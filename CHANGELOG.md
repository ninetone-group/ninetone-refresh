# Changelog

All notable changes to the Ninetone Group site. Versions follow `MAJOR.MINOR.PATCH.MICRO`
(the number in `VERSION`).

## [0.2.4.0] - 2026-09-14

### Added
- **Tidigare klienter (previous clients).** New Management archive mirroring the
  previous-artists pages: paginated list at `/management/clients/previous` (30 per page,
  A–Ö index on page 1, "Klienter / Tidigare klienter" tabs) and detail pages at
  `/management/clients/previous/single/{slug}`, both locales. Reads the cron-warmed
  `getPreviousClients()` list — no new FileMaker finds.
- **Cross-roster 301s for clients.** `/management/clients/{slug}` for a Not Active client
  redirects to the archive page and a re-signed client's archive URL redirects back, locale
  kept — the four former-client URLs still drawing traffic in Search Console
  (`bangarden_customs`, `raketforskaren`, `luddze_`, `johanna_and_marcus`) no longer 404.
- Sitemap and `llms.txt` list the new pages; middleware caches the list at the roster tier
  (6 h) and the detail pages at 1 h; footer links to the archive; the translation warm
  script covers previous-client prose.

## [0.2.3.0] - 2026-09-13

### Added
- **Homepage metrics from data.** Profiles = every active and former profile across
  Records, Management and Nation, merged by slug ("540+ · Sedan starten"); years since
  2006 computed at render; releases counted nightly by a new `0 4 * * *` cron (one 9 s /
  6 MB FileMaker find, stored in KV, editorial fallback when absent). "4 recording studios"
  replaces "1 house". Two new getters (former clients, former booking) are warmed by the
  FM cron.
- **Tracker ids carried over** from the old ninetone.com (GA4, Meta Pixel, Microsoft
  Clarity), pinned by a test; still dormant until `PUBLIC_NOINDEX` is off.
- **Cookie banner rendered on every page**, trackers or not, so the footer link works and
  the banner can be reviewed on staging.

### Fixed
- **Background translation never ran on Cloudflare.** The scheduler was the execution
  context's `waitUntil` detached from its receiver ("Illegal invocation", swallowed).
  New strings now translate within about a minute of their first render.
- Long Swedish compounds overflowing heading columns (headings hyphenate).
- Swedish overrides: "Teamet", "Vi bygger bron.", the metrics headline, "Sedan starten".
- Flaky bulk-read test made timing-independent; proxy deploys documented as
  `npm run deploy` in `worker-fm-proxy/`.

## [0.2.2.0] - 2026-09-13

### Added
- **Stale-while-revalidate at the edge.** A page-cache entry past its tier is served
  immediately (`x-cache: stale`) and re-rendered in the background through a
  self-referential `SELF` service binding; the stored copy lives 7 days with the tier
  carried as a freshness stamp. The first visitor after hours of quiet, or the first
  language switch after a lull, no longer waits for a cold render (4–6 s measured).
  A Publish still changes the cache key, so editorial changes are never served stale.
  Verified on staging: after the homepage tier lapsed, `/` answered in 443 ms and
  `/en` in 67 ms as stale, and both were fresh hits 8 s later.

### Fixed
- "We build the bridge." was served untranslated on the Swedish homepage (override:
  "Vi bygger bron.").

## [0.2.1.0] - 2026-09-13

Page-speed deep dive. Measured first (20 timed reloads of `/`, 20 alternating `/` and
`/en`, a Fast-3G browser trace of both), then fixed what the numbers pointed at. On
staging every fifth reload of the homepage was a miss at the 300 s tier and every one of
those misses paid FileMaker live, because the FM read-through expired on the same clock;
every image request went to FileMaker because the proxy never used the edge cache.

### Added
- **FM warm-up cron** (`*/5 * * * *`, `src/lib/fm-warm.ts`): re-runs the nine finds the
  pages perform, one at a time, in refresh mode, so the KV read-through never expires on
  a quiet host. ~2,600 FM finds/day against the ~11,500 the paused discovery tick did.
  `FM_WARM: "off"` in the Worker vars pauses it from the dashboard.
- **Image proxy edge cache.** `worker-fm-proxy` now serves image bytes through the Cache
  API (6 h edge, `x-fm-status: hit`), keyed by path plus the new `?v=<publish-epoch>`
  the site appends to every proxy URL, so a Publish is the cache buster and no other
  query string can force a FileMaker read.
- **Shopify products in KV** (1 h, epoch in the key): the last cold-isolate network call
  on the homepage is gone.
- `x-translation-bundle: hit; entries=N | miss` on every page-cache miss, so whether the
  route translation bundle seeded a render is visible in-band.

### Changed
- Only the Newsreader roman face is preloaded; the italic preload (147 KB, the largest
  asset on the page) competed with the render-blocking CSS and finished 2 s after first
  paint anyway.
- The artist-of-the-week tile no longer carries `fetchpriority="high"`; it sits three
  viewports below the fold and the LCP element is the h1.

## [0.2.0.0] - 2026-09-12

The first merge to `main` since the site went server-rendered on Cloudflare. Everything
below is live on staging (`ninetone-site.micke-ohlen.workers.dev`) and still noindexed;
`PUBLIC_NOINDEX` is untouched, so nothing here makes the site indexable yet.

### Added
- **English edition under `/en/`.** Swedish stays at the root. Every page renders in
  both languages from one set of route files; the header switch links to the exact
  alternate URL, and Swedish-only pages (privacy policy, guides) have no English URL.
- **Machine translation with a permanent cache.** Copy and FileMaker content are
  translated by Claude on first sight, cached in KV forever, and never block a page:
  a miss renders the source text and schedules the translation for the next visitor.
  Human overrides in `src/i18n/overrides.json` always win. A warm script pre-translates
  the whole site (`scripts/translate-warm.mjs`).
- **Search-engine groundwork.** Canonical, Open Graph and Twitter tags, hreflang pairs,
  JSON-LD (Organization, WebSite, Article, breadcrumbs, entity pages), a dynamic
  per-locale sitemap, `robots.txt` and `llms.txt` endpoints, meta descriptions with a
  bio fallback, one `<h1>` per page, distinct titles for paginated pages, an A–Ö index
  of every previous artist, and Nation category pages plus a guides route.
- **Legacy URL redirects** (`/previous-artists/*`, `/blog`) and trailing-slash
  canonicalisation.
- **Real contact-form delivery on Cloudflare**: submissions stored in KV first, then
  emailed per division, rate-limited.
- **YouTube channel feeds** on Records artist and Nation talent pages, quota-cached.
- **Locale-aware dates** on every `<time>` element, with machine-readable `datetime`.
- **Self-hosted fonts** and a WebP version of the hover artwork (2.8 MB → 114 KB).
- **`Server-Timing` on every response** so a slow render can be attributed to
  FileMaker, translation reads, rendering or buffering.
- **Translate-before-publish subsystem** (shadow mode only): discovery of FM edits,
  a translation queue, immutable release bundles and a Durable Object coordinator.
  Nothing is served from it yet, and its cron is paused (`PUBLICATION_TICK=off`).

### Changed
- **Cold renders are no longer seconds slow.** A page's translations are stored as one
  bundle per route and read in one KV round trip instead of one per string; parallel
  reads are batched into KV bulk gets; FileMaker list queries are shared across
  isolates through a short KV read-through keyed by the Publish epoch.
- A page that could not translate every string (the 25-call budget) is cached for one
  minute instead of its full tier, so it converges instead of sticking half-translated.
- Missing entities return a real 404 instead of a 200 "not found" page, and the full
  response body is buffered before caching to fix a zero-byte-response race.
- Security headers hardened (CSP, HSTS, frame and referrer policies); `X-Robots-Tag`
  now covers server-rendered HTML while the preview is gated.
- Nation green adjusted to AA contrast; stronger division accents.

### Fixed
- English pages canonicalised to their Swedish twin (would have dropped the English
  corpus from the index).
- `/en/admin` and `/en/404` lost their cache bypass; `/en/api/*` could reach real
  handlers; `/en/en/...` minted unbounded cache entries.
- Swedish-only pages were advertised as having an English alternate and served a
  Swedish page at `/en/…` (now a 301 to the Swedish URL).
- English pagination titles said "Sida"; the English `llms.txt` linked only Swedish URLs.
- 404 pages asserted a canonical URL and hreflang cluster for a URL that does not exist.
- A KV miss was pinned in the isolate cache for the isolate's lifetime; a long edge
  `cacheTtl` pinned misses per colo for hours.
- Translation guard rejected ordinary copy and cached truncated model output forever.
- Duplicate translation of already-translated card blurbs and CTA labels.
- Publication tick: the stale-scan guard read the coordinator revision after the FM
  scan and never fired; unchanged releases were rewritten every minute.
- XSS, proxy-hardening and cache-policy findings from the 2026-09-09 security audit.

### Removed
- `@astrojs/sitemap` (replaced by the hand-written per-locale endpoints).
- The `SearchAction` in WebSite JSON-LD (its target is permanently noindexed).
