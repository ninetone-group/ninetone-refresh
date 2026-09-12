// /404 is skipped for a subtler reason than /api and /admin: Astro.rewrite()
// (used by every detail route on a failed lookup) re-invokes this ENTIRE
// middleware — including this module — a second, nested time for the
// rewritten pathname, before returning control to the page that called it.
// That inner pass used to run the full cache read -> clone -> store cycle
// against the SAME response stream the outer pass would then read again to
// finish handling the original URL. A ReadableStream can only be consumed
// once; teeing it via `res.clone()` in the inner pass left the outer pass
// racing an already-locked-or-drained stream, which is what produced the
// intermittent zero-byte bodies on 404s (see docs/seo-phase-1b-brief.md P0
// item 1, Cause A). Bypassing the cache entirely for /404 means the inner
// pass does a single clean `harden(await next())` with no clone/tee, so the
// outer pass always receives a fully-formed body to hand back to the client.
const SKIP = [/^\/api\//, /^\/admin(\/|$)/, /^\/404(\/|$)/];

/**
 * Query params that never change page content — safe to ignore for cache
 * purposes so campaign links (?utm_*, ?fbclid=...) still hit the shared cache
 * instead of missing on every unique click-through.
 */
const IGNORABLE_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid", "mc_cid", "mc_eid", "ref",
]);

/**
 * Reduce a request's query string to what actually affects the response.
 * Returns "" when every param is an ignorable tracking param (or there are
 * none), or null when any other param is present — callers should treat
 * null as "bypass, this may vary the response".
 */
export function canonicalSearch(search: string): string | null {
  if (search === "") return "";
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (!IGNORABLE_PARAMS.has(key)) return null;
  }
  return "";
}

/**
 * The site sets no session/auth cookies, so a cookie header alone is not a
 * signal of private content — analytics cookies (_ga, _fbp, _ttp) set after
 * consent would otherwise make every repeat visitor miss the shared cache.
 * Response-side checks (private/no-store/no-cache, Set-Cookie, non-200,
 * /api and /admin skips) protect any future private route instead.
 */
export function shouldBypassCache(request: Request, pathname: string, search: string): boolean {
  return request.method !== "GET" || request.headers.has("authorization") ||
    canonicalSearch(search) === null || SKIP.some((re) => re.test(pathname));
}

export function edgeCacheKey(origin: string, pathname: string, version: string, buildId: string): string {
  return `https://edge-cache.ninetone.internal/v${version}/b${buildId}/o${encodeURIComponent(origin)}${pathname}`;
}

/**
 * Canonical (no trailing slash) pathname for a trailing-slash redirect —
 * seo-phase-1b-brief.md P0 item 5. The cf target sets `trailingSlash: "never"`
 * in astro.config.mjs, so "/records/" is never the shape Astro itself
 * renders or the middleware caches; this is what src/middleware.ts 301s to,
 * ahead of the cache lookup.
 *
 * Returns null when no redirect is warranted:
 *   - the pathname has no trailing slash to strip,
 *   - the pathname IS just "/" (root — stripping would produce "", not a
 *     real path, and "/" is never redirected),
 *   - the pathname matches the same SKIP list cache-policy already exempts
 *     from caching (/api/*, /admin, /404) — reusing that predicate rather
 *     than a second hardcoded list, per the brief.
 */
/**
 * OBSERVED ON STAGING (seo-phase-1b P0 item 5): on the cf target this function
 * rarely fires, because Cloudflare's static-asset layer normalizes trailing
 * slashes BEFORE the Worker is invoked — "/records/" comes back as a 308 to
 * "/records" carrying none of harden()'s security headers, i.e. our middleware
 * never ran. This helper stays as the correct in-Worker behaviour (and is what
 * the unit tests exercise); it is a backstop, not the primary mechanism.
 *
 * Two consequences worth knowing rather than "fixing":
 *   - The brief asks for 301; the asset layer issues 308. Both are permanent
 *     redirects and both consolidate ranking signals. 308 additionally
 *     preserves method and body, so it is the safer of the two for any
 *     non-GET that arrives with a stray slash.
 *   - The /api/* exemption below cannot be honoured for requests the asset
 *     layer answers first: "/api/contact/" 308s despite being in SKIP.
 *     Verified harmless — POST to the real "/api/contact" is reached normally
 *     (returns 400 for an empty body, i.e. the handler ran), nothing in src/
 *     links to an API path with a trailing slash, and 308 preserves the POST
 *     body anyway.
 */
/**
 * Collapse runs of slashes ("//evil.com/x", "/en//admin") to single slashes.
 * Returns null when the pathname is already canonical.
 *
 * Two defects share this root (2026-09-12 adversarial review):
 *   - OPEN REDIRECT: "//evil.com/" reached the trailing-slash 301 with target
 *     "//evil.com" — a protocol-relative Location the browser resolves to
 *     https://evil.com, shipped with our HSTS and noindex headers.
 *   - SKIP BYPASS: the anchored SKIP patterns never matched "//admin/publish",
 *     so a doubled slash defeated the cache bypass the same way a "/en"
 *     prefix once did.
 * The middleware 301s any such request to the collapsed path first, so every
 * later predicate and every Location it builds sees a single-slash-rooted
 * path. WHATWG URL already folds backslashes into slashes for https, so
 * forward slashes are the only separator that can reach here.
 */
export function collapseSlashes(pathname: string): string | null {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  return collapsed === pathname ? null : collapsed;
}

export function trailingSlashRedirectTarget(pathname: string): string | null {
  if (pathname === "/" || !pathname.endsWith("/")) return null;
  if (SKIP.some((re) => re.test(pathname))) return null;
  return pathname.slice(0, -1);
}

/**
 * Legacy previous-artist deep links → their real detail path.
 *
 * The old site served per-artist pages at `/previous-artists/{slug}` (verified
 * live: `/previous-artists/kuokka` is 200 there) and, later,
 * `/previous-artists/single/{slug}`. Both shapes exist in the wild — Discogs,
 * forums, old press — so both redirect to today's
 * `/records/artists/previous/single/{slug}`.
 *
 * Returns null for anything else, including the bare `/previous-artists`
 * (astro.config.mjs's `redirects` owns that one, since a static destination
 * needs no dynamic param and the adapter writes it correctly).
 *
 * Pure and exported so it can be unit-tested without a build.
 */
export function legacyPreviousArtistTarget(pathname: string): string | null {
  const m = /^\/previous-artists\/(?:single\/)?([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const slug = m[1];
  // "single" alone is "/previous-artists/single" — a listing shape, not a
  // slug. Without this guard it becomes /records/artists/previous/single/single,
  // a redirect into a 404. public/_redirects carries the same guard as an
  // explicit first rule (it matches top-down); keep the two in sync.
  if (!slug) return null;
  if (slug === "single") return "/records/artists/previous";
  return `/records/artists/previous/single/${slug}`;
}
