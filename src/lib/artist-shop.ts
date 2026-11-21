/** Public, credential-free reads for an artist's own Shopify storefront. */
import { cached, kvCached, readCacheVersion, type KvLike } from './cache.ts';
import { getCfEnv } from './cf.ts';
import type { ShopifyProduct } from './shopify.ts';

export type ShopCollection = { id: string; title: string; handle: string; url: string; image?: string };
export function artistStoreDomain(value: unknown): string | null {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  return host === 'shop.ninetone.com' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(host) ? host : null;
}

async function publicJson(host: string, path: string, fetchImpl: typeof fetch): Promise<any> {
  // Host is validated independently of Office. Never send the Ninetone Admin token.
  if (!artistStoreDomain(host)) throw new Error('Invalid artist storefront');
  const res = await fetchImpl(`https://${host}${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(6000),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Artist Shopify storefront: HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > 2_000_000) throw new Error('Artist storefront response too large');
  return JSON.parse(body);
}

export async function shopCollectionsWithKv(host: string, kv: KvLike | null | undefined, fetchImpl: typeof fetch = fetch): Promise<ShopCollection[]> {
  if (!artistStoreDomain(host)) return [];
  return cached('artist-shop-collections', {host}, async () => {
    const load = async () => {
      const items: ShopCollection[] = [];
      for (let page = 1; page <= 8; page++) {
        const data = await publicJson(host, `/collections.json?limit=250&page=${page}`, fetchImpl);
        if (!Array.isArray(data.collections) || data.collections.length > 250) throw new Error('Invalid collections response');
        for (const c of data.collections) {
          if (!/^[1-9][0-9]{0,19}$/.test(String(c.id)) || !/^[a-z0-9][a-z0-9-]{0,254}$/.test(c.handle) || typeof c.title !== 'string') continue;
          const image = typeof c.image?.src === 'string' && /^https:\/\/cdn\.shopify\.com\//.test(c.image.src) ? c.image.src : undefined;
          items.push({ id: String(c.id), title: c.title, handle: c.handle, url: `https://${host}/collections/${c.handle}`, image });
        }
        if (data.collections.length < 250) return items;
      }
      throw new Error('Too many artist shop collections');
    };
    return kv ? kvCached(kv, `artist-shop:v1:${await readCacheVersion(kv)}:${host}:collections`, 3600, load) : load();
  });
}

export async function shopProductsWithKv(host: string, collection: ShopCollection, limit: number, kv: KvLike | null | undefined, fetchImpl: typeof fetch = fetch): Promise<ShopifyProduct[]> {
  if (!artistStoreDomain(host) || !/^[a-z0-9][a-z0-9-]{0,254}$/.test(collection.handle)) return [];
  return cached('artist-shop-products', {host,id:collection.id,limit}, async () => {
    const load = async () => {
      const data = await publicJson(host, `/collections/${collection.handle}/products.json?limit=${limit}`, fetchImpl);
      if (!Array.isArray(data.products) || data.products.length > limit) throw new Error('Invalid products response');
      // Storefront product JSON uses decimal major units. Currency is explicit,
      // never assumed to be SEK for another artist's shop.
      let currency: string | undefined;
      try { const cart = await publicJson(host, '/cart.js', fetchImpl); if (/^[A-Z]{3}$/.test(cart.currency)) currency = cart.currency; } catch { /* omit uncertain prices */ }
      return data.products.filter((p: any) => Number.isSafeInteger(p.id) && /^[a-z0-9][a-z0-9-]*$/.test(p.handle) && typeof p.title === 'string' && p.published_at && Array.isArray(p.variants) && Array.isArray(p.images)).map((p: any) => ({...p, image:p.image ?? p.images[0] ?? null, status:'active', storefrontDomain:host, currency}));
    };
    return kv ? kvCached(kv, `artist-shop:v1:${await readCacheVersion(kv)}:${host}:products:${collection.id}:${limit}`, 3600, load) : load();
  });
}

export async function artistShopCollections(host: string): Promise<ShopCollection[]> {
  const env = await getCfEnv();
  return shopCollectionsWithKv(host, env?.CACHE_STATE);
}
export async function artistShopProducts(host: string, collection: ShopCollection, limit: number): Promise<ShopifyProduct[]> {
  const env = await getCfEnv();
  return shopProductsWithKv(host, collection, limit, env?.CACHE_STATE);
}
