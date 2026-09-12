import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORTED_LOCALES,
  ENTITY_FIELDS,
  ENTITY_TIER,
  CHROME_TIER,
  normalizeFields,
  sourceHashInput,
  jobId,
  jobsForRecord,
  isCandidateComplete,
  isSuperseded,
  validateRelease,
  isReleasePromotable,
} from "../src/lib/publication/contracts.ts";

// ---------------------------------------------------------------------------
// Field inventory — the contract that has already drifted once
// ---------------------------------------------------------------------------

test("entity prose is warmed on the SAME tier fmText() reads", () => {
  // The tier is part of the translation cache key. The warm script once wrote
  // WebPosts titles on "quality" while src/lib/t.ts's fmText() asked for
  // "fast", so those keys were never looked up and /team rendered English
  // under Swedish chrome while a correct translation sat unused in KV. This
  // asserts the two halves of that contract stay in agreement.
  assert.equal(ENTITY_TIER, "fast", "fmText() requests the fast tier");
  assert.equal(CHROME_TIER, "quality", "sharedT() requests the quality tier");
  assert.notEqual(ENTITY_TIER, CHROME_TIER);
});

test("every entity kind declares at least one translatable field", () => {
  for (const [kind, fields] of Object.entries(ENTITY_FIELDS)) {
    assert.ok(fields.length > 0, `${kind} must declare fields`);
    for (const f of fields) {
      assert.ok(["plain", "markdown", "title"].includes(f.kind), `${kind}.${f.field} kind`);
    }
  }
});

test("bios are markdown so renderBio still receives markdown (decision 8)", () => {
  const bio = ENTITY_FIELDS.artist.find((f) => f.field === "artistPresentationString");
  assert.equal(bio?.kind, "markdown");
  const body = ENTITY_FIELDS.newsPost.find((f) => f.field === "MessageString");
  assert.equal(body?.kind, "markdown");
});

// ---------------------------------------------------------------------------
// Normalization and hashing
// ---------------------------------------------------------------------------

test("normalizeFields trims, matching the warm script's job()", () => {
  // A stray trailing newline in an FM field produced a different sha256 from
  // the warmed key and therefore a permanent cache miss — 67 of 886 fields
  // were affected before this was fixed. Normalizing where the hash is
  // computed keeps that from recurring.
  const fields = normalizeFields("artist", {
    "Artist Presentation Title": "  A tagline\n",
    artistPresentationString: "Bio text",
  });
  assert.equal(fields["Artist Presentation Title"], "A tagline");
  assert.equal(fields.artistPresentationString, "Bio text");
});

test("normalizeFields omits empty and whitespace-only fields", () => {
  const fields = normalizeFields("artist", {
    "Artist Presentation Title": "   ",
    artistPresentationString: "",
    artistPresentationShort: null,
  });
  assert.deepEqual(fields, {});
});

test("sourceHashInput is stable across key order but changes with content", () => {
  const base = {
    kind: "artist",
    id: "anjo",
    fields: { a: "1", b: "2" },
    references: ["news:x", "news:y"],
    active: true,
  };
  const reordered = {
    ...base,
    fields: { b: "2", a: "1" },
    references: ["news:y", "news:x"],
  };
  // References no longer affect the CONTENT hash (they are membership), so
  // this also confirms reordering them is inert here.
  assert.equal(sourceHashInput(base, "v1"), sourceHashInput(reordered, "v1"));
  assert.notEqual(sourceHashInput(base, "v1"), sourceHashInput({ ...base, fields: { a: "1", b: "3" } }, "v1"));
});

test("sourceHashInput changes when the prompt version changes", () => {
  // A prompt change invalidates every existing translation, so it must produce
  // new hashes rather than silently reusing work done under the old prompt.
  const record = { kind: "artist", id: "anjo", fields: { a: "1" }, references: [], active: true };
  assert.notEqual(sourceHashInput(record, "v1"), sourceHashInput(record, "v2"));
});

test("sourceHashInput IGNORES an activation change with identical prose", () => {
  // Corrected requirement: the translation cache is keyed on text and target
  // language, not on whether a record is Active or Previous. Folding `active`
  // into the content hash meant Active -> Previous -> Active retranslated text
  // that never changed — paid work for nothing. Membership is tracked
  // separately by membershipFingerprint().
  const record = { kind: "artist", id: "anjo", fields: { a: "1" }, references: [], active: true };
  assert.equal(sourceHashInput(record, "v1"), sourceHashInput({ ...record, active: false }, "v1"));
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

test("jobsForRecord emits one job per non-empty field per locale, both directions", () => {
  // Both locales including the record's own source language: the Team section
  // is authored in English while most of the site is Swedish, so a
  // one-directional assumption leaves one of them permanently untranslated.
  const record = {
    kind: "artist",
    id: "anjo",
    hash: "h1",
    fields: { "Artist Presentation Title": "T", artistPresentationString: "B" },
    references: [],
    active: true,
  };
  const jobs = jobsForRecord(record);
  assert.equal(jobs.length, 2 * SUPPORTED_LOCALES.length);
  assert.deepEqual([...new Set(jobs.map((j) => j.target))].sort(), ["en", "sv"]);
  assert.ok(jobs.every((j) => j.tier === "fast"));
});

test("jobsForRecord emits nothing for an inactive record", () => {
  // Withdrawals take the priority removal path and must never be held behind
  // translation work.
  const jobs = jobsForRecord({
    kind: "artist",
    id: "gone",
    hash: "h1",
    fields: { artistPresentationString: "B" },
    references: [],
    active: false,
  });
  assert.deepEqual(jobs, []);
});

test("jobId is stable for identical work and distinct across every dimension", () => {
  const base = {
    entityKind: "artist",
    entityId: "anjo",
    sourceHash: "h1",
    field: "bio",
    target: "en",
    kind: "markdown",
    tier: "fast",
    protect: [],
  };
  assert.equal(jobId(base, "v1"), jobId({ ...base }, "v1"));
  for (const [k, v] of Object.entries({
    entityId: "other",
    sourceHash: "h2",
    field: "other",
    target: "sv",
    kind: "plain",
    tier: "quality",
  })) {
    assert.notEqual(jobId(base, "v1"), jobId({ ...base, [k]: v }, "v1"), `${k} must affect the id`);
  }
  assert.notEqual(jobId(base, "v1"), jobId(base, "v2"), "key version must affect the id");
});

// ---------------------------------------------------------------------------
// Candidates — supersession and completeness
// ---------------------------------------------------------------------------

test("a candidate is complete only when every required job is done", () => {
  const candidate = {
    entityKind: "artist",
    entityId: "anjo",
    sourceHash: "h1",
    state: "preparing",
    requiredJobIds: ["a", "b"],
    completed: { a: true },
  };
  assert.equal(isCandidateComplete(candidate), false);
  assert.equal(isCandidateComplete({ ...candidate, completed: { a: true, b: true } }), true);
});

test("a candidate is superseded when FM changed during translation", () => {
  // The acceptance requirement: an older queue message completing late must
  // never overwrite state for a newer edit.
  const candidate = {
    entityKind: "artist",
    entityId: "anjo",
    sourceHash: "h1",
    state: "preparing",
    requiredJobIds: [],
    completed: {},
  };
  assert.equal(isSuperseded(candidate, "h2"), true);
  assert.equal(isSuperseded(candidate, "h1"), false);
  assert.equal(isSuperseded(candidate, undefined), false, "no newer hash known: not superseded");
});

// ---------------------------------------------------------------------------
// Release validation
// ---------------------------------------------------------------------------

function releaseWith(entities) {
  // Routes are collected from the entities so a fixture cannot accidentally
  // fail the new missing-route check while testing something else.
  return {
    generation: "g1",
    createdAt: "2026-09-12T00:00:00Z",
    entities,
    routes: entities.flatMap((e) => e.routes ?? []),
    buildId: "b1",
    promptVersion: "v1",
  };
}

const completeArtist = {
  kind: "artist",
  id: "anjo",
  sourceHash: "h1",
  references: [],
  // Required fields come from the candidate manifest now, not inferred from
  // whichever keys happen to be in the output (review P1).
  requiredFields: ["Artist Presentation Title", "artistPresentationString"],
  routes: ["/records/artists/anjo", "/en/records/artists/anjo"],
  text: {
    sv: { "Artist Presentation Title": "Svensk titel", artistPresentationString: "Svensk bio" },
    en: { "Artist Presentation Title": "English title", artistPresentationString: "English bio" },
  },
};

test("a complete release validates and is promotable", () => {
  assert.deepEqual(validateRelease(releaseWith([completeArtist])), []);
  assert.equal(isReleasePromotable(releaseWith([completeArtist])), true);
});

test("a missing locale blocks promotion", () => {
  const broken = { ...completeArtist, text: { sv: completeArtist.text.sv } };
  const issues = validateRelease(releaseWith([broken]));
  assert.ok(issues.some((i) => i.type === "missing-locale" && i.locale === "en"));
  assert.equal(isReleasePromotable(releaseWith([broken])), false);
});

test("a field present in one locale but missing in the other blocks promotion", () => {
  // This is the exact shape of the bug that shipped: an English page rendering
  // Swedish source because one field never got its translation.
  const broken = {
    ...completeArtist,
    text: {
      sv: completeArtist.text.sv,
      en: { "Artist Presentation Title": "English title" },
    },
  };
  const issues = validateRelease(releaseWith([broken]));
  assert.ok(
    issues.some((i) => i.type === "missing-field" && i.locale === "en" && i.field === "artistPresentationString"),
  );
});

test("an empty translated value blocks promotion", () => {
  const broken = {
    ...completeArtist,
    text: {
      sv: completeArtist.text.sv,
      en: { ...completeArtist.text.en, artistPresentationString: "   " },
    },
  };
  assert.ok(validateRelease(releaseWith([broken])).some((i) => i.type === "empty-value"));
});

test("a field the source never had is not required", () => {
  // An artist with no short blurb must not be blocked for lacking its
  // translation — the manifest lists only the fields the source actually had.
  assert.deepEqual(validateRelease(releaseWith([completeArtist])), []);
});

test("a required field absent from BOTH locales is now REPORTED, not skipped", () => {
  // The review's P1: inferring requirements from output meant a field that
  // vanished everywhere validated cleanly.
  const stripped = {
    ...completeArtist,
    text: { sv: { "Artist Presentation Title": "T" }, en: { "Artist Presentation Title": "T" } },
  };
  assert.ok(
    validateRelease(releaseWith([stripped])).some(
      (i) => i.type === "missing-field" && i.field === "artistPresentationString",
    ),
  );
});

test("a link to an entity outside the release blocks promotion", () => {
  // The acceptance scenario: a new artist plus two related posts must publish
  // together, so a listing link can never point at an unavailable detail page.
  const artist = { ...completeArtist, references: ["news:unreleased"] };
  const issues = validateRelease(releaseWith([artist]));
  assert.ok(issues.some((i) => i.type === "dangling-reference" && i.reference === "news:unreleased"));
});

test("a reference satisfied inside the same release validates", () => {
  const post = {
    kind: "newsPost",
    id: "news:launch",
    sourceHash: "h2",
    references: [],
    requiredFields: ["Title", "shortMessage", "MessageString"],
    routes: ["/news/launch", "/en/news/launch"],
    text: {
      sv: { Title: "Svensk rubrik", shortMessage: "Svensk ingress", MessageString: "Svensk text" },
      en: { Title: "English headline", shortMessage: "English standfirst", MessageString: "English body" },
    },
  };
  const artist = { ...completeArtist, references: ["news:launch"] };
  assert.deepEqual(validateRelease(releaseWith([artist, post])), []);
});

test("duplicate entity ids are rejected", () => {
  assert.ok(
    validateRelease(releaseWith([completeArtist, completeArtist])).some((i) => i.type === "duplicate-id"),
  );
});

// ---------------------------------------------------------------------------
// Discovery — checkpoint 2
// ---------------------------------------------------------------------------

import {
  acquireScanLock,
  releaseScanLock,
  discover,
  persistDiscovery,
  recordJobCompletion,
  pendingReferences,
  reconcile,
  selectPublishable,
  stateKeys,
} from "../src/lib/publication/discovery.ts";

/** In-memory KvLike. Honours expirationTtl: 1 as "delete" the way the code uses it. */
function memStore() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value, opts) {
      if (opts?.expirationTtl === 1 && value === "") map.delete(key);
      else map.set(key, value);
    },
  };
}

function deps(records, store = memStore()) {
  return {
    store,
    hash: async (input) => `h(${input.length})`,
    loadRecords: async () => records,
    now: () => 1757700000000,
  };
}

function artist(id, hash, extra = {}) {
  return {
    kind: "artist",
    id,
    hash,
    fields: { artistPresentationString: `bio of ${id}` },
    references: [],
    active: true,
    ...extra,
  };
}

test("discovery: a new record is changed and produces jobs for both locales", async () => {
  const d = deps([artist("anjo", "h1")]);
  const result = await discover(d);
  assert.equal(result.changed.length, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(result.jobs.length, 2, "one field x two locales");
});

test("discovery: an unchanged hash produces no work at all", async () => {
  const store = memStore();
  const d = deps([artist("anjo", "h1")], store);
  await persistDiscovery(d, await discover(d), "v1");

  const second = await discover(deps([artist("anjo", "h1")], store));
  assert.equal(second.changed.length, 0);
  assert.equal(second.unchanged, 1);
  assert.deepEqual(second.jobs, []);
});

test("discovery: an edited record is rediscovered and re-jobbed", async () => {
  const store = memStore();
  const d = deps([artist("anjo", "h1")], store);
  await persistDiscovery(d, await discover(d), "v1");

  const edited = await discover(deps([artist("anjo", "h2")], store));
  assert.equal(edited.changed.length, 1);
  assert.equal(edited.jobs.length, 2);
});

test("discovery: an inactive record is a removal and never generates translation work", async () => {
  // A withdrawal must not queue behind prose work.
  const d = deps([artist("gone", "h1", { active: false })]);
  const result = await discover(d);
  assert.equal(result.removed.length, 1);
  assert.equal(result.changed.length, 0);
  assert.deepEqual(result.jobs, []);
});

test("discovery: persisting a removal records it for the priority path", async () => {
  const store = memStore();
  const d = deps([artist("gone", "h1", { active: false })], store);
  await persistDiscovery(d, await discover(d), "v1");
  assert.ok(await store.get(stateKeys.removal("artist", "gone")));
});

test("scan lock: a second scanner cannot take a held lock", async () => {
  const d = deps([]);
  assert.equal(await acquireScanLock(d, "scanner-a"), true);
  assert.equal(await acquireScanLock(d, "scanner-b"), false);
});

test("scan lock: only the holder can release it", async () => {
  const d = deps([]);
  await acquireScanLock(d, "scanner-a");
  await releaseScanLock(d, "scanner-b");
  assert.equal(await acquireScanLock(d, "scanner-c"), false, "b must not free a's lock");
  await releaseScanLock(d, "scanner-a");
  assert.equal(await acquireScanLock(d, "scanner-c"), true);
});

test("job completion is idempotent — at-least-once delivery is safe", async () => {
  const store = memStore();
  const record = artist("anjo", "h1");
  const d = deps([record], store);
  await persistDiscovery(d, await discover(d), "v1");

  const job = {
    entityKind: "artist",
    entityId: "anjo",
    sourceHash: "h1",
    field: "artistPresentationString",
    target: "en",
    kind: "markdown",
    tier: "fast",
    protect: [],
  };
  assert.equal(await recordJobCompletion(d, job, "v1"), true);
  assert.equal(await recordJobCompletion(d, job, "v1"), true, "redelivery is a no-op, not an error");

  const state = await reconcile(d, "v1");
  const candidate = state.candidates.find((c) => c.entityId === "anjo");
  assert.equal(Object.values(candidate.completed).filter(Boolean).length, 1);
});

test("a late completion from an older edit is refused, not merged", async () => {
  // The corruption case: an older queue message finishes after a newer edit
  // was discovered. It must never overwrite the newer state.
  const store = memStore();
  const d1 = deps([artist("anjo", "h1")], store);
  await persistDiscovery(d1, await discover(d1), "v1");

  const d2 = deps([artist("anjo", "h2")], store);
  await persistDiscovery(d2, await discover(d2), "v1");

  const staleJob = {
    entityKind: "artist",
    entityId: "anjo",
    sourceHash: "h1",
    field: "artistPresentationString",
    target: "en",
    kind: "markdown",
    tier: "fast",
    protect: [],
  };
  assert.equal(await recordJobCompletion(d2, staleJob, "v1"), false, "stale completion is refused");

  const state = await reconcile(d2, "v1");
  const current = state.candidates.find((c) => c.entityId === "anjo");
  assert.equal(current.sourceHash, "h2", "reconcile reports the NEWEST version");
});

test("a completion for an unknown candidate is refused rather than creating one", async () => {
  const d = deps([]);
  const job = {
    entityKind: "artist",
    entityId: "ghost",
    sourceHash: "h9",
    field: "artistPresentationString",
    target: "en",
    kind: "markdown",
    tier: "fast",
    protect: [],
  };
  assert.equal(await recordJobCompletion(d, job, "v1"), false);
});

test("pendingReferences reports references that are not yet ready", () => {
  const record = artist("anjo", "h1", { references: ["news:a", "news:b"] });
  assert.deepEqual(pendingReferences(record, new Set(["news:a"])), ["news:b"]);
  assert.deepEqual(pendingReferences(record, new Set(["news:a", "news:b"])), []);
});

test("selectPublishable withholds a record whose reference is not ready", () => {
  // The acceptance scenario: an artist plus two related posts publish together
  // or not at all, so a listing link can never reach an unavailable detail.
  // Identities are kind-qualified — the review found bare ids compared against
  // "kind:id" references — and links now bind in BOTH directions, so the
  // referenced post being pending also withholds the artist.
  const records = [
    artist("artist:anjo", "h1", { references: ["newsPost:a", "newsPost:b"] }),
    { ...artist("newsPost:a", "h2"), kind: "newsPost" },
  ];
  const ready = new Set(["artist:anjo", "newsPost:a"]);
  assert.deepEqual(selectPublishable(records, ready), [], "the group waits for newsPost:b");
});

test("selectPublishable includes the group once every reference is ready", () => {
  const records = [
    artist("artist:anjo", "h1", { references: ["newsPost:a", "newsPost:b"] }),
    { ...artist("newsPost:a", "h2"), kind: "newsPost" },
    { ...artist("newsPost:b", "h3"), kind: "newsPost" },
  ];
  const ready = new Set(["artist:anjo", "newsPost:a", "newsPost:b"]);
  assert.deepEqual(
    selectPublishable(records, ready).map((r) => r.id).sort(),
    ["artist:anjo", "newsPost:a", "newsPost:b"],
  );
});

test("selectPublishable does not let one failed record block unrelated ready records", () => {
  // Design: compose from validated new versions, omitting pending new records,
  // rather than holding the whole site for one failure.
  const records = [artist("artist:anjo", "h1"), artist("artist:stuck", "h2"), artist("artist:other", "h3")];
  const ready = new Set(["artist:anjo", "artist:other"]);
  assert.deepEqual(
    selectPublishable(records, ready).map((r) => r.id).sort(),
    ["artist:anjo", "artist:other"],
  );
});

test("selectPublishable reaches a fixed point when dropping a record strands another", () => {
  // Readiness is transitive: dropping "c" must also drop "b", which referenced
  // it, and then "a", which referenced "b".
  const records = [
    artist("artist:a", "h1", { references: ["artist:b"] }),
    artist("artist:b", "h2", { references: ["artist:c"] }),
    artist("artist:c", "h3"),
  ];
  assert.deepEqual(selectPublishable(records, new Set(["artist:a", "artist:b"])).map((r) => r.id), []);
});

test("selectPublishable omits inactive records even when marked ready", () => {
  const records = [artist("artist:gone", "h1", { active: false })];
  assert.deepEqual(selectPublishable(records, new Set(["artist:gone"])), []);
});
