import assert from "node:assert/strict";
import test from "node:test";

import { displayTitle, paginatedTitle, shouldAppendSiteName, taglineWithoutName } from "../src/lib/display-title.ts";

test("plain title is unchanged", () => {
  assert.equal(displayTitle("Artists"), "Artists");
});

test("strips a trailing pipe-separated Ninetone brand suffix", () => {
  assert.equal(
    displayTitle("Top Music Production & Artist Branding | Ninetone Records"),
    "Top Music Production & Artist Branding",
  );
});

test("strips an en-dash or em-dash Ninetone brand suffix", () => {
  assert.equal(displayTitle("Entertainers – Ninetone Nation"), "Entertainers");
  assert.equal(displayTitle("Entertainers — Ninetone Nation"), "Entertainers");
});

test("leaves a non-Ninetone suffix alone", () => {
  assert.equal(displayTitle("A | B"), "A | B");
});

test("trims surrounding whitespace", () => {
  assert.equal(displayTitle("  Artists  "), "Artists");
  assert.equal(displayTitle("  Artists | Ninetone Records  "), "Artists");
});

test("handles missing/empty input", () => {
  assert.equal(displayTitle(undefined), "");
  assert.equal(displayTitle(null), "");
  assert.equal(displayTitle(""), "");
  assert.equal(displayTitle("   "), "");
});

// seo-phase-1b-brief.md P1 item 7: pagination titles.
test("paginatedTitle: page 1 is unchanged", () => {
  assert.equal(paginatedTitle("Previous Artists", 1), "Previous Artists");
});

test("paginatedTitle: appends ' · Sida N' for page 2 and beyond", () => {
  assert.equal(paginatedTitle("Previous Artists", 2), "Previous Artists · Sida 2");
  assert.equal(paginatedTitle("Previous Artists", 12), "Previous Artists · Sida 12");
});

test("paginatedTitle: English pages say 'Page', not 'Sida'", () => {
  assert.equal(paginatedTitle("Previous Artists", 2, "en"), "Previous Artists · Page 2");
  assert.equal(paginatedTitle("Previous Artists", 1, "en"), "Previous Artists");
  assert.equal(paginatedTitle("Previous Artists", 2, "sv"), "Previous Artists · Sida 2");
});

// seo-phase-1b-brief.md P1 item 7: news titles drop the Base suffix when the
// FM headline is already long.
test("shouldAppendSiteName: true for a title at or under 60 characters", () => {
  assert.equal(shouldAppendSiteName("A".repeat(60)), true);
  assert.equal(shouldAppendSiteName("Short headline"), true);
});

test("shouldAppendSiteName: false once the title exceeds 60 characters", () => {
  assert.equal(shouldAppendSiteName("A".repeat(61)), false);
  assert.equal(
    shouldAppendSiteName(
      "This is a deliberately long news headline that blows past the sixty character mark",
    ),
    false,
  );
});

test("shouldAppendSiteName: trims surrounding whitespace before measuring length", () => {
  assert.equal(shouldAppendSiteName(`  ${"A".repeat(60)}  `), true);
});

// Headlines as Office returned them on 2026-11-10.
test("taglineWithoutName: a headline that opens with the name loses it and starts with a capital", () => {
  assert.equal(
    taglineWithoutName("Walter FM – gitarrdriven indie mellan vemod och hopp", "Walter FM"),
    "Gitarrdriven indie mellan vemod och hopp",
  );
  assert.equal(taglineWithoutName("Karakou - En resa genom hjärtskärande indierock", "Karakou"), "En resa genom hjärtskärande indierock");
  assert.equal(taglineWithoutName("Hälsingefyr: rock, folkton och hälsingehumor", "Hälsingefyr"), "Rock, folkton och hälsingehumor");
});

test("taglineWithoutName: the name is matched whatever its letter case and spacing", () => {
  assert.equal(taglineWithoutName("ANJO – dokumentära berättelser, personliga samtal och musik", "Anjo"), "Dokumentära berättelser, personliga samtal och musik");
  assert.equal(taglineWithoutName(" Tim Liljegren – från rallyskogen till dansgolvet", "Tim  Liljegren "), "Från rallyskogen till dansgolvet");
  assert.equal(taglineWithoutName("J.O.X – svenska melodier möter elektronisk dansenergi", "J.O.X"), "Svenska melodier möter elektronisk dansenergi");
});

test("taglineWithoutName: a headline that does not open with the name and a separator is left alone", () => {
  // Stage name in the headline, legal name on the record.
  assert.equal(taglineWithoutName("Guldleo – spelglädje, humor och digitala idéer", "Leo Johansson"), "Guldleo – spelglädje, humor och digitala idéer");
  // The name is only the start of a longer word or phrase.
  assert.equal(taglineWithoutName("Mika-fans samlas i Göteborg", "Mika"), "Mika-fans samlas i Göteborg");
  assert.equal(taglineWithoutName("Apollo tar nästa steg", "Apollo"), "Apollo tar nästa steg");
  // Nothing after the name: keep the line rather than show an empty tile.
  assert.equal(taglineWithoutName("Karakou –", "Karakou"), "Karakou –");
  assert.equal(taglineWithoutName("", "Karakou"), "");
  assert.equal(taglineWithoutName(undefined, undefined), "");
  assert.equal(taglineWithoutName("Svensk indiepop", ""), "Svensk indiepop");
});
