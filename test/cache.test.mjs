/**
 * src/lib/cache.ts — refresh mode (the warm-up cron) and the shared Publish
 * epoch read. The pre-existing kvCached behaviours live in
 * test/youtube-cache.test.mjs.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { cached, kvCached, readCacheVersion } from "../src/lib/cache.ts";

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  const gets = [];
  return {
    store,
    puts,
    gets,
    get: async (key, opts) => {
      gets.push([key, opts]);
      return store.has(key) ? store.get(key) : null;
    },
    put: async (key, value, opts) => {
      puts.push([key, value, opts]);
      store.set(key, value);
    },
  };
}

// Silence the stale-on-error log for the one test that provokes it.
async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test("cached: refresh re-runs the loader while an entry is still fresh, and the result replaces it", async () => {
  const ns = "cache-test-refresh";
  assert.equal(await cached(ns, { k: 1 }, async () => "v1"), "v1");
  assert.equal(await cached(ns, { k: 1 }, async () => "v2"), "v1", "fresh entry is reused without refresh");
  assert.equal(await cached(ns, { k: 1 }, async () => "v3", undefined, { refresh: true }), "v3", "refresh runs the loader");
  assert.equal(await cached(ns, { k: 1 }, async () => "v4"), "v3", "…and the refreshed value is what later callers see");
});

test("cached: a failing refresh keeps stale-on-error — the previous good value is served", async () => {
  const ns = "cache-test-refresh-stale";
  assert.equal(await cached(ns, { k: 1 }, async () => "good"), "good");
  const served = await quietly(() =>
    cached(ns, { k: 1 }, async () => { throw new Error("FM down"); }, undefined, { refresh: true }),
  );
  assert.equal(served, "good", "a refresh that fails must not surface an error the normal path would have hidden");
});

test("cached: refresh with no previous value still throws (never caches an empty site)", async () => {
  const ns = "cache-test-refresh-empty";
  await assert.rejects(
    () => cached(ns, { k: 1 }, async () => { throw new Error("boom"); }, undefined, { refresh: true }),
    /boom/,
  );
});

test("kvCached: refresh skips the KV read and always runs fn + put", async () => {
  const kv = fakeKv({ "k:1": JSON.stringify("cached") });
  let calls = 0;
  const value = await kvCached(kv, "k:1", 3600, async () => { calls++; return "fresh"; }, { refresh: true });
  assert.equal(value, "fresh");
  assert.equal(calls, 1);
  assert.equal(kv.gets.length, 0, "no get in refresh mode");
  assert.deepEqual(kv.puts, [["k:1", JSON.stringify("fresh"), { expirationTtl: 3600 }]]);
});

test("kvCached: without refresh a hit still short-circuits (regression guard for the option default)", async () => {
  const kv = fakeKv({ "k:2": JSON.stringify("cached") });
  let calls = 0;
  assert.equal(await kvCached(kv, "k:2", 3600, async () => { calls++; return "fresh"; }, {}), "cached");
  assert.equal(calls, 0);
});

test("readCacheVersion: reads the epoch with cacheTtl 60, '0' when absent, broken or unbound", async () => {
  const kv = fakeKv({ "cache-version": "7" });
  assert.equal(await readCacheVersion(kv), "7");
  assert.deepEqual(kv.gets, [["cache-version", { cacheTtl: 60 }]]);

  assert.equal(await readCacheVersion(fakeKv()), "0");
  assert.equal(await readCacheVersion(null), "0");
  assert.equal(await readCacheVersion(undefined), "0");
  assert.equal(await readCacheVersion({ get: async () => { throw new Error("kv down"); }, put: async () => {} }), "0");
});

test("readCacheVersion: no in-isolate memo — a Publish is observed on the very next read", async () => {
  const kv = fakeKv({ "cache-version": "1" });
  assert.equal(await readCacheVersion(kv), "1");
  kv.store.set("cache-version", "2"); // Publish
  assert.equal(await readCacheVersion(kv), "2");
});

// Cross-request sharing (2026-09-19). On Workers a fetch belongs to the request
// that started it and dies with that request, so an in-flight promise shared at
// module level can be one that never settles. The same hazard hung pages through
// the translation reads (v0.2.5.4); these pin the guard for the FM response cache
// and, through the shared helper, the FM session token.
test("cached: a caller joining an in-flight load that never settles runs its own load after the bound", async () => {
  const { setForeignWaitForTests } = await import("../src/lib/cache.ts");
  setForeignWaitForTests(40);
  try {
    let runs = 0;
    const payload = { q: `orphan-${Date.now()}` };
    // Request A: its loader hangs forever (the request ended mid-fetch).
    cached("fm-orphan", payload, () => { runs++; return new Promise(() => {}); }).catch(() => {});
    // Request B: same key, a loader that works.
    const HUNG = Symbol("hung");
    const b = await Promise.race([
      cached("fm-orphan", payload, async () => { runs++; return ["fresh"]; }),
      new Promise((r) => setTimeout(() => r(HUNG), 1500)),
    ]);
    assert.notEqual(b, HUNG, "request B must not wait forever on request A's dead load");
    assert.deepEqual(b, ["fresh"]);
    assert.equal(runs, 2);
    // The working load replaced the dead entry: a third caller is served from it.
    assert.deepEqual(await cached("fm-orphan", payload, async () => { runs++; return ["again"]; }), ["fresh"]);
    assert.equal(runs, 2);
  } finally {
    setForeignWaitForTests(null);
  }
});

test("cached: a caller joining a LIVE in-flight load still shares it (dedupe unchanged)", async () => {
  const { setForeignWaitForTests } = await import("../src/lib/cache.ts");
  setForeignWaitForTests(500);
  try {
    let runs = 0;
    const payload = { q: `live-${Date.now()}` };
    const slow = () => { runs++; return new Promise((r) => setTimeout(() => r(["one"]), 30)); };
    const [a, b] = await Promise.all([cached("fm-live", payload, slow), cached("fm-live", payload, slow)]);
    assert.deepEqual(a, ["one"]);
    assert.deepEqual(b, ["one"]);
    assert.equal(runs, 1);
  } finally {
    setForeignWaitForTests(null);
  }
});

test("boundedJoin: settles with the shared job when it is alive, falls back when it is dead, and passes rejections through", async () => {
  const { boundedJoin } = await import("../src/lib/cache.ts");
  assert.equal(await boundedJoin(Promise.resolve("shared"), 50, async () => "fallback"), "shared");
  assert.equal(await boundedJoin(new Promise(() => {}), 30, async () => "fallback"), "fallback");
  await assert.rejects(boundedJoin(Promise.reject(new Error("boom")), 50, async () => "fallback"), /boom/);
});
