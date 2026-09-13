import assert from "node:assert/strict";
import test from "node:test";

import {
  countReleases,
  readReleaseCount,
  refreshReleaseCount,
  RELEASE_COUNT_KEY,
  RELEASE_COUNT_CRON,
  RELEASE_COUNT_TTL_SECONDS,
} from "../src/lib/release-count.ts";

const P = "Green Web Category";
const artist = (slug, albums) => ({
  fieldData: { SLUG: slug },
  portalData: { [P]: albums.map((a) => ({ [`${P}::Album`]: a, [`${P}::Type`]: "Single" })) },
});

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  return {
    store,
    puts,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, o) { puts.push([k, v, o]); store.set(k, v); },
  };
}

test("countReleases counts distinct (artist, album) pairs and skips rows without an album", () => {
  const artists = [
    artist("a", ["One", "Two", "Two", "  "]), // duplicate + blank → 2
    artist("b", ["One"]), // same title, other artist → counts
    { fieldData: { SLUG: "c" } }, // no portal → 0
    artist("d", []),
  ];
  assert.equal(countReleases(artists), 3);
  assert.equal(countReleases([]), 0);
});

test("refreshReleaseCount stores { count, at } with the 8-day TTL", async () => {
  const kv = fakeKv();
  const value = await refreshReleaseCount({
    kv,
    load: async () => [artist("a", ["X", "Y"])],
    now: () => new Date("2026-09-14T04:00:00Z"),
  });
  assert.deepEqual(value, { count: 2, at: "2026-09-14T04:00:00.000Z" });
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0][0], RELEASE_COUNT_KEY);
  assert.deepEqual(kv.puts[0][2], { expirationTtl: RELEASE_COUNT_TTL_SECONDS });
  assert.deepEqual(await readReleaseCount(kv), value);
});

test("a zero count never overwrites the stored number", async () => {
  const kv = fakeKv({ [RELEASE_COUNT_KEY]: JSON.stringify({ count: 2152, at: "x" }) });
  const value = await refreshReleaseCount({ kv, load: async () => [] });
  assert.equal(value, null);
  assert.equal(kv.puts.length, 0);
  assert.equal((await readReleaseCount(kv)).count, 2152);
});

test("readReleaseCount returns null for no KV, no key, or garbage — the page then falls back", async () => {
  assert.equal(await readReleaseCount(null), null);
  assert.equal(await readReleaseCount(fakeKv()), null);
  assert.equal(await readReleaseCount(fakeKv({ [RELEASE_COUNT_KEY]: "not json" })), null);
  assert.equal(await readReleaseCount(fakeKv({ [RELEASE_COUNT_KEY]: JSON.stringify({ count: -1 }) })), null);
});

test("the nightly cron expression is a single daily tick, not the five-minute one", () => {
  assert.equal(RELEASE_COUNT_CRON, "0 4 * * *");
});
