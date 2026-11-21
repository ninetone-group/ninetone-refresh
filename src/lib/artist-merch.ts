import { getProducts, type GetProductsOptions, type ShopifyProduct } from './shopify.ts';

type ArtistCollections = { collectionIds?: unknown; collectionId?: unknown };
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
  const ids = artistCollectionIds(artist);
  const collections: ShopifyProduct[][] = [];
  // Bound concurrent Shopify reads even for a long Office selection.
  for (let offset = 0; offset < ids.length; offset += 4) {
    collections.push(...await Promise.all(ids.slice(offset, offset + 4).map(
      collectionId => load({ collectionId, limit }),
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
