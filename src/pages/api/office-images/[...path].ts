import type { APIRoute } from 'astro';
import { officeImage, usesOffice } from '../../../lib/office.ts';

/** Same-origin public image CDN; Office and its token are never exposed.
 * The immutable URL contains original hash + rendition policy + size. New
 * originals have new URLs; a Publish never forces every cached image to reload.
 */
// No static preview images are emitted; the Cloudflare target serves on demand.
export function getStaticPaths() { return []; }
const serve: APIRoute = async ({ request, params, locals }) => {
  if (!usesOffice()) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (new URL(request.url).search) return new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  const cache = typeof caches !== 'undefined' ? (caches as CacheStorage & { default?: Cache }).default : undefined;
  const key = new Request(request.url, { method: 'GET' });
  const etag = `"${params.path?.split('/')[2] ?? ''}"`;
  let cached: Response | undefined;
  try { cached = await cache?.match(key); } catch { /* A cache outage is an origin miss. */ }
  if (cached) {
    const headers = new Headers(cached.headers);
    if (request.headers.get('if-none-match')?.split(',').some(v => [etag, `W/${etag}`, '*'].includes(v.trim()))) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : cached.body, { headers });
  }
  const response = await officeImage(params.path ?? '', request.headers.get('if-none-match'), request.method === 'HEAD');
  if (cache && response.status === 200 && request.method === 'GET') {
    const work = cache.put(key, response.clone()).catch(() => {});
    // Astro exposes executionContext through locals on Cloudflare. Don't lose
    // a cache write when the visitor request completes.
    const context = (locals as unknown as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
    if (context) context.waitUntil(work); else await work;
  }
  return response;
};
export const GET = serve;
export const HEAD = serve;
