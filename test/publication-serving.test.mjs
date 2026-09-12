/**
 * Serving from a published generation — checkpoint 4.
 *
 * The acceptance requirements exercised here: one generation per request, no
 * live FM fallback when artifacts are missing, and shadow mode not changing
 * any response.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  publicationMode,
  pinGeneration,
  lookup,
  hasRoute,
  compareShadow,
} from "../src/lib/publication/serving.ts";
import { buildRelease, storeRelease, promoteRelease, releaseKeys } from "../src/lib/publication/release.ts";

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

const record = (id) => ({
  kind: "artist",
  id,
  hash: "h1",
  fields: { artistPresentationString: `bio ${id}` },
  references: [],
  active: true,
});

const translations = (ref) => ({
  [ref]: { sv: { artistPresentationString: "svensk" }, en: { artistPresentationString: "english" } },
});

async function seed(d, generation, ids) {
  const release = buildRelease({
    generation,
    records: ids.map(record),
    translations: Object.assign({}, ...ids.map((id) => translations(`artist:${id}`))),
    routesFor: (r) => [`/records/artists/${r.id}`, `/en/records/artists/${r.id}`],
    buildId: "b1",
    promptVersion: "v1",
    createdAt: "2026-09-12T00:00:00Z",
  });
  await storeRelease(d, release);
  await promoteRelease(d, release, {});
  return release;
}

// --- rollout mode -----------------------------------------------------------

test("publicationMode defaults to shadow when the flag is absent or misspelled", () => {
  // A missing or mistyped variable must never silently switch the site's
  // content source. Only an explicit "on" serves.
  assert.equal(publicationMode(undefined), "shadow");
  assert.equal(publicationMode({}), "shadow");
  assert.equal(publicationMode({ PUBLICATION_SERVING: "yes" }), "shadow");
  assert.equal(publicationMode({ PUBLICATION_SERVING: "true" }), "shadow");
  assert.equal(publicationMode({ PUBLICATION_SERVING: "on" }), "serving");
  assert.equal(publicationMode({ PUBLICATION_SERVING: "off" }), "off");
});

// --- one generation per request --------------------------------------------

test("a pinned generation is reused, so one page cannot mix generations", async () => {
  const d = deps();
  await seed(d, "g1", ["a", "b"]);
  const pinned = await pinGeneration(d);

  // A promotion lands mid-render.
  await seed(d, "g2", ["a", "b", "c"]);

  assert.equal(lookup(pinned, "artist:a", "en").generation, "g1");
  assert.equal(lookup(pinned, "artist:b", "en").generation, "g1");
  assert.equal(lookup(pinned, "artist:c", "en").status, "miss", "the new entity is not in the pinned generation");
});

test("lookup returns the requested locale's text", async () => {
  const d = deps();
  await seed(d, "g1", ["a"]);
  const pinned = await pinGeneration(d);
  assert.equal(lookup(pinned, "artist:a", "sv").text.artistPresentationString, "svensk");
  assert.equal(lookup(pinned, "artist:a", "en").text.artistPresentationString, "english");
});

test("hasRoute reflects the pinned generation's route inventory", async () => {
  const d = deps();
  await seed(d, "g1", ["a"]);
  const pinned = await pinGeneration(d);
  assert.equal(hasRoute(pinned, "/en/records/artists/a"), true);
  assert.equal(hasRoute(pinned, "/en/records/artists/nope"), false);
});

// --- no live fallback -------------------------------------------------------

test("an unresolvable generation reports unavailable, never partial data", async () => {
  // The caller must then keep its existing behaviour. Reaching into FM for
  // untranslated text here is the exact failure the design exists to prevent.
  const d = deps();
  const pinned = await pinGeneration(d);
  assert.equal(pinned.generation, null);
  assert.equal(lookup(pinned, "artist:a", "en").status, "unavailable");
});

test("a pointer naming a bundle that does not read back is treated as absent", async () => {
  const d = deps();
  await d.store.put(releaseKeys.current(), "g9");
  await d.store.put(releaseKeys.ready("g9"), JSON.stringify({ at: 1, generation: "g9" }));
  // No bundle written — the marker alone must not be believed.
  const pinned = await pinGeneration(d);
  assert.equal(pinned.release, null);
  assert.equal(lookup(pinned, "artist:a", "en").status, "unavailable");
});

// --- shadow comparison ------------------------------------------------------

test("compareShadow reports membership and field differences without asserting a verdict", async () => {
  // A difference is not automatically a defect: a release legitimately
  // withholds an entity whose translations are still preparing. The three sets
  // are the useful output, not a boolean.
  const d = deps();
  await seed(d, "g1", ["a", "b"]);
  const pinned = await pinGeneration(d);

  const result = compareShadow(pinned, [
    { id: "artist:a", text: { sv: { artistPresentationString: "svensk" }, en: { artistPresentationString: "english" } } },
    { id: "artist:c", text: { sv: {}, en: {} } },
  ]);

  assert.deepEqual(result.onlyInRelease, ["artist:b"]);
  assert.deepEqual(result.onlyInLive, ["artist:c"]);
  assert.deepEqual(result.differing, []);
});

test("compareShadow flags an entity whose text differs", async () => {
  const d = deps();
  await seed(d, "g1", ["a"]);
  const pinned = await pinGeneration(d);

  const result = compareShadow(pinned, [
    { id: "artist:a", text: { sv: { artistPresentationString: "annat" }, en: { artistPresentationString: "english" } } },
  ]);
  assert.deepEqual(result.differing, ["artist:a"]);
});

test("compareShadow with no release reports everything as live-only", () => {
  const result = compareShadow({ generation: null, release: null }, [{ id: "artist:a", text: { sv: {}, en: {} } }]);
  assert.deepEqual(result.onlyInLive, ["artist:a"]);
  assert.equal(result.generation, null);
});
