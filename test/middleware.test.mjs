import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import * as esbuild from "esbuild";
import { translate, translationKey } from "../src/lib/translate.ts";

const middlewareModule = await loadMiddleware();

async function loadMiddleware() {
  const result = await esbuild.build({
    entryPoints: ["src/middleware.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    // The middleware gates its redirects on the cf target (see HAS_RUNTIME
    // there); without this define the trailing-slash and legacy-redirect
    // tests would silently assert against dead code.
    define: { "import.meta.env.PUBLIC_HAS_RUNTIME": "true" },
    write: false,
    plugins: [{
      name: "middleware-test-stubs",
      setup(build) {
        build.onResolve({ filter: /^astro:middleware$/ }, () => ({ path: "astro", namespace: "stub" }));
        build.onResolve({ filter: /^\.\/lib\/cf$/ }, () => ({ path: "cf", namespace: "stub" }));
        // Keep translate.ts OUT of the bundle and import it from its real
        // file URL instead, so this test file and the middleware share ONE
        // module instance — the per-request translation ledger lives in that
        // module's AsyncLocalStorage, and a bundled copy would be a second,
        // invisible ledger.
        build.onResolve({ filter: /^\.\/lib\/translate$/ }, () => ({
          path: new URL("../src/lib/translate.ts", import.meta.url).href,
          external: true,
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: args.path === "astro"
            ? "export const defineMiddleware = (fn) => fn;"
            : "export const getCfEnv = () => globalThis.__middlewareTestEnv;",
          loader: "js",
        }));
      },
    }],
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

function createRuntime({ hit, env = { CACHE_STATE: { get: async () => "7" } } } = {}) {
  const matched = [];
  const stored = [];
  const waits = [];
  globalThis.__middlewareTestEnv = Promise.resolve(env);
  globalThis.caches = {
    default: {
      match: async (key) => {
        matched.push(key.url);
        return hit;
      },
      put: async (key, response) => { stored.push({ key: key.url, response }); },
    },
  };
  return { matched, stored, waits };
}

async function run(request, next, runtime) {
  const context = {
    request,
    url: new URL(request.url),
    locals: { cfContext: { waitUntil: (promise) => runtime.waits.push(promise) } },
  };
  const response = await middlewareModule.onRequest(context, next);
  await Promise.all(runtime.waits);
  return response;
}

test("caches a public miss with scoped cache key and security headers", async () => {
  const runtime = createRuntime();
  let nextCalls = 0;
  const response = await run(
    new Request("https://www.ninetone.com/news"),
    async () => { nextCalls++; return new Response("news"); },
    runtime,
  );

  assert.equal(nextCalls, 1);
  assert.equal(runtime.matched.length, 1);
  assert.match(runtime.matched[0], /ohttps%3A%2F%2Fwww\.ninetone\.com\/news$/);
  assert.equal(runtime.stored.length, 1);
  assert.equal(response.headers.get("x-cache"), "miss");
  assert.equal(response.headers.get("x-cache-ttl"), "900");
  assert.match(response.headers.get("cache-control"), /s-maxage=900/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("serves a host-scoped cache hit without invoking the route", async () => {
  const runtime = createRuntime({ hit: new Response("cached", { headers: { "content-type": "text/plain" } }) });
  const response = await run(
    new Request("https://preview.ninetone.com/news"),
    async () => { throw new Error("next must not run on a hit"); },
    runtime,
  );

  assert.equal(await response.text(), "cached");
  assert.equal(response.headers.get("x-cache"), "hit");
  assert.match(runtime.matched[0], /ohttps%3A%2F%2Fpreview\.ninetone\.com\/news$/);
  assert.equal(runtime.stored.length, 0);
});

test("bypasses shared cache for private and variant requests", async () => {
  for (const request of [
    new Request("https://ninetone.com/news", { headers: { authorization: "Bearer token" } }),
    new Request("https://ninetone.com/news?page=2"),
  ]) {
    const runtime = createRuntime();
    const response = await run(request, async () => new Response("private"), runtime);
    assert.equal(runtime.matched.length, 0);
    assert.equal(runtime.stored.length, 0);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  }
});

test("analytics cookies do not defeat the shared cache", async () => {
  const runtime = createRuntime();
  const response = await run(
    new Request("https://ninetone.com/news", { headers: { cookie: "_ga=GA1.1.1; _fbp=fb.1.1" } }),
    async () => new Response("news"),
    runtime,
  );
  assert.equal(runtime.matched.length, 1);
  assert.equal(runtime.stored.length, 1);
  assert.equal(response.headers.get("x-cache"), "miss");
});

test("tracking query params hit the same cache key as the bare path", async () => {
  const runtimeBare = createRuntime();
  await run(new Request("https://ninetone.com/news"), async () => new Response("news"), runtimeBare);

  const runtimeTracked = createRuntime();
  await run(
    new Request("https://ninetone.com/news?utm_source=x&fbclid=y"),
    async () => new Response("news"),
    runtimeTracked,
  );

  assert.equal(runtimeTracked.matched.length, 1);
  assert.equal(runtimeTracked.stored.length, 1);
  assert.equal(runtimeTracked.matched[0], runtimeBare.matched[0]);
});

test("/404 is never cached — avoids the nested-rewrite stream race (seo-phase-1b P0 item 1)", async () => {
  // Every detail route's `Astro.rewrite("/404")` re-enters this exact
  // middleware for the rewritten pathname before the outer request finishes.
  // If that inner pass ran the normal read/clone/store cycle, it would tee
  // the same response stream the outer pass then reads again — a stream can
  // only be consumed once, so the outer read intermittently came back empty
  // (the "0 bytes" failures in the brief). This must never call cacheApi.put.
  const runtime = createRuntime();
  const response = await run(
    new Request("https://ninetone.com/404"),
    async () => new Response("<html>not found</html>", { status: 404 }),
    runtime,
  );
  assert.equal(runtime.matched.length, 0);
  assert.equal(runtime.stored.length, 0);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "<html>not found</html>");
});

test("never stores private, no-store, cookie-setting, or redirect responses", async () => {
  for (const response of [
    new Response("private", { headers: { "cache-control": "private, max-age=60" } }),
    new Response("secret", { headers: { "cache-control": "no-store" } }),
    new Response("signed in", { headers: { "set-cookie": "session=1" } }),
    Response.redirect("https://ninetone.com/news", 302),
  ]) {
    const runtime = createRuntime();
    const result = await run(new Request("https://ninetone.com/news"), async () => response, runtime);
    assert.equal(runtime.stored.length, 0);
    assert.equal(result.headers.get("x-cache"), "bypass");
    assert.equal(result.headers.get("strict-transport-security"), "max-age=31536000");
  }
});

test("redirects a trailing-slash path to the bare path before any cache lookup (seo-phase-1b P0 item 5)", async () => {
  const runtime = createRuntime();
  const response = await run(
    new Request("https://ninetone.com/records/"),
    async () => { throw new Error("next must not run — redirect happens before rendering"); },
    runtime,
  );

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "/records");
  assert.equal(runtime.matched.length, 0, "cacheApi.match must not be called for a redirect");
  assert.equal(runtime.stored.length, 0);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("preserves the query string on a trailing-slash redirect", async () => {
  const runtime = createRuntime();
  const response = await run(
    new Request("https://ninetone.com/records/?utm_source=x"),
    async () => { throw new Error("next must not run"); },
    runtime,
  );

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "/records?utm_source=x");
});

test("never redirects the root path", async () => {
  const runtime = createRuntime();
  let nextCalls = 0;
  const response = await run(
    new Request("https://ninetone.com/"),
    async () => { nextCalls++; return new Response("home"); },
    runtime,
  );

  assert.equal(nextCalls, 1);
  assert.notEqual(response.status, 301);
});

test("never redirects /api/* even with a trailing slash", async () => {
  const runtime = createRuntime();
  let nextCalls = 0;
  const response = await run(
    new Request("https://ninetone.com/api/contact/"),
    async () => { nextCalls++; return new Response("ok"); },
    runtime,
  );

  assert.equal(nextCalls, 1);
  assert.notEqual(response.status, 301);
});

// NOT UNIT-TESTED, deliberately: the streaming-clone race behind the zero-byte
// pages and the intermittent 500s (seo-phase-1b P0 items 1 & 3) cannot be
// reproduced under node:test. undici's clone() buffers eagerly and both the
// clone() and the buffered branch expose a ReadableStream, so every assertion
// available here passes identically with and without the fix — verified by
// reverting src/middleware.ts and re-running. A test that cannot fail is worse
// than none: it would advertise coverage this defect does not have.
//
// The real evidence is the captured runtime exception, reproduced live via
// `wrangler tail` on a deployed Worker (3/3 requests to a heavy detail page):
//   ResponseSentError: The response has already been sent to the browser and
//   cannot be altered.
//     at Object.write (chunks/console_*.mjs)
//     at BufferedRenderer.flush
//     at iterate
// logged as "[edge-cache] put failed:" — i.e. cacheApi.put()'s branch of
// res.clone() was still being written while the visitor's branch had already
// completed, which aborts the render and yields a zero-byte 200.
//
// The regression guard is therefore the post-deploy staging check recorded in
// docs/seo-phase-1b-pr.md: N parallel requests across the affected detail
// pages with zero empty bodies and zero exceptions in `wrangler tail`.

test("legacy /previous-artists deep links 301 to the real detail path (seo-phase-1b P0 item 2)", async () => {
  // Both shapes existed on the live site and survive as inbound links. The
  // destination must be extensionless — the Cloudflare adapter's generated
  // _redirects rules append "/index.html", which 404s on the SSR Worker, which
  // is why this lives in middleware rather than astro.config.mjs's `redirects`.
  for (const [from, to] of [
    ["/previous-artists/kuokka", "/records/artists/previous/single/kuokka"],
    ["/previous-artists/single/kuokka", "/records/artists/previous/single/kuokka"],
    ["/previous-artists/yohio", "/records/artists/previous/single/yohio"],
  ]) {
    const runtime = createRuntime();
    const res = await run(new Request(`https://ninetone.com${from}`), async () => new Response("unused"), runtime);
    assert.equal(res.status, 301, `${from} should 301`);
    assert.equal(res.headers.get("location"), to);
    assert.equal(runtime.matched.length, 0, "redirect must precede the cache read");
    assert.ok(!res.headers.get("location").endsWith("/index.html"), "destination must be extensionless");
  }
});

test("legacy previous-artist redirect preserves the query string and ignores non-matching paths", async () => {
  const runtime = createRuntime();
  const res = await run(
    new Request("https://ninetone.com/previous-artists/kuokka?utm_source=discogs"),
    async () => new Response("unused"),
    runtime,
  );
  assert.equal(res.headers.get("location"), "/records/artists/previous/single/kuokka?utm_source=discogs");

  // "/previous-artists/single" is a LISTING shape, not a slug. Left ungained it
  // would become /records/artists/previous/single/single — a redirect into a
  // 404, which is worse for crawlers than a plain 404. It goes to the real
  // listing instead. (public/_redirects carries the same guard as its first
  // rule, since the asset layer is what actually serves these on cf.)
  const listing = createRuntime();
  const listingRes = await run(
    new Request("https://ninetone.com/previous-artists/single"),
    async () => new Response("unused"),
    listing,
  );
  assert.equal(listingRes.status, 301);
  assert.equal(listingRes.headers.get("location"), "/records/artists/previous");

  // A path that is already canonical must pass straight through.
  const rt = createRuntime();
  const passed = await run(
    new Request("https://ninetone.com/records/artists/previous"),
    async () => new Response("rendered"),
    rt,
  );
  assert.notEqual(passed.status, 301, "canonical path must not be redirected");
});

// ---------------------------------------------------------------------------
// Locale detection + rewrite (docs/i18n-phase-2-brief.md decision 2).
//
// next(payload)'s REAL rewrite semantics (re-resolving the route manifest
// via Astro's tryRewrite) cannot be exercised under this esbuild-bundled
// harness: sequence.js's payload branch requires a `fetchStateSymbol` on the
// context that only Astro's own request pipeline attaches ("FetchState not
// found on APIContext" is thrown otherwise) — confirmed by hand against a
// real `astro dev` server (DEPLOY_TARGET=cf) rather than guessed: hitting
// /en/integritet against a temporary probe middleware returned the actual
// 117KB integritet page body with locals.lang carried through, and
// /en/this-route-does-not-exist 404'd via next(payload) exactly as a normal
// unmatched route would. What IS tested here, at this level, is the
// contract src/middleware.ts owns regardless of what next() does with it:
// which pathname string it hands to next(), what it sets locals.lang to,
// and — the correctness-critical part — that the cache key it builds stays
// distinct per locale. The stub `next` below stands in for Astro's real
// rewrite/render by simply recording what it was called with and returning
// a marker response, the same "next is a black box we assert the call
// arguments of" approach the redirect tests above already use.
// ---------------------------------------------------------------------------

test("/en/records rewrites to /records with locals.lang set to en", async () => {
  const runtime = createRuntime();
  const calls = [];
  const context = {
    request: new Request("https://ninetone.com/en/records"),
    url: new URL("https://ninetone.com/en/records"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async (payload) => {
    calls.push(payload);
    return new Response("records page");
  };
  const response = await middlewareModule.onRequest(context, next);
  await Promise.all(runtime.waits);

  assert.deepEqual(calls, ["/records"], "next() must be called with the stripped path");
  assert.equal(context.locals.lang, "en");
  assert.equal(await response.text(), "records page");
});

test("/records (no prefix) sets locals.lang to sv and does not rewrite", async () => {
  const runtime = createRuntime();
  const calls = [];
  const context = {
    request: new Request("https://ninetone.com/records"),
    url: new URL("https://ninetone.com/records"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async (payload) => {
    calls.push(payload);
    return new Response("records page");
  };
  await middlewareModule.onRequest(context, next);

  assert.deepEqual(calls, [undefined], "next() must be called with no rewrite payload for sv");
  assert.equal(context.locals.lang, "sv");
});

test("/en/ (trailing slash) 301s to the canonical /en before locale detection ever runs", async () => {
  // Trailing-slash canonicalization (existing behaviour, unchanged by this
  // section) runs BEFORE locale detection in src/middleware.ts, and
  // trailingSlashRedirectTarget() has no locale awareness — it just strips
  // the trailing slash off any non-exempt path. "/en/" therefore never
  // reaches the locale-rewrite logic at all; it 301s to "/en" first, and
  // the browser's follow-up request to the canonical "/en" is what actually
  // triggers the rewrite (covered by the next test). Asserting this here
  // pins the ordering so a future change can't accidentally make "/en/"
  // rewrite directly and skip canonicalization.
  const runtime = createRuntime();
  let nextCalled = false;
  const context = {
    request: new Request("https://ninetone.com/en/"),
    url: new URL("https://ninetone.com/en/"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async () => { nextCalled = true; return new Response("must not run"); };
  const response = await middlewareModule.onRequest(context, next);

  assert.equal(nextCalled, false, "next() must not run — the trailing-slash redirect wins first");
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "/en");
});

test("/en (canonical, no trailing slash) rewrites to / with lang en", async () => {
  const runtime = createRuntime();
  const calls = [];
  const context = {
    request: new Request("https://ninetone.com/en"),
    url: new URL("https://ninetone.com/en"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async (payload) => {
    calls.push(payload);
    return new Response("home page");
  };
  await middlewareModule.onRequest(context, next);

  assert.deepEqual(calls, ["/"], "next() must rewrite /en to the bare root");
  assert.equal(context.locals.lang, "en");
});

test("/en/api/contact is a 404, not a rewrite — real API routes live at /api/* only", async () => {
  const runtime = createRuntime();
  let nextCalled = false;
  const context = {
    request: new Request("https://ninetone.com/en/api/contact", { method: "POST" }),
    url: new URL("https://ninetone.com/en/api/contact"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async () => { nextCalled = true; return new Response("must not run"); };
  const response = await middlewareModule.onRequest(context, next);

  assert.equal(nextCalled, false, "next() must never be called for /en/api/*");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-frame-options"), "DENY", "the 404 still goes through harden()");
});

test("/en/api (no trailing segment) is also a 404, not a rewrite", async () => {
  const runtime = createRuntime();
  let nextCalled = false;
  const context = {
    request: new Request("https://ninetone.com/en/api"),
    url: new URL("https://ninetone.com/en/api"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async () => { nextCalled = true; return new Response("must not run"); };
  const response = await middlewareModule.onRequest(context, next);

  assert.equal(nextCalled, false);
  assert.equal(response.status, 404);
});

test("a path merely starting with 'en' (not a real /en segment) is not treated as English", async () => {
  const runtime = createRuntime();
  const calls = [];
  const context = {
    request: new Request("https://ninetone.com/enterprise"),
    url: new URL("https://ninetone.com/enterprise"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async (payload) => { calls.push(payload); return new Response("enterprise page"); };
  await middlewareModule.onRequest(context, next);

  assert.deepEqual(calls, [undefined], "/enterprise must not be rewritten as if it were /en/terprise");
  assert.equal(context.locals.lang, "sv");
});

test("nested Astro.rewrite('/404') does not stomp an outer en locale back to sv", async () => {
  // Astro.rewrite("/404") (src/lib/not-found.ts) re-invokes this entire
  // middleware a second, nested time with url.pathname already rewritten to
  // the bare "/404" — and Astro's FetchState.locals is ONE shared object
  // across outer and inner passes (astro/dist/core/fetch/fetch-state.js),
  // never recreated by the rewrite machinery. If the inner pass re-derived
  // lang from "/404" (no /en prefix -> "sv") and unconditionally wrote it,
  // it would overwrite the outer pass's correct "en" while the visitor's
  // request was still /en/records/artists/some-bad-slug. Simulated here by
  // calling onRequest twice against the SAME locals object, exactly as the
  // shared FetchState does.
  const runtime = createRuntime();
  const locals = { cfContext: { waitUntil: (p) => runtime.waits.push(p) } };

  const outerContext = {
    request: new Request("https://ninetone.com/en/records/artists/does-not-exist"),
    url: new URL("https://ninetone.com/en/records/artists/does-not-exist"),
    locals,
  };
  const outerNext = async () => {
    // The detail route's lookup fails and it calls Astro.rewrite("/404"),
    // which re-enters this middleware for "/404" against the SAME locals.
    const innerContext = {
      request: new Request("https://ninetone.com/404"),
      url: new URL("https://ninetone.com/404"),
      locals,
    };
    const innerNext = async () => new Response("<html>404</html>", { status: 404 });
    return middlewareModule.onRequest(innerContext, innerNext);
  };

  const response = await middlewareModule.onRequest(outerContext, outerNext);
  await Promise.all(runtime.waits);

  assert.equal(locals.lang, "en", "the outer pass's en locale must survive the nested /404 rewrite");
  assert.equal(response.status, 404);
});

test("cache keys are locale-distinct: /en/records and /records do not collide (would FAIL without the fix)", async () => {
  // This is the critical correctness item from the brief: if the cache key
  // were built from the REWRITTEN pathname (both requests resolve to
  // "/records" once /en is stripped), the two locales would collide onto
  // one shared cache slot and visitors would randomly get served the wrong
  // language for up to the route's full TTL. The cache key must be built
  // from the pathname AS RECEIVED (still carrying /en when present).
  const runtimeSv = createRuntime();
  await run(
    new Request("https://ninetone.com/records"),
    async () => new Response("swedish records page"),
    runtimeSv,
  );

  const runtimeEn = createRuntime();
  await run(
    new Request("https://ninetone.com/en/records"),
    async (payload) => new Response(`rewritten to ${payload}`),
    runtimeEn,
  );

  assert.equal(runtimeSv.matched.length, 1);
  assert.equal(runtimeEn.matched.length, 1);
  assert.notEqual(
    runtimeSv.matched[0],
    runtimeEn.matched[0],
    "sv and en cache-lookup keys must differ for the same underlying route",
  );
  // Both must actually have been stored too — i.e. this isn't just a lookup
  // artifact, each locale gets its own cache entry on a miss.
  assert.equal(runtimeSv.stored.length, 1);
  assert.equal(runtimeEn.stored.length, 1);
  assert.notEqual(runtimeSv.stored[0].key, runtimeEn.stored[0].key);
});

test("the en cache key still carries the correct TTL tier despite the /en prefix", async () => {
  // ttlFor's table is written for the semantic (locale-free) route. This
  // guards the OTHER failure mode of using the raw pathname everywhere: if
  // ttlFor were also given the raw "/en/records" pathname, none of
  // TTL_RULES' patterns match a leading "/en" segment and it would silently
  // fall through to DEFAULT_TTL (3600s) instead of the 21600s section-landing
  // tier — same content, different (wrong) freshness contract for English
  // visitors only.
  const runtime = createRuntime();
  const response = await run(
    new Request("https://ninetone.com/en/records"),
    async (payload) => new Response(`rewritten to ${payload}`),
    runtime,
  );
  assert.equal(response.headers.get("x-cache-ttl"), "21600");
});

// --- i18n Phase 2, section-2 review fixes -----------------------------------
// Three defects caught in review, each reproduced before being fixed. Every
// test below fails if its fix is reverted (mutation-verified).

test("/en/admin/* keeps the SKIP-list cache bypass — a locale prefix must not defeat it", async () => {
  // cache-policy's SKIP patterns are anchored (/^\/admin(\/|$)/), so passing
  // the RAW "/en/admin/publish" made shouldBypassCache return false and the
  // Publish console was stored at the edge for an hour. The bypass is a
  // semantic-route question, so it takes the STRIPPED path.
  const runtime = createRuntime();
  const context = {
    request: new Request("https://ninetone.com/en/admin/publish"),
    url: new URL("https://ninetone.com/en/admin/publish"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async () => new Response("<html>publish console</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  const response = await middlewareModule.onRequest(context, next);

  assert.equal(runtime.matched.length, 0, "an /admin route must never be looked up in the edge cache");
  assert.equal(runtime.stored.length, 0, "an /admin route must never be STORED in the edge cache");
  assert.equal(response.headers.get("x-cache"), null, "bypassed responses carry no x-cache annotation");
});

test("/en/404 keeps the SKIP-list cache bypass, same as bare /404", async () => {
  const runtime = createRuntime();
  const context = {
    request: new Request("https://ninetone.com/en/404"),
    url: new URL("https://ninetone.com/en/404"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async () => new Response("<html>not found</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  await middlewareModule.onRequest(context, next);

  assert.equal(runtime.stored.length, 0, "/404 is deliberately never edge-cached — see cache-policy.ts");
});

test("/en/en/* is a deliberate 404, not a single-level strip into a route miss", async () => {
  // A second "/en" is a real path segment, not another locale prefix.
  // Stripping one level rewrote to "/en/records" (not a route) and
  // route-missed into a 404 that was then CACHED — one entry per member of
  // the infinite /en/en/en/... family.
  const runtime = createRuntime();
  let nextCalled = false;
  const context = {
    request: new Request("https://ninetone.com/en/en/records"),
    url: new URL("https://ninetone.com/en/en/records"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const next = async () => { nextCalled = true; return new Response("must not run"); };
  const response = await middlewareModule.onRequest(context, next);

  assert.equal(nextCalled, false, "next() must never be called for /en/en/*");
  assert.equal(response.status, 404);
  assert.equal(runtime.stored.length, 0, "the /en/en/... family must not mint cache entries");
});

test("legacy previous-artist deep links keep the visitor's locale across the 301", async () => {
  // "/en/previous-artists/kuokka" used to miss the anchored legacy pattern
  // entirely, fall through to the rewrite, and route-miss into a hard 404 —
  // while the Swedish visitor following the same Discogs link got a working
  // 301. Now the lookup runs on the stripped path and the locale is
  // re-applied to the destination.
  const runtime = createRuntime();
  const context = {
    request: new Request("https://ninetone.com/en/previous-artists/kuokka"),
    url: new URL("https://ninetone.com/en/previous-artists/kuokka"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const response = await middlewareModule.onRequest(context, async () => new Response("must not render"));

  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("Location"),
    "/en/records/artists/previous/single/kuokka",
    "an English visitor must land on the English detail page, not the Swedish one",
  );
});

test("the Swedish legacy redirect is unchanged by the locale-aware lookup", async () => {
  const runtime = createRuntime();
  const context = {
    request: new Request("https://ninetone.com/previous-artists/kuokka"),
    url: new URL("https://ninetone.com/previous-artists/kuokka"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const response = await middlewareModule.onRequest(context, async () => new Response("must not render"));

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("Location"), "/records/artists/previous/single/kuokka");
});

// ---------------------------------------------------------------------------
// 2026-09-12 review fixes
// ---------------------------------------------------------------------------

test("Swedish-only pages have no /en/ URL: /en/integritet 301s to /integritet, query kept", async () => {
  const runtime = createRuntime();
  let nextCalled = false;
  const response = await run(
    new Request("https://ninetone.com/en/integritet?x=1"),
    async () => { nextCalled = true; return new Response("must not render"); },
    runtime,
  );
  assert.equal(nextCalled, false);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("Location"), "/integritet?x=1");
  assert.equal(runtime.stored.length, 0, "a redirect must not mint a cache entry");
});

test("Swedish-only guides redirect too; bilingual routes still rewrite", async () => {
  const runtime = createRuntime();
  const guide = await run(
    new Request("https://ninetone.com/en/guider/hur-man-bokar"),
    async () => new Response("must not render"),
    runtime,
  );
  assert.equal(guide.status, 301);
  assert.equal(guide.headers.get("Location"), "/guider/hur-man-bokar");

  let target;
  const records = await run(
    new Request("https://ninetone.com/en/records"),
    async (t) => { target = t; return new Response("records"); },
    createRuntime(),
  );
  assert.equal(records.status, 200);
  assert.equal(target, "/records");
});

test("SSR HTML carries X-Robots-Tag while the preview is gated", async () => {
  const response = await run(
    new Request("https://ninetone.com/news"),
    async () => new Response("news"),
    createRuntime(),
  );
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive, nosnippet, noimageindex");
});

test("a render whose translation budget refused strings is cached for 60s, not the tier TTL", async () => {
  const runtime = createRuntime();
  const context = {
    request: new Request("https://ninetone.com/en/team"),
    url: new URL("https://ninetone.com/en/team"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const response = await middlewareModule.onRequest(context, async () => {
    context.locals.__i18nBudget = { refusedCount: 7 };
    return new Response("half-translated");
  });
  await Promise.all(runtime.waits);
  assert.equal(response.headers.get("x-cache"), "miss");
  assert.equal(response.headers.get("x-cache-ttl"), "60", "team tier is 86400; a degraded render must not pin that long");
  assert.match(response.headers.get("Cache-Control"), /s-maxage=60,/);
  assert.equal(response.headers.get("x-translation"), "degraded; misses=7 refused=7");
  assert.equal(runtime.stored.length, 1, "still cached — briefly — to absorb a burst");
});

test("budget exhausted by COMPONENTS (after headers, during body streaming) still degrades the TTL", async () => {
  // Astro streams: render() returns after the page frontmatter, and Header/
  // Footer/cards run while the body is consumed. Their refusals must count.
  const runtime = createRuntime();
  const context = {
    request: new Request("https://ninetone.com/en/team"),
    url: new URL("https://ninetone.com/en/team"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const response = await middlewareModule.onRequest(context, async () => {
    context.locals.__i18nBudget = { refusedCount: 0 }; // frontmatter: nothing refused yet
    const stream = new ReadableStream({
      pull(controller) {
        // "Component render" happening during body consumption.
        context.locals.__i18nBudget.refusedCount = 7;
        controller.enqueue(new TextEncoder().encode("<html>half-translated</html>"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/html" } });
  });
  await Promise.all(runtime.waits);
  assert.equal(response.headers.get("x-cache-ttl"), "60");
  assert.equal(response.headers.get("x-translation"), "degraded; misses=7 refused=7");
  assert.match(response.headers.get("Cache-Control"), /s-maxage=60,/);
  assert.equal(runtime.stored[0].response.headers.get("x-cache-ttl"), "60", "the cached copy carries the same short TTL");
  assert.equal(await response.text(), "<html>half-translated</html>");
});

test("a complete render keeps the tier TTL and no degraded marker", async () => {
  const runtime = createRuntime();
  const context = {
    request: new Request("https://ninetone.com/team"),
    url: new URL("https://ninetone.com/team"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const response = await middlewareModule.onRequest(context, async () => {
    context.locals.__i18nBudget = { refusedCount: 0 };
    return new Response("complete");
  });
  assert.equal(response.headers.get("x-cache-ttl"), "86400");
  assert.equal(response.headers.get("x-translation"), null);
});

test("route bundle: read before render, every resolved translation written back after", async () => {
  const key = await translationKey("Nyheter", "en", "quality");
  const reads = [];
  const puts = [];
  const store = new Map([[key, "News"]]);
  const kv = {
    get: async (k) => { reads.push(k); return typeof k === "string" && store.has(k) ? store.get(k) : null; },
    put: async (k, v, o) => { puts.push([k, v, o]); store.set(k, v); },
  };
  const runtime = createRuntime({ env: { CACHE_STATE: kv } });
  const context = {
    request: new Request("https://ninetone.com/en/news"),
    url: new URL("https://ninetone.com/en/news"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const response = await middlewareModule.onRequest(context, async () => {
    // What sharedT()/fmText() do: resolve through the request's ledger.
    const r = await translate({ text: "Nyheter", target: "en", tier: "quality", kv, ledger: context.locals.__i18nLedger });
    return new Response(r.text);
  });
  await Promise.all(runtime.waits);
  assert.equal(await response.text(), "News");
  assert.ok(reads.includes("trb:v1:en:/news"), "the route bundle is read on a page-cache miss");
  assert.ok(reads.indexOf("trb:v1:en:/news") < reads.indexOf(key), "…before the render's own reads");
  const bundlePut = puts.find(([k]) => k === "trb:v1:en:/news");
  assert.ok(bundlePut, "the ledger is written back as the route's bundle");
  assert.deepEqual(JSON.parse(bundlePut[1]), { [key]: "News" });
  assert.equal(bundlePut[2].expirationTtl, 21600);
});

test("route bundle: a preloaded bundle seeds the render and is not rewritten when unchanged", async () => {
  const key = await translationKey("Artister", "en", "quality");
  const reads = [];
  const puts = [];
  const store = new Map([["trb:v1:en:/records/artists", JSON.stringify({ [key]: "Artists (bundled)" })]]);
  const kv = {
    get: async (k) => { reads.push(k); return typeof k === "string" && store.has(k) ? store.get(k) : null; },
    put: async (k, v, o) => { puts.push([k, v, o]); },
  };
  const runtime = createRuntime({ env: { CACHE_STATE: kv } });
  const context = {
    request: new Request("https://ninetone.com/en/records/artists"),
    url: new URL("https://ninetone.com/en/records/artists"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const response = await middlewareModule.onRequest(context, async () => {
    const r = await translate({ text: "Artister", target: "en", tier: "quality", kv, ledger: context.locals.__i18nLedger });
    return new Response(r.text);
  });
  await Promise.all(runtime.waits);
  assert.equal(await response.text(), "Artists (bundled)");
  assert.ok(!reads.includes(key), "the seeded key is never read from KV");
  assert.equal(puts.length, 0, "identical ledger → no bundle write");
});

test("route bundle: a cache HIT reads no bundle at all", async () => {
  const reads = [];
  const kv = { get: async (k) => { reads.push(k); return null; }, put: async () => {} };
  const runtime = createRuntime({ hit: new Response("cached"), env: { CACHE_STATE: kv } });
  await run(new Request("https://ninetone.com/news"), async () => new Response("x"), runtime);
  assert.ok(!reads.some((k) => String(k).startsWith("trb:")), "no bundle read on a hit");
});

// ---------------------------------------------------------------------------
// 2026-09-12 adversarial review
// ---------------------------------------------------------------------------

test("a protocol-relative path can never become a protocol-relative Location (open redirect)", async () => {
  for (const path of ["//evil.com/", "//evil.com", "/en//evil.com/integritet/", "///evil.com/x/"]) {
    const runtime = createRuntime();
    let nextCalled = false;
    const response = await run(
      new Request(`https://ninetone.com${path}?k=1`),
      async () => { nextCalled = true; return new Response("must not render"); },
      runtime,
    );
    assert.equal(nextCalled, false, `${path} must be answered before rendering`);
    assert.equal(response.status, 301);
    const location = response.headers.get("Location");
    assert.ok(location.startsWith("/") && !location.startsWith("//"), `${path} → ${location} must be a same-origin path`);
    assert.ok(location.endsWith("?k=1"), "query preserved");
  }
});

test("a doubled slash cannot slip a private route past the SKIP list", async () => {
  const runtime = createRuntime();
  const response = await run(
    new Request("https://ninetone.com//admin/publish"),
    async () => new Response("must not render"),
    runtime,
  );
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("Location"), "/admin/publish");
  assert.equal(runtime.stored.length, 0, "nothing cached for the doubled-slash form");
});

test("guides share the legal-copy cache tier", async () => {
  const response = await run(new Request("https://ninetone.com/guider/hur-man-bokar"), async () => new Response("g"), createRuntime());
  assert.equal(response.headers.get("x-cache-ttl"), "86400");
});

test("an over-long path never reaches KV as a bundle key", async () => {
  const reads = [];
  const kv = { get: async (k) => { reads.push(k); return null; }, put: async () => {} };
  const long = "/" + "a".repeat(600);
  const response = await run(new Request(`https://ninetone.com${long}`), async () => new Response("x"), createRuntime({ env: { CACHE_STATE: kv } }));
  assert.equal(response.status, 200);
  assert.ok(!reads.some((k) => String(k).startsWith("trb:")), "no bundle read for a 600-char path");
  assert.ok(reads.every((k) => String(k).length <= 512), "no KV key over the 512-byte limit");
});

test("ONE untranslated string (a miss, no refusal) is enough to shorten the TTL", async () => {
  const runtime = createRuntime();
  const context = {
    request: new Request("https://ninetone.com/en/team"),
    url: new URL("https://ninetone.com/en/team"),
    locals: { cfContext: { waitUntil: (p) => runtime.waits.push(p) } },
  };
  const response = await middlewareModule.onRequest(context, async () => {
    // What an edited FM bio produces: scheduled, not refused.
    context.locals.__i18nBudget = { missCount: 1, refusedCount: 0 };
    return new Response("<html>one Swedish bio on /en</html>");
  });
  await Promise.all(runtime.waits);
  assert.equal(response.headers.get("x-cache-ttl"), "60");
  assert.equal(response.headers.get("x-translation"), "degraded; misses=1 refused=0");
});
