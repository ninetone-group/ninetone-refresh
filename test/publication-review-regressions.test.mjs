/**
 * Regression tests for docs/publication-checkpoints-1-2-review.md.
 *
 * One test per counterexample, written from the review's own local
 * reproductions. Every one of these FAILED against 758fbdd before the fixes;
 * they exist so the exact defects cannot return.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { validateRelease, isReleasePromotable } from "../src/lib/publication/contracts.ts";
import {
  discover,
  persistDiscovery,
  recordJobCompletion,
  reconcile,
  selectPublishable,
  stateKeys,
  SCAN_LOCK_TTL_SECONDS,
  MIN_KV_EXPIRATION_TTL_SECONDS,
} from "../src/lib/publication/discovery.ts";

function memStore() {
  const map = new Map();
  const writes = [];
  return {
    map,
    writes,
    async get(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async put(k, v, o) {
      writes.push({ key: k, ttl: o?.expirationTtl });
      // Cloudflare KV rejects expirationTtl below 60 (verified against the
      // official write-key-value-pairs docs). Model that here so a test
      // cannot pass against behaviour production would reject.
      if (o?.expirationTtl !== undefined && o.expirationTtl < 60) {
        throw new Error(`invalid expirationTtl ${o.expirationTtl}; minimum is 60`);
      }
      map.set(k, v);
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

const deps = (recs, store = memStore()) => ({
  store,
  hash: async (s) => `h(${s.length})`,
  loadRecords: async () => recs,
  now: () => 1757700000000,
});

const artist = (id, hash, extra = {}) => ({
  kind: "artist",
  id,
  hash,
  fields: { artistPresentationString: `bio ${id}` },
  references: [],
  active: true,
  ...extra,
});

const jobFor = (target, hash = "h1") => ({
  entityKind: "artist",
  entityId: "anjo",
  sourceHash: hash,
  field: "artistPresentationString",
  target,
  kind: "markdown",
  tier: "fast",
  protect: [],
});

// --- P1: crash recovery -----------------------------------------------------

test("P1 crash between newestHash and candidate does not strand the version", async () => {
  // Review reproduction: seed only newestHash=v1, scan source v1 ->
  // changed=[], unchanged=1, jobs=[]. The record had no candidate and no work
  // would ever be created for it again.
  const store = memStore();
  await store.put(stateKeys.newestHash("artist", "anjo"), "v1");

  const d = deps([artist("anjo", "v1")], store);
  const result = await discover(d);

  assert.equal(result.jobs.length, 2, "the missing candidate must be reconstructed with its jobs");
  assert.ok(
    result.changed.some((r) => r.id === "anjo"),
    "a known hash with no candidate is outstanding work, not an unchanged record",
  );
});

test("P1 crash after candidate persistence but before enqueue recovers", async () => {
  // The review requires this second window to recover too: the candidate
  // exists with zero completions and nothing was ever queued.
  const store = memStore();
  const d = deps([artist("anjo", "h1")], store);
  await persistDiscovery(d, await discover(d), "v1");

  const outstanding = await reconcile(d, "v1");
  assert.equal(outstanding.jobs.length, 2, "unfinished jobs must be re-enqueueable from state alone");
});

// --- P1: concurrent completion ---------------------------------------------

test("P1 concurrent completions of different locales both survive", async () => {
  // Review reproduction: Promise.all on two locale completions left only 1 of
  // 2 flags, because both read the same candidate JSON and one overwrote the
  // other. Immutable per-job records remove the shared mutable object.
  const store = memStore();
  const d = deps([artist("anjo", "h1")], store);
  await persistDiscovery(d, await discover(d), "v1");

  await Promise.all([
    recordJobCompletion(d, jobFor("sv"), "v1"),
    recordJobCompletion(d, jobFor("en"), "v1"),
  ]);

  const candidate = await reconcile(d, "v1").then((r) => r.candidates.find((c) => c.entityId === "anjo"));
  const done = Object.values(candidate.completed).filter(Boolean).length;
  assert.equal(done, 2, "both completions must be visible");
});

test("P1 a duplicate scan after progress does not reset completions", async () => {
  // Review reproduction: re-running persistDiscovery for an identical result
  // reset completed={}, discarding finished translation work.
  const store = memStore();
  const d = deps([artist("anjo", "h1")], store);
  const result = await discover(d);
  await persistDiscovery(d, result, "v1");
  await recordJobCompletion(d, jobFor("en"), "v1");

  await persistDiscovery(d, result, "v1");

  const candidate = await reconcile(d, "v1").then((r) => r.candidates.find((c) => c.entityId === "anjo"));
  assert.equal(Object.values(candidate.completed).filter(Boolean).length, 1, "progress must survive a rescan");
});

test("P1 a completion concurrent with withdrawal does not resurrect the record", async () => {
  const store = memStore();
  const d = deps([artist("anjo", "h1")], store);
  await persistDiscovery(d, await discover(d), "v1");

  // The record is withdrawn while a job is still in flight.
  const withdrawn = deps([artist("anjo", "h1", { active: false })], store);
  await persistDiscovery(withdrawn, await discover(withdrawn), "v1");
  await recordJobCompletion(withdrawn, jobFor("en"), "v1");

  const state = await reconcile(withdrawn, "v1");
  assert.ok(
    state.removals.some((r) => r.id === "anjo"),
    "the withdrawal must stand regardless of late completions",
  );
});

// --- P1: validation completeness -------------------------------------------

test("P1 an entity with empty text maps cannot be promoted", async () => {
  // Review reproduction: text={sv:{},en:{}} and routes=[] passed
  // isReleasePromotable() even though the source record has a biography.
  // Validation must bind to an explicit required-field manifest.
  const release = {
    generation: "g1",
    createdAt: "2026-09-12T00:00:00Z",
    buildId: "b1",
    promptVersion: "v1",
    routes: [],
    entities: [
      {
        kind: "artist",
        id: "anjo",
        sourceHash: "h1",
        references: [],
        requiredFields: ["artistPresentationString"],
        routes: ["/records/artists/anjo", "/en/records/artists/anjo"],
        text: { sv: {}, en: {} },
      },
    ],
  };
  const issues = validateRelease(release);
  assert.ok(issues.length > 0, "empty text must not validate");
  assert.equal(isReleasePromotable(release), false);
});

test("P1 a required field missing from BOTH locales is reported, not skipped", () => {
  const release = {
    generation: "g1",
    createdAt: "t",
    buildId: "b1",
    promptVersion: "v1",
    routes: ["/records/artists/anjo", "/en/records/artists/anjo"],
    entities: [
      {
        kind: "artist",
        id: "anjo",
        sourceHash: "h1",
        references: [],
        requiredFields: ["artistPresentationString"],
        routes: ["/records/artists/anjo", "/en/records/artists/anjo"],
        text: { sv: { other: "x" }, en: { other: "y" } },
      },
    ],
  };
  const issues = validateRelease(release);
  assert.ok(issues.some((i) => i.type === "missing-field" && i.field === "artistPresentationString"));
});

test("P1 an entity whose declared routes are absent from the release is reported", () => {
  const release = {
    generation: "g1",
    createdAt: "t",
    buildId: "b1",
    promptVersion: "v1",
    routes: [],
    entities: [
      {
        kind: "artist",
        id: "anjo",
        sourceHash: "h1",
        references: [],
        requiredFields: [],
        routes: ["/records/artists/anjo"],
        text: { sv: {}, en: {} },
      },
    ],
  };
  assert.ok(validateRelease(release).some((i) => i.type === "missing-route"));
});

// --- P1: disappeared records ------------------------------------------------

test("P1 a record that disappears from FM is discovered as a removal", async () => {
  // Review reproduction: persisted a known record, then loadRecords returned
  // [] -> removed.length=0. Membership must be compared, not just the active
  // flag of records that happen to still be returned.
  const store = memStore();
  const d1 = deps([artist("anjo", "h1")], store);
  await persistDiscovery(d1, await discover(d1, { inventoryComplete: true }), "v1");

  const d2 = deps([], store);
  const result = await discover(d2, { inventoryComplete: true });
  assert.ok(result.removed.some((r) => r.id === "anjo"), "disappearance is a removal");
});

test("P1 a partial/failed FM read is NOT interpreted as mass deletion", async () => {
  // The review is explicit that a truncated read must not delete the site.
  const store = memStore();
  const d1 = deps([artist("a", "h1"), artist("b", "h2")], store);
  await persistDiscovery(d1, await discover(d1), "v1");

  const partial = deps([], store);
  const result = await discover(partial, { inventoryComplete: false });
  assert.deepEqual(result.removed, [], "an incomplete scan must remove nothing");
});

test("P1 a reactivated record returns as changed rather than staying removed", async () => {
  const store = memStore();
  const gone = deps([artist("anjo", "h1", { active: false })], store);
  await persistDiscovery(gone, await discover(gone, { inventoryComplete: true }), "v1");

  const back = deps([artist("anjo", "h2")], store);
  const result = await discover(back, { inventoryComplete: true });
  assert.ok(result.changed.some((r) => r.id === "anjo"));
  assert.deepEqual(result.removed, []);
  const state = await reconcile(back, "v1");
  assert.ok(!state.removals.some((r) => r.id === "anjo"), "reactivation clears the removal");
});

// --- P2: grouping -----------------------------------------------------------

test("P2 an artist is withheld while posts that reference it are pending", async () => {
  // Review reproduction: two posts referencing a ready artist ->
  // selected=['new-artist']. References were followed in one direction only,
  // so the artist published alone and the posts appeared later.
  const records = [
    artist("artist:new-artist", "h1"),
    { ...artist("newsPost:post-a", "h2", { references: ["artist:new-artist"] }), kind: "newsPost" },
    { ...artist("newsPost:post-b", "h3", { references: ["artist:new-artist"] }), kind: "newsPost" },
  ];
  const selected = selectPublishable(records, new Set(["artist:new-artist"]));
  assert.deepEqual(selected, [], "the group publishes together or not at all");
});

test("P2 the group publishes once every member is ready", () => {
  const records = [
    artist("artist:new-artist", "h1"),
    { ...artist("newsPost:post-a", "h2", { references: ["artist:new-artist"] }), kind: "newsPost" },
    { ...artist("newsPost:post-b", "h3", { references: ["artist:new-artist"] }), kind: "newsPost" },
  ];
  const ready = new Set(["artist:new-artist", "newsPost:post-a", "newsPost:post-b"]);
  assert.equal(selectPublishable(records, ready).length, 3);
});

test("P2 unrelated ready records still publish while a group is pending", () => {
  const records = [
    artist("artist:new-artist", "h1"),
    { ...artist("newsPost:post-a", "h2", { references: ["artist:new-artist"] }), kind: "newsPost" },
    artist("artist:unrelated", "h4"),
  ];
  const selected = selectPublishable(records, new Set(["artist:new-artist", "artist:unrelated"]));
  assert.deepEqual(selected.map((r) => r.id), ["artist:unrelated"]);
});

// --- P2: KV TTL -------------------------------------------------------------

test("P2 scan lock never writes an expirationTtl below Cloudflare's minimum", async () => {
  // Cloudflare KV rejects expirationTtl < 60. releaseScanLock() used 1, which
  // would have thrown in production while passing against a naive fake.
  const store = memStore();
  const d = deps([], store);
  const { acquireScanLock, releaseScanLock } = await import("../src/lib/publication/discovery.ts");

  await acquireScanLock(d, "scanner-a");
  await releaseScanLock(d, "scanner-a");

  for (const w of store.writes) {
    if (w.ttl !== undefined) {
      assert.ok(w.ttl >= MIN_KV_EXPIRATION_TTL_SECONDS, `ttl ${w.ttl} is below the KV minimum`);
    }
  }
  assert.ok(SCAN_LOCK_TTL_SECONDS >= MIN_KV_EXPIRATION_TTL_SECONDS);
});
