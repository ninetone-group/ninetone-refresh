/**
 * Hand-maintained list of static (non-FM-driven) routes — every page that
 * isn't generated from a `src/lib/ninetone.ts` list helper.
 *
 * Consumers:
 *   - src/pages/sitemap-pages.xml.ts merges this with the FM-driven entity
 *     lists (artists, clients, team, Nation talent, news) to build the full
 *     sitemap.
 *   - src/pages/llms.txt.ts (Section 4 — imports this file, never edits it)
 *     does the same for its static-route section.
 *
 * What belongs here: every route a human can navigate to that Astro renders
 * from a fixed `.astro`/`.ts` file with no `getStaticPaths`/FM list behind
 * it — section landings, list/index pages, contact forms, legal pages. Each
 * entry is a site-relative path with a leading slash and no trailing slash
 * (the home page is the sole exception, `"/"`), matching what `url()` from
 * `src/lib/url.ts` expects.
 *
 * What does NOT belong here:
 *   - Anything generated from an FM list (artist/client/team/Nation/news
 *     detail pages, and their index pages already covered by list helpers
 *     directly) — those are enumerated separately by the sitemap/llms.txt
 *     builders via `src/lib/ninetone.ts`.
 *   - `/admin/*`, `/api/*` — not public content.
 *   - `/search-result` — a search-query surface, not a crawlable page (and
 *     explicitly excluded per the SEO brief).
 *   - Contact "thank you" states — there are none as distinct routes today;
 *     every contact page is a single URL with client-side submit state, so
 *     nothing to exclude beyond the contact form paths themselves, which
 *     ARE listed below (the form page is real, crawlable content).
 *   - `/[key].txt` (IndexNow key file, Section 10) — not content.
 *   - `/robots.txt`, `/llms.txt`, `/sitemap-index.xml`, `/sitemap-pages.xml`
 *     themselves — meta-routes, not pages to list inside themselves.
 *
 * Keep this list and the routes it names in sync by hand — there is no way
 * to derive it from the filesystem without also pulling in every dynamic
 * `[slug].astro`, which is exactly what it must NOT include.
 */

export interface StaticRoute {
  /** Site-relative path, leading slash, no trailing slash (except "/"). */
  path: string;
  /** Change frequency hint, loosely informative only (no lastmod claim). */
  changefreq?: "daily" | "weekly" | "monthly" | "yearly";
}

export const STATIC_ROUTES: StaticRoute[] = [
  { path: "/", changefreq: "daily" },
  { path: "/records", changefreq: "weekly" },
  { path: "/records/artists", changefreq: "weekly" },
  // Page 1 of paginate() lands at the BARE path, not "/previous/1" — Astro's
  // paginate() emits page 1 at the route's own base and pages 2+ at
  // "/previous/{n}" (confirmed in a fresh build: dist/records/artists/
  // previous/index.html exists, dist/records/artists/previous/1/ does not).
  // ArtistsTabs.astro and Footer.astro both link to this same bare path.
  { path: "/records/artists/previous", changefreq: "monthly" },
  { path: "/records/contact-records", changefreq: "yearly" },
  { path: "/management", changefreq: "weekly" },
  { path: "/management/clients", changefreq: "weekly" },
  { path: "/management/contact-management", changefreq: "yearly" },
  { path: "/ninetone-nation", changefreq: "weekly" },
  { path: "/ninetone-nation/booking", changefreq: "weekly" },
  { path: "/ninetone-nation/contact-ninetone-nation", changefreq: "yearly" },
  { path: "/team", changefreq: "monthly" },
  { path: "/news", changefreq: "daily" },
  { path: "/guider", changefreq: "monthly" },
  { path: "/integritet", changefreq: "yearly" },
];

/** Just the paths, in declared order — the common case for consumers that
 *  don't need `changefreq`. */
export function staticRoutePaths(): string[] {
  return STATIC_ROUTES.map((r) => r.path);
}

/**
 * Page size for the /records/artists/previous/{n} pagination.
 *
 * Single source of truth, defined here rather than in the page: a plain .ts
 * module can be imported by an .astro page (and by node:test), but not the
 * other way round. src/pages/records/artists/previous/[...page].astro imports
 * this for its paginate() call, and src/lib/sitemap.ts imports it to derive
 * how many pagination pages the sitemap should list.
 */
export const PREVIOUS_ARTISTS_PAGE_SIZE = 30;
