/**
 * Locale-aware date formatting for Phase 2 i18n (docs/i18n-phase-2-brief.md,
 * "Dates" Build item): Swedish format at root ("29 juli 2026"), English at
 * `/en/` ("29 July 2026"), via `Intl.DateTimeFormat` with the locale —
 * replacing the hardcoded-English-month-abbreviation formatters previously
 * duplicated in YouTubeFeed.astro and Discography.astro, and the raw FM
 * `MM/DD/YYYY` string that news/[slug].astro rendered directly (the
 * US-format output the design critique flagged).
 *
 * Deliberately Astro-free, like src/lib/i18n.ts: no `Astro.locals`, no
 * request object. Callers (components) read `Astro.locals.lang` themselves
 * (same structural read + "sv" fallback Base.astro already uses — see its
 * `<html lang>` precedence comment) and pass the resulting `Lang` in here.
 * That keeps this module plain-Node-testable via node:test with no Astro
 * runtime, and keeps it synchronous — this is pure `Intl` formatting, not a
 * translation, so it deliberately does NOT go through t()/sharedT(): no API
 * call, no budget, no async, none of section 4's waitUntil/cache machinery
 * applies here.
 *
 * INPUT SHAPES this codebase actually produces (verified against the call
 * sites this module replaces):
 *   - FM's "MM/DD/YYYY" strings (API_NEWS `Date`, release `releaseDate`,
 *     WebPosts guide blocks' `date` — see src/lib/schema.ts's fmDateToIso,
 *     which parses the identical shape and is reused below rather than
 *     writing a third parser).
 *   - ISO strings (YouTubeFeed's RSS/Data-API `publishedAt` timestamps).
 * Anything that matches neither returns "" — the existing formatters this
 * module replaces already treated unparseable input as absent (falsy), and
 * several templates rely on that (`{date && <time>...}` guards).
 *
 * ICU VERIFICATION (reported in full in the section 6 PR description): run
 * under this repo's actual Node (>=22.19.0 per CLAUDE.md; verified here on
 * 22.14.0 locally), `new Intl.DateTimeFormat("sv-SE", {day:"numeric",
 * month:"long", year:"numeric"}).format(new Date("2026-07-29T00:00:00Z"))`
 * produces exactly "29 juli 2026" — a real Swedish month name, not an
 * English fallback — confirming full-ICU (not small-icu) is present. Node
 * ships full ICU by default since v14; small-icu is an opt-in build flag
 * this project does not use (no `NODE_ICU_DATA` / `--with-intl=small-icu`
 * anywhere in package.json, wrangler config, or the GH Actions workflow).
 */

import { fmDateToIso } from "./schema.ts";

export type Lang = "sv" | "en";

/** BCP-47 locale Intl.DateTimeFormat formats with, per site Lang. */
const INTL_LOCALE: Record<Lang, string> = {
  sv: "sv-SE",
  en: "en-GB",
};

/**
 * Parse either input shape this codebase has (FM "MM/DD/YYYY" or ISO) into a
 * valid Date, or null if neither matches / the value doesn't represent a
 * real calendar date.
 *
 * FM dates are parsed via fmDateToIso() (src/lib/schema.ts) — reused rather
 * than re-implemented, per the task's instruction — which turns "MM/DD/YYYY"
 * into "YYYY-MM-DD" or `undefined` for a non-matching string. That ISO
 * string (or, if fmDateToIso didn't match, the raw input on the chance it's
 * already ISO) is then handed to `Date` with a UTC noon anchor: plain
 * "YYYY-MM-DD" is parsed by the Date constructor as UTC midnight, and
 * formatting a UTC-midnight instant with a viewer-local Intl.DateTimeFormat
 * (no `timeZone` override — see formatDate's doc comment for why) can roll
 * the calendar day backward for any timezone west of UTC. Re-anchoring to
 * UTC noon keeps every timezone on Earth reading the same calendar day
 * FileMaker meant, without imposing a fixed `timeZone` on the formatter
 * (which would fight a future non-UTC-authored ISO timestamp, e.g.
 * YouTube's `publishedAt`, which already carries real time-of-day + offset
 * information that re-anchoring must NOT touch).
 */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const fmIso = fmDateToIso(raw);
  if (fmIso) {
    // fmDateToIso output is always a bare "YYYY-MM-DD" (no time-of-day) —
    // anchor to UTC noon so no timezone can shift the calendar day.
    const d = new Date(`${fmIso}T12:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  // Not FM-shaped — try as-is (covers YouTube's real ISO timestamps, which
  // already carry their own time-of-day/offset and must format at their
  // actual instant, not get re-anchored to noon).
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Human-readable date string in the given locale:
 *   formatDate("2026-07-29T00:00:00Z", "sv") -> "29 juli 2026"
 *   formatDate("07/29/2026", "en")           -> "29 July 2026"
 *
 * Returns "" for null/undefined/empty/unparseable input — preserving the
 * falsy-on-failure contract the templates this replaces already depend on
 * (`{date && <time>{formatDate(date, lang)}</time>}`-shaped guards).
 *
 * No `timeZone` is fixed on the formatter: this renders a calendar date
 * ("29 juli 2026"), not a date+time, so the only thing that matters is that
 * the calendar day doesn't drift — which parseDate()'s UTC-noon anchoring
 * for FM/bare-ISO input already guarantees regardless of viewer timezone.
 */
export function formatDate(value: string | null | undefined, lang: Lang): string {
  const d = parseDate(value);
  if (!d) return "";
  return new Intl.DateTimeFormat(INTL_LOCALE[lang], {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/**
 * The ISO-8601 calendar date ("YYYY-MM-DD") for a `<time datetime="...">`
 * attribute, independent of display locale — machine-readable value and
 * human-readable text are different things (this task's own constraint,
 * matching how news/[slug].astro already separates `isoDate` from the
 * visible `date` text via fmDateToIso + JSON-LD).
 *
 * Returns "" on unparseable input, same contract as formatDate().
 */
export function formatIsoDate(value: string | null | undefined): string {
  const d = parseDate(value);
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}
