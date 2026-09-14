/**
 * FileMaker placeholder prose (2026-09-14).
 *
 * WHY. 64 of the 140 former Management clients carry a template instead of a
 * bio in clientPresentationString / clientPresentationShort:
 *
 *   -----Placeholder Text-----
 *   The main goal is to establish the artst (Artist Names) in the market …
 *
 * Rendering it puts "(Artist Names)" and "(Genré)" on a public page, and
 * translating it spends API calls on text nobody should read. The FM side is
 * not ours to clean (CLAUDE.md: work with the system), so the site treats a
 * placeholder exactly like an empty field — no blurb on the card, no bio on
 * the detail page, meta description falls back as if the field were blank —
 * and the pages heal themselves the moment real prose lands in FM.
 *
 * Only the explicit marker counts. A real bio that happens to contain the
 * word "placeholder" must not vanish, so this does not pattern-match the body.
 */
const PLACEHOLDER_MARKER = /^\s*-{3,}\s*placeholder\s+text\s*-{3,}/i;

export function isPlaceholderProse(text: unknown): boolean {
  return PLACEHOLDER_MARKER.test(String(text ?? ""));
}

/** The text itself, or "" when it is a placeholder — for callers that feed
 *  the value straight into fm()/renderBio(). */
export function withoutPlaceholder(text: unknown): string {
  const s = String(text ?? "");
  return isPlaceholderProse(s) ? "" : s;
}
