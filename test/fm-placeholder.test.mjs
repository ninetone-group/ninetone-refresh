import assert from "node:assert/strict";
import test from "node:test";

import { isPlaceholderProse, withoutPlaceholder } from "../src/lib/fm-placeholder.ts";

// Both variants seen in API_Management on 2026-09-14 (49 + 15 records): the
// second has a space after the CR, and FM delivers CR line endings.
const variantA = "-----Placeholder Text-----\rThe main goal is to establish the artst (Artist Names) in the market as one of the big name’s (Genré) artist’s";
const variantB = "-----Placeholder Text-----\r The main goal is to establish the artist (Artist Names) in the market";

test("isPlaceholderProse: recognises the FM placeholder template in both observed variants", () => {
  assert.equal(isPlaceholderProse(variantA), true);
  assert.equal(isPlaceholderProse(variantB), true);
  assert.equal(isPlaceholderProse("  ---placeholder text---  whatever"), true);
  assert.equal(isPlaceholderProse("---- PLACEHOLDER TEXT ----"), true);
});

test("isPlaceholderProse: real prose stays, even when it mentions placeholders or opens with a rule", () => {
  assert.equal(isPlaceholderProse("Alexandra Nilsson, född 18 april 1991 i Stockholm, är en placeholder-fri artist."), false);
  assert.equal(isPlaceholderProse("--- Ett riktigt citat ---\rBandet bildades 2009."), false);
  assert.equal(isPlaceholderProse(""), false);
  assert.equal(isPlaceholderProse(undefined), false);
  assert.equal(isPlaceholderProse(null), false);
  // The marker must open the text — a bio that quotes it later is still a bio.
  assert.equal(isPlaceholderProse("Riktig text.\r-----Placeholder Text-----"), false);
});

test("withoutPlaceholder: blanks a placeholder, passes real text through unchanged", () => {
  assert.equal(withoutPlaceholder(variantA), "");
  assert.equal(withoutPlaceholder("Riktig biografi."), "Riktig biografi.");
  assert.equal(withoutPlaceholder(undefined), "");
});
