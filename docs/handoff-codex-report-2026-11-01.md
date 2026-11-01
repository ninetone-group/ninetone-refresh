# Office website migration — 2026-11-01

## 1. New database, hosting, authentication and adapter

Ninetone Office is the authoritative content source: PostgreSQL17 on Google Cloud SQL,
served by the existing Office Cloud Run application at https://office.ninetone.com.
The website makes bounded HTTPS GET requests to
`/api/integrations/website/v1/layouts/{layout}` and `/images/{kind}/{id}/{hash}/{size}.webp`.
A server-only random bearer credential is verified against a SHA256 digest in Office.
There is no browser credential, CORS access, write endpoint, SQL access from Cloudflare,
or automatic fallback to FileMaker. Anonymous requests return401; browser Origin403.

Website transport: `src/lib/office.ts`, selected inside the existing `fmFind` /
`fmFindWithPortals` transport. Office projection: `backend/website_api.py` in the canonical
Office repository. Image generation: `backend/website_images.py`; additive schema283.
Office224 (`ninetone-office-preview-00224-qd6`) is Ready100%, immutable image
`sha256:c220839fe91c742224d00bf3e6d68a1ad71059c74ef5693688a25231cba9c44d`.
It is exactly three backend paths over Office223, retaining the separately approved
profile crop module and Office's own configuration, mail, storage, rights and capacity.
Beta585 remained unchanged during this production promotion.

The website deployment and post-deployment results are recorded at the end of this report.

## 2. Complete layout/field mapping

The public shape is unchanged. `website_profiles.public_fields` (PF below) contains an
allowlisted one-time copy of the existing public fields, keyed by stable scope + slug
and exact native UUID. This is Office-owned migration data, not a runtime FileMaker
connection. Native fields override where described. Unsupported/private source fields
never pass through. No business records are matched by name alone.

### API_ARTIST and API_ARTIST_DETAIL

| Output fields (each retained verbatim) | Office mapping |
|---|---|
| `SLUG` | `website_profiles.slug`; existing values unchanged |
| `Head Artist` | `artists.name` |
| `Artist Presentation Title` | PF; `artists.presentation_title` overrides after a change from its imported value |
| `artistPresentationString` | PF; changed `artists.biography_sv` overrides |
| `artistPresentationShort` | PF; changed `artists.presentation_text` overrides |
| `artistPicture_big`, `artistPicture_small` | Current `artist_profiles.image_id` / `artist_profile_images.sha256`, prepared large/small rendition; exact-owner imported asset fallback |
| `genre`, `internalAandR`, `Green_internalAandR::userEmail` | PF, with allowlisted import-event values for missing supported fields; email retained from PF |
| `yotubeHighlight_one`, `yotubeHighlight_two` | PF/import event; `client_card_fields.youtube_highlight_one/two` overrides when present |
| `collectionId` | PF/import event; existing numeric or nonnumeric string retained |
| `url_spotify`, `url_applemusic`, `url_amazon`, `url_youtube_music` | PF/import event; explicit `client_card_fields.dsp_spotify_url/dsp_apple_music_url/dsp_amazon_music_url/dsp_youtube_music_url` overrides |
| `url_youtube_link` | PF, import event `url youtube`; native `client_card_fields.youtube_channels[0].channel_id` when the channel list has been explicitly set |
| `url_instagram`, `url_tiktok_artist`, `url_twitter`, `url_facebook` | PF until native `artists.instagram_url/tiktok_url/twitter_url/facebook_url` differs from import; then native value, including an explicit clear |
| `url_spotify_artist` | PF/import event, unchanged embed URL |
| `readMore` | `web_sections.read_more` for records |
| `highLight_music` | PF/import event, unchanged string |
| `filterActive` | Native `artists.dashboard_activity`, canonicalized; PF/status fallback only if native is empty |
| `filterType` | `Music` for Records registry scope |
| `filterTypeCombine` | Original PF value; division default only if missing |
| `letterSearch` | Compatibility wildcard marker `**` |
| `__recordId`, top-level `recordId` | Original source record id retained in PF; registry identity fallback for new profiles |

The same mapping serves active, previous and single-artist lookups, as well as the
nightly all-artist release-count query. Saved records remain Saved; they are not
silently made active or previous. Original creation ids preserve newest-artist sorting.

Portal `Green Web Category`:

| Output key | Office mapping |
|---|---|
| `Green Web Category::Album` | Explicit `website_release_publications` membership → `release_details.album`; PF fallback for absent native detail |
| `Green Web Category::Type` | `release_details.release_format`, then publication PF |
| `Green Web Category::Releasedate First` | `original_release_date`, then `release_date`, then publication PF; normalized MM/DD/YYYY |
| `Green Web Category::urlRelease` | `release_links_content.fields.feature_fm`, then `release_details.linkfire_url`, then PF |
| `Green Web Category::urlSpotify`, `::urlAmazonMusic` | Native release-links `spotify` / `amazon` when present, otherwise PF |
| `Green Web Category::urlAppleMusic`, `::urlYoutubeMusic`, `::urlTidal` | Publication PF |
| `Green Web Category::coverPicture_webp` | Current `release_covers` prepared cover300; exact-owner imported fallback |
| `Green Web Category::Cover_Picture` | No legacy fallback URL emitted; valid prepared `coverPicture_webp` is authoritative |
| `Green Web Album::spotifyPitch` | Native release-links `spotify_pitch_sv`, then `release_details.pitch_message_sv`, then PF |
| `Green Web Album::socialMedia` | Native release-links `some_sv` when present, otherwise PF |
| portal `recordId` | Stable native context UUID; original release identities reconciled by source portal ROWID → ID_RELEASEPLAN → `work_contexts.legacy_category_id` |

Album names and membership remain explicit. One source portal row with an empty Album
is omitted, matching the existing getter and release-count behavior. Cross-artist
public release membership is retained without reparenting native business releases.

### API_Management and API_Booking

The common name, slug, images, YouTube, collection and every `url_*` field use the
artist mapping above, scoped to Management or Nation respectively.

| Layout / output fields | Office mapping |
|---|---|
| Management `clientPresentationTitle`, `clientPresentationString`, `clientPresentationShort` | Division-specific PF/import values until the corresponding shared native presentation title/biography/text is edited |
| Management `tags`, fallback `genre` | PF/import values, unchanged line/comma semantics |
| Management `internalMgmntManager`, fallback `internalAandR` | PF/import values |
| Management `Green_internalMgmntManagers::userEmail`, fallback `Green_internalAandR::userEmail` | Original public contact PF |
| Management `readMoreClients` | `web_sections.read_more` for management |
| Management `highLight_client` | PF/import value, unchanged string |
| Management `filterTypeCombine` | Original PF, preserving membership search semantics |
| Booking `bookingPresentationTitle`, `bookingPresentationString`, `bookingPresentationShort` | Nation PF/import values, with the same explicit native-presentation override rule |
| Booking `tagBooking`, fallback `tags`, fallback `genre` | PF; exact imported category membership supplies tags where the layout omitted them |
| Booking `filterActive` | Native activity as above; only Active passes active queries |
| Booking `filterType`, `filterTypeCombine` | Booking scope / retained original combined value |
| Booking `readMoreBooking` | `web_sections.read_more` for nation |

### API_BOOKING_TAG

| Output field / portal key | Office mapping |
|---|---|
| `tagBooking`, `breadBooking` | `website_booking_categories.tag`, `.description` |
| `Green HeadArtist::SLUG`, `::Head Artist`, `::artistPicture_big`, `::artistPicture_small` | Nation profiles using the mapping above, prefixed exactly `Green HeadArtist::` |
| `::bookingPresentationShort`, `::clientPresentationShort`, `::artistPresentationShort` | Same division fields; consuming fallback order unchanged |
| `::bookingPresentationTitle`, `::clientPresentationTitle`, `::Artist Presentation Title` | Same division fields; consuming fallback order unchanged |
| `::highLight_client`, `::filterActive` | Same highlight/native activity fields |
| `::url_spotify`, `::url_applemusic`, `::url_amazon`, `::url_youtube_music`, `::url_youtube_link`, `::url_instagram`, `::url_tiktok_artist`, `::url_twitter`, `::url_facebook`, `::url_spotify_artist` | Each common artist URL above, with the portal prefix |
| Portal order | Original per-category row position stored as PF `_category_order`; category order in `sort_order` |

All six original categories retained: Artist, Föreläsare, Konferencier, Moderator,
Underhållare, Influencer. Existing consumer code still hides empty active categories.

### API_NEWS

| Output field | Office mapping |
|---|---|
| `slug`, `Title`, `shortMessage` | `web_entries.fields.slug/title/summary`, section news, unarchived |
| `MessageString`, `Message` | `fields.body` for both |
| `Date` | `fields.publish_date` → MM/DD/YYYY |
| `image_webp` | `fields.webp_id` or `image_id` → `web_assets` → prepared large rendition |
| `category` | Empty; the imported NEWS editor has no category field |
| `Created By` | `fields.author` |
| `ytLinkA`, `ytLinkB`, `ytLinkC`, `ytLinkD` | `fields.youtube` positions0–3 |
| `recordId` | Preserved `source_record_id`, native UUID for new entries |

### API_WEBPOSTS

| Output field / portal key | Office mapping |
|---|---|
| `category`, `title`, `readMore` | `web_sections.key` mapped to original category label, `.title`, `.read_more` |
| `webPost::subject`, `webPost::message` | Unarchived section `web_entries.fields.title/body` |
| `webPost::image_webp`, `webPost::date` | Referenced prepared asset / normalized `publish_date` |
| `webPost::sortOrder` | `fields.sort_order`; original numeric source-id ordering retained |
| `webPost::ytLinkA` … `webPost::ytLinkD` | `fields.youtube` positions0–3 |
| portal `recordId` | `web_entries.source_record_id`, falling back to native UUID |

Section keys group/records/management/nation/team/blog map to Ninetone Group /
Ninetone Records / Ninetone Management / Ninetone Nation / Ninetone Group Team /
Ninetone Blog. Fresh source reads contained no Promo, Guider or FAQ category;
these remain empty and existing fallback behavior applies. Homepage row ids
3,4,55,56,57,58,59,60 are retained; no homepage binding edit was needed.

### API_USERS

| Output fields | Office mapping |
|---|---|
| `SLUG` | Team publication registry slug |
| `userNameCalc` | `app_users.display_name` |
| `title`, `titleDescription`, `DescriptionString` | Public PF, overridden by nonempty `user_profiles.fields.public_title/public_heading/public_presentation` |
| fallback `Description` | Original public PF |
| `userPhoto`, `userPhotoSmall` | Retained employee original mapping matching the current avatar generation, then prepared large/small rendition; imported fallback when no current photo |
| `userEmail` | Explicit public PF; never inferred from private login email |
| `Phone` | Public PF, overridden by nonempty profile phone |
| `sortOrder` | Original public string, registry identity fallback |
| `Active` | `Ja` only for explicitly enabled team website registry entries |

### Value normalization

- Active/Not Active/Saved canonicalized from native activity; unknown/External values
  retained, preventing an External profile from becoming a previous client.
- Team visibility means **approved for the website**, not employed or allowed to log in.
  Exactly the three previously public people remain selected.
- Highlights retain the original string `true`; no new highlight inference.
- Native dates, ISO dates and original MM/DD/YYYY become MM/DD/YYYY; invalid/empty stays
  empty. Newline normalization is CRLF/CR → LF; markdown is retained.
- Multi-value tags, placeholder bios, collection strings and video/embed links remain
  unchanged; existing consuming helpers perform their existing validation.
- Image fields are stable content-hash WebP URLs under `/api/office-images/`;
  no FileMaker session URLs. Static Pages rewrites only image fields to the production
  www origin. Block identities and all existing route slugs remain unchanged.

## 3. Decisions and assumptions

1. Office's current native activity wins over the old public snapshot. Patrik confirmed
   Margaux Dietz is active again and Annika Ljungberg is a new Records artist.
   Annika maps to native UUID `1311eb9d-769b-466b-adf8-9c51ab59e4eb`, new slug
   `annika_ljungberg`. She has no registered photo/bio; neither was invented.
   F.A.P. is currently Not Active in Office and consequently leaves the active list.
   Result:31 active Records,38 active Management,9 tagged active Nation,3 team,85 news.
2. Existing explicit public selection is migrated into separate allowlist tables.
   Private/demo profiles and unpublished releases are not inferred from dates or
   globally exposed. A new profile/release needs registry enrollment; no new editor
   for that enrollment was added. This is distinct from automatic WebP creation.
3. Preserve division-specific copy until Office edits its shared presentation;
   preserve snapshot-only contact/tag/platform fields where no native editor mapping
   exists. Some such fields require an explicit registry update rather than changing
   an unrelated private artist field. There is no ongoing FileMaker sync.
4. Twenty former Management profiles lacked a usable old image and are disabled in
   the new registry, preserving the old getter's exclusion. Registry total603,
   release memberships2191, six categories. Saved/External records retained correctly.
5. Existing source creation ids retained for ordering; new Annika assigned a later
   compatibility id. Team authorization remains separate from employment/login.
6. Same-origin Cloudflare image cache selected instead of publishing private buckets.
   Existing suitable WebP bytes retained; all expensive conversion happens on save/import.

## 4. Changes outside the adapter

- `src/lib/filemaker.ts`: provider dispatch and source+origin cache namespaces. Required
  to keep the existing getters while preventing old/Beta KV content from crossing sources.
- `src/lib/ninetone.ts`: release covers use the projected URL in Office mode; the old
  unconditional FileMaker proxy URL would otherwise keep a live FileMaker dependency.
- `src/pages/api/office-images/[...path].ts`: bounded same-origin image endpoint,
  successful immutable edge caching, GET/HEAD/ETag handling. No arbitrary upstream URL.
- `astro.config.mjs`: a static-preview boolean without environment-object expansion;
  development-only dependency-discovery workaround for Astro7 raw-frontmatter scanning.
- `package.json`: blank Office token during CF build; existing secrets gate retained.
- `wrangler.jsonc`: CONTENT_SOURCE and OFFICE_API_ORIGIN only. Bindings, crons, DO,
  Publish epoch, shadow-publication settings and translation configuration unchanged.
- `.github/workflows/deploy.yml`: static preview reads Office with server secret,
  retaining unrelated Shopify/YouTube settings. `.env.example`: new local settings.
- `test/office.test.mjs`:11 transport/security/cache/static-preview tests.
- `VERSION`, `CHANGELOG.md`, this report: required release/audit bookkeeping.

No consuming page/component/feed/sitemap or image markup was edited. `cache.ts`,
`fm-kv.ts`, the Publish mechanism, translation subsystem and cron implementations
are unchanged. Existing FM proxy/credentials are retained for deliberate rollback.

Office changes were a separately qualified narrow runtime, not deployment of its dirty
root. Schema/import/generation implementation and save hooks are documented in
Office `docs/HANDOFF-website-images-20261101.md`; final API correction is exactly
website_api.py + the two WSGI opt-in factories over Office223.

## 5. Verification performed

Node22.19.0 (official installed toolchain; nvm is not installed):

- `npm test`:872 passed,0 failed,0 skipped.
- `npm run build:cf`:passed; secrets gate checked113 files, no local secret baked.
  An earlier build was correctly blocked because optional import.meta.env expansion
  copied the local Office token into the server bundle. Replaced with a dedicated
  build boolean, rebuilt successfully; the failed build was never uploaded/deployed.
- `DEPLOY_TARGET=cf NODE_ENV=development npm run dev -- --force --port4333 --host127.0.0.1`:
  rendered against Beta, then restarted against production Office.
- HTTP200: homepage, /records/artists, /records/artists/mika, /management/clients,
  /management/clients/joakim_lundell, /ninetone-nation/booking,
  /ninetone-nation/joakim_lundell, /team, /team/patrik_frisk, /news,
  /news/ninetone_tecknar_avtal_med_jamtkraft_for_avdelning_, /news.xml,
  /sitemap-pages.xml, /en/records/artists/mika. Annika detail also200.
-151 unique image URLs across those production-backed local pages:all200 image/webp;
  no FileMaker image references. Beta run:153 unique images,all200.
- Browser: Mika hero visibly rendered and decoded1000px from the Office image endpoint.
- `/sitemap-sv.xml` returns404 in both existing production and new runtime. This is a
  handover/code discrepancy; the actual endpoint is `/sitemap-pages.xml`. No invented
  alias or sitemap consumer edit.

Office qualification commands use `private-data/web-admin-20261031/venv/bin/python`:

- Final frozen `build_local.py`, `qualify_runtime.py`:Linux/amd64 build, all Python
  compile/imports/WebP support;31 tests passed against exact frozen source.
- Final `qualify_startup.py`:complete isolated Office production staging/config
  startup with synthetic secrets, network disabled; existing mail configuration retained.
- `registry_data_v4.py production`, then `... --commit`:rollback rehearsal, one commit,
 603 profiles/2191 memberships/6 categories; native artists, releases, users, memberships,
 WEB entries/sections fingerprints unchanged; temporary owner revoked.
- `prewarm_native_v2.py production`, then `... --commit`:20 current native originals
 read by exact key/generation/hash, prepared derivatives only; zero original writes.
- One-time image import independently qualified3186 exact-owner source images and
23600 derivative rows; every stored payload hash read back. Existing image handoff
 records the detailed source export/import and10 protected financial-table checks.
- Final `publish.py`, `verify.py`:Office224 Ready100, exact image/live assets, original
 settings/capacity retained, anonymous API401; subsequent authenticated HTTPS reads
 verified the production counts and Annika/Margaux membership; browser Origin403.

Private scripts/receipts are under Office `private-data/website-cutover-20261101` and
`private-data/website-cutover-final-20261101`. Consumed write/deploy dispatches must
never be replayed. No raw data, tokens, image bytes or runtime configs are committed.

## 6. Not done / verification limits

No FileMaker business/schema change, ongoing sync, live upload test, email/form send,
financial operation, new publication-registry UI or new invented Annika biography/photo.
Upload/save/retry conversion behavior was tested in disposable PostgreSQL; live images
were read without saving business test data. No broad mobile/Lighthouse benchmark.
Local HTTP timing is not a production performance guarantee.

Two temporary UNDEPLOYED Cloudflare versions were used while investigating source
read access; Version URLs do not support this Worker's Durable Object. No production
traffic changed. Temporary preview settings were restored, temporary source route
removed, and a protected remote-development read-only export was stopped afterward.
FileMaker credentials stayed opaque inside Cloudflare. No credential value was logged.

## 7. Configuration, secrets and pre-deploy requirements

Already applied:independent Office schema283/image import/registry/prewarming,
image-generation flag1, API-enabled flag1, server-token SHA256 digest, Office224 runtime.
Production website vars:CONTENT_SOURCE=office;
OFFICE_API_ORIGIN=https://office.ninetone.com. GitHub repository secret OFFICE_API_TOKEN
was set for the static preview. Unrelated secrets/settings retained.

For a future manual rotation, securely supply the matching new token/digest to Office,
then the website secret (never place the value in the command/report):

```sh
npx wrangler secret put OFFICE_API_TOKEN
# GitHub Pages, if rotating the shared build credential:
gh secret set OFFICE_API_TOKEN
```

For this cutover, the single deployment command used was
`npm run deploy:cf -- --secrets-file /private/path/office-secrets.env`, which atomically
adds the new secret with the freshly built version; omitted secrets are retained.
The actual private file is mode600 outside the repository. Never deploy bare wrangler
or separate the build and deploy. No DNS/mail/capacity change is required.

## 8. Ranked risks / first post-deployment check

1. **First check:**fresh and warm Mika/news pages plus profile/release/news images on
 www.ninetone.com; confirm valid WebP, cache hits, no FileMaker image requests,
 Annika in Records and Margaux in Management. Roll back if route/image failures occur.
2. New profile/release public enrollment is explicit and currently operational, not
 automatic. Image rendition creation itself is automatic for profile/presentation,
 release, WEB/news/blog and employee saves. Keep selection separate from private data.
3. Snapshot-only public contact/tag/platform values and shared-presentation override
 rules need deliberate editorial maintenance; do not assume every private Office field
 is a website control. Annika still needs real approved photo and biography.
4. A cold Cloudflare image cache must fetch a stored rendition from Office; warm cache
 is immutable for a year. Large original WebP may remain the original size; smaller
 variants improve card payloads. No conversion is performed on visitor requests.
5. Office activity differences intentionally affect roster. Existing saved/External
 records and20 image-ineligible former clients require preservation when editing selection.
6. Keep additive data if rolling back code. Office rollback target223 retains the new
 registry/cache; the previous website deployment is preserved in the private pre-cutover
 receipt. A deliberate FileMaker-source redeploy is available, not an automatic fallback.


## 9. Public cutover results

Published with the one combined `npm run deploy:cf -- --secrets-file ...` command,
build and secrets gate successful. Cloudflare version
`bbaf7457-474c-489b-b2ac-d7248ba89bcc`, custom domains www.ninetone.com/ninetone.com,
workers.dev staging, all three existing crons and queue producer/consumer retained.
The new credential was independently verified as a **secret_text** binding through
Cloudflare's version API. No secret is a plaintext var or part of the code bundle.

Public route verification:all16 intended HTML/feed/sitemap routes200, including the
additional Annika and Margaux details; existing /sitemap-sv.xml404 unchanged.152 unique
public image URLs:all200 image/webp, no FileMaker image references. Apex301 to www;
sitemap-index.xml200; Margaux's old previous URL301 to her active URL. Annika and
Margaux are present in the actual public roster HTML. Browser screenshot shows the
live Mika hero and presentation; private proof site-live-mika.jpg.

Three HTTPS timing samples per route before/after (median TTFB, milliseconds):

| Route | Old source, existing warm deployment | Office, warm deployment |
|---|---:|---:|
| / | 239.4 | 106.7 |
| /records/artists | 197.3 | 84.6 |
| /records/artists/mika | 101.2 | 90.6 |
| /news | 128.4 | 94.4 |
| /news/{article} | 98.6 | 107.5 |
| /management/clients | 95.7 | 196.4 |

These small network samples are not a controlled Lighthouse/mobile comparison or a
promise that every route is faster. Management was more variable in this sample.
The first fresh deployment sweep includes cold caches and is recorded separately;
new image URLs necessarily start with an edge-cache miss. The representative news
article's old/new large WebP bytes are identical (13,422 bytes); new image response
retains one-year immutable caching. A proposed Mika byte comparison was excluded:
the old page had no usable hero and its first proxied image was a different news
picture; Office supplies a genuine current profile photo. Comparing those payloads
would be misleading.

Private public verification:live/route-render-results.json, live/route-image-results.json,
production-performance-before.json, production-performance-after.json,
site-deployments-after.json. Existing publication epoch was not bumped; the new build
id provides a fresh HTML generation and the Office cache namespace isolates old data.

Management follow-up:7 requests, all200, median TTFB103.1ms (initial
three-sample result was variable). First new-deployment homepage request2082ms;
first public image sweep median240.5ms, max1573.1ms. Those include fresh edge-cache
misses. The representative news image subsequently reports cf-cache-status:HIT,
Age56 and public,max-age=31536000,immutable. This separates warm behavior from
cold-start behavior instead of claiming every first request is equally fast.

The exact nightly all-artist portal query also returned schema1 successfully:
391 artists, 2191 release rows, 5579ms, inside the15s transport deadline.
