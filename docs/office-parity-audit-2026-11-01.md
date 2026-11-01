# Office data-parity audit — 2026-11-01

Read-only comparison of what the site reads from FileMaker (`files.ninetone.com`, the
pre-migration data) and from Ninetone Office (`https://office.ninetone.com`, the production
source since v0.3.3.3 on 2026-11-01). Every find the site issues was run against both
sources, live and uncached, and diffed record by record and field by field.

- Script: `scripts/office-parity-audit.mjs` (read-only; one FileMaker session, bearer GETs
  on Office; writes only its two report files).
- Generated detail: `docs/audit-evidence/office-parity-2026-11-01/report.md` (every
  differing value, grouped by field) and `results.json` (everything, machine-readable).
- Mapping it is checked against: `docs/handoff-codex-report-2026-11-01.md` §2 and
  `docs/handoff-codex-database-migration-2026-10-26.md` §4–5.
- Nothing was changed in either database or in the site code.

## Summary for Patrik

Written for: Patrik, as the Office owner. Plain language, no code.

The migration carried the data over correctly. Every record the website shows exists on
both sides with the same slug, so no URL changed. All 37 text blocks that build the
homepage and section intros are identical and keep their ids. No image the site shows was
lost: 2,157 of 2,158 release covers, all 85 news pictures, all team photos and all active
roster pictures resolve on Office, and Office fills several pictures FileMaker never had.

Five things are different on the public site, in order of visibility:

1. **Release pitch text on the discography pages.** For 945 of 2,158 releases the text
   under a release is now Office's Spotify pitch message ("Vi har precis släppt en singel
   med (Artist – Title) som vi hoppas skulle kunna passa…", 935 of them start exactly like
   that) instead of the editorial description FileMaker showed. The Office mapping puts the
   internal pitch before the public text. Internal pitch copy is now visible on
   www.ninetone.com, on 161 releases of currently active artists. Decision needed: show
   the public text first and fall back to the pitch only when there is none, or keep this.
2. **42 release dates changed.** Office uses the original release date. FileMaker held
   placeholder dates on many of these (the same 04/14/2008 or 01/25/2012 on whole
   discographies, for example Alvix and Patrick Aurelle), so most of these look like
   corrections. Two releases changed type (Tommy Nilsson "Samma Människa" and Norma Bates
   "Hey You! Get Down!" are now albums, not singles) and Norma Bates' album links moved to
   a different Linkfire id. Worth a quick look at those three.
3. **Roster changes, as decided before the cutover.** F.A.P. moved from active to previous
   Records artists. Annika Ljungberg is new in Records with no photo, no biography and no
   releases yet. Margaux Dietz is active in Management again. The team page shows 12 people
   instead of 3, in the order Office gives them (the nine re-enabled people sort between
   you and Birk/Joacim because their sort keys are 1216–1224 and the list is sorted as
   text). Stefan Hallgren's page is back.
4. **Links.** Office validated the social links. 84 values FileMaker held were dropped,
   almost all of them bare handles ("corrodedsweden"), doubled "@@" TikTok addresses or
   notes pasted into a URL field; on the old site those rendered as broken links, so this
   is a repair. Four are real editorial changes to check: Evelina Reuterfors' Instagram now
   points to a different account, Joy J's Instagram and TikTok were trimmed to one account,
   Team Lost's and The Swedish Family's multi-account links are gone. On the plus side,
   Office supplies streaming links (Spotify, Apple, Amazon, YouTube Music) for 8 active
   Management clients (20 counting former clients) and 8 of the 9 Nation talents that had
   none, a YouTube channel for 24 active Records artists, genre and tag chips on Management and Nation pages, and Karakou and
   Sudretsällskapet now get a merch section on their Nation pages.
5. **Small text changes.** Velvet's biography switched from the English FileMaker text to
   Office's Swedish one. Your own team title and biography changed (your edit in Office).
   46 news articles show the body with the original quotation marks that FileMaker's
   display field had stripped.

Nothing here needs the website code to change. Items 1, 2 and 4 are Office data decisions.

## What was compared

56 finds, each run once against FileMaker and once against Office with the exact body the
getter in `src/lib/ninetone.ts` sends (query, sort, limit, offset, portal limits):

| Query | Layout | FileMaker | Office |
|---|---|---|---|
| `getArtists` | API_ARTIST | 31 | 31 |
| `getArtistsWithReleases` (nightly release count) | API_ARTIST_DETAIL + releases | 390 artists, 2,192 release rows | 391 artists, 2,191 release rows |
| `getPreviousArtists` | API_ARTIST_DETAIL | 343 | 344 |
| `getClients` | API_Management | 37 | 38 |
| `getPreviousClients` | API_Management | 140, 120 after the picture filter | 119, 119 after the filter |
| `getBookingRoster` | API_Booking | 9 | 9 |
| `getPreviousBooking` | API_Booking | 17 | 17 |
| `getBookingCategories` | API_BOOKING_TAG + talents | 6 categories, 30 rows | 3 categories, 20 rows |
| `getNews` | API_NEWS | 85 | 85 |
| `getWebPosts` (all sections) | API_WEBPOSTS + blocks | 6 sections, 37 blocks | 6 sections, 37 blocks |
| `getTeam` | API_USERS | 3 | 12 |
| `getWebPosts(category)` for the 5 sections, Promo, Guider, and `FAQ <tag>` for all 6 tags | API_WEBPOSTS | as above; Promo, Guider and FAQ empty on both | same |
| `getArtistDetailWithReleases(slug)` for all 32 active artists on either side | API_ARTIST_DETAIL + releases | 31 found | 32 found |

The per-slug Nation lookups (`getBookingPageSet` extras) did not fire: every curated talent
is in the strict roster on both sides.

In total 3,647 records and portal rows were matched. Of 90,942 field values compared:

| Bucket | Values | Meaning |
|---|---|---|
| identical | 56,098 | same string |
| intended | 12,648 | a normalisation the Codex report declares (table below) |
| cosmetic | 138 | invisible on the site |
| image | 59 | an image field filled on one side only (all gains, see below) |
| unused | 20,235 | fields the site never reads on that layout |
| **differs** | **1,764** | real content differences in fields the site shows |

Declared normalisations found, all as described in the Codex report:

| Normalisation | Values |
|---|---|
| Image URLs re-addressed to `/api/office-images/…` | 4,488 |
| Line endings CR/CRLF → LF | 2,735 |
| Portal and record ids re-minted | 2,516 |
| `Green Web Category::Cover_Picture` no longer emitted (`coverPicture_webp` is authoritative) | 2,479 |
| `url_youtube_link` filled from FileMaker's `url youtube(1)` (declared import event) | 368 |
| `MessageString` now equals `Message` (declared: `fields.body` for both) | 46 |
| FileMaker `[MBS] Invalid image reference` rows → empty | 16 |

Cosmetic: release `Type` "EP" → "Ep" on 62 rows (the site lowercases), the timestamp in
`webPost::sortOrder` spelled `2025-02-14 16:08:55` instead of `02/14/2025 16:08:55` on all
71 blocks (both are NaN for the site's numeric sort, so the portal order decides, as before),
two album names in a different Unicode normalisation form, three whitespace-only values.

## Findings

### 1. Records present on one side only

All of these are the status decisions the Codex report lists, plus the test rows it
excluded. No record the old site showed is missing without a declared reason.

| Where | Record | FileMaker | Office |
|---|---|---|---|
| Records active | `f_a_p_` F.A.P. | Active | Not Active (now in previous artists) |
| Records active, all artists | `annika_ljungberg` | absent | Active; 0 releases, no picture, no biography |
| Management active | `margaux_dietz` | Not Active (previous) | Active |
| Management previous | 20 rows with `[MBS] Invalid image reference` in both picture fields | present, dropped by `hasProfileImage()` | absent (disabled in the registry) |
| Team | 9 people (`annbeath_frisk`, `embla_frisk`, `johanna_olandersson`, `per_skiold`, `patrik_norman`, `susanne_bertlin`, `molly_hl`, `stefan_hallgren`, `philip_vedl`) | `Active` ≠ Ja | `Active` = Ja |
| Nation categories | Konferencier (2 rows), Moderator (2), Underhållare (1) | present, 0 Active talents each | not emitted |
| Nation category rows | `the_swedish_family` ×2, `alexandra_nilsson` ×2, `caroline_ravn` | Not Active | not emitted |

Across all 390 Music artists the status distribution is the same on both sides except
F.A.P.: 31 Active, 344/345 Not Active, 15 Saved. The 120 vs 119 former clients is
Margaux moving to active; after the picture filter the two lists are otherwise identical.

The Nation categories and rows Office omits are exactly the ones the site already hides
(`isActiveBookingArtist()`, empty-category filter), so /ninetone-nation/booking renders
the same. `getWebPosts("Ninetone Group")` returns two records from FileMaker (its `=`
operator is a word-prefix match and also hits "Ninetone Group Team") and one from Office;
the site selects the exact category, so nothing changes.

### 2. Record order

- `getArtists`, `getClients`, `getPreviousClients`, `getBookingCategories`, `getWebPosts`: same order.
- `getNews`: differs from the sixth item. Two posts dated 10/09/2026 (Lisa Borg, Agnes
  Matsdotter) swap places. FileMaker broke the tie on creation time; Office does not.
  Visible on /news and in the RSS feed for same-day posts.
- `getPreviousArtists`: differs from position 22. "André Andersson" sorts after "Andrea
  Lundquist" on Office (code-point order) and before it in FileMaker (locale collation).
- `getTeam`: differs from position 1. Office sort keys are strings; the nine re-enabled
  members have `sortOrder` 1216–1224, which sorts before "20" (Birk, Joacim). Birk and
  Joacim also swapped (both "20"). The page puts the CEO first and photographed people
  before others, so the visible effect is the order within those groups.

### 3. Fields that really differ (1,764 values, 33 fields)

Full lists per field are in the generated report. Grouped by what a visitor sees:

**Release pitch (`Green Web Album::spotifyPitch`, 945 of 2,158 releases, 161 on active
artists).** Office returns the Spotify pitch message (`spotify_pitch_sv` → `pitch_message_sv`
→ public text, in that order per the mapping). 935 of the 945 start with "Vi har precis
släppt en singel med (…)". FileMaker returned the editorial release text. The Discography
component renders this field (`r.pitch`), so the internal pitch template is now public on
every discography. This is the one finding I would act on.

**Release dates (`Releasedate First`, 42 rows).** Office uses the original release date.
The FileMaker values were placeholders on 30 of them (04/14/2008 on 9 rows across six
artists, 01/25/2012 on 17 rows for Alvix/LIN/JJM/Douglas T, 06/30/2022 on 4 J.O.X rows);
three rows had no date and now have one. The remaining nine are individual corrections
(Yohio, Toftgård, Robbin & JP, Norma Bates, Rasmus Sandström, two La Bomba releases, and
"Jolene" for Oberg and J.O.X moved from 10/30 to 11/06/2026). The discography is sorted by
this field, so these artists' release order changed.

**Release type and links.** Tommy Nilsson "Samma Människa" and Norma Bates "Hey You! Get
Down!" are Single → Album. Norma Bates' six links moved from Linkfire `Fn3FsqPc` to
`OgJoIkMV`. Oberg and J.O.X "Jolene" lost their Spotify and Amazon links (FileMaker held a
Spotify *artist* URL in both fields, so the old links were wrong anyway). Three
`socialMedia` texts differ (Klara Andén, Norma Bates, Mika; the field is fetched and
translated but not rendered).

**Social links lost (84 values).** `url_twitter` 56 (44 Records artists including the
active Lost System, 12 Management rows), `url_tiktok_artist` 14, `url_facebook` 9,
`url_instagram` 5. Almost
all were not URLs: bare handles ("RabihJaber87"), `@@` TikTok addresses, a Facebook admin
URL, Instagram links followed by pasted notes (`hiddn` had login prompts in the field).
`StreamingRow` uses the value as `href` unchanged, so these rendered as broken relative
links before. Office's validation dropped them; Corroded's handle became a proper URL. Four
are editorial changes rather than clean-ups: `evelina_reuterfors` Instagram
`evelinasrecept` → `evelinacollinreuterfors`; `joyj` Instagram and TikTok reduced to one
account; `team_lost` and `the_swedish_family` multi-account values dropped entirely.

**Links and tags gained (194 values).** Streaming links from `client_card_fields` on
active Management clients (`url_spotify` 8, `url_applemusic` 5, `url_youtube_music` 6,
`url_amazon` 5; 12/5/5/4 more on former clients), on 8 of the 9 Nation talents (all four
fields), and the same on the Nation category portal rows; social
links for Corroded, Galia Mashchenko, Crashdïet and six management clients. `genre` and
`tags` filled on Management and Nation records where FileMaker had none (tag chips and the
"related" strips now use them). `internalAandR` filled on 137 Management/Nation records:
the Management detail page falls back to it when `internalMgmntManager` is empty, which is
one active client (Karakou, now shows "Patrik Frisk"). `collectionId` on Nation: Karakou
(515284041993) and Sudretsällskapet (516748738825) now get a merch section on their Nation
pages; Joakim Lundell, Tim Liljegren, Mia Elfqvist hold "Upcoming" (no merch, as before).
`filterType` is now "Booking" on all 26 Nation records (FileMaker: empty); only the query
uses it.

**Text.** `artistPresentationString` for `velvet`: English → Swedish (Office native
biography wins once edited). `patrik_frisk` `titleDescription` ("Patrik Frisk - CEO" →
"Patrik Frisk – vd") and `DescriptionString` rewritten. 46 news bodies: `MessageString`
now carries the same text as `Message`, which restores quotation marks FileMaker's display
field had removed (declared, listed as intended above).

### 4. Image fields

No image the site reads was lost. On every matched record where FileMaker had a usable URL,
Office has one too (0 "FM only" across all used image fields).

| Field | Both | Office only | Neither |
|---|---|---|---|
| Active artists `artistPicture_small` | 29 | 1 (Mika, `[MBS]` error in FM) | 0 |
| Active artists `artistPicture_big` (list layout) | 0 | 30 (FileMaker never filled it on API_ARTIST; the homepage fetched the detail record for it) | 0 |
| All 390 artists `artistPicture_big/small` | 381 | 2 (Mika, Robbin & Jojje) | 7 (plus 9 `[MBS]` rows in FM, 7 of them Saved/test rows) |
| Release covers `coverPicture_webp` | 2,157 | 0 | 1 (Martin Fritzon "Feels So Real", `[MBS]` in FM) |
| Previous artists, clients, former clients, Nation roster, category rows | all | 0 | 0 |
| Former Nation talents `artistPicture_big/small` | 6 | 11 (all `[MBS]` rows in FM) | 0 |
| News `image_webp` | 85 | 0 | 0 |
| Team photos | 3 | 0 | 0 |
| Web post block images | 3 | 0 | 34 (same on both) |

`Green Web Category::Cover_Picture` is empty on all 2,158 Office rows by design; the site
reads `coverPicture_webp` in Office mode. Images were compared by state, not by bytes.

### 5. Web post blocks

6 sections, 37 blocks, all 37 matched by portal row `recordId`; subject, message, image,
date and YouTube links identical in every block. The homepage slot ids 3, 4, 55–60 are all
present. Rendered block order is the same. Promo, Guider and every `FAQ <tag>` category are
empty on both sides. Office adds `readMore` on the section record (unused by the site) and
drops `webPost::createdBy`, `idPost`, `Primärnyckel`, `modId` (unused).

### 6. Fields the site never reads

FileMaker returned 20 internal fields Office does not emit (`ID_Artist`, `record_id`,
`modId`, `Artist Presentation`, `clientPresentation`, `bookingPresentation`,
`Artist Presentation Picture`, `artistPresentationPicture`, `artistImageTemp`,
`url youtube(1)`, `Green Navigation::Menu`, `Green Web Category::Artist`, `::ID_Artist`,
`Primärnyckel`, `dateSort`, `Timestamp Created`, `idPost`, `webPost::createdBy`, and the
layout-specific presentation fields). Office fills the three division intros
(`readMore`, `readMoreClients`, `readMoreBooking`), `filterTypeCombine`, `letterSearch`
and both highlight flags on every layout; the site reads each only on its own layout. None
of this reaches a visitor. The full table is in the generated report under "Fields the site
never reads".

## Recommendations

1. **Pitch text (Office data).** Change the `spotifyPitch` precedence to public text first,
   Spotify pitch only as a fallback, or clear the pitch for the public projection. Until
   then 945 release cards show an internal pitch template.
2. **Spot-check three releases** with Patrik: Tommy Nilsson "Samma Människa" (type),
   Norma Bates "Hey You! Get Down!" (type and Linkfire id), Oberg/J.O.X "Jolene" (lost
   streaming links; the old ones were artist links).
3. **Confirm four social-link edits** (Evelina Reuterfors, Joy J, Team Lost, The Swedish
   Family). Everything else dropped was malformed.
4. **Annika Ljungberg** still needs a photo, biography and release enrolment (known).
5. **Team order**: `sortOrder` is compared as text; give the nine re-enabled members
   two-digit keys if they should follow Birk and Joacim.
6. Re-run `node scripts/office-parity-audit.mjs` before FileMaker is switched off if
   anything is corrected on the Office side; it takes about 30 seconds.

No website code change is needed for any finding.
