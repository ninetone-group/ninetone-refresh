# YouTube video indexing: recommendation for Ninetone

Reviewed **2026-10-10**, Europe/Stockholm. Sources: the supplied GSC screenshot, the two affected Joakim Lundell URLs, current public HTML/headers, local video code at `47652c5`, and current Google documentation. The checkout is on `fix/admin-lock-integrity`; its in-progress admin changes were left untouched.

> **Follow-up, 2026-10-10 (after this review).** The cause of the screenshot's errors is
> confirmed, so Step 1 below is answered. The old DivHunt site still answered at its
> former IP (`curl --resolve www.ninetone.com:443:34.102.250.126 …`) and its template
> printed two `VideoObject` entries on **every** artist and client page: never an
> `uploadDate`, `name` set to the raw FileMaker highlight link (empty when the person had
> no video, seen on `/records/artists/chan_fuze`), and broken thumbnail and embed
> addresses. That is the shape of "288 missing `uploadDate`, 260 missing `name`". The new
> site went live on 2026-10-08 ~19:30 UTC and has never emitted `VideoObject` (git
> history, Googlebot-UA fetch and YouTube's embed document all checked), so the count
> drains as Google recrawls; nothing in the code needs fixing. The watch-page pilot
> (Steps 2–4) is undecided; the advice given was to wait for the new site's own
> Video indexing data first.

## Recommendation

**This is worth a small pilot. Create dedicated watch pages for selected videos, with complete video metadata. Keep artist/client profiles focused on the artist/client.** Google explicitly supports indexing a YouTube video on both YouTube and a third-party site, provided the embedding page meets its requirements. A watch page must primarily serve one video; supporting videos on a biography or article are a weaker fit. The page itself must also be indexed and perform sufficiently well in Search. Eligibility does not guarantee video indexing. [Google's video requirements](https://developers.google.com/search/docs/appearance/video#watch-page)

First verify whether the screenshot's missing-field errors still exist. **They do not match the first-party structured data currently served by either supplied URL.** Adding fields blindly to the existing profiles would address the wrong layer.

## What the screenshot means

The screenshot is the **Videos structured-data enhancement report**. It shows **288 invalid items**, including 288 missing `uploadDate` and 260 missing `name`. These are structured-data items, not necessarily 288 unique videos or pages. The issue counts overlap. Its blue notice directs you to **Indexing → Video indexing** for the actual indexing outcome. Valid metadata is one checkpoint; it is not proof that a video has been indexed. [Rich result report overview](https://support.google.com/webmasters/answer/7552505?hl=en)

## What is live on the two affected URLs

Direct HTTPS GETs to the production URLs produced the following results. [Saved response summary](audit-evidence/video-indexing-2026-10-10/live-checks.json)

| Check | [Records profile](https://www.ninetone.com/records/artists/joakim_lundell) | [Management profile](https://www.ninetone.com/management/clients/joakim_lundell) |
| --- | --- | --- |
| HTTP status | 200 | 200 |
| Declared canonical | Its own production URL | Its own production URL |
| Robots meta / `X-Robots-Tag` | No restriction observed | No restriction observed |
| First-party JSON-LD | Organization, WebSite, BreadcrumbList, MusicGroup | Organization, WebSite, BreadcrumbList, Person |
| `VideoObject` entries | **0** | **0** |
| YouTube players in response HTML | **2** | **2** |
| Channel-feed links to YouTube | None in this response | 5 |

Both pages embed the same videos: **`4iWjuLc47Nw`** and **`TVrgkOC4I28`**. Each iframe has the generic title “Joakim Lundell video” and `loading="lazy"`. The players appear after the biography, in a two-column highlights section. This is supplementary profile content, not a dedicated watch experience.

Production [robots.txt](https://www.ninetone.com/robots.txt) allows crawling. The live [sitemap index](https://www.ninetone.com/sitemap-index.xml) references only `sitemap-pages.xml`. No blanket robots/noindex problem was found for these two pages. This does not establish Google's selected canonical or current indexing status; those require GSC inspection.

The code confirms the distinction:

- [Records profile:299](../src/pages/records/artists/[slug].astro#L299) and [management profile:266](../src/pages/management/clients/[slug].astro#L266) render supporting iframes from FM links, without per-video metadata.
- [YouTubeFeed.astro:140](../src/components/YouTubeFeed.astro#L140) renders thumbnails/title/date as links that open **YouTube**, rather than players on Ninetone.
- [schema.ts](../src/lib/schema.ts) contains no `VideoObject` builder. [News articles:177](../src/pages/news/[slug].astro#L177) likewise render supporting players without video JSON-LD.
- [youtube.ts:27](../src/lib/youtube.ts#L27) already models title, publication time and thumbnail for feed videos. Its RSS parser and top-viewed API path populate those values, but the manually selected highlight videos are not enriched through that model.

**Inference:** the GSC errors likely reflect older markup/crawls. Other possibilities include markup introduced during rendering or a different response served to Google's crawler. The screenshot's history extends back before the current production launch. Without Google's stored item/source and last-crawl date, the historical cause remains unconfirmed. Ordinary-user HTML is useful evidence, but cannot establish exactly what Googlebot received.

## Step 1: reconcile GSC with the live site

For each supplied URL:

1. Open an example under each missing-field issue. Record the **last crawled date**, video item and code location.
2. Compare the indexed version with **Test live URL → View tested page → HTML**. Look for `VideoObject`, `itemtype="...VideoObject"` and the two embedded video IDs. Check whether the offending markup belongs to the Ninetone document or an embedded resource.
3. Run the URL through [Rich Results Test](https://search.google.com/test/rich-results). If it still detects invalid video items, inspect the rendered source it highlights and repair that specific producer. An iframe's HTML `title` attribute does **not** supply `VideoObject.name`.
4. If the live error is gone, request recrawling of the examples and start **Validate fix** after checking the other reported examples. If incomplete markup remains elsewhere, repair or remove it there as well. Validation can take two weeks or more. [Google's validation workflow](https://support.google.com/webmasters/answer/13300208?hl=en)

If old video markup was removed, the invalid count may shrink without the valid count increasing. That resolves the enhancement error; it does not create new video search visibility.

## Step 2: pilot a genuine watch experience

Start with **5–10 editorially selected videos**, including the two Joakim IDs if they are useful priority content. This is a proposed experiment size, not a Google requirement.

Create one stable route per selected video, for example **`/videos/4iWjuLc47Nw`**. Reuse that watch URL from both the records and management profiles; do not create a separate copy for each division. Start with Swedish watch pages. Add `/en/videos/...` only when localized supporting content exists, using the site's existing canonical/hreflang helpers.

The proposed template should have:

- A video-specific H1, followed immediately by one large, visible player. On these watch pages, load the primary iframe eagerly and include its real `src` in server-rendered HTML. Keep ordinary playback controls; clicking Play is different from requiring a click to create/discover the player.
- The real video title, publication date and a concise description. Add useful release context, credits or an accurate transcript when available. Avoid producing hundreds of near-identical pages from the rolling channel feed.
- Links back to the related artist/client and release. Add a visible “Watch video” link from those existing pages to the dedicated route. The channel feed can remain an outbound YouTube discovery feature.
- A self-canonical Ninetone URL, a 200 response for published watch pages, and no production noindex restriction. Do not canonicalize the watch page to the artist profile or YouTube.

This is my recommended design for meeting the watch-page requirement while preserving the profiles' purpose. The current lazy supporting embeds can remain on profiles.

## Step 3: supply real video metadata

Extend [youtube.ts](../src/lib/youtube.ts) with lookup **by video ID**, rather than assuming the latest/top-five channel lists contain every highlight. Reuse the existing API secret and cache helpers. Batch known IDs through `videos.list` with `part=snippet,contentDetails,status`; this endpoint costs one quota unit per request. Keep lookups cached instead of fetching once per iframe/visitor. [YouTube videos.list](https://developers.google.com/youtube/v3/docs/videos/list)

| Output | Source / policy |
| --- | --- |
| `name` — required | Actual `snippet.title`, also used in the visible video heading |
| `uploadDate` — required | `snippet.publishedAt`: the video's publication timestamp, including timezone; not the FM article date, album release date or deploy date |
| `thumbnailUrl` — required | A real, accessible video thumbnail returned by YouTube; use one stable URL consistently |
| `embedUrl` — recommended | The specific iframe player URL, e.g. `https://www.youtube.com/embed/4iWjuLc47Nw` |
| `description` — recommended | A truthful video-specific summary, represented visibly on the page |
| `duration` — recommended | `contentDetails.duration`, when available |
| `url` / `@id` | The Ninetone watch URL and a stable video entity identifier |
| Playback eligibility | Check public availability and `status.embeddable`; account for region/age restrictions and removed videos |

Google requires `name`, `thumbnailUrl` and `uploadDate`. For YouTube embeds, use `embedUrl`; omit `contentUrl` unless you genuinely have an accessible media-file URL. A YouTube watch/player URL is not the video's media bytes. [VideoObject requirements](https://developers.google.com/search/docs/appearance/structured-data/video#video-object)

YouTube's `publishedAt` may differ from the private upload time when a video was made public later. It is the appropriate publication timestamp for this public-video workflow. The API also supplies the title, duration and embedding flag. [YouTube video resource](https://developers.google.com/youtube/v3/docs/videos)

Add a pure `videoObject()` builder to [schema.ts](../src/lib/schema.ts), and render through the existing [JsonLd.astro](../src/components/JsonLd.astro) escaping path. Use the same normalized record for the visible player, JSON-LD and sitemap. Do not fabricate a date/title when a lookup fails. Preserve a previously verified cached record during temporary failures; withhold incomplete new entries from the video sitemap/markup until resolved.

The rolling feed already has some metadata, but it is **not** a stable publication inventory: older videos fall out of its lists. Derive the pilot's selected IDs from existing FM highlight/news links or a small checked-in selection, deduplicate by ID, and retain a stable selected-video inventory. No FM schema changes or replacement CMS are needed.

## Step 4: add discovery and meaningful validation

Add **`sitemap-videos.xml`** and reference it from [sitemap-index.xml.ts](../src/pages/sitemap-index.xml.ts). Each entry's `<loc>` should be the Ninetone watch page, with the video's thumbnail, title, description and `<video:player_loc>`; include the real publication date as well. Keep these values aligned with JSON-LD and the visible page. A video sitemap helps discovery, but cannot make a profile page qualify as a watch page. [Google video sitemap documentation](https://developers.google.com/search/docs/crawling-indexing/sitemaps/video-sitemaps)

For the implementation, verify:

- Metadata mapping, timezone dates, duplicate IDs, missing/deleted/non-embeddable videos and safe JSON-LD serialization in focused tests.
- The Cloudflare build and secret gate, plus initial response HTML for a watch page: visible primary iframe, complete `VideoObject`, correct canonical and no noindex.
- Mobile layout and playback, including Google's rendered screenshot. The main player should be visible without opening a tab or modal. If consent controls delay player insertion, verify what Google can detect and retain consistent consent behavior for visitors and crawlers.
- Each pilot URL in Rich Results Test and GSC URL Inspection. Submit the sitemap, request indexing for the small pilot, and then follow **Indexing → Video indexing**, not just the enhancement report.

Google's video indexing report counts indexed pages where it detected a video, and indexes at most one video per page. Record the actual reason if a pilot URL is excluded: page not indexed, not a watch page, thumbnail failure, player position or another reported cause. Fix that cause rather than repeatedly submitting unchanged URLs. [Video indexing report](https://support.google.com/webmasters/answer/9495631)

## Investment decision

My suggested review window is **4–6 weeks after deployment**, extended if the pilot pages have not been crawled; this is a planning window, not a promised indexing timeline. Measure three separate outcomes:

1. **Metadata:** pilot `VideoObject` items validate without critical errors.
2. **Indexing:** watch pages are indexed, and Google reports their videos as indexed or provides actionable exclusion reasons.
3. **Value:** video-search impressions, clicks and useful visits to artist/release pages.

If the pilot earns visibility, expand selectively. If technically eligible, crawled watch pages still produce no useful results, keep YouTube as the primary video destination and prioritize Ninetone's artist, release and news search presence. Do not build a large video library solely to make a GSC chart green.

**Recommended next work:** reconcile the two current GSC examples, then implement the shared metadata lookup, one watch-page template and a small video sitemap. This document recommends that work; no product code, deployment settings or GSC state were changed during this review. No build/test rerun was needed for the documentation-only deliverable. Live Rich Results Test and authenticated GSC checks remain to be performed; access to those results was not available here.
