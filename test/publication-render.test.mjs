/**
 * Rendering integration tests — checkpoint 4.5.
 *
 * The property that matters most here is INERTNESS: with the flag off (today's
 * state), the release path must change nothing at all — same text, same number
 * of translator calls, and not even a KV read to resolve a generation.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  pinForRequest,
  resolveFromRelease,
  servingFromRelease,
  withRelease,
} from "../src/lib/publication/render.ts";

const GENERATION = { generation: "g1", approvedAt: 1 };

function fakeTranslator() {
  const calls = [];
  const fn = async (source, kind) => {
    calls.push([source, kind]);
    return `[translated] ${String(source ?? "").trim()}`;
  };
  fn.calls = calls;
  return fn;
}

function hitLookup(text) {
  return async () => ({ status: "hit", text });
}

// ---------------------------------------------------------------------------
// Inertness while the flag is off
// ---------------------------------------------------------------------------

test("shadow mode never resolves a generation at all", async () => {
  let resolved = 0;
  const pinned = await pinForRequest({}, {
    env: {},
    resolve: async () => {
      resolved += 1;
      return GENERATION;
    },
  });

  assert.equal(pinned.mode, "shadow");
  assert.equal(pinned.generation, null);
  assert.equal(resolved, 0, "no KV read per request while shadow — pure latency otherwise");
  assert.equal(servingFromRelease(pinned), false);
});

test("off mode is equally inert", async () => {
  const pinned = await pinForRequest({}, {
    env: { PUBLICATION_SERVING: "off" },
    resolve: async () => GENERATION,
  });
  assert.equal(pinned.mode, "off");
  assert.equal(pinned.generation, null);
});

test("a near-miss flag value does NOT switch the content source", async () => {
  for (const value of ["ON", "On", "true", "1", "yes", " on"]) {
    const pinned = await pinForRequest({}, {
      env: { PUBLICATION_SERVING: value },
      resolve: async () => GENERATION,
    });
    assert.equal(pinned.generation, null, `"${value}" must not enable serving`);
  }
});

test("with the flag off the translator is used unchanged", async () => {
  const translator = fakeTranslator();
  const pinned = await pinForRequest({}, { env: {}, resolve: async () => GENERATION });

  const wrapped = withRelease(translator, {
    pinned,
    locale: "sv",
    entityId: "artist:anjo",
    fieldFor: () => "artistPresentationShort",
    lookup: hitLookup({ artistPresentationShort: "FRÅN RELEASE" }),
  });

  assert.equal(wrapped, translator, "no wrapper is even applied");
  assert.equal(await wrapped("Kort bio."), "[translated] Kort bio.");
});

// ---------------------------------------------------------------------------
// Serving from a release
// ---------------------------------------------------------------------------

test("serving mode prefers the release text", async () => {
  const translator = fakeTranslator();
  const pinned = await pinForRequest({}, {
    env: { PUBLICATION_SERVING: "on" },
    resolve: async () => GENERATION,
  });
  assert.equal(servingFromRelease(pinned), true);

  const wrapped = withRelease(translator, {
    pinned,
    locale: "sv",
    entityId: "artist:anjo",
    fieldFor: () => "artistPresentationShort",
    lookup: hitLookup({ artistPresentationShort: "FRÅN RELEASE" }),
  });

  assert.equal(await wrapped("Kort bio."), "FRÅN RELEASE");
  assert.equal(translator.calls.length, 0, "a release hit must not call the translator");
});

test("a release miss falls back to the existing translator", async () => {
  const translator = fakeTranslator();
  const pinned = await pinForRequest({}, {
    env: { PUBLICATION_SERVING: "on" },
    resolve: async () => GENERATION,
  });

  const wrapped = withRelease(translator, {
    pinned,
    locale: "sv",
    entityId: "artist:anjo",
    fieldFor: () => "artistPresentationShort",
    lookup: async () => ({ status: "miss" }),
  });

  assert.equal(await wrapped("Kort bio."), "[translated] Kort bio.");
  assert.equal(translator.calls.length, 1);
});

test("an empty release value is not served", async () => {
  const translator = fakeTranslator();
  const pinned = await pinForRequest({}, {
    env: { PUBLICATION_SERVING: "on" },
    resolve: async () => GENERATION,
  });

  const wrapped = withRelease(translator, {
    pinned,
    locale: "sv",
    entityId: "artist:anjo",
    fieldFor: () => "artistPresentationShort",
    lookup: hitLookup({ artistPresentationShort: "   " }),
  });

  assert.equal(await wrapped("Kort bio."), "[translated] Kort bio.", "blank is not a translation");
});

test("an unmappable source falls through rather than guessing", async () => {
  const translator = fakeTranslator();
  const pinned = await pinForRequest({}, {
    env: { PUBLICATION_SERVING: "on" },
    resolve: async () => GENERATION,
  });

  const wrapped = withRelease(translator, {
    pinned,
    locale: "sv",
    entityId: "artist:anjo",
    fieldFor: () => null, // caller cannot say which field this is
    lookup: hitLookup({ artistPresentationShort: "FRÅN RELEASE" }),
  });

  assert.equal(await wrapped("Okänd text."), "[translated] Okänd text.");
});

test("no entity id means no release lookup", async () => {
  const translator = fakeTranslator();
  const pinned = await pinForRequest({}, {
    env: { PUBLICATION_SERVING: "on" },
    resolve: async () => GENERATION,
  });

  const wrapped = withRelease(translator, {
    pinned,
    locale: "sv",
    entityId: null,
    fieldFor: () => "artistPresentationShort",
    lookup: hitLookup({ artistPresentationShort: "FRÅN RELEASE" }),
  });

  assert.equal(wrapped, translator, "serving one record's prose under another's name is the risk");
});

// ---------------------------------------------------------------------------
// One generation per request
// ---------------------------------------------------------------------------

test("the generation is pinned once and reused", async () => {
  const locals = {};
  let calls = 0;
  const deps = {
    env: { PUBLICATION_SERVING: "on" },
    resolve: async () => {
      calls += 1;
      return { generation: `g${calls}`, approvedAt: calls };
    },
  };

  const [a, b, c] = await Promise.all([
    pinForRequest(locals, deps),
    pinForRequest(locals, deps),
    pinForRequest(locals, deps),
  ]);

  assert.equal(calls, 1, "concurrent lookups must not each resolve a generation");
  assert.equal(a.generation.generation, "g1");
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test("a promotion landing mid-render cannot split the page", async () => {
  const locals = {};
  let current = { generation: "g1", approvedAt: 1 };
  const deps = { env: { PUBLICATION_SERVING: "on" }, resolve: async () => current };

  const first = await pinForRequest(locals, deps);
  current = { generation: "g2", approvedAt: 2 }; // promotion lands mid-render
  const second = await pinForRequest(locals, deps);

  assert.equal(second.generation.generation, "g1", "the pin wins for the whole render");
  assert.equal(first.generation.generation, "g1");
});

// ---------------------------------------------------------------------------
// Failure degrades, never throws
// ---------------------------------------------------------------------------

test("a resolver failure degrades to existing behaviour", async () => {
  const pinned = await pinForRequest({}, {
    env: { PUBLICATION_SERVING: "on" },
    resolve: async () => {
      throw new Error("KV unavailable");
    },
  });

  assert.equal(pinned.generation, null, "must not throw a render");
  assert.equal(servingFromRelease(pinned), false);

  const translator = fakeTranslator();
  const wrapped = withRelease(translator, {
    pinned,
    locale: "sv",
    entityId: "artist:anjo",
    fieldFor: () => "artistPresentationShort",
    lookup: hitLookup({ artistPresentationShort: "X" }),
  });
  assert.equal(await wrapped("Kort bio."), "[translated] Kort bio.");
});

test("resolveFromRelease returns null, never source text", async () => {
  assert.equal(
    await resolveFromRelease({ mode: "serving", generation: null }, hitLookup({ f: "x" }), "e", "sv", "f"),
    null,
  );
  assert.equal(
    await resolveFromRelease(
      { mode: "serving", generation: GENERATION },
      async () => ({ status: "unavailable" }),
      "e",
      "sv",
      "f",
    ),
    null,
  );
});
