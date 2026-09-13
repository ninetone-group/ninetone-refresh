/**
 * Browser critical path (perf deep dive, 2026-09-13).
 *
 * A throttled trace (Fast 3G, warm edge cache) showed the felt load time
 * after TTFB was fonts and blocking CSS, not images: two Newsreader preloads
 * (280 KB) started at High priority alongside the 12 KB of render-blocking
 * CSS and finished 2 s after first paint, and the artist-of-the-week tile
 * carried fetchpriority="high" while sitting ~3,000 px below the fold. Both
 * are source-level decisions, so these tests pin them at the source, the
 * same way test/no-redirect-in-components.test.mjs scans components.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("Base.astro preloads exactly one font: the Newsreader roman face (the h1 / LCP element)", () => {
  const base = read("src/layouts/Base.astro");
  const preloads = base.match(/<link[^>]*rel="preload"[^>]*as="font"[^>]*>/g) ?? [];
  assert.equal(preloads.length, 1, `expected one font preload, got:\n${preloads.join("\n")}`);
  assert.match(preloads[0], /newsreader-roman\.woff2/);
  assert.doesNotMatch(base, /rel="preload"[^>]*newsreader-italic/, "the italic face must not be preloaded");
});

test("index.astro passes `priority` to no BentoTile — nothing on the homepage is an above-the-fold image", () => {
  const index = read("src/pages/index.astro");
  // A prop on its own line inside a component tag, as Astro formats it.
  assert.doesNotMatch(index, /^\s+priority\s*$/m, "a BentoTile on the homepage still passes `priority`");
  assert.doesNotMatch(index, /priority=\{/, "a BentoTile on the homepage still passes `priority`");
});
