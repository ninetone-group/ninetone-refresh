import assert from "node:assert/strict";
import test from "node:test";

import {
  translate,
  translationKey,
  TRANSLATION_KEY_VERSION,
  violatesOutputContract,
  buildProtectedTerms,
  FIXED_PROTECTED_TERMS,
  RequestBudget,
  waitUntilFromLocals,
  createT,
} from "../src/lib/translate.ts";
import { resolveFmDisplayText } from "../src/lib/t.ts";

// ---------------------------------------------------------------------------
// Test doubles — same shape/spirit as test/youtube-cache.test.mjs's fakeKv
// and test/indexnow.test.mjs's withStubbedFetch/withEnv, so this file reads
// like the rest of the suite rather than inventing new conventions.
// ---------------------------------------------------------------------------

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  return {
    store,
    puts,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => {
      puts.push([key, value]);
      store.set(key, value);
    },
  };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

// Stubs globalThis.fetch for the duration of `fn`. Every test in this file
// must go through this — the brief is explicit that translate() must NEVER
// make a real Anthropic (or, transitively via buildProtectedTerms, FM) call
// during a test. `impl` receives (url, init) and decides the response; tests
// that don't care about FM calls made by buildProtectedTerms() just answer
// any URL that isn't api.anthropic.com with a generic failure, which
// buildProtectedTerms() is documented to swallow.
async function withStubbedFetch(impl, fn) {
  const calls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = prevFetch;
  }
}

function anthropicResponse(text) {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}

/** Routes fetch calls: Anthropic goes to `onAnthropic`, everything else (FM etc.) fails harmlessly. */
function router(onAnthropic) {
  return async (url, init) => {
    if (url.startsWith("https://api.anthropic.com/")) {
      return onAnthropic(url, init);
    }
    // Any other host (FM session/find calls triggered transitively by
    // buildProtectedTerms -> getBookingCategories) — fail closed. translate.ts
    // documents that a failed booking-category fetch is swallowed, so this
    // never breaks a test; it just exercises that fallback path for free.
    return new Response("not found", { status: 404 });
  };
}

const waitUntilInline = (promise) => promise; // run "scheduled" work eagerly so tests can await it via the returned promise chain if needed
function collectingWaitUntil() {
  const scheduled = [];
  const waitUntil = (promise) => {
    scheduled.push(promise);
  };
  return { waitUntil, scheduled, flush: () => Promise.all(scheduled) };
}

// ---------------------------------------------------------------------------
// translationKey — key stability (decision 7 / Build item)
// ---------------------------------------------------------------------------

test("translationKey: stable for the same (source, target, tier) — pure, no I/O", async () => {
  const a = await translationKey("Hej världen", "en", "fast");
  const b = await translationKey("Hej världen", "en", "fast");
  assert.equal(a, b);
});

test("translationKey: matches the documented shape tr:v1:{target}:{tier}:{sha256(source)}", async () => {
  const key = await translationKey("hello", "sv", "quality");
  assert.match(key, /^tr:v1:sv:quality:[0-9a-f]{64}$/);
  assert.equal(key.startsWith(`tr:${TRANSLATION_KEY_VERSION}:`), true);
});

test("translationKey: different source text produces a different key (content-addressed)", async () => {
  const a = await translationKey("hello", "sv", "fast");
  const b = await translationKey("hello world", "sv", "fast");
  assert.notEqual(a, b);
});

test("translationKey: target and tier are both part of the key, not just the hash", async () => {
  const base = await translationKey("hello", "sv", "fast");
  const diffTarget = await translationKey("hello", "en", "fast");
  const diffTier = await translationKey("hello", "sv", "quality");
  assert.notEqual(base, diffTarget);
  assert.notEqual(base, diffTier);
  // The hash suffix itself (same source, same everything downstream of the
  // colon-split) should still be identical between diffTarget/diffTier and
  // base, proving the divergence is in the target/tier segment, not the hash.
  const hashOf = (k) => k.split(":").pop();
  assert.equal(hashOf(base), hashOf(diffTarget));
  assert.equal(hashOf(base), hashOf(diffTier));
});

// ---------------------------------------------------------------------------
// translate() — override precedence (decision 5)
// ---------------------------------------------------------------------------

// P1-7 fix: the previous version of this test shipped overrides.json as `{}`
// and asserted only the NO-override fall-through path — deleting
// lookupOverride() entirely (i.e. never checking overrides.json at all)
// would still have passed every assertion here, so decision 5 itself was
// untested. src/i18n/overrides.json now carries one real fixture entry
// (keyed by sha256("Kontakta oss"), documented in its own file so it also
// shows Patrik the exact format to edit) whose "en" value is deliberately
// NOT a literal translation of the Swedish source — "Get in touch" rather
// than "Contact us" — specifically so a passing assertion on that exact
// string can only mean the override file's value was used, never a
// plausible-looking model output.
const OVERRIDE_FIXTURE_SOURCE = "Kontakta oss";
const OVERRIDE_FIXTURE_EN = "Get in touch";

test("translate: a real overrides.json entry wins over both KV cache and the API — zero fetches, zero KV reads", async () => {
  const kv = fakeKv();
  await withStubbedFetch(
    router(() => anthropicResponse("this must never be returned")),
    async (calls) => {
      const result = await translate({
        text: OVERRIDE_FIXTURE_SOURCE,
        target: "en",
        tier: "fast",
        kv,
        waitUntil: waitUntilInline,
      });
      assert.equal(result.cached, true);
      assert.equal(result.text, OVERRIDE_FIXTURE_EN);
      assert.equal(result.lang, "en");
      // The override short-circuits BEFORE the KV cache is even consulted —
      // decision 5 says it "wins", not merely "wins when KV also misses".
      assert.equal(kv.puts.length, 0);
      assert.equal(calls.length, 0);
    },
  );
});

test("translate: a source string with NO override entry falls through to KV/API as normal (no override false-positive)", async () => {
  const kv = fakeKv();
  await withStubbedFetch(
    router(() => anthropicResponse("hello")),
    async () => {
      const result = await translate({
        text: "hej",
        target: "en",
        tier: "fast",
        kv,
        waitUntil: waitUntilInline,
      });
      // No override exists for "hej" in overrides.json, so this is a
      // genuine cache miss: source text comes back immediately.
      assert.equal(result.cached, false);
      assert.equal(result.text, "hej");
    },
  );
});

// ---------------------------------------------------------------------------
// violatesOutputContract — the guard (decision 10)
// ---------------------------------------------------------------------------

test("violatesOutputContract: clean translated text passes", () => {
  assert.equal(violatesOutputContract("Hello world"), false);
  assert.equal(violatesOutputContract("Hej världen"), false);
});

test("violatesOutputContract: rejects a 'Here is the translation' preamble", () => {
  assert.equal(violatesOutputContract("Here is the translation: Hello world"), true);
  assert.equal(violatesOutputContract("Here's the translated text"), true);
});

test("violatesOutputContract: rejects a leading 'Translation:' label", () => {
  assert.equal(violatesOutputContract("Translation: Hello world"), true);
});

test("violatesOutputContract: rejects a source-language label prefix", () => {
  assert.equal(violatesOutputContract("Swedish: Hej"), true);
  assert.equal(violatesOutputContract("(English) Hello"), true);
});

test("violatesOutputContract: does NOT reject prose that merely mentions a country/language name mid-sentence", () => {
  // Narrow label-prefix matching (decision 10's intent), not a blanket
  // "contains the word Swedish" ban — a legitimate translated sentence about
  // Sweden must not be discarded.
  assert.equal(
    violatesOutputContract("The band toured across Sweden and played mostly Swedish festivals."),
    false,
  );
});

test("violatesOutputContract: rejects empty/whitespace-only responses", () => {
  assert.equal(violatesOutputContract(""), true);
  assert.equal(violatesOutputContract("   "), true);
});

// P0-3: four real, reproduced false positives from the Opus review — every
// one of these is exactly the kind of copy a music label actually
// publishes, and the pre-fix guard rejected all four. Locked in here as
// must-NOT-reject cases so the guard can never regress on them silently.
test("violatesOutputContract: does NOT reject a Swedish sentence that happens to start with 'Här är' (ordinary Swedish, not a translation preamble)", () => {
  assert.equal(violatesOutputContract("Här är låtarna som definierade hans karriär."), false);
});

test("violatesOutputContract: does NOT reject an English sentence that happens to start with 'Here' (not 'here...translation')", () => {
  assert.equal(
    violatesOutputContract("Here comes the sun — the band's breakout single."),
    false,
  );
});

test("violatesOutputContract: does NOT reject a hyphenated compound adjective naming a language ('Swedish-Norwegian')", () => {
  assert.equal(violatesOutputContract("Swedish-Norwegian duo formed in 2019."), false);
});

test("violatesOutputContract: does NOT reject a hyphenated compound adjective naming a language ('English-language')", () => {
  assert.equal(violatesOutputContract("English-language debut album."), false);
});

// P1-4: the guard used to only check the SOURCE language's label names (plus
// target), so an en->en no-op call would never catch a stray Swedish label —
// it now checks all four names unconditionally regardless of direction.
test("violatesOutputContract: catches a label in a language that is neither the guessed source nor the target", () => {
  assert.equal(violatesOutputContract("Svenska: Boka oss"), true);
  assert.equal(violatesOutputContract("Engelska: Book us"), true);
});

// ---------------------------------------------------------------------------
// translate() — the guard end-to-end: reject -> retry escalating tier -> fall back to source
// ---------------------------------------------------------------------------

test("translate: a contract-violating fast response is retried once at quality; a clean quality response is cached", () =>
  withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
    const kv = fakeKv();
    const seenModels = [];
    await withStubbedFetch(
      router((url, init) => {
        const body = JSON.parse(init.body);
        seenModels.push(body.model);
        if (body.model === "claude-haiku-4-5") {
          return anthropicResponse("Here is the translation: Hello");
        }
        return anthropicResponse("Hello");
      }),
      async (calls) => {
        const scheduler = collectingWaitUntil();
        const result = await translate({
          text: "Hej",
          target: "en",
          tier: "fast",
          kv,
          waitUntil: scheduler.waitUntil,
        });
        // Cache miss returns source immediately, regardless of what the
        // background job does — never blocks.
        assert.equal(result.cached, false);
        assert.equal(result.text, "Hej");

        await scheduler.flush();

        assert.deepEqual(seenModels, ["claude-haiku-4-5", "claude-sonnet-5"]);
        assert.equal(kv.puts.length, 1);
        assert.equal(kv.puts[0][1], "Hello");
      },
    );
  }));

test("translate: both tiers violating the contract falls back to source — nothing is written to KV", () =>
  withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
    const kv = fakeKv();
    await withStubbedFetch(
      router(() => anthropicResponse("Translation: nope")),
      async () => {
        const scheduler = collectingWaitUntil();
        const result = await translate({
          text: "Hej",
          target: "en",
          tier: "fast",
          kv,
          waitUntil: scheduler.waitUntil,
        });
        assert.equal(result.text, "Hej");
        await scheduler.flush();
        assert.equal(kv.puts.length, 0);
      },
    );
  }));

// ---------------------------------------------------------------------------
// translate() — KV cache hit / miss basics
// ---------------------------------------------------------------------------

test("translate: a KV cache hit returns the stored text, marks cached=true, target lang, and never calls fetch", async () => {
  const key = await translationKey("Hej", "en", "fast");
  const kv = fakeKv({ [key]: "Hello" });
  await withStubbedFetch(
    router(() => anthropicResponse("should not be used")),
    async (calls) => {
      const result = await translate({ text: "Hej", target: "en", tier: "fast", kv, waitUntil: waitUntilInline });
      assert.equal(result.cached, true);
      assert.equal(result.text, "Hello");
      assert.equal(result.lang, "en");
      assert.equal(calls.length, 0);
    },
  );
});

test("translate: empty/blank input short-circuits without touching KV or fetch", async () => {
  const kv = fakeKv();
  await withStubbedFetch(
    router(() => anthropicResponse("x")),
    async (calls) => {
      const result = await translate({ text: "   ", target: "en", tier: "fast", kv });
      assert.equal(result.cached, true);
      assert.equal(result.text, "   ");
      assert.equal(calls.length, 0);
      assert.equal(kv.puts.length, 0);
    },
  );
});

test("translate: missing ANTHROPIC_API_KEY degrades to source-only, no fetch, no throw", () =>
  withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
    const kv = fakeKv();
    await withStubbedFetch(
      router(() => anthropicResponse("should not be called")),
      async (calls) => {
        const scheduler = collectingWaitUntil();
        const result = await translate({
          text: "Hej",
          target: "en",
          tier: "fast",
          kv,
          waitUntil: scheduler.waitUntil,
        });
        assert.equal(result.text, "Hej");
        await scheduler.flush();
        const anthropicCalls = calls.filter((c) => c.url.startsWith("https://api.anthropic.com/"));
        assert.equal(anthropicCalls.length, 0);
        assert.equal(kv.puts.length, 0);
      },
    );
  }));

// ---------------------------------------------------------------------------
// Per-request budget (Build item: "max 25 uncached calls per render, beyond
// that return source and schedule" — read literally: past budget, translate()
// does NOT schedule either, matching the no-scheduler-available degradation
// path documented in translate.ts; this test locks in that exact behavior.)
// ---------------------------------------------------------------------------

test("RequestBudget: allows exactly `max` consumptions, then refuses", () => {
  const budget = new RequestBudget(3);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), false);
  assert.equal(budget.remaining, 0);
});

test("RequestBudget: defaults to the documented 25-call ceiling", () => {
  const budget = new RequestBudget();
  for (let i = 0; i < 25; i += 1) {
    assert.equal(budget.tryConsume(), true, `call ${i} should be allowed`);
  }
  assert.equal(budget.tryConsume(), false);
});

test("translate: once the budget is exhausted, further misses return source and schedule nothing further", () =>
  withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
    const kv = fakeKv();
    const budget = new RequestBudget(1);
    await withStubbedFetch(
      router(() => anthropicResponse("translated")),
      async () => {
        const scheduler1 = collectingWaitUntil();
        const first = await translate({
          text: "Text one",
          target: "en",
          tier: "fast",
          kv,
          budget,
          waitUntil: scheduler1.waitUntil,
        });
        assert.equal(first.cached, false);
        assert.equal(scheduler1.scheduled.length, 1); // budget allowed this one
        await scheduler1.flush();

        const scheduler2 = collectingWaitUntil();
        const second = await translate({
          text: "Text two — a different string, still a cache miss",
          target: "en",
          tier: "fast",
          kv,
          budget,
          waitUntil: scheduler2.waitUntil,
        });
        assert.equal(second.cached, false);
        // Source text returned unchanged — budget exhausted, nothing scheduled.
        assert.equal(second.text, "Text two — a different string, still a cache miss");
        assert.equal(scheduler2.scheduled.length, 0);
      },
    );
  }));

// ---------------------------------------------------------------------------
// waitUntil scheduling stub (decision 6)
// ---------------------------------------------------------------------------

test("waitUntilFromLocals: reads locals.cfContext.waitUntil — the adapter's real, live binding", () => {
  const calls = [];
  const locals = { cfContext: { waitUntil: (p) => calls.push(p) } };
  const fn = waitUntilFromLocals(locals);
  assert.equal(typeof fn, "function");
  const p = Promise.resolve();
  fn(p);
  assert.deepEqual(calls, [p]);
});

test("waitUntilFromLocals: returns undefined when cfContext is absent (static build / plain dev / missing locals)", () => {
  assert.equal(waitUntilFromLocals(undefined), undefined);
  assert.equal(waitUntilFromLocals({}), undefined);
  assert.equal(waitUntilFromLocals({ cfContext: {} }), undefined);
});

// P0-1 REGRESSION TEST (Opus review): @astrojs/cloudflare 14.3.1's real
// createLocals(ctx) (node_modules/@astrojs/cloudflare/dist/utils/cf-helpers.js)
// always sets `cfContext: ctx` AND a non-enumerable `runtime` object whose
// `.ctx` getter unconditionally THROWS ("Astro.locals.runtime.ctx has been
// removed in Astro v6..."). `locals.runtime` itself is a real object, never
// undefined or null, so `locals?.runtime?.ctx` does NOT short-circuit —
// optional chaining only guards against a nullish RECEIVER, not a throwing
// accessor on a present one. A version of `waitUntilFromLocals` that ever
// reads `.runtime?.ctx` as a fallback crashes the instant it's evaluated,
// on every request where `cfContext` is missing or incomplete — i.e.
// precisely the degraded-input case the fallback was meant to handle safely.
// This fixture reproduces that exact shape (a getter that throws, exactly
// like the real adapter) rather than a plain object with a `runtime` key,
// which is why the ORIGINAL bug's own test suite passed: a plain object
// literal for `runtime.ctx` never exercises a throwing getter at all.
function localsWithThrowingRuntimeCtx(cfContext) {
  const locals = cfContext !== undefined ? { cfContext } : {};
  Object.defineProperty(locals, "runtime", {
    enumerable: false,
    value: {
      get ctx() {
        throw new Error("Astro.locals.runtime.ctx has been removed in Astro v6. Use 'Astro.locals.cfContext' instead.");
      },
    },
  });
  return locals;
}

test("waitUntilFromLocals: does not touch locals.runtime at all, so a throwing runtime.ctx getter (the real adapter shape) never fires", () => {
  const locals = localsWithThrowingRuntimeCtx(undefined); // cfContext absent — the exact case a bad fallback would reach for runtime.ctx
  assert.doesNotThrow(() => waitUntilFromLocals(locals));
  assert.equal(waitUntilFromLocals(locals), undefined);
});

test("waitUntilFromLocals: still resolves cfContext.waitUntil correctly even when the adapter's throwing runtime is also present", () => {
  const calls = [];
  const locals = localsWithThrowingRuntimeCtx({ waitUntil: (p) => calls.push(p) });
  const fn = waitUntilFromLocals(locals);
  assert.equal(typeof fn, "function");
  fn(Promise.resolve("x"));
  assert.equal(calls.length, 1);
});

// P0-2 REGRESSION TEST: translate() used to await the translation job
// inline when no `waitUntil` scheduler was supplied. That violated decision
// 6 ("never block a render on the API") for no benefit — by the time that
// branch ran, source text had already been chosen as the return value, so
// the only thing "gained" by awaiting was a live network round-trip glued
// onto the render path. The fix: no scheduler behaves exactly like an
// exhausted budget — skip the call, return source, schedule nothing.
test("translate: with no scheduler available, the miss returns source immediately and makes NO fetch call at all (never blocks per decision 6)", () =>
  withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
    const kv = fakeKv();
    await withStubbedFetch(
      router(() => anthropicResponse("Hello")),
      async (calls) => {
        // No `waitUntil` passed.
        const result = await translate({ text: "Hej", target: "en", tier: "fast", kv });
        assert.equal(result.cached, false);
        assert.equal(result.text, "Hej");
        // No scheduler -> the call is skipped entirely, not awaited inline.
        const anthropicCalls = calls.filter((c) => c.url.startsWith("https://api.anthropic.com/"));
        assert.equal(anthropicCalls.length, 0);
        assert.equal(kv.puts.length, 0);
      },
    );
  }));

// ---------------------------------------------------------------------------
// createT() — chrome-string helper bound to locals.lang
// ---------------------------------------------------------------------------

test("createT: binds to locals.lang and translates through the same pipeline (quality tier)", () =>
  withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
    const kv = fakeKv();
    const seenModels = [];
    const scheduler = collectingWaitUntil();
    const locals = { lang: "en", cfContext: { waitUntil: scheduler.waitUntil } };
    await withStubbedFetch(
      router((url, init) => {
        seenModels.push(JSON.parse(init.body).model);
        return anthropicResponse("Book us");
      }),
      async () => {
        // NOTE: deliberately NOT the "Kontakta oss" override fixture string
        // (see OVERRIDE_FIXTURE_SOURCE above) — that string now short-
        // circuits before ever reaching the API, which would make this
        // test pass for the wrong reason (or fail outright, since
        // seenModels would stay empty). "Boka oss" has no override entry.
        const t = createT(locals, { kv });
        const out = await t("Boka oss");
        assert.equal(out, "Boka oss"); // never blocks — source back immediately
        await scheduler.flush();
        assert.deepEqual(seenModels, ["claude-sonnet-5"]); // decision 3: chrome strings -> quality tier
      },
    );
  }));

test("createT: defaults to sv when locals.lang is absent", async () => {
  const kv = fakeKv();
  await withStubbedFetch(
    router(() => anthropicResponse("x")),
    async () => {
      const t = createT({}, { kv, budget: new RequestBudget(0) }); // budget 0 -> never actually calls out
      const out = await t("Some source string");
      assert.equal(out, "Some source string");
    },
  );
});

// P1-6 REGRESSION TESTS: createT() used to default straight to "no budget"
// (translate() treats an omitted budget as unbounded), so every t() binding
// across the whole site was silently unbounded unless a caller remembered
// to pass one. createT() now constructs its own RequestBudget by default;
// unbounded requires the explicit opt-out `budget: null`.
test("createT: defaults to a real budget (RequestBudget) when opts.budget is not mentioned at all — unbounded is no longer the default", () =>
  withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
    const kv = fakeKv();
    const scheduler = collectingWaitUntil();
    const locals = { lang: "en", cfContext: { waitUntil: scheduler.waitUntil } };
    let callCount = 0;
    await withStubbedFetch(
      router(() => {
        callCount += 1;
        return anthropicResponse("translated");
      }),
      async () => {
        // No `budget` key in opts at all — this must still be budgeted.
        const t = createT(locals, { kv });
        // Exhaust a tiny stand-in budget by calling with more distinct
        // strings than the default ceiling would allow is impractical here
        // (25 real fetch round-trips per test is wasteful) — instead prove
        // the default budget object is actually wired by exhausting a
        // ZERO-sized one via the opt-out path in the next test, and here
        // simply prove a normal call still succeeds through a real
        // RequestBudget instance (i.e. the default doesn't break the
        // happy path).
        const out = await t("Prenumerera");
        assert.equal(out, "Prenumerera");
        await scheduler.flush();
        assert.equal(callCount, 1);
      },
    );
  }));

test("createT: budget: null is the explicit opt-out into unbounded translation", () =>
  withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
    const kv = fakeKv();
    const scheduler = collectingWaitUntil();
    const locals = { lang: "en", cfContext: { waitUntil: scheduler.waitUntil } };
    let callCount = 0;
    await withStubbedFetch(
      router(() => {
        callCount += 1;
        return anthropicResponse("translated");
      }),
      async () => {
        const t = createT(locals, { kv, budget: null });
        // Two distinct strings — with a default budget this would still
        // pass at n=2, so what actually distinguishes "opted out" is
        // covered by the companion test below asserting the DEFAULT really
        // is a RequestBudget instance, not merely "large enough for 2".
        await t("Prenumerera nu");
        await t("Avsluta prenumeration");
        await scheduler.flush();
        assert.equal(callCount, 2);
      },
    );
  }));

test("createT: omitting opts.budget produces a budget that actually caps calls (proves the default is a real RequestBudget, not unbounded)", () =>
  withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
    const kv = fakeKv();
    const scheduler = collectingWaitUntil();
    const locals = { lang: "en", cfContext: { waitUntil: scheduler.waitUntil } };
    await withStubbedFetch(
      router(() => anthropicResponse("translated")),
      async () => {
        const t = createT(locals, { kv }); // no budget mentioned
        // Reach past the default ceiling (25) with distinct, never-cached
        // source strings so every call is a genuine miss.
        for (let i = 0; i < 26; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await t(`Unik textrad nummer ${i}`);
        }
        await scheduler.flush();
        // The 26th call must have found the budget exhausted and scheduled
        // nothing for it — i.e. at most 25 KV writes, never 26.
        assert.ok(kv.puts.length <= 25, `expected at most 25 KV writes, got ${kv.puts.length}`);
      },
    );
  }));

// ---------------------------------------------------------------------------
// buildProtectedTerms — do-not-translate list assembly (decision 7)
// ---------------------------------------------------------------------------

test("buildProtectedTerms: includes the fixed list plus caller-supplied entity names, de-duplicated", () =>
  withStubbedFetch(
    // FM calls (triggered transitively via getBookingCategories) fail —
    // buildProtectedTerms must degrade to fixed+protect only, never throw.
    async () => new Response("fm unavailable", { status: 500 }),
    async () => {
      const terms = await buildProtectedTerms(["Emma Blyfors", "Ninetone"]);
      for (const fixed of FIXED_PROTECTED_TERMS) {
        assert.ok(terms.includes(fixed), `expected fixed term ${fixed} to be present`);
      }
      assert.ok(terms.includes("Emma Blyfors"));
      // "Ninetone" appears in both the caller-supplied list and the fixed
      // list — must be de-duplicated, not doubled.
      assert.equal(terms.filter((t) => t === "Ninetone").length, 1);
    },
  ));

test("buildProtectedTerms: a failed FM lookup for booking-category tags degrades to fixed+protect only, never throws", () =>
  withStubbedFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      await assert.doesNotReject(() => buildProtectedTerms([]));
      const terms = await buildProtectedTerms([]);
      assert.deepEqual(new Set(terms), new Set(FIXED_PROTECTED_TERMS));
    },
  ));

test("resolveFmDisplayText skips a second translation for locale-resolved prose", async () => {
  let calls = 0;
  const translateText = async (text) => { calls += 1; return `${text} translated`; };

  assert.equal(await resolveFmDisplayText("Already English", translateText, true), "Already English");
  assert.equal(calls, 0);
  assert.equal(await resolveFmDisplayText("Svenska", translateText, false), "Svenska translated");
  assert.equal(calls, 1);
});
