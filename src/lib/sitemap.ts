/**
 * Pure sitemap-entry builder. No I/O, no Astro globals — callers
 * (src/pages/sitemap-pages.xml.ts) gather the FM list data that's already
 * fetched elsewhere (same helpers the index pages use, src/lib/ninetone.ts)
 * and pass it in as plain arrays. Kept separate and pure so it's unit
 * testable without a build (test/sitemap.test.mjs).
 *
 * `<lastmod>` is intentionally almost always omitted: none of the FM layouts
 * behind these lists expose a modification timestamp distinct from a
 * "published" date (API_NEWS has only `Date`; releases have only
 * `releaseDate`; artists/clients/team/booking rows have no date field at
 * all beyond FM's internal `__recordId`, which is a creation-order serial,
 * not a timestamp). Per the brief: never fabricate a date. Every builder
 * below therefore emits no `lastmod` for any entity — there is nothing
 * truthful to put there today. If a genuine modification-timestamp field
 * ever appears in a fetched layout, thread it through here explicitly
 * rather than guessing from an adjacent date field.
 *
 * Section 5 (i18n Phase 2, docs/i18n-phase-2-brief.md): "both locales for
 * every URL, with xhtml:link alternates." `buildSitemapEntries` below keeps
 * building the locale-FREE (Swedish-path) entry list exactly as before —
 * that shape is what every existing test in test/sitemap.test.mjs asserts
 * against, and it is the natural "one canonical page list" representation.
 * `localizeSitemapEntries()` is the new layer on top: it takes that list and
 * expands each entry into one sv entry and (when English is being
 * advertised — see `renderUrlsetXml`'s `xhtml` param and the gh/static
 * guard in src/pages/sitemap-pages.xml.ts) one en entry, each carrying the
 * full sv/en/x-default alternate set on itself. All path math goes through
 * src/lib/i18n.ts's `localizedPath` — never reimplemented here.
 */

import { PREVIOUS_ARTISTS_PAGE_SIZE, type StaticRoute } from "./routes.ts";
import { slugifyTag } from "./booking-slug.ts";
import { hasEnglishVersion, localizedPath } from "./i18n.ts";
import type { Lang } from "./translate.ts";

export interface SitemapEntry {
  /** Absolute URL — origin + path, no trailing slash added/removed beyond
   *  what the input path already has. */
  loc: string;
  changefreq?: "daily" | "weekly" | "monthly" | "yearly";
  /** ISO date string. Omitted whenever no real modification timestamp
   *  exists for the entity — see module doc. Never fabricated. */
  lastmod?: string;
  /**
   * Per-URL hreflang alternate set (sitemap protocol's `xhtml:link
   * rel="alternate"`), added by `localizeSitemapEntries()` below. Absent on
   * an entry built directly by `buildSitemapEntries()` — only the localized
   * layer populates this, and `renderUrlsetXml` only emits the
   * `xmlns:xhtml` namespace / `<xhtml:link>` tags for entries that carry it,
   * so the un-localized entry shape (and every existing test asserting
   * against it) is unaffected.
   */
  alternates?: HreflangAlternate[];
}

/** One `<xhtml:link rel="alternate" hreflang="…">` on a `SitemapEntry`. */
export interface HreflangAlternate {
  hreflang: "sv" | "en" | "x-default";
  href: string;
}

function joinPath(origin: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${p}`;
}

/** Static hand-maintained routes (src/lib/routes.ts) as sitemap entries. */
export function staticRouteEntries(origin: string, routes: StaticRoute[]): SitemapEntry[] {
  return routes.map((r) => ({
    loc: joinPath(origin, r.path),
    changefreq: r.changefreq,
  }));
}

export interface SlugSource {
  SLUG?: unknown;
  slug?: unknown;
}

/**
 * Build sitemap entries for a list of FM rows that each resolve to one
 * detail page at `${pathPrefix}/${slug}`. Skips rows with no usable slug
 * (mirrors the `if (!slug) continue` guard search-index.json.ts uses for
 * the same lists) so a blank/malformed FM row never emits a bare
 * `pathPrefix` URL.
 */
export function detailPageEntries(
  origin: string,
  rows: SlugSource[],
  pathPrefix: string,
  changefreq?: SitemapEntry["changefreq"],
): SitemapEntry[] {
  const prefix = pathPrefix.replace(/\/$/, "");
  const out: SitemapEntry[] = [];
  for (const row of rows) {
    const slug = String(row.SLUG ?? row.slug ?? "");
    if (!slug) continue;
    out.push({ loc: joinPath(origin, `${prefix}/${slug}`), changefreq });
  }
  return out;
}

/**
 * Page 2..lastPage of the previous-artists roster listing
 * (src/pages/records/artists/previous/[...page].astro) — real, crawlable,
 * paginated list pages, distinct from the individual previous-artist detail
 * pages (already covered by `detailPageEntries` at
 * "/records/artists/previous/single/{slug}"). Page 1 lives at the bare
 * "/records/artists/previous" (see src/lib/routes.ts) and is NOT repeated
 * here. `totalPreviousArtists` is the live count from the same
 * getPreviousArtists() call the sitemap endpoint already makes — no new FM
 * read, and the page count self-maintains as the roster grows or shrinks.
 */
export function previousArtistsPaginationEntries(
  origin: string,
  totalPreviousArtists: number,
  pageSize: number = PREVIOUS_ARTISTS_PAGE_SIZE,
): SitemapEntry[] {
  const lastPage = Math.max(1, Math.ceil(totalPreviousArtists / pageSize));
  const out: SitemapEntry[] = [];
  for (let n = 2; n <= lastPage; n++) {
    out.push({ loc: joinPath(origin, `/records/artists/previous/${n}`), changefreq: "monthly" });
  }
  return out;
}

/**
 * Nation booking category pages (Section 6:
 * src/pages/ninetone-nation/kategori/[category].astro) — one entry per
 * category that actually has at least one active talent, using the exact
 * same "at least one artist" filter and slugifyTag() the page's own
 * getStaticPaths() uses, so this list can never include a category that
 * 404s or omit one that's live (rule 12: empty categories don't exist as
 * pages at all, so they must not exist in the sitemap either).
 */
export interface BookingCategoryLike {
  tag: string;
  artists: unknown[];
}

export function bookingCategoryEntries(
  origin: string,
  categories: BookingCategoryLike[],
): SitemapEntry[] {
  return categories
    .filter((c) => c.artists.length > 0)
    .map((c) => ({
      loc: joinPath(origin, `/ninetone-nation/kategori/${slugifyTag(c.tag)}`),
      changefreq: "weekly",
    }));
}

/**
 * Guides route (Section 7: src/pages/guider/index.astro + [slug].astro) —
 * one entry per guide already derived from the "Guider" WebPosts category by
 * guidesFromCategory() (src/lib/guides.ts), the exact same helper the guide
 * pages' own getStaticPaths() uses. When the category is absent or empty,
 * `guides` is [] and this produces no entries at all (rule 12) — mirrors
 * bookingCategoryEntries()'s "page doesn't exist -> no sitemap entry" shape.
 */
export interface GuideLike {
  slug: string;
}

export function guideEntries(origin: string, guides: GuideLike[]): SitemapEntry[] {
  return guides
    .filter((g) => g.slug)
    .map((g) => ({
      loc: joinPath(origin, `/guider/${g.slug}`),
      changefreq: "monthly",
    }));
}

/**
 * Assemble the full `sitemap-pages.xml` entry list: static routes + every
 * FM-driven detail page, using the exact list helpers/shapes the index
 * pages already fetch with (src/lib/ninetone.ts) — no new FM reads here,
 * callers pass already-fetched rows in.
 */
export function buildSitemapEntries(
  origin: string,
  input: {
    staticRoutes: StaticRoute[];
    artists: SlugSource[];
    previousArtists: SlugSource[];
    clients: SlugSource[];
    team: SlugSource[];
    bookingTalent: SlugSource[];
    bookingCategories: BookingCategoryLike[];
    news: SlugSource[];
    /** Section 7 — guides derived from the "Guider" WebPosts category via
     *  guidesFromCategory(); [] when the category is absent (rule 12). */
    guides?: GuideLike[];
  },
): SitemapEntry[] {
  return [
    ...staticRouteEntries(origin, input.staticRoutes),
    ...detailPageEntries(origin, input.artists, "/records/artists", "weekly"),
    ...previousArtistsPaginationEntries(origin, input.previousArtists.length),
    ...detailPageEntries(origin, input.previousArtists, "/records/artists/previous/single", "yearly"),
    ...detailPageEntries(origin, input.clients, "/management/clients", "weekly"),
    ...detailPageEntries(origin, input.team, "/team", "monthly"),
    ...detailPageEntries(origin, input.bookingTalent, "/ninetone-nation", "weekly"),
    ...bookingCategoryEntries(origin, input.bookingCategories),
    ...detailPageEntries(origin, input.news, "/news", "monthly"),
    ...guideEntries(origin, input.guides ?? []),
  ];
}

/**
 * Expand a locale-free entry list (as produced by `buildSitemapEntries()`,
 * every `loc` a bare Swedish-path URL under `origin`) into "both locales for
 * every URL, with xhtml:link alternates" (Section 5's Build item).
 *
 * For each input entry this produces:
 *   - ALWAYS one sv entry, at the entry's existing (unprefixed) `loc`.
 *   - When `includeEnglish` is true, ALSO one en entry, at the `/en`-
 *     prefixed URL for the same path.
 * Both carry the identical `alternates` array — sv, en, and x-default (=
 * Swedish, decision 1) — so "each locale gets an entry, and each entry
 * lists the full alternate set including itself" (the brief's own
 * definition of what "both locales" means here) holds for every entry this
 * function returns, not just the English ones.
 *
 * `includeEnglish` exists for the gh/static target (see
 * src/pages/sitemap-pages.xml.ts's own doc comment for the full reasoning):
 * `/en/` is a CF-only feature there (decision 2), so advertising `/en/...`
 * URLs in a STATIC sitemap would point crawlers at pages that don't exist
 * on that target. Passing `false` collapses this to sv-only entries, each
 * still carrying its full (sv/en/x-default) alternate set — the alternates
 * describe the site's actual locale structure (true everywhere the site is
 * eventually reachable), while the *listed* `<url>` entries describe what
 * this particular build actually serves.
 *
 * All path math is `localizedPath()` from src/lib/i18n.ts — never
 * reimplemented here. `loc` is origin + path (`joinPath`'s own contract),
 * so the bare path is recovered by stripping the `origin` prefix before
 * calling `localizedPath()` and re-joining after.
 */
export function localizeSitemapEntries(
  origin: string,
  entries: SitemapEntry[],
  includeEnglish: boolean,
): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const entry of entries) {
    const path = entry.loc.startsWith(origin) ? entry.loc.slice(origin.length) || "/" : entry.loc;
    const svHref = joinPath(origin, localizedPath(path, "sv"));

    // Swedish-only pages get ONE entry and no English alternate (SEO audit
    // P1). Doubling every entry unconditionally put /en/integritet and
    // /en/guider/* in the sitemap as loc values and as hreflang alternates,
    // even though those URLs return Swedish HTML canonicalizing to the bare
    // Swedish path — a non-canonical URL advertised as an English version.
    // hasEnglishVersion() is the same rule Base.astro's hreflang builder and
    // the language switch use, so the three cannot drift apart.
    if (!hasEnglishVersion(path)) {
      out.push({
        ...entry,
        loc: svHref,
        alternates: [
          { hreflang: "sv", href: svHref },
          { hreflang: "x-default", href: svHref },
        ],
      });
      continue;
    }

    const enHref = joinPath(origin, localizedPath(path, "en"));
    const alternates: HreflangAlternate[] = [
      { hreflang: "sv", href: svHref },
      { hreflang: "en", href: enHref },
      { hreflang: "x-default", href: svHref },
    ];

    out.push({ ...entry, loc: svHref, alternates });
    if (includeEnglish) {
      out.push({ ...entry, loc: enHref, alternates });
    }
  }
  return out;
}

/**
 * Convenience: build the locale-free entry list AND localize it in one
 * call, exactly the two-step pipeline src/pages/sitemap-pages.xml.ts runs.
 * Kept as a thin wrapper (rather than folding localization into
 * `buildSitemapEntries` itself) so the many existing tests in
 * test/sitemap.test.mjs asserting against `buildSitemapEntries`'s
 * locale-free output keep working unchanged — Section 5 adds a layer, it
 * does not change what was already there.
 */
export function buildLocalizedSitemapEntries(
  origin: string,
  input: Parameters<typeof buildSitemapEntries>[1],
  includeEnglish: boolean,
): SitemapEntry[] {
  return localizeSitemapEntries(origin, buildSitemapEntries(origin, input), includeEnglish);
}

/**
 * Serialize entries to a `urlset` sitemap XML document.
 *
 * Section 5: entries carrying `alternates` (from `localizeSitemapEntries()`)
 * get one `<xhtml:link rel="alternate" hreflang="…">` per alternate, and the
 * `xmlns:xhtml` namespace declaration is added to `<urlset>` whenever AT
 * LEAST ONE entry has alternates — the sitemap protocol requires the
 * namespace be declared on the root element for `xhtml:link` to be valid at
 * all, so this is unconditional-per-document rather than per-entry: a
 * `<urlset>` with `<xhtml:link>` children but no matching `xmlns:xhtml`
 * declaration is invalid XML-by-schema even though a lenient parser might
 * render it, which is exactly the "worse than no alternates" failure mode
 * the brief calls out. Entries with no `alternates` (i.e. anything built by
 * `buildSitemapEntries()` directly, without going through
 * `localizeSitemapEntries()`) render exactly as before — this is additive,
 * not a breaking change to the existing single-locale shape.
 */
export function renderUrlsetXml(entries: SitemapEntry[]): string {
  const hasAlternates = entries.some((e) => e.alternates && e.alternates.length > 0);
  const urls = entries
    .map((e) => {
      const lastmod = e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : "";
      const changefreq = e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : "";
      const alternates = (e.alternates ?? [])
        .map((a) => `<xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${escapeXml(a.href)}"/>`)
        .join("");
      return `<url><loc>${escapeXml(e.loc)}</loc>${alternates}${lastmod}${changefreq}</url>`;
    })
    .join("");
  const xhtmlNs = hasAlternates ? ` xmlns:xhtml="http://www.w3.org/1999/xhtml"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtmlNs}>${urls}</urlset>`;
}

/** Serialize a `sitemapindex` document referencing one or more page
 *  sitemaps. Kept generic (a list of absolute URLs) even though Phase 1
 *  only ever has one member — the shape a second sitemap would need later
 *  (e.g. an images sitemap) costs nothing extra now. */
export function renderSitemapIndexXml(sitemapUrls: string[]): string {
  const items = sitemapUrls.map((u) => `<sitemap><loc>${escapeXml(u)}</loc></sitemap>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</sitemapindex>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
