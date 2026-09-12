/**
 * Full cron tick — end-to-end, through the real orchestration.
 *
 * These answer the deployment review's demand directly: "verify through the
 * real entrypoints that a cron tick followed by queue completion produces a
 * readable shadow release; repeat after an injected crash between persistence
 * and enqueue; prove failed translation jobs remain recoverable without visitor
 * traffic or FM edits."
 *
 * Nothing is asserted from a helper in isolation: every test drives runTick()
 * and consumeJob() and then READS THE STORED BUNDLE BACK out of the fake
 * release store.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { consumeJob, routesForRecord, runTick } from "../src/lib/publication/orchestrate.ts";
import { CoordinatorCore } from "../src/lib/publication/coordinator-do.ts";
import { readRelease, resolveGeneration } from "../src/lib/publication/release.ts";
import { validateRelease } from "../src/lib/publication/contracts.ts";

async function sha(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(4);
}

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async put(k, v) {
      map.set(k, v);
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

function fakeQueue() {
  return {
    sent: [],
    async sendBatch(messages) {
      for (const m of messages) this.sent.push(m.body);
    },
    async send(body) {
      this.sent.push(body);
    },
  };
}

const ARTIST = { SLUG: "anjo", "Head Artist": "Anjo", artistPresentationShort: "Kort bio." };

function getters(artist = ARTIST) {
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

/** A coordinator backed by the real CoordinatorCore over fake DO storage. */
function coordinator() {
  const storage = new Map();
  const core = new CoordinatorCore({
    async get(k) {
      return storage.get(k);
    },
    async put(k, v) {
      storage.set(k, v);
    },
  });
  return {
    core,
    read: () => core.read(),
    applyScan: (scan) => core.applyScan(scan),
    approve: (args) => core.approve(args),
  };
}

function harness({ store = fakeKv(), cache = fakeKv(), release = fakeKv(), env = {}, artist = ARTIST, queue = fakeQueue(), coord = coordinator() } = {}) {
  return {
    store,
    cache,
    release,
    queue,
    coord,
    deps: {
      discovery: { store, hash: sha, loadRecords: async () => [] },
      snapshots: { store, hash: sha, now: () => 1 },
      load: { getters: getters(artist), hash: sha },
      queue,
      env,
      keyVersion: "v1",
      release: { store: release, now: () => 1 },
      readbackCache: { get: (k) => cache.get(k) },
      keyFor: async (s, t, tier) => `tr:v1:${t}:${tier}:${await sha(s)}`,
      buildId: "b1",
      now: () => 1_757_000_000_000,
      coordinator: coord,
    },
  };
}

function consumerDeps(store, cache, counter = { n: 0 }, opts = {}) {
  return {
    counter,
    deps: {
      consumer: {
        cache: { get: (k) => cache.get(k), put: (k, v) => cache.put(k, v) },
        keyFor: async (s, t, tier) => `tr:v1:${t}:${tier}:${await sha(s)}`,
        translateFn: async ({ text, target }) => {
          counter.n += 1;
          if (opts.fail) throw new Error("provider down");
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

// ---------------------------------------------------------------------------

test("tick 1 assembles nothing; after queue completion tick 2 stores a READABLE release", async () => {
  const h = harness();

  const first = await runTick(h.deps);
  assert.equal(first.mode, "shadow");
  assert.equal(first.coordinatorApplied, true, "the scan goes through the coordinator");
  assert.equal(first.assembled, null, "nothing is ready yet");
  assert.equal(first.discovery.enqueued, 2);

  // Queue completion.
  const { deps: cd, counter } = consumerDeps(h.store, h.cache);
  for (const job of h.queue.sent) await consumeJob(cd, job);
  assert.equal(counter.n, 2);

  const second = await runTick(h.deps);
  assert.ok(second.assembled, "a release is assembled once translations exist");
  assert.equal(second.assembled.stored, true);
  assert.equal(second.assembled.published, 1);
  assert.deepEqual(second.assembled.issues, []);

  // READ THE STORED BUNDLE BACK — not the return value.
  const bundle = await readRelease({ store: h.release }, second.assembled.generation);
  assert.ok(bundle, "the bundle must be readable from the store");
  assert.deepEqual(validateRelease(bundle), []);
  const entity = bundle.entities.find((e) => e.id === "artist:anjo");
  assert.equal(entity.text.sv.artistPresentationShort, "[sv] Kort bio.");
  assert.equal(entity.text.en.artistPresentationShort, "[en] Kort bio.");
  assert.deepEqual(entity.routes, ["/records/artists/anjo", "/en/records/artists/anjo"]);
});

test("shadow assembly does NOT promote: nothing serves from the release", async () => {
  const h = harness();
  await runTick(h.deps);
  const { deps: cd } = consumerDeps(h.store, h.cache);
  for (const job of h.queue.sent) await consumeJob(cd, job);
  const second = await runTick(h.deps);

  assert.equal(second.promoted, false);
  assert.equal(await h.release.get("rel:v1:current"), null, "the current pointer is never set");
  assert.equal(await resolveGeneration({ store: h.release }), null);
});

test("with PUBLICATION_SERVING=on the release is promoted and resolvable", async () => {
  const h = harness({ env: { PUBLICATION_SERVING: "on" } });
  await runTick(h.deps);
  const { deps: cd } = consumerDeps(h.store, h.cache);
  for (const job of h.queue.sent) await consumeJob(cd, job);
  const second = await runTick(h.deps);

  assert.equal(second.mode, "serving");
  assert.equal(second.promoted, true);
  assert.equal(
    await resolveGeneration({ store: h.release }),
    second.assembled.generation,
    "the promoted generation is what serving resolves",
  );
});

test("an unchanged corpus re-assembles to the SAME generation id", async () => {
  const h = harness();
  await runTick(h.deps);
  const { deps: cd } = consumerDeps(h.store, h.cache);
  for (const job of h.queue.sent) await consumeJob(cd, job);

  const a = await runTick(h.deps);
  const b = await runTick(h.deps);
  assert.equal(
    b.assembled.generation,
    a.assembled.generation,
    "content-addressed, so a cron every minute does not create a bundle every minute",
  );
});

test("CRASH between persistence and enqueue is recovered without an FM edit", async () => {
  const store = fakeKv();
  const boom = {
    async sendBatch() {
      throw new Error("queue unavailable");
    },
    async send() {
      throw new Error("queue unavailable");
    },
  };

  const failing = harness({ store, queue: boom });
  await assert.rejects(() => runTick(failing.deps), /queue unavailable/);

  // FM is unchanged; only the queue recovered.
  const healthy = harness({ store, cache: failing.cache, release: failing.release, coord: failing.coord });
  const recovered = await runTick(healthy.deps);
  assert.equal(recovered.discovery.changed, 0, "discover() reports nothing new");
  assert.equal(recovered.discovery.enqueued, 2, "but the lost jobs are replayed");

  const { deps: cd } = consumerDeps(store, healthy.cache);
  for (const job of healthy.queue.sent) await consumeJob(cd, job);

  const final = await runTick(healthy.deps);
  assert.equal(final.assembled.stored, true, "and the release still assembles");
  assert.ok(await readRelease({ store: healthy.release }, final.assembled.generation));
});

test("a FAILED translation is recoverable on a later tick, with no FM edit", async () => {
  const h = harness();
  await runTick(h.deps);

  // Provider is down: every job exhausts its retries and is ACKed (not retried
  // by the queue), so no completion record is written.
  const { deps: failing, counter } = consumerDeps(h.store, h.cache, { n: 0 }, { fail: true });
  for (const job of h.queue.sent) {
    const d = await consumeJob(failing, job);
    assert.equal(d.action, "ack");
    assert.equal(d.outcome.status, "failed");
  }
  assert.ok(counter.n > 0);

  const stillNothing = await runTick(h.deps);
  assert.equal(stillNothing.assembled, null, "nothing is ready while translations are missing");
  assert.equal(stillNothing.discovery.enqueued, 2, "the failed work is re-enqueued automatically");

  // Provider recovers.
  h.queue.sent.length = 0;
  const again = await runTick(h.deps);
  const { deps: working } = consumerDeps(h.store, h.cache);
  for (const job of h.queue.sent) await consumeJob(working, job);

  const final = await runTick(h.deps);
  assert.equal(final.assembled.stored, true, "recovery needs no visitor traffic and no FM edit");
  void again;
});

test("a stale scan is refused by the coordinator and skips assembly", async () => {
  const h = harness();
  // Force the coordinator's revision ahead of what the next scan will claim.
  await h.coord.applyScan({ basedOnRevision: 0, newestHashes: { x: "1" }, removals: [] });
  await h.coord.applyScan({ basedOnRevision: 1, newestHashes: { x: "2" }, removals: [] });

  const stale = {
    ...h.deps,
    coordinator: {
      read: async () => ({ revision: 0 }), // pretends to be an older tick
      applyScan: (scan) => h.coord.applyScan(scan),
      approve: (args) => h.coord.approve(args),
    },
  };

  const result = await runTick(stale);
  assert.equal(result.coordinatorApplied, false, "an out-of-order scan must be refused");
  assert.equal(result.assembled, null, "and must not go on to assemble");
});

test("REAL ordering: a scan whose FM read started before a faster tick applied is refused", async () => {
  // Reproduces review D2 against runTick itself, with the REAL coordinator:
  // while this tick is still reading FM, another tick applies. The slow tick
  // must be refused — which only holds if its revision was read BEFORE the
  // FM read began, not after.
  const h = harness();
  await runTick(h.deps); // establishes revision 1
  const slowGetters = getters();
  slowGetters.getArtists = async () => {
    // "Faster tick" lands mid-read.
    await h.coord.applyScan({
      basedOnRevision: (await h.coord.read()).revision,
      newestHashes: { "artist:anjo": "v2" },
      removals: [],
    });
    return [ARTIST];
  };
  const result = await runTick({ ...h.deps, load: { getters: slowGetters, hash: sha } });
  assert.equal(result.coordinatorApplied, false, "the slow, stale scan must be refused");
  assert.equal(result.assembled, null);
  const state = await h.coord.read();
  assert.equal(state.newestHashes["artist:anjo"], "v2", "the newer hash must survive");
});

test("a partial FM read never claims an inventory at the coordinator", async () => {
  const broken = getters();
  broken.getNews = async () => {
    throw new Error("FM down");
  };
  const h = harness();
  const deps = { ...h.deps, load: { getters: broken, hash: sha } };

  const result = await runTick(deps);
  assert.equal(result.discovery.inventoryComplete, false);
  const state = await h.coord.read();
  assert.deepEqual(state.inventory, [], "a partial read must not look like mass deletion");
});

test("routes match the sitemap's authoritative prefixes", () => {
  const r = (kind, id) => routesForRecord({ kind, id, hash: "h", fields: {}, references: [], active: true });
  assert.deepEqual(r("artist", "anjo"), ["/records/artists/anjo", "/en/records/artists/anjo"]);
  assert.deepEqual(r("previousArtist", "x"), [
    "/records/artists/previous/single/x",
    "/en/records/artists/previous/single/x",
  ]);
  assert.deepEqual(r("client", "c"), ["/management/clients/c", "/en/management/clients/c"]);
  assert.deepEqual(r("teamMember", "t"), ["/team/t", "/en/team/t"]);
  assert.deepEqual(r("bookingTalent", "b"), ["/ninetone-nation/b", "/en/ninetone-nation/b"]);
  assert.deepEqual(r("newsPost", "n"), ["/news/n", "/en/news/n"]);
  assert.deepEqual(r("bookingCategory", "Artist"), [], "category pages come from a filter");
  assert.deepEqual(r("webPostSection", "Ninetone Group"), [], "sections are fragments, not pages");
  assert.deepEqual(r("webPostSection", "Ninetone Group#1"), [], "blocks are fragments too");
});

test("a corrected translation produces a NEW generation, not a throw", async () => {
  // Production failure: two English bios the model had returned in Swedish were
  // corrected. The source text never changed, so every snapshotVersion stayed
  // identical and the generation id — then derived from snapshot versions alone
  // — stayed identical too. storeRelease() correctly refuses to rewrite a
  // generation whose bytes differ, so assembly threw on EVERY tick and no
  // release could be stored again. The id must cover the translations.
  const h = harness();
  await runTick(h.deps);
  const { deps: cd } = consumerDeps(h.store, h.cache);
  for (const job of h.queue.sent) await consumeJob(cd, job);

  const first = await runTick(h.deps);
  assert.equal(first.assembled.stored, true);

  // Correct a translation in place; the SOURCE is untouched.
  for (const [k, v] of [...h.cache.map.entries()]) {
    if (k.startsWith("tr:v1:en:")) h.cache.map.set(k, "CORRECTED ENGLISH");
    void v;
  }

  const second = await runTick(h.deps);
  assert.equal(second.assembled.stored, true, "assembly must not throw after a correction");
  assert.notEqual(
    second.assembled.generation,
    first.assembled.generation,
    "changed content must mean a new immutable generation",
  );

  const bundle = await readRelease({ store: h.release }, second.assembled.generation);
  assert.equal(bundle.entities[0].text.en.artistPresentationShort, "CORRECTED ENGLISH");

  // And the original generation is still intact — immutability preserved.
  const original = await readRelease({ store: h.release }, first.assembled.generation);
  assert.equal(original.entities[0].text.en.artistPresentationShort, "[en] Kort bio.");
});

test("an unchanged corpus AND unchanged translations still reuse the generation", async () => {
  const h = harness();
  await runTick(h.deps);
  const { deps: cd } = consumerDeps(h.store, h.cache);
  for (const job of h.queue.sent) await consumeJob(cd, job);

  const a = await runTick(h.deps);
  const b = await runTick(h.deps);
  assert.equal(b.assembled.generation, a.assembled.generation, "no churn when nothing changed");
});

test("generation id is independent of key INSERTION ORDER", async () => {
  // Production churn: read-back fills the translation map in parallel, so key
  // insertion order varies between runs. The generation id hashed
  // JSON.stringify(translations), whose output depends on that order, so five
  // byte-identical 557-entity generations were written in a few minutes — a new
  // immutable bundle every cron tick, forever.
  const { canonicalTranslations } = await import("../src/lib/publication/orchestrate.ts");

  const a = {
    "artist:anjo": { sv: { title: "T", body: "B" }, en: { title: "T", body: "B" } },
    "artist:bo": { sv: { title: "X" }, en: { title: "X" } },
  };
  // Same content, every level inserted in a different order.
  const b = {
    "artist:bo": { en: { title: "X" }, sv: { title: "X" } },
    "artist:anjo": { en: { body: "B", title: "T" }, sv: { body: "B", title: "T" } },
  };

  assert.notEqual(JSON.stringify(a), JSON.stringify(b), "the naive encoding really does differ");
  assert.equal(canonicalTranslations(a), canonicalTranslations(b), "the canonical one must not");
});

test("a real content change still changes the canonical digest", async () => {
  const { canonicalTranslations } = await import("../src/lib/publication/orchestrate.ts");
  const base = { "artist:anjo": { sv: { title: "T" }, en: { title: "T" } } };
  const changed = { "artist:anjo": { sv: { title: "T" }, en: { title: "CHANGED" } } };
  assert.notEqual(canonicalTranslations(base), canonicalTranslations(changed));
});

test("repeated ticks over unchanged content write ONE bundle, not one per tick", async () => {
  const h = harness();
  await runTick(h.deps);
  const { deps: cd } = consumerDeps(h.store, h.cache);
  for (const job of h.queue.sent) await consumeJob(cd, job);

  const ids = new Set();
  for (let i = 0; i < 4; i++) ids.add((await runTick(h.deps)).assembled.generation);

  assert.equal(ids.size, 1, `four ticks produced ${ids.size} generations: ${[...ids].join(", ")}`);
  const bundles = [...h.release.map.keys()].filter((k) => k.startsWith("rel:v1:bundle:"));
  assert.equal(bundles.length, 1, "a cron every minute must not write a bundle every minute");
});
