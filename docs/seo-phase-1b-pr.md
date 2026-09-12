# SEO Phase 1b — launch hardening

Implements [docs/seo-phase-1b-brief.md](seo-phase-1b-brief.md), P0 items 1–5 and
P1 items 6–11, on branch `seo-phase-1` (6 commits on top of Phase 1).
**Not merged.** Deployed to staging only:
**https://ninetone-site.micke-ohlen.workers.dev**

Still fully noindexed. `PUBLIC_NOINDEX` is untouched, `/robots.txt` serves
`Disallow: /`, and every page carries the noindex meta tag.

## Status

- `npm test` — 227 passing
- `npm run build` (static) — 546 pages, audit clean, 0 issues
- `npm run build:cf` (SSR) — clean
- Staging — deployed and verified
- Sitemap — **543 URLs, 543 unique, 0 duplicates**

## Headline results

| Metric | Before | After |
|---|---|---|
| Pages without exactly one `<h1>` | 546 | **0** |
| Meta descriptions under 70 chars | 348 | **32** |
| Duplicate `<title>` values | 0 | **0** |
| Zero-byte / broken entity pages | 12 | **0** |
| Nation pages failing an 8-parallel crawl | intermittent | **0 of 27** |

## The two bugs that mattered most

### 1. Twelve "missing entities" were real pages, and the brief's fix would have deleted them

The brief called twelve slugs missing entities that "must 404, and must not be
in the sitemap", and prescribed excluding them via a shared predicate. That was
inferred from the crawl's zero-byte symptom, not from the data.

Verified against live FM and staging: all twelve are legitimate records, present
in the sitemap and on the rendered rosters, and several were observed rendering
their real pages between failures. **Following the brief literally would have
removed twelve real pages from the site and the sitemap.** No exclusion was
added; they now serve 200 with full content (32–50 KB each).

### 2. P0 items 1 and 3 were one bug, and it wasn't a race

Six components used `return Astro.redirect("")` in frontmatter as a "render
nothing" shortcut: `StreamingRow`, `MerchSection`, `WebPostsSection`,
`EditorialNewsBlock`, `LatestNewsSection`, `Pagination`. That is only safe from a
top-level page. From a child component the parent has already begun streaming, so
Astro's `BufferedRenderer` hits
`if (chunk instanceof Response) throw new AstroError(ResponseSentError)` — the
render dies mid-flush with headers already sent, and the visitor gets a
**zero-byte 200**.

It looked intermittent but is **deterministic per entity**: `StreamingRow`'s bad
branch fires only when an entity has no social links at all. All twelve item-1
slugs have zero social fields, as do 11 of 72 active Nation records — so a
parallel crawl across mixed slugs shows a mix of passes and failures that reads
as a load-dependent race.

Ruled out by evidence rather than assumption:

- The **static build renders all twelve completely** (32–50 KB each), so the
  components' inputs were never at fault.
- **Local `wrangler dev` reproduced it 100%**, not intermittently, with every
  FM/Shopify fetch returning 200 — ruling out FM data, subrequest limits, the
  token-cache race, and the Workers CPU limit. The tail `outcome` was
  `ok`/`exception`, never `exceededCpu`.

Captured stack trace, per the brief's requirement:

```
ResponseSentError: The response has already been sent to the browser and
cannot be altered.
    at Object.write (chunks/console_*.mjs:7206:40)
    at BufferedRenderer.flush (chunks/console_*.mjs:6312:53)
    at iterate (chunks/console_*.mjs:6435:42)
```

## A regression this phase shipped and then caught

**The static build was producing 546 redirect stubs instead of pages**, and had
been since `fc58da1`, several commits before anyone noticed.

P0 item 5's trailing-slash canonicalizer ran during the **static prerender
pass**, not just on Cloudflare. Astro builds each prerender URL from
`config.trailingSlash`, and on the gh target (`"ignore"` + directory format)
every path arrives *with* a trailing slash — so the middleware 301'd every route
before `next()` could render it. Astro's `generate.js` saw a 3xx, wrote a
redirect shim in place of the page, and still counted it as built. Build time
collapsed from 53 s to 3 s, no page exceeded 1.2 KB, and the build exited 0.

It surfaced only because P1 item 6 added an H1 audit; the previous audit checked
nothing a stub would fail. Both middleware redirects are now gated on
`PUBLIC_HAS_RUNTIME`. Static is back to 546 real pages in ~50 s; the CF Worker
inlines `PUBLIC_HAS_RUNTIME: true`, so its behaviour is byte-identical to what
was already shipping.

**Lesson for the reviewer:** a green build and a green test suite did not catch
this. The audit did. Post-build assertions about the *output* are worth more here
than anything upstream of them.

## P0

| # | Item | Result |
|---|---|---|
| 1 | Missing entities 404 | Premise corrected — the twelve are real and serve 200. `Astro.rewrite("/404")` forced status 200 in Astro 7.3.2, so genuine 404s were soft-404s; `src/lib/not-found.ts` fixes that at all 10 call sites (verified: unknown slugs return 404 with the full 25 KB page). |
| 2 | Legacy previous-artist redirects | All shapes resolve: `/previous-artists/{slug}`, `/previous-artists/single/{slug}`, the bare path, `/blog`, and `/previous-artists/single` (a listing shape that was 301-ing into a 404). |
| 3 | Intermittent Nation 500s | Same root cause as item 1. 8-parallel crawl × 3 rounds: 27/27 200s, zero exceptions in `wrangler tail`. |
| 4 | `/sitemap.xml` alias | Byte-identical to `/sitemap-index.xml`, sharing the builder. |
| 5 | Trailing slashes | `trailingSlash: "never"` on cf with an in-Worker 301; static keeps `"ignore"`. |

## P1

| # | Item | Result |
|---|---|---|
| 6 | H1s | Exactly one H1 on every page (546 → 0 failures), enforced by a build-failing audit check. |
| 7 | Titles & descriptions | 0 duplicate titles; descriptions under 70 chars 348 → 32. |
| 8 | A–Ö index | All 341 previous artists linked from page 1 — three clicks from home. |
| 9 | Images | `width`/`height` from real proxy dimensions; **CLS is 0**. Homepage hero switched from the 500×500 to the 1000×1000 variant. |
| 10 | Organization logo | New square 512×512 wordmark replaces the 1.91:1 social card. |
| 11 | Self-hosted fonts | 340 KB of woff2; zero `fonts.googleapis.com`/`gstatic.com` references remain. |

## Lighthouse (mobile)

Google's PageSpeed Insights API refused the request ("Quota exceeded … Queries
per day"), so these are from Lighthouse 12 run locally against staging with
mobile emulation — same engine and audits. Field data (CrUX) does not exist for a
`workers.dev` host either way.

| Category | Score |
|---|---|
| Performance | 77 |
| Accessibility | 87 |
| Best Practices | **100** |
| SEO | 69 |

```
LCP  5.0 s     CLS  0        TBT  0 ms
FCP  1.9 s     Speed Index  4.7 s
```

**SEO 69 is the intentional noindex and nothing else** — "Page is blocked from
indexing" is the only failing SEO audit; every other one passes. Expect ~100 once
the launch flag flips.

**CLS 0** is item 9 landing.

**LCP 5.0 s is the real remaining number.** Lighthouse's own opportunities are
small (defer offscreen images 330 ms, properly size images 160 ms), so the bulk is
FM-backed SSR on a cold edge cache plus the hero image. Worth a deliberate look
rather than a guess — and note that a local run over the public internet to
workers.dev is pessimistic versus the production domain behind Cloudflare's CDN
with a warm cache.

## Substitute decisions — where the brief could not be followed as written

1. **The twelve entities are not excluded** (P0 1). They are real; excluding them
   would have deleted twelve live pages. They serve 200.
2. **`/team/emma_blyfors` has no double H1 because it no longer exists** (P1 6).
   That URL 404s — the record is gone from FM, absent from the sitemap and the
   team index. The crawl saw a page that has since been removed. The underlying
   bug class was real and is fixed anyway: `renderBio` now clamps a markdown
   `#` to `<h2>`, so FM prose can never emit a competing H1.
3. **No 29 pages fall back to the default `og:image`** (P1 9). An exhaustive
   crawl of all 513 entity detail pages found zero. Only list/index pages use the
   default, which is correct. Phase 1's wiring landed after the crawl was taken.
4. **Trailing slash redirects with 308, not the requested 301** (P0 5).
   Cloudflare's static-asset layer normalizes before the Worker runs. Both are
   permanent and consolidate ranking signals identically; 308 also preserves
   method and body. The `/api/*` exemption cannot apply to requests answered at
   that layer — verified harmless (POST to `/api/contact` reaches the handler,
   nothing links to an API path with a trailing slash).
5. **Legacy redirects live in `public/_redirects`, not `astro.config.mjs`**
   (P0 2). The Cloudflare adapter writes dynamic redirect destinations with an
   `/index.html` suffix, which 404s on an SSR Worker, and Cloudflare rejects
   duplicate paths outright so a corrected copy cannot shadow the generated one.
   The middleware carries the same logic as a backstop.
6. **Description coverage extended past the brief's scoping** (P1 7). The brief
   scoped the bio fallback to records artists and management clients; previous
   artists (303 short → 0) and team (16 → 3) share the same layout and FM bio
   field. The team fallback respects the existing `isAiSpeculative` guard, so a
   bio suppressed on the page cannot reappear in a meta tag.
7. **The A–Ö index is collapsed behind a toggle** (P1 8), which the brief did not
   specify. 341 links would dominate the page. The collapse is `max-height` only
   — every link is in the static HTML, so crawl depth is genuinely three clicks —
   and the panel is `inert` while collapsed so keyboard users don't tab through
   341 invisible targets.
8. **`NewsCard` and `YouTubeFeed` get no `width`/`height`** (P1 9). Their variants
   are genuinely variable (news covers measured at 1007×488, 930×488, 906×488;
   YouTube thumbnails fall through three resolutions), and the brief says not to
   invent numbers.

## Pre-existing issues found, deliberately not fixed here

- **Four accessibility failures**, none introduced by this phase:
  - `color-contrast` — 20 nodes, all `.kicker text-ninetone-ink/55` at ~4.0:1
    against paper where 4.5:1 is required. This is the design system's
    most-repeated primitive (CLAUDE.md rule 3), so it is a DESIGN.md decision —
    darken the token or raise the opacity step — not a one-off fix.
  - `aria-hidden-focus` — the CommandPalette `#cmdk` container is
    `aria-hidden="true"` while containing focusable children.
  - `definition-list` — a `<dl>` whose direct children are `div > span`.
  - `image-redundant-alt` — 20 roster cards whose `alt` duplicates the adjacent
    visible artist name.
- **Title collisions remain possible on team and Nation talent pages.** The brief
  scoped the role-marker fix to records/management; someone who is both a
  Management client and a Nation talent would still collide.
- **FM has a duplicate slug**: `velvet` matches two records on
  `API_ARTIST_DETAIL` (`foundCount: 2`), silently tolerated by the `limit: 1`
  lookup. Not touching FM, per CLAUDE.md.
- **`DEPLOY.md` is wrong about `_redirects`** (carried over from Phase 1, and now
  proven by a failed deploy): the file *is* honoured on Workers Static Assets. One
  line to correct, after merge.
- **`dist/server/virtual_astro_middleware.mjs` leaks a local home-directory path**
  via Vite's `import.meta.env`. Cosmetic, not visitor-reachable.
- **Newsreader's woff2 files retain the `opsz 6–72` axis** (279 KB of the 340 KB)
  while `global.css` pins `font-variation-settings`. Subsetting that axis out
  would cut them substantially at no visual cost.

## Before DNS moves — for Patrik, and only Patrik can do it

**Export the indexed URLs from Search Console's Pages report.** Once DNS moves,
the old site stops being crawlable and the record of what Google actually had
indexed is gone. No crawler can reconstruct it: the live site's links are built in
JavaScript, which is why the audit found **zero links and nine H1s** on its
homepage. That export is the list every old URL gets tested against on the new
build, and the window closes at cutover.

## At launch

1. `PUBLIC_NOINDEX=false` — `/robots.txt` switches to Variant A with the
   `Sitemap:` line; Lighthouse SEO should reach ~100.
2. `PUBLIC_SITE_ORIGIN=https://ninetone.com` — every canonical, OG URL, sitemap
   `<loc>`, llms.txt link and JSON-LD `@id` follows.
3. Remove the `X-Robots-Tag` block from `public/_headers`.
4. Set `INDEXNOW_KEY` to activate IndexNow.
