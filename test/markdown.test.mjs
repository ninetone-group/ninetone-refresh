import assert from "node:assert/strict";
import test from "node:test";

import { renderBio } from "../src/lib/markdown.ts";

test("renderBio: a markdown H1 in FM prose is demoted to H2, never emits <h1>", () => {
  const html = renderBio("# Emma Blyfors\n\nSome bio text.");
  assert.ok(!html.includes("<h1"), `expected no <h1>, got: ${html}`);
  assert.ok(html.includes("<h2>Emma Blyfors</h2>"));
});

test("renderBio: h2 and below are left exactly as the editor wrote them", () => {
  // Only h1 is rewritten. An earlier version shifted every level down one,
  // which broke long-form articles (/news/[slug], /guider/[slug] also use
  // renderBio): an editor's "## Section" became h3, so those pages jumped
  // h1 -> h3 with no h2. Clamping keeps a competing h1 impossible without
  // touching correct hierarchy.
  const html = renderBio("## Section\n\n### Subsection\n\n#### Detail");
  assert.ok(html.includes("<h2>Section</h2>"), html);
  assert.ok(html.includes("<h3>Subsection</h3>"), html);
  assert.ok(html.includes("<h4>Detail</h4>"), html);
});

test("renderBio: h6 stays h6 and no invalid tag is ever emitted", () => {
  const html = renderBio("###### Deepest heading");
  assert.ok(html.includes("<h6>Deepest heading</h6>"));
  assert.ok(!/<h[7-9]/.test(html));
});

test("renderBio: heading text still runs through inline markdown (links, bold)", () => {
  const html = renderBio("## **Bold** heading with [a link](https://example.com)");
  assert.ok(html.includes("<strong>Bold</strong>"));
  assert.ok(html.includes('<a href="https://example.com">a link</a>'));
});
