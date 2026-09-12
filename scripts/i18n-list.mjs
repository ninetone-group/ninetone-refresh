#!/usr/bin/env node
/**
 * Chrome-string review table for i18n Phase 2 (docs/i18n-phase-2-brief.md,
 * decision 5 / section 4's "ALSO DELIVER" item).
 *
 * WHAT THIS IS FOR: every `t("...")` call site in src/**\/*.astro is a
 * chrome string that gets machine-translated and cached by
 * src/lib/translate.ts. Patrik needs to review the Swedish voice AND the
 * machine English before either ships silently. This script finds every
 * such literal, computes the SAME cache key translate.ts itself would use
 * (via its own `translationKey()` — see "WHY IT REUSES translate.ts'S OWN
 * HASHER" below), and prints whatever sv/en override already exists for it
 * in src/i18n/overrides.json, so the whole review surface is one table
 * instead of a source-tree grep.
 *
 * WHY IT REUSES translate.ts'S OWN HASHER (not a hand-rolled sha256 here):
 * `src/i18n/overrides.json` is keyed by `sha256(source string)`
 * (translate.ts's `lookupOverride`), and the live KV cache is keyed by
 * `tr:{TRANSLATION_KEY_VERSION}:{target}:{tier}:{sha256(source)}`
 * (translate.ts's `translationKey()`). If this script computed its own
 * hash — even a byte-identical sha256 implementation — it would still be a
 * SECOND, independently-maintained copy of a key format that only
 * translate.ts should own; the day that format changes (a new
 * TRANSLATION_KEY_VERSION, a different hash algorithm) this script would
 * silently print keys that no longer match anything live, and nobody would
 * notice until an override written against this script's output failed to
 * take effect. Importing `translationKey` directly (same convention
 * scripts/translate-warm.mjs's Implementation-note-A obligation establishes
 * for the warm script) makes that class of drift structurally impossible.
 *
 * WHAT THIS SCRIPT CANNOT SEE (documented per the brief's own "must be
 * honest about what it can't see" instruction — read this before trusting
 * the table as exhaustive):
 *
 *   1. Template literals: `t(`Hello ${name}`)` is not a scannable source
 *      string (and in practice this codebase never calls t() with
 *      interpolation — every chrome string is deliberately a static
 *      literal, since an interpolated string can never be a stable
 *      override/cache key across different `name` values). If one appears,
 *      it is skipped and reported in the "skipped (non-literal)" section
 *      at the end of the run rather than silently dropped.
 *   2. `t(someVariable)` — a string resolved elsewhere and passed by
 *      reference (e.g. `t(item.label)` inside a .map()). The regex below
 *      only matches a literal string argument; a variable argument is
 *      invisible to a source-grep by construction. These are also
 *      collected into "skipped (non-literal)" with their file:line so a
 *      human can go look.
 *   3. Strings translated by calling `translate()` directly instead of
 *      through `t()` (FM prose — bios, releases, news; decision 3's "fast"
 *      tier). Out of scope for this script on purpose: decision 5 and this
 *      script are about "UI chrome" specifically, and FM content has its
 *      own review path (decision 9's warm script + Patrik reviewing actual
 *      FM records, not a source-code grep).
 *   4. Anything not spelled exactly `t(` — e.g. a local alias
 *      (`const translate = t; translate("x")`) would not match. No call
 *      site in this codebase does this as of this script's authoring; if
 *      one appears later, this regex needs a matching update, which is
 *      exactly why this file documents its own blind spots instead of
 *      quietly claiming completeness.
 *
 * This is deliberately "a simple, documented regex over src/**\/*.astro"
 * (brief's own words) — NOT a real parser (no Acorn/Babel/Astro-compiler
 * dependency). A false negative here (a string this script misses) is
 * recoverable: it just means that string machine-translates without a
 * pre-existing override the first time it renders, exactly like any other
 * chrome string would. A parser would close the gaps above at the cost of
 * a new dependency and real maintenance weight for a review tool — not
 * worth it at this codebase's actual chrome-string volume.
 *
 * USAGE
 *   node scripts/i18n-list.mjs                # print the table
 *   node scripts/i18n-list.mjs --json          # machine-readable dump instead
 *
 * HOW PATRIK WRITES AN OVERRIDE (translate.ts's own contract, restated here
 * for one-stop reference): open src/i18n/overrides.json, add or edit an
 * entry keyed by the "sha256(source)" column this script prints — NOT the
 * full tr:v1:... cache key, just the bare hash — with the sv/en text you
 * want to ship:
 *
 *   {
 *     "997d5f35d561f920438924e3a1afe5d2fdc6f558ef9e55f06691a43fe675a2e9": {
 *       "sv": "Kontakta oss",
 *       "en": "Get in touch"
 *     }
 *   }
 *
 * An override always wins over the machine translation (translate.ts's
 * `lookupOverride`, checked before the KV cache) and takes effect on the
 * NEXT render that calls t() with that exact source string — no rebuild,
 * no cache bust, no redeploy needed on the CF target. Committing the file
 * is what makes the edit durable and reviewable in git, per decision 5.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

import { translationKey, TRANSLATION_KEY_VERSION } from "../src/lib/translate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OVERRIDES_PATH = path.join(ROOT, "src/i18n/overrides.json");
const TIER = "quality"; // t() (translate.ts's createT()) always calls translate() at tier "quality" — see its own doc comment.

/**
 * Matches `t("...")` / `t('...')` with a plain, non-interpolated string
 * literal as the sole argument — including the multi-line form this
 * codebase's own conversions use for long strings:
 *
 *   const x = await t(
 *     "A long chrome string that wraps across lines for readability",
 *   );
 *
 * Deliberately does NOT match `t(\`...\`)` (template literal — see blind
 * spot #1 above) or `t(someIdentifier)` (blind spot #2) — those fall
 * through to the second, broader "any t(...) call" pass below, which is
 * used only to detect and report what this regex missed, never to extract
 * a string from them.
 */
const T_CALL_LITERAL_RE = /\bt\(\s*\n?\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*,?\s*\n?\s*\)/gs;

/** Any `t(...)` call at all, literal or not — used only to compute the "skipped" set (blind spots 1/2 above) by diffing against what T_CALL_LITERAL_RE matched. */
const T_CALL_ANY_RE = /\bt\(\s*([^)]*?)\s*\)/gs;

/**
 * Strips `//` line comments and `/* … *\/` block comments before either
 * regex above ever sees the text. Without this, the WHY-comments this very
 * conversion pass writes throughout the codebase — which routinely say
 * things like "call it through t() before handing it down" in plain
 * English — get matched by T_CALL_ANY_RE as if they were real call sites,
 * polluting the "skipped (non-literal)" report with prose fragments that
 * were never a translation gap. A real parser would sidestep this for
 * free; a comment-stripping pre-pass is the "simple, documented regex"
 * equivalent the brief asks for. Deliberately NOT comment-aware inside
 * string literals (e.g. a chrome string that itself contains "//") — no
 * current source string does, and over-engineering this pre-pass for a
 * case that doesn't exist in the codebase today isn't worth it.
 */
function stripComments(text) {
  // Blank out comment bodies to spaces (preserving embedded newlines) rather
  // than deleting them outright — deleting would shift every later offset,
  // which lineNumberAt() computes against the ORIGINAL file text; blanking
  // keeps every match index/line number correct while still making comment
  // text invisible to the t(...) regexes.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Scan one file's text for t("...") literal call sites plus a best-effort
 * list of t(...) calls this scan could NOT resolve to a literal (for the
 * "skipped" report — see the file-level doc comment's blind spots 1/2).
 */
function scanFile(relPath, text) {
  // Scan the comment-blanked text (same length/offsets as `text`, see
  // stripComments()'s doc comment) so a WHY-comment that happens to mention
  // "t()" in plain English is never mistaken for a real call site. `text`
  // itself (not the blanked copy) is what raw.replace() below pulls the
  // actual string content from — irrelevant here since comments can't
  // contain a real t(...) call, but keeping the distinction explicit avoids
  // ever accidentally extracting a blanked (space-filled) "string".
  const scanText = stripComments(text);

  const found = [];
  const literalSpans = [];

  for (const m of scanText.matchAll(T_CALL_LITERAL_RE)) {
    const raw = m[2];
    // Unescape the two escapes this codebase's own strings actually use
    // (\" and \\) — good enough for a review tool; anything fancier is out
    // of scope for "simple, documented regex" per the brief.
    const source = raw.replace(/\\(["'\\])/g, "$1");
    found.push({ file: relPath, line: lineNumberAt(text, m.index), source });
    literalSpans.push([m.index, m.index + m[0].length]);
  }

  const skipped = [];
  for (const m of scanText.matchAll(T_CALL_ANY_RE)) {
    const isCoveredByLiteralMatch = literalSpans.some(([start, end]) => m.index >= start && m.index < end);
    if (isCoveredByLiteralMatch) continue;
    // Guard against a stray blanked comment fragment matching T_CALL_ANY_RE's
    // loose `t(...)` shape (e.g. a blanked-out line leaving "t(" adjacent to
    // unrelated code) — snippet is pulled from the ORIGINAL text at the same
    // offset so a real hit still reads as real source, but an all-whitespace
    // "capture" (only possible if the match itself sits entirely inside a
    // blanked span, which literalSpans doesn't cover since it only tracks
    // LITERAL t() calls) is dropped as noise rather than reported.
    if (/^\s*$/.test(m[1] ?? "")) continue;
    skipped.push({ file: relPath, line: lineNumberAt(text, m.index), snippet: text.slice(m.index, m.index + m[0].length).replace(/\s+/g, " ").trim() });
  }

  return { found, skipped };
}

async function loadOverrides() {
  try {
    const raw = await readFile(OVERRIDES_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const jsonOutput = process.argv.includes("--json");

  const files = globSync("src/**/*.astro", { cwd: ROOT }).sort();

  const allFound = [];
  const allSkipped = [];
  for (const rel of files) {
    const text = await readFile(path.join(ROOT, rel), "utf8");
    const { found, skipped } = scanFile(rel, text);
    allFound.push(...found);
    allSkipped.push(...skipped);
  }

  // De-duplicate by source string — the SAME chrome string legitimately
  // appears at many call sites (e.g. "View profile" on multiple BentoTiles
  // across the homepage). One row per distinct string is what Patrik
  // actually needs to review; the file:line list is kept per-row so the
  // "where does this appear" question is still answerable.
  const bySource = new Map();
  for (const entry of allFound) {
    const existing = bySource.get(entry.source);
    if (existing) {
      existing.locations.push(`${entry.file}:${entry.line}`);
    } else {
      bySource.set(entry.source, { source: entry.source, locations: [`${entry.file}:${entry.line}`] });
    }
  }

  const overrides = await loadOverrides();

  const rows = [];
  for (const { source, locations } of bySource.values()) {
    // translationKey() hashes the source once internally; called twice here
    // (sv target, en target) because the KV cache key — unlike the
    // override key — is PER TARGET LANGUAGE (translate.ts's `keyFromHash`),
    // so the "what's the live cache key for this string's English
    // translation" question has a different answer than the Swedish one
    // even though both read the same override entry.
    const keySv = await translationKey(source, "sv", TIER);
    const keyEn = await translationKey(source, "en", TIER);
    // The override file is keyed by the bare sha256(source) — the part of
    // keySv/keyEn AFTER the last ":" (see translate.ts's keyFromHash: `tr:
    // {version}:{target}:{tier}:{hash}`) — not by the full cache key, so
    // pull it back out here rather than hashing a third time.
    const hash = keySv.split(":").pop();
    const override = overrides[hash] ?? null;

    rows.push({
      hash,
      source,
      overrideSv: override?.sv ?? null,
      overrideEn: override?.en ?? null,
      locations,
    });
  }

  rows.sort((a, b) => a.source.localeCompare(b.source, "sv"));

  if (jsonOutput) {
    process.stdout.write(
      JSON.stringify(
        { keyVersion: TRANSLATION_KEY_VERSION, tier: TIER, count: rows.length, rows, skipped: allSkipped },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  // Human-readable table. Kept to plain fixed-width columns (no external
  // table-formatting dependency) — this is a review artifact pasted into a
  // PR description or read in a terminal, not a UI.
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  console.log(`i18n chrome strings — ${rows.length} distinct source strings found across ${files.length} .astro files`);
  console.log(`(cache key version: ${TRANSLATION_KEY_VERSION}, tier: ${TIER})\n`);

  const HASH_W = 12;
  const SRC_W = 48;
  const OV_W = 30;
  console.log(
    "sha256".padEnd(HASH_W) + " | " + "source".padEnd(SRC_W) + " | " + "override sv".padEnd(OV_W) + " | " + "override en".padEnd(OV_W),
  );
  console.log("-".repeat(HASH_W) + "-+-" + "-".repeat(SRC_W) + "-+-" + "-".repeat(OV_W) + "-+-" + "-".repeat(OV_W));
  for (const row of rows) {
    console.log(
      truncate(row.hash, HASH_W).padEnd(HASH_W) +
        " | " +
        truncate(row.source, SRC_W).padEnd(SRC_W) +
        " | " +
        truncate(row.overrideSv ?? "(none — machine translated)", OV_W).padEnd(OV_W) +
        " | " +
        truncate(row.overrideEn ?? "(none — machine translated)", OV_W).padEnd(OV_W),
    );
  }

  const withOverride = rows.filter((r) => r.overrideSv || r.overrideEn).length;
  console.log(`\n${withOverride} of ${rows.length} strings have a human override today.`);

  if (allSkipped.length > 0) {
    console.log(
      `\n${allSkipped.length} t(...) call site(s) could NOT be read as a plain string literal ` +
        `(template literal or variable argument — see this script's file-level doc comment, blind spots 1/2). ` +
        `These are not translation gaps — t() still runs fine on them at request time — they are just invisible ` +
        `to THIS review table:`,
    );
    for (const s of allSkipped) {
      console.log(`  ${s.file}:${s.line}  ${truncate(s.snippet, 70)}`);
    }
  }

  console.log(
    `\nTo add or edit an override: edit src/i18n/overrides.json, keyed by the "sha256" column above ` +
      `(the bare hash, not the full tr:${TRANSLATION_KEY_VERSION}:... cache key), e.g.:\n` +
      `  { "<sha256 from the table>": { "sv": "...", "en": "..." } }\n` +
      `An override always wins over the machine translation and takes effect on the next render — no rebuild needed.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
