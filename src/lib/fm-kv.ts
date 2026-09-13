/**
 * KV read-through for FileMaker finds. Lives in its own module (not in
 * filemaker.ts) so it can be unit-tested under plain Node: filemaker.ts pulls
 * in fm-image-mirror.ts, which reads `import.meta.env` at module load and
 * cannot be imported outside Vite.
 */
import { type CacheOptions, kvCached, type KvLike, readCacheVersion } from "./cache.ts";
import type { FmFindBody } from "./filemaker.ts";
import { sha256Hex } from "./http.ts";
import { timeServer } from "./server-timing.ts";

// ---------------------------------------------------------------------------
// Cross-isolate KV read-through for FM finds (2026-09-12)
// ---------------------------------------------------------------------------
//
// WHY. The in-memory `cached()` layer above is per ISOLATE and lives 60 s.
// Worker isolates are recycled constantly, so the first render on each one
// pays FM in full — and FM is the slowest thing on the cold path: measured
// on staging via Server-Timing, the previous-artists find set cost
// `fmnet 3002 ms` of a 3.9 s TTFB. This layer lets any isolate reuse a find
// another isolate performed in the last five minutes, so a cold isolate reads ~1 MB
// from KV in ~100 ms instead of waiting seconds on FM.
//
// PUBLISH SEMANTICS PRESERVED. The key embeds the same `cache-version` epoch
// the edge cache uses, so a Publish (which bumps it) makes every FM read
// miss this layer once and re-fetch live. Between Publishes, the visitor-
// visible freshness is already governed by the page tiers (5 min–24 h), and
// this layer's TTL equals the shortest of them. If the publication cron is
// resumed, it observes FM at most this many seconds late.
//
// NOT a correctness layer: no KV binding (static build, Node dev) means a
// straight call; a KV failure means a straight call.
// 300 s: the publication cron (which ran the same finds every minute and kept
// this layer warm) is paused, so visitor renders are the only refresh. Five
// minutes is the shortest page tier (homepage), so nothing is served staler
// than its own tier already allows; a Publish still forces a live read.
const FM_KV_TTL_SECONDS = 300;

/**
 * TTL for entries written by the five-minute warm-up cron (src/lib/fm-warm.ts).
 *
 * WHY 360 AND NOT 300. The cron fires every five minutes; a 300 s entry
 * written at t=0 expires at t=300, and the next warm write lands at t=300
 * plus cron jitter plus the FM round trip — a gap of seconds to a minute in
 * which a visitor's miss pays FM in full, which is the exact expiry the cron
 * exists to prevent (perf handoff 2026-09-13: the read-through expires on a
 * quiet staging host). 60 s of grace covers that gap. Visitor reads still
 * write 300 s: nothing is served staler than the shortest page tier allows,
 * and the cron overwrites the entry (fresh data, fresh TTL) before either
 * expires.
 */
export const FM_KV_WARM_TTL_SECONDS = FM_KV_TTL_SECONDS + 60;

// The epoch read lives in cache.ts (`readCacheVersion`) since the Shopify
// read-through keys off the same value — see the comment there for why it
// is deliberately NOT memoized per isolate.

/** Content-addressed find key: epoch + layout + shape + exact query body. */
export async function fmKvKey(version: string, layout: string, body: FmFindBody, withPortals: boolean): Promise<string> {
  return `fm:v1:${version}:${withPortals ? "p" : "f"}:${layout}:${await sha256Hex(JSON.stringify(body))}`;
}

/**
 * The read-through itself; `kv` is injected so tests can drive it.
 *
 * The loader receives the epoch string the KV key was built with (undefined
 * when there is no binding). filemaker.ts threads it into the image-URL
 * rewrite as `?v=<epoch>`, so the proxy's edge cache (worker-fm-proxy) is
 * keyed by the same Publish epoch as everything else. It is passed rather
 * than re-read so the URLs inside an entry always match the key the entry
 * is stored under.
 *
 * `refresh` (the warm-up cron) bypasses the KV read and writes with the
 * longer `FM_KV_WARM_TTL_SECONDS` — see that constant.
 */
export async function fmFindViaKv<T>(
  kv: KvLike | null | undefined,
  layout: string,
  body: FmFindBody,
  withPortals: boolean,
  loader: (version?: string) => Promise<T[]>,
  opts?: CacheOptions,
): Promise<T[]> {
  if (!kv) return loader(undefined);
  const version = await readCacheVersion(kv);
  const key = await fmKvKey(version, layout, body, withPortals);
  const ttl = opts?.refresh ? FM_KV_WARM_TTL_SECONDS : FM_KV_TTL_SECONDS;
  return timeServer("fmkv", () => kvCached<T[]>(kv, key, ttl, () => loader(version), opts));
}

