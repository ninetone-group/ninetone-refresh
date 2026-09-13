# Page-speed deep dive — handoff for a fresh session (2026-09-13)

Mikael's report: **"the site loads slow every other time I reload a page or
move between EN and SE."** Staging: https://ninetone-site.ninetone.workers.dev
(Ninetone's Cloudflare account, Workers Paid). Repo `ninetone-group/ninetone-refresh`,
branch `main` (PR #1 merged 2026-09-13, merge commit 64d9063). Nothing in
this document is a fix; it is the state of knowledge so the next session
measures first and does not re-derive what is already known.

## What is already true (do not re-investigate)

Read `docs/review-and-fixes-2026-09-12.md` §1 for the measurements behind each.

- **Warm edge-cache hits are ~0.05–0.15 s.** Not the problem.
- **A page-cache miss on a WARM isolate is fast** (~0.1–0.6 s) thanks to the
  route translation bundle (`trb:` keys, one KV read per render) and the FM
  KV read-through (`src/lib/fm-kv.ts`, 300 s TTL keyed by the Publish epoch).
  Verified 2026-09-13: `/en/management/clients` natural miss → 111 ms,
  `trbundle n=1`, zero per-string KV reads.
- **A page-cache miss on a COLD isolate with an EXPIRED FM read-through is
  the slow case:** 2.5–3.5 s, almost entirely `fmnet` (live FileMaker). Seen
  2026-09-13 on `/records/artists/previous` (`fmnet 2500 ms n=1`) and, the
  night before, on `/` (`fmnet 955 ms`) and `/records/artists/previous`
  (`fmnet 3002 ms`).
- The per-string translation cost on cold isolates is solved by the bundle
  for **natural** misses; it still shows up in the `?probe=` measurements
  because an unknown query parameter bypasses the page cache BEFORE the
  bundle code runs (`src/middleware.ts`, `shouldBypassCache`). Do not read
  `trnkv n=72` in a probe run as a regression.
- `Server-Timing` is on every response. Metric names: `cachever`, `cache`,
  `trbundle`, `trnread`, `trnkv`, `fmkv`, `fmnet`, `fmread`, `render`,
  `buffer`. **It under-counts component-level work** (AsyncLocalStorage does
  not reach Astro child components under workerd), so `trnkv n=` is a lower
  bound and `render` covers only page frontmatter.
- CPU and HTML size are noise (single-digit ms; 440 KB HTML gzips to 55 KB).
- Discovery cron is **paused** (`PUBLICATION_TICK=off`), so nothing keeps the
  FM read-through warm between visitors on quiet staging.

## Why "every other reload" is plausible, ranked

1. **Edge-cache eviction + FM read-through expiry.** The page cache is the
   Worker Cache API: per-datacenter, and on a low-traffic host entries are
   evicted well before their TTL. Each eviction is a miss; if >5 min have
   passed the FM layer has expired too, and a miss then pays 2–3 s of
   FileMaker. Mikael's reloads spaced minutes apart would alternate
   hit/miss exactly like this. Browser `max-age=60` adds a third state:
   reload within 60 s is instant from the browser.
2. **Different datacenters between requests.** Cloudflare can route
   consecutive requests from one client to different colos (mobile
   networks, VPN, Wi‑Fi hand-off); each colo has its own page cache and its
   own isolates. `cf-ray` suffix (e.g. `-ARN`) reveals it.
3. **EN/SE switch is always the OTHER locale's cache entry.** Locale is in
   the cache key by design; the first switch after any eviction is a miss.
   Correct behaviour, but it means the switch is the most miss-prone action.
4. **Cold isolates.** Isolate recycling makes the in-memory FM cache (60 s)
   and isolate translation cache empty; the bundle covers translations, the
   KV read-through covers FM — unless (1) expired it.
5. **Homepage Shopify fetch** (`MerchSection.astro` → `src/lib/shopify.ts`)
   is cached in-memory only (60 s), never in KV: every cold isolate pays a
   live Shopify call on `/`. Small but real, and the only remaining
   per-isolate network dependency besides FM.
6. **The FM image proxy does not cache at the edge — confirmed 2026-09-13.**
   `worker-fm-proxy/src/index.ts` sets `Cache-Control: public, max-age=86400,
   s-maxage=604800` but never uses `caches.default` (line ~326 has the
   to-do). On workers.dev a header alone caches nothing, so EVERY first
   request for an image goes Worker → FileMaker: measured 230–900 ms per
   image, `cf-cache-status` absent. A roster page has 33 images; a first
   view by any visitor (or after the browser's 24 h `max-age`) pays that in
   parallel-but-throttled requests. This is very likely a large part of
   "feels slow", and it survives a warm page cache. Fix: Cache API in the
   proxy (match/put on the request URL, ~15 lines) with a TTL of hours, and
   a cache-buster so a replaced photo shows: append the Publish epoch (or
   FM record modification stamp) as `?v=` when `src/lib/fm-image-mirror.ts`
   rewrites the URL, so the key changes when content can have changed.
7. **Browser-side (LCP/fonts/CSS)** — never traced under throttling. Two
   preloaded Newsreader faces (132 KB + 147 KB) and two blocking CSS files.
   Would feel like "slow" even on a fast TTFB. Lowest prior for an
   "every other time" symptom, but the only candidate that survives a
   warm cache.

## Measure first (30 minutes)

1. **Reproduce Mikael's pattern, instrumented.** From his machine, or by
   asking him to run it: 20 reloads of the same page spaced 30–90 s apart,
   recording per request: `x-cache`, `x-cache-ttl`, `cf-ray` (colo),
   `server-timing`, TTFB. A tiny script is easiest:
   ```
   node -e 'for(let i=0;i<20;i++){const t=Date.now();const r=await fetch("https://ninetone-site.ninetone.workers.dev/");await r.text();console.log(Date.now()-t,"ms",r.headers.get("x-cache"),r.headers.get("cf-ray"),r.headers.get("server-timing"));await new Promise(s=>setTimeout(s,45000))}' --input-type=module
   ```
   Then the same alternating `/` and `/en`. This alone decides between
   hypotheses 1, 2 and 6.
2. `node scripts/perf-cold-probe.mjs` for the render-cost view (remember the
   probe bypasses the page cache).
3. A throttled browser trace (Chrome DevTools, "Fast 3G", cache disabled)
   of `/` and `/en` — the never-done half of the 2026-09-11 audit.

## Likely fixes, in order of value (pick after measuring)

1. **FM warm-up cron** (every 5 min, runs the eight list getters through
   `fmFind` so the KV read-through never expires on quiet hosts). ~2,300
   FM finds/day, far below the paused discovery tick's ~11,500. Kills the
   2–3 s miss case outright. Ten-minute change: a `scheduled` branch in
   `src/worker-entry.ts` gated on its own var, plus a cron trigger.
   Mikael leaned toward doing this before launch.
2. **Edge-cache the image proxy** (see hypothesis 6). Likely the biggest
   *felt* win after the FM cron; independent of the page cache entirely.
3. **KV-cache the Shopify products** (`kvCached` already exists in
   `src/lib/cache.ts`, used by YouTube) — 5-line change, removes the last
   cold-isolate network call on the homepage.
4. **Longer FM read-through for slow-changing lists** (rosters, previous
   artists, team) — but NOT beyond each route's page tier; the homepage
   tier is 5 min, so a blanket increase is wrong. Per-query TTL if at all.
5. **Custom domain + real zone** (after Patrik's nameserver switch): a zone
   gets Cloudflare's Tiered Cache and much less eviction than workers.dev.
   This may make hypothesis 1 mostly disappear in production by itself —
   which is why measuring on staging can overstate the problem.
   (Asked and answered: moving the translation cache from KV to D1 would
   not help — D1 is single-region SQLite, slower for global reads of
   immutable values; KV plus the route bundle is the right shape.)
6. **Browser work** only if step 3 shows it: font `preload` audit,
   critical CSS, hero image priority.

## Constraints (unchanged)

- Keep `await res.arrayBuffer()` body buffering in the middleware
  (zero-byte-response fix). Keep the 25-call translation budget. No FM-side
  changes; the Data API is the surface. Respect FM load (Ninetone's FM is
  a heavy production system): a 5-minute warm cron is fine, a 1-minute one
  is what got paused.
- Translations are content-addressed in KV; the bundle is a cache of a
  cache, never a correctness layer.
- Do not touch the publication subsystem (shadow, paused) for this work.

## Tooling and access

- Deploy: `npm run deploy:cf` (one command; `dist/` is shared by both
  build targets). Worker `ninetone-site`, account pinned in `wrangler.jsonc`.
- Logs: `npx wrangler tail ninetone-site --format json`.
- KV namespaces (Ninetone account): cache-state `1772c36b…`.
- GitHub: work on a branch, open a PR; `ci.yml` runs tests + build:cf.
  Use `gh auth switch --user MixxMasterMike` (the org member account).
- Effort level: `high` for the measurement + fixes; use subagents for the
  20-request capture and the browser trace so the main context stays clean.

## Related

`docs/review-and-fixes-2026-09-12.md` (what was fixed and measured),
`docs/perf-handoff-2026-09-12.md` (the earlier picture, now partly stale),
`docs/handoff-patrik-2026-09-12.md` (DNS/launch steps).
