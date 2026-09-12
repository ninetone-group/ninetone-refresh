import assert from "node:assert/strict";
import test from "node:test";

import {
  staticRouteEntries,
  detailPageEntries,
  previousArtistsPaginationEntries,
  bookingCategoryEntries,
  guideEntries,
  buildSitemapEntries,
  localizeSitemapEntries,
  buildLocalizedSitemapEntries,
  renderUrlsetXml,
  renderSitemapIndexXml,
} from "../src/lib/sitemap.ts";
import { STATIC_ROUTES, staticRoutePaths } from "../src/lib/routes.ts";

const ORIGIN = "https://ninetone.com";

test("staticRouteEntries: one entry per route, absolute, under the origin", () => {
  const entries = staticRouteEntries(ORIGIN, [
    { path: "/", changefreq: "daily" },
    { path: "/records", changefreq: "weekly" },
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].loc, "https://ninetone.com/");
  assert.equal(entries[1].loc, "https://ninetone.com/records");
  for (const e of entries) assert.ok(e.loc.startsWith(ORIGIN));
});

test("detailPageEntries: builds one URL per row keyed on SLUG (uppercase field)", () => {
  const rows = [{ SLUG: "anjo" }, { SLUG: "some-artist" }];
  const entries = detailPageEntries(ORIGIN, rows, "/records/artists", "weekly");
  assert.deepEqual(
    entries.map((e) => e.loc),
    ["https://ninetone.com/records/artists/anjo", "https://ninetone.com/records/artists/some-artist"],
  );
  assert.equal(entries[0].changefreq, "weekly");
});

test("detailPageEntries: also accepts lowercase slug field (news posts)", () => {
  const rows = [{ slug: "a-headline" }];
  const entries = detailPageEntries(ORIGIN, rows, "/news");
  assert.deepEqual(entries.map((e) => e.loc), ["https://ninetone.com/news/a-headline"]);
});

test("detailPageEntries: skips rows with no usable slug rather than emitting a bare prefix URL", () => {
  const rows = [{ SLUG: "" }, {}, { SLUG: "valid" }];
  const entries = detailPageEntries(ORIGIN, rows, "/team");
  assert.deepEqual(entries.map((e) => e.loc), ["https://ninetone.com/team/valid"]);
});

test("detailPageEntries: strips a trailing slash from pathPrefix so no double-slash appears", () => {
  const entries = detailPageEntries(ORIGIN, [{ SLUG: "x" }], "/team/");
  assert.equal(entries[0].loc, "https://ninetone.com/team/x");
});

test("detailPageEntries: never emits a lastmod — no FM layout in scope exposes a real modification timestamp", () => {
  const entries = detailPageEntries(ORIGIN, [{ SLUG: "x" }], "/records/artists");
  assert.equal(entries[0].lastmod, undefined);
});

test("previousArtistsPaginationEntries: 0 extra pages when the roster fits on page 1", () => {
  const entries = previousArtistsPaginationEntries(ORIGIN, 1, 30);
  assert.equal(entries.length, 0);
});

test("previousArtistsPaginationEntries: derives page count from total/pageSize, starting at page 2 (page 1 is the bare static route)", () => {
  const entries = previousArtistsPaginationEntries(ORIGIN, 342, 30); // matches ninetone.ts's own "342 records as of writing" comment
  // ceil(342/30) = 12 total pages -> pages 2..12 = 11 entries
  assert.equal(entries.length, 11);
  assert.deepEqual(
    entries.map((e) => e.loc),
    Array.from({ length: 11 }, (_, i) => `https://ninetone.com/records/artists/previous/${i + 2}`),
  );
});

test("previousArtistsPaginationEntries: recomputes page count for a smaller/larger total (self-maintaining, not hardcoded)", () => {
  assert.equal(previousArtistsPaginationEntries(ORIGIN, 60, 30).length, 1); // pages 1-2, only page 2 extra
  assert.equal(previousArtistsPaginationEntries(ORIGIN, 61, 30).length, 2); // pages 1-3
  assert.equal(previousArtistsPaginationEntries(ORIGIN, 0, 30).length, 0);
});

function stubbedLists() {
  return {
    staticRoutes: STATIC_ROUTES,
    artists: [{ SLUG: "artist-a" }, { SLUG: "artist-b" }],
    previousArtists: Array.from({ length: 65 }, (_, i) => ({ SLUG: `old-artist-${i}` })),
    clients: [{ SLUG: "client-a" }, { SLUG: "client-b" }, { SLUG: "client-c" }],
    team: [{ SLUG: "team-a" }],
    bookingTalent: [{ SLUG: "talent-a" }, { SLUG: "talent-b" }],
    bookingCategories: [
      { tag: "Artist", artists: [{ slug: "talent-a" }, { slug: "talent-b" }] },
      { tag: "Föreläsare", artists: [{ slug: "talent-a" }] },
      { tag: "Konferencier", artists: [] }, // empty category -> no sitemap entry
    ],
    news: [{ slug: "post-a" }],
  };
}

test("buildSitemapEntries: produces exactly N entries for stubbed lists (static + every detail row + previous-artist pagination pages + populated category pages)", () => {
  const input = stubbedLists();
  const entries = buildSitemapEntries(ORIGIN, input);
  const expectedPaginationPages = previousArtistsPaginationEntries(ORIGIN, input.previousArtists.length).length;
  const expectedCategoryPages = input.bookingCategories.filter((c) => c.artists.length > 0).length;
  const expectedCount =
    input.staticRoutes.length +
    input.artists.length +
    expectedPaginationPages +
    input.previousArtists.length +
    input.clients.length +
    input.team.length +
    input.bookingTalent.length +
    expectedCategoryPages +
    input.news.length;
  assert.equal(entries.length, expectedCount);
  // With 65 previous artists at page size 30: ceil(65/30) = 3 pages -> 2 extra (pages 2, 3).
  assert.equal(expectedPaginationPages, 2);
  // Artist + Föreläsare populated, Konferencier empty -> 2 category pages.
  assert.equal(expectedCategoryPages, 2);
});

test("buildSitemapEntries: previous-artist pagination page 1 is NOT duplicated (only the bare static route represents it)", () => {
  const entries = buildSitemapEntries(ORIGIN, stubbedLists());
  const locs = entries.map((e) => e.loc);
  assert.ok(locs.includes("https://ninetone.com/records/artists/previous")); // from STATIC_ROUTES
  assert.ok(!locs.includes("https://ninetone.com/records/artists/previous/1"));
  assert.ok(locs.includes("https://ninetone.com/records/artists/previous/2"));
  assert.ok(locs.includes("https://ninetone.com/records/artists/previous/3"));
});

test("buildSitemapEntries: no duplicate <loc> values", () => {
  const entries = buildSitemapEntries(ORIGIN, stubbedLists());
  const locs = entries.map((e) => e.loc);
  assert.equal(new Set(locs).size, locs.length);
});

test("buildSitemapEntries: every <loc> is absolute and under the given origin", () => {
  const entries = buildSitemapEntries(ORIGIN, stubbedLists());
  for (const e of entries) {
    assert.ok(e.loc.startsWith(`${ORIGIN}/`) || e.loc === ORIGIN, `${e.loc} not under ${ORIGIN}`);
    assert.doesNotThrow(() => new URL(e.loc));
  }
});

test("buildSitemapEntries: same detail-page path shapes the index pages actually use", () => {
  const entries = buildSitemapEntries(ORIGIN, stubbedLists());
  const locs = entries.map((e) => e.loc);
  assert.ok(locs.includes("https://ninetone.com/records/artists/artist-a"));
  assert.ok(locs.includes("https://ninetone.com/records/artists/previous/single/old-artist-0"));
  assert.ok(locs.includes("https://ninetone.com/management/clients/client-a"));
  assert.ok(locs.includes("https://ninetone.com/team/team-a"));
  assert.ok(locs.includes("https://ninetone.com/ninetone-nation/talent-a"));
  assert.ok(locs.includes("https://ninetone.com/news/post-a"));
});

test("buildSitemapEntries: with empty FM lists, only the static routes appear", () => {
  const entries = buildSitemapEntries(ORIGIN, {
    staticRoutes: STATIC_ROUTES,
    artists: [],
    previousArtists: [],
    clients: [],
    team: [],
    bookingTalent: [],
    bookingCategories: [],
    news: [],
  });
  assert.equal(entries.length, STATIC_ROUTES.length);
});

// ---------------------------------------------------------------------------
// bookingCategoryEntries (Section 6 — Nation category pages)
// ---------------------------------------------------------------------------

test("bookingCategoryEntries: one entry per category with at least one artist, slugified", () => {
  const entries = bookingCategoryEntries(ORIGIN, [
    { tag: "Artist", artists: [{ slug: "a" }] },
    { tag: "Föreläsare", artists: [{ slug: "b" }] },
  ]);
  assert.deepEqual(
    entries.map((e) => e.loc),
    [
      "https://ninetone.com/ninetone-nation/kategori/artist",
      "https://ninetone.com/ninetone-nation/kategori/forelasare",
    ],
  );
});

test("bookingCategoryEntries: skips categories with zero artists (rule 12 — no page, no sitemap entry)", () => {
  const entries = bookingCategoryEntries(ORIGIN, [
    { tag: "Artist", artists: [{ slug: "a" }] },
    { tag: "Moderator", artists: [] },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].loc, "https://ninetone.com/ninetone-nation/kategori/artist");
});

// ---------------------------------------------------------------------------
// guideEntries (Section 7 — Guides route)
// ---------------------------------------------------------------------------

test("guideEntries: one entry per guide with a slug", () => {
  const entries = guideEntries(ORIGIN, [{ slug: "first-guide" }, { slug: "second-guide" }]);
  assert.deepEqual(
    entries.map((e) => e.loc),
    ["https://ninetone.com/guider/first-guide", "https://ninetone.com/guider/second-guide"],
  );
  assert.equal(entries[0].changefreq, "monthly");
});

test("guideEntries: skips a row with no usable slug", () => {
  const entries = guideEntries(ORIGIN, [{ slug: "" }, { slug: "ok" }]);
  assert.deepEqual(entries.map((e) => e.loc), ["https://ninetone.com/guider/ok"]);
});

test("guideEntries: empty input -> [] (Guider category absent, rule 12 — no page, no sitemap entry)", () => {
  assert.deepEqual(guideEntries(ORIGIN, []), []);
});

test("buildSitemapEntries: includes guide entries when guides are passed, and defaults to [] when omitted", () => {
  const withGuides = buildSitemapEntries(ORIGIN, { ...stubbedLists(), guides: [{ slug: "g1" }] });
  assert.ok(withGuides.map((e) => e.loc).includes("https://ninetone.com/guider/g1"));

  const withoutGuides = buildSitemapEntries(ORIGIN, stubbedLists());
  assert.ok(!withoutGuides.map((e) => e.loc).some((l) => l.includes("/guider/")));
});

test("routes.ts: staticRoutePaths() excludes admin/api/search-result", () => {
  const paths = staticRoutePaths();
  for (const p of paths) {
    assert.ok(!p.startsWith("/admin"), p);
    assert.ok(!p.startsWith("/api"), p);
    assert.notEqual(p, "/search-result");
  }
});

test("renderUrlsetXml: valid-looking XML, one <url> per entry, lastmod omitted when absent", () => {
  const xml = renderUrlsetXml([
    { loc: "https://ninetone.com/records" },
    { loc: "https://ninetone.com/news/post-a", lastmod: "2026-01-05" },
  ]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.equal((xml.match(/<url>/g) ?? []).length, 2);
  assert.ok(xml.includes("<loc>https://ninetone.com/records</loc>"));
  assert.ok(!xml.includes("https://ninetone.com/records</loc><lastmod>"));
  assert.ok(xml.includes("<lastmod>2026-01-05</lastmod>"));
});

test("renderUrlsetXml: escapes XML-special characters in <loc>", () => {
  const xml = renderUrlsetXml([{ loc: "https://ninetone.com/news/a&b" }]);
  assert.ok(xml.includes("a&amp;b"));
  assert.ok(!xml.includes("a&b<"));
});

test("renderSitemapIndexXml: one <sitemap> entry per URL given", () => {
  const xml = renderSitemapIndexXml(["https://ninetone.com/sitemap-pages.xml"]);
  assert.match(xml, /<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.equal((xml.match(/<sitemap>/g) ?? []).length, 1);
  assert.ok(xml.includes("<loc>https://ninetone.com/sitemap-pages.xml</loc>"));
});

// ---------------------------------------------------------------------------
// localizeSitemapEntries / buildLocalizedSitemapEntries (Section 5 —
// i18n Phase 2: "both locales for every URL, with xhtml:link alternates")
// ---------------------------------------------------------------------------

test("localizeSitemapEntries: includeEnglish=true emits one sv entry + one en entry per input, each carrying the full alternate set", () => {
  const entries = localizeSitemapEntries(ORIGIN, [{ loc: `${ORIGIN}/records`, changefreq: "weekly" }], true);
  assert.equal(entries.length, 2);

  const sv = entries.find((e) => e.loc === "https://ninetone.com/records");
  const en = entries.find((e) => e.loc === "https://ninetone.com/en/records");
  assert.ok(sv, "expected a Swedish (bare-path) entry");
  assert.ok(en, "expected an English (/en-prefixed) entry");

  for (const e of [sv, en]) {
    assert.equal(e.alternates?.length, 3);
    assert.deepEqual(
      e.alternates.map((a) => a.hreflang).sort(),
      ["en", "sv", "x-default"],
    );
    const byLang = Object.fromEntries(e.alternates.map((a) => [a.hreflang, a.href]));
    assert.equal(byLang.sv, "https://ninetone.com/records");
    assert.equal(byLang.en, "https://ninetone.com/en/records");
    // x-default = Swedish (decision 1).
    assert.equal(byLang["x-default"], byLang.sv);
  }
});

test("localizeSitemapEntries: root path localizes to bare /en, not /en/ (localizedPath's own contract)", () => {
  const entries = localizeSitemapEntries(ORIGIN, [{ loc: `${ORIGIN}/` }], true);
  const en = entries.find((e) => e.loc.includes("/en"));
  assert.equal(en.loc, "https://ninetone.com/en");
});

test("localizeSitemapEntries: includeEnglish=false lists sv-only <url> entries but every entry still carries the full sv/en/x-default alternate set", () => {
  const entries = localizeSitemapEntries(ORIGIN, [{ loc: `${ORIGIN}/records` }, { loc: `${ORIGIN}/team` }], false);
  assert.equal(entries.length, 2, "no /en/ <url> entries listed on the gh/static target");
  assert.ok(entries.every((e) => e.loc.startsWith(ORIGIN) && !e.loc.includes("/en/") && e.loc !== `${ORIGIN}/en`));
  for (const e of entries) {
    assert.equal(e.alternates?.length, 3);
    assert.ok(e.alternates.some((a) => a.hreflang === "en"));
  }
});

test("localizeSitemapEntries: preserves changefreq/lastmod on both locale entries", () => {
  const entries = localizeSitemapEntries(
    ORIGIN,
    [{ loc: `${ORIGIN}/news/post-a`, changefreq: "monthly", lastmod: "2026-01-05" }],
    true,
  );
  assert.equal(entries.length, 2);
  for (const e of entries) {
    assert.equal(e.changefreq, "monthly");
    assert.equal(e.lastmod, "2026-01-05");
  }
});

test("buildLocalizedSitemapEntries: doubles every entry that HAS an English version, and only those", () => {
  // Previously this asserted a flat 2x. That was the defect the SEO audit
  // found: Swedish-only routes (/integritet, /guider/*) were doubled too, so
  // the sitemap advertised /en/integritet as an English alternate of a page
  // that returns Swedish HTML canonicalizing to /integritet.
  const localeFree = buildSitemapEntries(ORIGIN, stubbedLists());
  const localized = buildLocalizedSitemapEntries(ORIGIN, stubbedLists(), true);

  const svOnly = localeFree.filter((e) => {
    const path = e.loc.slice(ORIGIN.length) || "/";
    return path === "/integritet" || path === "/guider" || path.startsWith("/guider/");
  }).length;

  assert.equal(localized.length, (localeFree.length - svOnly) * 2 + svOnly);
  assert.ok(svOnly > 0, "the stub list must contain a Swedish-only route or this asserts nothing");
});

test("buildLocalizedSitemapEntries: no /en/ loc or English alternate for a Swedish-only route", () => {
  const localized = localizeSitemapEntries(ORIGIN, [{ loc: `${ORIGIN}/integritet` }], true);

  assert.equal(localized.length, 1, "a Swedish-only route gets exactly one entry");
  assert.equal(localized[0].loc, `${ORIGIN}/integritet`);
  assert.deepEqual(
    localized[0].alternates.map((a) => a.hreflang).sort(),
    ["sv", "x-default"],
    "it must not claim an English alternate",
  );
});

test("buildLocalizedSitemapEntries: a normal route still gets both locales and the full alternate set", () => {
  const localized = localizeSitemapEntries(ORIGIN, [{ loc: `${ORIGIN}/records` }], true);

  assert.deepEqual(localized.map((e) => e.loc), [`${ORIGIN}/records`, `${ORIGIN}/en/records`]);
  for (const entry of localized) {
    assert.deepEqual(entry.alternates.map((a) => a.hreflang).sort(), ["en", "sv", "x-default"]);
  }
});

test("buildLocalizedSitemapEntries: includeEnglish=false keeps the same entry count as the locale-free list", () => {
  const localeFree = buildSitemapEntries(ORIGIN, stubbedLists());
  const localized = buildLocalizedSitemapEntries(ORIGIN, stubbedLists(), false);
  assert.equal(localized.length, localeFree.length);
});

// ---------------------------------------------------------------------------
// renderUrlsetXml — xhtml namespace + <xhtml:link> alternates
// ---------------------------------------------------------------------------

test("renderUrlsetXml: emits xmlns:xhtml on <urlset> when any entry carries alternates", () => {
  const entries = localizeSitemapEntries(ORIGIN, [{ loc: `${ORIGIN}/records` }], true);
  const xml = renderUrlsetXml(entries);
  assert.match(xml, /<urlset[^>]*\sxmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"[^>]*>/);
  // Namespace declared exactly once, on the root element — not repeated per <url>.
  assert.equal((xml.match(/xmlns:xhtml=/g) ?? []).length, 1);
});

test("renderUrlsetXml: does NOT emit xmlns:xhtml when no entry has alternates (unchanged Phase-1 shape)", () => {
  const xml = renderUrlsetXml([{ loc: `${ORIGIN}/records` }]);
  assert.ok(!xml.includes("xmlns:xhtml"));
  assert.ok(!xml.includes("xhtml:link"));
});

test("renderUrlsetXml: emits one <xhtml:link rel=\"alternate\"> per alternate, hreflang sv/en/x-default all present", () => {
  const entries = localizeSitemapEntries(ORIGIN, [{ loc: `${ORIGIN}/records` }], true);
  const svEntryXml = renderUrlsetXml([entries.find((e) => e.loc === "https://ninetone.com/records")]);
  assert.equal((svEntryXml.match(/<xhtml:link rel="alternate"/g) ?? []).length, 3);
  assert.ok(svEntryXml.includes('hreflang="sv" href="https://ninetone.com/records"'));
  assert.ok(svEntryXml.includes('hreflang="en" href="https://ninetone.com/en/records"'));
  assert.ok(svEntryXml.includes('hreflang="x-default" href="https://ninetone.com/records"'));
});

test("renderUrlsetXml: x-default alternate always equals the Swedish href, on both the sv and en <url> entries (decision 1)", () => {
  const entries = localizeSitemapEntries(ORIGIN, [{ loc: `${ORIGIN}/records` }], true);
  const xml = renderUrlsetXml(entries);
  // Both <url> blocks in this document should carry an x-default alternate
  // pointing at the bare (Swedish) URL, never the /en/ one.
  const xDefaultHrefs = [...xml.matchAll(/hreflang="x-default" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(xDefaultHrefs.length, 2);
  assert.ok(xDefaultHrefs.every((h) => h === "https://ninetone.com/records"));
});

test("renderUrlsetXml: escapes XML-special characters inside xhtml:link href too", () => {
  const entries = localizeSitemapEntries(ORIGIN, [{ loc: `${ORIGIN}/news/a&b` }], true);
  const xml = renderUrlsetXml(entries);
  assert.ok(xml.includes("a&amp;b"));
  assert.ok(!/href="[^"]*a&b[^"]*"/.test(xml));
});

test("full pipeline: buildLocalizedSitemapEntries + renderUrlsetXml produces a valid-looking document with /en/ <url> entries and namespace present", () => {
  const entries = buildLocalizedSitemapEntries(ORIGIN, stubbedLists(), true);
  const xml = renderUrlsetXml(entries);
  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.ok(xml.includes("<loc>https://ninetone.com/en/records/artists/artist-a</loc>"));
  assert.ok(xml.includes("<loc>https://ninetone.com/records/artists/artist-a</loc>"));
  assert.ok(xml.includes('hreflang="x-default"'));
});
