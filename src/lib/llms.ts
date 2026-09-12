/**
 * Pure llms.txt body builder. No I/O, no Astro globals — the endpoint
 * (src/pages/llms.txt.ts) fetches the FM list data that's already fetched
 * elsewhere (same helpers the sitemap and index pages use,
 * src/lib/ninetone.ts) and passes it in as plain arrays. Kept separate and
 * pure, mirroring src/lib/sitemap.ts's split, so it's unit-testable without a
 * build (test/robots-llms.test.mjs).
 *
 * This module only `import type`s from src/lib/ninetone.ts (erased at
 * runtime, so it never pulls in that file's FileMaker import chain). It does
 * take one real value import, markdownToPlainText from ./schema.ts, which in
 * turn imports renderBio (marked) — that chain is lightweight and has no FM
 * dependency, so it doesn't reintroduce the problem the type-only import
 * from ninetone.ts avoids; it's just not accurate to describe the whole file
 * as type-only, so noting it here explicitly.
 *
 * Content per docs/seo-strategy-2026-09.md Appendix B ("llms.txt skeleton"):
 * static section links plus one factual line per FM entity (name,
 * category/genre if present, tagline as plain text, absolute URL) — never
 * marketing copy, since this file is parsed rather than read.
 *
 * SECTION 5 (i18n Phase 2, docs/i18n-phase-2-brief.md) — ENGLISH CONTENT
 * STRATEGY, chosen and explained here because this is where it's
 * implemented:
 *
 * llms.txt lists EVERY FM entity — as of writing, ~300+ lines (every active
 * artist, previous artist, client, team member, news post, booking talent,
 * category, and guide). That is far beyond the per-request translation
 * budget (25 uncached calls — src/lib/translate.ts's RequestBudget), and
 * this endpoint has no per-visitor render to amortize the cost across the
 * way a page does: it's one flat text file, requested cold as often as
 * warm, with no component tree to spread a shared budget over.
 *
 * The choice made here: the small, fixed set of CHROME strings (section
 * headings, the four static nav-link labels' fixed suffixes, the intro
 * blurb — roughly 20 literal strings total, enumerated in
 * `LLMS_CHROME_STRINGS` below) are looked up in an optional `chrome` table
 * the caller supplies; ENTITY content (every artist/client/team/news/
 * booking/guide line — names, genres, taglines, the "previous artist" /
 * "N bookable" fragments baked into their lines) is ALWAYS rendered in
 * whatever language it already exists in, in FM or in the line-builder
 * functions below (artistLine, previousArtistLine, etc.) — never live-
 * translated here.
 *
 * Why not translate entity content too, given src/lib/translate.ts's
 * `translate()` is itself cache-first and never blocks (decision 6)? A
 * cache HIT is free either way — cheap and correct to use if the warm
 * script (decision 9) has already populated KV for a string. The problem is
 * the miss path: `translate()` on a miss with no `waitUntil` scheduler
 * simply returns source text and schedules nothing (by design — see
 * translate.ts's own doc comment on why an unscheduled miss must not await
 * inline), which is exactly the degrade path decision 6 describes. But
 * calling it WITH a scheduler for 300+ entity lines on every cold request
 * would fire 300+ concurrent Anthropic calls via `waitUntil` on a single
 * request with no budget gate appropriate to that volume (the 25-call
 * budget exists for a page's chrome, not a 300-line manifest) — "silently
 * blow the budget," precisely what the brief warns against. So entity
 * content takes the passive, read-only half of decision 6's degrade path:
 * translated once it's warm (via the warm script bulk-loading KV directly,
 * decision 9 — not via a live call from this endpoint), source-language
 * otherwise, and this endpoint never itself schedules a single entity
 * translation. This IS "serve whatever is already in the KV cache and
 * untranslated otherwise" — the brief's own suggested fallback.
 *
 * Chrome, by contrast, is a small fixed vocabulary (~20 strings) reused on
 * every request, so warming it is genuinely cheap (note C in the brief:
 * "translating all ~125 chrome strings costs about $0.08 once,
 * permanently") and worth doing live if the caller has a resolved `t()` at
 * hand — hence taking it as a plain lookup table rather than reaching for
 * translate.ts itself, keeping this module pure (no I/O, no Astro globals,
 * same contract as before).
 */

import type { Artist, TeamMember, WebPost } from "./ninetone.ts";
import { markdownToPlainText } from "./schema.ts";
import { slugifyTag } from "./booking-slug.ts";

/** One factual line: "- [Name](url): detail". */
function entityLine(name: string, path: string, origin: string, detail?: string): string {
  const href = `${origin}${path.startsWith("/") ? path : `/${path}`}`;
  const suffix = detail ? `: ${detail}` : "";
  return `- [${name}](${href})${suffix}`;
}

/** Join non-empty fragments (genre, category, tagline) with an em dash —
 *  the "one factual line per entity" shape the brief calls for. */
function factualDetail(parts: Array<string | undefined | null>): string | undefined {
  const clean = parts.map((p) => (p ? p.trim() : "")).filter(Boolean);
  return clean.length > 0 ? clean.join(" — ") : undefined;
}

function splitGenre(v: unknown): string | undefined {
  if (!v) return undefined;
  const first = String(v).split(/\r|\n|,/).map((s) => s.trim()).filter(Boolean)[0];
  return first || undefined;
}

export function artistLine(a: Artist, origin: string): string | null {
  const slug = String(a.SLUG ?? "");
  const name = String(a["Head Artist"] ?? "");
  if (!slug || !name) return null;
  const genre = splitGenre(a.genre);
  const tagline = markdownToPlainText(String(a["Artist Presentation Title"] ?? ""), 140);
  return entityLine(name, `/records/artists/${slug}`, origin, factualDetail([genre, tagline || undefined]));
}

export function previousArtistLine(a: Artist, origin: string): string | null {
  const slug = String(a.SLUG ?? "");
  const name = String(a["Head Artist"] ?? "");
  if (!slug || !name) return null;
  const genre = splitGenre(a.genre);
  // Real route is /records/artists/previous/single/{slug} (verified against
  // src/pages/records/artists/previous/single/[slug].astro and the existing
  // search-index.json.ts generator, and matching src/lib/sitemap.ts's own
  // detailPageEntries prefix for previous artists) — the brief's Appendix B
  // skeleton shows a shorter "/records/artists/previous/{slug}" shape, which
  // does not match an actual route in this repo. Using the real, reachable
  // URL rather than the skeleton's literal text.
  return entityLine(
    name,
    `/records/artists/previous/single/${slug}`,
    origin,
    factualDetail([genre, "previous artist"]),
  );
}

export function clientLine(c: Artist, origin: string): string | null {
  const slug = String(c.SLUG ?? "");
  const name = String(c["Head Artist"] ?? "");
  if (!slug || !name) return null;
  const category = splitGenre(c.tags ?? c.genre);
  const tagline = markdownToPlainText(String(c.clientPresentationTitle ?? ""), 140);
  return entityLine(name, `/management/clients/${slug}`, origin, factualDetail([category, tagline || undefined]));
}

export function teamLine(m: TeamMember, origin: string): string | null {
  const slug = String(m.SLUG ?? "");
  const name = String(m.userNameCalc ?? "");
  if (!slug || !name) return null;
  const title = String(m.title ?? "").trim();
  return entityLine(name, `/team/${slug}`, origin, factualDetail([title || undefined]));
}

export function newsLine(p: WebPost, origin: string): string | null {
  const slug = String(p.SLUG ?? p.slug ?? "");
  const title = String(p.Title ?? p.title ?? "");
  if (!slug || !title) return null;
  const date = String(p.Date ?? "").trim();
  return entityLine(title, `/news/${slug}`, origin, factualDetail([date || undefined]));
}

/** One line per active Nation booking talent, deduped across categories
 *  (an artist bookable in more than one category gets one line, tagged with
 *  the first category encountered). Takes already-fetched category data
 *  (src/lib/ninetone.ts's getBookingCategories() shape) — no FM read here. */
export function bookingTalentLines(
  categories: Array<{ tag: string; artists: Array<{ slug: string; name: string; tagline: string }> }>,
  origin: string,
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const cat of categories) {
    for (const a of cat.artists) {
      if (!a.slug || !a.name || seen.has(a.slug)) continue;
      seen.add(a.slug);
      const tagline = markdownToPlainText(a.tagline, 140);
      lines.push(
        entityLine(a.name, `/ninetone-nation/${a.slug}`, origin, factualDetail([cat.tag, tagline || undefined])),
      );
    }
  }
  return lines;
}

/**
 * One line per Nation booking category that has at least one active talent
 * (Section 6 — src/pages/ninetone-nation/kategori/[category].astro). Same
 * "at least one artist" filter and slugifyTag() that page's getStaticPaths()
 * uses, so a category never appears here unless its page actually exists
 * (rule 12 — empty categories are not generated, so no llms.txt line either).
 */
export function bookingCategoryLines(
  categories: Array<{ tag: string; description?: string; artists: Array<unknown> }>,
  origin: string,
): string[] {
  return categories
    .filter((c) => c.artists.length > 0)
    .map((c) =>
      entityLine(
        c.tag,
        `/ninetone-nation/kategori/${slugifyTag(c.tag)}`,
        origin,
        factualDetail([`${c.artists.length} bookable`, c.description || undefined]),
      ),
    );
}

export interface LlmsTxtData {
  artists: Artist[];
  previousArtists: Artist[];
  clients: Artist[];
  team: TeamMember[];
  news: WebPost[];
  /** Pre-expanded ("- [Name](url): detail") lines — see bookingTalentLines(). */
  bookingLines: string[];
  /** Pre-expanded category-page lines — see bookingCategoryLines(). */
  bookingCategoryLines?: string[];
  /** Pre-expanded guide lines (Section 7) — see guideLines() below. */
  guideLines?: string[];
}

/**
 * The fixed, small chrome vocabulary `buildLlmsTxt` renders — see this
 * module's doc comment ("ENGLISH CONTENT STRATEGY") for why only THESE
 * strings are ever live-translated, never entity content. Every string
 * here is a literal that appears verbatim in `buildLlmsTxt` below; keeping
 * them declared once, in one array, means a caller building the `chrome`
 * table (src/pages/llms.txt.ts, or its /en/ counterpart) can iterate this
 * list rather than hand-copy the literals a second time somewhere else —
 * and a future edit to a heading in `buildLlmsTxt` that forgets to update
 * this list is a `chromeText()` fallback-to-source, not a crash.
 */
export const LLMS_CHROME_STRINGS: readonly string[] = [
  "# Ninetone Group",
  "> Swedish music company based in Sundsvall and Stockholm. Three divisions:\n" +
    "> Ninetone Records (label), Ninetone Management (artist and creator\n" +
    "> management), Ninetone Nation (booking for events).",
  "## Ninetone Records",
  "Artists",
  "current roster",
  "Previous artists",
  "Contact Records",
  "demo submissions",
  "## Ninetone Management",
  "Clients",
  "managed artists and creators",
  "Contact Management",
  "## Ninetone Nation",
  "Booking",
  "bookable talent by category",
  "Contact Nation",
  "## Company",
  "Team",
  "News",
  "Guider",
  "Privacy",
];

/** A resolved-translation lookup for `LLMS_CHROME_STRINGS`, keyed by the
 *  exact source (Swedish) string — e.g. `{ "Team": "Team", "News": "News",
 *  "Artists": "Artists", ... }` for English. Absent entries fall back to
 *  the source string (see `chromeText()`), never to a blank or a crash —
 *  same "never block, degrade to source" posture as translate.ts itself. */
export type LlmsChromeTable = Record<string, string>;

export interface BuildLlmsTxtOptions {
  /** See `LlmsChromeTable`. Omit entirely for source-language (Swedish)
   *  output — every `chromeText()` call then simply returns its input. */
  chrome?: LlmsChromeTable;
  /**
   * Locale the LINKS should point at. "en" prefixes every internal href
   * with /en so an agent reading the English manifest lands on English
   * pages (2026-09-12 SEO review: /en/llms.txt linked only Swedish URLs).
   * Entity lines built OUTSIDE this function (booking, guides) must be
   * built with `llmsLinkOrigin(origin, lang)` for the same reason.
   */
  lang?: "sv" | "en";
}

/** Origin to build entity links against for a given manifest locale. */
export function llmsLinkOrigin(origin: string, lang: "sv" | "en" | undefined): string {
  return lang === "en" ? `${origin}/en` : origin;
}

/**
 * Swedish chrome for the Swedish manifest. The literals in
 * `LLMS_CHROME_STRINGS` are English, so the Swedish render used to emit
 * "## Company" and "Previous artists" while the English one was a
 * byte-identical copy — a static table beats a live `t()` round trip here:
 * twenty fixed labels, deterministic, no KV, no model.
 */
export const LLMS_CHROME_SV: LlmsChromeTable = {
  ["> Swedish music company based in Sundsvall and Stockholm. Three divisions:\n" +
    "> Ninetone Records (label), Ninetone Management (artist and creator\n" +
    "> management), Ninetone Nation (booking for events)."]:
    "> Svenskt musikbolag med bas i Sundsvall och Stockholm. Tre divisioner:\n" +
    "> Ninetone Records (skivbolag), Ninetone Management (artist- och\n" +
    "> kreatörsmanagement), Ninetone Nation (bokning för evenemang).",
  Artists: "Artister",
  "current roster": "aktuell roster",
  "Previous artists": "Tidigare artister",
  "Contact Records": "Kontakta Records",
  "demo submissions": "demoinskick",
  Clients: "Klienter",
  "managed artists and creators": "artister och kreatörer under management",
  "Contact Management": "Kontakta Management",
  Booking: "Bokning",
  "bookable talent by category": "bokningsbara talanger per kategori",
  "Contact Nation": "Kontakta Nation",
  "## Company": "## Företaget",
  Team: "Team",
  News: "Nyheter",
  Guider: "Guider",
  Privacy: "Integritet",
};

/**
 * One line per guide (Section 7 — src/pages/guider/[slug].astro), built from
 * the same Guide[] shape guidesFromCategory() (src/lib/guides.ts) produces —
 * that module only `import type`s from ninetone.ts, so no new value import
 * chain is introduced here. Takes plain data, no FM read of its own.
 */
export interface GuideLike {
  slug: string;
  title: string;
  message?: string;
}

export function guideLines(guides: GuideLike[], origin: string): string[] {
  return guides
    .filter((g) => g.slug && g.title)
    .map((g) => {
      const tagline = markdownToPlainText(g.message ?? "", 140);
      return entityLine(g.title, `/guider/${g.slug}`, origin, tagline || undefined);
    });
}

/**
 * Build the full llms.txt body. Structured as an ordered list of sections —
 * each a heading plus static links plus (for the roster sections) FM-driven
 * entity lines — so Sections 6/7 (Nation category pages, guides route) can
 * each add one more section without restructuring anything.
 */
export function buildLlmsTxt(siteOrigin: string, data: LlmsTxtData, opts?: BuildLlmsTxtOptions): string {
  const chrome = opts?.chrome;
  // Every href below is built against the locale-prefixed origin; the
  // caller passes the bare site origin and the manifest locale.
  const origin = llmsLinkOrigin(siteOrigin, opts?.lang);
  // Falls back to `source` whenever the table has no entry — an absent
  // table (Swedish/default render), a miss for one particular string, or a
  // caller that only warmed a subset all degrade the same way: render the
  // source string, never throw, never blank. Mirrors translate.ts's own
  // "cache miss -> return source" posture (decision 6), just without any
  // live call — this module stays pure.
  const chromeText = (source: string): string => chrome?.[source] ?? source;

  const artistLines = data.artists.map((a) => artistLine(a, origin)).filter((l): l is string => !!l);
  const previousLines = data.previousArtists
    .map((a) => previousArtistLine(a, origin))
    .filter((l): l is string => !!l);
  const clientLines = data.clients.map((c) => clientLine(c, origin)).filter((l): l is string => !!l);
  const teamLines = data.team.map((m) => teamLine(m, origin)).filter((l): l is string => !!l);
  const newsLines = data.news.map((p) => newsLine(p, origin)).filter((l): l is string => !!l);

  const sections: string[] = [];

  sections.push(chromeText("# Ninetone Group"));
  sections.push(
    chromeText(
      "> Swedish music company based in Sundsvall and Stockholm. Three divisions:\n" +
        "> Ninetone Records (label), Ninetone Management (artist and creator\n" +
        "> management), Ninetone Nation (booking for events).",
    ),
  );

  sections.push(
    [
      chromeText("## Ninetone Records"),
      entityLine(chromeText("Artists"), "/records/artists", origin, chromeText("current roster")),
      ...artistLines,
      // Real route is the bare /records/artists/previous (Astro's paginate()
      // emits page 1 unsuffixed in [...page].astro; pages 2+ get /previous/{n})
      // — verified against a fresh dist/ build: dist/records/artists/previous/
      // index.html exists, dist/records/artists/previous/1/ does not. The
      // brief's Appendix B skeleton writes "/records/artists/previous/1",
      // which 404s; using the real, reachable URL instead, same as the
      // previous/single/{slug} deviation below.
      entityLine(chromeText("Previous artists"), "/records/artists/previous", origin),
      ...previousLines,
      entityLine(
        chromeText("Contact Records"),
        "/records/contact-records",
        origin,
        chromeText("demo submissions"),
      ),
    ].join("\n"),
  );

  sections.push(
    [
      chromeText("## Ninetone Management"),
      entityLine(
        chromeText("Clients"),
        "/management/clients",
        origin,
        chromeText("managed artists and creators"),
      ),
      ...clientLines,
      entityLine(chromeText("Contact Management"), "/management/contact-management", origin),
    ].join("\n"),
  );

  sections.push(
    [
      chromeText("## Ninetone Nation"),
      entityLine(
        chromeText("Booking"),
        "/ninetone-nation/booking",
        origin,
        chromeText("bookable talent by category"),
      ),
      ...(data.bookingCategoryLines ?? []),
      ...data.bookingLines,
      entityLine(chromeText("Contact Nation"), "/ninetone-nation/contact-ninetone-nation", origin),
    ].join("\n"),
  );

  sections.push(
    [
      chromeText("## Company"),
      entityLine(chromeText("Team"), "/team", origin),
      ...teamLines,
      entityLine(chromeText("News"), "/news", origin),
      ...newsLines,
      entityLine(chromeText("Guider"), "/guider", origin),
      ...(data.guideLines ?? []),
      entityLine(chromeText("Privacy"), "/integritet", origin),
    ].join("\n"),
  );

  return `${sections.join("\n\n")}\n`;
}
