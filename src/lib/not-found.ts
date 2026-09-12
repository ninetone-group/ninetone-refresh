/**
 * Serve the 404 page body with a real 404 status from inside a detail
 * route's frontmatter, on a failed lookup.
 *
 * Why not just `return Astro.rewrite("/404")`: Astro's rewrite handler
 * (astro/dist/core/rewrites/handler.js, applyRewriteToState) unconditionally
 * sets `state.status = 200` whenever a rewrite is applied — the 404 page
 * itself never calls `Astro.response.status = 404`, so the rewritten
 * response always comes back as a 200 carrying the 404 page's HTML. That
 * is Cause A of docs/seo-phase-1b-brief.md P0 item 1: every missing-entity
 * URL served the "not found" copy with a success status, so it stayed
 * indexable and stayed in the sitemap.
 *
 * `Astro.rewrite()` also re-invokes the whole middleware chain (including
 * src/middleware.ts's edge cache) a second, nested time to render the /404
 * target before returning. That inner pass used to run the full
 * cache-read/clone/store cycle against the same response stream the outer
 * page was about to read again — a ReadableStream can only be consumed
 * once, so the outer read sometimes raced an already-drained stream and
 * came back empty (Cause B of the same item — a genuine bug in
 * src/middleware.ts, not in any FM query; see src/lib/cache-policy.ts's
 * `/404` bypass entry, which is the actual fix for that half). This helper
 * only needs to handle Cause A: it takes the Response the (now
 * cache-bypassed) rewrite produced and re-wraps it with the honest status.
 */
export async function notFound(astroRewrite: () => Promise<Response>): Promise<Response> {
  const rewritten = await astroRewrite();
  return new Response(rewritten.body, {
    status: 404,
    statusText: "Not Found",
    headers: rewritten.headers,
  });
}
