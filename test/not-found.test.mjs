import assert from "node:assert/strict";
import test from "node:test";

import { notFound } from "../src/lib/not-found.ts";

// docs/seo-phase-1b-brief.md P0 item 1, Cause A: Astro.rewrite("/404")
// unconditionally sets the response status back to 200 internally
// (astro/dist/core/rewrites/handler.js, applyRewriteToState), because the
// 404 page itself never sets Astro.response.status. Every detail route on a
// failed lookup returned the 404 page's HTML with a 200 — indexable, and
// never dropping out of the sitemap. notFound() re-wraps whatever Response
// the rewrite produced with a real 404 status, which is the actual fix.

test("notFound() serves the rewritten body with a real 404 status", async () => {
  const rewritten = new Response("<html>not found</html>", {
    status: 200, // simulates Astro.rewrite("/404")'s forced 200
    headers: { "content-type": "text/html" },
  });
  const result = await notFound(async () => rewritten);
  assert.equal(result.status, 404);
  assert.equal(await result.text(), "<html>not found</html>");
  assert.equal(result.headers.get("content-type"), "text/html");
});

test("notFound() overrides any status the rewrite target happened to carry", async () => {
  const rewritten = new Response("body", { status: 200 });
  const result = await notFound(async () => rewritten);
  assert.equal(result.status, 404);
});

test("notFound() preserves an empty body rather than throwing", async () => {
  const rewritten = new Response(null, { status: 200 });
  const result = await notFound(async () => rewritten);
  assert.equal(result.status, 404);
  assert.equal(await result.text(), "");
});
