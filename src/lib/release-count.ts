/**
 * Nightly release count for the homepage metrics panel (2026-09-13).
 *
 * WHY A SEPARATE CRON. Releases are portal rows on each artist's
 * API_ARTIST_DETAIL record, so counting them means ONE find that returns
 * every artist with their whole discography: measured 9.4 s and 6 MB for
 * 390 artists / 2,186 rows. Far too heavy for the five-minute warm-up
 * (src/lib/fm-warm.ts) or for any visitor's render, and the number changes
 * a few times a month — so it is counted once a night, stored in KV, and
 * the homepage reads the stored number. If the job has never run (or KV is
 * empty), the page falls back to its editorial copy rather than showing a
 * wrong figure. The count itself is a pure function so it can be tested
 * without FM.
 *
 * Dependency-light on purpose (`.ts` imports only), like fm-warm.ts.
 */
import type { KvLike } from "./cache.ts";

/** 04:00 UTC daily — quiet hours for a Swedish audience and for FM. */
export const RELEASE_COUNT_CRON = "0 4 * * *";
export const RELEASE_COUNT_KEY = "metrics:v1:releases";
/** 8 days: survives a week of failed ticks, then the page falls back. */
export const RELEASE_COUNT_TTL_SECONDS = 8 * 24 * 60 * 60;

export const RELEASE_PORTAL = "Green Web Category";

type ReleaseRow = Record<string, unknown>;
type ArtistWithPortal = {
  fieldData: { SLUG?: unknown };
  portalData?: Record<string, ReleaseRow[]>;
};

/**
 * Distinct (artist, album) pairs with a non-empty album name — the same rule
 * the discography rendering and the image proxy apply (rows without an
 * album are skipped there too). The same title released twice (a single
 * and its remaster) is one release.
 */
export function countReleases(artists: ReadonlyArray<ArtistWithPortal>): number {
  const seen = new Set<string>();
  for (const artist of artists) {
    const slug = typeof artist.fieldData?.SLUG === "string" ? artist.fieldData.SLUG : "";
    for (const row of artist.portalData?.[RELEASE_PORTAL] ?? []) {
      const album = String(row[`${RELEASE_PORTAL}::Album`] ?? "").trim();
      if (album) seen.add(`${slug} ${album}`);
    }
  }
  return seen.size;
}

export type StoredReleaseCount = { count: number; at: string };

/** The stored count, or null when absent or malformed (→ editorial fallback). */
export async function readReleaseCount(kv: KvLike | null | undefined): Promise<StoredReleaseCount | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(RELEASE_COUNT_KEY, { cacheTtl: 3600 });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredReleaseCount>;
    if (typeof parsed.count !== "number" || !Number.isFinite(parsed.count) || parsed.count < 0) return null;
    return { count: parsed.count, at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch {
    return null;
  }
}

/**
 * Count live and store. `load` is injected (the cron passes the FM getter,
 * tests pass fixtures). A zero count is NOT stored: an empty or failed
 * payload must never replace a good number with "0" on the homepage.
 */
export async function refreshReleaseCount(deps: {
  kv: KvLike;
  load: () => Promise<ReadonlyArray<ArtistWithPortal>>;
  now?: () => Date;
  log?: (msg: string) => void;
}): Promise<StoredReleaseCount | null> {
  const started = Date.now();
  const artists = await deps.load();
  const count = countReleases(artists);
  if (count === 0) {
    deps.log?.(`[release-count] counted 0 releases across ${artists.length} artists — keeping the stored value`);
    return null;
  }
  const value: StoredReleaseCount = { count, at: (deps.now ?? (() => new Date()))().toISOString() };
  await deps.kv.put(RELEASE_COUNT_KEY, JSON.stringify(value), { expirationTtl: RELEASE_COUNT_TTL_SECONDS });
  deps.log?.(`[release-count] ${count} releases across ${artists.length} artists in ${Date.now() - started} ms`);
  return value;
}
