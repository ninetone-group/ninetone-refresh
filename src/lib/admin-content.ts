import { breaksMarkdownStructure, translate, type Kind, type Lang, type Tier, type TranslationOrigin } from "./translate.ts";
import type { KvLike } from "./cache.ts";
import type { HomepageCopy } from "./homepage-copy.ts";

/**
 * The FM texts the admin pages can look at, and the state each one is in.
 *
 * Each string is listed with the EXACT source text, kind and tier its page
 * passes to the translator — a translation is keyed on those, so a string
 * described even slightly differently here would look "waiting" forever.
 * When a page changes how it reads a field, change it here too:
 *
 *   news     src/pages/news/index.astro, src/pages/news/[slug].astro  (fmText: fast tier)
 *   homepage src/pages/index.astro                                    (t(): quality tier, plain)
 *
 * Chrome strings written in the page files themselves are not listed. They
 * have no inventory to read at runtime; their wordings are pinned in
 * src/i18n/overrides.json.
 */
export type ContentString = {
  id: string;
  label: string;
  source: string;
  kind: Kind;
  tier: Tier;
  /**
   * Set when the page itself skips the translator for this language. The
   * homepage shows FM copy untouched on the Swedish site (index.astro's
   * `fromFm`), so asking translate() what Swedish "would" get is the wrong
   * question — it would report a short headline as waiting, and offer a lock
   * that nothing reads.
   */
  shownAsWrittenIn?: Lang;
};
export type ContentItem = { id: string; label: string; path: string; strings: ContentString[] };

const present = (strings: ContentString[]) => strings.filter((s) => s.source.trim());

export function newsItems(posts: readonly Record<string, unknown>[]): ContentItem[] {
  return posts
    .filter((post) => post.slug)
    .map((post) => {
      const slug = String(post.slug);
      const title = String(post.Title ?? "").trim();
      return {
        id: `news:${slug}`,
        label: title || slug,
        path: `/news/${slug}`,
        strings: present([
          { id: "title", label: "Headline", source: title, kind: "title", tier: "fast" },
          { id: "excerpt", label: "Excerpt", source: String(post.shortMessage ?? "").trim(), kind: "plain", tier: "fast" },
          { id: "body", label: "Article text", source: String(post.MessageString ?? post.Message ?? "").trim(), kind: "markdown", tier: "fast" },
        ]),
      };
    });
}

export function homepageItem(copy: HomepageCopy): ContentItem {
  const strings: ContentString[] = [];
  const add = (id: string, label: string, source: string | undefined) => {
    if (source) strings.push({ id, label, source, kind: "plain", tier: "quality", shownAsWrittenIn: "sv" });
  };
  add("hero.heading", "Hero headline", copy.hero?.heading);
  add("hero.body", "Hero text", copy.hero?.body);
  add("hero.tagline", "Hero italic line", copy.hero?.tagline);
  add("positioning.heading", "Positioning headline", copy.positioning?.heading);
  add("positioning.tagline", "Positioning italic line", copy.positioning?.tagline);
  add("positioning.body", "Positioning text", copy.positioning?.body);
  for (const division of ["records", "management", "nation"] as const) {
    add(`cards.${division}.tagline`, `${division} card, tagline`, copy.cards[division]?.tagline);
    add(`cards.${division}.blurb`, `${division} card, text`, copy.cards[division]?.blurb);
  }
  add("bridge.heading", "Bridge headline", copy.bridge?.heading);
  add("bridge.tagline", "Bridge italic line", copy.bridge?.tagline);
  copy.bridge?.cases.forEach((c, i) => {
    add(`bridge.case.${i}.kicker`, `Bridge case ${i + 1}, label`, c.kicker);
    add(`bridge.case.${i}.heading`, `Bridge case ${i + 1}, name`, c.heading);
    add(`bridge.case.${i}.body`, `Bridge case ${i + 1}, text`, c.body);
  });
  add("bridge.closing", "Bridge closing line", copy.bridge?.closing);
  add("bridge.closingAccent", "Bridge closing line, red part", copy.bridge?.closingAccent);
  for (const [slot, name] of [["whatsOn", "What's on"], ["roster", "Roster"], ["news", "News"], ["merch", "Merch"]] as const) {
    add(`${slot}.heading`, `${name} headline`, copy[slot]?.heading);
    add(`${slot}.body`, `${name} text`, copy[slot]?.body);
  }
  add("about.heading", "About headline", copy.about?.heading);
  copy.about?.paragraphs.forEach((p, i) => add(`about.paragraph.${i}`, `About paragraph ${i + 1}`, p));
  add("about.closing", "About closing line", copy.about?.closing);
  return { id: "homepage", label: "Homepage", path: "/", strings };
}

export type Shown = { text: string; origin: TranslationOrigin; structureBroken: boolean };

/**
 * What one language's site shows for a string right now. Read-only: with no
 * scheduler passed, translate() never calls the model on a miss.
 */
export async function shownFor(string: ContentString, lang: Lang, kv: KvLike | null): Promise<Shown> {
  if (string.shownAsWrittenIn === lang) return { text: string.source, origin: "same-language", structureBroken: false };
  const result = await translate({ text: string.source, target: lang, tier: string.tier, kind: string.kind, kv });
  const replaced = result.origin === "cached" || result.origin === "locked" || result.origin === "override";
  return {
    text: result.text,
    origin: result.origin,
    structureBroken: replaced && string.kind === "markdown" && breaksMarkdownStructure(string.source, result.text),
  };
}

export type HealthProblem = { item: string; itemLabel: string; path: string; string: string; lang: Lang; issue: "waiting" | "damaged" };
export type HealthReport = {
  items: number;
  strings: number;
  byLang: Record<Lang, Record<TranslationOrigin, number>>;
  damaged: number;
  problems: HealthProblem[];
};

const LANGS: Lang[] = ["sv", "en"];
const tally = (): Record<TranslationOrigin, number> => ({ empty: 0, override: 0, "same-language": 0, locked: 0, cached: 0, miss: 0 });

/** Every string of every item, in both languages. Damaged ones first in `problems`. */
export async function healthOf(items: ContentItem[], kv: KvLike | null): Promise<HealthReport> {
  const report: HealthReport = { items: items.length, strings: 0, byLang: { sv: tally(), en: tally() }, damaged: 0, problems: [] };
  const checks = items.flatMap((item) => item.strings.flatMap((string) => LANGS.map((lang) => ({ item, string, lang }))));
  report.strings = checks.length / LANGS.length;
  const shown = await Promise.all(checks.map((c) => shownFor(c.string, c.lang, kv)));
  shown.forEach((state, i) => {
    const { item, string, lang } = checks[i];
    report.byLang[lang][state.origin]++;
    const issue = state.structureBroken ? "damaged" : state.origin === "miss" ? "waiting" : null;
    if (state.structureBroken) report.damaged++;
    if (issue) report.problems.push({ item: item.id, itemLabel: item.label, path: item.path, string: string.label, lang, issue });
  });
  report.problems.sort((a, b) => Number(b.issue === "damaged") - Number(a.issue === "damaged"));
  return report;
}
