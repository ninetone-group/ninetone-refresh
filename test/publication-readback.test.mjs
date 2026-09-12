/**
 * Translation read-back tests — checkpoint 4.5.
 *
 * Closes the third adapter gap: `processJob()` returns cache KEYS and discards
 * the text, so release assembly had no text source. These tests drive the real
 * consumer against a counting fake provider and then assemble a real release
 * from what it cached — end to end, with zero model calls asserted rather than
 * assumed.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  expectedFields,
  publishableRecords,
  readBackAll,
  readBackEntity,
} from "../src/lib/publication/readback.ts";
import { contentHashFor, jobsForSnapshot, writeSnapshot } from "../src/lib/publication/snapshot.ts";
import { processJob } from "../src/lib/publication/consumer.ts";
import { buildRelease } from "../src/lib/publication/release.ts";
import { validateRelease } from "../src/lib/publication/contracts.ts";

const PROMPT_VERSION = "p1";

async function testHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Mirrors translate.ts's content-addressed key shape. */
const keyFor = async (source, target, tier) => `tr:v1:${target}:${tier}:${await testHash(source)}`;

function fakeCache() {
  const map = new Map();
  return {
    map,
    reads: 0,
    async get(key) {
      this.reads += 1;
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}

function store() {
  const map = new Map();
  return {
    map,
    async get(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async put(k, v) {
      map.set(k, v);
    },
  };
}

async function snapshotOf(fields, { id = "anjo", kind = "artist", active = true, protect = [] } = {}) {
  const base = { kind, id, fields, references: [], active };
  const hash = await contentHashFor({ hash: testHash }, base, PROMPT_VERSION);
  const deps = { store: store(), hash: testHash, now: () => 1 };
  return writeSnapshot(deps, { ...base, hash }, { promptVersion: PROMPT_VERSION, protect });
}

// ---------------------------------------------------------------------------
// Completeness is verified, not assumed
// ---------------------------------------------------------------------------

test("a fully translated entity reads back complete", async () => {
  const snap = await snapshotOf({ artistPresentationShort: "Kort bio." });
  const cache = fakeCache();
  for (const locale of ["sv", "en"]) {
    cache.map.set(await keyFor("Kort bio.", locale, "fast"), `[${locale}] Kort bio.`);
  }

  const result = await readBackEntity({ cache, keyFor }, snap);
  assert.equal(result.complete, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.text.sv.artistPresentationShort, "[sv] Kort bio.");
  assert.equal(result.text.en.artistPresentationShort, "[en] Kort bio.");
});

test("a missing locale is named, not silently dropped", async () => {
  const snap = await snapshotOf({ artistPresentationShort: "Kort bio." });
  const cache = fakeCache();
  cache.map.set(await keyFor("Kort bio.", "sv", "fast"), "svensk");

  const result = await readBackEntity({ cache, keyFor }, snap);
  assert.equal(result.complete, false);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].locale, "en");
  assert.equal(result.missing[0].field, "artistPresentationShort");
  assert.ok(result.missing[0].key.startsWith("tr:v1:en:fast:"), "the looked-up key is reported");
});

test("an empty cached value counts as missing", async () => {
  const snap = await snapshotOf({ artistPresentationShort: "Text." });
  const cache = fakeCache();
  for (const locale of ["sv", "en"]) cache.map.set(await keyFor("Text.", locale, "fast"), "   ");

  const result = await readBackEntity({ cache, keyFor }, snap);
  assert.equal(result.complete, false);
  assert.equal(result.missing.length, 2, "blank is not a translation");
});

test("expected fields come from the snapshot, mirroring jobsForSnapshot", async () => {
  const snap = await snapshotOf({
    "Artist Presentation Title": "Titel",
    artistPresentationShort: "Kort.",
  });
  assert.deepEqual(expectedFields(snap).sort(), [
    "Artist Presentation Title",
    "artistPresentationShort",
  ]);
  // One job per field per locale — the read-back must expect exactly these.
  assert.equal(jobsForSnapshot(snap).length, expectedFields(snap).length * 2);
});

test("a field the source never had is not required", async () => {
  const snap = await snapshotOf({ artistPresentationShort: "Bara kort." });
  const cache = fakeCache();
  for (const locale of ["sv", "en"]) {
    cache.map.set(await keyFor("Bara kort.", locale, "fast"), `t-${locale}`);
  }
  const result = await readBackEntity({ cache, keyFor }, snap);
  assert.equal(result.complete, true, "an absent bio must not block the record");
});

// ---------------------------------------------------------------------------
// Keys are derived from the snapshot, never from live FM
// ---------------------------------------------------------------------------

test("read-back uses the snapshot's frozen text, so later FM edits cannot affect it", async () => {
  const snap = await snapshotOf({ artistPresentationShort: "ORIGINALTEXT" });
  const cache = fakeCache();
  for (const locale of ["sv", "en"]) {
    cache.map.set(await keyFor("ORIGINALTEXT", locale, "fast"), `t-${locale}`);
  }
  // A translation of some NEWER text exists in the cache too; it must not win.
  for (const locale of ["sv", "en"]) {
    cache.map.set(await keyFor("REDIGERAD TEXT", locale, "fast"), "WRONG");
  }

  const result = await readBackEntity({ cache, keyFor }, snap);
  assert.equal(result.text.sv.artistPresentationShort, "t-sv");
  assert.equal(result.text.en.artistPresentationShort, "t-en");
});

// ---------------------------------------------------------------------------
// Batch split: ready vs still preparing
// ---------------------------------------------------------------------------

test("readBackAll splits ready from incomplete", async () => {
  const ready = await snapshotOf({ artistPresentationShort: "Klar." }, { id: "klar" });
  const pending = await snapshotOf({ artistPresentationShort: "Väntar." }, { id: "vantar" });

  const cache = fakeCache();
  for (const locale of ["sv", "en"]) {
    cache.map.set(await keyFor("Klar.", locale, "fast"), `k-${locale}`);
  }
  cache.map.set(await keyFor("Väntar.", "sv", "fast"), "v-sv"); // en missing

  const result = await readBackAll({ cache, keyFor }, [ready, pending]);
  assert.deepEqual(result.ready, ["artist:klar"]);
  assert.deepEqual(result.incomplete, ["artist:vantar"]);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].ref, "artist:vantar");
});

test("an incomplete entity does not block an unrelated ready one", async () => {
  const a = await snapshotOf({ artistPresentationShort: "A." }, { id: "a" });
  const b = await snapshotOf({ artistPresentationShort: "B." }, { id: "b" });
  const cache = fakeCache();
  for (const locale of ["sv", "en"]) cache.map.set(await keyFor("A.", locale, "fast"), `a-${locale}`);

  const result = await readBackAll({ cache, keyFor }, [a, b]);
  assert.deepEqual(result.ready, ["artist:a"]);
  assert.deepEqual(result.incomplete, ["artist:b"]);
});

test("publishableRecords keeps only ready, active records", async () => {
  const records = [
    { kind: "artist", id: "a", hash: "h", fields: {}, references: [], active: true },
    { kind: "artist", id: "b", hash: "h", fields: {}, references: [], active: true },
    { kind: "artist", id: "c", hash: "h", fields: {}, references: [], active: false },
  ];
  const out = publishableRecords(records, ["artist:a", "artist:c"]);
  assert.deepEqual(out.map((r) => r.id), ["a"], "inactive is excluded even when 'ready'");
});

// ---------------------------------------------------------------------------
// End to end: consumer -> cache -> read-back -> valid release
// ---------------------------------------------------------------------------

test("consumer output feeds a VALID release, with zero model calls on reuse", async () => {
  const snap = await snapshotOf(
    { "Artist Presentation Title": "Titel", artistPresentationShort: "Kort bio." },
    { protect: ["Anjo"] },
  );
  const cache = fakeCache();

  let calls = 0;
  const consumerDeps = {
    cache,
    keyFor,
    translateFn: async ({ text, target, protect }) => {
      calls += 1;
      assert.deepEqual(protect, ["Anjo"], "protected names travel with the job");
      return `[${target}] ${text}`;
    },
    sourceFor: async (job) => snap.fields[job.field] ?? null,
    sleep: async () => {},
  };

  const jobs = jobsForSnapshot(snap);
  assert.equal(jobs.length, 4);
  for (const job of jobs) {
    const outcome = await processJob(consumerDeps, job);
    assert.equal(outcome.status, "translated");
  }
  assert.equal(calls, 4, "one call per field per locale on first pass");

  // Re-running is free — this is the property the whole cache-first design buys.
  calls = 0;
  for (const job of jobs) {
    const outcome = await processJob(consumerDeps, job);
    assert.equal(outcome.status, "reused");
  }
  assert.equal(calls, 0, "redelivery costs nothing");

  // The consumer returned only keys. Read the text back and assemble.
  const readBack = await readBackAll({ cache, keyFor }, [snap]);
  assert.deepEqual(readBack.ready, ["artist:anjo"]);

  const record = {
    kind: snap.kind,
    id: snap.id,
    hash: snap.contentHash,
    fields: snap.fields,
    references: [],
    active: true,
  };
  const release = buildRelease({
    generation: "g1",
    records: publishableRecords([record], readBack.ready),
    translations: readBack.translations,
    routesFor: () => ["/records/artists/anjo", "/en/records/artists/anjo"],
    buildId: "b1",
    promptVersion: PROMPT_VERSION,
    createdAt: "2026-09-12T00:00:00.000Z",
  });

  assert.deepEqual(validateRelease(release), [], "the assembled release must validate");
  const entity = release.entities[0];
  assert.equal(entity.text.sv["artistPresentationShort"], "[sv] Kort bio.");
  assert.equal(entity.text.en["Artist Presentation Title"], "[en] Titel");
  assert.deepEqual(
    [...entity.requiredFields].sort(),
    ["Artist Presentation Title", "artistPresentationShort"],
  );
});

test("a release assembled from an INCOMPLETE read-back fails validation", async () => {
  const snap = await snapshotOf({
    "Artist Presentation Title": "Titel",
    artistPresentationShort: "Kort.",
  });
  const cache = fakeCache();
  // Only the title translated; the blurb never did.
  for (const locale of ["sv", "en"]) {
    cache.map.set(await keyFor("Titel", locale, "fast"), `t-${locale}`);
  }

  const readBack = await readBackAll({ cache, keyFor }, [snap]);
  assert.deepEqual(readBack.ready, [], "it must not be reported ready");

  // Force it in anyway — validation is the backstop and must catch it.
  const record = {
    kind: snap.kind,
    id: snap.id,
    hash: snap.contentHash,
    fields: snap.fields,
    references: [],
    active: true,
  };
  const release = buildRelease({
    generation: "g1",
    records: [record],
    translations: readBack.translations,
    routesFor: () => ["/x"],
    buildId: "b1",
    promptVersion: PROMPT_VERSION,
    createdAt: "2026-09-12T00:00:00.000Z",
  });
  const issues = validateRelease(release);
  assert.ok(issues.length > 0, "a gap must never validate");
  assert.ok(
    issues.some((i) => i.field === "artistPresentationShort"),
    "the missing field is named",
  );
});

test("read-back makes no model calls and no FM reads", async () => {
  const snap = await snapshotOf({ artistPresentationShort: "Text." });
  const cache = fakeCache();
  for (const locale of ["sv", "en"]) cache.map.set(await keyFor("Text.", locale, "fast"), "t");

  cache.reads = 0;
  await readBackEntity({ cache, keyFor }, snap);
  assert.equal(cache.reads, 2, "exactly one read per (field, locale); nothing else is consulted");
});

// ---------------------------------------------------------------------------
// Overrides must reach the RELEASE, not only the rendered page
// ---------------------------------------------------------------------------

test("an override beats a poisoned cache entry", async () => {
  // Found in production: two FM bios are authored in ENGLISH, and the model
  // returned Swedish for the English request — twice for one of them, so
  // re-translating did not help. A human override fixed rendering (translate()
  // checks overrides before the cache), but readBackAll read KV directly and
  // would have shipped the Swedish text inside the release. The release and the
  // page disagreeing is worse than either being wrong alone.
  const snap = await snapshotOf({ artistPresentationShort: "Authored in English." });
  const cache = fakeCache();
  for (const locale of ["sv", "en"]) {
    cache.map.set(await keyFor("Authored in English.", locale, "fast"), "FEL SPRÅK");
  }

  const result = await readBackEntity(
    {
      cache,
      keyFor,
      overrideFor: async (source, locale) =>
        locale === "en" && source === "Authored in English." ? "Authored in English." : null,
    },
    snap,
  );

  assert.equal(result.complete, true);
  assert.equal(result.text.en.artistPresentationShort, "Authored in English.", "override wins");
  assert.equal(result.text.sv.artistPresentationShort, "FEL SPRÅK", "other locales fall through");
});

test("a blank override does not mask the cache", async () => {
  const snap = await snapshotOf({ artistPresentationShort: "Text." });
  const cache = fakeCache();
  for (const locale of ["sv", "en"]) cache.map.set(await keyFor("Text.", locale, "fast"), `ok-${locale}`);

  const result = await readBackEntity(
    { cache, keyFor, overrideFor: async () => "   " },
    snap,
  );
  assert.equal(result.text.en.artistPresentationShort, "ok-en", "whitespace is not an override");
});

test("read-back without overrideFor behaves exactly as before", async () => {
  const snap = await snapshotOf({ artistPresentationShort: "Text." });
  const cache = fakeCache();
  for (const locale of ["sv", "en"]) cache.map.set(await keyFor("Text.", locale, "fast"), `v-${locale}`);

  const result = await readBackEntity({ cache, keyFor }, snap);
  assert.equal(result.complete, true);
  assert.equal(result.text.sv.artistPresentationShort, "v-sv");
});
