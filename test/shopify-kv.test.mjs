/**
 * src/lib/shopify.ts — the KV read-through for the product list, driven
 * through the injectable core `getProductsWithKv(kv, opts, fetchImpl)`.
 * getCfEnv() resolves null under Node, so `getProducts()` itself would only
 * ever exercise the no-KV path here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SHOPIFY_KV_TTL_SECONDS, getProductsWithKv } from "../src/lib/shopify.ts";

// Read lazily by the module (process.env under nodejs_compat) — set before
// the first call, not before the import.
process.env.SHOPIFY_ADMIN_TOKEN = "test-token";

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  const gets = [];
  return {
    store,
    puts,
    gets,
    get: async (key, opts) => {
      gets.push([key, opts]);
      return store.has(key) ? store.get(key) : null;
    },
    put: async (key, value, opts) => {
      puts.push([key, value, opts]);
      store.set(key, value);
    },
  };
}

const PRODUCTS = [{ id: 1, title: "Tee", handle: "tee", variants: [{ id: 1, title: "M", price: "249" }], images: [], image: null }];

function fakeFetch(products = PRODUCTS) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    return new Response(JSON.stringify({ products }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, impl };
}

test("miss → one Shopify fetch, stored under shopify:v1:<epoch>:products:<id>:<limit> for an hour", async () => {
  const kv = fakeKv({ "cache-version": "7" });
  const { calls, impl } = fakeFetch();
  const products = await getProductsWithKv(kv, { collectionId: "c1", limit: 12 }, impl);
  assert.deepEqual(products, PRODUCTS);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/admin\/api\/[\d-]+\/products\.json\?limit=12&status=active&collection_id=c1$/);
  assert.equal(calls[0].headers["X-Shopify-Access-Token"], "test-token");
  assert.equal(kv.puts.length, 1);
  const [key, value, opts] = kv.puts[0];
  assert.equal(key, "shopify:v1:7:products:c1:12");
  assert.deepEqual(JSON.parse(value), PRODUCTS);
  assert.equal(opts.expirationTtl, SHOPIFY_KV_TTL_SECONDS);
  assert.equal(SHOPIFY_KV_TTL_SECONDS, 3600);
  assert.ok(kv.gets.some(([k, o]) => k === "cache-version" && o?.cacheTtl === 60), "epoch read like the FM layer");
});

test("hit → no fetch at all (another isolate's read is reused)", async () => {
  const kv = fakeKv({ "cache-version": "7", "shopify:v1:7:products:c2:12": JSON.stringify(PRODUCTS) });
  const { calls, impl } = fakeFetch([]);
  const products = await getProductsWithKv(kv, { collectionId: "c2", limit: 12 }, impl);
  assert.deepEqual(products, PRODUCTS);
  assert.equal(calls.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("refresh → fetch + put even on a hit, and the in-memory layer is bypassed too", async () => {
  const fresh = [{ ...PRODUCTS[0], title: "Tee v2" }];
  const kv = fakeKv({ "cache-version": "7", "shopify:v1:7:products:c3:12": JSON.stringify(PRODUCTS) });
  const { calls, impl } = fakeFetch(fresh);
  const products = await getProductsWithKv(kv, { collectionId: "c3", limit: 12, refresh: true }, impl);
  assert.deepEqual(products, fresh);
  assert.equal(calls.length, 1);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0][0], "shopify:v1:7:products:c3:12");
  assert.ok(!kv.gets.some(([k]) => k.startsWith("shopify:")), "refresh never reads the entry");

  // Now in memory: a second refresh still goes to Shopify.
  await getProductsWithKv(kv, { collectionId: "c3", limit: 12, refresh: true }, impl);
  assert.equal(calls.length, 2);
  // …while a normal call is served from the in-memory layer (60 s dedup).
  await getProductsWithKv(kv, { collectionId: "c3", limit: 12 }, impl);
  assert.equal(calls.length, 2);
});

test("the Publish epoch is in the key, so a Publish forces a fresh read", async () => {
  const kv = fakeKv({ "cache-version": "8", "shopify:v1:7:products:c4:12": JSON.stringify(PRODUCTS) });
  const { calls, impl } = fakeFetch();
  await getProductsWithKv(kv, { collectionId: "c4", limit: 12 }, impl);
  assert.equal(calls.length, 1, "the epoch-7 entry is not consulted under epoch 8");
  assert.equal(kv.puts[0][0], "shopify:v1:8:products:c4:12");
});

test("no KV → plain in-memory as before: fetch once, no KV traffic, dedup on the second call", async () => {
  const { calls, impl } = fakeFetch();
  assert.deepEqual(await getProductsWithKv(null, { collectionId: "c5" }, impl), PRODUCTS);
  assert.deepEqual(await getProductsWithKv(null, { collectionId: "c5" }, impl), PRODUCTS);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /limit=50&status=active&collection_id=c5$/, "default limit stays 50");
});

test("a non-2xx Shopify answer throws and nothing is written", async () => {
  const kv = fakeKv({ "cache-version": "7" });
  const impl = async () => new Response("nope", { status: 500 });
  await assert.rejects(() => getProductsWithKv(kv, { collectionId: "c6", limit: 12 }, impl), /HTTP 500/);
  assert.equal(kv.puts.length, 0);
});
