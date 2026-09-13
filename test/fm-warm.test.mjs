/**
 * src/lib/fm-warm.ts — the warm-up pass itself, with the loaders injected.
 * The dispatch from `scheduled` is covered against the built bundle in
 * test/fm-warm-entry.test.mjs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FM_WARM_CRON, HOMEPAGE_MERCH_LIMIT, warmDisabled, warmReadThrough } from "../src/lib/fm-warm.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("FM_WARM_CRON is the five-minute expression wrangler.jsonc registers", () => {
  assert.equal(FM_WARM_CRON, "*/5 * * * *");
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(config.includes(`"${FM_WARM_CRON}"`), "the trigger must be registered, or `scheduled` never sees this cron");
});

test("warmDisabled: exactly 'off' disables, anything else leaves it running", () => {
  assert.equal(warmDisabled({ FM_WARM: "off" }), true);
  assert.equal(warmDisabled({}), false);
  assert.equal(warmDisabled({ FM_WARM: "OFF" }), false);
  assert.equal(warmDisabled({ FM_WARM: "on" }), false);
  assert.equal(warmDisabled({ FM_WARM: false }), false);
});

test("loaders run SEQUENTIALLY — the second does not start until the first has settled", async () => {
  const first = deferred();
  const order = [];
  const run = warmReadThrough({
    loaders: [
      { name: "a", run: async () => { order.push("a:start"); await first.promise; order.push("a:end"); } },
      { name: "b", run: async () => { order.push("b:start"); order.push("b:end"); } },
    ],
  });
  // Let the microtask queue drain: if "b" were started concurrently it would
  // have pushed by now.
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, ["a:start"], "one FM find in flight at a time");
  first.resolve();
  const result = await run;
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  assert.deepEqual(result.ok, ["a", "b"]);
  assert.deepEqual(result.failed, []);
});

test("a throwing loader is reported in `failed` and the rest still run", async () => {
  const lines = [];
  const result = await warmReadThrough({
    loaders: [
      { name: "a", run: async () => {} },
      { name: "b", run: async () => { throw new Error("FM 503"); } },
      { name: "c", run: async () => { throw "not-an-error"; } },
      { name: "d", run: async () => {} },
    ],
    log: (msg) => lines.push(msg),
    now: (() => { let t = 1000; return () => (t += 50); })(),
  });
  assert.deepEqual(result.ok, ["a", "d"]);
  assert.deepEqual(result.failed, [{ name: "b", error: "FM 503" }, { name: "c", error: "not-an-error" }]);
  assert.equal(result.ms, 50);
  assert.equal(lines.length, 1, "one summary line");
  assert.match(lines[0], /^\[fm-warm\] warmed 2\/4 in 50 ms — failed: b \(FM 503\), c \(not-an-error\)$/);
});

test("an all-green pass logs without a failure suffix", async () => {
  const lines = [];
  await warmReadThrough({ loaders: [{ name: "a", run: async () => {} }], log: (m) => lines.push(m) });
  assert.match(lines[0], /^\[fm-warm\] warmed 1\/1 in \d+ ms$/);
});

test("HOMEPAGE_MERCH_LIMIT matches the limit index.astro passes to MerchSection (the KV key embeds it)", () => {
  const page = readFileSync(new URL("../src/pages/index.astro", import.meta.url), "utf8");
  const m = page.match(/<MerchSection\b[^>]*?\blimit=\{(\d+)\}/s);
  assert.ok(m, "index.astro must pass an explicit limit to <MerchSection>");
  assert.equal(Number(m[1]), HOMEPAGE_MERCH_LIMIT, "the warm cron must fetch the same limit or it warms a key the homepage never reads");
});
