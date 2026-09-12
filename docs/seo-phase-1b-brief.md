# Phase 1b — launch hardening from the external crawl

Findings from a 543-URL crawl of staging (2026-09-11), verified by Fable. Build spec, same rules as [seo-phase-1-brief.md](seo-phase-1-brief.md): branch `seo-phase-1`, agents edit and test only, orchestrator builds and deploys, reviewer per section. Do this BEFORE Phase 2.

## P0

**1. Missing entities must 404, and must not be in the sitemap.**
Twelve slugs return 200 with an empty body or the 404 page body: `styrelsen`, `galia_mashchenko`, `f_a_p_` (records; the first two also under management), and previous singles `ninetone_collections`, `silver_lantern_sons`, `somewhere`, `sveriges_unga`, `velvet`, `victor_och_natten`, `yohio`. Cause A: the detail routes do `return Astro.rewrite("/404")`, which serves the 404 page with status 200; some responses come back zero-byte, so also check how `src/middleware.ts` handles a rewritten response (body consumed before store? `harden()` on a null body?). Fix: on a failed lookup return the 404 page with a real 404 status (Astro supports `new Response(null, { status: 404 })` with the 404 route, or rewrite plus `Astro.response.status = 404`; pick what works on this Astro version and verify with curl). The middleware must never cache a non-200. Cause B: the list helpers (roster, previous, clients) return these slugs but the detail lookup (`API_ARTIST_DETAIL` find by `SLUG`) does not find them. Find out why before changing anything: compare the raw FM rows for two of them (fetch by slug on both layouts, print the fields). Likely candidates: a trailing-underscore or special-char slug that the find query mangles, or a record present on the list layout but filtered on the detail layout. Fix at the lookup if it is a query bug; if the record is genuinely absent on the detail layout, exclude it from lists and sitemap using the same predicate the detail route uses (one shared function, like `booking-status.ts`). Test: a unit test on the shared predicate; curl all twelve → 404 with body; sitemap no longer lists them; count of `<url>` reported.

**2. Legacy previous-artist redirects.** The live site serves `/previous-artists/<slug>` (verified: `/previous-artists/kuokka` is 200 there, `/previous-artists/single/kuokka` is 404). Add the dynamic redirect `/previous-artists/[slug]` → `/records/artists/previous/single/[slug]`, keep the existing `/single/` rule and the bare one. Also `/search-result` from the old sitemap: confirm the new route responds 200 at the same path. Verify on wrangler dev with two real slugs.

**3. Intermittent 500s on Nation talent pages under 8 parallel requests** ("Worker threw exception", fine on retry). Reproduce: `xargs -P 8` over the Nation slugs three times while `wrangler tail` runs; capture the exception. Suspects: the FM token cache racing across concurrent first requests (two logins, one invalidated), a subrequest or CPU limit on pages that fan out to FM + YouTube + Shopify, or an unhandled rejection in a `Promise.all`. Fix the root cause; add a test if it is code; report the stack trace either way.

**4. `/sitemap.xml`** must serve the same document as `/sitemap-index.xml` (alias endpoint). The launch `robots.txt` (Variant A) already carries a `Sitemap:` line pointing at the index.

**5. Trailing slashes.** On the CF target set `trailingSlash: "never"` and have the middleware 301 `/path/` → `/path` (never for `/`, never for `/api/*`, before the cache lookup). The static target keeps its current setting (directory index files). Verify `/records/` → 301 → `/records`, canonical unchanged.

## P1

**6. H1s.** `/records`, `/management`, `/ninetone-nation` have no H1; the hero heading in `SplitPortalHero` (or the page's typographic hero) becomes the H1 with no visual change (same classes). `team/emma_blyfors` has two H1s; make the second an H2. Post-build check: exactly one H1 on every page.

**7. Titles and descriptions.** Pagination pages: append " · Sida N" for N ≥ 2. Same person under records and management: title patterns `{Name} · Artist | Ninetone Records` and `{Name} · Client | Ninetone Management` so they never collide; descriptions: when the tagline/blurb is under 70 characters, fall back to the first ~150 characters of the bio, plain text, cut at a word boundary. News: when the FM title exceeds 60 characters, drop the ` | Ninetone Group` suffix. Report counts before/after (duplicates, under-70 descriptions).

**8. Previous artists A–Ö index.** One page `/records/artists/previous/index` is already page 1; add a compact alphabetical list section at the top of page 1 (reuse `RosterIndex`) linking every previous artist detail page, so no detail page is more than three clicks from home. Editorial archetype; hide if empty.

**9. Images.** Add `width`/`height` attributes to every `.fm-img` (the proxy variants have fixed output sizes; read them from `worker-fm-proxy/src/index.ts` and `LAYOUT_CONFIG`; if a variant is not fixed-size, use the aspect utility plus `sizes`, no invented numbers). The homepage hero currently loads the `small` (500×500) variant into a 610 px slot with `fetchpriority=high`; switch it to `big`. Entity pages with an image must use it as `og:image` (29 pages fall back to the default today; list which remain after the fix and why).

**10. Organization logo.** Add a square 512×512 PNG of the wordmark to `public/` and point `Organization.logo` at it. `og-default.png` stays for OG.

**11. Self-host the three Google Fonts** (all OFL): woff2 files in `public/fonts/`, `@font-face` with `font-display: swap` in `global.css`, `<link rel="preload">` for the two display weights used above the fold, remove the Google Fonts `<link>`s and preconnects from `Base.astro`. DESIGN.md rule 10 requires updating both places; update DESIGN.md's font section to say self-hosted. Verify no request to fonts.googleapis.com or fonts.gstatic.com remains in the built HTML/CSS.

## Not doing here (recorded so nobody re-raises it)

- Per-page `lang`, `og:locale`, `inLanguage`: Phase 2 (i18n) owns these.
- Slug generator quirks (`avdelning_`, `crashdet`, `_feet`): URLs are kept as they are because they match the live site; do not change the function for existing content.
- Proxy host under the own domain: needs the zone, cutover checklist.
- Mobile Core Web Vitals: run PageSpeed Insights manually after this phase and paste the numbers into the PR description.

## Definition of done

`npm test` green, both builds green, audit clean; the twelve URLs 404 with the 404 page body; sitemap `<url>` count reported and excludes them; the three redirect shapes verified on wrangler dev; 8-parallel crawl of all Nation pages three times with zero non-200s; one H1 per page across the whole built output; no duplicate `<title>` across the sitemap; no Google Fonts requests; PR description `docs/seo-phase-1b-pr.md` with before/after counts and every substitute decision.
