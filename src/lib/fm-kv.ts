/**
 * KV read-through for FileMaker finds. Lives in its own module (not in
 * filemaker.ts) so it can be unit-tested under plain Node: filemaker.ts pulls
 * in fm-image-mirror.ts, which reads `import.meta.env` at module load and
 * cannot be imported outside Vite.
 */
import { kvCached, type KvLike } from "./cache.ts";
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
 * NO in-isolate memo of the epoch, on purpose. The middleware reads
 * "cache-version" (cacheTtl 60) to build the PAGE cache key; this layer must
 * never see an OLDER epoch than that read did, or a Publish can render old FM
 * data and pin it under the new epoch for the page's full tier (24 h on
 * /team — Codex review, 2026-09-12). Reading the same edge-cached KV entry,
 * in the same colo, milliseconds later gives exactly that guarantee: the
 * value is identical or newer, and "newer FM data under an older page key"
 * is harmless because that key is already dying. A memo broke it. The read
 * is one edge-cached KV get per in-memory miss (per layout per 60 s per
 * isolate), which is cheap.
 */
async function fmCacheVersion(kv: KvLike): Promise<string> {
  try {
    return (await kv.get("cache-version", { cacheTtl: 60 })) ?? "0";
  } catch {
    // KV unavailable → still cache under epoch "0"; the edge cache has the
    // same fallback (src/middleware.ts).
    return "0";
  }
}

/** Content-addressed find key: epoch + layout + shape + exact query body. */
export async function fmKvKey(version: string, layout: string, body: FmFindBody, withPortals: boolean): Promise<string> {
  return `fm:v1:${version}:${withPortals ? "p" : "f"}:${layout}:${await sha256Hex(JSON.stringify(body))}`;
}

/** The read-through itself; `kv` is injected so tests can drive it. */
export async function fmFindViaKv<T>(
  kv: KvLike | null | undefined,
  layout: string,
  body: FmFindBody,
  withPortals: boolean,
  loader: () => Promise<T[]>,
): Promise<T[]> {
  if (!kv) return loader();
  const version = await fmCacheVersion(kv);
  const key = await fmKvKey(version, layout, body, withPortals);
  return timeServer("fmkv", () => kvCached<T[]>(kv, key, FM_KV_TTL_SECONDS, loader));
}

