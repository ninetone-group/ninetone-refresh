import assert from "node:assert/strict";
import test from "node:test";

import { pickOfTheWeek, weekSlot } from "../src/lib/rotation.ts";

const DAY = 86_400_000;
const MONDAY = Date.UTC(2026, 9, 12, 0, 0, 0); // 2026-10-12 is a Monday

test("the artist slot steps exactly at Monday 00:00 UTC", () => {
  assert.equal(weekSlot(MONDAY - 1), weekSlot(MONDAY) - 1);
  assert.equal(weekSlot(MONDAY), weekSlot(MONDAY + 6 * DAY + 23 * 3_600_000));
});

test("the client slot, offset half a week, steps at Thursday 12:00 UTC and never together with the artist", () => {
  const thursdayNoon = MONDAY + 3.5 * DAY;
  assert.equal(weekSlot(thursdayNoon - 1, 3.5), weekSlot(thursdayNoon, 3.5) - 1);
  // across a whole week, sampled hourly, the two slots never change in the same hour
  for (let t = MONDAY; t < MONDAY + 7 * DAY; t += 3_600_000) {
    const artistStep = weekSlot(t) !== weekSlot(t - 3_600_000);
    const clientStep = weekSlot(t, 3.5) !== weekSlot(t - 3_600_000, 3.5);
    assert.ok(!(artistStep && clientStep), new Date(t).toISOString());
  }
});

test("pickOfTheWeek walks the pool in order and copes with an empty pool", () => {
  const pool = ["a", "b", "c"];
  const first = pickOfTheWeek(pool, MONDAY);
  assert.equal(pickOfTheWeek(pool, MONDAY + 7 * DAY), pool[(pool.indexOf(first) + 1) % 3]);
  assert.equal(pickOfTheWeek(pool, MONDAY + 3 * DAY), first);
  assert.equal(pickOfTheWeek([], MONDAY), undefined);
});
