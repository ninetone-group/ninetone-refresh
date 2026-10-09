import type { WebPostBlock, WebPostCategory } from "./ninetone.ts";
import { markdownToText } from "./excerpt.ts";

/**
 * Homepage copy from FileMaker — API_WEBPOSTS, category "Ninetone Group"
 * (Patrik, 2026-10-09). Same data shape as the Records / Management / Nation
 * sections, but those pages print their blocks as one generic list; the
 * homepage has a bespoke layout, so each block has to land in one named slot.
 *
 * HOW A BLOCK IS MATCHED TO A SLOT. FM gives a block no key of its own: the
 * subject IS the headline and editors change it, `slug` is empty, and five of
 * the eleven blocks share one `sortOrder` timestamp, so order cannot tell the
 * hero from the positioning block. The portal row id is the one thing that
 * survives an edit, so slots are bound to it. The three division cards are
 * the exception — their subject is the division name, which is a real key.
 *
 * Everything here is optional. A slot whose block is missing (deleted, or
 * deleted and re-created under a new row id) comes back undefined and the
 * page keeps its built-in copy for that slot. A NEW block in FM is ignored
 * until it is added to SLOT_BY_RECORD_ID.
 */
const SLOT_BY_RECORD_ID = {
  "3": "hero",
  "4": "positioning",
  "55": "bridge",
  "56": "whatsOn",
  "57": "roster",
  "58": "news",
  "59": "about",
  "60": "merch",
} as const;

type Slot = (typeof SLOT_BY_RECORD_ID)[keyof typeof SLOT_BY_RECORD_ID];
export type Division = "records" | "management" | "nation";
type Target = Slot | `card:${Division}`;

/** What each slot is called on /admin/homepage. Also the list of every slot there is. */
const TARGET_LABELS: Record<Target, string> = {
  hero: "Hero (top of the page)",
  positioning: "Positioning band",
  "card:records": "Records card",
  "card:management": "Management card",
  "card:nation": "Nation card",
  bridge: "Bridge section and its cases",
  whatsOn: "What's on heading",
  roster: "Roster heading",
  news: "News heading",
  about: "About",
  merch: "Merch heading",
};

/** The one rule for where a block goes — shared by the parser and the admin status page. */
function targetOf(block: WebPostBlock): Target | null {
  const subject = block.subject.trim();
  const division = subject.toLowerCase();
  if (division === "records" || division === "management" || division === "nation") return `card:${division}`;
  const slot = SLOT_BY_RECORD_ID[block.recordId as keyof typeof SLOT_BY_RECORD_ID] as Slot | undefined;
  return slot && subject ? slot : null;
}

export type HomepageBlockStatus = { recordId: string; subject: string; fills: string | null };

/** Every FM block with the slot it fills (or null), plus the slots nothing fills. For /admin/homepage. */
export function describeHomepageBlocks(section: WebPostCategory | null | undefined): {
  blocks: HomepageBlockStatus[];
  unfilled: string[];
} {
  const filled = new Set<Target>();
  const blocks = (section?.blocks ?? []).map((block) => {
    const target = targetOf(block);
    if (target) filled.add(target);
    return { recordId: block.recordId ?? "", subject: block.subject.trim(), fills: target ? TARGET_LABELS[target] : null };
  });
  const unfilled = (Object.keys(TARGET_LABELS) as Target[]).filter((t) => !filled.has(t)).map((t) => TARGET_LABELS[t]);
  return { blocks, unfilled };
}

export type HeadedCopy = { heading: string; body: string };
export type BridgeCase = { kicker: string; heading: string; body: string };

export type HomepageCopy = {
  hero?: { heading: string; body: string; tagline: string };
  positioning?: { heading: string; tagline: string; body: string };
  cards: Partial<Record<Division, { tagline: string; blurb: string }>>;
  bridge?: { heading: string; tagline: string; cases: BridgeCase[]; closing: string; closingAccent: string };
  whatsOn?: HeadedCopy;
  roster?: HeadedCopy;
  news?: HeadedCopy;
  about?: { heading: string; paragraphs: string[]; closing: string };
  merch?: HeadedCopy;
};

/**
 * One blank-line-separated chunk of a block's message. Editors mark the
 * standout lines the only way a text field allows: a heading (`## …`) or a
 * line wrapped in emphasis (`*…*`). Either makes it a `lead`.
 */
type Part = { text: string; heading: boolean; emphasised: boolean; lead: boolean };

function partsOf(message: string): Part[] {
  return message
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const body = raw.replace(/^#{1,6}\s+/, "");
      const heading = body !== raw;
      const emphasised = /^([*_]{1,3})[^*_]+\1$/.test(body);
      return { text: markdownToText(body), heading, emphasised, lead: heading || emphasised };
    })
    .filter((part) => part.text);
}

const join = (parts: Part[]) => parts.map((p) => p.text).join(" ");

/** First lead line plus everything that is ordinary prose. */
function leadAndBody(message: string): { lead: string; body: string } {
  const parts = partsOf(message);
  return { lead: parts.find((p) => p.lead)?.text ?? "", body: join(parts.filter((p) => !p.lead)) };
}

/**
 * The bridge section's closing line ends on an accent the design sets in red:
 * "Olika världar. Samma kärna. Behov. Erbjudande. Människa." The accent is
 * the trailing run of one-word sentences. No such run, no accent.
 */
function splitAccent(text: string): { closing: string; closingAccent: string } {
  const sentences = text.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? [];
  if (sentences.join(" ") !== text) return { closing: text, closingAccent: "" };
  let start = sentences.length;
  while (start > 0 && !/\s/.test(sentences[start - 1])) start--;
  if (start === 0 || sentences.length - start < 2) return { closing: text, closingAccent: "" };
  return { closing: sentences.slice(0, start).join(" "), closingAccent: sentences.slice(start).join(" ") };
}

/**
 * The bridge block: an opening lead, then one case per plain heading —
 * `kicker`, `## Name`, body — and a closing lead.
 */
function bridgeOf(block: WebPostBlock): HomepageCopy["bridge"] {
  const parts = partsOf(block.message);
  const tagline = parts[0]?.emphasised ? parts.shift()!.text : "";
  const closing = parts[parts.length - 1]?.emphasised ? parts.pop()!.text : "";

  const cases: BridgeCase[] = [];
  let pending: Part[] = []; // prose seen since the previous case heading
  for (const part of parts) {
    if (!isCaseHeading(part)) {
      pending.push(part);
      continue;
    }
    // The line right above a heading is its kicker, unless it is the only
    // prose the previous case has — a case keeps its body before the next
    // one gets a kicker.
    const current = cases[cases.length - 1];
    const kicker = pending.length > (current ? 1 : 0) ? pending.pop()!.text : "";
    if (current) current.body = join(pending);
    cases.push({ kicker, heading: part.text, body: "" });
    pending = [];
  }
  if (cases.length) cases[cases.length - 1].body = join(pending);

  return { heading: block.subject.trim(), tagline, cases, ...splitAccent(closing) };
}

/** A case name is a heading that is not also emphasised (`## Name`, not `## *line*`). */
function isCaseHeading(part: Part): boolean {
  return part.heading && !part.emphasised;
}

export function parseHomepageCopy(section: WebPostCategory | null | undefined): HomepageCopy {
  const copy: HomepageCopy = { cards: {} };
  for (const block of section?.blocks ?? []) {
    const subject = block.subject.trim();
    const slot = targetOf(block);
    if (!slot) continue;

    if (slot === "card:records" || slot === "card:management" || slot === "card:nation") {
      const { lead, body } = leadAndBody(block.message);
      copy.cards[slot.slice(5) as Division] = { tagline: lead, blurb: body };
    } else if (slot === "hero") {
      const { lead, body } = leadAndBody(block.message);
      copy.hero = { heading: subject, body, tagline: lead };
    } else if (slot === "positioning") {
      const { lead, body } = leadAndBody(block.message);
      copy.positioning = { heading: subject, tagline: lead, body };
    } else if (slot === "bridge") {
      copy.bridge = bridgeOf(block);
    } else if (slot === "about") {
      const parts = partsOf(block.message);
      const closing = parts[parts.length - 1]?.lead ? parts.pop()!.text : "";
      copy.about = { heading: subject, paragraphs: parts.map((p) => p.text), closing };
    } else {
      copy[slot] = { heading: subject, body: markdownToText(block.message) };
    }
  }
  return copy;
}
