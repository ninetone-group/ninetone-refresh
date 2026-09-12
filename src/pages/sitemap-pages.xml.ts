import type { APIRoute } from "astro";
import {
  getArtists,
  getPreviousArtists,
  getClients,
  getTeam,
  getAllActiveBookingSlugs,
  getBookingCategories,
  getNews,
  getWebPosts,
} from "../lib/ninetone";
import { STATIC_ROUTES } from "../lib/routes";
import { buildSitemapEntries, localizeSitemapEntries, renderUrlsetXml } from "../lib/sitemap";
import { guidesFromCategory } from "../lib/guides";
import { pageJsonLdOrigin } from "../lib/site";

/**
 * The page sitemap referenced by /sitemap-index.xml. Lists every static
 * route (src/lib/routes.ts) plus every active artist, previous artist,
 * client, team member, Nation talent, and news article — using the same
 * list helpers the index pages already fetch with (src/lib/ninetone.ts), so
 * this can never enumerate a detail page that doesn't actually exist.
 *
 * Deliberately excludes: /admin, /api, /search-result, and contact
 * thank-you states (there are none as distinct routes — see routes.ts doc).
 *
 * Runs prerendered on the static (gh) target (Astro forces full prerender
 * under output: "static", so no explicit `export const prerender` is
 * needed there) and per-request on the CF (server) target, where it reads
 * live FM data and the real request origin — exactly the "replace
 * @astrojs/sitemap's output with our own endpoint" behaviour the brief asks
 * for on that target.
 *
 * Uses pageJsonLdOrigin() rather than a bare siteOrigin(): on the still-
 * preview gh target the site is served from a sub-path
 * (`/ninetone-refresh-preview`), and every <loc> must be a URL that actually
 * resolves there, not 404 — the same "GH Pages sub-path leaked out of an
 * absolute URL built from a bare origin" bug jsonLdOrigin()/
 * pageJsonLdOrigin() (src/lib/site.ts) already exist to prevent for JSON-LD.
 * Once PUBLIC_SITE_ORIGIN is set (production-shaped), this is a no-op
 * passthrough of siteOrigin() — see jsonLdOrigin()'s own doc comment.
 *
 * Section 5 (i18n Phase 2, docs/i18n-phase-2-brief.md): "both locales for
 * every URL, with xhtml:link alternates." The locale-free entry list below
 * (unchanged from Phase 1) is run through localizeSitemapEntries(), which
 * adds the full sv/en/x-default alternate set to every entry and — gated on
 * PUBLIC_HAS_RUNTIME — also emits a separate /en/... <url> entry per page.
 *
 * WHY GATED ON PUBLIC_HAS_RUNTIME (constraint from the brief): decision 2 is
 * explicit that /en/ is a CF-only feature — src/middleware.ts's locale
 * rewrite only runs `if (HAS_RUNTIME)`, so on the gh/static target visiting
 * an /en/... URL 404s (Astro never built a page there; there is no rewrite
 * to save it). Advertising hundreds of /en/... <loc> entries in the STATIC
 * sitemap would therefore point every crawler that reads it at real 404s.
 * The gh build IS noindex/nofollow today (robots.txt's PUBLIC_NOINDEX
 * default-on), so in practice nothing crawls this sitemap on that target
 * yet — but "nothing crawls it YET, because it's marked noindex" is a
 * property of today's launch state, not a property of the sitemap file
 * itself, and a sitemap that lists 404s is wrong regardless of whether
 * anything is currently reading it. So the static build gets sv-only <url>
 * entries (each still carrying the full alternates array — the alternates
 * describe the site's real locale structure, honest on every target; only
 * the *listed* URLs are gated to what this target actually serves), and the
 * cf/server target — where /en/... genuinely resolves — gets both.
 */
export const GET: APIRoute = async ({ request }) => {
  const origin = pageJsonLdOrigin(request);

  const [artists, previousArtists, clients, team, bookingSlugs, bookingCategories, news, guiderSections] =
    await Promise.all([
      getArtists(),
      getPreviousArtists(),
      getClients(),
      getTeam(),
      getAllActiveBookingSlugs(),
      getBookingCategories(),
      getNews(),
      getWebPosts("Guider"),
    ]);
  // Section 7: guides derived from the same helper the guide pages'
  // getStaticPaths() uses, so a guide can never appear here without a real
  // page behind it (or vice versa).
  const guides = guidesFromCategory(guiderSections[0]);

  const entries = buildSitemapEntries(origin, {
    staticRoutes: STATIC_ROUTES,
    artists,
    previousArtists,
    clients,
    team,
    // getAllActiveBookingSlugs() (not getBookingRoster()) — this is the
    // EXACT set /ninetone-nation/[slug].astro generates pages for (via
    // getBookingPageSet(), same underlying helper). getBookingRoster() is
    // the stricter API_Booking query and misses booking-only talents that
    // exist only in the API_BOOKING_TAG portal (e.g. Quireboys, Asta Kask —
    // see ninetone.ts's own comment on getBookingPageSet). The two sets
    // happen to coincide today but will silently diverge the moment such a
    // talent reappears; using the roster helper here would then omit a real
    // page from the sitemap.
    bookingTalent: bookingSlugs.map((slug) => ({ SLUG: slug })),
    // Section 6 category pages (src/pages/ninetone-nation/kategori/[category].astro)
    // — bookingCategoryEntries() applies the same "at least one artist"
    // filter that page's getStaticPaths() uses, so only populated categories
    // ever appear here.
    bookingCategories,
    news,
    guides,
  });

  // Gated on PUBLIC_HAS_RUNTIME — see this file's doc comment above for why
  // the gh/static build must not advertise /en/... URLs that 404 there.
  const hasRuntime =
    import.meta.env.PUBLIC_HAS_RUNTIME === true || import.meta.env.PUBLIC_HAS_RUNTIME === "true";
  const localizedEntries = localizeSitemapEntries(origin, entries, hasRuntime);

  return new Response(renderUrlsetXml(localizedEntries), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
