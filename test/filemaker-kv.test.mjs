/**
 * Cross-isolate KV read-through for FM finds (src/lib/fm-kv.ts, 2026-09-12).
 * Drives fmFindViaKv() with an injected KV; no FM, no network.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FM_KV_WARM_TTL_SECONDS, fmFindViaKv, fmKvKey } from "../src/lib/fm-kv.ts";

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  const gets = [];
  return {
    store,
    puts,
    gets,
    async get(key, opts) {
      gets.push([key, opts]);
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      puts.push([key, value, opts]);
      store.set(key, value);
    },
  };
}

const BODY = { query: [{ SLUG: "*" }], limit: 1000, portal: [] };

test("no KV binding → the loader runs directly", async () => {
  let calls = 0;
  const rows = await fmFindViaKv(null, "API_ARTIST", BODY, false, async () => { calls++; return [{ a: 1 }]; });
  assert.deepEqual(rows, [{ a: 1 }]);
  assert.equal(calls, 1);
});

test("first read fills KV (300 s TTL); a second isolate's read costs no FM call", async () => {
  const kv = fakeKv({ "cache-version": "7" });
  let calls = 0;
  const loader = async () => { calls++; return [{ SLUG: "x", bio: "…" }]; };

  const first = await fmFindViaKv(kv, "API_ARTIST_DETAIL", BODY, false, loader);
  assert.deepEqual(first, [{ SLUG: "x", bio: "…" }]);
  assert.equal(calls, 1);
  assert.equal(kv.puts.length, 1);
  const [key, value, opts] = kv.puts[0];
  assert.match(key, /^fm:v1:7:f:API_ARTIST_DETAIL:[0-9a-f]{64}$/, "epoch, shape, layout and body hash in the key");
  assert.deepEqual(JSON.parse(value), first);
  assert.equal(opts.expirationTtl, 300);

  // "Another isolate": same KV, fresh loader that must not be reached.
  const second = await fmFindViaKv(kv, "API_ARTIST_DETAIL", BODY, false, async () => { throw new Error("FM must not be called"); });
  assert.deepEqual(second, first);
});

test("the Publish epoch is part of the key, so a Publish forces a live FM read", async () => {
  const a = await fmKvKey("7", "API_NEWS", BODY, false);
  const b = await fmKvKey("8", "API_NEWS", BODY, false);
  assert.notEqual(a, b);
  const p = await fmKvKey("7", "API_NEWS", BODY, true);
  assert.notEqual(a, p, "portal-shaped results are keyed apart from flat ones");
  const other = await fmKvKey("7", "API_NEWS", { ...BODY, limit: 500 }, false);
  assert.notEqual(a, other, "a different query body is a different key");
});

test("an empty result is cached only briefly (negative-result guard) and a KV failure falls through to FM", async () => {
  const kv = fakeKv({ "cache-version": "7" });
  await fmFindViaKv(kv, "API_NEWS", BODY, false, async () => []);
  assert.equal(kv.puts.at(-1)[2].expirationTtl, 300);

  const broken = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } };
  const original = console.error;
  console.error = () => {};
  try {
    const rows = await fmFindViaKv(broken, "API_NEWS", BODY, false, async () => [{ ok: true }]);
    assert.deepEqual(rows, [{ ok: true }]);
  } finally {
    console.error = original;
  }
});

test("a Publish epoch change is observed on the very next read — no in-isolate memo", async () => {
  const kv = fakeKv({ "cache-version": "1" });
  await fmFindViaKv(kv, "API_NEWS", BODY, false, async () => [{ v: 1 }]);
  assert.match(kv.puts.at(-1)[0], /^fm:v1:1:/);
  kv.store.set("cache-version", "2"); // Publish
  let calls = 0;
  const rows = await fmFindViaKv(kv, "API_NEWS", BODY, false, async () => { calls++; return [{ v: 2 }]; });
  assert.equal(calls, 1, "the new epoch misses the old entry and re-reads FM");
  assert.deepEqual(rows, [{ v: 2 }]);
  assert.match(kv.puts.at(-1)[0], /^fm:v1:2:/);
});

// ---------------------------------------------------------------------------
// Refresh mode — the warm-up cron (src/lib/fm-warm.ts)
// ---------------------------------------------------------------------------

test("refresh mode skips the KV read, runs the loader, and writes with the 360 s warm TTL", async () => {
  const kv = fakeKv({ "cache-version": "7" });
  // Seed a fresh-looking entry under exactly the key a normal read would use.
  const key = await fmKvKey("7", "API_NEWS", BODY, false);
  kv.store.set(key, JSON.stringify([{ stale: true }]));

  let calls = 0;
  const rows = await fmFindViaKv(kv, "API_NEWS", BODY, false, async () => { calls++; return [{ fresh: true }]; }, { refresh: true });
  assert.deepEqual(rows, [{ fresh: true }], "a refresh never returns the cached entry");
  assert.equal(calls, 1);
  assert.ok(!kv.gets.some(([k]) => k === key), "the entry itself is never read in refresh mode");
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0][0], key, "…but it IS overwritten under the same key the render path reads");
  assert.equal(kv.puts[0][2].expirationTtl, 360, "300 s + 60 s grace so a */5 cron always lands first");
  assert.equal(FM_KV_WARM_TTL_SECONDS, 360);

  // A normal read afterwards is served from the refreshed entry.
  const next = await fmFindViaKv(kv, "API_NEWS", BODY, false, async () => { throw new Error("FM must not be called"); });
  assert.deepEqual(next, [{ fresh: true }]);
});

test("a normal (non-refresh) read still writes 300 s", async () => {
  const kv = fakeKv({ "cache-version": "7" });
  await fmFindViaKv(kv, "API_NEWS", BODY, false, async () => [{ v: 1 }], { refresh: false });
  assert.equal(kv.puts[0][2].expirationTtl, 300);
});

test("the loader receives the epoch the key was built with; no KV → undefined", async () => {
  const kv = fakeKv({ "cache-version": "7" });
  const seen = [];
  await fmFindViaKv(kv, "API_ARTIST", BODY, false, async (version) => { seen.push(version); return [{ a: 1 }]; });
  assert.deepEqual(seen, ["7"], "the image URLs inside an entry must carry the same epoch as its key");

  await fmFindViaKv(kv, "API_ARTIST", { ...BODY, limit: 5 }, false, async (version) => { seen.push(version); return [{ a: 1 }]; }, { refresh: true });
  assert.deepEqual(seen, ["7", "7"], "refresh mode passes it too");

  await fmFindViaKv(null, "API_ARTIST", BODY, false, async (version) => { seen.push(version); return [{ a: 1 }]; });
  assert.equal(seen[2], undefined, "no binding means no epoch (static build) — the URL stays bare");
});
