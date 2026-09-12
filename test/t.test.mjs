/**
 * src/lib/t.ts — the call-site façade over translate(). Pins the two
 * properties its doc comment says it exists for (one budget per render;
 * memoization by exact source string) plus the budget's refusal count the
 * middleware reads to keep a degraded render out of the long-TTL edge cache.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { sharedT, fmText } from "../src/lib/t.ts";

function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  return Promise.resolve().then(fn).finally(() => { console.error = original; });
}

function requestLocals() {
  const waits = [];
  return { lang: "en", cfContext: { waitUntil: (p) => waits.push(p) }, waits };
}

test("ONE budget per render: Header-, Footer- and page-level bindings share the 25-call ceiling", () =>
  quietly(async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // scheduled jobs become no-ops, never network
    try {
      const locals = requestLocals();
      const page = sharedT(locals);
      const header = sharedT(locals);
      const fm = fmText(locals);
      const strings = Array.from({ length: 30 }, (_, i) => `Text ${i}`);
      await Promise.all([
        ...strings.slice(0, 10).map((s) => page(s)),
        ...strings.slice(10, 20).map((s) => header(s)),
        ...strings.slice(20).map((s) => fm(s)),
      ]);
      assert.ok(locals.__i18nBudget, "the budget is stashed on locals");
      assert.equal(locals.__i18nBudget.remaining, 0);
      assert.equal(locals.__i18nBudget.refusedCount, 5, "30 uncached strings against a 25 ceiling refuse exactly 5");
      assert.equal(locals.__i18nBudget.consumedCount, 25);
      assert.equal(locals.__i18nBudget.missCount, 30, "every one of the 30 rendered as source text");
      assert.equal(locals.waits.length, 25, "exactly 25 jobs scheduled for the whole render");
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  }));

test("memoization: the same source string is one job per render, shared across bindings", () =>
  quietly(async () => {
    const locals = requestLocals();
    const a = sharedT(locals);
    const b = sharedT(locals);
    const p1 = a("Book");
    const p2 = a("Book");
    const p3 = b("Book");
    assert.equal(p1, p2, "same binding, same promise");
    assert.equal(p1, p3, "different binding, same locals → same promise");
    await Promise.all([p1, p2, p3]);
    assert.equal(locals.waits.length, 1, "one scheduled job for one distinct string");
    assert.equal(locals.__i18nBudget.remaining, 24, "one budget slot, not three");
  }));

test("fmText memoizes per (kind, trimmed text) and returns empty for blank input", () =>
  quietly(async () => {
    const locals = requestLocals();
    const fm = fmText(locals);
    assert.equal(await fm("   "), "");
    assert.equal(await fm(null), "");
    // fmText is an async function, so each call returns a fresh wrapper
    // promise — memoization is observed through the budget and the scheduler,
    // not through promise identity.
    await Promise.all([fm("  Bio  "), fm("Bio"), fm("\nBio\n")]);
    assert.equal(locals.waits.length, 1, "trimmed text shares one memo entry → one job");
    assert.equal(locals.__i18nBudget.remaining, 24);
    await fm("Bio", "title");
    assert.equal(locals.waits.length, 2, "a different kind is a different job");
  }));

test("a refused string renders its source text, never blank", () =>
  quietly(async () => {
    const locals = requestLocals();
    const t = sharedT(locals);
    for (let i = 0; i < 25; i++) await t(`Fyllnad ${i}`);
    assert.equal(await t("Sök"), "Sök");
    assert.equal(locals.__i18nBudget.refusedCount, 1);
  }));
