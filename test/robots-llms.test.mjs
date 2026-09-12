import assert from "node:assert/strict";
import test from "node:test";

import { buildRobotsTxt } from "../src/pages/robots.txt.ts";
import {
  buildLlmsTxt,
  bookingTalentLines,
  bookingCategoryLines,
  guideLines,
  LLMS_CHROME_STRINGS,
  LLMS_CHROME_SV,
  llmsLinkOrigin,
} from "../src/lib/llms.ts";
import { handleEnLlmsTxt } from "../src/pages/en/llms.txt.ts";

const ORIGIN = "https://ninetone.com";

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

test("robots.txt: PUBLIC_NOINDEX flag on (default/preview) -> disallow-all, no Sitemap/Content-Signal", () => {
  const body = buildRobotsTxt(ORIGIN, true);
  assert.equal(body, "User-agent: *\nDisallow: /\n");
  assert.ok(!body.includes("Sitemap"));
  assert.ok(!body.includes("Content-Signal"));
});

test("robots.txt: PUBLIC_NOINDEX=false -> Variant A, allow-all with Sitemap + Content-Signal", () => {
  const body = buildRobotsTxt(ORIGIN, false);
  assert.match(body, /^User-agent: \*\nAllow: \/\n/);
  assert.ok(body.includes(`Sitemap: ${ORIGIN}/sitemap-index.xml`));
  assert.ok(body.includes("Content-Signal: ai-train=yes, search=yes, ai-input=yes"));
  assert.ok(!body.includes("Disallow"));
});

test("robots.txt: Variant A sitemap line uses the passed-in origin, never hardcoded", () => {
  const body = buildRobotsTxt("https://staging.example.workers.dev", false);
  assert.ok(body.includes("Sitemap: https://staging.example.workers.dev/sitemap-index.xml"));
  assert.ok(!body.includes("ninetone.com"));
});

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

function stubData(overrides = {}) {
  return {
    artists: [],
    previousArtists: [],
    clients: [],
    team: [],
    news: [],
    bookingLines: [],
    ...overrides,
  };
}

test("llms.txt: always includes the four static sections and intro blurb", () => {
  const body = buildLlmsTxt(ORIGIN, stubData());
  assert.ok(body.startsWith("# Ninetone Group"));
  assert.ok(body.includes("## Ninetone Records"));
  assert.ok(body.includes("## Ninetone Management"));
  assert.ok(body.includes("## Ninetone Nation"));
  assert.ok(body.includes("## Company"));
  assert.ok(body.includes(`(${ORIGIN}/records/artists)`));
  assert.ok(body.includes(`(${ORIGIN}/management/clients)`));
  assert.ok(body.includes(`(${ORIGIN}/ninetone-nation/booking)`));
  assert.ok(body.includes(`(${ORIGIN}/team)`));
  assert.ok(body.includes(`(${ORIGIN}/news)`));
  assert.ok(body.includes(`(${ORIGIN}/integritet)`));
});

test("llms.txt: 'Previous artists' links to the bare /records/artists/previous, not the brief skeleton's /previous/1 (which 404s)", () => {
  const body = buildLlmsTxt(ORIGIN, stubData());
  assert.ok(body.includes(`[Previous artists](${ORIGIN}/records/artists/previous)`));
  assert.ok(!body.includes(`${ORIGIN}/records/artists/previous/1)`));
});

test("llms.txt: expands an active artist into one factual line with genre + tagline + absolute URL", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({
      artists: [
        {
          SLUG: "anjo",
          "Head Artist": "Anjo",
          genre: "Pop\nDance",
          "Artist Presentation Title": "Chart-topping pop from the north.",
        },
      ],
    }),
  );
  assert.ok(body.includes(`[Anjo](${ORIGIN}/records/artists/anjo): Pop — Chart-topping pop from the north.`));
});

test("llms.txt: skips artist rows missing SLUG or name", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({
      artists: [
        { SLUG: "", "Head Artist": "No Slug" },
        { SLUG: "no-name", "Head Artist": "" },
      ],
    }),
  );
  assert.ok(!body.includes("No Slug"));
  assert.ok(!body.includes("no-name"));
});

test("llms.txt: previous artists use the real previous/single/{slug} route, not the brief skeleton's shorter path", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({
      previousArtists: [{ SLUG: "old-act", "Head Artist": "Old Act", genre: "Rock" }],
    }),
  );
  assert.ok(body.includes(`[Old Act](${ORIGIN}/records/artists/previous/single/old-act): Rock — previous artist`));
});

test("llms.txt: expands a management client with category and tagline", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({
      clients: [
        {
          SLUG: "client-a",
          "Head Artist": "Client A",
          tags: "Influencer",
          clientPresentationTitle: "Creator and brand partner.",
        },
      ],
    }),
  );
  assert.ok(
    body.includes(`[Client A](${ORIGIN}/management/clients/client-a): Influencer — Creator and brand partner.`),
  );
});

test("llms.txt: expands team members with title", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({ team: [{ SLUG: "pat", userNameCalc: "Pat Person", title: "CEO" }] }),
  );
  assert.ok(body.includes(`[Pat Person](${ORIGIN}/team/pat): CEO`));
});

test("llms.txt: expands news posts with date", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({ news: [{ slug: "big-news", Title: "Big news", Date: "01/15/2026" }] }),
  );
  assert.ok(body.includes(`[Big news](${ORIGIN}/news/big-news): 01/15/2026`));
});

test("llms.txt: booking talent lines (pre-expanded by bookingTalentLines) are inserted as-is", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({ bookingLines: [`- [Someone](${ORIGIN}/ninetone-nation/someone): Artist — On tour now.`] }),
  );
  assert.ok(body.includes(`[Someone](${ORIGIN}/ninetone-nation/someone): Artist — On tour now.`));
});

test("llms.txt: markdown in taglines is stripped to plain text, not raw markdown", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({
      artists: [
        {
          SLUG: "md-artist",
          "Head Artist": "MD Artist",
          "Artist Presentation Title": "**Bold** claim about _sound_.",
        },
      ],
    }),
  );
  assert.ok(!body.includes("**Bold**"));
  assert.ok(!body.includes("_sound_"));
  assert.ok(body.includes("Bold"));
});

test("llms.txt: every generated URL is absolute under the given origin", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({
      artists: [{ SLUG: "a1", "Head Artist": "A1" }],
      clients: [{ SLUG: "c1", "Head Artist": "C1" }],
      team: [{ SLUG: "t1", userNameCalc: "T1" }],
      news: [{ slug: "n1", Title: "N1" }],
    }),
  );
  const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.ok(link.startsWith(ORIGIN), `expected absolute URL under origin, got: ${link}`);
  }
});

test("llms.txt: uses the passed-in origin, never a hardcoded domain", () => {
  const other = "https://ninetone-site.micke-ohlen.workers.dev";
  const body = buildLlmsTxt(other, stubData({ artists: [{ SLUG: "a1", "Head Artist": "A1" }] }));
  assert.ok(body.includes(`(${other}/records/artists/a1)`));
  assert.ok(!body.includes("ninetone.com"));
});

// ---------------------------------------------------------------------------
// bookingTalentLines
// ---------------------------------------------------------------------------

test("bookingTalentLines: one line per talent, tagged with its category", () => {
  const categories = [
    { tag: "Artist", artists: [{ slug: "a1", name: "Someone", tagline: "On tour now." }] },
    { tag: "Föreläsare", artists: [{ slug: "s1", name: "Speaker One", tagline: "" }] },
  ];
  const lines = bookingTalentLines(categories, ORIGIN);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes(`[Someone](${ORIGIN}/ninetone-nation/a1): Artist — On tour now.`));
  assert.ok(lines[1].includes(`[Speaker One](${ORIGIN}/ninetone-nation/s1): Föreläsare`));
});

test("bookingTalentLines: dedupes a talent booked under more than one category, keeping the first", () => {
  const categories = [
    { tag: "Artist", artists: [{ slug: "dual", name: "Dual Act", tagline: "" }] },
    { tag: "Konferencier", artists: [{ slug: "dual", name: "Dual Act", tagline: "" }] },
  ];
  const lines = bookingTalentLines(categories, ORIGIN);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("Artist"));
  assert.ok(!lines[0].includes("Konferencier"));
});

test("bookingTalentLines: skips rows missing slug or name", () => {
  const categories = [
    { tag: "Artist", artists: [{ slug: "", name: "No Slug", tagline: "" }, { slug: "no-name", name: "", tagline: "" }] },
  ];
  const lines = bookingTalentLines(categories, ORIGIN);
  assert.equal(lines.length, 0);
});

// ---------------------------------------------------------------------------
// bookingCategoryLines (Section 6 — Nation category pages)
// ---------------------------------------------------------------------------

test("bookingCategoryLines: one line per category with at least one artist, slugified per booking-slug.ts", () => {
  const categories = [
    { tag: "Artist", artists: [{ slug: "a1" }, { slug: "a2" }] },
    { tag: "Föreläsare", artists: [{ slug: "s1" }] },
  ];
  const lines = bookingCategoryLines(categories, ORIGIN);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes(`[Artist](${ORIGIN}/ninetone-nation/kategori/artist): 2 bookable`));
  assert.ok(lines[1].includes(`[Föreläsare](${ORIGIN}/ninetone-nation/kategori/forelasare): 1 bookable`));
});

test("bookingCategoryLines: skips categories with zero artists (rule 12 — the page doesn't exist, so neither does the line)", () => {
  const categories = [
    { tag: "Artist", artists: [{ slug: "a1" }] },
    { tag: "Moderator", artists: [] },
  ];
  const lines = bookingCategoryLines(categories, ORIGIN);
  assert.equal(lines.length, 1);
  assert.ok(!lines.some((l) => l.includes("Moderator")));
});

test("bookingCategoryLines: includes the category description when present", () => {
  const categories = [{ tag: "Artist", description: "Live music acts.", artists: [{ slug: "a1" }] }];
  const lines = bookingCategoryLines(categories, ORIGIN);
  assert.ok(lines[0].includes("Live music acts."));
});

test("llms.txt: booking category lines (Section 6) appear under ## Ninetone Nation, ahead of individual talent lines", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({
      bookingCategoryLines: [`- [Artist](${ORIGIN}/ninetone-nation/kategori/artist): 8 bookable`],
      bookingLines: [`- [Someone](${ORIGIN}/ninetone-nation/someone): Artist — On tour now.`],
    }),
  );
  const nationSection = body.split("## Ninetone Nation")[1].split("## Company")[0];
  const categoryIdx = nationSection.indexOf("kategori/artist");
  const talentIdx = nationSection.indexOf("ninetone-nation/someone");
  assert.ok(categoryIdx > -1 && talentIdx > -1);
  assert.ok(categoryIdx < talentIdx);
});

// ---------------------------------------------------------------------------
// guideLines (Section 7 — Guides route)
// ---------------------------------------------------------------------------

test("guideLines: one line per guide with slug + title, tagline stripped to plain text", () => {
  const lines = guideLines(
    [{ slug: "hur-man-bokar", title: "Hur man bokar", message: "**Snabb** guide till bokning." }],
    ORIGIN,
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`[Hur man bokar](${ORIGIN}/guider/hur-man-bokar)`));
  assert.ok(lines[0].includes("Snabb guide till bokning."));
  assert.ok(!lines[0].includes("**"));
});

test("guideLines: skips a guide missing slug or title", () => {
  const lines = guideLines(
    [
      { slug: "", title: "No slug" },
      { slug: "no-title", title: "" },
    ],
    ORIGIN,
  );
  assert.equal(lines.length, 0);
});

test("guideLines: empty input -> [] (Guider category absent, rule 12 — no page, no llms.txt line)", () => {
  assert.deepEqual(guideLines([], ORIGIN), []);
});

test("llms.txt: Guider link and guide lines (Section 7) appear under ## Company, after News", () => {
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({
      guideLines: [`- [Hur man bokar](${ORIGIN}/guider/hur-man-bokar): En kort guide.`],
    }),
  );
  assert.ok(body.includes(`[Guider](${ORIGIN}/guider)`));
  const companySection = body.split("## Company")[1];
  const newsIdx = companySection.indexOf(`(${ORIGIN}/news)`);
  const guiderIdx = companySection.indexOf(`(${ORIGIN}/guider)`);
  const guideLineIdx = companySection.indexOf("hur-man-bokar");
  assert.ok(newsIdx > -1 && guiderIdx > -1 && guideLineIdx > -1);
  assert.ok(newsIdx < guiderIdx);
  assert.ok(guiderIdx < guideLineIdx);
});

test("llms.txt: with no guideLines passed, the Guider link still appears but no guide entity lines do", () => {
  const body = buildLlmsTxt(ORIGIN, stubData());
  assert.ok(body.includes(`[Guider](${ORIGIN}/guider)`));
});

// ---------------------------------------------------------------------------
// llms.txt — Section 5 (i18n Phase 2): chrome translation table
// ---------------------------------------------------------------------------

test("buildLlmsTxt: with no chrome table (Swedish/default), renders the literal source strings unchanged", () => {
  const body = buildLlmsTxt(ORIGIN, stubData());
  assert.ok(body.startsWith("# Ninetone Group"));
  assert.ok(body.includes("## Ninetone Records"));
  assert.ok(body.includes(`[Artists](${ORIGIN}/records/artists): current roster`));
  assert.ok(body.includes(`[Team](${ORIGIN}/team)`));
});

test("buildLlmsTxt: chrome table entries replace the matching static strings, headings included", () => {
  const chrome = {
    "# Ninetone Group": "# Ninetone Group (EN)",
    "## Ninetone Records": "## Ninetone Records (EN)",
    Artists: "Artists (EN)",
    "current roster": "current roster (EN)",
    Team: "Team (EN)",
  };
  const body = buildLlmsTxt(ORIGIN, stubData(), { chrome });
  assert.ok(body.startsWith("# Ninetone Group (EN)"));
  assert.ok(body.includes("## Ninetone Records (EN)"));
  assert.ok(body.includes(`[Artists (EN)](${ORIGIN}/records/artists): current roster (EN)`));
  assert.ok(body.includes(`[Team (EN)](${ORIGIN}/team)`));
});

test("buildLlmsTxt: a chrome table missing some keys falls back to source for those, never blanks or throws", () => {
  const body = buildLlmsTxt(ORIGIN, stubData(), { chrome: { Team: "Team (EN)" } });
  assert.ok(body.includes(`[Team (EN)](${ORIGIN}/team)`)); // translated
  assert.ok(body.includes(`[News](${ORIGIN}/news)`)); // untranslated key -> source, not blank
  assert.ok(body.startsWith("# Ninetone Group")); // untranslated heading -> source
});

test("buildLlmsTxt: chrome table NEVER touches entity content — artist/client/team/news names and taglines render in source language regardless of chrome", () => {
  const chrome = { Artists: "Artists (EN)", Team: "Team (EN)" };
  const body = buildLlmsTxt(
    ORIGIN,
    stubData({
      artists: [{ SLUG: "anjo", "Head Artist": "Anjo", genre: "Pop", "Artist Presentation Title": "Svensk pop." }],
      team: [{ SLUG: "pat", userNameCalc: "Pat Person", title: "VD" }],
    }),
    { chrome },
  );
  // Entity content unchanged — no translation applied to FM-sourced text.
  assert.ok(body.includes("Anjo"));
  assert.ok(body.includes("Pop — Svensk pop."));
  assert.ok(body.includes("Pat Person"));
  assert.ok(body.includes("VD"));
  // Only the chrome labels around them changed.
  assert.ok(body.includes("Artists (EN)"));
  assert.ok(body.includes("Team (EN)"));
});

test("LLMS_CHROME_STRINGS: every literal in the list actually appears in a Swedish/default render (no stale entries)", () => {
  const body = buildLlmsTxt(ORIGIN, stubData());
  for (const source of LLMS_CHROME_STRINGS) {
    assert.ok(body.includes(source), `chrome string not found in default render: ${JSON.stringify(source)}`);
  }
});

test("LLMS_CHROME_STRINGS: a full chrome table built from this list translates every static label in the document", () => {
  const chrome = Object.fromEntries(LLMS_CHROME_STRINGS.map((s) => [s, `${s} [EN]`]));
  const body = buildLlmsTxt(ORIGIN, stubData(), { chrome });
  for (const source of LLMS_CHROME_STRINGS) {
    assert.ok(body.includes(`${source} [EN]`), `expected translated chrome for: ${JSON.stringify(source)}`);
  }
});

// ---------------------------------------------------------------------------
// /en/llms.txt route (Section 5) — src/pages/en/llms.txt.ts
// ---------------------------------------------------------------------------

test("handleEnLlmsTxt: 404s when PUBLIC_HAS_RUNTIME is false (gh/static target — decision 2, /en/ does not exist there)", async () => {
  const res = await handleEnLlmsTxt({}, false);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "Not found");
});


// ---------------------------------------------------------------------------
// Locale (2026-09-12 SEO review): the English manifest links English pages,
// and the Swedish manifest is actually Swedish.
// ---------------------------------------------------------------------------

test("buildLlmsTxt: lang 'en' prefixes every internal link with /en", () => {
  const body = buildLlmsTxt(ORIGIN, stubData(), { lang: "en" });
  const hrefs = [...body.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 5, "sanity: links present");
  for (const href of hrefs) {
    assert.ok(href.startsWith(`${ORIGIN}/en/`), `not an English URL: ${href}`);
    assert.ok(!href.includes("/en/en/"), `double prefix: ${href}`);
  }
});

test("buildLlmsTxt: default/Swedish links carry no /en prefix", () => {
  const body = buildLlmsTxt(ORIGIN, stubData(), { lang: "sv", chrome: LLMS_CHROME_SV });
  assert.ok(!body.includes(`${ORIGIN}/en/`));
  assert.ok(body.includes(`[Artister](${ORIGIN}/records/artists)`));
  assert.ok(body.includes("## Företaget"));
  assert.ok(body.includes("Svenskt musikbolag"));
});

test("llmsLinkOrigin: only 'en' changes the origin", () => {
  assert.equal(llmsLinkOrigin(ORIGIN, "en"), `${ORIGIN}/en`);
  assert.equal(llmsLinkOrigin(ORIGIN, "sv"), ORIGIN);
  assert.equal(llmsLinkOrigin(ORIGIN, undefined), ORIGIN);
});

test("LLMS_CHROME_SV: every key is a real chrome literal, and every literal that reads as English has a Swedish entry", () => {
  for (const key of Object.keys(LLMS_CHROME_SV)) {
    assert.ok(LLMS_CHROME_STRINGS.includes(key), `unknown chrome key: ${JSON.stringify(key)}`);
  }
  // Headings that are proper names stay; the rest must be covered.
  const proper = new Set(["# Ninetone Group", "## Ninetone Records", "## Ninetone Management", "## Ninetone Nation"]);
  for (const literal of LLMS_CHROME_STRINGS) {
    if (proper.has(literal)) continue;
    assert.ok(literal in LLMS_CHROME_SV, `no Swedish for: ${JSON.stringify(literal)}`);
  }
});
