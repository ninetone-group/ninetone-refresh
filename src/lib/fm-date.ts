/**
 * FM date fields (release dates, news post dates) are "MM/DD/YYYY" — convert
 * to ISO-8601 (YYYY-MM-DD), or return undefined when the value doesn't match
 * rather than guess/fabricate a date. Lives in its own dependency-free module
 * so the pure sitemap builder (src/lib/sitemap.ts) can share it with the
 * JSON-LD helpers (src/lib/schema.ts) without dragging markdown/URL code
 * into the Node test suite.
 */
export function fmDateToIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const m = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}
