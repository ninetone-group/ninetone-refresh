import assert from "node:assert/strict";
import test from "node:test";

import { slugifyTag } from "../src/lib/booking-slug.ts";

// Verified against every current API_BOOKING_TAG value (see
// docs/seo-phase-1-brief.md Section 6 and the orchestrator's facts file for
// this batch) — this is the canonical transliteration used for both the
// booking index's in-page anchors and the Section 6 category page slugs.
test("slugifyTag: lowercases plain ASCII tags", () => {
  assert.equal(slugifyTag("Artist"), "artist");
  assert.equal(slugifyTag("Influencer"), "influencer");
  assert.equal(slugifyTag("Moderator"), "moderator");
});

test("slugifyTag: strips Swedish diacritics rather than percent-encoding them", () => {
  assert.equal(slugifyTag("Föreläsare"), "forelasare");
  assert.equal(slugifyTag("Underhållare"), "underhallare");
});

test("slugifyTag: leaves an already-plain multi-syllable tag untouched but lowercased", () => {
  assert.equal(slugifyTag("Konferencier"), "konferencier");
});

test("slugifyTag: collapses non-alphanumeric runs to a single hyphen and trims leading/trailing hyphens", () => {
  assert.equal(slugifyTag("  Multi   Word!! "), "multi-word");
  assert.equal(slugifyTag("--leading and trailing--"), "leading-and-trailing");
});
