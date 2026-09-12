import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { resolveFmDisplayText } from "../src/lib/t.ts";

/**
 * RosterIndex's `blurbsTranslated` prop is a NAKED ASSERTION: when it is set,
 * resolveFmDisplayText returns the caller's string untouched. Nothing at
 * runtime checks that the string really was translated, and nothing can —
 * on a translation miss the source text IS the intended render, so a page
 * that wrongly claims `blurbsTranslated` looks completely healthy: correct
 * layout, right row count, no error, no blank, no console warning. The only
 * symptom is Swedish prose sitting on an English page until a human notices.
 *
 * This bit us once already. management/clients.astro pre-translated into
 * `clientPresentationString` (what its CARDS read) while RosterIndex reads
 * `artistPresentationShort` — which the object spread carried through
 * untranslated. Adding `blurbsTranslated` to that caller therefore asserted
 * something false and would have shipped a Swedish A-Ö index on /en.
 *
 * These tests pin the contract at the two places it can break: the helper's
 * own semantics, and every caller that claims the flag.
 */

const FIELD = "artistPresentationShort";

/** Callers that pass `blurbsTranslated` must pre-translate FIELD themselves. */
const ASSERTING_CALLERS = [
  "src/pages/records/artists.astro",
  "src/pages/management/clients.astro",
];

/**
 * The previous-artists page deliberately does NOT assert the flag: it hands
 * RosterIndex `allPrevious`, a different (and untranslated) array from the
 * 30-record page slice it pre-translates. It must keep letting the component
 * translate, or ~311 Swedish blocks reappear on /en.
 */
const NON_ASSERTING_CALLERS = ["src/pages/records/artists/previous/[...page].astro"];

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("resolveFmDisplayText passes through only when the caller asserts translation", async () => {
  let calls = 0;
  const translate = async (text) => {
    calls += 1;
    return `EN[${text}]`;
  };

  assert.equal(await resolveFmDisplayText("Svenska", translate, true), "Svenska");
  assert.equal(calls, 0, "an asserting caller must not trigger a translation");

  assert.equal(await resolveFmDisplayText("Svenska", translate, false), "EN[Svenska]");
  assert.equal(calls, 1, "a non-asserting caller must still be translated");
});

test("RosterIndex reads the field these tests pin", () => {
  const src = read("src/components/RosterIndex.astro");
  assert.match(
    src,
    new RegExp(`resolveFmDisplayText\\(\\s*String\\(a\\.${FIELD}`),
    `RosterIndex no longer resolves ${FIELD}; update ASSERTING_CALLERS to match the new field`,
  );
});

for (const caller of ASSERTING_CALLERS) {
  test(`${caller} pre-translates ${FIELD} before claiming blurbsTranslated`, () => {
    const src = read(caller);

    assert.ok(
      /<RosterIndex[^>]*blurbsTranslated/s.test(src),
      `${caller} is listed as asserting but no longer passes blurbsTranslated`,
    );

    // The assertion is only honest if the very field RosterIndex reads is
    // reassigned from an await fm(...) call in this file's frontmatter.
    assert.match(
      src,
      new RegExp(`${FIELD}:\\s*await fm\\(`),
      `${caller} claims blurbsTranslated but never awaits fm() into ${FIELD} — ` +
        `RosterIndex would render untranslated prose on /en with no visible symptom`,
    );
  });
}

for (const caller of NON_ASSERTING_CALLERS) {
  test(`${caller} lets RosterIndex translate its own inputs`, () => {
    const src = read(caller);
    assert.ok(
      !/<RosterIndex[^>]*blurbsTranslated/s.test(src),
      `${caller} passes RosterIndex a different array than the one it pre-translates; ` +
        `asserting blurbsTranslated there reintroduces Swedish blocks on /en`,
    );
  });
}
