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

/** Longest profile blurb a homepage tile takes. FileMaker's short texts were all about this long. */
const TEASER_MAX = 200;
/** A cut at a sentence end is only used when it leaves at least this much text. */
const TEASER_MIN_SENTENCE = 80;

/**
 * A profile's short text, held to tile length.
 *
 * Office returns the whole biography in `artistPresentationShort` /
 * `clientPresentationShort` (about 800 characters since 2026-11; FileMaker cut
 * the field at 200), which filled the homepage "of the week" tiles with the
 * full bio. Text that already fits is returned as it is, so a real short text
 * is shown verbatim. Longer text ends at the last full sentence that fits, or
 * at a word boundary with an ellipsis when the first sentence alone is too long.
 *
 * Call it on the text that will be shown, after translation: the translator
 * then still gets the field as the profile page sends it, and its stored
 * translation is reused.
 */
export function profileTeaser(text: unknown, max = TEASER_MAX): string {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;

  // A sentence ends at . ! or ? (and a closing quote or bracket) when the next
  // word starts with a capital, a digit or an opening quote. That keeps
  // "J.O.X", "bl.a. musik" and "3.5 miljoner" in one piece.
  let end = -1;
  for (const m of line.matchAll(/[.!?]["”’)]?(?=\s[\p{Lu}\d"“‘(])/gu)) {
    const stop = m.index + m[0].length;
    if (stop > max) break;
    end = stop;
  }
  if (end >= Math.min(TEASER_MIN_SENTENCE, max)) return line.slice(0, end);

  const head = line.slice(0, max);
  const space = /\s/.test(line[max]) ? max : head.lastIndexOf(" ");
  const words = (space > 0 ? head.slice(0, space) : head).replace(/[\s.,;:!?–—-]+$/, "");
  return `${words}…`;
}
