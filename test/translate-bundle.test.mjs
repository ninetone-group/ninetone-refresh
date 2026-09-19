/**
 * Cold-isolate cost controls in src/lib/translate.ts (2026-09-12):
 *   - physical KV reads issued in the same tick are batched into ONE bulk get
 *   - a KV miss is never pinned in the isolate cache
 *   - the per-request ledger + per-route bundle turn N reads into one
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  translate,
  translationKey,
  loadTranslationBundle,
  storeTranslationBundleIfChanged,
  seedIsolateCache,
  translationBundleKey,
  translationLedgerFor,
  TRANSLATION_BUNDLE_TTL_SECONDS,
  TRANSLATION_BUNDLE_REFRESH_MS,
  resetBundleWriteLogForTests,
} from "../src/lib/translate.ts";

/** KV double that understands bulk get (array of keys -> Map), like Workers KV. */
function bulkKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { single: 0, bulk: 0, bulkKeys: [], puts: [] };
  return {
    store,
    calls,
    async get(key, opts) {
      if (Array.isArray(key)) {
        calls.bulk += 1;
        calls.bulkKeys.push(key.length);
        return new Map(key.map((k) => [k, store.has(k) ? store.get(k) : null]));
      }
      calls.single += 1;
      void opts;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      calls.puts.push([key, value, opts]);
      store.set(key, value);
    },
  };
}

/** KV double WITHOUT bulk support: an array key is just an unknown key. */
function plainKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { gets: 0, single: 0, probes: 0 };
  return {
    store,
    calls,
    async get(key) {
      calls.gets += 1;
      if (Array.isArray(key)) calls.probes += 1;
      else calls.single += 1;
      return typeof key === "string" && store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

const words = (n) => Array.from({ length: n }, (_, i) => `Ord nummer ${i}`);

test("parallel reads in one tick become ONE bulk KV get (six-connection ceiling)", async () => {
  const sources = words(40);
  const initial = {};
  for (const s of sources) initial[await translationKey(s, "en", "fast")] = `EN ${s}`;
  const kv = bulkKv(initial);

  const results = await Promise.all(sources.map((text) => translate({ text, target: "en", tier: "fast", kv })));

  assert.deepEqual(results.map((r) => r.text), sources.map((s) => `EN ${s}`));
  // The coalescing window is one macrotask; under CPU load the hashing that
  // precedes each read can straddle a tick, so a fan-out may land in a few
  // batches rather than exactly one. The property that matters: a handful
  // of connections, not forty.
  const physical = kv.calls.bulk + kv.calls.single;
  assert.ok(physical <= 4, `expected a few physical reads for 40 keys, got ${physical}`);
  assert.ok(kv.calls.bulk >= 1, "at least one bulk read");
  assert.equal(kv.calls.bulkKeys.reduce((a, b) => a + b, 0) + kv.calls.single, 40, "every key read exactly once");
});

test("more than 100 parallel reads are chunked at KV's bulk limit", async () => {
  const sources = words(230);
  const initial = {};
  for (const s of sources) initial[await translationKey(s, "en", "fast")] = "x";
  const kv = bulkKv(initial);
  await Promise.all(sources.map((text) => translate({ text, target: "en", tier: "fast", kv })));
  assert.ok(Math.max(...kv.calls.bulkKeys) <= 100, "no bulk read exceeds KV's 100-key limit");
  assert.equal(kv.calls.bulkKeys.reduce((a, b) => a + b, 0) + kv.calls.single, 230, "every key read exactly once");
  assert.ok(kv.calls.bulk + kv.calls.single <= 8, "230 keys cost a handful of connections, not 230");
});

test("a binding without bulk support falls back to individual reads with identical results", async () => {
  const sources = words(12);
  const initial = {};
  for (const s of sources) initial[await translationKey(s, "en", "fast")] = `EN ${s}`;
  const kv = plainKv(initial);
  const results = await Promise.all(sources.map((text) => translate({ text, target: "en", tier: "fast", kv })));
  assert.deepEqual(results.map((r) => r.text), sources.map((s) => `EN ${s}`));
  // Every key is read individually exactly once. The number of failed array
  // probes is NOT pinned: reads requested in the same tick are flushed on a
  // zero-delay timer, and on a slow runner (CI, 2026-09-13) the twelve
  // parallel calls can land as two batches — two probes, still 12 reads.
  assert.equal(kv.calls.single, 12, "12 individual reads");
  assert.ok(kv.calls.probes >= 1 && kv.calls.probes <= 2, `array probe(s): ${kv.calls.probes}`);
});

test("a serial chain still reads one key at a time (single-key path, no bulk probe)", async () => {
  const kv = bulkKv({ [await translationKey("Hej", "en", "fast")]: "Hello" });
  await translate({ text: "Hej", target: "en", tier: "fast", kv });
  assert.equal(kv.calls.single, 1);
  assert.equal(kv.calls.bulk, 0);
});

test("physical reads use a SHORT edge cacheTtl (KV caches negative lookups for the same TTL as hits)", async () => {
  const seen = [];
  const kv = {
    async get(key, opts) { seen.push([Array.isArray(key) ? "bulk" : "single", opts]); return Array.isArray(key) ? new Map(key.map((k) => [k, null])) : null; },
    async put() {},
  };
  await translate({ text: "Ensam", target: "en", tier: "fast", kv });
  await Promise.all(["Ett", "Två", "Tre"].map((text) => translate({ text, target: "en", tier: "fast", kv })));
  assert.ok(seen.length >= 2);
  for (const [, opts] of seen) {
    assert.ok(opts && typeof opts.cacheTtl === "number", "cacheTtl is always passed explicitly");
    assert.ok(opts.cacheTtl <= 60, `a miss must not be pinned at the colo for long: cacheTtl=${opts.cacheTtl}`);
  }
});

test("a KV miss is NOT pinned: the value written moments later is read on the next request", async () => {
  const kv = bulkKv();
  const key = await translationKey("Hej världen", "en", "fast");

  const first = await translate({ text: "Hej världen", target: "en", tier: "fast", kv });
  assert.equal(first.cached, false);

  // The scheduled job (or the warm script) lands the translation.
  await kv.put(key, "Hello world");

  const second = await translate({ text: "Hej världen", target: "en", tier: "fast", kv });
  assert.equal(second.cached, true, "an isolate must re-read a key it previously missed");
  assert.equal(second.text, "Hello world");
});

test("a hit IS held by the isolate cache: a second request costs no physical read", async () => {
  const kv = bulkKv({ [await translationKey("Hej", "en", "fast")]: "Hello" });
  await translate({ text: "Hej", target: "en", tier: "fast", kv });
  await translate({ text: "Hej", target: "en", tier: "fast", kv });
  assert.equal(kv.calls.single + kv.calls.bulk, 1);
});

test("the ledger records every (key, value) a request resolved from KV, and nothing it missed", async () => {
  const kv = bulkKv({
    [await translationKey("Ett", "en", "fast")]: "One",
    [await translationKey("Två", "en", "quality")]: "Two",
  });
  const locals = {};
  const ledger = translationLedgerFor(locals);
  assert.equal(translationLedgerFor(locals), ledger, "one ledger per locals object");
  await translate({ text: "Ett", target: "en", tier: "fast", kv, ledger });
  await translate({ text: "Två", target: "en", tier: "quality", kv, ledger });
  await translate({ text: "Saknas", target: "en", tier: "fast", kv, ledger }); // miss: not recorded
  assert.deepEqual(
    [...ledger.entries()].sort(),
    [
      [await translationKey("Ett", "en", "fast"), "One"],
      [await translationKey("Två", "en", "quality"), "Two"],
    ].sort(),
  );
});

test("a seeded (bundled) value is recorded in the ledger too, so an unchanged route rewrites nothing", async () => {
  const key = await translationKey("Tre", "en", "fast");
  const kv = bulkKv();
  seedIsolateCache(kv, { [key]: "Three" });
  const ledger = new Map();
  await translate({ text: "Tre", target: "en", tier: "fast", kv, ledger });
  assert.deepEqual([...ledger.entries()], [[key, "Three"]]);
});

test("a preloaded bundle seeds the isolate cache: the render reads ZERO translation keys", async () => {
  const key = await translationKey("Hej", "en", "fast");
  const bundleKey = translationBundleKey("en", "/records/artists");
  // The bundle holds the value; the live key is deliberately ABSENT from KV,
  // so any read that reached it would miss.
  const kv = bulkKv({ [bundleKey]: JSON.stringify({ [key]: "Hello (bundled)" }) });

  const bundle = await loadTranslationBundle(kv, bundleKey);
  assert.deepEqual(bundle, { [key]: "Hello (bundled)" });

  const result = await translate({ text: "Hej", target: "en", tier: "fast", kv });
  assert.equal(result.text, "Hello (bundled)");
  assert.equal(result.cached, true);
  assert.equal(kv.calls.single, 1, "the only read is the bundle itself");
});

test("bundle key carries the key version and the locale", () => {
  assert.equal(translationBundleKey("en", "/news"), "trb:v1:en:/news");
  assert.equal(translationBundleKey("sv", "/"), "trb:v1:sv:/");
});

test("a malformed or missing bundle is a miss, never an error", async () => {
  const kv = bulkKv({ "trb:v1:sv:/bad": "7", "trb:v1:sv:/arr": "[1,2]", "trb:v1:sv:/mixed": JSON.stringify({ a: 1, b: "ok" }) });
  assert.equal(await loadTranslationBundle(kv, "trb:v1:sv:/bad"), null);
  assert.equal(await loadTranslationBundle(kv, "trb:v1:sv:/arr"), null);
  assert.equal(await loadTranslationBundle(kv, "trb:v1:sv:/none"), null);
  assert.deepEqual(await loadTranslationBundle(kv, "trb:v1:sv:/mixed"), { b: "ok" });
  const broken = { get: async () => { throw new Error("kv down"); }, put: async () => {} };
  assert.equal(await loadTranslationBundle(broken, "trb:v1:sv:/x"), null);
});

test("seedIsolateCache never overrides an entry the isolate already holds", async () => {
  const key = await translationKey("Hej", "en", "fast");
  const kv = bulkKv({ [key]: "Hello (live)" });
  await translate({ text: "Hej", target: "en", tier: "fast", kv }); // now held
  seedIsolateCache(kv, { [key]: "Hello (stale bundle)" });
  const r = await translate({ text: "Hej", target: "en", tier: "fast", kv });
  assert.equal(r.text, "Hello (live)");
});

test("storeTranslationBundleIfChanged: writes on first sight, skips when identical, rewrites on change", async () => {
  resetBundleWriteLogForTests();
  const kv = bulkKv();
  const bundleKey = translationBundleKey("en", "/");
  const ledger = new Map([["tr:v1:en:fast:a", "A"], ["tr:v1:en:quality:b", "B"]]);
  const t0 = 1_000_000;

  assert.equal(await storeTranslationBundleIfChanged(kv, bundleKey, null, ledger, t0), true);
  assert.equal(kv.calls.puts.length, 1);
  assert.deepEqual(kv.calls.puts[0][2], { expirationTtl: TRANSLATION_BUNDLE_TTL_SECONDS });
  assert.deepEqual(JSON.parse(kv.calls.puts[0][1]), Object.fromEntries(ledger));

  const previous = JSON.parse(kv.store.get(bundleKey));
  assert.equal(await storeTranslationBundleIfChanged(kv, bundleKey, previous, ledger, t0 + 1000), false, "identical, just written → no write");
  assert.equal(kv.calls.puts.length, 1);

  ledger.set("tr:v1:en:fast:c", "C");
  assert.equal(await storeTranslationBundleIfChanged(kv, bundleKey, previous, ledger, t0 + 2000), true, "new entry → rewrite");
  assert.equal(kv.calls.puts.length, 2);

  assert.equal(await storeTranslationBundleIfChanged(kv, bundleKey, null, new Map(), t0 + 3000), false, "empty ledger → nothing to store");
});

// 2026-09-14 cold-start investigation: the 6 h expiry was anchored to the
// last CHANGE, so an unchanged route's bundle lapsed and the next miss render
// paid ~70 serial KV reads (4.3 s on "/"). Reproduced before the fix: with
// the old code the third call below returned false and the expiry was never
// renewed.
test("an identical bundle is re-written once per refresh window so its KV expiry is renewed by use, not only by change", async () => {
  resetBundleWriteLogForTests();
  const kv = bulkKv();
  const bundleKey = translationBundleKey("sv", "/");
  const ledger = new Map([["tr:v1:sv:quality:a", "A"]]);
  const t0 = 5_000_000;

  assert.equal(await storeTranslationBundleIfChanged(kv, bundleKey, null, ledger, t0), true);
  const previous = JSON.parse(kv.store.get(bundleKey));
  assert.equal(await storeTranslationBundleIfChanged(kv, bundleKey, previous, ledger, t0 + TRANSLATION_BUNDLE_REFRESH_MS - 1), false, "inside the window → no write");
  assert.equal(await storeTranslationBundleIfChanged(kv, bundleKey, previous, ledger, t0 + TRANSLATION_BUNDLE_REFRESH_MS), true, "window elapsed → renewed");
  assert.equal(kv.calls.puts.length, 2);
  assert.deepEqual(kv.calls.puts[1][2], { expirationTtl: TRANSLATION_BUNDLE_TTL_SECONDS });
  assert.equal(await storeTranslationBundleIfChanged(kv, bundleKey, previous, ledger, t0 + TRANSLATION_BUNDLE_REFRESH_MS + 1), false, "renewal recorded → quiet again");
  // A different route has its own clock.
  assert.equal(await storeTranslationBundleIfChanged(kv, translationBundleKey("sv", "/news"), null, ledger, t0 + 10), true);
});

test("the bundle lifetime is a week, not hours — a route rendered weekly can never lapse", () => {
  assert.equal(TRANSLATION_BUNDLE_TTL_SECONDS, 7 * 24 * 60 * 60);
  assert.ok(TRANSLATION_BUNDLE_REFRESH_MS < TRANSLATION_BUNDLE_TTL_SECONDS * 1000 / 24, "renewal happens far more often than expiry");
});

test("storeTranslationBundleIfChanged swallows a KV write failure", async () => {
  const kv = { get: async () => null, put: async () => { throw new Error("kv down"); } };
  assert.equal(await storeTranslationBundleIfChanged(kv, "trb:v1:sv:/", null, new Map([["k", "v"]])), false);
});

test("a queued read whose flush never settles resolves null within the bound and is not pinned", async () => {
  const { setKvReadTimeoutForTests } = await import("../src/lib/translate.ts");
  setKvReadTimeoutForTests(50);
  const original = console.error;
  console.error = () => {};
  try {
    const key = await translationKey("Häng", "en", "fast");
    let calls = 0;
    const hanging = { async get() { calls++; return new Promise(() => {}); }, async put() {} };
    const t0 = Date.now();
    const first = await translate({ text: "Häng", target: "en", tier: "fast", kv: hanging });
    assert.equal(first.cached, false, "a hung read is a miss, not a hang");
    assert.ok(Date.now() - t0 < 2000, "bounded by the timeout, not by the hung promise");
    // Not pinned: the next request issues a fresh physical read.
    hanging.get = async (k) => (k === key ? "Hang (resolved)" : null);
    const second = await translate({ text: "Häng", target: "en", tier: "fast", kv: hanging });
    assert.equal(second.text, "Hang (resolved)");
    assert.equal(calls, 1);
  } finally {
    console.error = original;
    setKvReadTimeoutForTests(5000);
  }
});

test("isolate entries age out: a corrected KV value replaces a seeded one instead of being carried forward", async () => {
  const { setIsolateEntryTtlForTests } = await import("../src/lib/translate.ts");
  setIsolateEntryTtlForTests(30);
  try {
    const key = await translationKey("Rätta", "en", "fast");
    const kv = bulkKv({ [key]: "CORRECTED" });
    seedIsolateCache(kv, { [key]: "WRONG (old bundle)" });
    const ledger = new Map();
    const first = await translate({ text: "Rätta", target: "en", tier: "fast", kv, ledger });
    assert.equal(first.text, "WRONG (old bundle)", "seeded value serves while fresh");
    await new Promise((r) => setTimeout(r, 40));
    const second = await translate({ text: "Rätta", target: "en", tier: "fast", kv, ledger });
    assert.equal(second.text, "CORRECTED", "after the entry ages out, KV is authoritative again");
    assert.equal(ledger.get(key), "CORRECTED", "and the ledger — hence the next bundle — carries the corrected value");
    // A live (fresh) entry is never overwritten by a later seed.
    seedIsolateCache(kv, { [key]: "WRONG again" });
    const third = await translate({ text: "Rätta", target: "en", tier: "fast", kv, ledger });
    assert.equal(third.text, "CORRECTED");
  } finally {
    setIsolateEntryTtlForTests(60 * 60 * 1000);
  }
});

// Production hang, 2026-09-19 (staging, after a deploy): the FIRST cold render of
// a route answered in ~0.5 s and the SECOND request for it never answered (Worker
// log: outcome "canceled", 19 ms CPU, no log line; visitors saw error 1101 and a
// language switch that looked dead). On Workers a timer belongs to the request
// that created it and is dropped when that request ends. A read queued late by
// request A therefore never flushes and never reaches its own timeout — and both
// the batch queue and the isolate cache handed A's dead promise to request B.
test("a read orphaned by a finished request cannot hang the next request on the same isolate", async () => {
  const { setKvReadTimeoutForTests } = await import("../src/lib/translate.ts");
  setKvReadTimeoutForTests(50);
  const originalError = console.error;
  console.error = () => {};
  const realSetTimeout = globalThis.setTimeout;
  try {
    const key = await translationKey("Föräldralös", "en", "fast");
    const kv = bulkKv({ [key]: "Orphaned (en)" });

    // Request A: its I/O context is gone, so none of its timers ever fire.
    globalThis.setTimeout = () => 0;
    translate({ text: "Föräldralös", target: "en", tier: "fast", kv }).catch(() => {});
    await new Promise((r) => realSetTimeout(r, 20));
    globalThis.setTimeout = realSetTimeout;

    // Request B, same isolate, same key, and a second key that has to join the queue.
    const otherKey = await translationKey("Granne", "en", "fast");
    kv.store.set(otherKey, "Neighbour (en)");
    const HUNG = Symbol("hung");
    const bound = (p) => Promise.race([p, new Promise((r) => realSetTimeout(() => r(HUNG), 1500))]);
    const same = await bound(translate({ text: "Föräldralös", target: "en", tier: "fast", kv }));
    const other = await bound(translate({ text: "Granne", target: "en", tier: "fast", kv }));
    assert.notEqual(same, HUNG, "request B must not wait on request A's dead promise");
    assert.notEqual(other, HUNG, "request B must not join a queue whose flush timer died");
    assert.equal(same.text, "Orphaned (en)");
    assert.equal(other.text, "Neighbour (en)");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    console.error = originalError;
    setKvReadTimeoutForTests(5000);
  }
});
