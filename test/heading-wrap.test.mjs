/**
 * Long Swedish compounds must never overflow a heading column (2026-09-13:
 * "Toppmusikproduktion & Artistvarumärkesbyggande" ran into the paragraph
 * next to it on /records). The rule lives in the base heading layer of
 * global.css so every FM-fed headline gets it; pin it at the source, the
 * same way test/critical-path.test.mjs pins Base.astro.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("base heading rule hyphenates and breaks over-long words", () => {
  const css = readFileSync(path.join(ROOT, "src/styles/global.css"), "utf8");
  const base = css.match(/h1, h2, h3, h4, h5, h6 \{([^}]*)\}/);
  assert.ok(base, "base heading rule not found");
  assert.match(base[1], /hyphens:\s*auto/);
  assert.match(base[1], /overflow-wrap:\s*break-word/);
});

test("Base.astro sets <html lang> so `hyphens: auto` has a dictionary to use", () => {
  const base = readFileSync(path.join(ROOT, "src/layouts/Base.astro"), "utf8");
  assert.match(base, /<html[^>]*\slang=/);
});
