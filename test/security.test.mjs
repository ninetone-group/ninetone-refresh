import assert from "node:assert/strict";
import test from "node:test";

import { renderBio } from "../src/lib/markdown.ts";
import { externalUrl } from "../src/lib/url.ts";
import { edgeCacheKey, shouldBypassCache } from "../src/lib/cache-policy.ts";

test("FileMaker markdown cannot emit raw HTML or scriptable links", () => {
  const html = renderBio('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [obfuscated](java\tscript:alert(1))');
  assert.doesNotMatch(html, /<img\b|href="javascript:/i);
  assert.match(html, /&lt;img/);
  assert.match(renderBio("[safe](https://example.com/path)"), /href="https:\/\/example\.com\/path"/);
});

test("FileMaker markdown cannot emit protocol-relative cross-origin links", () => {
  const link = renderBio("[x](//evil.com/phish)");
  assert.doesNotMatch(link, /<a\b/i);
  assert.match(link, />x</);
  const image = renderBio("![x](//evil.com/a.png)");
  assert.doesNotMatch(image, /<img\b/i);
  assert.match(renderBio("[records](/records)"), /href="\/records"/);
});

test("CMS external links allow only HTTP(S)", () => {
  assert.equal(externalUrl("javascript:alert(1)"), null);
  assert.equal(externalUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(externalUrl("https://example.com/a"), "https://example.com/a");
});

test("shared cache bypasses request variants that may be private or attacker-controlled", () => {
  assert.equal(shouldBypassCache(new Request("https://ninetone.com/a", { headers: { cookie: "_ga=GA1.1.1" } }), "/a", ""), false);
  assert.equal(shouldBypassCache(new Request("https://ninetone.com/a", { headers: { authorization: "Bearer x" } }), "/a", ""), true);
  assert.equal(shouldBypassCache(new Request("https://ninetone.com/a?q=x"), "/a", "?q=x"), true);
  assert.equal(shouldBypassCache(new Request("https://ninetone.com/a?utm_source=x&fbclid=y"), "/a", "?utm_source=x&fbclid=y"), false);
  assert.equal(shouldBypassCache(new Request("https://ninetone.com/api/publish"), "/api/publish", ""), true);
  assert.equal(shouldBypassCache(new Request("https://ninetone.com/news"), "/news", ""), false);
});

test("the 404 route bypasses the shared cache — see docs/seo-phase-1b-brief.md P0 item 1", () => {
  // Astro.rewrite("/404") re-invokes this entire middleware a second, nested
  // time for the rewritten pathname. Without this bypass, that inner pass's
  // own cache read/clone/store cycle raced the outer pass reading the same
  // response stream, which is what produced the intermittent zero-byte 404
  // bodies (Cause B in the brief). This must stay true regardless of query
  // string or trailing slash.
  assert.equal(shouldBypassCache(new Request("https://ninetone.com/404"), "/404", ""), true);
  assert.equal(shouldBypassCache(new Request("https://ninetone.com/404/"), "/404/", ""), true);
  assert.equal(shouldBypassCache(new Request("https://ninetone.com/404?x=1"), "/404", "?x=1"), true);
});

test("edge cache keys separate request origins", () => {
  assert.notEqual(
    edgeCacheKey("https://ninetone.com", "/news", "v1", "build"),
    edgeCacheKey("https://attacker.example", "/news", "v1", "build"),
  );
});
