/**
 * Cross-roster redirects between the current-artist and previous-artist
 * detail routes (2026-09-14).
 *
 * WHY. The old ninetone.com served every artist under /records/artists/{slug}
 * for as long as they were current, and those URLs live on in search results
 * and links after the artist moves to "Not Active" — on the new site the same
 * path 404s because the artist is now only in the previous roster
 * (/records/artists/previous/single/{slug}). The reverse happens when a
 * previous artist is re-signed. Rather than a hand-maintained 301 list, each
 * detail route looks the slug up in the OTHER roster (a cached list read, no
 * extra FM call) and redirects. The pattern-based /previous-artists/* legacy
 * redirects (public/_redirects, cache-policy.ts) stay as they are.
 */

export const ARTIST_PATH = "/records/artists";
export const PREVIOUS_ARTIST_PATH = "/records/artists/previous/single";

type WithSlug = { SLUG?: unknown };

const hasSlug = (roster: ReadonlyArray<WithSlug>, slug: string): boolean =>
  roster.some((row) => String(row.SLUG ?? "") === slug);

/**
 * Where a slug that is NOT in the roster the route serves should go, or null
 * for a genuine 404. `from` is the roster the route serves; the sibling
 * roster is searched.
 */
export function crossRosterTarget(
  slug: string,
  from: "current" | "previous",
  siblingRoster: ReadonlyArray<WithSlug>,
): string | null {
  if (!slug || !hasSlug(siblingRoster, slug)) return null;
  const base = from === "current" ? PREVIOUS_ARTIST_PATH : ARTIST_PATH;
  return `${base}/${encodeURIComponent(slug)}`;
}
