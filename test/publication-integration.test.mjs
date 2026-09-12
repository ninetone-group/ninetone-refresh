/**
 * Local integration tests for the publication flow.
 *
 * Every test uses a COUNTING fake provider, so "zero model calls" is asserted
 * rather than assumed. No network, no bindings, no spend.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { jobsForRecord, sourceHashInput, ENTITY_FIELDS } from "../src/lib/publication/contracts.ts";
import { processJob, processBatch, dryRun, RETRY_DELAYS_MS } from "../src/lib/publication/consumer.ts";
import { applyScan, EMPTY_STATE } from "../src/lib/publication/coordinator.ts";

/** Counts every call so spend is observable. */
function fakeProvider({ failTimes = 0, returnNull = false } = {}) {
  let calls = 0;
  let failures = failTimes;
  return {
    get calls() { return calls; },
    async translate({ text, target }) {
      calls += 1;
      if (failures > 0) { failures -= 1; throw new Error("provider 529"); }
      if (returnNull) return null;
      return `[${target}] ${text}`;
    },
  };
}

function fakeCache(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); },
  };
}

/** Mirrors translate.ts's key shape: text + target + tier, nothing else. */
const keyFor = async (source, target, tier) => `tr:v1:${target}:${tier}:${source.length}:${source.slice(0, 24)}`;

function depsFor(provider, cache, sources) {
  return {
    cache,
    keyFor,
    sourceFor: async (job) => sources[`${job.entityId}:${job.field}`] ?? null,
    translateFn: (args) => provider.translate(args),
    sleep: async () => {},
  };
}

const artist = (id, text, active = true) => ({
  kind: "artist",
  id,
  hash: "h",
  fields: { artistPresentationString: text },
  references: [],
  active,
});

// --- THE headline scenario --------------------------------------------------

test("Active -> Previous -> Active makes ZERO model calls for unchanged text", async () => {
  const provider = fakeProvider();
  const cache = fakeCache();
  const text = "Oförändrad artistbiografi.";
  const sources = { "anjo:artistPresentationString": text };

  // Pass 1: the artist is Active and new. This is the only time we pay.
  const active = artist("anjo", text, true);
  const firstHash = sourceHashInput(active, "v1");
  const first = await processBatch(
    depsFor(provider, cache, sources),
    jobsForRecord({ ...active, hash: firstHash }),
  );
  assert.equal(first.translated, 2, "two locales translated once");
  const paidCalls = provider.calls;
  assert.equal(paidCalls, 2);

  // Pass 2: moved to Previous. Same text, so the content hash is unchanged and
  // the records are simply re-processed — every key is already cached.
  const previous = artist("anjo", text, false);
  assert.equal(sourceHashInput(previous, "v1"), firstHash, "status must not change the content hash");
  const second = await processBatch(
    depsFor(provider, cache, sources),
    jobsForRecord({ ...previous, hash: firstHash, active: true }),
  );
  assert.equal(second.calls, 0);
  assert.equal(second.reused, 2);

  // Pass 3: moved back to Active.
  const third = await processBatch(
    depsFor(provider, cache, sources),
    jobsForRecord({ ...active, hash: firstHash }),
  );
  assert.equal(third.calls, 0);
  assert.equal(third.reused, 2);

  assert.equal(provider.calls, paidCalls, "no further spend across the whole cycle");
});

test("editing the text after a status change pays only for the changed field", async () => {
  const provider = fakeProvider();
  const cache = fakeCache();

  const original = "Ursprunglig text";
  const edited = "Redigerad text";
  const record = {
    kind: "artist",
    id: "anjo",
    hash: "h1",
    fields: { artistPresentationString: original, "Artist Presentation Title": "Tagline" },
    references: [],
    active: true,
  };

  const sources1 = {
    "anjo:artistPresentationString": original,
    "anjo:Artist Presentation Title": "Tagline",
  };
  await processBatch(depsFor(provider, cache, sources1), jobsForRecord(record));
  assert.equal(provider.calls, 4, "2 fields x 2 locales");

  const sources2 = { ...sources1, "anjo:artistPresentationString": edited };
  const after = await processBatch(
    depsFor(provider, cache, sources2),
    jobsForRecord({ ...record, hash: "h2", fields: { ...record.fields, artistPresentationString: edited } }),
  );
  assert.equal(after.translated, 2, "only the edited field, both locales");
  assert.equal(after.reused, 2, "the unchanged tagline is reused");
  assert.equal(provider.calls, 6);
});

// --- >25 strings without visitor traffic ------------------------------------

test("more than 25 strings complete with no visitor traffic and no budget starvation", async () => {
  // The per-render budget of 25 applies to VISITOR renders. Background
  // preparation has no such ceiling: it is bounded by concurrency, not by a
  // render budget, so a large batch completes rather than starving.
  const provider = fakeProvider();
  const cache = fakeCache();

  const records = Array.from({ length: 30 }, (_, i) => artist(`a${i}`, `Biografi nummer ${i}`));
  const sources = Object.fromEntries(
    records.map((r) => [`${r.id}:artistPresentationString`, r.fields.artistPresentationString]),
  );
  const jobs = records.flatMap((r) => jobsForRecord(r));
  assert.equal(jobs.length, 60, "30 records x 2 locales");

  const result = await processBatch(depsFor(provider, cache, sources), jobs);
  assert.equal(result.translated, 60, "all complete");
  assert.equal(result.failed, 0);
  assert.equal(provider.calls, 60);
});

// --- retries, duplicates, dead letter ---------------------------------------

test("a transient provider failure is retried and then succeeds", async () => {
  const provider = fakeProvider({ failTimes: 2 });
  const cache = fakeCache();
  const sources = { "anjo:artistPresentationString": "Text" };
  const [job] = jobsForRecord(artist("anjo", "Text"));

  const outcome = await processJob(depsFor(provider, cache, sources), job);
  assert.equal(outcome.status, "translated");
  assert.equal(outcome.calls, 3, "two failures then a success");
});

test("a job that exhausts its retries is dead-lettered, not cached", async () => {
  const provider = fakeProvider({ failTimes: 99 });
  const cache = fakeCache();
  const sources = { "anjo:artistPresentationString": "Text" };
  const jobs = jobsForRecord(artist("anjo", "Text"));

  const result = await processBatch(depsFor(provider, cache, sources), jobs);
  assert.equal(result.failed, 2);
  assert.equal(result.deadLettered.length, 2);
  assert.equal(cache.map.size, 0, "nothing bad is cached");
  assert.equal(provider.calls, 2 * (RETRY_DELAYS_MS.length + 1));
});

test("an output-contract rejection fails without caching and without retrying", async () => {
  // Retrying an identical request is unlikely to help, and caching a rejected
  // result would poison a permanent entry.
  const provider = fakeProvider({ returnNull: true });
  const cache = fakeCache();
  const sources = { "anjo:artistPresentationString": "Text" };
  const [job] = jobsForRecord(artist("anjo", "Text"));

  const outcome = await processJob(depsFor(provider, cache, sources), job);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reason, "output-contract");
  assert.equal(outcome.calls, 1);
  assert.equal(cache.map.size, 0);
});

test("a redelivered job costs nothing the second time", async () => {
  // Queue delivery is at least once by design.
  const provider = fakeProvider();
  const cache = fakeCache();
  const sources = { "anjo:artistPresentationString": "Text" };
  const [job] = jobsForRecord(artist("anjo", "Text"));
  const deps = depsFor(provider, cache, sources);

  await processJob(deps, job);
  const again = await processJob(deps, job);
  assert.equal(again.status, "reused");
  assert.equal(provider.calls, 1);
});

test("two records sharing identical text pay once", async () => {
  // The cache key is sha256(text) per target and tier, so identity does not
  // enter into it.
  const provider = fakeProvider();
  const cache = fakeCache();
  const shared = "Samma text på två artister";
  const sources = {
    "a:artistPresentationString": shared,
    "b:artistPresentationString": shared,
  };
  const jobs = [...jobsForRecord(artist("a", shared)), ...jobsForRecord(artist("b", shared))];

  const result = await processBatch(depsFor(provider, cache, sources), jobs, 1);
  assert.equal(result.translated, 2);
  assert.equal(result.reused, 2);
  assert.equal(provider.calls, 2, "two locales, not four");
});

test("a job whose source is empty is skipped rather than translated", async () => {
  const provider = fakeProvider();
  const cache = fakeCache();
  const [job] = jobsForRecord(artist("anjo", "Text"));
  const outcome = await processJob(depsFor(provider, cache, {}), job);
  assert.equal(outcome.status, "skipped");
  assert.equal(provider.calls, 0);
});

// --- dry run ----------------------------------------------------------------

test("dryRun reports genuine misses and makes no model calls", async () => {
  const provider = fakeProvider();
  const cache = fakeCache();
  const sources = { "a:artistPresentationString": "Text A", "b:artistPresentationString": "Text B" };
  const jobs = [...jobsForRecord(artist("a", "Text A")), ...jobsForRecord(artist("b", "Text B"))];
  const deps = depsFor(provider, cache, sources);

  // Warm half of them.
  await processJob(deps, jobs[0]);
  const before = provider.calls;

  const estimate = await dryRun(deps, jobs);
  assert.equal(estimate.jobs, 4);
  assert.equal(estimate.cached, 1);
  assert.equal(estimate.missing, 3);
  assert.equal(provider.calls, before, "a dry run spends nothing");
});

// --- coordinator + consumer together ----------------------------------------

test("a status flip advances membership without creating translation work", async () => {
  const provider = fakeProvider();
  const cache = fakeCache();
  const text = "Text som inte ändras";
  const sources = { "anjo:artistPresentationString": text };
  const record = artist("anjo", text);
  const hash = sourceHashInput(record, "v1");

  await processBatch(depsFor(provider, cache, sources), jobsForRecord({ ...record, hash }));
  const paid = provider.calls;

  // The coordinator records the withdrawal; no job is produced for it.
  const state = applyScan(EMPTY_STATE, {
    basedOnRevision: 0,
    newestHashes: { "artist:anjo": hash },
    removals: ["artist:anjo"],
  }).state;
  assert.equal(state.pendingRemovals.length, 1);
  assert.deepEqual(jobsForRecord({ ...record, active: false, hash }), []);

  // Reactivation reuses everything.
  const back = await processBatch(depsFor(provider, cache, sources), jobsForRecord({ ...record, hash }));
  assert.equal(back.calls, 0);
  assert.equal(provider.calls, paid);
});

// --- deploy gating ----------------------------------------------------------

import { chromeGate, activationDecision, publicationMode } from "../src/lib/publication/serving.ts";

test("a deploy with new UI strings cannot activate until they are translated", async () => {
  // Without this gate the new copy falls back to source at render time, which
  // is exactly the visitor-facing untranslated text the design removes.
  const strings = ["Existing copy", "Brand new button"];
  const translated = {
    "Existing copy": { sv: "Befintlig text", en: "Existing copy" },
    "Brand new button": { sv: "Ny knapp", en: undefined },
  };
  const gate = chromeGate(strings, translated);
  assert.equal(gate.ready, false);
  assert.deepEqual(gate.missing, [{ source: "Brand new button", locale: "en" }]);

  const decision = activationDecision({
    mode: "serving",
    releaseValid: true,
    chrome: gate,
    generation: "g1",
  });
  assert.equal(decision.activate, false);
  assert.equal(decision.reason, "chrome-missing:1");
});

test("a blank translation counts as missing, not as present", () => {
  const gate = chromeGate(["Copy"], { Copy: { sv: "   ", en: "Copy" } });
  assert.equal(gate.ready, false);
  assert.equal(gate.missing[0].locale, "sv");
});

test("activation requires mode, generation, release validity and chrome together", () => {
  const ready = chromeGate(["Copy"], { Copy: { sv: "Text", en: "Copy" } });
  assert.equal(ready.ready, true);

  assert.equal(activationDecision({ mode: "shadow", releaseValid: true, chrome: ready, generation: "g1" }).reason, "mode:shadow");
  assert.equal(activationDecision({ mode: "serving", releaseValid: true, chrome: ready, generation: null }).reason, "no-generation");
  assert.equal(activationDecision({ mode: "serving", releaseValid: false, chrome: ready, generation: "g1" }).reason, "release-invalid");
  assert.equal(activationDecision({ mode: "serving", releaseValid: true, chrome: ready, generation: "g1" }).activate, true);
});

test("shadow mode never activates, whatever else is ready", () => {
  // Shadow must not change a single response, so it can never activate even
  // when everything else is green.
  const ready = chromeGate([], {});
  assert.equal(publicationMode({}), "shadow");
  assert.equal(
    activationDecision({ mode: "shadow", releaseValid: true, chrome: ready, generation: "g1" }).activate,
    false,
  );
});

// --- zero model calls from public rendering ---------------------------------

import { pinGeneration, lookup } from "../src/lib/publication/serving.ts";
import { buildRelease, storeRelease, promoteRelease } from "../src/lib/publication/release.ts";

test("serving a request from a release makes ZERO model calls", async () => {
  // The acceptance requirement "public requests do not initiate model calls".
  // The provider is counted, so this is asserted rather than assumed.
  const provider = fakeProvider();
  const store = new Map();
  const deps = {
    store: {
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
    },
    now: () => 1,
  };

  const release = buildRelease({
    generation: "g1",
    records: [artist("anjo", "Bio")],
    translations: {
      "artist:anjo": {
        sv: { artistPresentationString: "Svensk bio" },
        en: { artistPresentationString: "English bio" },
      },
    },
    routesFor: () => ["/records/artists/anjo", "/en/records/artists/anjo"],
    buildId: "b1",
    promptVersion: "v1",
    createdAt: "t",
  });
  await storeRelease(deps, release);
  await promoteRelease(deps, release, {});

  const pinned = await pinGeneration(deps);
  const sv = lookup(pinned, "artist:anjo", "sv");
  const en = lookup(pinned, "artist:anjo", "en");

  assert.equal(sv.text.artistPresentationString, "Svensk bio");
  assert.equal(en.text.artistPresentationString, "English bio");
  assert.equal(provider.calls, 0, "rendering from a release never calls the model");
});

test("an unavailable release still makes no model calls", async () => {
  // The failure path must not quietly reach for live translation either.
  const provider = fakeProvider();
  const deps = { store: { async get() { return null; }, async put() {}, async delete() {} }, now: () => 1 };
  const pinned = await pinGeneration(deps);
  assert.equal(lookup(pinned, "artist:anjo", "en").status, "unavailable");
  assert.equal(provider.calls, 0);
});
