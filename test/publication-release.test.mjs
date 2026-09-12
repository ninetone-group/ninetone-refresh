/**
 * Release assembly, promotion and consistency — checkpoint 3.
 *
 * The acceptance cases here are the ones the handoff calls out as most
 * dangerous: missing/late KV artifacts, mixed cache generations, stale
 * completions, and urgent removals that must not wait on translation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelease,
  storeRelease,
  verifyGenerationReadable,
  rejectStalePromotion,
  promoteRelease,
  resolveGeneration,
  readRelease,
  rollback,
  withRemovals,
  releaseKeys,
  RETAINED_GENERATIONS,
} from "../src/lib/publication/release.ts";
import { validateRelease } from "../src/lib/publication/contracts.ts";

const validateIssues = (release) => validateRelease(release);

function memStore() {
  const map = new Map();
  return {
    map,
    async get(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async put(k, v, o) {
      if (o?.expirationTtl !== undefined && o.expirationTtl < 60) throw new Error("ttl<60");
      map.set(k, v);
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

const deps = (store = memStore()) => ({ store, now: () => 1757700000000 });

const record = (id, hash = "h1", extra = {}) => ({
  kind: "artist",
  id,
  hash,
  fields: { artistPresentationString: `bio ${id}` },
  references: [],
  active: true,
  ...extra,
});

const translationsFor = (ref) => ({
  [ref]: {
    sv: { artistPresentationString: "svensk text" },
    en: { artistPresentationString: "english text" },
  },
});

function makeRelease(generation, records, translations, routesFor = (r) => [`/a/${r.id}`]) {
  return buildRelease({
    generation,
    records,
    translations,
    routesFor,
    buildId: "b1",
    promptVersion: "v1",
    createdAt: "2026-09-12T00:00:00Z",
  });
}

// --- assembly ---------------------------------------------------------------

test("buildRelease takes requiredFields from the SOURCE, not from the translation map", () => {
  // A field that failed to translate is absent from the map. Inferring
  // requirements from the map would make that absence invisible — the exact
  // completeness hole the review found.
  const rec = record("anjo");
  const release = makeRelease("g1", [rec], {});
  assert.deepEqual(release.entities[0].requiredFields, ["artistPresentationString"]);
  assert.deepEqual(release.entities[0].text, { sv: {}, en: {} });
});

test("a release missing a translation cannot be promoted", async () => {
  const d = deps();
  const release = makeRelease("g1", [record("anjo")], {});
  await storeRelease(d, release);
  const result = await promoteRelease(d, release, {});
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "invalid");
});

test("a complete release promotes and becomes current", async () => {
  const d = deps();
  const rec = record("anjo");
  const release = makeRelease("g1", [rec], translationsFor("artist:anjo"));
  await storeRelease(d, release);
  const result = await promoteRelease(d, release, {});
  assert.equal(result.promoted, true);
  assert.equal(await d.store.get(releaseKeys.current()), "g1");
});

// --- readiness is not the pointer ------------------------------------------

test("a bundle with no readiness marker is not readable", async () => {
  const d = deps();
  const release = makeRelease("g1", [record("anjo")], translationsFor("artist:anjo"));
  // Bundle only — simulating a crash between the two writes.
  await d.store.put(releaseKeys.bundle("g1"), JSON.stringify(release));
  assert.equal(await verifyGenerationReadable(d, "g1"), false);
});

test("a readiness marker whose bundle has not propagated is not readable", async () => {
  // KV is eventually consistent: a marker visible at this edge does not prove
  // the bundle is. Reading the bundle back is what makes "ready" mean anything.
  const d = deps();
  await d.store.put(releaseKeys.ready("g1"), JSON.stringify({ at: 1, generation: "g1" }));
  assert.equal(await verifyGenerationReadable(d, "g1"), false);
});

test("a pointer to an unreadable generation falls back to the last good one", async () => {
  const d = deps();
  const good = makeRelease("g1", [record("anjo")], translationsFor("artist:anjo"));
  await storeRelease(d, good);
  await promoteRelease(d, good, {});

  // A newer pointer appears before its bundle is readable.
  await d.store.put(releaseKeys.current(), "g2");
  await d.store.put(releaseKeys.history(), JSON.stringify(["g2", "g1"]));

  assert.equal(await resolveGeneration(d), "g1", "must serve the last complete generation");
});

test("resolveGeneration returns null when nothing is readable, never a partial read", async () => {
  // The caller must then keep its existing behaviour. A missing artifact must
  // never fall through to live, untranslated FileMaker data.
  const d = deps();
  await d.store.put(releaseKeys.current(), "ghost");
  assert.equal(await resolveGeneration(d), null);
});

// --- stale promotion --------------------------------------------------------

test("promotion is refused when FM changed during preparation", async () => {
  const d = deps();
  const release = makeRelease("g1", [record("anjo", "h1")], translationsFor("artist:anjo"));
  await storeRelease(d, release);

  const result = await promoteRelease(d, release, { "artist:anjo": "h2" });
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "stale");
  assert.deepEqual(result.issues, ["artist:anjo"]);
  assert.equal(await d.store.get(releaseKeys.current()), null, "the pointer must not move");
});

test("rejectStalePromotion ignores entities with no newer hash known", () => {
  const release = makeRelease("g1", [record("anjo", "h1")], translationsFor("artist:anjo"));
  assert.deepEqual(rejectStalePromotion(release, {}), []);
  assert.deepEqual(rejectStalePromotion(release, { "artist:anjo": "h1" }), []);
});

// --- mixed generations ------------------------------------------------------

test("every retained generation is internally complete, so a mixed-edge read is safe", async () => {
  // The handoff's requirement: a new listing link must never reach an
  // unavailable detail page. Because each generation validates as a whole, an
  // edge serving an older one shows a consistent older site.
  const d = deps();
  const first = makeRelease("g1", [record("a")], translationsFor("artist:a"));
  await storeRelease(d, first);
  await promoteRelease(d, first, {});

  const second = makeRelease(
    "g2",
    [record("a"), record("b")],
    { ...translationsFor("artist:a"), ...translationsFor("artist:b") },
  );
  await storeRelease(d, second);
  await promoteRelease(d, second, {});

  const older = await readRelease(d, "g1");
  const newer = await readRelease(d, "g2");
  assert.deepEqual(validateIssues(older), []);
  assert.deepEqual(validateIssues(newer), []);
  assert.ok(!older.routes.includes("/a/b"), "the older generation does not link to the new entity");
});

// --- history, rollback, removals -------------------------------------------

test("history is bounded and newest-first", async () => {
  const d = deps();
  for (let i = 1; i <= RETAINED_GENERATIONS + 3; i += 1) {
    const release = makeRelease(`g${i}`, [record("anjo")], translationsFor("artist:anjo"));
    await storeRelease(d, release);
    await promoteRelease(d, release, {});
  }
  const history = JSON.parse(await d.store.get(releaseKeys.history()));
  assert.equal(history.length, RETAINED_GENERATIONS);
  assert.equal(history[0], `g${RETAINED_GENERATIONS + 3}`);
});

test("rollback moves to the previous readable generation and keeps the evidence", async () => {
  const d = deps();
  const first = makeRelease("g1", [record("a")], translationsFor("artist:a"));
  await storeRelease(d, first);
  await promoteRelease(d, first, {});
  const second = makeRelease("g2", [record("a")], translationsFor("artist:a"));
  await storeRelease(d, second);
  await promoteRelease(d, second, {});

  assert.equal(await rollback(d), "g1");
  assert.equal(await d.store.get(releaseKeys.current()), "g1");
  assert.ok(await d.store.get(releaseKeys.bundle("g2")), "the rolled-back generation is retained");
});

test("withRemovals drops an entity and every reference to it, without translation", async () => {
  // An urgent withdrawal must not queue behind prose work, so a removal
  // generation is derived by filtering rather than rebuilt.
  const withRefs = {
    ...makeRelease(
      "g1",
      [record("a", "h1", { references: ["artist:b"] }), record("b")],
      { ...translationsFor("artist:a"), ...translationsFor("artist:b") },
    ),
  };
  const filtered = withRemovals(withRefs, new Set(["artist:b"]), "g2", "2026-09-12T01:00:00Z");

  assert.deepEqual(filtered.entities.map((e) => e.id), ["artist:a"]);
  assert.deepEqual(filtered.entities[0].references, [], "references to the removed entity are dropped");
  assert.ok(!filtered.routes.includes("/a/b"));
  assert.deepEqual(validateIssues(filtered), [], "the filtered generation is still complete");
});

test("a removal generation promotes without any translation work", async () => {
  const d = deps();
  const base = makeRelease(
    "g1",
    [record("a"), record("b")],
    { ...translationsFor("artist:a"), ...translationsFor("artist:b") },
  );
  await storeRelease(d, base);
  await promoteRelease(d, base, {});

  const filtered = withRemovals(base, new Set(["artist:b"]), "g2", "2026-09-12T01:00:00Z");
  await storeRelease(d, filtered);
  const result = await promoteRelease(d, filtered, {});
  assert.equal(result.promoted, true);
  assert.equal(await resolveGeneration(d), "g2");
});

test("a stale job completing after a removal cannot restore the entity", async () => {
  // Rolling back to a generation that still contains the withdrawn record
  // would resurrect it, so the removal generation must stay current.
  const d = deps();
  const base = makeRelease("g1", [record("a"), record("b")], {
    ...translationsFor("artist:a"),
    ...translationsFor("artist:b"),
  });
  await storeRelease(d, base);
  await promoteRelease(d, base, {});

  const filtered = withRemovals(base, new Set(["artist:b"]), "g2", "2026-09-12T01:00:00Z");
  await storeRelease(d, filtered);
  await promoteRelease(d, filtered, {});

  // A late completion for the removed entity tries to publish the OLD bundle.
  const result = await promoteRelease(d, base, { "artist:b": "newer-hash" });
  assert.equal(result.promoted, false, "a superseded bundle cannot be re-promoted");
  assert.equal(await resolveGeneration(d), "g2", "the removal stands");
});

test("storeRelease does not rewrite an unchanged generation (content-addressed ids reach it every tick)", async () => {
  const store = memStore();
  const puts = [];
  const originalPut = store.put.bind(store);
  store.put = async (k, v, o) => { puts.push(k); return originalPut(k, v, o); };
  const d = deps(store);
  const release = makeRelease("g-same", [record("a")], translationsFor("artist:a"));
  const first = await storeRelease(d, release);
  assert.equal(puts.length, 2, "bundle + ready marker on first store");
  const second = await storeRelease(d, release);
  assert.equal(second, first, "same digest");
  assert.equal(puts.length, 2, "no writes at all on an identical re-store");
});

test("storeRelease repairs a missing ready marker without rewriting the bundle", async () => {
  const store = memStore();
  const d = deps(store);
  const release = makeRelease("g-repair", [record("a")], translationsFor("artist:a"));
  await storeRelease(d, release);
  store.map.delete(releaseKeys.ready("g-repair")); // crash between the two puts
  const puts = [];
  const originalPut = store.put.bind(store);
  store.put = async (k, v, o) => { puts.push(k); return originalPut(k, v, o); };
  await storeRelease(d, release);
  assert.deepEqual(puts, [releaseKeys.ready("g-repair")]);
});
