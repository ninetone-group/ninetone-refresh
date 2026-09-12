import assert from "node:assert/strict";
import test from "node:test";
import { timeServer, withServerTiming } from "../src/lib/server-timing.ts";
import { translate, translationKey } from "../src/lib/translate.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Server-Timing reports dependency wall time separately from overlapping sum", async () => {
  const response = await withServerTiming(async () => {
    await Promise.all([
      timeServer("fmread", () => delay(20)),
      timeServer("fmread", () => delay(20)),
    ]);
    return new Response("ok");
  });

  const value = response.headers.get("server-timing");
  assert.match(value, /^fmread;dur=[\d.]+;desc="n=2 sum=[\d.]+ms"$/);
  const [, wall, sum] = value.match(/dur=([\d.]+).*sum=([\d.]+)ms/) ?? [];
  assert.ok(Number(sum) > Number(wall), `${value} must not present the overlapping sum as elapsed time`);
});

test("concurrent requests keep independent timing stores and replace stale cached headers", async () => {
  const [one, two] = await Promise.all([
    withServerTiming(async () => {
      await timeServer("cache", () => delay(15));
      return new Response("one", { headers: { "Server-Timing": "stale;dur=999" } });
    }),
    withServerTiming(async () => {
      await Promise.all([
        timeServer("trnkv", () => delay(5)),
        timeServer("trnkv", () => delay(5)),
      ]);
      return new Response("two");
    }),
  ]);

  assert.match(one.headers.get("server-timing"), /^cache;/);
  assert.doesNotMatch(one.headers.get("server-timing"), /stale|trnkv/);
  assert.match(two.headers.get("server-timing"), /^trnkv;.*n=2/);
  assert.doesNotMatch(two.headers.get("server-timing"), /cache/);
});

test("translation timing separates logical reads from physical KV reads", async () => {
  const key = await translationKey("Hej", "en", "fast");
  const kv = { get: async (candidate) => candidate === key ? "Hello" : null, put: async () => {} };
  const response = await withServerTiming(async () => {
    await translate({ text: "Hej", target: "en", tier: "fast", kv });
    await translate({ text: "Hej", target: "en", tier: "fast", kv });
    return new Response("ok");
  });

  const value = response.headers.get("server-timing");
  assert.match(value, /trnkv;[^,]*n=1/);
  assert.match(value, /trnread;[^,]*n=2/);
});
