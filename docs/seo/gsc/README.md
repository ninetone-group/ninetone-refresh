# Google Search Console exports

Raw GSC performance exports, one folder per export date. The first folder is the
**baseline** taken four days after the new site went live on www.ninetone.com
(2026-10-08), so almost everything in it describes the old DivHunt site. Later exports are
compared against it to see what the new site does to search traffic.

```
docs/seo/gsc/
  2026-10-12/     baseline — Web search, last 16 months (2025-06-11 .. 2026-10-10)
    Chart.csv            daily clicks / impressions / CTR / position
    Pages.csv            top 1000 pages
    Queries.csv          top 1000 queries
    Countries.csv, Devices.csv, Search appearance.csv, Filters.csv
```

The property is the **domain property**, so the export covers every ninetone.com host:
www, shop (Shopify), link (smart links), files, music, vip. Only `www.ninetone.com` is
this repo.

## Taking the next export

1. GSC → Performance → Search results. Keep Search type = Web. Set the date range so it
   overlaps the baseline (last 16 months is fine; the compare script trims to the common
   window by itself when you give it one).
2. Export → Download CSV. Unzip into `docs/seo/gsc/<YYYY-MM-DD>/` keeping Google's file names.
3. Run the two scripts below and add a short "what changed" section to this file.

```bash
# clicks / impressions / position deltas, by host, by section, top movers
node scripts/gsc-compare.mjs docs/seo/gsc/2026-10-12 docs/seo/gsc/<new-date>

# fetch every www.ninetone.com URL in the export; lists 404s and redirect chains
node scripts/gsc-url-probe.mjs docs/seo/gsc/<new-date>
```

Both are read-only. The probe makes one GET per URL against production (about 500
requests, six at a time, under a minute).

---

## Baseline, 2026-10-12 (16 months, ending 2026-10-10)

### Totals

| | Clicks | Impressions | CTR | Position |
|---|---|---|---|---|
| Whole property, 16 months | 24,200 | 1,080,628 | 2.24% | ~7.6 |
| Last 30 days (2026-09-11 .. 10-10) | 1,446 | 54,843 | 2.64% | ~7.2 |
| Previous 30 days (08-12 .. 09-10) | 1,163 | 52,638 | 2.21% | |
| Same 30 days a year earlier (2025) | 1,513 | 53,615 | 2.82% | |

Daily run rate going into the launch: about **45 clicks and 1,800 impressions a day**.
That is the number to beat.

By host (from Pages.csv, top 1000 pages):

| Host | Pages | Clicks | Impressions |
|---|---|---|---|
| www.ninetone.com | 494 | 17,891 | 954,820 |
| shop.ninetone.com | 419 | 6,905 | 272,797 |
| ninetone.com (apex, redirects) | 2 | 276 | 6,584 |
| link.ninetone.com | 82 | 15 | 1,293 |

Audience: Sweden 85.6% of clicks, mobile 72.8%. Only three search-appearance types
register: Product snippets (1,623 clicks, shop), Translated results (33), Merchant listings
(18).

### www.ninetone.com by section

| Section | Pages | Clicks | Impressions | CTR |
|---|---|---|---|---|
| /records/artists/* | 263 | 6,031 | 503,804 | 1.20% |
| / (homepage, incl. apex + http) | 4 | 4,171 | 24,671 | 16.9% |
| /news/* | 82 | 2,471 | 135,990 | 1.82% |
| /management/clients/* | 54 | 2,302 | 192,411 | 1.20% |
| /ninetone-nation/booking/* | 19 | 1,096 | 26,457 | 4.14% |
| /team/* | 21 | 1,026 | 25,815 | 3.97% |
| /team | 1 | 576 | 11,548 | 4.99% |
| /management | 1 | 130 | 10,361 | 1.25% |
| /records/artists | 1 | 124 | 6,856 | 1.81% |
| /records | 1 | 63 | 7,222 | 0.87% |
| /previous-artists/* | 28 | 19 | 1,159 | |
| /en/* | 10 | 2 | 47 | |

Artist and client detail pages carry two thirds of the impressions but convert at 1.2%:
people search a name, see the Ninetone page at position 5–11, and click something else
(Wikipedia, Instagram, the artist's own site). The homepage and the team pages convert
5–20× better because the query is "ninetone".

### Queries

Brand queries ("ninetone", "ninetone records", "ninetone group ab", misspellings) are
20 of the 1000 rows but **4,340 of 13,093 query clicks** (33%), all at position 1–4. The
rest is artist and client names. The single biggest non-brand topics are Doug Seegers
(where does he live, net worth, girlfriend) and Joakim Lundell (height, tour 2026,
merch), and most of those clicks go to the **shop blog**, not www.

High-impression pages with CTR under 1% (title/snippet opportunities once the new site
has settled): `/records/artists/anjo` (22k impressions), `/records/artists/disreign`
(25k), `/management/clients/kammi_rosenskjold` (19k), `/management/clients/anjo` (18k),
`/records/artists/klara` (14k), `/records/artists/joakim_lundell` (14k, 0.11%).

### Daily chart, things to know when reading it

- 2025-12 to 2026-02 was the high season (3,000–4,000 impressions/day, Kristallen and
  Spökjakt news). Summer 2026 is the trough. Compare year over year, not month to month.
- 2026-09-12 is a one-day spike (354 clicks, 9,098 impressions) on an otherwise normal
  week. Treat as an outlier.
- 2026-09-18 to 09-25 impressions fell to 465–1,300/day, a third of normal, then
  recovered by 09-27. This is **before** the DNS cutover and predates anything in this
  repo; it is the old host.
- The new site has three days of data in this export (10-08, 10-09, 10-10): 41, 38, 37
  clicks. Indistinguishable from the weeks before. Nothing has happened yet.

### URL migration, verified against production 2026-10-12

All 496 `www.ninetone.com` / `ninetone.com` URLs in Pages.csv were fetched from the live
Worker (`scripts/gsc-url-probe.mjs`):

| Result | URLs | Clicks (16 mo) |
|---|---|---|
| 200 directly | 196 | 12,120 |
| 200 after a 301 | 280 | 5,986 |
| 404 | 20 | 61 |

The redirects are the legacy-URL rules doing their job, and Google will spend the next
weeks moving index entries to the new URLs. Expect the `Pages` report to churn:

- `/records/artists/<slug>` → `/records/artists/previous/single/<slug>` (245 URLs,
  4,397 clicks). Everyone who is no longer on the roster, including the three biggest
  artist pages: Dogma Society, Ronny & Ragge, Öresund.
- `/ninetone-nation/booking/<slug>` → `/ninetone-nation/<slug>` (9 URLs, 1,048 clicks,
  Joakim Lundell is 898 of them).
- `/management/clients/<slug>` → `.../previous/single/<slug>` (13 URLs) and two re-slugged
  active clients (`bangarden_customs` → `bangarden`).
- 7 URLs take two hops (booking → nation → previous artist). Harmless, but the final
  URL is what Google should settle on.

The 20 404s are people and artists with no FM record on the new site (former team
members `jesper_lindgren`, `tommy_backstrom`, `johan_karlsson`, `leo_linder`; artists
`emilush`, `fredrikvon`, `Dilbamusic`, `liampinelakee`, `AndreAnd_Music`), two FM
`null` slugs, and junk (`/records/artists/*`, `/news/253Ca2520href`). 61 clicks in 16
months between them. Nothing to fix.

### What to look at next month

1. **Run rate.** Last-30-day clicks and impressions versus 1,446 / 54,843. A dip during
   re-indexing is normal; it should recover within 4–8 weeks.
2. **Position on the brand queries** stays 1–2. If "ninetone" or "ninetone records" slips,
   something is wrong with the homepage.
3. **Index moves to the new URLs.** `/records/artists/previous/single/*` and
   `/ninetone-nation/<slug>` should appear in Pages; the old shapes should fade. The probe
   script's redirect count should fall.
4. **`/en/*` impressions** come off zero now that English pages exist and are in the
   sitemap. "Translated results" appearance should fall as real English pages replace
   Google's auto-translation.
5. **CTR on artist detail pages.** The new pages have real titles and descriptions; the
   1.2% section CTR is the baseline.
6. **404s in GSC's Pages > Not indexed report**, cross-checked with the probe.
