/**
 * FM warm-up cron — keeps the cross-isolate KV read-through populated.
 *
 * WHY. src/lib/fm-kv.ts caches every FM find in KV for 300 s, keyed by the
 * Publish epoch, so a cold isolate reads ~1 MB from KV in ~100 ms instead of
 * waiting seconds on FM. But visitor renders were the only thing refreshing
 * those entries once the publication tick was paused, and on a quiet host
 * (staging today, ninetone.com at 04:00 tomorrow) they simply expire — the
 * next visitor then pays FM in full on top of a page-cache miss (perf handoff
 * 2026-09-13). This cron re-runs the same finds the pages run, in refresh
 * mode, every five minutes, so the read-through never expires between
 * visitors. Cost: ~2,600 FM finds/day (nine finds per pass, 288 passes) — under
 * a quarter of the ~11,500 the paused every-minute discovery tick performed.
 *
 * Dependency-light on purpose (`.ts` imports only, nothing from
 * `cloudflare:`): src/worker-entry.ts dispatches to this from `scheduled`,
 * and the logic lives here so test/fm-warm.test.mjs can exercise it under
 * plain Node without the built bundle.
 */

/**
 * Cron expression the Worker dispatches on (wrangler.jsonc `triggers`).
 * `scheduled` compares `event.cron` against this string byte-for-byte —
 * Cloudflare hands back the configured expression verbatim — so the two must
 * stay identical.
 */
export const FM_WARM_CRON = "*/5 * * * *";

/**
 * The `limit` src/pages/index.astro passes to MerchSection. The Shopify KV
 * key embeds the limit (src/lib/shopify.ts), so the cron must warm with the
 * SAME value or it writes an entry the homepage never reads. Pinned by
 * test/fm-warm.test.mjs against the page source.
 */
export const HOMEPAGE_MERCH_LIMIT = 10;

/**
 * Is the warm-up switched off by the FM_WARM var? Exactly "off" disables —
 * the same convention as PUBLICATION_TICK, so a dashboard var flip pauses it
 * without a redeploy and a missing or misspelled var leaves it running
 * (the safe default: a warm cache is never wrong, only cheaper).
 */
export function warmDisabled(env: { FM_WARM?: unknown }): boolean {
  return env.FM_WARM === "off";
}

export type WarmLoader = {
  /** Short label for the summary line, e.g. "artists". */
  name: string;
  run: () => Promise<unknown>;
};

export type WarmResult = {
  ok: string[];
  failed: { name: string; error: string }[];
  /** Wall-clock for the whole pass. */
  ms: number;
};

/**
 * Run the loaders SEQUENTIALLY — one FM find in flight at a time. FM is a
 * production platform doing heavy real-time aggregation (CLAUDE.md); the
 * cron exists to spare it visitor-time load, not to add a burst of nine
 * parallel finds every five minutes.
 *
 * Each loader is wrapped so one failure never stops the rest: a single
 * layout being slow or erroring should still leave the other eight warm.
 * Failures are reported, never thrown — the handler runs in `waitUntil`,
 * where a rejection is just noise.
 */
export async function warmReadThrough(deps: {
  loaders: ReadonlyArray<WarmLoader>;
  log?: (msg: string, detail?: unknown) => void;
  now?: () => number;
}): Promise<WarmResult> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const started = now();
  const ok: string[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const loader of deps.loaders) {
    try {
      await loader.run();
      ok.push(loader.name);
    } catch (error) {
      failed.push({ name: loader.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const result: WarmResult = { ok, failed, ms: now() - started };
  log(
    `[fm-warm] warmed ${ok.length}/${deps.loaders.length} in ${result.ms} ms` +
      (failed.length ? ` — failed: ${failed.map((f) => `${f.name} (${f.error})`).join(", ")}` : ""),
  );
  return result;
}
