/**
 * Shopify Admin API client (build-time only).
 *
 * SECURITY: Admin API token has full read/write access to the entire store.
 * This file MUST NEVER be imported by client-side code. Astro's import graph
 * keeps it server-side because it reads from `import.meta.env.SHOPIFY_*`
 * which are only resolved during SSR/build.
 *
 * For long-term safety, swap to Storefront API before launch (see
 * docs/api-shopify.md).
 */

// `.ts` extensions on purpose: plain Node (the test runner, with
// --experimental-strip-types) cannot resolve extension-less imports, and
// test/shopify-kv.test.mjs imports this module directly.
import { cached, type KvLike, kvCached, readCacheVersion } from "./cache.ts";
import { getCfEnv } from "./cf.ts";

// Lazy env reads with a process.env fallback — on the Cloudflare Worker
// runtime, secrets arrive as bindings (exposed on process.env via
// nodejs_compat) instead of being baked at build. See src/lib/filemaker.ts.
// `import.meta.env?.` so the module also loads under plain Node (tests),
// where `import.meta.env` is undefined — see src/lib/fm-image-mirror.ts.
type ProcHolder = { process?: { env?: Record<string, string | undefined> } };
const procEnv = (name: string) => (globalThis as ProcHolder).process?.env?.[name];

const shopDomain = () =>
  import.meta.env?.SHOPIFY_SHOP_DOMAIN || procEnv("SHOPIFY_SHOP_DOMAIN") || "fc6d3a-d9.myshopify.com";
const publicStoreUrl = () =>
  import.meta.env?.SHOPIFY_PUBLIC_STORE_URL || procEnv("SHOPIFY_PUBLIC_STORE_URL") || "https://shop.ninetone.com";
// A secret: process.env only, never import.meta.env (src/lib/env.ts).
const adminToken = () => procEnv("SHOPIFY_ADMIN_TOKEN");
const API_VERSION = "2024-10";

/**
 * Cross-isolate TTL for the product list in `CACHE_STATE` KV.
 *
 * WHY. The in-memory `cached()` layer is per isolate and lives 60 s, so on a
 * recycled isolate the homepage paid a live Shopify round trip on every
 * page-cache miss — the last cold-isolate network call left on that route
 * once FM reads went through KV (perf handoff 2026-09-13 §5). Merch changes
 * rarely; an hour is generous for the shop and still shorter than the
 * roster tiers. The key embeds the Publish epoch, so a Publish forces a
 * fresh read exactly as it does for FM (src/lib/fm-kv.ts).
 */
export const SHOPIFY_KV_TTL_SECONDS = 3600;

export interface ShopifyVariant {
  id: number;
  title: string;
  price: string;
}

export interface ShopifyImage {
  id: number;
  src: string;
  alt: string | null;
  width: number;
  height: number;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  product_type: string;
  status: string;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
  image: ShopifyImage | null;
}

interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}

async function shopifyFetch(path: string, fetchImpl: typeof fetch): Promise<Response> {
  const token = adminToken();
  if (!token) {
    throw new Error("SHOPIFY_ADMIN_TOKEN env var not set");
  }
  return fetchImpl(`https://${shopDomain()}/admin/api/${API_VERSION}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
  });
}

async function fetchProducts(
  collectionId: string,
  limit: number,
  fetchImpl: typeof fetch,
): Promise<ShopifyProduct[]> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("status", "active");
  if (collectionId) params.set("collection_id", collectionId);

  const res = await shopifyFetch(`/products.json?${params}`, fetchImpl);
  if (!res.ok) {
    throw new Error(`Shopify products failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as ShopifyProductsResponse;
  return json.products;
}

export type GetProductsOptions = {
  collectionId?: string;
  limit?: number;
  /** Bypass both caches and rewrite the KV entry — the warm-up cron
   *  (src/lib/fm-warm.ts). Never set on a visitor render. */
  refresh?: boolean;
};

/**
 * The KV-backed core of `getProducts`, with the binding and `fetch` injected
 * so it can be driven under plain Node (test/shopify-kv.test.mjs) and so the
 * warm-up cron can pass the `scheduled` handler's own binding.
 *
 * Layers, outermost first: in-memory `cached()` (60 s in-flight dedup and
 * per-isolate reuse, as before) → KV read-through keyed by the Publish
 * epoch → Shopify. No KV means a plain in-memory cache, exactly as before.
 */
export function getProductsWithKv(
  kv: KvLike | null | undefined,
  opts?: GetProductsOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ShopifyProduct[]> {
  const collectionId = opts?.collectionId ?? "";
  const limit = opts?.limit ?? 50;
  const cacheOpts = { refresh: opts?.refresh === true };
  return cached(
    "shopify-products",
    { collectionId, limit },
    async () => {
      const load = () => fetchProducts(collectionId, limit, fetchImpl);
      if (!kv) return load();
      // Epoch read per in-memory miss, never memoized — see readCacheVersion.
      const key = `shopify:v1:${await readCacheVersion(kv)}:products:${collectionId}:${limit}`;
      return kvCached<ShopifyProduct[]>(kv, key, SHOPIFY_KV_TTL_SECONDS, load, cacheOpts);
    },
    undefined,
    cacheOpts,
  );
}

/** List products from the store. Optionally scoped to a Shopify collection. */
export async function getProducts(opts?: GetProductsOptions): Promise<ShopifyProduct[]> {
  const env = await getCfEnv();
  return getProductsWithKv(env?.CACHE_STATE ?? null, opts);
}

/** Storefront URL for a product (so users can buy on shop.ninetone.com). */
export function productUrl(product: ShopifyProduct): string {
  return `${publicStoreUrl()}/products/${product.handle}`;
}

/** Lowest variant price as a formatted SEK string. */
export function productPrice(product: ShopifyProduct): string {
  const prices = product.variants.map((v) => parseFloat(v.price)).filter((n) => !isNaN(n));
  if (prices.length === 0) return "";
  const min = Math.min(...prices);
  return `${min.toFixed(0)} kr`;
}
