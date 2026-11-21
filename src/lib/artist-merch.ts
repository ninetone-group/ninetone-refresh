import { artistStoreDomain, artistShopCollections, artistShopProducts, type ShopCollection } from './artist-shop.ts';
import { getProducts, type GetProductsOptions, type ShopifyProduct } from './shopify.ts';

export type ArtistCollections = { SLUG?: unknown; collectionIds?: unknown; collectionId?: unknown; shopifyCollections?: unknown; shopifyStoreDomain?: unknown };
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value.trim());

/** Office's explicit list, including [], supersedes the legacy single ID. */
export function artistCollectionIds(artist: ArtistCollections): string[] {
  if (Object.hasOwn(artist, 'collectionIds')) {
    const ids = artist.collectionIds;
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every(validId)) return [];
    return [...new Set(ids.map(id => id.trim()))];
  }
  return validId(artist.collectionId) ? [artist.collectionId.trim()] : [];
}

/** Use the existing epoch-aware Shopify cache for every selected collection. */
export async function getArtistMerch(
  artist: ArtistCollections,
  limit = 8,
  load: (opts: GetProductsOptions) => Promise<ShopifyProduct[]> = getProducts,
): Promise<ShopifyProduct[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Invalid merch limit');
  const domain = artistStoreDomain(artist.shopifyStoreDomain);
  if (domain === null) return [];
  const ids = artistCollectionIds(artist);
  if (!ids.length) return [];
  const external = domain && domain !== 'shop.ninetone.com';
  const available = external ? await getArtistCollections(artist) : [];
  const read = external ? async ({collectionId,limit}: GetProductsOptions) => {
    const collection = available.find(c => c.id === collectionId);
    return collection ? artistShopProducts(domain,collection,limit!) : [];
  } : load;
  const collections: ShopifyProduct[][] = [];
  // Bound concurrent Shopify reads even for a long Office selection.
  for (let offset = 0; offset < ids.length; offset += 4) {
    collections.push(...await Promise.all(ids.slice(offset, offset + 4).map(
      collectionId => read({ collectionId, limit }),
    )));
  }
  const seen = new Set<number>();
  const products: ShopifyProduct[] = [];
  // Give each collection space before filling the rest of the existing grid.
  for (let row = 0; row < limit && products.length < limit; row++) {
    for (const collection of collections) {
      const product = collection[row];
      if (!product || seen.has(product.id)) continue;
      seen.add(product.id);
      products.push(product);
      if (products.length === limit) break;
    }
  }
  return products;
}

/** Show every selected, publicly resolvable collection, independently of product API availability. */
export async function getArtistCollections(artist: ArtistCollections): Promise<ShopCollection[]> {
  const domain = artistStoreDomain(artist.shopifyStoreDomain);
  const ids = artistCollectionIds(artist);
  if (domain === null || !ids.length) return [];
  if (Object.hasOwn(artist,'shopifyCollections')) {
    if (!Array.isArray(artist.shopifyCollections)) return [];
    const host=domain||'shop.ninetone.com';
    return artist.shopifyCollections.filter((c: any): c is ShopCollection =>
      c && ids.includes(c.id) && typeof c.title==='string' && /^[a-z0-9][a-z0-9-]{0,254}$/.test(c.handle)
      && c.url===`https://${host}/collections/${c.handle}`
      && (c.image===undefined || typeof c.image==='string' && /^https:\/\/cdn\.shopify\.com\//.test(c.image)));
  }
  const collections = await artistShopCollections(domain || 'shop.ninetone.com');
  return ids.flatMap(id => collections.filter(c => c.id === id));
}
