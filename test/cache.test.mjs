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
