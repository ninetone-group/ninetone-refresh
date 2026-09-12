/**
 * Tiered edge-cache middleware — the "really good cache engine" from
 * docs/cms-architecture.md, in one route→TTL table.
 *
 * Flow per GET request (cf target only — inert in Node, where there is no
 * Cache API):
 *
 *   1. Read the cache VERSION from KV (bumped by the Publish button —
 *      src/pages/api/publish.ts). The version is part of every cache key,
 *      so bumping it instantly invalidates the whole site without a
 *      Cloudflare-API purge token.
 *   2. Look up `v<version>:<path>` in the edge cache → serve on hit (~ms).
 *   3. On miss, render the page (FM reads go through src/lib/cache.ts,
 *      so even a burst of misses costs at most one FM call per query per
 *      60s per isolate), stamp tiered Cache-Control, and store the copy
 *      via cfContext.waitUntil so the visitor never waits on the write.
 *
 * Content-aware TTLs: different content changes at different rates. One
 * flat timeout would either hammer FM (too short) or feel stale (too
 * long). Tiers per the architecture doc:
 *
 *   homepage 5min · news 15min · detail pages 1h · rosters 6h · team 24h
 *
 * `stale-while-revalidate` is included for the production domain, where
 * Cloudflare's CDN honors it; the Worker-level Cache API simply expires.
 *

 * Cache keys embed BOTH invalidation signals:
 *   - the KV version epoch (content: Publish button)
 *   - the per-build id (code: every deploy starts a fresh generation)
 * Verified live on workers.dev — x-cache: hit serves in ~20ms.
 */

import { defineMiddleware } from "astro:middleware";
import { getCfEnv } from "./lib/cf";
import {
  collapseSlashes,
  edgeCacheKey,
  legacyPreviousArtistTarget,
  shouldBypassCache,
  trailingSlashRedirectTarget,
} from "./lib/cache-policy";
import { hasEnglishVersion, localizedPath, stripLocale } from "./lib/i18n";
import { timeServer, withServerTiming } from "./lib/server-timing";
import {
  loadTranslationBundle,
  storeTranslationBundleIfChanged,
  translationBundleKey,
  translationLedgerFor,
  type Lang,
} from "./lib/translate";

// Statically replaced by Vite (astro.config define); guarded for any context
// where the define isn't applied.
declare const __BUILD_ID__: string | undefined;
const BUILD_ID = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

/**
 * Are we on the Cloudflare (server) target?
 *
 * This middleware also runs during the STATIC build's prerender pass, which is
 * easy to forget — and there it must not redirect anything. Astro builds each
 * prerender URL from `config.trailingSlash`, and on the gh target
 * ("ignore" + build.format "directory") every path arrives WITH a trailing
 * slash. The canonicalizer below then 301'd every route before next() could
 * render it; Astro's generate.js saw a 3xx and wrote a redirect shim in place
 * of the page, while still counting it as a built page. Result: 546 "pages"
 * of ~450-byte shims, build time collapsed from 53s to 3s, and no FM fetch at
 * all. Guarded here rather than at the call site so any future redirect added
 * to this file inherits the same protection.
 *
 * Read defensively (optional chaining + string compare) the same way
 * ContactForm.astro and YouTubeFeed.astro do: the test harness bundles this
 * module through esbuild, where `import.meta.env` does not exist.
 */
const HAS_RUNTIME =
  import.meta.env?.PUBLIC_HAS_RUNTIME === true ||
  import.meta.env?.PUBLIC_HAS_RUNTIME === "true";

/** First match wins — order specific → general. Seconds. */
const TTL_RULES: Array<[RegExp, number]> = [
  [/^\/$/, 300], // homepage — promo bar + featured rotate often
  [/^\/search-index\.json$/, 900], // command palette / search data
  [/^\/news(\/|$)/, 900], // news index + articles
  [/^\/team(\/|$)/, 86400], // changes a few times a year
  [/^\/integritet(\/|$)/, 86400], // static legal copy
  [/^\/guider(\/|$)/, 86400], // hand-authored guides — same cadence as legal copy
  [/^\/(records|management|ninetone-nation)\/?$/, 21600], // section landings
  [/^\/records\/artists\/?$/, 21600], // roster lists
  [/^\/management\/clients\/?$/, 21600],
  [/^\/ninetone-nation\/booking\/?$/, 21600],
  [/^\/records\/artists\/previous\/single\//, 3600], // previous-artist detail
  [/^\/records\/artists\/previous(\/|$)/, 21600], // previous roster (paginated)
  [/^\/records\/artists\//, 3600], // artist detail
  [/^\/management\/clients\//, 3600], // client detail
  [/^\/ninetone-nation\//, 3600], // nation detail + contact
];
const DEFAULT_TTL = 3600;

/** KV keys are capped at 512 bytes; leave headroom for multi-byte paths. */
const MAX_BUNDLE_KEY_LENGTH = 400;

function ttlFor(pathname: string): number {
  for (const [re, ttl] of TTL_RULES) {
    if (re.test(pathname)) return ttl;
  }
  return DEFAULT_TTL;
}

/**
 * Site-wide noindex while the preview is gated — the same PUBLIC_NOINDEX
 * flag Base.astro's <meta name="robots"> and robots.txt read. public/_headers
 * only covers the static-asset layer, so without this the SSR HTML never
 * carried the header the launch checklist assumed it did. Flips off with
 * the same single variable at launch.
 */
const NOINDEX_HEADER =
  String(import.meta.env?.PUBLIC_NOINDEX ?? "true") !== "false";

function harden(res: Response): Response {
  // Some platform responses expose immutable headers; clone before applying
  // policy so redirects/errors receive the same protection reliably.
  res = new Response(res.body, res);
  if (NOINDEX_HEADER) res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.headers.set("Content-Security-Policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'none'");
  res.headers.set("Strict-Transport-Security", "max-age=31536000");
  return res;
}

export const onRequest = defineMiddleware((context, next) => withServerTiming(async () => {
  const { request, url, locals } = context;
  const render = (target?: string) => timeServer("render", () => next(target));

  // Trailing-slash canonicalization (seo-phase-1b-brief.md P0 item 5) — the
  // cf target's astro.config.mjs now sets trailingSlash: "never", so
  // "/path/" is never the shape Astro itself renders. Redirect ahead of the
  // cache lookup: it must return immediately without ever reaching the
  // cache read/buffer/store cycle below. trailingSlashRedirectTarget()
  // already exempts "/" and reuses cache-policy's own SKIP list (/api/*,
  // /admin, /404) rather than a second hardcoded exemption list.
  //
  // FIRST, collapse doubled slashes (see collapseSlashes in cache-policy.ts):
  // "//evil.com/" must never become a protocol-relative Location, and
  // "//admin/publish" must not slip past the anchored SKIP list. Every
  // predicate below, and every Location built below, works on `pathname`,
  // the collapsed form — never on url.pathname directly.
  const collapsed = HAS_RUNTIME ? collapseSlashes(url.pathname) : null;
  const pathname = collapsed ?? url.pathname;
  const redirectTarget = HAS_RUNTIME ? (trailingSlashRedirectTarget(pathname) ?? collapsed) : null;
  if (redirectTarget) {
    const location = `${redirectTarget}${url.search}`;
    return harden(new Response(null, { status: 301, headers: { Location: location } }));
  }

  // Legacy previous-artist deep links (seo-phase-1b-brief.md P0 item 2).
  //
  // BACKSTOP, not the live path on cf. Verified on staging: these URLs are
  // answered by the Cloudflare static-asset layer from public/_redirects —
  // the response carries public/_headers' fingerprint (max-age=600,
  // x-robots-tag) rather than this middleware's (x-cache, tiered s-maxage) —
  // so the code below does not run there. It exists for any request that does
  // reach the Worker, and it is what the unit tests exercise.
  //
  // Not in astro.config.mjs's `redirects` because the Cloudflare adapter
  // writes those into _redirects with an "/index.html" suffix on dynamic
  // destinations, which 404s on an SSR Worker, and corrected duplicates are
  // rejected ("Duplicate rule for path").
  //
  // Keep in sync with public/_redirects, including the "single" listing guard.
  //
  // LOCALE-AWARE (i18n Phase 2): the lookup runs on the locale-STRIPPED path
  // and the locale is re-applied to the destination, so an English visitor
  // stays in English across the redirect.
  //
  // legacyPreviousArtistTarget's pattern is anchored at "/previous-artists",
  // so before this change "/en/previous-artists/kuokka" simply didn't match —
  // and the outcome was worse than the locale-losing redirect it looked like
  // it was avoiding. The request fell through to the rewrite below and became
  // next("/previous-artists/kuokka"), which is NOT a route in this app (that
  // path exists only as a redirect rule in public/_redirects, served by the
  // asset layer ahead of the Worker). So it route-missed into the 404 — an
  // English visitor following an old Discogs link got a hard 404 where a
  // Swedish visitor following the same link got a working 301, and the 404
  // was then cached for an hour under the /en/ key.
  const legacyLocale = HAS_RUNTIME ? stripLocale(pathname) : null;
  const legacyPrevious = legacyLocale ? legacyPreviousArtistTarget(legacyLocale.path) : null;
  if (legacyPrevious && legacyLocale) {
    const location = `${localizedPath(legacyPrevious, legacyLocale.lang)}${url.search}`;
    return harden(new Response(null, { status: 301, headers: { Location: location } }));
  }

  // Locale detection + rewrite (docs/i18n-phase-2-brief.md decision 2).
  //
  // gh/static guard: on the static GH Pages preview there is no request-time
  // rewrite mechanism at all (see below — next(payload) needs the live route
  // manifest astro:middleware's test/dev/cf pipeline provides), and decision
  // 2 is explicit that /en/ is a CF-only feature there anyway ("Static GH
  // Pages preview stays single-language Swedish"). HAS_RUNTIME is the same
  // flag the redirect backstops above already gate on, so an /en/-prefixed
  // path on the gh target falls straight through to next() untouched and
  // 404s exactly like any other route Astro didn't build — never gains
  // locale behaviour that could interact with the prerender pass.
  //
  // MUST run after the redirect backstops above (trailing-slash and legacy
  // previous-artist both operate on the raw, possibly-/en-prefixed pathname
  // as an opaque string and are correct either way — "/en/records/" still
  // 301s to "/en/records", "/en/previous-artists/x" simply never matches the
  // legacy regex, which is correct: those old deep links never had an
  // English variant) and MUST run before the cache short-circuit below,
  // because the cache key is partly derived from url.pathname and that
  // derivation needs to know the locale before it runs (see rawPathname).
  let lang: Lang = "sv";
  // The RAW, pre-rewrite pathname — captured now, before next(rewritten) is
  // ever called below. This is what the cache key is built from, NOT
  // `stripped`. If the cache key were computed from the post-rewrite path
  // instead, "/en/records" and "/records" would both resolve to the cache
  // key for "/records" and collide onto ONE shared cache slot: whichever
  // locale rendered first would serve both, and the other locale's visitors
  // would randomly get the wrong-language page for the page's entire TTL
  // (up to 24h for team/legal pages) until the slot's next miss happened to
  // be the correct locale again. Keeping the /en segment IN the cache-key
  // pathname is what makes the two locales address different cache entries
  // even though they render the same underlying route.
  const rawPathname = pathname;
  let renderTarget: string | null = null;
  if (HAS_RUNTIME) {
    // /en/api/* is a 404, NOT a rewrite (brief, decision 2 / Build item):
    // the real API routes exist ONLY at /api/*. Rewriting
    // "/en/api/contact" → "/api/contact" would silently let a
    // locale-prefixed URL reach the contact/publish handlers — verified
    // empirically against a live `astro dev` server that without this
    // guard, next("/api/contact") reaches the real handler (the request
    // gets a real 400 validation response, i.e. the handler ran). Checked
    // ahead of the general strip-and-rewrite below, on the raw pathname,
    // so it takes priority over the general case.
    if (/^\/en\/api(\/|$)/.test(rawPathname)) {
      return harden(new Response(null, { status: 404 }));
    }

    // A SECOND "/en" segment is a real path segment, not another locale
    // prefix — "/en/en/records" is not "English, twice", it is a page named
    // "en" inside the English locale, and no such page exists.
    //
    // Without this guard stripLocale peels exactly one level, so
    // "/en/en/records" rewrote to "/en/records" — itself not a route (the
    // route table only holds bare paths) — and route-missed into the custom
    // 404. The right OUTCOME by accident, but reached without intent and,
    // worse, cached: every member of the infinite "/en/en/en/..." family
    // minted its own edge-cache entry for an hour. Answering directly here
    // makes the 404 deliberate and keeps the cache key space finite.
    if (/^\/en\/en(\/|$)/.test(rawPathname)) {
      return harden(new Response(null, { status: 404 }));
    }

    const stripped = stripLocale(rawPathname);
    lang = stripped.lang;

    // Swedish-only content (src/lib/i18n.ts SWEDISH_ONLY_PREFIXES — the
    // privacy policy and the guides) has no English URL: hreflang, the
    // sitemap and the language switch already say so, and this is the
    // serving side of the same rule (2026-09-12 SEO review). Without it
    // "/en/integritet" answered 200 with Swedish HTML canonicalised to
    // "/integritet" — a crawlable soft-duplicate. A 301 to the Swedish URL
    // rather than a 404: a visitor who edited the address bar still lands on
    // the page, and a crawler consolidates instead of recording a dead end.
    if (lang === "en" && !hasEnglishVersion(stripped.path)) {
      return harden(new Response(null, { status: 301, headers: { Location: `${stripped.path}${url.search}` } }));
    }

    if (lang === "en") renderTarget = stripped.path;
  }
  // Set locals.lang only if this is the FIRST pass through this middleware
  // for the request. Astro.rewrite("/404") (src/lib/not-found.ts, used by
  // every detail route on a failed lookup) re-invokes this entire
  // middleware a second, nested time for the "/404" pathname — and
  // state.locals (astro/dist/core/fetch/fetch-state.js) is ONE shared
  // object across outer and inner passes, never recreated by the rewrite
  // machinery. Without this guard, the inner pass would see rawPathname
  // "/404" (no /en prefix — Astro.rewrite("/404") always targets the bare
  // path), derive lang "sv", and stomp the outer pass's "en" back to "sv"
  // while the real request is still an /en/... 404. The 404 page would then
  // render with the wrong <html lang> and (once section 4 wires up t())
  // Swedish chrome copy for an English visitor. Setting it once, on first
  // touch, means the inner pass inherits whatever the outer pass correctly
  // determined instead of re-deriving it from a pathname that has already
  // been rewritten out from under it.
  const localsRef = locals as { lang?: Lang };
  if (localsRef.lang === undefined) localsRef.lang = lang;

  const cacheApi = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  // shouldBypassCache asks a SEMANTIC-ROUTE question ("is this an /api,
  // /admin or /404 route?"), exactly like ttlFor below — so it takes the
  // STRIPPED path, not the raw one. Only the cache KEY is a locale question.
  //
  // Passing rawPathname here was a real defect, caught in review and
  // reproduced directly against cache-policy: its SKIP patterns are anchored
  // (/^\/admin(\/|$)/ etc.), so a leading "/en" defeats every one of them
  // while the rewrite below still sends the request to the real route:
  //
  //   /admin/publish    → BYPASS (correct)
  //   /en/admin/publish → CACHED (wrong — the skip silently evaporated)
  //   /404              → BYPASS (correct)
  //   /en/404           → CACHED (wrong)
  //
  // src/pages/admin/publish.astro sets no Cache-Control of its own, so the
  // rendered Publish console passed the response-side bypass checks further
  // down and would have been stored at the edge for an hour under
  // s-maxage=3600, reachable by anyone who guessed the URL. The page is only
  // a password form (the real secret is checked in /api/publish), so this was
  // not credential disclosure — but SKIP is the mechanism every future
  // private route will rely on, and a locale prefix must never be able to
  // strip it. /en/404 additionally un-did the documented no-cache invariant
  // that cache-policy.ts's header comment exists to explain.
  if (!cacheApi || shouldBypassCache(request, renderTarget ?? rawPathname, url.search)) {
    return harden(await render(renderTarget ?? undefined));
  }

  const env = await getCfEnv();
  if (!env) return harden(await render(renderTarget ?? undefined)); // Node runtime (static build / plain dev)

  // Publish-button epoch. KV read is edge-cached 60s, so a Publish takes
  // effect within ~a minute per colo — and costs ~nothing per request.
  let version = "0";
  try {
    version = await timeServer("cachever", async () =>
      (await env.CACHE_STATE?.get("cache-version", { cacheTtl: 60 })) ?? "0"
    );
  } catch {
    // KV unavailable → still cache, just without instant purge.
  }

  // ttlFor's table is written in terms of the semantic (locale-free) route —
  // "/records" changes at the same rate whether it's rendered in Swedish or
  // English, so the TTL lookup uses the STRIPPED path (renderTarget when
  // present, else the raw path is already bare). Using rawPathname here
  // instead would silently miss every rule for an /en/ request (none of
  // TTL_RULES' patterns match a leading "/en" segment) and fall everything
  // on /en/* through to DEFAULT_TTL — wrong tier, not a correctness bug like
  // the cache-key collision below, but still worth getting right the first
  // time rather than leaving English visitors on a different freshness
  // contract than Swedish ones for no reason.
  const ttl = ttlFor(renderTarget ?? rawPathname);
  // Cache KEY, by contrast, is built from rawPathname (still carrying /en
  // when present) — see the comment above rawPathname's declaration for why
  // collapsing this to the rewritten path would let the two locales share
  // one cache slot. Include the request origin so Host-dependent SSR output
  // cannot cross hosts either.
  const cacheKey = new Request(edgeCacheKey(url.origin, rawPathname, version, BUILD_ID));

  const hit = await timeServer("cache", () => cacheApi.match(cacheKey));
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("x-cache", "hit");
    return harden(res);
  }

  // Clone immediately: platform-generated redirects can expose immutable
  // Headers, while the cache decision needs to annotate every response.
  //
  // renderTarget carries the STRIPPED path ("/en/records" → "/records") so
  // Astro renders the real route; undefined means "no rewrite" (sv request,
  // or HAS_RUNTIME false), which next() treats identically to next() with no
  // arguments per Astro's MiddlewareNext signature.
  // Route translation bundle (see translate.ts, "Per-route translation
  // bundles"): ONE KV read that seeds the isolate cache with every
  // translation this route resolved last time, so a cold isolate does not
  // pay one round trip per string — the cause of the multi-second
  // page-cache misses measured on 2026-09-12. Keyed by locale + semantic
  // route, like the TTL table. A miss or a malformed value is simply "no
  // seed"; the render is unaffected either way.
  //
  // The key embeds the request path, which is attacker-chosen. Two bounds
  // keep that harmless: KV keys max out at 512 bytes, so over-long paths skip
  // the bundle entirely instead of throwing on every request; and the WRITE
  // below only happens for a 200 (the non-200 early return further down is
  // what stops a 404 flood from minting bundle keys — keep it ahead of the
  // write if this block is ever reordered).
  const translationKv = env.CACHE_STATE ?? null;
  const bundleKey = translationBundleKey(lang, renderTarget ?? rawPathname);
  const bundleUsable = translationKv !== null && bundleKey.length <= MAX_BUNDLE_KEY_LENGTH;
  const bundle = bundleUsable
    ? await timeServer("trbundle", () => loadTranslationBundle(translationKv!, bundleKey))
    : null;
  // Created here so the nested /404 rewrite pass (same locals object) and
  // every component in the render append to ONE ledger.
  const ledger = translationLedgerFor(locals as { __i18nLedger?: Map<string, string> });

  const rendered = await render(renderTarget ?? undefined);
  const res = new Response(rendered.body, rendered);

  // Only cache successful full responses — a transient error page must never
  // be pinned at the edge for an hour.
  const responseCacheControl = res.headers.get("cache-control") ?? "";
  if (
    res.status !== 200 ||
    res.headers.has("set-cookie") ||
    /(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(responseCacheControl)
  ) {
    res.headers.set("x-cache", "bypass");
    return harden(res);
  }

  // Buffer the body before caching rather than res.clone().
  //
  // Astro streams its HTML. clone() tees that single stream into two branches
  // which must be consumed at roughly the same rate: one goes to the visitor,
  // the other to cacheApi.put(). When the visitor's branch finishes first the
  // renderer is still writing into the cache branch, and the runtime throws
  //   ResponseSentError: The response has already been sent to the browser
  //   and cannot be altered.
  // from BufferedRenderer.flush — which aborts the render mid-stream and
  // hands the visitor a ZERO-BYTE 200. Captured via `wrangler tail`:
  // 3/3 requests to a heavy detail page threw exactly this
  // (docs/seo-phase-1b-brief.md P0 items 1 and 3 are the same defect).
  //
  // Reading the body to completion first costs one buffer of the page, and
  // these are HTML documents, not large assets. Both the visitor's response
  // and the cached copy are then built from the same settled bytes, so
  // neither can race the other.
  const body = await timeServer("buffer", () => res.arrayBuffer());

  // DEGRADED RENDER — decided only AFTER the body is buffered. Astro streams:
  // when render() returns, only the page's own frontmatter has run; Header,
  // Footer and every card execute while the body is consumed above, and
  // their translation calls are the ones most likely to hit the ceiling. A
  // check placed before the buffer saw refusedCount=0 for a render that went
  // on to refuse seven strings, and cached the half-translated page for the
  // full tier (24 h on /team). Reproduced and pinned in test/middleware.test.mjs.
  //
  // The budget (25 uncached strings per render, src/lib/translate.ts
  // RequestBudget) refusing a string means the page knowingly rendered source
  // text for it. Such a page is still cached, but for one minute: long enough
  // to absorb a burst, short enough that the translations the NEXT render
  // schedules become visible within the minute, so the page converges
  // instead of sticking (2026-09-12 i18n review, D2).
  //
  // "Degraded" is ANY miss, not only budget exhaustion: a single edited FM
  // field renders as Swedish source on /en/ and schedules its translation —
  // with a full-tier cache that page would stay half-translated for up to
  // 24 h after the job completed seconds later (Codex review, 2026-09-12).
  const budget = (locals as { __i18nBudget?: { missCount?: number; refusedCount?: number } }).__i18nBudget;
  const misses = budget?.missCount ?? budget?.refusedCount ?? 0;
  const degraded = misses > 0;
  const effectiveTtl = degraded ? Math.min(ttl, 60) : ttl;

  // Browser gets a short lease (60s), the edge holds the tiered TTL, and the
  // production CDN may serve stale while it revalidates in the background.
  // Set on `res` BEFORE the two responses below are built from it — they
  // copy its headers at construction.
  res.headers.set(
    "Cache-Control",
    `public, max-age=60, s-maxage=${effectiveTtl}, stale-while-revalidate=${effectiveTtl}`,
  );
  res.headers.set("x-cache", "miss");
  res.headers.set("x-cache-ttl", String(effectiveTtl));
  if (degraded) res.headers.set("x-translation", `degraded; misses=${misses} refused=${budget?.refusedCount ?? 0}`);

  const forVisitor = new Response(body, res);
  const forCache = new Response(body, res);

  const store = cacheApi.put(cacheKey, forCache);
  // Never let the cache write block the visitor's response; fall back to
  // inline await if the execution context isn't exposed for some reason.
  const cfContext = (locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
  if (cfContext?.waitUntil) {
    cfContext.waitUntil(store.catch((err) => console.error("[edge-cache] put failed:", err)));
  } else {
    await store.catch((err) => console.error("[edge-cache] put failed:", err));
  }

  // Write the route bundle back only when this render resolved something the
  // preloaded bundle did not have (or had differently). The body is fully
  // buffered above, so the ledger is complete here. Off the visitor's path.
  if (bundleUsable && translationKv && ledger.size > 0) {
    const save = storeTranslationBundleIfChanged(translationKv, bundleKey, bundle, ledger).catch(
      (err) => console.error("[translate] bundle write failed:", err),
    );
    if (cfContext?.waitUntil) cfContext.waitUntil(save);
    else await save;
  }

  return harden(forVisitor);
}));
