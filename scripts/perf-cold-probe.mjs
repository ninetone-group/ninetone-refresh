#!/usr/bin/env node
/**
 * Cold-render probe for the Cloudflare staging Worker.
 *
 * Fetches each route ONCE with an unknown query parameter (which bypasses the
 * page cache, so the Worker renders) and prints the Server-Timing breakdown:
 *   trbundle  route translation bundle read (one per render)
 *   trnkv     physical translation KV reads — near 0 once bundles are warm
 *   fmkv      FM read-through (KV) · fmnet  live FileMaker time
 * Read-only: plain GETs, no cache purge, no writes, no model calls.
 *
 *   node scripts/perf-cold-probe.mjs            # default routes
 *   node scripts/perf-cold-probe.mjs /news /en  # your own routes
 *
 * Interpretation: a slow render whose time is in `fmnet` is FileMaker; time
 * in `trnkv` with a large n is per-string translation reads (bundle missing
 * for that route); neither present and still slow → look at `render`.
 */
const base = process.env.SITE_ORIGIN ?? "https://ninetone-site.ninetone.workers.dev";
const routes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["/", "/en", "/records/artists", "/records/artists/previous", "/en/records/artists/previous", "/news", "/team"];

const pick = (st, n) => (st.match(new RegExp(`${n};dur=([\\d.]+);desc="n=(\\d+)`)) || []).slice(1).join("ms n=") || "-";

for (const path of routes) {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}?probe=${Date.now()}`);
  const ttfb = Math.round(performance.now() - t0);
  const body = await res.text();
  const st = res.headers.get("server-timing") ?? "";
  console.log(
    `${path.padEnd(30)} ${res.status} ttfb=${String(ttfb).padStart(5)}ms bytes=${String(body.length).padStart(6)}` +
      `  trbundle=${pick(st, "trbundle")}  trnkv=${pick(st, "trnkv")}  fmkv=${pick(st, "fmkv")}  fmnet=${pick(st, "fmnet")}  render=${pick(st, "render")}` +
      `  degraded=${res.headers.get("x-translation") ?? "no"}`,
  );
}
