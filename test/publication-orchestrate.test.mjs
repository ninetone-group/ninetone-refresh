/**
 * Orchestration + coordinator DO tests — checkpoint 4.5.
 *
 * These exercise the sequence the Worker's `scheduled` and `queue` handlers
 * run, against FAKE BINDINGS: a fake KV, a fake queue producer, a fake DO
 * storage, and a counting translation provider. No workerd, no miniflare, no
 * network, no spend.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { assembleRelease, consumeJob, runDiscovery, shouldPromote } from "../src/lib/publication/orchestrate.ts";
import {
  CoordinatorCore,
  SINGLETON_NAME,
  handleCoordinatorRequest,
} from "../src/lib/publication/coordinator-do.ts";
import { readRelease } from "../src/lib/publication/release.ts";

async function sha(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(4);
}

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function fakeQueue() {
  const sent = [];
  return {
    sent,
    async send(body) {
      sent.push(body);
    },
    async sendBatch(messages) {
      for (const m of messages) sent.push(m.body);
    },
  };
}

const ARTIST = {
  SLUG: "anjo",
  "Head Artist": "Anjo",
  artistPresentationShort: "Kort bio.",
};

function fakeGetters(artist = ARTIST) {
  const empty = async () => [];
  return {
    getArtists: async () => (artist ? [artist] : []),
    getPreviousArtists: empty,
    getClients: empty,
    getBookingRoster: empty,
    getTeam: empty,
    getNews: empty,
    getBookingCategories: empty,
    getWebPosts: empty,
  };
}

function discoveryRunDeps({ store = fakeKv(), queue = fakeQueue(), env = {}, getters = fakeGetters() } = {}) {
  return {
    deps: {
      discovery: { store, hash: sha, loadRecords: async () => [] },
      snapshots: { store, hash: sha, now: () => 1 },
      load: { getters, hash: sha },
      queue,
      env,
      keyVersion: "v1",
    },
    store,
    queue,
  };
}

// ---------------------------------------------------------------------------
// Discovery run
// ---------------------------------------------------------------------------

test("a first scan snapshots and enqueues both locales", async () => {
  const { deps, queue } = discoveryRunDeps();
  const result = await runDiscovery(deps);

  assert.equal(result.mode, "shadow", "no PUBLICATION_SERVING means shadow");
  assert.equal(result.scanned, 1);
  assert.equal(result.changed, 1);
  assert.equal(result.snapshots, 1);
  assert.equal(result.enqueued, 2, "one field x two locales");
  assert.equal(result.inventoryComplete, true);

  assert.deepEqual([...new Set(queue.sent.map((j) => j.target))].sort(), ["en", "sv"]);
  for (const job of queue.sent) {
    assert.ok(job.snapshotVersion, "every job names its snapshot");
    assert.deepEqual(job.protect, ["Anjo"], "protected names travel with the job");
  }
});

test("a re-scan enqueues NOTHING once the work has completed", async () => {
  // The "no work at all" property is about COMPLETED work, not merely about an
  // unchanged hash. Enqueueing is driven by reconcile(), which derives
  // outstanding jobs from MISSING completion records — so a re-scan re-sends
  // anything that never finished. That is the crash-recovery behaviour, and an
  // earlier version of this test asserted the opposite by never consuming the
  // queue, which would have locked in the bug where a failed enqueue stranded a
  // record until someone edited it in FileMaker.
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);

  const { deps: cd, calls } = consumeDeps(store);
  for (const job of queue.sent) await consumeJob(cd, job);
  assert.equal(calls.n, 2, "two locales translated on the first pass");

  queue.sent.length = 0;
  const second = await runDiscovery(deps);

  assert.equal(second.changed, 0);
  assert.equal(second.enqueued, 0, "completed work must never be re-enqueued");
  assert.equal(second.unchanged, 1);
  assert.deepEqual([...second.reconciled.readyIds], ["artist:anjo"]);
});

test("a re-scan RE-ENQUEUES work that never completed (crash recovery)", async () => {
  // Reproduces the deployment-review finding: a queue failure after
  // persistDiscovery() previously stranded the record forever, because
  // discover() reports `unchanged` on the next scan and nothing replayed the
  // lost jobs. Verified before the fix: scan 2 gave `enqueued: 0`.
  const store = fakeKv();
  const boom = {
    async sendBatch() {
      throw new Error("queue unavailable");
    },
    async send() {
      throw new Error("queue unavailable");
    },
  };

  const { deps: failing } = discoveryRunDeps({ store, queue: boom });
  await assert.rejects(() => runDiscovery(failing), /queue unavailable/);

  const { deps: healthy, queue } = discoveryRunDeps({ store });
  const second = await runDiscovery(healthy);

  assert.equal(second.changed, 0, "FM is unchanged — discover() sees nothing new");
  assert.equal(second.enqueued, 2, "but the lost jobs are recovered from missing completions");
  assert.equal(queue.sent.length, 2);
});

test("an edit is rediscovered and re-enqueued", async () => {
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);
  queue.sent.length = 0;

  const edited = { ...ARTIST, artistPresentationShort: "Ny text." };
  const second = await runDiscovery({ ...deps, load: { getters: fakeGetters(edited), hash: sha } });

  assert.equal(second.changed, 1);
  assert.equal(second.enqueued, 2);
  assert.ok(store.map.size > 0);
});

test("the snapshot is written BEFORE the job is enqueued", async () => {
  const order = [];
  const store = fakeKv();
  const trackingStore = {
    ...store,
    async put(key, value) {
      if (key.startsWith("pub:v1:snap:")) order.push("snapshot");
      return store.put(key, value);
    },
  };
  const queue = {
    sent: [],
    async sendBatch(messages) {
      order.push("enqueue");
      for (const m of messages) this.sent.push(m.body);
    },
  };
  const { deps } = discoveryRunDeps({ store: trackingStore, queue });
  await runDiscovery(deps);

  assert.equal(order[0], "snapshot", "a job must never reference a snapshot that does not exist");
  assert.ok(order.includes("enqueue"));
});

test("a failed FM layout clears inventoryComplete so removals are not trusted", async () => {
  const getters = fakeGetters();
  getters.getNews = async () => {
    throw new Error("FM down");
  };
  const { deps } = discoveryRunDeps({ getters });
  const result = await runDiscovery(deps);

  assert.equal(result.inventoryComplete, false);
  assert.deepEqual(result.failures, ["API_NEWS"]);
  assert.equal(result.changed, 1, "the layers that did load still progress");
});

test("discovery works with no queue bound (shadow, pre-queue)", async () => {
  const { deps } = discoveryRunDeps({ queue: null });
  const result = await runDiscovery(deps);
  assert.equal(result.snapshots, 1, "snapshots are still frozen");
  assert.equal(result.enqueued, 0);
});

// ---------------------------------------------------------------------------
// Queue consumption
// ---------------------------------------------------------------------------

function consumeDeps(store, { calls = { n: 0 }, fail = false } = {}) {
  const cache = fakeKv();
  return {
    cache,
    calls,
    deps: {
      consumer: {
        cache: { get: (k) => cache.get(k), put: (k, v) => cache.put(k, v) },
        keyFor: async (source, target, tier) => `tr:v1:${target}:${tier}:${await sha(source)}`,
        translateFn: async ({ text, target }) => {
          calls.n += 1;
          if (fail) throw new Error("provider down");
          return `[${target}] ${text}`;
        },
        sleep: async () => {},
      },
      snapshots: { store },
      discovery: { store, hash: sha, loadRecords: async () => [] },
      keyVersion: "v1",
    },
  };
}

test("a job translates, records completion and acks", async () => {
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);
  const job = queue.sent[0];

  const { deps: cd, calls } = consumeDeps(store);
  const disposition = await consumeJob(cd, job);

  assert.equal(disposition.action, "ack");
  assert.equal(disposition.outcome.status, "translated");
  assert.equal(calls.n, 1);
});

test("a redelivered job is reused and costs no model call", async () => {
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);
  const job = queue.sent[0];

  const { deps: cd, calls } = consumeDeps(store);
  await consumeJob(cd, job);
  calls.n = 0;

  const again = await consumeJob(cd, job);
  assert.equal(again.action, "ack");
  assert.equal(again.outcome.status, "reused");
  assert.equal(calls.n, 0, "at-least-once delivery must be free");
});

test("a missing snapshot RETRIES and never calls the model", async () => {
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);
  const job = queue.sent[0];

  // Drop only the snapshot, as an edge that has not caught up would see.
  for (const key of [...store.map.keys()]) {
    if (key.startsWith("pub:v1:snap:")) store.map.delete(key);
  }

  const { deps: cd, calls } = consumeDeps(store);
  const disposition = await consumeJob(cd, job);

  assert.equal(disposition.action, "retry");
  assert.equal(disposition.reason, "snapshot-missing");
  assert.equal(calls.n, 0, "a missing snapshot must never fall back to live FM");
});

test("a field absent from a readable snapshot ACKs rather than looping", async () => {
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);
  const job = { ...queue.sent[0], field: "artistPresentationString" };

  const { deps: cd, calls } = consumeDeps(store);
  const disposition = await consumeJob(cd, job);

  assert.equal(disposition.action, "ack", "permanent absence must not retry forever");
  assert.equal(disposition.outcome.status, "absent");
  assert.equal(calls.n, 0);
});

test("an exhausted job ACKs rather than multiplying queue retries", async () => {
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);
  const job = queue.sent[0];

  const { deps: cd, calls } = consumeDeps(store, { fail: true });
  const disposition = await consumeJob(cd, job);

  assert.equal(disposition.action, "ack");
  assert.equal(disposition.outcome.status, "failed");
  assert.equal(calls.n, 4, "processJob's own bounded retries ran once, not once per delivery");
});

test("a stale completion ACKs and is not merged", async () => {
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);
  const job = queue.sent[0];

  // A newer edit lands, superseding this job's candidate.
  const edited = { ...ARTIST, artistPresentationShort: "Nyare text." };
  await runDiscovery({ ...deps, load: { getters: fakeGetters(edited), hash: sha } });

  const { deps: cd } = consumeDeps(store);
  const disposition = await consumeJob(cd, job);
  assert.equal(disposition.action, "ack");
  assert.equal(disposition.outcome.status, "stale", "a late completion is refused, not merged");
});

// ---------------------------------------------------------------------------
// Assembly stores but never promotes
// ---------------------------------------------------------------------------

test("assembly stores a valid release and promotes nothing", async () => {
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);

  const { deps: cd } = consumeDeps(store);
  for (const job of queue.sent) await consumeJob(cd, job);

  const releaseStore = fakeKv();
  const snapshots = [...store.map.entries()]
    .filter(([k]) => k.startsWith("pub:v1:snap:"))
    .map(([, v]) => JSON.parse(v));
  const records = snapshots.map((s) => ({
    kind: s.kind,
    id: s.id,
    hash: s.contentHash,
    fields: s.fields,
    references: [],
    active: true,
  }));

  const result = await assembleRelease(
    {
      readback: { cache: cd.consumer.cache, keyFor: cd.consumer.keyFor },
      release: { store: releaseStore, now: () => 1 },
      buildId: "b1",
      generation: "g1",
      createdAt: "2026-09-12T00:00:00.000Z",
      routesFor: () => ["/records/artists/anjo"],
    },
    records,
    snapshots,
  );

  assert.equal(result.stored, true);
  assert.equal(result.published, 1);
  assert.deepEqual(result.issues, []);
  assert.ok(result.digest);

  const stored = await readRelease({ store: releaseStore }, "g1");
  assert.equal(stored.entities.length, 1);
  assert.equal(
    releaseStore.map.get("rel:v1:current"),
    undefined,
    "shadow assembly must NOT move the current pointer",
  );
});

test("an incomplete entity is withheld, not published with a gap", async () => {
  const { deps, queue, store } = discoveryRunDeps();
  await runDiscovery(deps);

  const { deps: cd } = consumeDeps(store);
  await consumeJob(cd, queue.sent[0]); // only one locale translated

  const snapshots = [...store.map.entries()]
    .filter(([k]) => k.startsWith("pub:v1:snap:"))
    .map(([, v]) => JSON.parse(v));
  const records = snapshots.map((s) => ({
    kind: s.kind,
    id: s.id,
    hash: s.contentHash,
    fields: s.fields,
    references: [],
    active: true,
  }));

  const result = await assembleRelease(
    {
      readback: { cache: cd.consumer.cache, keyFor: cd.consumer.keyFor },
      release: { store: fakeKv(), now: () => 1 },
      buildId: "b1",
      generation: "g1",
      createdAt: "2026-09-12T00:00:00.000Z",
      routesFor: () => ["/x"],
    },
    records,
    snapshots,
  );

  assert.equal(result.stored, false);
  assert.equal(result.published, 0);
  assert.deepEqual(result.withheld, ["artist:anjo"]);
});

// ---------------------------------------------------------------------------
// The rollout flag gates promotion ONLY
// ---------------------------------------------------------------------------

test("promotion is gated on an exact 'on'", () => {
  assert.equal(shouldPromote({}), false, "absent means shadow");
  assert.equal(shouldPromote({ PUBLICATION_SERVING: "ON" }), false, "case matters");
  assert.equal(shouldPromote({ PUBLICATION_SERVING: "true" }), false);
  assert.equal(shouldPromote({ PUBLICATION_SERVING: "off" }), false);
  assert.equal(shouldPromote({ PUBLICATION_SERVING: "on" }), true);
});

test("preparation is NOT gated on the flag", async () => {
  const { deps } = discoveryRunDeps({ env: { PUBLICATION_SERVING: "off" } });
  const result = await runDiscovery(deps);
  assert.equal(result.mode, "off");
  assert.equal(result.snapshots, 1, "shadow preparation runs regardless of the serving flag");
  assert.equal(result.enqueued, 2);
});

// ---------------------------------------------------------------------------
// Coordinator Durable Object
// ---------------------------------------------------------------------------

function fakeDurableStorage() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}

test("the coordinator starts empty and applies a scan", async () => {
  const core = new CoordinatorCore(fakeDurableStorage());
  assert.equal((await core.read()).revision, 0);

  const applied = await core.applyScan({
    basedOnRevision: 0,
    newestHashes: { "artist:anjo": "h1" },
    inventory: ["artist:anjo"],
    removals: [],
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.state.newestHashes["artist:anjo"], "h1");
});

test("a scan computed from an older revision is REFUSED", async () => {
  const core = new CoordinatorCore(fakeDurableStorage());
  await core.applyScan({ basedOnRevision: 0, newestHashes: { a: "1" }, removals: [] });
  const current = await core.read();

  const stale = await core.applyScan({
    basedOnRevision: current.revision - 1,
    newestHashes: { a: "STALE" },
    removals: [],
  });

  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale-revision");
  assert.equal((await core.read()).newestHashes.a, "1", "state must not regress");
});

test("state survives across core instances (durable, not in-memory)", async () => {
  const storage = fakeDurableStorage();
  await new CoordinatorCore(storage).applyScan({
    basedOnRevision: 0,
    newestHashes: { a: "1" },
    removals: [],
  });
  const reread = await new CoordinatorCore(storage).read();
  assert.equal(reread.newestHashes.a, "1");
});

test("the RPC surface dispatches every op", async () => {
  const core = new CoordinatorCore(fakeDurableStorage());

  const applied = await handleCoordinatorRequest(core, {
    op: "applyScan",
    scan: { basedOnRevision: 0, newestHashes: { a: "1" }, inventory: ["a"], removals: ["b"] },
  });
  assert.equal(applied.applied, true);

  const plan = await handleCoordinatorRequest(core, { op: "servingPlan" });
  assert.equal(plan.current, null, "nothing is approved in shadow");

  const state = await handleCoordinatorRequest(core, { op: "read" });
  assert.ok(state.pendingRemovals.some((r) => r.ref === "b"), "removals persist as an outbox");

  const cleared = await handleCoordinatorRequest(core, { op: "commitRemovals", refs: ["b"] });
  assert.equal(cleared.pendingRemovals.length, 0);
});

test("an unknown op throws rather than silently succeeding", async () => {
  const core = new CoordinatorCore(fakeDurableStorage());
  await assert.rejects(() => handleCoordinatorRequest(core, { op: "nope" }), /unknown coordinator op/);
});

test("the singleton name is fixed", () => {
  assert.equal(SINGLETON_NAME, "publication", "sharding would defeat serialization");
});
