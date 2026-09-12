import type { APIContext, APIRoute } from "astro";

/**
 * /en/llms.txt — dedicated route file, needed ONLY for the gh/static
 * target (docs/i18n-phase-2-brief.md Section 5 Build item: "llms.txt:
 * Swedish at /llms.txt, English at /en/llms.txt").
 *
 * WHY A DEDICATED FILE INSTEAD OF LETTING THE MIDDLEWARE HANDLE IT: on the
 * CF (server) target it doesn't — src/middleware.ts's locale rewrite has no
 * page/endpoint allowlist (only `/en/api/*` and `/en/en/*` are special-
 * cased) and rewrites ANY `/en/...` pathname by stripping the prefix and
 * calling `next(stripped)`. A request for `/en/llms.txt` is therefore
 * rewritten to `next("/llms.txt")`, which resolves to
 * ../llms.txt.ts — THIS file is never reached on cf, because the router
 * resolves the rewritten path before this route could ever match. See
 * ../llms.txt.ts's own doc comment for the full mechanism and why the
 * brief's option (a) — "route it through the middleware rewrite" — is the
 * one actually used there.
 *
 * But the middleware's rewrite is itself gated `if (HAS_RUNTIME)` (decision
 * 2: "/en/ is a CF-only feature" on the still-preview gh target — there is
 * no request-time rewrite mechanism at all under `output: "static"`, only
 * whatever route files physically exist get prerendered). Without a route
 * file at this exact path, `/en/llms.txt` simply would not exist in the gh
 * build's output — not a 404 Astro generates on purpose, just a URL nobody
 * ever wrote a page for.
 *
 * WHY THIS 404s ON THE GH TARGET RATHER THAN RENDERING CONTENT: decision 2
 * is unambiguous that `/en/` does not exist there at all — no `/en/records`,
 * no `/en/anything`. A static `/en/llms.txt` that DID render real content
 * would be the one `/en/...` URL on the whole gh preview that works, which
 * is a worse inconsistency than a clean 404: it would look like partial,
 * half-shipped i18n support on a target that isn't supposed to have any,
 * and (being static) it could only ever serve whatever Swedish→English
 * chrome happened to be in KV at build time with no live request to
 * refresh it. src/pages/robots.txt.ts's own noindex default means nothing
 * is meant to crawl this target's URLs yet regardless, so the 404 costs
 * nothing real today and keeps the gh target's actual behavior (no /en/)
 * matching its documented behavior exactly.
 *
 * `PUBLIC_HAS_RUNTIME` is the existing project-wide flag for this exact
 * branch (see CLAUDE.md, astro.config.mjs, and every other cf-only-feature
 * guard in this codebase — ContactForm.astro, YouTubeFeed.astro,
 * src/middleware.ts's own HAS_RUNTIME). Read defensively (string OR
 * boolean compare) for the same reason those do: consistency, not because
 * this file is bundled through the test harness's esbuild stub the way
 * middleware.ts is.
 */
/**
 * Pure-in-its-`hasRuntime`-argument core, factored out of `GET` so it's
 * testable without touching `import.meta.env` — which is `undefined` under
 * plain `node:test` (no Vite involved) and throws on property access rather
 * than reading as falsy, the same reason src/pages/api/publish.ts's
 * `handlePublish` takes its config as an explicit argument instead of
 * reading bindings off a global. `GET` below is the only caller that reads
 * the real env flag; everything else (the 404 guard, the delegation to
 * `renderLlmsTxt`) lives here and is what test/robots-llms.test.mjs
 * exercises directly.
 *
 * `renderLlmsTxt` is imported DYNAMICALLY, inside the `hasRuntime` branch,
 * rather than statically at the top of this file — deliberately, and for a
 * reason specific to this file rather than a general style preference: a
 * static `import { renderLlmsTxt } from "../llms.txt.ts"` pulls in that
 * file's whole value-import graph (src/lib/ninetone.ts ->
 * src/lib/filemaker.ts -> src/lib/fm-image-mirror.ts) as soon as THIS
 * module is evaluated, even for a request that's about to 404 without ever
 * needing FM data. That graph reads several `import.meta.env.*` vars at
 * module top level (e.g. FM_IMAGE_PROXY_BASE), which Vite bakes at build
 * time on both real targets but which is simply `undefined` under plain
 * `node:test` (no bundler involved) — so a top-level static import here
 * would make importing THIS file for a unit test throw before any test body
 * even runs, purely because of an unrelated module's env reads three hops
 * away. src/lib/translate.ts already has exactly this precedent
 * (`bookingCategoryTags()` dynamically imports `./ninetone.ts` for the same
 * reason: avoid dragging the FM chain into every module that merely CAN
 * reach it). Deferring the import here means test/robots-llms.test.mjs can
 * import this file and exercise the 404 guard (`hasRuntime: false`) without
 * ever loading FM code at all — which is also the only branch a unit test
 * can meaningfully exercise, since `renderLlmsTxt` does live FM reads.
 */
export async function handleEnLlmsTxt(context: APIContext, hasRuntime: boolean): Promise<Response> {
  if (!hasRuntime) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  // Reachable in practice only if something bypasses the middleware rewrite
  // (e.g. a future test that calls this route directly) — real cf traffic
  // never gets here (see doc comment above). Force "en" explicitly rather
  // than reading locals.lang: a direct hit on THIS path, if it ever
  // happened outside the rewrite, unambiguously means English by the URL
  // alone.
  const { renderLlmsTxt } = await import("../llms.txt.ts");
  return renderLlmsTxt(context, "en");
}

export const GET: APIRoute = async (context) => {
  const hasRuntime =
    import.meta.env.PUBLIC_HAS_RUNTIME === true || import.meta.env.PUBLIC_HAS_RUNTIME === "true";
  return handleEnLlmsTxt(context, hasRuntime);
};
