/**
 * In-memory cache for FM/Shopify/YouTube reads, shared by both runtimes:
 *
 *  - Static build (GH Pages preview): one process, exits when done. The TTL
 *    barely matters — the win is in-flight dedup, so redundant list calls
 *    (`getArtists` from a list page AND getStaticPaths) collapse to one
 *    network round-trip.
 *  - Cloudflare Worker (server output): the isolate lives for many requests.
 *    Here the TTL is load-bearing — without it, the first render would pin
 *    its data forever and the site would never refresh. 60s keeps every
 *    isolate near-fresh while the edge cache (src/middleware.ts) absorbs
 *    almost all traffic in front of this layer.
 *
 * Stale-on-error: when a refresh fails and we have a previously-good value,
 * serve that and retry shortly — an FM hiccup shouldn't 500 a page that
 * rendered fine a minute ago. A failure with NO previous value still throws
 * (better a loud error than caching an empty site).
 *
 * Token requests are deliberately NOT cached here — auth flow stays live.
 */

const TTL_MS = 60_000;
const RETRY_AFTER_ERROR_MS = 30_000;
const MAX_ENTRIES = 500;

type Entry = {
  promise: Promise<unknown>;
  expires: number;
  /** Last successfully resolved value — served if a later refresh fails. */
  stale?: { value: unknown };
};

const memCache = new Map<string, Entry>();

function key(namespace: string, payload: unknown): string {
  return `${namespace}:${JSON.stringify(payload)}`;
}

/**
 * Refresh mode (the FM warm-up cron, src/lib/fm-warm.ts): the caller wants
 * the loader to RUN, not a cached answer. Shared by `cached()` and
 * `kvCached()` so one option object can be threaded through the whole FM
 * read path (src/lib/filemaker.ts → fm-kv.ts) without each layer inventing
 * its own flag.
 */
export type CacheOptions = {
  /** Skip any existing fresh entry and re-run the loader; the result is
   *  stored as usual so the next normal read is served from it. */
  refresh?: boolean;
};

/**
 * Cache a fetch by (namespace, payload). Concurrent callers share the
 * in-flight Promise; the value is reused until the TTL lapses.
 *
 * With `refresh`, a fresh entry is ignored and the loader runs anyway. The
 * entry's last-good value is still carried over, so a refresh that fails
 * degrades to stale-on-error exactly like an expired-entry refresh does.
 */
export function cached<T>(
  namespace: string,
  payload: unknown,
  loader: () => Promise<T>,
  ttlMs: number = TTL_MS,
  opts?: CacheOptions,
): Promise<T> {
  const k = key(namespace, payload);
  const now = Date.now();
  const existing = memCache.get(k);
  if (existing && now < existing.expires && !opts?.refresh) return existing.promise as Promise<T>;

  const entry: Entry = {
    promise: Promise.resolve() as Promise<unknown>,
    expires: now + ttlMs,
    stale: existing?.stale,
  };
  entry.promise = loader().then(
    (value) => {
      entry.stale = { value };
      return value;
    },
    (err) => {
      if (entry.stale) {
        console.error(`[cache] ${namespace} refresh failed — serving stale value:`, err);
        entry.expires = Date.now() + RETRY_AFTER_ERROR_MS;
        return entry.stale.value as T;
      }
      memCache.delete(k);
      throw err;
    },
  );
  memCache.set(k, entry);
  // Request-derived slugs can otherwise grow a long-lived Worker isolate's
  // map without bound. Map.keys() yields insertion order and re-setting an
  // existing key doesn't move it, so this evicts the oldest-inserted entry —
  // plain FIFO, not an LRU (a frequently-hit old entry is evicted just the
  // same as an unused one).
  if (memCache.size > MAX_ENTRIES) {
    const oldest = memCache.keys().next().value as string | undefined;
    if (oldest && oldest !== k) memCache.delete(oldest);
  }
  return entry.promise as Promise<T>;
}

/**
 * Minimal KV shape `kvCached` needs — a structural subset of
 * `CacheStateKv` (src/lib/cf.ts) so this module doesn't have to import the
 * Cloudflare-flavored type for what is otherwise a generic helper.
 */
export type KvLike = {
  get(key: string, opts?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};

const NEGATIVE_TTL_SECONDS = 10 * 60; // 10 min — see module doc below.

/**
 * Cache a JSON-serializable value across Worker isolates via the shared
 * `CACHE_STATE` KV binding, for loaders far too expensive to re-run every
 * 60s (e.g. YouTube Data API quota — see src/lib/youtube.ts).
 *
 * Falls through to the in-process `cached()` when no KV binding is present
 * (static build, local dev, or the gh target) — same call shape either way,
 * so callers don't need to branch.
 *
 * Negative-result guard: a "no result" value (null, or an empty array) is
 * only ever stored for `NEGATIVE_TTL_SECONDS` regardless of the requested
 * `ttlSeconds`, so a transient API failure or empty API response can't pin
 * an empty result for the full (e.g. 30-day) TTL. A genuinely empty steady
 * state just gets re-fetched every 10 minutes — cheap relative to the win.
 *
 * KV writes are best-effort: a `put` failure is logged and swallowed so a
 * KV hiccup degrades to "recompute every call" rather than throwing.
 */
export async function kvCached<T>(
  kv: KvLike | null | undefined,
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  opts?: CacheOptions,
): Promise<T> {
  if (!kv) {
    return cached<T>("kv-fallback", key, fn, ttlSeconds * 1000, opts);
  }

  // Refresh mode skips the read entirely: the point is to overwrite whatever
  // KV holds with a fresh value (and a fresh TTL) before it expires, so a
  // hit would defeat the purpose. See `CacheOptions`.
  if (!opts?.refresh) {
    try {
      const raw = await kv.get(key);
      if (raw !== null) {
        return JSON.parse(raw) as T;
      }
    } catch (err) {
      console.error(`[kv-cache] read failed for ${key} — recomputing:`, err);
    }
  }

  const value = await fn();
  const isEmpty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
  const effectiveTtl = isEmpty ? Math.min(ttlSeconds, NEGATIVE_TTL_SECONDS) : ttlSeconds;

  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: effectiveTtl });
  } catch (err) {
    console.error(`[kv-cache] write failed for ${key}:`, err);
  }

  return value;
}

/**
 * The Publish epoch ("cache-version", bumped by src/pages/api/publish.ts).
 * Every cross-isolate cache key that carries FM- or Shopify-derived content
 * embeds it (fm-kv.ts, shopify.ts), so a Publish makes all of them miss once
 * and re-read live, the same way the edge cache (src/middleware.ts) does.
 *
 * NO in-isolate memo of the epoch, on purpose. The middleware reads
 * "cache-version" (cacheTtl 60) to build the PAGE cache key; the data layers
 * must never see an OLDER epoch than that read did, or a Publish can render
 * old data and pin it under the new epoch for the page's full tier (24 h on
 * /team — Codex review, 2026-09-12). Reading the same edge-cached KV entry,
 * in the same colo, milliseconds later gives exactly that guarantee: the
 * value is identical or newer, and "newer data under an older page key" is
 * harmless because that key is already dying. A memo broke it. The read is
 * one edge-cached KV get per in-memory miss (per layout per 60 s per
 * isolate), which is cheap.
 *
 * "0" when there is no binding or KV is unavailable — the edge cache has the
 * same fallback, so the layers stay keyed alike.
 */
export async function readCacheVersion(kv: KvLike | null | undefined): Promise<string> {
  if (!kv) return "0";
  try {
    return (await kv.get("cache-version", { cacheTtl: 60 })) ?? "0";
  } catch {
    return "0";
  }
}
