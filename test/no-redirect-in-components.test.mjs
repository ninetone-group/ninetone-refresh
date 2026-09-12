import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

// docs/seo-phase-1b-brief.md P0 item 3 root cause: six .astro components
// (StreamingRow, MerchSection, WebPostsSection, EditorialNewsBlock,
// LatestNewsSection, Pagination) used `return Astro.redirect("")` in their
// frontmatter as a "render nothing" trick when there was no content to show.
//
// That pattern only works safely in a top-level PAGE's frontmatter, before
// the response has started streaming — Astro.redirect() there returns a
// Response, and Astro uses it to short-circuit the whole route.
//
// Called from a CHILD COMPONENT instead, Astro.redirect() still returns a
// Response object. By the time that component renders, the parent page has
// already started streaming HTML (head tags, earlier sections, etc.), so
// Astro's BufferedRenderer tries to write that Response as if it were an
// HTML chunk — which throws `ResponseSentError` at flush
// (astro/dist/runtime/server/render/…, "chunk instanceof Response" guard)
// and leaves the visitor with an empty body / 500.
//
// Verified live: every FM artist record with zero populated social-link
// fields (twelve entities on staging, incl. `galia_mashchenko`, `styrelsen`,
// `yohio`) hit this in StreamingRow on every single request — 100%
// reproducible via `wrangler dev` + the local observability query API,
// which showed all FM/Shopify/YouTube fetches completing successfully
// before the ResponseSentError killed the render.
//
// This can't be reproduced as an Astro-rendering unit test: `npm test` runs
// under plain `node --experimental-strip-types --test`, which has no loader
// for `.astro` files (they require Astro's Vite-based toolchain) — trying to
// import one directly throws ERR_UNKNOWN_FILE_EXTENSION. So this test
// verifies the fix at the only level available to node:test: static source
// inspection. It will fail if this exact anti-pattern is reintroduced in any
// component, in this file or a new one.

const componentsDir = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../src/components",
);

function astroFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return astroFiles(full);
      return entry.name.endsWith(".astro") ? [full] : [];
    });
}

// Strip `//` line comments before matching so this test's own explanatory
// comments (which quote the offending pattern on purpose, as documentation)
// don't trip the check.
function stripLineComments(code) {
  return code
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("no src/components/*.astro calls Astro.redirect() from its frontmatter", () => {
  const offenders = [];
  for (const file of astroFiles(componentsDir)) {
    const source = fs.readFileSync(file, "utf8");
    const frontmatter = stripLineComments(source.split("---")[1] ?? "");
    if (/Astro\.redirect\s*\(/.test(frontmatter)) {
      offenders.push(path.relative(componentsDir, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Astro.redirect() in a child component's frontmatter returns a Response ` +
      `that crashes the parent page's stream once it has already started ` +
      `flushing (ResponseSentError). Use a template-level boolean guard ` +
      `("{hasContent && (...)}") instead. Offending files: ${offenders.join(", ")}`,
  );
});
