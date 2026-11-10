/**
 * IndexNow for content that arrives without anyone pressing Publish.
 *
 * Until 2026-11 the only IndexNow ping was the one the Publish button sends
 * (src/pages/api/publish.ts), and it lists the fixed section pages. Since the
 * site reads Ninetone Office and refreshes itself from Office's revision every
 * minute (src/lib/office-publication.ts), a new article or profile is live
 * without Publish — and no search engine that listens to IndexNow (Bing, and
 * through it ChatGPT and Copilot search) was told.
 *
 * This compares the site's own sitemap with the one it last reported and
 * pings the difference:
 *
 *   - a URL that was not in the last report (new article, artist, client…)
 *   - a URL whose <lastmod> changed (only news entries carry one)
 *
 * The first run has nothing to compare with and reports the whole sitemap
 * once, which is also what seeds an index that has never crawled the site.
 *
 * What it does NOT see: an edit to an existing profile. Those entries have no
 * <lastmod>, so the sitemap is identical before and after.
 *
 * Pure: the sitemap, the KV store, the ping and the clock are passed in, so
 * every branch is unit-tested without a network (test/indexnow-sync.test.mjs).
 * src/worker-entry.ts wires it to the five-minute cron.
 */

/** Runs on the FM warm-up's schedule; the two share nothing but the cadence. */
export const INDEXNOW_SYNC_CRON = "*/5 * * * *";

/** KV key (CACHE_STATE) holding the sitemap as last reported to IndexNow. */
export const INDEXNOW_SNAPSHOT_KEY = "indexnow-sitemap:v1";

/** After a refused or failed ping, wait this long before trying again. A wrong
 *  key answers 403 every time; retrying each tick would post the same list 288
 *  times a day. */
export const INDEXNOW_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** IndexNow accepts at most this many URLs in one request. */
export const INDEXNOW_MAX_URLS = 10_000;

/** A sitemap with fewer than this share of the last report's URLs is treated
 *  as a partial render (Office unreachable, a roster read that failed) and
 *  ignored. Accepting it would drop the missing URLs from the record and
 *  report them all as new when they come back. */
const MIN_HEALTHY_SHARE = 0.5;
/** …but only once there is a record big enough for the comparison to mean anything. */
const MIN_SNAPSHOT_FOR_GUARD = 20;

interface Snapshot {
  v: 1;
  /** loc → lastmod ("" when the entry has none). */
  urls: Record<string, string>;
  /** Epoch ms of the last ping that did not go through. */
  failedAt?: number;
}

export type IndexNowSyncOutcome =
  | "disabled" // exactly "off" in the INDEXNOW_SYNC var
  | "no-sitemap" // the sitemap could not be fetched or held no URLs
  | "unhealthy" // far fewer URLs than last reported; ignored
  | "backoff" // a recent ping failed; waiting
  | "unchanged" // nothing new since the last report
  | "seeded" // first run: the whole sitemap reported
  | "pinged" // the difference reported
  | "failed"; // the ping was refused or threw

export interface IndexNowSyncResult {
  outcome: IndexNowSyncOutcome;
  /** URLs sent (or that would have been sent, for "failed"). */
  count: number;
}

export interface IndexNowSyncDeps {
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
  };
  /** The site's own sitemap XML, or null when it cannot be had. */
  loadSitemap: () => Promise<string | null>;
  /** Report these URLs. Resolves true when IndexNow accepted the request. */
  ping: (urls: string[]) => Promise<boolean>;
  now?: () => number;
}

/** Exactly "off" pauses the sync from the Cloudflare dashboard, no redeploy. */
export function indexNowSyncDisabled(env: { readonly INDEXNOW_SYNC?: unknown }): boolean {
  return env.INDEXNOW_SYNC === "off";
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Every <url> of a urlset as loc → lastmod ("" when absent). */
export function parseSitemap(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(entry[1]);
    if (!loc) continue;
    const lastmod = /<lastmod>([^<]*)<\/lastmod>/.exec(entry[1]);
    out.set(unescapeXml(loc[1].trim()), lastmod ? lastmod[1].trim() : "");
  }
  return out;
}

/** URLs in `current` that `previous` did not have, or had with another lastmod. */
export function changedUrls(previous: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [loc, lastmod] of current) {
    if (!previous.has(loc) || previous.get(loc) !== lastmod) out.push(loc);
  }
  return out;
}

function readSnapshot(raw: string | null): Snapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot> | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.urls !== "object" || parsed.urls === null) return null;
    const failedAt = typeof parsed.failedAt === "number" ? parsed.failedAt : undefined;
    return { v: 1, urls: parsed.urls, failedAt };
  } catch {
    return null;
  }
}

/**
 * One pass: read the sitemap, compare with the last report, ping the
 * difference, record the new state. Never throws for an expected failure —
 * the caller logs the outcome.
 *
 * The record only moves forward after IndexNow accepted the ping, so a URL
 * whose ping failed is reported again once the back-off has passed.
 */
export async function syncIndexNow(deps: IndexNowSyncDeps): Promise<IndexNowSyncResult> {
  const now = (deps.now ?? Date.now)();

  const snapshot = readSnapshot(await deps.kv.get(INDEXNOW_SNAPSHOT_KEY));
  if (snapshot?.failedAt !== undefined && now - snapshot.failedAt < INDEXNOW_RETRY_AFTER_MS) {
    return { outcome: "backoff", count: 0 };
  }

  const xml = await deps.loadSitemap();
  const current = xml ? parseSitemap(xml) : new Map<string, string>();
  if (current.size === 0) return { outcome: "no-sitemap", count: 0 };

  const previous = new Map(Object.entries(snapshot?.urls ?? {}));
  if (previous.size >= MIN_SNAPSHOT_FOR_GUARD && current.size < previous.size * MIN_HEALTHY_SHARE) {
    return { outcome: "unhealthy", count: current.size };
  }

  const changed = changedUrls(previous, current).slice(0, INDEXNOW_MAX_URLS);
  const record = (urls: ReadonlyMap<string, string>, failedAt?: number): Promise<unknown> =>
    deps.kv.put(
      INDEXNOW_SNAPSHOT_KEY,
      JSON.stringify({ v: 1, urls: Object.fromEntries(urls), ...(failedAt === undefined ? {} : { failedAt }) } satisfies Snapshot),
    );

  if (changed.length === 0) {
    // Nothing to report. Rewrite the record only to drop URLs that left the
    // sitemap or to clear an expired failure mark; otherwise leave KV alone.
    if (previous.size !== current.size || snapshot?.failedAt !== undefined) await record(current);
    return { outcome: "unchanged", count: 0 };
  }

  let accepted = false;
  try {
    accepted = await deps.ping(changed);
  } catch {
    accepted = false;
  }
  if (!accepted) {
    await record(previous, now);
    return { outcome: "failed", count: changed.length };
  }

  // URLs beyond the request limit stay out of the record, so the next pass
  // reports them.
  const reported = new Set(changed);
  const next = new Map<string, string>();
  for (const [loc, lastmod] of current) {
    const wasKnown = previous.has(loc) && previous.get(loc) === lastmod;
    if (wasKnown || reported.has(loc)) next.set(loc, lastmod);
  }
  await record(next);
  return { outcome: previous.size === 0 ? "seeded" : "pinged", count: changed.length };
}
