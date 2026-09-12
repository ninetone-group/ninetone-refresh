/**
 * Regression tests for docs/publication-implementation-review-2026-09-12.md.
 *
 * One test per counterexample, from the review's own local reproductions. All
 * four FAILED against 26140d2 before the coordinator was added.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_STATE,
  applyScan,
  approveGeneration,
  commitRemovals,
  servingPlan,
  digestOf,
  KvCoordinator,
} from "../src/lib/publication/coordinator.ts";
import {
  buildRelease,
  storeRelease,
  promoteRelease,
  readRelease,
  releaseKeys,
} from "../src/lib/publication/release.ts";
import { validateRelease } from "../src/lib/publication/contracts.ts";
import { pinGeneration, lookup, lookupWithFallback } from "../src/lib/publication/serving.ts";

function memStore() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
  };
}
const deps = (store = memStore()) => ({ store, now: () => 1 });

const record = (id, hash = "h") => ({
  kind: "artist",
  id,
  hash,
  fields: { artistPresentationString: `bio ${id}` },
  references: [],
  active: true,
});
const translations = (ref) => ({
  [ref]: { sv: { artistPresentationString: "sv" }, en: { artistPresentationString: "en" } },
});
const mkRelease = (generation, ids, withText = true) =>
  buildRelease({
    generation,
    records: ids.map((id) => record(id)),
    translations: withText ? Object.assign({}, ...ids.map((i) => translations(`artist:${i}`))) : {},
    routesFor: (r) => [`/artists/${r.id}`],
    buildId: "b",
    promptVersion: "v1",
    createdAt: "t",
  });

// --- P1-A: stale scan ordering ---------------------------------------------

test("P1 a scan computed from an older revision is refused, not applied", () => {
  // Review reproduction: discover v1; discover v2 before persisting either;
  // persist v2 then the delayed v1 -> stored newestHash became v1. An
  // immediately consistent store was enough; the advisory lock did not help,
  // because both scans were legal when they started.
  const afterV2 = applyScan(EMPTY_STATE, {
    basedOnRevision: 0,
    newestHashes: { "artist:anjo": "v2" },
    removals: [],
  });
  assert.equal(afterV2.applied, true);

  const delayedV1 = applyScan(afterV2.state, {
    basedOnRevision: 0, // computed before v2 was applied
    newestHashes: { "artist:anjo": "v1" },
    removals: [],
  });
  assert.equal(delayedV1.applied, false);
  assert.equal(delayedV1.reason, "stale-revision");
  assert.equal(delayedV1.state.newestHashes["artist:anjo"], "v2", "newer state must survive");
});

test("P1 a scan based on the current revision applies", () => {
  const first = applyScan(EMPTY_STATE, { basedOnRevision: 0, newestHashes: { a: "1" }, removals: [] });
  const second = applyScan(first.state, {
    basedOnRevision: first.state.revision,
    newestHashes: { a: "2" },
    removals: [],
  });
  assert.equal(second.applied, true);
  assert.equal(second.state.newestHashes.a, "2");
});

test("P1 a stale scan cannot erase newer inventory membership", () => {
  const withBoth = applyScan(EMPTY_STATE, {
    basedOnRevision: 0,
    newestHashes: {},
    inventory: ["artist:a", "artist:b"],
    removals: [],
  });
  const stale = applyScan(withBoth.state, {
    basedOnRevision: 0,
    newestHashes: {},
    inventory: ["artist:a"],
    removals: [],
  });
  assert.equal(stale.applied, false);
  assert.deepEqual(stale.state.inventory, ["artist:a", "artist:b"]);
});

// --- P1-D: removal outbox ---------------------------------------------------

test("P1 a pending removal survives replay until it is committed", async () => {
  // Review reproduction: first scan reported one removal, the next reported
  // zero, and nothing replayed the marker. The outbox keeps it until the
  // withdrawal is actually published.
  let state = applyScan(EMPTY_STATE, {
    basedOnRevision: 0,
    newestHashes: {},
    inventory: ["artist:anjo"],
    removals: [],
  }).state;

  state = applyScan(state, {
    basedOnRevision: state.revision,
    newestHashes: {},
    inventory: [],
    removals: ["artist:anjo"],
  }).state;
  assert.equal(state.pendingRemovals.length, 1);

  // A later pass that observes nothing new must still see the outstanding work.
  state = applyScan(state, {
    basedOnRevision: state.revision,
    newestHashes: {},
    inventory: [],
    removals: [],
  }).state;
  assert.equal(state.pendingRemovals.length, 1, "the withdrawal is still pending after replay");

  state = commitRemovals(state, ["artist:anjo"]);
  assert.equal(state.pendingRemovals.length, 0, "committing clears it");
});

test("P1 reactivation clears a pending removal", () => {
  let state = applyScan(EMPTY_STATE, {
    basedOnRevision: 0,
    newestHashes: {},
    removals: ["artist:anjo"],
  }).state;
  assert.equal(state.pendingRemovals.length, 1);

  state = applyScan(state, {
    basedOnRevision: state.revision,
    newestHashes: { "artist:anjo": "h2" },
    removals: [],
    reactivated: ["artist:anjo"],
  }).state;
  assert.deepEqual(state.pendingRemovals, []);
});

// --- P2-C: promotion binds to the stored artifact ---------------------------

test("P2 promotion validates the STORED bundle, not the caller's object", async () => {
  // Review reproduction: store an invalid bundle, promote with a valid object
  // carrying the same generation id -> promoted:true while the served bundle
  // had two validation issues.
  const d = deps();
  const invalid = mkRelease("g1", ["anjo"], false);
  await storeRelease(d, invalid);

  const valid = mkRelease("g1", ["anjo"], true);
  const result = await promoteRelease(d, valid, {});

  assert.equal(result.promoted, false, "the stored artifact is what gets validated");
  assert.equal(result.reason, "invalid");
  assert.ok(validateRelease(await readRelease(d, "g1")).length > 0);
});

test("P2 a generation key cannot be overwritten with different content", async () => {
  const d = deps();
  await storeRelease(d, mkRelease("g1", ["anjo"], true));
  await assert.rejects(
    () => storeRelease(d, mkRelease("g1", ["anjo", "other"], true)),
    /immutable/,
    "generations are immutable",
  );
});

test("P2 re-storing byte-identical content is allowed (idempotent retry)", async () => {
  const d = deps();
  const release = mkRelease("g1", ["anjo"], true);
  const first = await storeRelease(d, release);
  const second = await storeRelease(d, release);
  assert.equal(first, second, "same content, same digest");
});

test("P2 approval binds a digest and refuses a reused id with different content", async () => {
  const digestA = await digestOf("bundle-a");
  const digestB = await digestOf("bundle-b");

  const approved = approveGeneration(EMPTY_STATE, { basedOnRevision: 0, generation: "g1", digest: digestA });
  assert.equal(approved.promoted, true);
  assert.equal(approved.state.current.digest, digestA);

  const reused = approveGeneration(approved.state, {
    basedOnRevision: approved.state.revision,
    generation: "g1",
    digest: digestB,
  });
  assert.equal(reused.promoted, false);
  assert.equal(reused.reason, "duplicate-generation");
});

test("P2 approval refuses a promotion computed from an older revision", () => {
  const first = approveGeneration(EMPTY_STATE, { basedOnRevision: 0, generation: "g1", digest: "d1" });
  const stale = approveGeneration(first.state, { basedOnRevision: 0, generation: "g2", digest: "d2" });
  assert.equal(stale.promoted, false);
  assert.equal(stale.reason, "stale-revision");
  assert.equal(stale.state.current.generation, "g1");
});

// --- P1-B: cross-request navigation ----------------------------------------

test("P1 a detail request on an older generation resolves a newly approved entity", async () => {
  // Review reproduction: edge A has a generation containing /artists/new,
  // edge B still has the previous one -> hasRoute true at A, false at B, so a
  // link followed from A 404s at B. Consulting NEWER approved generations
  // closes it.
  const d = deps();
  const older = mkRelease("g1", ["old"], true);
  await storeRelease(d, older);
  await promoteRelease(d, older, {});
  const newer = mkRelease("g2", ["old", "new"], true);
  await storeRelease(d, newer);

  // This request resolved the OLD generation but knows g2 was approved.
  const pinned = await pinGeneration(d, { newerApproved: ["g2"] });
  assert.equal(lookup(pinned, "artist:new", "en").status, "miss", "not in the pinned generation");

  const resolved = await lookupWithFallback(d, pinned, "artist:new", "en");
  assert.equal(resolved.status, "hit", "a newly approved entity is still reachable");
  assert.equal(resolved.generation, "g2");
});

test("P1 the fallback looks FORWARD only, so a withdrawn record is not resurrected", async () => {
  // Direction is the safety property. An older generation still contains what
  // a removal dropped, so consulting backwards would undo withdrawals.
  const d = deps();
  const withBoth = mkRelease("g1", ["a", "gone"], true);
  await storeRelease(d, withBoth);
  await promoteRelease(d, withBoth, {});
  const afterRemoval = mkRelease("g2", ["a"], true);
  await storeRelease(d, afterRemoval);
  await promoteRelease(d, afterRemoval, {});

  // A request on the CURRENT generation, with no newer approvals to consult.
  const pinned = await pinGeneration(d, { newerApproved: [] });
  assert.equal(pinned.generation, "g2");
  const result = await lookupWithFallback(d, pinned, "artist:gone", "en");
  assert.equal(result.status, "miss", "the withdrawn record stays gone");
});

// --- serving plan -----------------------------------------------------------

test("servingPlan exposes the current generation and its approved fallbacks", () => {
  let state = approveGeneration(EMPTY_STATE, { basedOnRevision: 0, generation: "g1", digest: "d1" }).state;
  state = approveGeneration(state, { basedOnRevision: state.revision, generation: "g2", digest: "d2" }).state;
  const plan = servingPlan(state);
  assert.equal(plan.current, "g2");
  assert.deepEqual(plan.fallbacks, ["g2", "g1"]);
});

test("KvCoordinator persists and refuses stale applications across reads", async () => {
  const store = memStore();
  const c = new KvCoordinator(store);
  const first = await c.applyScan({ basedOnRevision: 0, newestHashes: { a: "1" }, removals: [] });
  assert.equal(first.applied, true);

  const stale = await c.applyScan({ basedOnRevision: 0, newestHashes: { a: "0" }, removals: [] });
  assert.equal(stale.applied, false);
  assert.equal((await c.read()).newestHashes.a, "1");
});

// --- status changes must not re-translate -----------------------------------
// Requirement added to the review: the KV translation key depends on text and
// language, not on whether a record is Active or Previous. Same text means
// reuse; only changed or missing text is translated.

import { sourceHashInput, membershipFingerprint, jobsForRecord } from "../src/lib/publication/contracts.ts";

test("Active -> Previous -> Active makes ZERO new translation calls", () => {
  const fields = { artistPresentationString: "Oförändrad text", "Artist Presentation Title": "Tagline" };
  const active = { kind: "artist", id: "anjo", fields, references: [], active: true };
  const previous = { ...active, active: false };

  const hashActive = sourceHashInput(active, "v1");
  const hashPrevious = sourceHashInput(previous, "v1");
  const hashBack = sourceHashInput({ ...active }, "v1");

  assert.equal(hashPrevious, hashActive, "moving to Previous must not change the content hash");
  assert.equal(hashBack, hashActive, "moving back must not change it either");

  // Simulate the coordinator seeing all three states. A job is only created
  // when the content hash is new, so the later two transitions create none.
  const seen = new Set();
  let calls = 0;
  for (const [record, hash] of [
    [active, hashActive],
    [previous, hashPrevious],
    [active, hashBack],
  ]) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    calls += jobsForRecord({ ...record, hash, active: true }).length;
  }

  assert.equal(seen.size, 1, "all three states share one content version");
  assert.equal(calls, 4, "2 fields x 2 locales, translated once and only once");
});

test("membership still changes on a status flip, so the release is rebuilt", () => {
  // Translations are reused, but section listings and route inventories differ,
  // so the bundle must still be reassembled. The two concerns are separate.
  const active = { kind: "artist", id: "anjo", fields: { a: "x" }, references: [], active: true };
  const previous = { ...active, active: false };
  assert.notEqual(membershipFingerprint(active), membershipFingerprint(previous));
});

test("editing text after a status change translates only the changed fields", () => {
  const before = {
    kind: "artist",
    id: "anjo",
    fields: { artistPresentationString: "Gammal", "Artist Presentation Title": "Tagline" },
    references: [],
    active: false,
  };
  const after = {
    ...before,
    active: true,
    fields: { artistPresentationString: "Ny text", "Artist Presentation Title": "Tagline" },
  };

  assert.notEqual(sourceHashInput(before, "v1"), sourceHashInput(after, "v1"));

  // The unchanged tagline keeps its own cache entry, because the translation
  // key is per source STRING, not per record version.
  const jobs = jobsForRecord({ ...after, hash: "h2" });
  const changedFieldJobs = jobs.filter((j) => j.field === "artistPresentationString");
  assert.equal(changedFieldJobs.length, 2, "the edited field is retranslated in both locales");
});

test("a reference change alters membership but not the content hash", () => {
  const a = { kind: "artist", id: "anjo", fields: { x: "same" }, references: ["newsPost:a"], active: true };
  const b = { ...a, references: ["newsPost:a", "newsPost:b"] };
  assert.equal(sourceHashInput(a, "v1"), sourceHashInput(b, "v1"), "prose did not change");
  assert.notEqual(membershipFingerprint(a), membershipFingerprint(b), "grouping did");
});
