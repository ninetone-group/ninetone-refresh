/**
 * FM WebPosts/presentation titles are authored as SEO strings, e.g.
 * "Top Music Production & Artist Branding | Ninetone Records". Good for
 * <title>, wrong for an on-page tagline or heading. Strip a trailing
 * " | Ninetone …" / " – Ninetone …" / " — Ninetone …" brand-suffix segment
 * before rendering the raw FM string as display copy.
 *
 * Only strips when the suffix mentions "Ninetone" — an arbitrary "A | B"
 * title is left alone, since that separator is also legitimate prose.
 */
export function displayTitle(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";

  const match = trimmed.match(/^([\s\S]*?)\s+[|–—]\s+([^|–—]+)$/);
  if (!match) return trimmed;

  const [, head, tail] = match;
  if (!/ninetone/i.test(tail)) return trimmed;

  return head.trim();
}

/**
 * <title> suffix for a paginated listing page (seo-phase-1b-brief.md P1
 * item 7). Astro's paginate() puts page 1 at the route's bare path — its
 * title is unchanged. Pages 2+ each need a distinct <title> or they read as
 * duplicates of page 1 to a crawler, so " · Sida N" (Swedish "page N",
 * matching the site's existing Swedish UI strings — e.g. Pagination.astro)
 * is appended for currentPage >= 2.
 */
export function paginatedTitle(baseTitle: string, currentPage: number, lang: "sv" | "en" = "sv"): string {
  // Locale-aware (2026-09-12 SEO review): "Sida" on an <html lang="en"> page
  // was shipping Swedish <title>s for all eleven English pagination URLs.
  const pageWord = lang === "en" ? "Page" : "Sida";
  return currentPage >= 2 ? `${baseTitle} · ${pageWord} ${currentPage}` : baseTitle;
}

/**
 * Whether a <title> built from an FM-authored string should still get
 * Base.astro's own " | Ninetone Group" suffix appended (seo-phase-1b-brief.md
 * P1 item 7, news titles). FM news headlines are editorial copy that can run
 * long; stacking the brand suffix on an already-long headline produces a
 * <title> far past the ~60-character point search results typically display.
 * Dropping the suffix (rather than truncating the headline) keeps the
 * crawler-visible title identical to what a reader sees in the page's own
 * <h1> — only Base's suffix is what changes.
 */
export function shouldAppendSiteName(title: string, maxLength = 60): boolean {
  return title.trim().length <= maxLength;
}
