/** Server-only Office transport. The existing getters/cache/Publish semantics stay.
 * No automatic FileMaker fallback: a failed migration must not silently mix data.
 */
import { secretEnv } from './env.ts';
import type { FmFindBody } from './filemaker.ts';

declare const __OFFICE_STATIC_PREVIEW__: boolean;

const LAYOUTS = new Set(['API_ARTIST','API_ARTIST_DETAIL','API_Management','API_Booking','API_BOOKING_TAG','API_NEWS','API_WEBPOSTS','API_USERS']);
export function usesOffice(): boolean {
  const source = secretEnv('CONTENT_SOURCE') ?? 'filemaker';
  if (source !== 'office' && source !== 'filemaker') throw new Error('Unknown content source');
  return source === 'office';
}
function origin(): string {
  const raw = secretEnv('OFFICE_API_ORIGIN');
  if (!raw) throw new Error('OFFICE_API_ORIGIN is required');
  const url = new URL(raw);
  const local = secretEnv('OFFICE_ALLOW_LOCAL') === '1' && ['127.0.0.1','localhost'].includes(url.hostname) && url.protocol === 'http:';
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Exact Office HTTPS origin required');
  return url.origin;
}
export function officeScope(layout: string): string {
  // Separate KV entries across sources/environments WITHOUT altering fm-kv.ts.
  // A pre-existing FileMaker value can never masquerade as Office validation.
  return usesOffice() ? `office-v1:${origin()}:${layout}` : layout;
}
async function request(path: string, query?: string): Promise<Response> {
  const token = secretEnv('OFFICE_API_TOKEN');
  if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('OFFICE_API_TOKEN is required');
  const url = new URL(`/api/integrations/website/v1/${path}`, origin());
  if (query) url.searchParams.set('q', query);
  const response = await fetch(url, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: path.startsWith('images/') ? 'image/webp' : 'application/json' },
    redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  if (response.status >= 300 && response.status < 400) throw new Error('Office redirects are not permitted');
  return response;
}
export type OfficeFindResponse<T> = {
  response: { data: { fieldData: T; portalData?: Record<string, unknown[]>; recordId: string }[]; dataInfo: { foundCount: number; returnedCount: number } };
  messages: { code: string; message: string }[];
};
export async function officeFind<T>(layout: string, body: FmFindBody): Promise<OfficeFindResponse<T>> {
  if (!LAYOUTS.has(layout)) throw new Error('Unknown Office layout');
  const response = await request(`layouts/${layout}`, JSON.stringify(body));
  if (!response.ok) throw new Error(`Office ${layout} unavailable: HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Office returned non-JSON');
  const raw = await response.text();
  if (raw.length > 16 * 1024 * 1024) throw new Error('Office response exceeds limit');
  const json = JSON.parse(raw);
  const rows = json?.response?.data; const info = json?.response?.dataInfo;
  if (json.schema_version !== 1 || !Array.isArray(rows) || rows.length > (body.limit ?? 100) || !info || !Number.isSafeInteger(info.foundCount) || !Number.isSafeInteger(info.returnedCount) || info.returnedCount !== rows.length || info.foundCount < rows.length) throw new Error('Invalid Office response');
  if (info.foundCount > info.returnedCount && body.limit !== 1) throw new Error('Office result would truncate');
  for (const row of rows) {
    if (!row || typeof row.recordId !== 'string' || !row.fieldData || typeof row.fieldData !== 'object' || Array.isArray(row.fieldData)) throw new Error('Invalid Office record');
    if (row.portalData != null) {
      if (typeof row.portalData !== 'object' || Array.isArray(row.portalData)) throw new Error('Invalid Office portals');
      for (const [name, portal] of Object.entries(row.portalData)) if (!Array.isArray(portal) || portal.length > (body.portalLimits?.[name] ?? 500)) throw new Error('Office portal would truncate');
    }
  }
  // Legacy image addresses are forbidden once Office is selected.
  if (/files\.ninetone\.com\/Streaming_SSL|ninetone-fm-image-proxy\./i.test(raw)) throw new Error('Office returned a FileMaker image');
  // Static GitHub Pages has no image API. Its public pictures are served
  // by the production Worker; the server build keeps same-origin paths.
  const staticPreview = typeof __OFFICE_STATIC_PREVIEW__ === 'boolean'
    ? __OFFICE_STATIC_PREVIEW__ : secretEnv('PUBLIC_HAS_RUNTIME') === 'false';
  if (staticPreview) {
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && /(^|::)(artistPicture_(big|small)|userPhoto(Small)?|image_webp|coverPicture_webp)$/.test(key) && item.startsWith('/api/office-images/')) (value as Record<string, unknown>)[key] = `https://www.ninetone.com${item}`;
        else if (typeof item === 'object') walk(item);
      }
    };
    walk(rows);
  }
  return json;
}
export const OFFICE_IMAGE_POLICY = 'public, max-age=31536000, immutable';
export async function officeImage(path: string, ifNoneMatch: string | null, head = false): Promise<Response> {
  const match = /^(web|team|profile|presentation|release)\/([0-9a-f-]{36})\/([0-9a-f]{64})\/(cover|small|medium|large)\.webp$/.exec(path);
  if (!match || !usesOffice()) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  // This endpoint never accepts an upstream URL or forwards visitor credentials.
  // Only success is cacheable; origin 401/404/503 must never become a blank image.
  try {
    const upstream = await request(`images/${path}`);
    if (!upstream.ok || upstream.headers.get('content-type')?.split(';')[0] !== 'image/webp') return new Response(null, { status: upstream.status === 404 ? 404 : 503, headers: { 'Cache-Control': 'no-store' } });
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.length < 12 || bytes.length > 10 * 1024 * 1024 || String.fromCharCode(...bytes.slice(0,4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8,12)) !== 'WEBP') throw new Error('Invalid Office image');
    const etag = `"${match[3]}"`;
    const headers = { 'Content-Type': 'image/webp', 'Cache-Control': OFFICE_IMAGE_POLICY, ETag: etag, 'X-Content-Type-Options': 'nosniff' };
    // Validate current visibility at Office before issuing 304 on a cache miss.
    if (ifNoneMatch?.split(',').some(v => [etag, `W/${etag}`, '*'].includes(v.trim()))) return new Response(null, { status: 304, headers });
    return new Response(head ? null : bytes, { status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) } });
  } catch { return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
