/**
 * Pure helpers for the Guides route (Section 7 of docs/seo-phase-1-brief.md
 * — src/pages/guider/index.astro + [slug].astro). No I/O, no Astro globals —
 * callers pass in the `WebPostCategory` shape `getWebPosts("Guider")` already
 * returns (src/lib/ninetone.ts), so this is unit-testable without FM.
 *
 * Guides live as portal rows (blocks) inside ONE FM WebPosts record whose
 * category is "Guider" — same shape every other WebPosts category uses
 * (subject/message/image/date per block). There is no FM slug field on a
 * webPost portal row, so the guide's slug is derived from its subject
 * (title), mirroring how src/lib/booking-slug.ts derives a stable slug from
 * an FM tag string rather than requiring a new FM field.
 */

import type { WebPostBlock, WebPostCategory } from "./ninetone.ts";

// ---------------------------------------------------------------------------
// Slugging
// ---------------------------------------------------------------------------

/**
 * Slugify a guide title into a URL segment. Same transliteration rules as
 * src/lib/booking-slug.ts's slugifyTag() (strip diacritics rather than
 * percent-encode them, collapse non-alphanumeric runs to one hyphen) — kept
 * as a separate function here rather than imported, since that module's name
 * and doc comment are specifically about booking category tags, not
 * arbitrary titles; the two are free to diverge later without either
 * pretending to be the other's alias.
 */
export function slugifyTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Guide shape
// ---------------------------------------------------------------------------

export interface Guide {
  slug: string;
  title: string;
  message: string;
  image?: string;
  /** Raw FM date string (MM/DD/YYYY), same format as API_NEWS's `Date`. */
  date?: string;
}

/**
 * Map the "Guider" WebPosts category's blocks into slugged, orderable
 * guides. Blocks with no usable subject are skipped (mirrors
 * detailPageEntries()'s "no usable slug -> skip" guard in src/lib/sitemap.ts
 * — never emit a page/link for a row with nothing to slug from).
 *
 * Two blocks that slugify to the same value get a `-2`, `-3`, ... suffix
 * (stable by portal order, which getWebPosts() already sorts by the editor's
 * sortOrder field) rather than silently colliding on one route.
 */
export function guidesFromCategory(category: WebPostCategory | null | undefined): Guide[] {
  if (!category) return [];
  const seen = new Map<string, number>();
  const out: Guide[] = [];
  for (const block of category.blocks) {
    const guide = guideFromBlock(block);
    if (!guide) continue;
    const count = seen.get(guide.slug) ?? 0;
    seen.set(guide.slug, count + 1);
    out.push(count === 0 ? guide : { ...guide, slug: `${guide.slug}-${count + 1}` });
  }
  return out;
}

function guideFromBlock(block: WebPostBlock): Guide | null {
  const title = String(block.subject ?? "").trim();
  if (!title) return null;
  const slug = slugifyTitle(title);
  if (!slug) return null;
  return {
    slug,
    title,
    message: block.message ?? "",
    image: block.image,
    date: block.date,
  };
}

/** Find one guide by slug within an already-fetched "Guider" category. */
export function findGuideBySlug(category: WebPostCategory | null | undefined, slug: string): Guide | null {
  return guidesFromCategory(category).find((g) => g.slug === slug) ?? null;
}

// ---------------------------------------------------------------------------
// FAQ extraction from guide markdown
// ---------------------------------------------------------------------------

export interface FaqItem {
  q: string;
  a: string;
}

/**
 * Strip a CommonMark ATX closing sequence — one or more "#" characters
 * preceded by at least one space, at the end of a heading line (e.g.
 * "## FAQ ##" and "### Question? ###" are both valid ATX headings whose
 * heading text is "FAQ" / "Question?", not "FAQ ##" / "Question? ###").
 * Applied after the leading "#"-run + required whitespace has already been
 * stripped by the caller's regex capture group.
 */
function stripClosingSequence(text: string): string {
  return text.replace(/\s+#+\s*$/, "").trim();
}

/**
 * Extract FAQ question/answer pairs from a guide's markdown body.
 *
 * Looks for an H2 section titled "Vanliga frågor" or "FAQ" (case-insensitive,
 * trimmed), then reads each H3 inside that section as a question, taking the
 * following paragraph (up to the next H2/H3, or end of the section) as the
 * answer. Returns [] when no such section exists — the expected default per
 * the brief, not an error.
 *
 * Deliberately a plain regex/line-scan over markdown SOURCE, not the
 * rendered HTML: renderBio() (src/lib/markdown.ts) turns headings into
 * generic <h2>/<h3> tags with no reliable "is this the FAQ section" marker,
 * whereas the source heading text is exactly what an editor wrote and is
 * unambiguous to match here.
 */
export function parseFaqFromMarkdown(markdown: string | null | undefined): FaqItem[] {
  if (!markdown) return [];
  const normalized = String(markdown).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const isFaqHeading = (line: string): boolean => {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (!m) return false;
    const heading = stripClosingSequence(m[1]).toLowerCase();
    return heading === "vanliga frågor" || heading === "faq";
  };

  // Find the FAQ H2 section's line range: from just after the heading to the
  // next H2 (or end of document).
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFaqHeading(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start, end);

  const items: FaqItem[] = [];
  let currentQ: string | null = null;
  let currentA: string[] = [];

  const flush = () => {
    if (currentQ) {
      const answer = currentA.join(" ").trim();
      if (answer) items.push({ q: currentQ, a: answer });
    }
    currentQ = null;
    currentA = [];
  };

  for (const raw of section) {
    const h3 = raw.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      flush();
      currentQ = stripClosingSequence(h3[1]);
      continue;
    }
    if (currentQ === null) continue; // text before the first H3 isn't a Q/A pair
    const trimmed = raw.trim();
    if (!trimmed) {
      // Blank line: the answer paragraph for this question is done, but keep
      // currentQ open in case of a stray blank line before the next H3 — the
      // next H3 (or end of section) calls flush() anyway. Only flush now if
      // we've already collected an answer, so a heading followed immediately
      // by a blank line doesn't lose text that comes after it.
      if (currentA.length > 0) {
        flush();
      }
      continue;
    }
    currentA.push(trimmed);
  }
  flush();

  return items;
}
