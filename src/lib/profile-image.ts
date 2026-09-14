/**
 * "Does this roster row have a usable profile picture?" (2026-09-14)
 *
 * WHY. 20 of the 140 former Management clients carry a FileMaker plugin
 * error in BOTH picture fields instead of a streaming URL:
 *
 *   [MBS] Invalid image reference: [MBS] Failed to read image.
 *
 * The image mirror only rewrites real Streaming_SSL URLs, so that string
 * reached the card's <img src> as-is and the card rendered empty. Mikael's
 * read: records like these are test entries, not clients to show — drop the
 * whole row, not just the picture. Applied in getPreviousClients() so the
 * list, detail pages, sitemap, llms.txt and the cross-roster redirect all
 * agree; a row heals itself the moment FM holds a real image.
 *
 * Deliberately shape-based (a URL, any host) rather than matching the MBS
 * text: the mirror has already rewritten the field to the proxy URL by the
 * time this runs, and any other non-URL garbage should fail the same way.
 */
const URL_SHAPE = /^https?:\/\//i;

type PictureFields = { artistPicture_small?: unknown; artistPicture_big?: unknown };

export function hasProfileImage(row: PictureFields): boolean {
  const small = String(row.artistPicture_small ?? "").trim();
  const big = String(row.artistPicture_big ?? "").trim();
  return URL_SHAPE.test(small) || URL_SHAPE.test(big);
}
