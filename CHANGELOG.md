# Changelog

All notable changes to the Ninetone Group site. Versions follow `MAJOR.MINOR.PATCH.MICRO`
(the number in `VERSION`).

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
