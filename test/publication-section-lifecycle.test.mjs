/**
 * webPostSection lifecycle — the three cases a section+blocks group goes
 * through, pinned as regressions.
 *
 * WHY THIS FILE EXISTS. Modelling a section's title separately from its
 * repeated blocks, with references binding them in both directions, makes
 * "the section is withheld" an outcome that is CORRECT in one case, WRONG in
 * another, and IRRELEVANT in a third. Reviewing the code alone conflates them,
 * so each is pinned here against the real release machinery:
 *
 *   1. NEW section, one block still translating
 *      -> the whole group is withheld. Correct: a half-translated section must
 *         never become visible ("ready before visible").
 *
 *   2. EXISTING published section being edited, new text still translating
 *      -> the candidate generation publishes nothing, but the PREVIOUS
 *         generation keeps serving, so visitors keep seeing the last fully
 *         translated version. Withholding must never mean "the section
 *         disappears from the live site".
 *
 *   3. A block is DELETED
 *      -> the block goes immediately, the section and its surviving blocks
 *         stay, and the section's dangling reference is dropped. A withdrawal
 *         must never queue behind unrelated prose work.
 *
 * The failure mode these guard against is a future change that makes case 2
 * behave like case 1 — an edit in flight blanking a live section — which would
 * look like data loss to anyone editing in FileMaker.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { selectPublishable } from "../src/lib/publication/discovery.ts";
import {
  buildRelease,
  readRelease,
  resolveGeneration,
  storeRelease,
  withRemovals,
} from "../src/lib/publication/release.ts";
import { validateRelease } from "../src/lib/publication/contracts.ts";

const KIND = "webPostSection";
const SECTION = `${KIND}:Sek`;
const BLOCK_1 = `${KIND}:Sek#1`;
const BLOCK_2 = `${KIND}:Sek#2`;

function kv() {
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

/** Mirrors fm-source.ts: section references its blocks, each block its section. */
function group(hash = "h1") {
  return [
    { kind: KIND, id: "Sek", hash, fields: { title: "T" }, references: [BLOCK_1, BLOCK_2], active: true },
    { kind: KIND, id: "Sek#1", hash, fields: { subject: "A" }, references: [SECTION], active: true },
    { kind: KIND, id: "Sek#2", hash, fields: { subject: "B" }, references: [SECTION], active: true },
  ];
}

const translationsFor = (records) =>
  Object.fromEntries(
    records.map((r) => [
      `${r.kind}:${r.id}`,
      { sv: Object.fromEntries(Object.keys(r.fields).map((f) => [f, `sv-${f}`])), en: Object.fromEntries(Object.keys(r.fields).map((f) => [f, `en-${f}`])) },
    ]),
  );

async function publishGeneration(deps, store, records, generation) {
  const release = buildRelease({
    generation,
    records,
    translations: translationsFor(records),
    routesFor: () => ["/sek"],
    buildId: "b1",
    promptVersion: "p1",
    createdAt: "2026-09-12T00:00:00.000Z",
  });
  assert.deepEqual(validateRelease(release), [], `${generation} must validate`);
  await storeRelease(deps, release);
  await store.put("rel:v1:current", generation);
  await store.put("rel:v1:history", JSON.stringify([generation]));
  return release;
}

// ---------------------------------------------------------------------------

test("case 1: a NEW section is withheld until every block is translated", () => {
  const records = group();
  const partiallyReady = new Set([SECTION, BLOCK_1]); // block 2 still translating

  const publishable = selectPublishable(records, partiallyReady);
  assert.deepEqual(publishable, [], "a half-translated section must not become visible");
});

test("case 1: the group publishes together once every block is ready", () => {
  const records = group();
  const allReady = new Set([SECTION, BLOCK_1, BLOCK_2]);

  const ids = selectPublishable(records, allReady).map((r) => r.id).sort();
  assert.deepEqual(ids, ["Sek", "Sek#1", "Sek#2"]);
});

test("case 1: an unrelated record is NOT held back by a preparing section", () => {
  const artist = { kind: "artist", id: "anjo", hash: "h", fields: {}, references: [], active: true };
  const records = [...group(), artist];
  const ready = new Set([SECTION, BLOCK_1, "artist:anjo"]); // block 2 preparing

  const ids = selectPublishable(records, ready).map((r) => r.id);
  assert.deepEqual(ids, ["anjo"], "withholding must be scoped to the reference group");
});

test("case 2: an edit in flight leaves the PREVIOUS generation serving", async () => {
  const store = kv();
  const deps = { store, now: () => 1 };

  // A fully translated section is published and promoted.
  await publishGeneration(deps, store, group("h1"), "g1");
  assert.equal(await resolveGeneration(deps), "g1");

  // The section is edited; the new text for block 2 has not translated yet.
  const edited = group("h2");
  const stillPreparing = new Set([SECTION, BLOCK_1]);
  assert.deepEqual(
    selectPublishable(edited, stillPreparing),
    [],
    "the CANDIDATE generation correctly publishes nothing",
  );

  // The live site is unaffected: g1 is still current and still has the section.
  assert.equal(await resolveGeneration(deps), "g1", "an in-flight edit must not blank a live section");
  const served = await readRelease(deps, "g1");
  assert.ok(
    served.entities.some((e) => e.id === SECTION),
    "visitors keep seeing the last fully translated version",
  );
  assert.equal(served.entities.length, 3);
});

test("case 2: promotion only happens when the new generation is complete", async () => {
  const store = kv();
  const deps = { store, now: () => 1 };
  await publishGeneration(deps, store, group("h1"), "g1");

  // Once the edit finishes translating, the new generation is publishable.
  const edited = group("h2");
  const allReady = new Set([SECTION, BLOCK_1, BLOCK_2]);
  const publishable = selectPublishable(edited, allReady);
  assert.equal(publishable.length, 3);

  await publishGeneration(deps, store, publishable, "g2");
  assert.equal(await resolveGeneration(deps), "g2", "the edit becomes visible only when complete");
});

test("case 3: deleting a block removes it WITHOUT waiting for translation", async () => {
  const store = kv();
  const deps = { store, now: () => 1 };
  const g1 = await publishGeneration(deps, store, group("h1"), "g1");

  // Derived by FILTERING an existing generation — no translation involved.
  const g2 = withRemovals(g1, new Set([BLOCK_2]), "g2", "2026-09-12T01:00:00.000Z");

  const ids = g2.entities.map((e) => e.id).sort();
  assert.deepEqual(ids, [SECTION, BLOCK_1], "the section and its surviving block stay");
});

test("case 3: the section's dangling reference is dropped", async () => {
  const store = kv();
  const deps = { store, now: () => 1 };
  const g1 = await publishGeneration(deps, store, group("h1"), "g1");

  const g2 = withRemovals(g1, new Set([BLOCK_2]), "g2", "2026-09-12T01:00:00.000Z");
  const section = g2.entities.find((e) => e.id === SECTION);

  assert.deepEqual(section.references, [BLOCK_1], "nothing may link to a removed block");
  assert.deepEqual(validateRelease(g2), [], "a removal generation must validate");
});

test("case 3: removing the whole section removes its blocks' parent cleanly", async () => {
  const store = kv();
  const deps = { store, now: () => 1 };
  const g1 = await publishGeneration(deps, store, group("h1"), "g1");

  const g2 = withRemovals(g1, new Set([SECTION, BLOCK_1, BLOCK_2]), "g2", "2026-09-12T01:00:00.000Z");
  assert.deepEqual(g2.entities, []);
  assert.deepEqual(validateRelease(g2), []);
});

test("a deleted block leaves no stale reference once the section is re-scanned", () => {
  // In a real scan the deleted block is simply ABSENT and the section's
  // references are re-derived in the SAME pass, so both come from one
  // loadSourceRecords() call and cannot disagree.
  const rescanned = [
    { kind: KIND, id: "Sek", hash: "h2", fields: { title: "T" }, references: [BLOCK_1], active: true },
    { kind: KIND, id: "Sek#1", hash: "h1", fields: { subject: "A" }, references: [SECTION], active: true },
  ];
  const ids = selectPublishable(rescanned, new Set([SECTION, BLOCK_1])).map((r) => r.id).sort();
  assert.deepEqual(ids, ["Sek", "Sek#1"], "the survivors publish without the deleted block");
});
