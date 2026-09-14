# Handoff — "Tidigare klienter" (previous clients) pages — 2026-09-14

Next session: read this in full first. Then `DESIGN.md`, then the two files the
work mirrors: `src/pages/records/artists/previous/[...page].astro` (list) and
`src/pages/records/artists/previous/single/[slug].astro` (detail). Do not
re-derive anything below.

## Why

The GSC "Pages" export (last 3 months, run through staging on 2026-09-14) shows
421 indexed ninetone.com URLs: 178 exist on the new site, 225 redirect by rule,
18 are 404s. Four of the 404s are **former management clients with real
traffic** (`/management/clients/bangarden_customs` 503 impressions,
`raketforskaren`, `luddze_`, `johanna_and_marcus`). They are in FM as
`filterActive = "Not Active"` on `API_Management` (140 records), but the new
site has no section for former clients, so nothing can redirect there. Mikael
and Patrik agreed: build it, like previous artists.

## What exists already (reuse, don't rebuild)

- `getPreviousClients(opts?)` in `src/lib/ninetone.ts` — the Not Active query,
  sorted by Head Artist, limit 500. Warmed by the 5-minute FM cron
  (`src/worker-entry.ts` loader `previous-clients`), so it is in KV.
- `getPreviousArtists()` + the two previous-artist pages: list with A–Ö index
  and pagination (30/page), detail page. Copy their structure and copy.
- `src/lib/roster-redirect.ts` — `crossRosterTarget(slug, from, siblingRoster)`
  with `ARTIST_PATH` / `PREVIOUS_ARTIST_PATH`. Generalise it (or add a client
  pair) so `/management/clients/{slug}` for a Not Active client 301s to the new
  previous-client URL and vice versa, exactly like the artist routes do (see
  the `if (!artist)` blocks in `src/pages/records/artists/[slug].astro` and
  `…/previous/single/[slug].astro`).
- Middleware TTL tier for `/management/clients/…` is 1 h; add the new list
  path to `TTL_RULES` in `src/middleware.ts` at the roster tier (21600) next to
  `/records/artists/previous`.
- Sitemap: `src/pages/sitemap-pages.xml.ts` enumerates previous artists —
  add previous clients the same way (both locales). `src/lib/routes.ts` for
  the static route list; `src/lib/llms.ts` if it lists sections.
- i18n: chrome strings through `sharedT(Astro.locals)`; whole sentences with
  `{placeholders}` (see the previous-artists list page, 2026-09-13 fix) and
  add Swedish overrides in `src/i18n/overrides.json` for the page title
  ("Tidigare klienter"), kicker and counter sentences. `hasEnglishVersion`
  in `src/lib/i18n.ts` — the new paths are bilingual (nothing to add unless
  the prefix list is an allow-list; check).
- Design: archetype (a) editorial section page for the list, (b) detail page
  (sticky split, image col-span-5 / content col-span-7). Kicker + h1 + lede +
  accent rule, `sectionAccent["management"]`. Hide empty sections. Square
  corners. No new fonts.

## Suggested URLs

- List: `/management/clients/previous` (+ `/management/clients/previous/{n}`
  for pages 2+, mirroring `/records/artists/previous`).
- Detail: `/management/clients/previous/single/{slug}`.
- Tabs on the clients list page like `ArtistsTabs.astro` ("Klienter" /
  "Tidigare klienter") — check how `src/pages/management/clients.astro`
  renders its header before adding.

## Definition of done

1. Both pages render in sv and en on staging; the A–Ö index and pagination
   work; empty categories hidden.
2. `/management/clients/bangarden_customs` (and the other three) 301 to the
   new detail page, locale kept; a re-activated client's previous-URL 301s
   back. Unknown slugs still 404.
3. Sitemap lists the new pages in both locales; llms.txt if applicable.
4. Tests: unit test for the redirect helper (extend
   `test/roster-redirect.test.mjs`), middleware TTL rule, sitemap inclusion.
   `npm test` green (734 at handoff), `npm run build:cf` green.
5. Deploy with `npm run deploy:cf`; verify the four GSC URLs live with curl;
   re-run the GSC classifier
   (`scratchpad …/perf/classify.mjs` was session-local — recreate: sitemap
   paths vs `docs/`-free list; the 18-URL list is in this doc's "Why").
6. Bump `VERSION` (0.2.3.0 → 0.2.4.0) and `CHANGELOG.md` in the same commit.
   Work on a branch, open a PR, merge after CI (Mikael has been merging
   same-day).

## Constraints (unchanged)

No FM-side changes; the Data API is the surface. Respect FM load: the list is
already warmed, so the pages must read through `getPreviousClients()` /
`fmFind` only — no new per-request FM finds beyond the detail record lookup
the artist detail page already does. Keep `arrayBuffer()` buffering and the
25-call translation budget. Do not touch `src/lib/publication/`.

## Also open (not this task)

- Two Nation talents now inactive (`/ninetone-nation/booking/aw`,
  `…/mia_karlsson`) redirect into a 404 — same shape of problem, smaller;
  decide later whether Nation gets a "previous" section.
- Secrets baked into the cf build bundle (see memory / CHANGELOG 0.2.1.0).
- Tiered warm-cron cadence pending Patrik's view on FM Data API metering.
- GSC spike on 2026-09-12 = shop blog post about Doug Seegers; unrelated.
