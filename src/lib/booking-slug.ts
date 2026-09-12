/**
 * Shared slug for a Nation booking category tag (e.g. "Artist", "Föreläsare",
 * "Konferencier"). Originally defined only inside
 * src/pages/ninetone-nation/booking.astro (used for in-page anchor ids like
 * `#cat-forelasare`, since removed in favor of linking out to the category
 * pages); extracted here so
 * src/pages/ninetone-nation/kategori/[category].astro can produce the exact
 * same slug for its route params/links without a second, drifting copy.
 *
 * Output verified against every current API_BOOKING_TAG value: Artist ->
 * artist, Föreläsare -> forelasare, Konferencier -> konferencier, Moderator ->
 * moderator, Underhållare -> underhallare, Influencer -> influencer. This is
 * the "prefer forelasare over foerelaesare" transliteration the SEO brief
 * asks for.
 */
export function slugifyTag(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
