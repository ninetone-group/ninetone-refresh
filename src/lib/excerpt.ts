import { renderBio } from "./markdown.ts";

// Present in an excerpt only when markup or a line break leaked into it.
const MARKUP_RE = /[\r\n*`#[\]<>]|https?:\/\//;

/** Rendered Markdown to one line of text. Inline tags leave no gap, so "*Efter fem*." does not become "Efter fem ." */
function htmlToText(html: string): string {
  return html
    .replace(/<\/?(a|strong|em|code|del)\b[^>]*>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Markdown source to one line of plain text. */
export function markdownToText(markdown: string): string {
  return htmlToText(renderBio(markdown));
}

/**
 * News excerpt as plain text — the card blurb, the article standfirst, the
 * meta description and the search-index blurb all read it.
 *
 * FM's `shortMessage` is the raw body up to its first full stop. Two things
 * follow from that, both seen live on /news (2026-10-09):
 *
 *   - It is Markdown source, not text. Rendered as-is, a card showed
 *     "## Under helgen…", "**Plats och datum:**" and "<h2>Karakou…</h2>".
 *   - The first full stop can sit inside a link target, which cut one excerpt
 *     off at "[Jämtlands Bryggeri](https://jamtlandsbryggeri." — when the cut
 *     lands mid-word the excerpt is extended to the end of that sentence.
 *
 * An excerpt with no markup is returned untouched, so its translation cache
 * key (sha256 of the source) does not move.
 */
export function newsExcerpt(shortMessage: unknown, message: unknown): string {
  let excerpt = String(shortMessage ?? "").trim();
  if (!excerpt) return "";

  const body = String(message ?? "").trimStart();
  if (body.startsWith(excerpt)) {
    const rest = body.slice(excerpt.length);
    if (rest && !/^\s/.test(rest)) {
      const line = rest.split(/[\r\n]/, 1)[0];
      const end = line.search(/[.!?](?=\s|$)/);
      excerpt += end === -1 ? line : line.slice(0, end + 1);
    }
  }

  if (!MARKUP_RE.test(excerpt)) return excerpt;
  // Literal tags first: renderBio escapes them, so they would otherwise come
  // back out of the entity decoding above as visible "<h2>" text.
  return markdownToText(excerpt.replace(/<\/?[a-z][^>]*>/gi, " "));
}
