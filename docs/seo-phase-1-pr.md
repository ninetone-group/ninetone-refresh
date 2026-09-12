# SEO Phase 1

Implements [docs/seo-phase-1-brief.md](docs/seo-phase-1-brief.md), sections 1–10.
Branch `seo-phase-1`, 8 commits, **not merged**. Deployed to staging only:
**https://ninetone-site.micke-ohlen.workers.dev**

Nothing here makes the site indexable. `PUBLIC_NOINDEX` is untouched, so
`/robots.txt` still serves `Disallow: /` and every page still carries the
noindex meta tag. Flipping that flag is a separate, deliberate launch step.

## Status

- `npm test` — 200 passing
- `npm run build` (static/gh) — 889 pages, post-build audit clean
- `npm run build:cf` (SSR) — clean
- Staging deploy — live and verified (see Verification below)

## What shipped

| § | Change |
|---|---|
| 1 | `src/lib/site.ts` (`siteOrigin`, never a hardcoded origin) and head metadata in `Base.astro`: canonical, full OG + Twitter card set, `theme-color`, favicon set. Ninetone-branded `favicon.svg` / `favicon.ico` / `apple-touch-icon.png` / `og-default.png` replace the stock Astro starter artwork. |
| 2 | `src/lib/schema.ts` pure JSON-LD builders + `JsonLd.astro`. Every page emits Organization + WebSite; detail pages add breadcrumbs and their entity; booking index CollectionPage; contact pages ContactPage. |
| 3 | Dynamic sitemap (`sitemap-index.xml`, `sitemap-pages.xml`) covering every FM entity. `@astrojs/sitemap` dropped — its default output filename collides with ours. |
| 4 | `robots.txt` and `llms.txt` as endpoints. `public/robots.txt` deleted. |
| 5 | Meta descriptions on 12 pages (table below). |
| 6 | Nation category pages at `/ninetone-nation/kategori/{category}`. |
| 7 | Guides route at `/guider`. |
| 8 | 301s for `/blog` and the legacy `/previous-artists` paths. |
| 9 | `fetchpriority="high"` on one hero image per detail page, `aspect-ratio` fallback, visible dateline on news. |
| 10 | IndexNow, shipping dormant behind a `ninetone.com` host gate. |

## Meta descriptions written (§5)

Every one reuses copy already on the page rather than inventing marketing
language. Patrik can edit each directly in that page's `<Base description="…">`.

| Page | Description | Character count | Source | Language |
|---|---|---|---|---|
| Home (`/`) | Ninetone connects what people need with what people care about — music, talent management and booking for artists, creators and public figures since 2006. | 154 | Reused (hero h1 "We connect what people need with what people care about." + Swedish lede content translated/condensed for the English meta surface) | English |
| `/records` | Ninetone Records: A&R, production and artist development from song to universe. Meet the roster and the team shaping Sweden's sound. | 132 | Reused (SplitPortalHero taglines "From song to universe." + "The roster — active and shaping the sound of Sweden right now." + "A&R, production, marketing…") | English |
| `/management` | Backoffice for public people. Ninetone Management builds structure and strategy for Sweden's creators, influencers and public figures. | 134 | Reused (SplitPortalHero tagline "Backoffice for public people." + blurb "A roster of Sweden's most extraordinary creators and influencers.") | English |
| `/ninetone-nation` | Sweden's leading artists, hosts and speakers, available for your event — meet Ninetone Nation's talent and booking team. | 120 | Reused (SplitPortalHero blurb "Sweden's leading artists, hosts, and speakers — available for your event.") | English |
| `/records/artists` | The Ninetone Records roster — active artists shaping the sound of Sweden right now, from song to universe. | 106 | Reused (division page's own SplitPortalHero blurb, since the artists index itself sources its tagline from dynamic FM `WebPosts` data rather than static copy) | English |
| `/management/clients` | The Ninetone Management roster — creators, influencers and public figures we build structure and strategy around. | 113 | Reused (division page's SplitPortalHero blurb + management contact tagline "structure and strategy") — the clients index itself sources its tagline from dynamic FM `WebPosts` data | English |
| `/team` | The people behind the work — meet the A&R, management and booking team at Ninetone Group. | 89 | Reused (page's own static h1 fallback "The people behind the work.") | English |
| `/news` | Releases, signings, tours, and the occasional unguarded thought, from the house in Sundsvall, with a foot in Stockholm. | 119 | Reused verbatim (page's own static lede paragraph) | English |
| `/ninetone-nation/booking` | Sweden's leading artists, hosts and speakers, available for your event — browse bookable talent by category. | 108 | Reused (division page's SplitPortalHero blurb — the booking index's own tagline is dynamic FM `WebPosts` data) | English |
| `/records/contact-records` | Send the music. We reply with merit — submit your demo to Ninetone Records via Spotify, SoundCloud or direct links. | 115 | Reused (page's own heading "We listen to everything." / tagline "Send the music. We reply with merit." + blurb detail) | English |
| `/management/contact-management` | Building a serious career? Let's talk. Reach Ninetone Management with your channels and where you want to go next. | 114 | Reused (page's own tagline "Building a serious career? Let's talk." + blurb "where you'd like to be in eighteen months") | English |
| `/ninetone-nation/contact-ninetone-nation` | Book your next moment. Tell us the artist, the date, the room and the budget — Ninetone Nation replies within one business day. | 127 | Reused (page's own heading "Book your next moment." + blurb "Tell us the artist, the date, the room, and the budget… within one business day.") | English |
| `/integritet` | Information om hur Ninetone Group AB hanterar cookies och personuppgifter. | 74 | **Unchanged** — already present and good; left as-is per the brief's instruction to only improve weak/default descriptions | Swedish |


Two of these need a second look: `/records/artists` and `/management/clients`
have no static English lede of their own — their on-page tagline comes from FM
at build time, which isn't safe to freeze into a fixed meta description — so
they borrow their parent division page's copy. `/integritet` already had a good
Swedish description and was left untouched.

## Decisions where the brief could not be followed as written

**1. `/records/artists/previous/1` does not exist.** The brief uses this path in
§8 and Appendix B uses it in llms.txt. Astro's `paginate()` puts page 1 at the
bare `/records/artists/previous` and pages 2–12 at `/previous/{n}`. Verified in
a real build. Everything targets the bare path. This had already leaked into
both the sitemap and llms.txt as an advertised 404 before it was caught.

**2. Previous-artist detail pages live at `/records/artists/previous/single/{slug}`,**
not Appendix B's `/records/artists/previous/{slug}`. The appendix is wrong; all
341 URLs in llms.txt use the real route.

**3. No `<lastmod>` anywhere in the sitemap.** No public FM layout exposes a
modification timestamp — `filemaker.ts` keeps only `__recordId`, a
creation-order serial. The brief says never to fake it, so it is omitted
entirely rather than filled with a publish date.

**4. "Publicerad" instead of "Uppdaterad" on news articles — needs your call.**
§9 asks for a visible `Uppdaterad {date}` line. There is no modification
timestamp in FM, only the publish date. A *visible* "Updated" label tells a
reader an edit happened after publication, which cannot be verified and would
be fabricated — different from the invisible JSON-LD `dateModified` →
`datePublished` fallback, which is an accepted convention. The line reads
**"Publicerad {date}"**: same dateline, same data, honest label. Say the word
if you want the literal wording anyway.

**5. `sameAs` lists both the English and Swedish Wikipedia articles.** The brief
specifies `en`; the Footer links `sv`. Both articles exist (verified via the
MediaWiki API — en pageid 25086793; Wikidata Q7038555 carries both sitelinks),
so both are included. `sameAs` is a list and both strengthen entity reconciliation.

**6. The legacy `/previous-artists/*` splat has no Astro equivalent.** Astro
validates that a dynamic redirect's destination matches a real route, and the
paginated route's param is `[...page]`, so `[...rest]` is rejected. The splat
stays in `public/_redirects`; the two exact-path rules moved to Astro config.

**7. `@astrojs/sitemap` was dropped rather than kept for the static target.** The
brief allowed either. Its default output filename is `sitemap-index.xml` —
identical to ours — so keeping it would have served two competing indexes. Both
targets now serve the same endpoints; on the static build all four prerender as
real files under the sub-path.

**8. No visible FAQ block on guide pages.** §6 says "an FAQ block rendered"; §7
says only "JSON-LD: `Article` + `faqPage`". The guide's FAQ text already renders
in its markdown body, so a second visible block would duplicate it.

## Verification

### Structured data (`npx structured-data-testing-tool`, Google preset)

| Page | Schemas | Result |
|---|---|---|
| Home | Organization, WebSite | 4/4 passed, 0 warnings |
| Artist (`/records/artists/anjo`) | Organization, WebSite, BreadcrumbList, MusicGroup | 6/6 passed, 0 warnings |
| News article | Organization, WebSite, BreadcrumbList, NewsArticle | 18/18 passed, 0 warnings |
| Nation category | Organization, WebSite, CollectionPage | 5/5 passed, 0 warnings |

The news article initially failed 5 of 18: `publisher` was a bare `{"@id": …}`
reference — valid JSON-LD, since the Organization node is on the same page, but
Google's article validators read publisher in isolation and report `@type`,
`name` and `logo` as missing. The byline was also absent from the JSON-LD
despite being FM data already shown on the page. Both fixed in `29aed6e`.

### Live on staging

```
/blog                                       301 → /news
/previous-artists                           301 → /records/artists/previous
/previous-artists/single/a_choir_of_ghosts  301 → /records/artists/previous/single/a_choir_of_ghosts
/robots.txt                                 User-agent: * / Disallow: /   (flag not flipped)
/sitemap-index.xml                          → /sitemap-pages.xml
/sitemap-pages.xml                          543 entries, 0 duplicates, all absolute under origin
/llms.txt                                   541 lines, 524 links, 0 dead
/ninetone-nation/kategori/{artist,forelasare,influencer}   200
/ninetone-nation/kategori/konferencier      404   (empty category — rule 12)
/guider                                     200
```

Canonical, description and JSON-LD confirmed on home, an artist page, a client
page and the news index. All origins resolve from the request on CF, so nothing
needs changing at cutover beyond `PUBLIC_SITE_ORIGIN`.

## Bugs found and fixed during review

Each was verified in built output, not taken from a self-report.

- **341 previous-artist pages** emitted a `MusicGroup` whose `@id`/`url` pointed
  at a non-existent `/records/artists/{slug}`, contradicting the page's own
  breadcrumbs. Now all 341 point at their real path.
- **`additionalType` never emitted** on any Nation talent page — built on a
  pre-existing always-empty variable. Now correct on all 9.
- **`/records/artists/previous/1` advertised as a 404** in both the sitemap and
  llms.txt (see Decisions #1).
- **11 indexable pages missing** from the sitemap (previous-artist pagination 2–12).
- **Sitemap enumerated Nation talent from the wrong helper** (`getBookingRoster()`
  rather than the `getAllActiveBookingSlugs()` the pages are generated from),
  which would orphan booking-only talents the moment the two sets diverge.
- **`/guider` shipped a literally empty `<main>`** with no `<h1>` while being
  advertised in the sitemap and llms.txt — a thin-content signal. The entire
  editorial header sat inside the empty-list guard, so an absent FM category
  erased the page identity. Rule 12 hides empty *list sections*, not pages.
- **`/guider` was orphaned** — nothing linked to it. Now in the Footer site-wide.
- **Canonical URLs leaked the GH Pages sub-path** onto production origins
  (`https://ninetone.com/ninetone-refresh-preview/…`).
- **Booking category headings became links with no affordance** — identical at
  rest to the plain headings they replaced. Now a persistent `→` on the kicker.

## For the reviewer: the build is the only real gate

Section agents in this phase were not allowed to run builds — concurrent builds
corrupt `dist/` and produce bogus `ERR_MODULE_NOT_FOUND:
dist/.prerender/chunks/_slug__*.mjs` failures that look real and are not. Agents
edited and ran `npm test`; the orchestrator ran both builds once, sequentially,
between batches.

That is the right trade, but it means **a green `npm test` from an agent is
necessary, not sufficient**. Two defects reached the build stage that no amount
of source review or unit testing would have surfaced, both in
`src/pages/[key].txt.ts`:

1. A `*/` sequence inside a glob written in a block comment
   (`src/pages/**/*.astro`) terminated the comment early. Vite failed with
   "Unexpected token". Tests passed.
2. A dynamic route with no `getStaticPaths` — fatal on the static target,
   invisible on cf. Fixed by returning an empty path list when `INDEXNOW_KEY`
   is unset, so the dormant feature emits no key file at all.

A third only appeared at deploy: Astro *appends* its `redirects` config to the
`public/_redirects` copied into the build, so two rules existed twice and
Cloudflare rejected the upload with "Duplicate rule for path". Neither builds
nor tests catch that — only a real `wrangler deploy` does.

## Follow-ups, deliberately not in this branch

- **`DEPLOY.md` is wrong about `_redirects`** (around lines 233 and 259). It
  claims the file is inert on the current Cloudflare target. It is not:
  `_redirects` is honoured on Workers Static Assets the same way `_headers`
  from that directory is — it simply does not fire for routes the Worker
  renders. The failed deploy above proves it. No decision in this branch
  changes, but the claim would mislead the next agent that reads it. One-line
  doc fix, kept out of this PR so a docs correction isn't mixed into an SEO change.
- **`X-Robots-Tag` is absent from CF SSR responses.** `public/_headers` is
  static-asset-only and `src/middleware.ts` sets six security headers but not
  that one. Pre-existing. Staging is still protected by the endpoint and the
  meta tag, so this is belt-and-braces being one strap short — worth adding to
  the launch checklist rather than fixing here.
- **Nation talent booking-category chips never render.** They read from a
  pre-existing always-empty `tags` variable in `ninetone-nation/[slug].astro`.
  The correct data is now computed on that page for `additionalType`, so the
  visible fix is small — but it changes page UI, not structured data.
- **`NewsCard`'s hover mark hardcodes `bg-ninetone-red`.** Pre-existing, and now
  that `/guider` reuses the card its cards show a Records-red mark on a page
  with an ink accent rule. Wants a `theme` prop.
- **Accent rule thickness is inconsistent** between the two new pages: `h-px` on
  `/guider`, `h-0.5` on the category pages. Both have precedent in the codebase
  (roughly 6:2 in favour of `h-px`); worth settling one way.

## At launch (not now)

1. `PUBLIC_NOINDEX=false` — `/robots.txt` then serves Appendix A with
   `Sitemap: https://ninetone.com/sitemap-index.xml`, verified by building with
   the flag flipped.
2. `PUBLIC_SITE_ORIGIN=https://ninetone.com` — every canonical, OG URL, sitemap
   `<loc>`, llms.txt link and JSON-LD `@id` follows automatically.
3. Remove the `X-Robots-Tag` block from `public/_headers`.
4. Set `INDEXNOW_KEY` to activate IndexNow, which stays dormant until the host
   is `ninetone.com`.
