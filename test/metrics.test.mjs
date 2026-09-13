import assert from "node:assert/strict";
import test from "node:test";

import { liveRosterCount, roundedPlus, yearsSince, FOUNDED_YEAR } from "../src/lib/metrics.ts";

test("liveRosterCount unions the divisions by slug, so a cross-listed artist counts once", () => {
  const records = [{ SLUG: "a" }, { SLUG: "b" }, { SLUG: "c" }];
  const management = [{ SLUG: "b" }, { SLUG: "d" }];
  const nation = [{ SLUG: "a" }, { SLUG: "e" }, { SLUG: " e " }];
  assert.equal(liveRosterCount(records, management, nation), 5);
});

test("liveRosterCount ignores rows without a usable slug", () => {
  assert.equal(liveRosterCount([{ SLUG: "" }, { SLUG: null }, {}, { SLUG: "x" }]), 1);
  assert.equal(liveRosterCount(), 0);
});

test("roundedPlus rounds DOWN to tens with a plus, exact below ten", () => {
  assert.equal(roundedPlus(87), "80+");
  assert.equal(roundedPlus(90), "90+");
  assert.equal(roundedPlus(342), "340+");
  assert.equal(roundedPlus(9), "9");
  assert.equal(roundedPlus(0), "0");
});

test("yearsSince counts whole years from 2006 and never goes negative", () => {
  assert.equal(FOUNDED_YEAR, 2006);
  assert.equal(yearsSince(2006, new Date("2026-09-13")), 20);
  assert.equal(yearsSince(2006, new Date("2006-01-01")), 0);
  assert.equal(yearsSince(2030, new Date("2026-01-01")), 0);
});
