/**
 * Ninetone FM image proxy.
 *
 * GH Pages serves static HTML; this Worker serves the images. It holds a
 * cached FM session token, refreshes when stale, fetches a fresh streaming
 * URL on demand for a given (layout, slug, field) tuple, then streams the
 * bytes through to the browser. No FM URLs ever appear in the static HTML.
 *
 * Routes:
 *   GET /artist/:slug/big      → API_ARTIST_DETAIL.artistPicture_big
 *   GET /artist/:slug/small    → API_ARTIST_DETAIL.artistPicture_small
 *   GET /client/:slug/big      → API_CLIENT_DETAIL.artistPicture_big
 *   GET /booking/:slug/big     → API_BOOKING_DETAIL.artistPicture_big
 *   GET /news/:slug/cover      → API_WEBPOSTS.image_webp
 *   GET /healthz               → quick FM session check
 *
 * CORS: open to the GH Pages origin + production domain.
 *
 * Caching: image routes sit behind the Cache API (`caches.default`). The key
 * is the request origin + pathname + ONLY the `v` query param (the site embeds
 * `?v=<publish-epoch>` on every proxy URL, so a Publish is the cache buster) —
 * any other query string is dropped so a stray `?foo=bar` cannot mint a fresh
 * key and force an FM read. Edge TTL is 6 h (`s-maxage=21600`), bounded so a
 * photo replaced in FM without a Publish still shows within hours; browsers
 * keep bytes for 24 h because the HTML's `?v=` changes when content does.
 * Only 200s are stored; errors and /healthz never are. CORS is applied per
 * request on hits, so the allowed origin is never frozen into the cached copy.
 */

interface Env {
  FM_HOST: string;
  FM_DB: string;
  FM_USER: string;
  FM_PASS: string;
  /** Overridable for tests; production uses the UPSTREAM_TIMEOUT_MS default. */
  UPSTREAM_TIMEOUT_MS?: string;
}

const ALLOWED_ORIGINS = new Set([
  "https://mixxmastermike123.github.io",
  "https://www.ninetone.com",
  "https://ninetone.com",
]);

// Token cache lives in module scope for the lifetime of an isolate. Workers
// keep isolates warm for many requests, so most calls hit the cache. When the
// isolate is torn down or the token expires, next request grabs a fresh one.
let cachedToken: { value: string; expires: number } | null = null;
const TOKEN_TTL_MS = 12 * 60 * 1000; // refresh at 12 min, FM expires at 15
const MAX_SLUG_LENGTH = 160;
const MAX_ALBUM_LENGTH = 240;
// Upstream FM streaming host is outside our control — a slow or hung
// response would otherwise pin a Worker invocation indefinitely.
const UPSTREAM_TIMEOUT_MS = 15_000;
// Raster images only; this is well above any legitimate artist/cover photo.
// Caps memory/bandwidth if an upstream response is unexpectedly huge.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Edge TTL is deliberately short of "forever": an image replaced in FM without
// a Publish (no `?v=` bump) should still surface within a working day.
const EDGE_TTL_S = 6 * 60 * 60;
const BROWSER_TTL_S = 24 * 60 * 60;

function upstreamTimeoutMs(env: Env): number {
  const raw = env.UPSTREAM_TIMEOUT_MS ? Number(env.UPSTREAM_TIMEOUT_MS) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : UPSTREAM_TIMEOUT_MS;
}

/**
 * Wrap a readable stream so it errors once more than `maxBytes` have passed
 * through — lets us reject an oversized body without buffering it first.
 */
function capStream(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new Error("Upstream image exceeded size cap"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function decodePathSegment(value: string, maxLength: number): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > maxLength || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function fmUrl(raw: string, env: Env): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== env.FM_HOST.toLowerCase() || !parsed.pathname.includes("/Streaming_SSL/")) return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Distinguishes an upstream timeout from any other fetch failure so the
 * caller can return 504 instead of a generic 502. */
class UpstreamTimeoutError extends Error {}

// One deadline covers the whole redirect chain, not a fresh timeout per hop —
// a chain of otherwise-fast redirects shouldn't be able to add up past it.
async function fetchFmImage(raw: string, env: Env, signal: AbortSignal): Promise<Response | null> {
  let target = fmUrl(raw, env);
  if (!target) return null;
  for (let redirects = 0; redirects < 4; redirects++) {
    let response: Response;
    try {
      response = await fetch(target, { redirect: "manual", signal });
    } catch (err) {
      if (signal.aborted) throw new UpstreamTimeoutError();
      return null;
    }
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("Location");
    try {
      target = location ? fmUrl(new URL(location, target).toString(), env) : null;
    } catch {
      target = null;
    }
    if (!target) return null;
  }
  return null;
}

async function getToken(env: Env): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires) return cachedToken.value;
  const auth = btoa(`${env.FM_USER}:${env.FM_PASS}`);
  const res = await fetch(
    `https://${env.FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(env.FM_DB)}/sessions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: "{}",
    },
  );
  if (!res.ok) {
    throw new Error(`FM session failed: ${res.status}`);
  }
  const json = (await res.json()) as { response?: { token?: string } };
  if (!json.response?.token) throw new Error("FM session returned no token");
  cachedToken = { value: json.response.token, expires: Date.now() + TOKEN_TTL_MS };
  return cachedToken.value;
}

interface FmRecord {
  fieldData: Record<string, string>;
}

async function fmFind(
  env: Env,
  layout: string,
  query: Record<string, string>,
  retried = false,
): Promise<FmRecord | null> {
  const token = await getToken(env);
  const res = await fetch(
    `https://${env.FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(env.FM_DB)}/layouts/${layout}/_find`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: [query], limit: 1 }),
    },
  );
  // 401 = token expired between cache check and request — drop cache, retry once.
  // After one retry we bail out so a persistent auth failure can't recurse.
  if (res.status === 401) {
    cachedToken = null;
    if (retried) throw new Error("FM auth failed after token refresh");
    return fmFind(env, layout, query, true);
  }
  if (!res.ok) return null;
  const json = (await res.json()) as { response: { data: FmRecord[] }; messages: { code: string }[] };
  if (json.messages?.some((m) => m.code === "401")) return null; // FM "no records" code
  return json.response.data?.[0] ?? null;
}

interface RouteSpec {
  layout: string;
  query: (slug: string) => Record<string, string>;
  fields: Record<string, string>;
}

const ROUTES: Record<string, RouteSpec> = Object.assign(Object.create(null), {
  artist: {
    layout: "API_ARTIST_DETAIL",
    query: (slug) => ({ SLUG: `==${slug}` }),
    fields: { big: "artistPicture_big", small: "artistPicture_small" },
  },
  client: {
    layout: "API_Management",
    query: (slug) => ({ SLUG: `==${slug}` }),
    fields: { big: "artistPicture_big", small: "artistPicture_small" },
  },
  booking: {
    layout: "API_Booking",
    query: (slug) => ({ SLUG: `==${slug}` }),
    fields: { big: "artistPicture_big", small: "artistPicture_small" },
  },
  news: {
    layout: "API_NEWS",
    query: (slug) => ({ slug: `==${slug}` }),
    fields: { cover: "image_webp" },
  },
  team: {
    layout: "API_USERS",
    query: (slug) => ({ SLUG: `==${slug}` }),
    fields: { big: "userPhoto", small: "userPhotoSmall" },
  },
});

// Releases are a portal on the artist record (not their own layout). Looked up
// by artist slug + either an album name (current scheme — stable across FM
// edits) or a positional index (legacy scheme kept alive for HTML built before
// the by-album route existed).
async function fetchReleasePortal(
  env: Env,
  artistSlug: string,
  retried = false,
): Promise<Array<Record<string, unknown>> | null> {
  const token = await getToken(env);
  const res = await fetch(
    `https://${env.FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(env.FM_DB)}/layouts/API_ARTIST_DETAIL/_find`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: [{ SLUG: `==${artistSlug}` }],
        limit: 1,
        // Match src/lib/ninetone.ts: explicit portal limit so big
        // discographies aren't capped at the layout's portal row count.
        portal: ["Green Web Category"],
        "limit.Green Web Category": "500",
      }),
    },
  );
  if (res.status === 401) {
    cachedToken = null;
    if (retried) throw new Error("FM auth failed after token refresh");
    return fetchReleasePortal(env, artistSlug, true);
  }
  if (!res.ok) return null;
  const json = (await res.json()) as {
    response: { data: Array<{ portalData?: Record<string, Array<Record<string, unknown>>> }> };
    messages: { code: string }[];
  };
  if (json.messages?.some((m) => m.code === "401")) return null;
  const portal = json.response.data?.[0]?.portalData?.["Green Web Category"];
  if (!portal) return null;
  // Drop rows without an album name — the build-side rewriter filters these
  // out before assigning covers, so the Worker must see the same set.
  return portal.filter((r) => String(r["Green Web Category::Album"] ?? "") !== "");
}

function releaseCoverField(row: Record<string, unknown>): string | null {
  const url =
    String(row["Green Web Category::coverPicture_webp"] ?? "") ||
    String(row["Green Web Category::Cover_Picture"] ?? "");
  return url || null;
}

async function fetchReleaseCoverByAlbum(
  env: Env,
  artistSlug: string,
  album: string,
): Promise<string | null> {
  const portal = await fetchReleasePortal(env, artistSlug);
  if (!portal) return null;
  // Same album released twice (e.g. single + remaster) → prefer the newest.
  const matches = portal
    .filter((r) => String(r["Green Web Category::Album"] ?? "") === album)
    .sort((a, b) => {
      const da = parseDate(String(a["Green Web Category::Releasedate First"] ?? ""));
      const db = parseDate(String(b["Green Web Category::Releasedate First"] ?? ""));
      return db - da;
    });
  const row = matches[0];
  return row ? releaseCoverField(row) : null;
}

// Legacy: HTML built before the by-album scheme addresses covers by
// newest-first index. Keep resolving those until the preview is rebuilt.
async function fetchReleaseCoverByIndex(
  env: Env,
  artistSlug: string,
  index: number,
): Promise<string | null> {
  const portal = await fetchReleasePortal(env, artistSlug);
  if (!portal) return null;
  const sorted = [...portal].sort((a, b) => {
    const da = parseDate(String(a["Green Web Category::Releasedate First"] ?? ""));
    const db = parseDate(String(b["Green Web Category::Releasedate First"] ?? ""));
    return db - da;
  });
  const row = sorted[index];
  return row ? releaseCoverField(row) : null;
}

function parseDate(s: string): number {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Standard observability headers attached to every image response. Lets us
 * inspect what the Worker is doing from devtools without log access:
 *   x-fm-route   route kind that served the request, e.g. "artist/big"
 *   x-fm-status  hit   served from caches.default, no FM round trip
 *                miss  resolved through FM this request (and stored if 200)
 *                error not an image response; never cached
 */
function obsHeaders(route: string, status: "hit" | "miss" | "error" = "miss"): Record<string, string> {
  return {
    "x-fm-route": route,
    "x-fm-status": status,
  };
}

const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

/**
 * Resolve + stream one upstream image, applying the shared timeout and size
 * cap. Returns either a ready-to-send Response or an error status/body pair
 * for the caller to wrap with its own CORS/observability headers.
 */
async function streamImage(
  imageUrl: string,
  env: Env,
  origin: string | null,
  route: string,
): Promise<Response> {
  const timeoutMs = upstreamTimeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let imgRes: Response | null;
  try {
    imgRes = await fetchFmImage(imageUrl, env, controller.signal);
  } catch (err) {
    if (err instanceof UpstreamTimeoutError) {
      return new Response("Upstream timed out", {
        status: 504,
        headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
      });
    }
    return new Response("Image fetch failed", {
      status: 502,
      headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!imgRes) {
    return new Response("Image fetch failed", {
      status: 502,
      headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
    });
  }
  if (!imgRes.ok) {
    return new Response("Image fetch failed", {
      status: 502,
      headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
    });
  }
  const contentLength = Number(imgRes.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    return new Response("Image too large", {
      status: 502,
      headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
    });
  }
  const contentType = imgRes.headers.get("Content-Type")?.split(";", 1)[0].toLowerCase();
  if (!contentType || !SUPPORTED_IMAGE_TYPES.includes(contentType)) {
    return new Response("Unsupported image type", {
      status: 502,
      headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
    });
  }
  const headers = new Headers({ "Content-Type": contentType });
  headers.set("X-Content-Type-Options", "nosniff");
  // s-maxage drives the caches.default TTL (6 h); max-age is the browser's
  // 24 h. No stale-while-revalidate — the Cache API ignores it.
  headers.set("Cache-Control", `public, max-age=${BROWSER_TTL_S}, s-maxage=${EDGE_TTL_S}`);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  for (const [k, v] of Object.entries(obsHeaders(route, "miss"))) headers.set(k, v);
  const body = imgRes.body ? capStream(imgRes.body, MAX_IMAGE_BYTES) : imgRes.body;
  return new Response(body, { headers });
}

/** Minimal shape of the Workers ExecutionContext we rely on; optional so the
 * handler also runs under plain Node in tests (no waitUntil → fire-and-forget). */
interface Ctx {
  waitUntil?(promise: Promise<unknown>): void;
}

/** Shape of `caches.default` we use; absent outside the Workers runtime. */
interface EdgeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

function edgeCache(): EdgeCache | undefined {
  return (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
}

/**
 * Canonical cache key: origin + pathname + only the `v` query param. Every
 * other query string is dropped on purpose — the site adds `?v=<epoch>` as
 * the deliberate buster, and nothing else may mint a key (and an FM read).
 */
function cacheKey(url: URL): Request {
  const v = url.searchParams.get("v");
  return new Request(url.origin + url.pathname + (v ? `?v=${encodeURIComponent(v)}` : ""));
}

/** Only the image routes are cacheable; /healthz and unknown paths never are. */
function isImageRoute(kind: string | undefined): boolean {
  return kind === "release" || (kind !== undefined && kind in ROUTES);
}

/**
 * Re-wrap a cached copy for THIS request: the stored headers carry the CORS
 * origin of whoever caused the miss, and the allowed origin depends on the
 * requester, so it is re-applied here rather than trusted from the cache.
 */
function fromCache(hit: Response, origin: string | null): Response {
  const headers = new Headers(hit.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  headers.set("x-fm-status", "hit");
  return new Response(hit.body, { status: hit.status, headers });
}

export default {
  async fetch(req: Request, env: Env, ctx?: Ctx): Promise<Response> {
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
    if (req.method !== "GET") return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, OPTIONS", ...corsHeaders(origin) },
    });

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Under Node (tests) there is no Cache API — behaviour is then exactly the
    // pre-cache path: every request resolves through FM.
    const cache = isImageRoute(parts[0]) ? edgeCache() : undefined;
    const key = cache ? cacheKey(url) : null;
    if (cache && key) {
      const hit = await cache.match(key);
      if (hit) return fromCache(hit, origin);
    }

    const res = await resolveImage(parts, env, origin);

    // Store only real images. The clone happens before the body is handed to
    // the client, so both sides read the same tee'd stream; if capStream
    // errors mid-body the put rejects — log it, never let it surface as an
    // unhandled rejection or a failed request.
    if (cache && key && res.status === 200) {
      const put = cache.put(key, res.clone()).catch((err: unknown) => {
        console.warn(`[fm-proxy] cache.put failed for ${key.url}:`, err instanceof Error ? err.message : err);
      });
      if (ctx?.waitUntil) ctx.waitUntil(put);
    }
    return res;
  },
};

/**
 * Everything below the cache shell: /healthz plus the FM lookup + stream for
 * one image route. Unchanged from before the Cache API layer was added.
 */
async function resolveImage(parts: string[], env: Env, origin: string | null): Promise<Response> {
  if (parts[0] === "healthz") {
    // Beyond a token check, verify FM is actually answering for a route we
    // know exists. Catches the case where the token is valid but a layout
    // changed name or permission flipped.
    const checks: Record<string, unknown> = { tokenCached: !!cachedToken };
    try {
      await getToken(env);
      checks.token = "ok";
    } catch (err) {
      checks.token = "failed";
      return new Response(JSON.stringify({ ok: false, ...checks }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
    try {
      // Cheap representative read — just confirms the API_ARTIST_DETAIL
      // layout still responds. We don't care which record comes back.
      const probe = await fmFind(env, "API_ARTIST_DETAIL", { SLUG: "*" });
      checks.fmFind = probe ? "ok" : "no-records";
    } catch (err) {
      checks.fmFind = "failed";
      return new Response(JSON.stringify({ ok: false, ...checks }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
    return new Response(JSON.stringify({ ok: true, ...checks }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  const [kind, slug, variant, extra] = parts;

  // /release/:artistSlug/by-album/:album — release cover art (current)
  // /release/:artistSlug/:index         — legacy positional lookup
  if (kind === "release" && slug && variant) {
    const safeSlug = decodePathSegment(slug, MAX_SLUG_LENGTH);
    if (!safeSlug) return new Response("Bad slug", { status: 400, headers: corsHeaders(origin) });
    const byAlbum = variant === "by-album";
    const route = byAlbum ? "release/by-album" : `release/${variant}`;
    let idx = -1;
    let album = "";
    if (byAlbum) {
      if (!extra) {
        return new Response("Missing album", {
          status: 400,
          headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
        });
      }
      const decodedAlbum = decodePathSegment(extra, MAX_ALBUM_LENGTH);
      if (!decodedAlbum) return new Response("Bad album", { status: 400, headers: corsHeaders(origin) });
      album = decodedAlbum;
    } else {
      idx = parseInt(variant, 10);
      if (!Number.isInteger(idx) || idx < 0 || String(idx) !== variant) {
        return new Response("Bad index", {
          status: 400,
          headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
        });
      }
    }
    let imageUrl: string | null;
    try {
      imageUrl = byAlbum
        ? await fetchReleaseCoverByAlbum(env, safeSlug, album)
        : await fetchReleaseCoverByIndex(env, safeSlug, idx);
    } catch (err) {
      return new Response("FM error", {
        status: 502,
        headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
      });
    }
    if (!imageUrl) {
      return new Response("Release not found", {
        status: 404,
        headers: { ...corsHeaders(origin), ...obsHeaders(route, "error") },
      });
    }
    return streamImage(imageUrl, env, origin, route);
  }

  const route = ROUTES[kind];
  const routeTag = `${kind}/${variant ?? ""}`;
  if (!route) {
    return new Response("Not found", {
      status: 404,
      headers: { ...corsHeaders(origin), ...obsHeaders(routeTag, "error") },
    });
  }
  const fieldName = route.fields[variant];
  if (!fieldName || !slug) {
    return new Response("Not found", {
      status: 404,
      headers: { ...corsHeaders(origin), ...obsHeaders(routeTag, "error") },
    });
  }
  const safeSlug = decodePathSegment(slug, MAX_SLUG_LENGTH);
  if (!safeSlug) return new Response("Bad slug", { status: 400, headers: corsHeaders(origin) });

  let record: FmRecord | null;
  try {
    record = await fmFind(env, route.layout, route.query(safeSlug));
  } catch (err) {
    return new Response("FM error", {
      status: 502,
      headers: { ...corsHeaders(origin), ...obsHeaders(routeTag, "error") },
    });
  }
  if (!record) {
    return new Response("Record not found", {
      status: 404,
      headers: { ...corsHeaders(origin), ...obsHeaders(routeTag, "error") },
    });
  }

  const imageUrl = record.fieldData[fieldName];
  if (!imageUrl) {
    return new Response("Image field empty", {
      status: 404,
      headers: { ...corsHeaders(origin), ...obsHeaders(routeTag, "error") },
    });
  }

  // Stream the image bytes through. FM URL is fresh — generated this same
  // request — so it works for the brief moment we need it.
  return streamImage(imageUrl, env, origin, routeTag);
}
