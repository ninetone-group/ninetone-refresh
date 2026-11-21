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
  if (!artistStoreDomain(host) || !/^[1-9][0-9]{0,19}$/.test(collection.id) || !/^[a-z0-9][a-z0-9-]{0,254}$/.test(collection.handle) || !Number.isSafeInteger(limit) || limit<1 || limit>50) return [];
  return cached('artist-shop-products', {host,id:collection.id,limit}, async () => {
    const load = async () => {
      const query='query ArtistMerch($id: ID!, $limit: Int!){collection(id:$id){products(first:$limit){nodes{id title handle featuredImage{url altText width height} priceRange{minVariantPrice{amount currencyCode}}}}}}';
      const res=await fetchImpl(`https://${host}/api/2026-10/graphql.json`,{
        method:'POST',redirect:'manual',signal:AbortSignal.timeout(6000),
        headers:{'Content-Type':'application/json',Accept:'application/json'},
        body:JSON.stringify({query,variables:{id:`gid://shopify/Collection/${collection.id}`,limit}}),
      });
      if(!res.ok)throw new Error(`Artist Shopify storefront: HTTP ${res.status}`);
      const body=await res.text();if(body.length>2_000_000)throw new Error('Artist storefront response too large');
      const data=JSON.parse(body);if(data.errors?.length)throw new Error('Shopify Storefront query failed');
      const nodes=data.data?.collection?.products?.nodes??[];
      if(!Array.isArray(nodes)||nodes.length>limit)throw new Error('Invalid Storefront products response');
      return nodes.flatMap((p:any)=>{
        const id=Number(/^gid:\/\/shopify\/Product\/([0-9]+)$/.exec(p.id)?.[1]);
        const price=p.priceRange?.minVariantPrice;
        if(!Number.isSafeInteger(id)||id<1||typeof p.title!=='string'||!(/^[a-z0-9][a-z0-9-]*$/).test(p.handle)||!price||!(/^[A-Z]{3}$/).test(price.currencyCode)||!Number.isFinite(Number(price.amount)))return [];
        const f=p.featuredImage;
        const image=f&&typeof f.url==='string'&&f.url.startsWith('https://cdn.shopify.com/')?{id,src:f.url,alt:f.altText??null,width:f.width??600,height:f.height??600}:null;
        return [{id,title:p.title,handle:p.handle,body_html:'',product_type:'',status:'active',variants:[{id,title:'',price:price.amount}],images:image?[image]:[],image,storefrontDomain:host,currency:price.currencyCode}];
      });
    };
    return kv ? kvCached(kv, `artist-shop:v2:${await readCacheVersion(kv)}:${host}:products:${collection.id}:${limit}`, 3600, load) : load();
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
