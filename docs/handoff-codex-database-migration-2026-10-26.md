# Handover to Codex — moving www.ninetone.com off the FileMaker Data API (2026-10-26)

Written for Patrik and for Codex, the agent that will do the remapping. Everything
below is read from the code as of commit `b759188` (v0.3.3.1, the version running on
www.ninetone.com). Paths are relative to the repo root.

The short version: **the site does not need its fields remapped in 38 files. It needs a
new adapter under one file.** Section 2 explains why, section 3 is the plan, sections
4 to 6 are the complete field map the new data source has to satisfy.

---

## 1. Where everything is

| What | Where | Access |
|---|---|---|
| Source code | GitHub `ninetone-group/ninetone-refresh`, branch `main` | `patrikfrisk-ninetone` is admin of the org and the repo |
| Production site | Cloudflare Worker `ninetone-site` on Ninetone's Cloudflare account, custom domain www.ninetone.com (apex 301s to www) | Ninetone's Cloudflare login |
| Image proxy | Cloudflare Worker `ninetone-fm-image-proxy`, source in `worker-fm-proxy/` | same account |
| Static preview | GitHub Pages, built by `.github/workflows/deploy.yml` on every push to `main` | public |
| Deploy command | `npm run deploy:cf` from a checkout (build + `wrangler deploy` in one command, never split) | needs `wrangler login` on Ninetone's account |
| Secrets | Cloudflare Worker secrets on `ninetone-site` (production) and a local `.env` (dev, not in git) | see section 8 |

`main` and the deployed Worker match (v0.3.3.1, 2026-10-15). There is no unpushed work.
Node 22 is required (`nvm use 22`). `npm test` runs the suite under plain Node.

Read `CLAUDE.md` first. It is short and every rule in it exists because something broke.

## 2. How the site talks to FileMaker today

One module owns the connection: `src/lib/filemaker.ts`. Every page, feed, sitemap and
cron reads through typed getters in `src/lib/ninetone.ts` (`getArtists`, `getClients`,
`getTeam`, `getNews`, `getWebPosts`, ...). Those getters call `fmFind(layout, body)` and
get back plain records. The 38 files that mention FileMaker field names consume *those
records*; none of them talk to FileMaker.

What `filemaker.ts` does, and what a replacement has to do:

1. **Auth.** `POST https://{FM_HOST}/fmi/data/vLatest/databases/{FM_DB}/sessions` with
   Basic auth, token cached 12 minutes, one in-flight login shared across concurrent
   requests, a 401 on a find triggers one re-login and retry.
2. **Find.** `POST .../layouts/{layout}/_find` with the body shape in `FmFindBody`
   (`query` as an array of field→criteria objects with FileMaker operators `==`, `*`,
   `==**`, `==***`; `sort`; `limit`; `offset`; `portal`; per-portal limits sent as
   `limit.<portalName>`). 30 s timeout.
3. **Response.** Unwrap `response.data[].fieldData` into flat records, attach the
   FileMaker `recordId` as `__recordId`. A reply with message code `401` means "no
   records" and becomes an empty list, not an error. If `foundCount > returnedCount`
   the call throws (the site never pages, it raises `limit`).
4. **Portals.** `fmFindWithPortals` keeps `portalData`; rows carry keys like
   `Green Web Category::Album` and a top-level `recordId` per row.
5. **Image URLs.** Every field value that looks like a FileMaker streaming URL is
   rewritten to the image proxy before the record leaves the adapter
   (`src/lib/fm-image-mirror.ts`, see section 7).
6. **Caching around it.** In-memory per isolate (`src/lib/cache.ts`), then a KV
   read-through keyed by layout + body + the Publish epoch (`src/lib/fm-kv.ts`). Both
   are transparent to the getters and can stay as they are.

## 3. Recommended plan

Keep the record shapes the site already consumes. Replace what produces them.

1. **Write a new adapter** that exposes the same two functions, `fmFind` and
   `fmFindWithPortals`, with the same signatures, returning the same flat records and
   the same portal row keys (section 4). Where the new database has a different query
   language, translate the handful of `query`/`sort` bodies listed per layout in
   section 4. There are about fifteen distinct queries in the whole site.
2. **Keep the layout and field names** in the records the adapter returns, even if the
   new database uses other column names. Map inside the adapter. That is one mapping
   table in one file instead of 38 edits, and every test keeps passing.
3. **Keep the value formats** in section 5. Several are load-bearing: `"Active"` /
   `"Not Active"`, `"Ja"` for team, dates as `MM/DD/YYYY`, `"true"` for highlights.
   If the new database stores these differently, normalise in the adapter.
4. **Replace the image pipeline** (section 7). This is the one part that cannot be
   mapped; it has to be rebuilt around wherever the new images live.
5. **Decide the homepage block identity** (section 6). The homepage copy is bound to
   FileMaker portal row ids; the new source needs a stable id per block.
6. Run `npm test`, then `npm run build:cf`. The build fails if a secret is baked into
   the bundle. Deploy with `npm run deploy:cf`.

Do not: bypass the adapter from a page, read secrets via `import.meta.env`, or add a
new per-string translation read (see `CLAUDE.md`, "FM data + image proxy invariants").

## 4. Field map per layout

Record identity is `SLUG` everywhere except news, which uses lowercase `slug`. Slugs are
used as-is in URLs, so they must be unique and URL-safe.

### API_ARTIST — active Records roster (`getArtists`)

Query: `filterActive == "Active"`, `filterType = "Music"`, `SLUG = "*"`,
`letterSearch == "**"`, `"Head Artist" = "*"`. Sort: `highLight_music` desc, then
`Head Artist` asc. Limit 500.

| Field | Used for |
|---|---|
| `SLUG` | route `/records/artists/{SLUG}`, image key |
| `Head Artist` | display name, never translated |
| `Artist Presentation Title` | tagline, meta description |
| `artistPresentationString` | bio (markdown) |
| `artistPresentationShort` | card blurb, homepage artist of the week, search |
| `artistPicture_big`, `artistPicture_small` | hero / card images (big is often empty on this layout, the homepage fetches the detail record for it) |
| `genre` | tag chips, filters, related artists (split on line breaks) |
| `internalAandR`, `Green_internalAandR::userEmail` | A&R contact name and email |
| `yotubeHighlight_one`, `yotubeHighlight_two` | YouTube embeds (FileMaker spelling, keep it) |
| `collectionId` | Shopify merch collection id |
| `url_spotify`, `url_applemusic`, `url_amazon`, `url_youtube_music`, `url_youtube_link`, `url_instagram`, `url_tiktok_artist`, `url_twitter`, `url_facebook` | streaming and social links |
| `url_spotify_artist` | Spotify artist embed |
| `readMore` | section intro (markdown), first row |
| `highLight_music` | highlight badge and sort key |

### API_ARTIST_DETAIL — single artist, previous artists, releases

Queries:
- `getArtistBySlug`: `filterActive == "*"`, `SLUG = slug`, limit 1.
- `getArtistDetailWithReleases`: same, plus portal `Green Web Category` (limit 500).
- `getArtistsWithReleases` (nightly 04:00 release-count cron): `filterType = "Music"`,
  `SLUG = "*"`, limit 1000, same portal.
- `getPreviousArtists`: `filterActive == "Not Active"`, `filterType = "Music"`,
  `SLUG = "*"`, `artistPresentationShort = "*"`, `"Head Artist" == "**"`, sort
  `Head Artist` asc, offset 1, limit 1000, no portals.

Fields: the same as API_ARTIST (`SLUG`, `Head Artist`, `Artist Presentation Title`,
`artistPresentationString`, `artistPresentationShort`, `artistPicture_big/small`,
`genre`, `collectionId`, the `url_*` set, `yotubeHighlight_one/two`).

Portal `Green Web Category`, one row per release:

| Portal key | Used for |
|---|---|
| `Green Web Category::Album` | release title **and release identity** (cover URL, dedupe in the release count). Rows with empty Album are dropped. |
| `Green Web Category::Type` | Single / EP / Album filter (prefix match, lowercased) |
| `Green Web Category::Releasedate First` | sort newest first, display date, JSON-LD |
| `Green Web Category::urlRelease` | main smart link |
| `Green Web Category::urlSpotify`, `::urlAppleMusic`, `::urlAmazonMusic`, `::urlYoutubeMusic`, `::urlTidal` | per-platform links |
| `Green Web Category::coverPicture_webp`, fallback `::Cover_Picture` | cover image (read by the proxy only) |
| `Green Web Album::spotifyPitch` | release pitch text |

### API_Management — clients (`getClients`, `getPreviousClients`)

Query: `filterActive == "Active"` (or `"Not Active"` for previous),
`filterTypeCombine = "Management"`, `SLUG = "*"`, `"Head Artist" = "*"`. Sort:
`highLight_client` desc, then `Head Artist` asc. Limit 500. Previous clients without a
usable picture are dropped after the fetch.

| Field | Used for |
|---|---|
| `SLUG` | routes `/management/clients/{SLUG}` and `/management/clients/previous/single/{SLUG}` |
| `Head Artist` | name |
| `clientPresentationTitle` | tagline |
| `clientPresentationString` | bio (markdown), list-card blurb |
| `clientPresentationShort`, fallback `artistPresentationShort` | homepage client of the week, search |
| `artistPicture_big`, `artistPicture_small` | images, also the "has a picture" filter |
| `tags`, fallback `genre` | tag chips (split on line breaks or commas) |
| `internalMgmntManager`, fallback `internalAandR` | manager name |
| `Green_internalMgmntManagers::userEmail`, fallback `Green_internalAandR::userEmail` | manager email |
| `yotubeHighlight_one`, `yotubeHighlight_two`, `collectionId`, the `url_*` set | as for artists |
| `readMoreClients` | section intro (markdown), first row |
| `highLight_client` | highlight badge and sort key |

### API_Booking — Ninetone Nation talents

Queries:
- `getBookingRoster`: `filterActive == "Active"`, `filterType = "Booking"`,
  `SLUG = "*"`, `filterTypeCombine == "***"`, `tagBooking = "*"`, limit 500, no sort.
- `getPreviousBooking`: `filterActive == "Not Active"`, `filterType = "Booking"`,
  `SLUG = "*"` (used only for the homepage "profiles since the start" count).
- per-slug lookup: `SLUG == slug`, `filterActive == "Active"`, limit 1.

| Field | Used for |
|---|---|
| `SLUG` | route `/ninetone-nation/{SLUG}` |
| `Head Artist` | name |
| `bookingPresentationTitle` | tagline |
| `bookingPresentationString` | bio (markdown) |
| `bookingPresentationShort` | search blurb |
| `artistPicture_big`, `artistPicture_small` | images |
| `tagBooking`, fallback `tags`, fallback `genre` | tags, related talents |
| `filterActive` | must equal exactly `"Active"` to be shown |
| `yotubeHighlight_one`, `yotubeHighlight_two`, `collectionId`, the `url_*` set | as for artists |

### API_BOOKING_TAG — Nation categories (`getBookingCategories`)

Query: `tagBooking = "*"`, limit 100, portal `Green HeadArtist` (limit 500).

| Field | Used for |
|---|---|
| `tagBooking` | category name; also the category page slug and a do-not-translate word. Known values: Artist, Föreläsare, Konferencier, Moderator, Underhållare, Influencer |
| `breadBooking` | category description |

Portal `Green HeadArtist`, one row per talent in the category: `::SLUG` (decides which
talent pages exist), `::Head Artist`, `::artistPicture_big`, `::artistPicture_small`,
`::bookingPresentationShort` → `::clientPresentationShort` → `::artistPresentationShort`
(first non-empty), `::bookingPresentationTitle` → `::clientPresentationTitle` →
`::Artist Presentation Title`, `::highLight_client`, `::filterActive` (only `"Active"`
rows shown), and the `::url_*` set.

### API_NEWS — news articles (`getNews`)

Query: `Message = "*"`, sort `Date` desc, limit 500.

| Field | Used for |
|---|---|
| `slug` (lowercase) | route `/news/{slug}`, RSS, sitemap, admin |
| `Title` | headline |
| `shortMessage` | excerpt (cleaned to one line at fetch time) |
| `MessageString`, fallback `Message` | body (markdown); `Message` is also used to find articles mentioning an artist by name |
| `Date` | display date, sort, RSS pubDate, sitemap lastmod |
| `image_webp` | cover image |
| `category` | category label |
| `Created By` | byline |
| `ytLinkA` … `ytLinkD` | YouTube embeds |

### API_WEBPOSTS — editorial sections, homepage copy, promo, guides (`getWebPosts`)

Query: `category = <name>`, limit 100, portal `webPost` (limit 500). Categories the
site asks for: `Ninetone Group` (homepage), `Ninetone Records`, `Ninetone Management`,
`Ninetone Nation`, `Ninetone Group Team`, `Promo`, `Guider`, `FAQ {tag}`.

| Field | Used for |
|---|---|
| `category` | section key |
| `title` | section title or tagline (a trailing ` \| Ninetone…` is stripped) |
| portal `webPost::subject` | block heading; guide title (slugified); FAQ question; promo label; homepage division-card key (`records` / `management` / `nation`) |
| portal `webPost::message` | block body (markdown); FAQ answer; promo text; homepage slot copy |
| portal `webPost::image_webp`, `webPost::date` | guide image and date |
| portal `webPost::sortOrder` | intended order (in practice FileMaker holds a timestamp here, so the portal's own row order is what the site shows) |
| portal row `recordId` | **stable block identity**, see section 6 |

### API_USERS — team (`getTeam`)

Query: `Active == "Ja"`, `SLUG = "*"`, sort `sortOrder` asc, limit 500. The page then
puts the CEO first and people with photos before people without.

| Field | Used for |
|---|---|
| `SLUG` | route `/team/{SLUG}` |
| `userNameCalc` | name, never translated |
| `title` | job title |
| `titleDescription` | subtitle and meta description |
| `DescriptionString`, fallback `Description` | bio (markdown) |
| `userPhoto`, `userPhotoSmall` | photo |
| `userEmail`, `Phone` | contact links |
| `sortOrder` | order (string compare) |
| `Active` | `"Ja"` shows the person |

Note for Patrik: as of 2026-10-25 only three users have `Active = "Ja"` on
files.ninetone.com, so www.ninetone.com/team shows three people and the other team
pages (including Stefan Hallgren's, a top-ten page in Search Console) return 404. It
was fifteen on 2026-10-15. If the new database owns this flag, decide what it means
("works here" vs "shown on the website").

## 5. Value formats the code depends on

| Field(s) | Expected format |
|---|---|
| `filterActive` | exactly `"Active"` or `"Not Active"` |
| `filterType` | `"Music"` for Records, `"Booking"` for Nation |
| `filterTypeCombine` | contains `"Management"` for clients; non-empty for booking |
| `Active` (team) | `"Ja"` or `"Nej"` |
| `highLight_music`, `highLight_client` | the string `"true"` means highlighted; also sort keys |
| `Date`, `Releasedate First`, `webPost::date` | `MM/DD/YYYY`; anything else counts as no date |
| `genre`, `tags`, `tagBooking` | multi-value text, one per line (clients and booking also accept commas) |
| markdown fields | `artistPresentationString`, `clientPresentationString`, `bookingPresentationString`, `DescriptionString`, `MessageString`, `webPost::message`, `readMore`, `readMoreClients` |
| placeholder bios | a client text starting `-----Placeholder Text-----` counts as empty |
| image fields | currently FileMaker container streaming URLs; `[MBS] Invalid image reference` counts as no image |
| `collectionId` | numeric Shopify collection id; non-numeric (FileMaker holds `"Upcoming"` on some rows) means no merch |
| YouTube fields | any URL containing an 11-character video id |
| `url_youtube_link` | channel URL `…/channel/UC…` or a bare `UC…` id (`/@handle` is resolved through the YouTube API) |
| `url_spotify_artist` | must contain `embed/artist/<id>` |
| promo block | `subject` is the label; in `message`, the first non-URL line is the text and a line starting with `http` is the link |
| `Green Web Category::Album` | release identity, must be stable per artist |

## 6. Homepage copy is bound to portal row ids

`src/lib/homepage-copy.ts` reads the `Ninetone Group` web post and binds blocks to
homepage slots by the FileMaker portal row `recordId`:

| recordId | Homepage slot |
|---|---|
| 3 | hero |
| 4 | positioning |
| 55 | bridge |
| 56 | whatsOn |
| 57 | roster |
| 58 | news |
| 59 | about |
| 60 | merch |

The division cards are matched by `subject` instead (`records`, `management`, `nation`).
A new data source has to give each block a stable id; the adapter can expose it as
`recordId` on the portal row, or the table above changes to whatever the new ids are.
This is the one place where FileMaker internals leak into the site.

## 7. Images: the part that has to be rebuilt

Today, FileMaker container fields return `https://files.ninetone.com/Streaming_SSL/...`
URLs that expire with the session (about 15 minutes). So:

1. `src/lib/fm-image-mirror.ts` rewrites every such URL, in the fields
   `artistPicture_big`, `artistPicture_small`, `Artist Presentation Picture`,
   `image_webp`, `userPhoto`, `userPhotoSmall`, to
   `https://ninetone-fm-image-proxy.ninetone.workers.dev/{kind}/{slug}/{variant}?v={epoch}`.
2. The proxy Worker (`worker-fm-proxy/`) holds its own FileMaker session, looks the
   record up by slug on each request and streams the bytes, cached 6 hours at the edge.
   Routes: `/artist/{slug}/big|small`, `/client/{slug}/big`, `/booking/{slug}/big`,
   `/news/{slug}/cover`, `/team/{slug}/big|small`, `/release/{slug}/by-album/{album}`.

If the new database serves images from stable public URLs (a bucket, a CDN), both
pieces go away: the adapter returns the final URL in the same fields, the mirror
becomes a no-op, and the proxy Worker is retired. Keep the `.fm-img-frame` / `.fm-img`
markup and the `onload` handler on the `<img>` elements; the client router depends on
them (`CLAUDE.md`). Keep a cache buster in the URL if images can change without a
filename change.

## 8. Secrets and settings

Read only through `src/lib/env.ts` (`secretEnv`), never via `import.meta.env`.

| Name | Used for | Where set |
|---|---|---|
| `FM_HOST`, `FM_DB` | FileMaker server and database (non-secret, in `wrangler.jsonc` vars) | vars |
| `FM_USER`, `FM_PASS` | Data API account | Worker secret + `.env` |
| `SHOPIFY_ADMIN_TOKEN` and the `SHOPIFY_*` vars | merch cards | Worker secret / vars |
| `ANTHROPIC_API_KEY` | translations (Swedish ↔ English) | Worker secret |
| `PUBLISH_PASSWORD` | the Publish button and `/admin` | Worker secret |
| `INDEXNOW_KEY`, `YOUTUBE_API_KEY` | optional, currently unset in production | Worker secret |

The proxy Worker has its own copies of the FileMaker credentials. A new data source
means new secrets: add them with `wrangler secret put`, add non-secret settings to
`vars` in `wrangler.jsonc`, and put local values in `.env`.

## 9. Everything else wired to FileMaker semantics

None of this needs field changes, but Codex should know it exists.

- **Publish button** (`src/pages/api/publish.ts`): bumps a `cache-version` epoch in KV.
  Every edge-cache key, every KV data key and every image URL embeds it, so one click
  invalidates the whole site. Keep it; it is the editor's "I changed something" signal.
- **KV read-through** (`src/lib/fm-kv.ts`): caches each find for 300 s under the epoch.
  Works unchanged with any adapter.
- **Crons** (`src/worker-entry.ts`): a 5-minute warm-up that re-runs the roster finds,
  and a nightly 04:00 release count over `API_ARTIST_DETAIL` portals (the homepage
  "releases" metric). The every-minute publication tick is paused (`PUBLICATION_TICK:
  "off"`).
- **Translations** (`src/lib/translate.ts`): keyed by a hash of the source text, not by
  record id. Existing translations survive the migration as long as the text is the
  same.
- **Admin** (`/admin`, `src/lib/admin-content.ts`): lists news fields and homepage
  blocks for review. Reads through the same getters.
- **Publication subsystem** (`src/lib/publication/`): shadow mode, serves nothing.
  Reads through an interface over the same getters (`fm-source.ts`).
- **Feeds and indexes**: `/news.xml`, sitemaps, `/llms.txt`, the search index. All read
  through the getters.
- **Shopify** and **YouTube** are separate integrations keyed by `collectionId` and
  `url_youtube_link`.

## 10. Open questions for Patrik

1. What is the new database's API? REST, GraphQL, SQL over a connector, something
   Codex generates? The adapter design depends on it.
2. Does it keep the FileMaker field names, or new ones? Either works; new names mean a
   mapping table in the adapter.
3. Where will images live, and are their URLs stable? Decides whether the proxy
   Worker is retired or rewritten.
4. What is the stable id of a web post block (section 6)?
5. Is the team `Active` flag "employed" or "shown on the site"? Today it is one flag.
6. Does the new database keep the `"Active"` / `"Not Active"` values and `MM/DD/YYYY`
   dates, or should the adapter normalise?
7. Do `SLUG` values stay the same? Every URL on the site, and every inbound link from
   Google, depends on them.

## 11. Definition of done

- `npm test` green.
- `npm run build:cf` passes (including the baked-secrets check).
- Every route in the sitemaps renders on staging (`ninetone-site.ninetone.workers.dev`)
  with the same slugs as today.
- Images load on artist, client, talent, team and news pages, and survive a Publish.
- `/admin` content health shows the same items as before.
- Deploy with `npm run deploy:cf`, bump `VERSION` and `CHANGELOG.md` in the same commit.

## Appendix: prompt to paste into Codex

Patrik: fill in the seven "Facts from Patrik" lines at the bottom (one line each is
enough; leave a line blank if you do not know), open Codex in a checkout of
`ninetone-group/ninetone-refresh`, and paste the whole text as the first message. It
pulls `main` itself, runs the migration end to end without check-ins, opens a pull
request, and writes a report for Mikael. You deploy when it is done; Mikael audits the
code afterwards.

```text
You are migrating the Astro site in this repository from the FileMaker Data API to a
new database. You do the whole job in one run: no plan approvals, no check-ins.
Patrik, who is running you, deploys when you are done. Mikael, the developer who
built the site, audits the result afterwards from your report. Ask a question only
if you truly cannot continue without the answer; otherwise decide, and write the
decision and the assumption down in the report.

Step 0: get on the latest code.

    git checkout main
    git pull origin main
    cat VERSION

The version must be 0.3.3.2 or higher and
docs/handoff-codex-database-migration-2026-10-26.md must exist. If not, stop and say
so; do not work on old code.

Step 1: read CLAUDE.md and docs/handoff-codex-database-migration-2026-10-26.md
completely. The handover is the specification. Its plan (section 3) is the approach:
a new adapter that exposes the same `fmFind` and `fmFindWithPortals` functions as
src/lib/filemaker.ts, returning records with the same field names, portal row keys
and value formats listed in sections 4 and 5. Do not rename fields across the site.
Do not edit the pages, components, feeds or sitemaps that consume the records unless
the handover names the change (section 6 for the homepage block ids, section 7 for
images). Keep src/lib/cache.ts, src/lib/fm-kv.ts, the Publish epoch, the crons and
the translation subsystem unchanged.

Step 2: the facts about the new database are in the "Facts from Patrik" block at the
end of this message, answering section 10 of the handover. Where a fact is missing,
inspect the database or its code if you can reach it; if you still cannot tell,
choose the simplest option, keep it in one place in the adapter, and record it as an
assumption in the report.

Step 3: implement on a branch named feat/new-database-adapter. Read secrets only
through src/lib/env.ts (`secretEnv`), never through `import.meta.env`. Put new
non-secret settings in `vars` in wrangler.jsonc. Never write a secret into a file
that is committed; list the `wrangler secret put` commands in the report instead.
Keep the `.fm-img-frame` / `.fm-img` markup on images.

Step 4: run `npm test` and `npm run build:cf` (Node 22: `nvm use 22`). Fix what
fails. Render the main routes with `npm run dev` (homepage, /records/artists, one
artist, /management/clients, one client, /ninetone-nation/booking, one talent,
/team, one team member, /news, one article, /news.xml, /sitemap-sv.xml) and check
that images load. Bump VERSION and add a CHANGELOG.md entry, as the repo does for
every change. Commit, push the branch, and open a pull request against main.

Step 5: write the report for Mikael. Save it as
docs/handoff-codex-report-<today's date>.md and commit it to the same pull request.
Write it for a reader who knows this codebase but has not seen your work, in this
order:

- What the new database is (technology, where it runs, how the site authenticates)
  and where the adapter lives.
- The mapping table: every layout and field from sections 4 and 5 of the handover,
  what it maps to in the new database, and every value the adapter normalises
  (dates, "Active", "Ja", "true", image URLs, block ids).
- Every decision you took without an answer from Patrik, and the assumption behind it.
- What you changed outside the adapter, file by file, and why each change was
  unavoidable.
- What you verified, with the actual commands and their results: tests, the
  Cloudflare build, which routes you rendered, which images you checked.
- What you did not do or could not verify.
- What Patrik must do before deploy: secrets to set with `wrangler secret put`,
  settings in wrangler.jsonc, anything in Cloudflare, anything in the new database.
- Risks you see, ranked, with the one thing to check first after deploy.

Be factual. If a test failed and you could not fix it, say so with the output. Do not
describe work you did not do.

Deploy: only when Patrik tells you to, and only with `npm run deploy:cf` as one
command (never a bare `wrangler deploy`, see CLAUDE.md). Never change anything on the
FileMaker side. Never commit a secret. If the handover disagrees with the code, trust
the code and note it in the report.

Facts from Patrik (section 10 of the handover):
1. The new database's API (REST, GraphQL, SQL, something else) and its base URL:
2. Field names: same as FileMaker, or new ones (where is the mapping):
3. Where images live and whether their URLs are stable:
4. The stable id of a web post block (homepage copy):
5. What the team "Active" flag means in the new database:
6. Whether "Active" / "Not Active" and MM/DD/YYYY dates are kept or changed:
7. Whether SLUG values stay the same:
```
