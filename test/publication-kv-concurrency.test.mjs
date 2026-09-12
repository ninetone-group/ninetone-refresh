/**
 * KV I/O shape — the defect a Map-backed fake cannot show you.
 *
 * WHAT HAPPENED. The first deployment ran the cron against the real bindings
 * and died part-way through every tick: `pub:v1:cand` and `pub:v1:newest` were
 * written for all 557 records, `pub:v1:inventory` was written — and NOT ONE
 * snapshot existed, so no job was ever enqueued and no release could assemble.
 *
 * WHY NO TEST CAUGHT IT. Every fake store in this suite is a `Map`, which
 * answers in microseconds. The same 557-record scan completes locally in ~39ms
 * while issuing 6,686 KV operations. Against remote KV at ~5ms per op, those
 * same operations are ~33 seconds of wall time when issued sequentially, and
 * the scheduled invocation is killed long before the end.
 *
 * The fix was bounded parallelism (`readMany` / `runBounded` in discovery.ts),
 * which changes NO semantics — identical keys, identical values, identical
 * results — only how many reads are in flight at once.
 *
 * These tests therefore assert on I/O SHAPE rather than on outputs: that the
 * hot paths actually overlap their reads, and that a tick completes within a
 * realistic time budget when latency is simulated. A future change that
 * reintroduces a sequential `for (... of records) await store.get(...)` in
 * discovery or snapshotting will fail here rather than in production.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { runDiscovery } from "../src/lib/publication/orchestrate.ts";
import { KV_READ_CONCURRENCY, readMany, runBounded } from "../src/lib/publication/discovery.ts";

async function sha(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(4);
}

/** A store that simulates remote latency and records peak concurrency. */
function latentKv(latencyMs = 2) {
  const map = new Map();
  const stats = { ops: 0, inflight: 0, peak: 0 };
  const track = async (fn) => {
    stats.ops += 1;
    stats.inflight += 1;
    stats.peak = Math.max(stats.peak, stats.inflight);
    await new Promise((r) => setTimeout(r, latencyMs));
    stats.inflight -= 1;
    return fn();
  };
  return {
    map,
    stats,
    async get(key) {
      return track(() => (map.has(key) ? map.get(key) : null));
    },
    async put(key, value) {
      return track(() => void map.set(key, value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function corpus(n) {
  return Array.from({ length: n }, (_, i) => ({
    SLUG: `artist-${i}`,
    "Head Artist": `Artist ${i}`,
    artistPresentationShort: `Biography number ${i}.`,
  }));
}

function getters(artists) {
  const empty = async () => [];
  return {
    getArtists: async () => artists,
    getPreviousArtists: empty,
    getClients: empty,
    getBookingRoster: empty,
    getTeam: empty,
    getNews: empty,
    getBookingCategories: empty,
    getWebPosts: empty,
  };
}

// ---------------------------------------------------------------------------
// The helpers themselves
// ---------------------------------------------------------------------------

test("readMany overlaps reads and preserves order", async () => {
  const store = latentKv(5);
  const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
  keys.forEach((k, i) => store.map.set(k, `v${i}`));

  const values = await readMany(store, keys);

  assert.deepEqual(values, keys.map((_, i) => `v${i}`), "order must match the keys exactly");
  assert.ok(store.stats.peak > 1, "reads must actually overlap");
  assert.ok(
    store.stats.peak <= KV_READ_CONCURRENCY,
    `concurrency must stay bounded (was ${store.stats.peak})`,
  );
});

test("readMany returns null for absent keys rather than skipping them", async () => {
  const store = latentKv(0);
  store.map.set("b", "B");
  assert.deepEqual(await readMany(store, ["a", "b", "c"]), [null, "B", null]);
});

test("readMany handles an empty list without hanging", async () => {
  assert.deepEqual(await readMany(latentKv(0), []), []);
});

test("runBounded visits every item exactly once, bounded", async () => {
  const seen = [];
  let inflight = 0;
  let peak = 0;
  await runBounded(Array.from({ length: 40 }, (_, i) => i), async (item) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 1));
    seen.push(item);
    inflight -= 1;
  });

  assert.equal(seen.length, 40);
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
  assert.ok(peak > 1 && peak <= KV_READ_CONCURRENCY);
});

// ---------------------------------------------------------------------------
// The scan itself — the regression that reached production
// ---------------------------------------------------------------------------

test("a full-corpus scan overlaps its KV reads", async () => {
  const store = latentKv(1);
  const queue = { sent: [], async sendBatch(ms) { for (const m of ms) this.sent.push(m.body); }, async send(b) { this.sent.push(b); } };

  await runDiscovery({
    discovery: { store, hash: sha, loadRecords: async () => [] },
    snapshots: { store, hash: sha, now: () => 1 },
    load: { getters: getters(corpus(200)), hash: sha },
    queue,
    env: {},
    keyVersion: "v1",
  });

  assert.ok(
    store.stats.peak > 1,
    "a sequential scan is what killed the first deployment; reads must overlap",
  );
  assert.ok(store.stats.peak <= KV_READ_CONCURRENCY);
});

test("a realistic corpus completes well inside a cron invocation", async () => {
  // 557 records is the measured live corpus. At 1ms simulated latency a
  // sequential implementation needs ~6.7s here (6,686 ops); the batched one
  // needs a fraction of that. The threshold is deliberately loose — this is a
  // guard against re-serialization, not a benchmark.
  const store = latentKv(1);
  const queue = { sent: [], async sendBatch(ms) { for (const m of ms) this.sent.push(m.body); }, async send(b) { this.sent.push(b); } };

  const started = Date.now();
  const result = await runDiscovery({
    discovery: { store, hash: sha, loadRecords: async () => [] },
    snapshots: { store, hash: sha, now: () => 1 },
    load: { getters: getters(corpus(557)), hash: sha },
    queue,
    env: {},
    keyVersion: "v1",
  });
  const elapsed = Date.now() - started;

  assert.equal(result.snapshots, 557, "every record must be snapshotted");
  assert.equal(result.enqueued, 1114, "two locales per record");
  assert.ok(
    elapsed < 3000,
    `a 557-record scan took ${elapsed}ms at 1ms/op — sequential I/O has been reintroduced`,
  );
});

test("snapshots are written for EVERY changed record, not a prefix", async () => {
  // The production symptom was partial progress: candidates for all records,
  // snapshots for none. This pins the invariant that the two stay in step.
  const store = latentKv(0);
  const queue = { sent: [], async sendBatch(ms) { for (const m of ms) this.sent.push(m.body); }, async send(b) { this.sent.push(b); } };

  await runDiscovery({
    discovery: { store, hash: sha, loadRecords: async () => [] },
    snapshots: { store, hash: sha, now: () => 1 },
    load: { getters: getters(corpus(120)), hash: sha },
    queue,
    env: {},
    keyVersion: "v1",
  });

  const keys = [...store.map.keys()];
  const candidates = keys.filter((k) => k.startsWith("pub:v1:cand:")).length;
  const snapshots = keys.filter((k) => k.startsWith("pub:v1:snap:")).length;

  assert.equal(candidates, 120);
  assert.equal(snapshots, 120, "a candidate without a snapshot is the production failure");
});

// ---------------------------------------------------------------------------
// Assembly — the SECOND sequential-I/O failure, found in production
// ---------------------------------------------------------------------------

test("read-back overlaps its reads across fields and entities", async () => {
  // The first perf fix batched discovery but NOT readBackAll, which does one
  // read per (field, locale). At full readiness that is 3,342 reads — ~21.6s
  // sequentially. The live symptom: a release assembled while only 10 of 557
  // entities were ready, then never assembled again once all 557 were, because
  // the tick died inside this loop every time.
  const { readBackAll } = await import("../src/lib/publication/readback.ts");

  let inflight = 0;
  let peak = 0;
  const cache = {
    async get() {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight -= 1;
      return "translated";
    },
  };

  const snapshots = Array.from({ length: 120 }, (_, i) => ({
    snapshotVersion: `s${i}`,
    contentHash: `c${i}`,
    membership: "m",
    kind: "artist",
    id: `a${i}`,
    fields: {
      "Artist Presentation Title": `T${i}`,
      artistPresentationShort: `S${i}`,
      artistPresentationString: `L${i}`,
    },
    protect: [],
    active: true,
    references: [],
    promptVersion: "p1",
    capturedAt: 1,
  }));

  const started = Date.now();
  const result = await readBackAll(
    { cache, keyFor: async (s, t, tier) => `tr:v1:${t}:${tier}:${await sha(s)}` },
    snapshots,
  );
  const elapsed = Date.now() - started;

  assert.equal(result.ready.length, 120);
  assert.equal(result.incomplete.length, 0);
  assert.ok(peak > 1, "read-back must not be sequential — that is what killed assembly");
  assert.ok(
    elapsed < 2000,
    `720 reads took ${elapsed}ms at 2ms/op — sequential read-back has been reintroduced`,
  );
});
