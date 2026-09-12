import assert from "node:assert/strict";
import test from "node:test";

import { formatDate, formatIsoDate } from "../src/lib/dates.ts";

// ---------------------------------------------------------------------------
// formatDate — both locales, both input shapes (docs/i18n-phase-2-brief.md
// "Dates" Build item: "Swedish format at root (29 juli 2026), English at
// /en/ (29 July 2026), via Intl.DateTimeFormat with the locale"). Exact
// strings verified by running node (task instruction) before writing this
// file — see src/lib/dates.ts's module doc comment for the verification
// note and the section 6 report for the full paste.
// ---------------------------------------------------------------------------

test("formatDate renders FM MM/DD/YYYY in Swedish — matches the brief's example exactly", () => {
  assert.equal(formatDate("07/29/2026", "sv"), "29 juli 2026");
});

test("formatDate renders FM MM/DD/YYYY in English — matches the brief's example exactly", () => {
  assert.equal(formatDate("07/29/2026", "en"), "29 July 2026");
});

test("formatDate renders an ISO string in Swedish", () => {
  assert.equal(formatDate("2026-07-29T14:23:00Z", "sv"), "29 juli 2026");
});

test("formatDate renders an ISO string in English", () => {
  assert.equal(formatDate("2026-07-29T14:23:00Z", "en"), "29 July 2026");
});

test("formatDate handles single-digit FM month/day (no leading zeros in the source)", () => {
  // FM's MM/DD/YYYY is not always zero-padded — fmDateToIso (src/lib/schema.ts)
  // already tolerates 1-2 digit month/day; formatDate reuses it, so this
  // guards that path stays intact through dates.ts's wrapper.
  assert.equal(formatDate("1/5/2026", "sv"), "5 januari 2026");
  assert.equal(formatDate("1/5/2026", "en"), "5 January 2026");
});

test("formatDate handles a bare ISO calendar date (no time-of-day) without rolling the day backward", () => {
  // Regression guard for the UTC-noon anchoring in dates.ts's parseDate():
  // a bare "YYYY-MM-DD" is parsed by `Date` as UTC midnight, and formatting
  // that instant with a non-UTC-anchored Intl call could show the PREVIOUS
  // calendar day in timezones west of UTC. This assertion is timezone-
  // independent by construction — it would fail in CI running in any
  // negative-offset zone if the anchoring regressed.
  assert.equal(formatDate("2026-07-29", "sv"), "29 juli 2026");
  assert.equal(formatDate("2026-07-29", "en"), "29 July 2026");
});

// ---------------------------------------------------------------------------
// Invalid/empty input -> "" (task instruction: preserve the existing
// formatters' falsy-on-failure contract; several templates rely on
// falsy-checking the result, e.g. `{date && <time>...}` guards).
// ---------------------------------------------------------------------------

test("formatDate returns empty string for null/undefined/empty input", () => {
  assert.equal(formatDate(null, "sv"), "");
  assert.equal(formatDate(undefined, "sv"), "");
  assert.equal(formatDate("", "sv"), "");
  assert.equal(formatDate("   ", "sv"), "");
});

test("formatDate returns empty string for unparseable input", () => {
  assert.equal(formatDate("not-a-date", "sv"), "");
  // Out-of-range month/day: not FM-shaped (fmDateToIso's regex is shape-only,
  // it doesn't range-check, but month 13 / day 45 don't match "MM/DD/YYYY"'s
  // \d{1,2} groups any differently — the fallback `new Date(...)` parse of
  // the raw string is what actually rejects it), and not valid as a bare
  // Date-constructor string either.
  assert.equal(formatDate("13/45/2026", "sv"), "");
});

// ---------------------------------------------------------------------------
// formatIsoDate — the machine-readable <time datetime="..."> value, which
// must stay ISO regardless of display locale (task constraint).
// ---------------------------------------------------------------------------

test("formatIsoDate returns YYYY-MM-DD for FM MM/DD/YYYY input, independent of locale", () => {
  assert.equal(formatIsoDate("07/29/2026"), "2026-07-29");
});

test("formatIsoDate returns YYYY-MM-DD for ISO input", () => {
  assert.equal(formatIsoDate("2026-07-29T14:23:00Z"), "2026-07-29");
});

test("formatIsoDate returns empty string for invalid/empty input", () => {
  assert.equal(formatIsoDate(null), "");
  assert.equal(formatIsoDate(undefined), "");
  assert.equal(formatIsoDate(""), "");
  assert.equal(formatIsoDate("garbage"), "");
});

// ---------------------------------------------------------------------------
// ICU guard: catches full-ICU silently degrading to small-ICU (English-only
// data), which would make sv-SE output come out in English with no error —
// exactly the failure mode the task asked this suite to guard against.
// ---------------------------------------------------------------------------

test("ICU guard: Swedish output actually contains a Swedish month name, not an English fallback", () => {
  const sv = formatDate("07/29/2026", "sv");
  assert.match(sv, /juli/, `expected a Swedish month name in "${sv}" — full ICU may be missing`);
  assert.doesNotMatch(sv, /July/, `Swedish output fell back to English: "${sv}"`);
});

test("ICU guard: a full pass over all twelve Swedish month names resolves correctly", () => {
  const svMonths = [
    "januari", "februari", "mars", "april", "maj", "juni",
    "juli", "augusti", "september", "oktober", "november", "december",
  ];
  for (let month = 1; month <= 12; month++) {
    const mm = String(month).padStart(2, "0");
    const result = formatDate(`${mm}/15/2026`, "sv");
    assert.equal(result, `15 ${svMonths[month - 1]} 2026`);
  }
});
