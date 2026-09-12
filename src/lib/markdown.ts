import { marked, Renderer } from "marked";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only navigation schemes which are safe in an HTML href/src attribute. */
function safeUrl(value: string, image = false): string | null {
  const href = value.trim();
  if (!href || /[\u0000-\u001F\u007F]/.test(href)) return null;
  // Protocol-relative ("//host/...") and backslash variants ("\\host",
  // "/\host") resolve against the https://markdown.invalid/ base below as a
  // live cross-origin https:// URL, bypassing the intent of the scheme
  // allowlist. Reject before URL parsing.
  if (/^[/\\]{2}/.test(href)) return null;
  try {
    const parsed = new URL(href, "https://markdown.invalid/");
    const allowed = image ? ["http:", "https:"] : ["http:", "https:", "mailto:", "tel:"];
    return allowed.includes(parsed.protocol) ? href : null;
  } catch {
    return null;
  }
}

const renderer = new Renderer();
// FM content is untrusted. Preserve literal HTML as text rather than allowing
// scriptable tags/attributes to reach Astro's set:html consumers.
renderer.html = ({ text }) => escapeHtml(text);
renderer.link = function ({ href, title, tokens }) {
  const label = this.parser.parseInline(tokens);
  const safe = safeUrl(href);
  if (!safe) return label;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safe)}"${titleAttr}>${label}</a>`;
};
renderer.image = ({ href, title, text }) => {
  const safe = safeUrl(href, true);
  if (!safe) return escapeHtml(text);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}"${titleAttr}>`;
};
// FM prose is always rendered into the body of a page that already has its
// own <h1> (detail-page hero name, article title, etc.) — never as the
// page's own heading. Editors write plain markdown (# / ##) without knowing
// that, so a literal "# Some Heading" in a bio would otherwise emit a second,
// competing <h1>.
//
// CLAMP rather than shift: only h1 is rewritten (to h2); every other level is
// left alone. Shifting everything down one was the first attempt and it broke
// long-form hierarchy — renderBio also renders /news/[slug] and /guider/[slug],
// where an editor's "## Section" is a legitimate h2 under the template's h1.
// Demoting those to h3 made ~80 article pages jump h1 -> h3 with no h2 in
// between. Clamping makes a competing h1 impossible while leaving correct
// headings untouched.
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  const level = depth === 1 ? 2 : depth;
  return `<h${level}>${text}</h${level}>\n`;
};

marked.setOptions({
  gfm: true,
  breaks: true,
  renderer,
});

/**
 * Normalize reference-style link definitions written by ChatGPT-style editors.
 *
 * The bios in FileMaker contain reference markdown like:
 *   See ([Bjärenu][1]).
 *   ...
 *   [1]: https://bjarenu.se/... Stjärnspäckad sommarfest - bjarenu.se
 *
 * CommonMark requires the trailing title to be wrapped in quotes/parens.
 * Without that, marked falls back to printing the raw `[label][N]` text and
 * the `[N]: url ...` lines instead of resolving them. We rewrite each ref
 * line to `[N]: url "title"`, which marked handles natively.
 */
function normalizeReferenceDefs(text: string): string {
  return text.replace(
    /^(\[[^\]]+\]:\s*\S+)([ \t]+)(.+)$/gm,
    (_, prefix, _ws, rest) => `${prefix} "${String(rest).replace(/"/g, "'")}"`,
  );
}

/**
 * Strip tracking-only query params from URLs in markdown.
 *
 * Editors paste links from ChatGPT / various sources and they often carry
 * `?utm_source=chatgpt.com`, `fbclid=...`, etc. None of these affect where
 * the link goes, so we drop them at render time rather than asking content
 * editors to clean every URL by hand.
 */
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "gbraid", "wbraid", "msclkid", "yclid", "dclid",
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "hsCtaTracking",
  "ref", "ref_src", "ref_url", "igshid",
]);

function stripTrackingParams(url: string): string {
  try {
    const u = new URL(url);
    let dirty = false;
    [...u.searchParams.keys()].forEach((k) => {
      if (TRACKING_PARAMS.has(k.toLowerCase())) {
        u.searchParams.delete(k);
        dirty = true;
      }
    });
    if (!dirty) return url;
    // Drop the trailing "?" if no params remain
    let result = u.toString();
    if (u.search === "" && result.endsWith("?")) result = result.slice(0, -1);
    return result;
  } catch {
    return url; // not a parseable URL — leave it alone
  }
}

function cleanLinksInMarkdown(text: string): string {
  // Inline links: [label](https://...) and reference defs: [1]: https://...
  return text.replace(
    /(https?:\/\/[^\s)\]"']+)/g,
    (match) => stripTrackingParams(match),
  );
}

/**
 * Render FileMaker bio text as HTML.
 *
 * FileMaker stores line breaks as `\r` (carriage return), so we normalize
 * those to `\n` first. Editors write markdown (## headings, **bold**, links)
 * in the FM field, same as the DivHunt site does.
 *
 * Pipeline: \r→\n  →  normalize ref defs  →  strip utm_ and tracking params  →  marked
 */
export function renderBio(text: string | undefined | null): string {
  if (!text) return "";
  let processed = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  processed = normalizeReferenceDefs(processed);
  processed = cleanLinksInMarkdown(processed);
  return marked.parse(processed, { async: false }) as string;
}

/**
 * Detect bios that read like they were written by a chatbot summarizing a press
 * release, not a person describing themselves. Real bios use first or third
 * person without hedging. AI summaries say "would be focused on", "according to
 * Ninetone", "based on publicly available information", etc.
 *
 * Returns true when the bio should be suppressed in favor of the role title.
 */
export function isAiSpeculative(text: string | undefined | null): boolean {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const tells = [
    "would be focused",
    "would be involved",
    "would likely",
    "would therefore",
    "would entail",
    "according to ninetone",
    "according to the company",
    "based on publicly available",
    "while specific details",
    "while the specific",
    "publicly available information",
    "in their capacity as",
    "in her capacity as",
    "in his capacity as",
  ];
  return tells.some((tell) => t.includes(tell));
}
