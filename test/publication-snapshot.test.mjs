/**
 * Source snapshot tests — checkpoint 4.5.
 *
 * The central property under test is the TWO-IDENTITY split:
 *   - content hash: text only, so a status change reuses every translation
 *   - snapshot version: text + membership, so a status change is still a new
 *     source version for release assembly
 *
 * Everything is injected (store, hash, now), so these run with no network, no
 * bindings and no translation spend.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  contentHashFor,
  jobsForSnapshot,
  readSnapshot,
  resolveJobSource,
  snapshotKey,
  snapshotVersionFor,
  writeSnapshot,
} from "../src/lib/publication/snapshot.ts";
import { membershipFingerprint, sourceHashInput } from "../src/lib/publication/contracts.ts";

const PROMPT_VERSION = "p1";

/** Deterministic, collision-resistant enough for tests, and order-sensitive. */
async function testHash(input) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function fakeStore() {
  const map = new Map();
  return {
    map,
    writes: 0,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      this.writes += 1;
      map.set(key, value);
    },
  };
}

function deps(store = fakeStore()) {
  return { store, hash: testHash, now: () => 1_700_000_000_000 };
}

async function recordWith({ fields, active = true, references = [], id = "anjo", kind = "artist" }) {
  const base = { kind, id, fields, references, active };
  const hash = await contentHashFor({ hash: testHash }, base, PROMPT_VERSION);
  return { ...base, hash };
}

// ---------------------------------------------------------------------------
// The two-identity split
// ---------------------------------------------------------------------------

test("snapshot version covers membership; content hash does not", async () => {
  const fields = { artistPresentationShort: "Svensk artist." };
  const active = await recordWith({ fields, active: true });
  const previous = await recordWith({ fields, active: false });

  // The CONTENT hash is deliberately blind to `active` — this is what makes a
  // status change reuse translations instead of paying for them again.
  assert.equal(active.hash, previous.hash, "content hash must ignore status");

  const d = deps();
  const a = await snapshotVersionFor(d, active);
  const p = await snapshotVersionFor(d, previous);

  assert.equal(a.contentHash, p.contentHash);
  assert.notEqual(
    a.snapshotVersion,
    p.snapshotVersion,
    "snapshot version must change when membership changes",
  );
  assert.notEqual(a.membership, p.membership);
});

test("references are membership, not content", async () => {
  const fields = { artistPresentationShort: "Text." };
  const bare = await recordWith({ fields, references: [] });
  const linked = await recordWith({ fields, references: ["newsPost:hello"] });

  assert.equal(bare.hash, linked.hash, "adding a reference must not retranslate");

  const d = deps();
  assert.notEqual(
    (await snapshotVersionFor(d, bare)).snapshotVersion,
    (await snapshotVersionFor(d, linked)).snapshotVersion,
    "a reference change is still a new source version",
  );
});

test("editing text changes both identities", async () => {
  const before = await recordWith({ fields: { artistPresentationShort: "Före." } });
  const after = await recordWith({ fields: { artistPresentationShort: "Efter." } });

  assert.notEqual(before.hash, after.hash);
  const d = deps();
  assert.notEqual(
    (await snapshotVersionFor(d, before)).snapshotVersion,
    (await snapshotVersionFor(d, after)).snapshotVersion,
  );
});

test("Active -> Previous -> Active returns to the ORIGINAL snapshot version", async () => {
  const fields = { artistPresentationShort: "Oförändrad text." };
  const d = deps();

  const v1 = (await snapshotVersionFor(d, await recordWith({ fields, active: true }))).snapshotVersion;
  const v2 = (await snapshotVersionFor(d, await recordWith({ fields, active: false }))).snapshotVersion;
  const v3 = (await snapshotVersionFor(d, await recordWith({ fields, active: true }))).snapshotVersion;

  assert.notEqual(v1, v2);
  assert.equal(v1, v3, "moving back must be the same version, not a third one");
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

test("writeSnapshot is write-once for the same version", async () => {
  const store = fakeStore();
  const d = deps(store);
  const record = await recordWith({ fields: { artistPresentationShort: "Text." } });

  const first = await writeSnapshot(d, record, { promptVersion: PROMPT_VERSION, protect: ["Anjo"] });
  const writesAfterFirst = store.writes;

  const second = await writeSnapshot(d, record, { promptVersion: PROMPT_VERSION, protect: ["Anjo"] });

  assert.equal(store.writes, writesAfterFirst, "must not rewrite an existing snapshot");
  assert.deepEqual(second, first);
});

test("a redelivered job reads byte-identical text", async () => {
  const store = fakeStore();
  const d = deps(store);
  const record = await recordWith({ fields: { artistPresentationShort: "Stabil text." } });
  const snap = await writeSnapshot(d, record, { promptVersion: PROMPT_VERSION, protect: [] });
  const [job] = jobsForSnapshot(snap);

  const a = await resolveJobSource(d, job);
  const b = await resolveJobSource(d, job);
  assert.equal(a.status, "found");
  assert.deepEqual(a, b);
});

test("a corrupt snapshot is replaced rather than returned", async () => {
  const store = fakeStore();
  const d = deps(store);
  const record = await recordWith({ fields: { artistPresentationShort: "Text." } });
  const { snapshotVersion } = await snapshotVersionFor(d, record);
  store.map.set(snapshotKey(record.kind, record.id, snapshotVersion), "{not json");

  const snap = await writeSnapshot(d, record, { promptVersion: PROMPT_VERSION, protect: [] });
  assert.equal(snap.snapshotVersion, snapshotVersion);
  assert.equal(snap.fields.artistPresentationShort, "Text.");
});

// ---------------------------------------------------------------------------
// Missing snapshot => retry, never live FM
// ---------------------------------------------------------------------------

test("a missing snapshot retries and never yields text", async () => {
  const store = fakeStore();
  const d = deps(store);
  const record = await recordWith({ fields: { artistPresentationShort: "Text." } });
  const snap = await writeSnapshot(d, record, { promptVersion: PROMPT_VERSION, protect: [] });
  const [job] = jobsForSnapshot(snap);

  store.map.clear(); // snapshot not visible at this edge yet

  const result = await resolveJobSource(d, job);
  assert.equal(result.status, "retry");
  assert.equal(result.reason, "snapshot-missing");
  assert.equal(result.text, undefined, "must not produce text from anywhere else");
});

test("a readable snapshot with a missing field is absent, not retry", async () => {
  const store = fakeStore();
  const d = deps(store);
  const record = await recordWith({ fields: { artistPresentationShort: "Text." } });
  const snap = await writeSnapshot(d, record, { promptVersion: PROMPT_VERSION, protect: [] });
  const [job] = jobsForSnapshot(snap);

  // Same snapshot, a field that was never captured.
  const result = await resolveJobSource(d, { ...job, field: "artistPresentationString" });
  assert.equal(result.status, "absent");
  assert.equal(result.reason, "field-missing");
});

test("resolving never consults FM: the store is the only source", async () => {
  const store = fakeStore();
  let reads = 0;
  const counting = {
    ...store,
    async get(key) {
      reads += 1;
      return store.get(key);
    },
    async put(key, value) {
      return store.put(key, value);
    },
  };
  const d = { store: counting, hash: testHash, now: () => 1 };
  const record = await recordWith({ fields: { artistPresentationShort: "Text." } });
  const snap = await writeSnapshot(d, record, { promptVersion: PROMPT_VERSION, protect: [] });
  const [job] = jobsForSnapshot(snap);

  reads = 0;
  const result = await resolveJobSource(d, job);
  assert.equal(result.status, "found");
  assert.equal(reads, 1, "exactly one KV read, no FM call");
});

// ---------------------------------------------------------------------------
// Jobs carry snapshot identity and protected names
// ---------------------------------------------------------------------------

test("every job names its snapshot and carries protected names", async () => {
  const d = deps();
  const record = await recordWith({
    fields: { "Artist Presentation Title": "Titel", artistPresentationShort: "Kort." },
  });
  const snap = await writeSnapshot(d, record, {
    promptVersion: PROMPT_VERSION,
    protect: ["Anjo", "Ninetone"],
  });

  const jobs = jobsForSnapshot(snap);
  assert.equal(jobs.length, 4, "2 fields x 2 locales");
  for (const job of jobs) {
    assert.equal(job.snapshotVersion, snap.snapshotVersion);
    assert.deepEqual(job.protect, ["Anjo", "Ninetone"], "protect must not be empty");
    assert.equal(job.sourceHash, snap.contentHash, "completion identity stays text-only");
  }
  assert.deepEqual(
    [...new Set(jobs.map((j) => j.target))].sort(),
    ["en", "sv"],
    "both locales, including the source language",
  );
});

test("an inactive snapshot produces zero jobs", async () => {
  const d = deps();
  const record = await recordWith({
    fields: { artistPresentationShort: "Text." },
    active: false,
  });
  const snap = await writeSnapshot(d, record, { promptVersion: PROMPT_VERSION, protect: [] });
  assert.deepEqual(jobsForSnapshot(snap), [], "a withdrawal must never queue prose work");
});

test("empty fields produce no jobs", async () => {
  const d = deps();
  const record = await recordWith({ fields: { artistPresentationShort: "Bara en." } });
  const snap = await writeSnapshot(d, record, { promptVersion: PROMPT_VERSION, protect: [] });
  const fields = new Set(jobsForSnapshot(snap).map((j) => j.field));
  assert.deepEqual([...fields], ["artistPresentationShort"]);
});

// ---------------------------------------------------------------------------
// Hash agreement with the contracts module
// ---------------------------------------------------------------------------

test("contentHashFor matches sourceHashInput + hash", async () => {
  const base = {
    kind: "artist",
    id: "anjo",
    fields: { artistPresentationShort: "Text." },
    references: [],
    active: true,
  };
  assert.equal(
    await contentHashFor({ hash: testHash }, base, PROMPT_VERSION),
    await testHash(sourceHashInput(base, PROMPT_VERSION)),
  );
});

test("snapshot version is derived from content hash and membership", async () => {
  const d = deps();
  const record = await recordWith({ fields: { artistPresentationShort: "Text." } });
  const { snapshotVersion } = await snapshotVersionFor(d, record);
  assert.equal(
    snapshotVersion,
    await testHash(`content=${record.hash}|${membershipFingerprint(record)}`),
  );
});

test("field order does not change the snapshot version", async () => {
  const d = deps();
  const a = await recordWith({ fields: { alpha: "1", beta: "2" } });
  const b = await recordWith({ fields: { beta: "2", alpha: "1" } });
  assert.equal(
    (await snapshotVersionFor(d, a)).snapshotVersion,
    (await snapshotVersionFor(d, b)).snapshotVersion,
  );
});

test("readSnapshot returns null for an unknown version", async () => {
  const d = deps();
  assert.equal(await readSnapshot(d, "artist", "anjo", "nope"), null);
});
