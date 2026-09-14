/**
 * Cross-roster redirects between the current and previous detail routes of
 * a division (Records artists 2026-09-14, Management clients 2026-09-14).
 *
 * WHY. The old ninetone.com served every artist under /records/artists/{slug}
 * and every client under /management/clients/{slug} for as long as they were
 * current, and those URLs live on in search results and links after the
 * entity moves to "Not Active" — on the new site the same path 404s because
 * the entity is now only in the previous roster
 * (/records/artists/previous/single/{slug},
 * /management/clients/previous/single/{slug}). The reverse happens when a
 * previous artist or client is re-signed. Rather than a hand-maintained 301
 * list, each detail route looks the slug up in the OTHER roster (a cached
 * list read, no extra FM call) and redirects. The pattern-based
 * /previous-artists/* legacy redirects (public/_redirects, cache-policy.ts)
 * stay as they are.
 */

export const ARTIST_PATH = "/records/artists";
export const PREVIOUS_ARTIST_PATH = "/records/artists/previous/single";
export const CLIENT_PATH = "/management/clients";
export const PREVIOUS_CLIENT_PATH = "/management/clients/previous/single";

export type RosterDivision = "records" | "management";

const ROSTER_PATHS: Record<RosterDivision, { current: string; previous: string }> = {
  records: { current: ARTIST_PATH, previous: PREVIOUS_ARTIST_PATH },
  management: { current: CLIENT_PATH, previous: PREVIOUS_CLIENT_PATH },
};

type WithSlug = { SLUG?: unknown };

const hasSlug = (roster: ReadonlyArray<WithSlug>, slug: string): boolean =>
  roster.some((row) => String(row.SLUG ?? "") === slug);

/**
 * Where a slug that is NOT in the roster the route serves should go, or null
 * for a genuine 404. `from` is the roster the route serves; the sibling
 * roster is searched. `division` picks the path pair — Records artists by
 * default (the original call sites), Management clients when asked.
 */
export function crossRosterTarget(
  slug: string,
  from: "current" | "previous",
  siblingRoster: ReadonlyArray<WithSlug>,
  division: RosterDivision = "records",
): string | null {
  if (!slug || !hasSlug(siblingRoster, slug)) return null;
  const paths = ROSTER_PATHS[division];
  const base = from === "current" ? paths.previous : paths.current;
  return `${base}/${encodeURIComponent(slug)}`;
}
