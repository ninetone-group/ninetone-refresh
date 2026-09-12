#!/usr/bin/env node
/**
 * Post-build static audit for dist/.
 *
 * Pure Node, no TS, no FM round-trips. Catches the problems we can see in the
 * built output:
 *
 *   - FM streaming URLs leaked into HTML/JSON/JS/CSS (these expire and break
 *     within ~15 min — must be rewritten to the proxy)
 *   - Empty <img src=""> tags
 *   - Pages with empty <title>
 *   - Pages with empty <h1> (heuristic — a few legitimate template pages
 *     might trip this; surface for review, don't fail the build)
 *   - Pages with zero or more than one <h1> — every page must have exactly
 *     one. Fails the build (a regression here is an SEO/a11y bug, not a
 *     stylistic nit).
 *
 * Writes dist/_audit.json (machine-readable) and prints a human summary.
 * FM URL leaks and wrong-h1-count fail the build. Other findings remain
 * advisory so a legitimate template exception does not block deployment.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIST = path.resolve(process.argv[2] || "dist");
const FM_LEAK_RE = /https?:\/\/files\.ninetone\.com\/Streaming_SSL\/[^\s"'<>]+/g;
const EMPTY_IMG_RE = /<img[^>]*\bsrc=""[^>]*>/g;
const TITLE_RE = /<title>([^<]*)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const H1_ALL_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").trim();
}

async function main() {
  const files = await walk(DIST);
  const issues = [];
  let htmlCount = 0;

  for (const file of files) {
    const rel = path.relative(DIST, file);
    if (/\.(html|json|js|css)$/i.test(file)) {
      const content = await readFile(file, "utf8");
      const leaks = content.match(FM_LEAK_RE);
      if (leaks) {
        for (const url of [...new Set(leaks)]) {
          issues.push({ kind: "fm-url-leak", file: rel, detail: "redacted FM streaming URL" });
        }
      }
    }
    if (/\.html$/i.test(file)) {
      htmlCount++;
      const content = await readFile(file, "utf8");

      const emptyImgs = content.match(EMPTY_IMG_RE);
      if (emptyImgs) {
        issues.push({ kind: "empty-img-src", file: rel, detail: `${emptyImgs.length}×` });
      }

      const title = content.match(TITLE_RE)?.[1]?.trim();
      if (!title) {
        issues.push({ kind: "empty-title", file: rel });
      }

      const h1 = content.match(H1_RE)?.[1];
      if (h1 != null && !stripTags(h1)) {
        issues.push({ kind: "empty-h1", file: rel });
      }

      // Astro emits a tiny <meta http-equiv="refresh"> shim for each entry in
      // astro.config.mjs's `redirects` on the static target (GH Pages has no
      // server-side redirects). Those are not pages and correctly have no
      // <h1> — exempt them rather than weakening the check for real pages.
      //
      // Matched on SHAPE, not on the string appearing anywhere in the file: an
      // earlier content-only test (`/http-equiv=["']refresh["']/`) failed OPEN,
      // because FM bio or guide markdown that merely mentions that attribute
      // reaches the page through set:html and would have silently exempted a
      // real 0-<h1> page from a build-failing check. A genuine shim is tiny,
      // has the meta in <head>, and has no <main>.
      // (Astro's shim omits the literal <head> tag, so key on size + absence of
      // page chrome instead: a real page always has a <main>.)
      const isRedirectShim =
        content.length < 2048 &&
        !/<main[\s>]/i.test(content) &&
        /<meta[^>]+http-equiv=["']refresh["']/i.test(content);
      const h1Matches = isRedirectShim ? [] : [...content.matchAll(H1_ALL_RE)];
      if (isRedirectShim) {
        // Intentionally headless — skip.
      } else if (h1Matches.length === 0) {
        issues.push({ kind: "wrong-h1-count", file: rel, detail: "0 <h1>" });
      } else if (h1Matches.length > 1) {
        const texts = h1Matches.map((m) => stripTags(m[1])).join(" | ");
        issues.push({ kind: "wrong-h1-count", file: rel, detail: `${h1Matches.length} <h1>: ${texts}` });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    distDir: DIST,
    htmlPages: htmlCount,
    issues,
  };

  await writeFile(path.join(DIST, "_audit.json"), JSON.stringify(report, null, 2));

  // Human summary
  const byKind = new Map();
  for (const i of issues) {
    const arr = byKind.get(i.kind) ?? [];
    arr.push(i);
    byKind.set(i.kind, arr);
  }
  const lines = [`Audit: scanned ${htmlCount} HTML pages`];
  if (byKind.size === 0) {
    lines.push("  ✓ No issues found");
  } else {
    for (const [kind, list] of [...byKind.entries()].sort()) {
      lines.push(`  ${kind}: ${list.length}`);
      for (const i of list.slice(0, 3)) {
        const detail = i.detail ? ` — ${i.detail}` : "";
        lines.push(`    · ${i.file}${detail}`);
      }
      if (list.length > 3) lines.push(`    … +${list.length - 3} more (see dist/_audit.json)`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
  if (byKind.has("fm-url-leak") || byKind.has("wrong-h1-count")) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`Audit failed: ${err}\n`);
  process.exit(1);
});
