# To Codex: data-parity audit of the Office migration — 2026-11-01

Written for Codex, the agent that built the Office adapter and projection
(`docs/handoff-codex-report-2026-11-01.md`). From Mikael, after auditing production.

## What was done

Every find the website issues (the bodies in `src/lib/ninetone.ts`, 56 queries including
the per-category `getWebPosts` calls and a per-slug `API_ARTIST_DETAIL` find for each
active artist) was run against FileMaker and against Office, live and uncached, and
diffed record by record and field by field. Script: `scripts/office-parity-audit.mjs`
(read-only, ~30 s). Findings: `docs/office-parity-audit-2026-11-01.md`. Every differing
value: `docs/audit-evidence/office-parity-2026-11-01/report.md`.

Your declared normalisations all check out: line endings, MM/DD/YYYY dates, re-addressed
images, `letterSearch`, dropped `Cover_Picture`, re-minted ids, `url_youtube_link` from
`url youtube(1)`, `MessageString` = body. Slugs unchanged, all 37 web post blocks identical
with their ids, homepage slot ids 3/4/55–60 present, no image lost, status changes exactly
as decided (F.A.P., Annika, Margaux, the 20 `[MBS]` rows). Good work.

## Issues to act on, all on the Office side

1. **`Green Web Album::spotifyPitch` precedence (visible regression).** On 945 of 2,158
   releases (161 on active artists) the website now shows the Spotify pitch message, 935
   of them starting "Vi har precis släppt en singel med (Artist – Title) som vi hoppas…".
   `Discography.astro` renders this field under every release, so an internal pitch
   template is public on www.ninetone.com. The mapping order "release-links
   `spotify_pitch_sv`, then `release_details.pitch_message_sv`, then PF" is the cause.
   Requested change: PF (the imported public text) first; native pitch only when PF is
   empty, or never. No website change is needed.
2. **Release dates and types.** 42 `Releasedate First` values differ. 30 replace FileMaker
   placeholder dates (04/14/2008 ×9, 01/25/2012 ×17, 06/30/2022 ×4) and three fill empty
   dates: fine. Please confirm with Patrik the rest are correct: Yohio "Together We Stand
   Alone" (11/10/2014 → 03/19/2014), Toftgård "Tell U What To Do", Robbin & JP "Kul Å
   Vara Full", Norma Bates "Hey You! Get Down!" (also Single → Album and all six links
   moved from Linkfire `Fn3FsqPc` to `OgJoIkMV`), Rasmus Sandström "Härifrån", La Bomba
   "Bunker Café" and "All The Lights", Oberg/J.O.X "Jolene" (10/30 → 11/06/2026, and both
   lost their `urlSpotify`/`urlAmazonMusic`; FileMaker held a Spotify *artist* URL there),
   Tommy Nilsson "Samma Människa" (Single → Album).
3. **Social links.** 84 FileMaker values were dropped by your validation. Almost all were
   malformed (bare handles, `@@` TikTok URLs, pasted notes in URL fields) and rendered as
   broken links before, so this is a repair. Four are editorial changes Patrik should
   confirm: `evelina_reuterfors` Instagram `evelinasrecept` → `evelinacollinreuterfors`;
   `joyj` Instagram and TikTok reduced to one account; `team_lost` and
   `the_swedish_family` multi-account values dropped entirely.
4. **Team sort.** `sortOrder` is compared as text by the site (documented in the handover).
   The nine re-enabled members carry `1216`–`1224`, which sorts before Birk's and Joacim's
   `20`. If they should follow, give them two-digit keys.
5. **`getNews` tie-break.** Posts with the same `Date` come back in a different order than
   FileMaker (which used creation time). Visible on /news and in the RSS feed for same-day
   posts. If Office can sort ties by creation time, the old order returns.
6. **Collation.** `getPreviousArtists` sorts "André Andersson" by code point (after
   "Andrea Lundquist"). FileMaker used locale collation. Minor.

## Things that differ but need nothing

- Office fills `readMore`/`readMoreClients`/`readMoreBooking`, `filterTypeCombine`,
  `letterSearch` and both highlight flags on every layout; the site reads each only on its
  own layout. FileMaker's internal fields (`ID_Artist`, `modId`, `record_id`,
  `Artist Presentation`, `clientPresentation`, `artistPresentationPicture`, …) are not
  emitted; nothing reads them.
- `getWebPosts("Ninetone Group")` returns one record from Office and two from FileMaker
  (its `=` is a word-prefix match that also hits "Ninetone Group Team"). The site selects
  the exact category.
- Three Nation categories with zero active talents and five Not Active portal rows are
  not emitted. The site already hid them.
- Release `Type` "EP" → "Ep" (site lowercases), `webPost::sortOrder` timestamp spelling
  (NaN for the site either way), two album names in a different Unicode form.
- Gains: streaming links on 8 active Management clients and 8 of 9 Nation talents,
  YouTube channel for 24 active artists, genre/tag chips on Management and Nation, big
  pictures on the API_ARTIST list layout, merch collections for Karakou and
  Sudretsällskapet on Nation pages.

## How to re-check

```sh
node scripts/office-parity-audit.mjs
```

Needs the FileMaker and Office credentials in `.env`. Re-run after any Office-side fix and
before FileMaker is switched off; compare `docs/audit-evidence/office-parity-<date>/report.md`
with the 2026-11-01 one. Do not change website code for any of the items above.
