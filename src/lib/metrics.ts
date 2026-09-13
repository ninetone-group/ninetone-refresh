/**
 * Homepage "by the numbers" helpers (2026-09-13). The panel used to be four
 * hardcoded figures; two of them drift with reality, so they are derived:
 *   - the live roster count across Records, Management and Nation
 *   - the years since Ninetone started (2006)
 * The other two (campaigns, houses) stay editorial copy — nothing the site
 * reads from FM can produce them.
 */

/** Rows from the three active rosters; only the slug matters here. */
type WithSlug = { SLUG?: unknown };

/**
 * Distinct active profiles across the divisions. The same person can be a
 * Records artist AND bookable through Nation (or a Management client), so the
 * union is by slug — counting rows would count them twice. Rows without a
 * slug are skipped: they have no page, so they are not a "profile".
 */
export function liveRosterCount(...rosters: ReadonlyArray<ReadonlyArray<WithSlug>>): number {
  const slugs = new Set<string>();
  for (const roster of rosters) {
    for (const row of roster) {
      const slug = typeof row.SLUG === "string" ? row.SLUG.trim() : "";
      if (slug) slugs.add(slug);
    }
  }
  return slugs.size;
}

/** "87" → "80+": the panel's rounded-down, never-overstated style. Below 10 the exact figure. */
export function roundedPlus(n: number): string {
  if (n < 10) return String(Math.max(0, Math.floor(n)));
  return `${Math.floor(n / 10) * 10}+`;
}

export const FOUNDED_YEAR = 2006;

/** Whole years since the founding year, never negative. */
export function yearsSince(founded: number = FOUNDED_YEAR, now: Date = new Date()): number {
  return Math.max(0, now.getFullYear() - founded);
}
