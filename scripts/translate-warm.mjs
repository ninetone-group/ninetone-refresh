#!/usr/bin/env node
/**
 * Pre-warm the translation KV cache for i18n Phase 2 (docs/i18n-phase-2-brief.md,
 * decision 9, extended by Implementation notes A, C, D, E — SECTION 7, the
 * final build section for this brief). Read those notes before touching
 * this file; they are binding, not advisory.
 *
 * WHAT THIS DOES, IN ORDER:
 *   1. Walks every FM entity via src/lib/ninetone.ts and collects every
 *      field the site actually renders for it (the sitemap/llms.txt field
 *      lists, PLUS release pitch/social copy and WebPosts section intros —
 *      decision 9's "reuse the field list ... plus release pitch/social
 *      text and WebPosts").
 *   2. Discovers chrome strings by READING a JSONL capture file produced by
 *      a build run with I18N_CAPTURE_CHROME_STRINGS=1 (note D) — never by
 *      parsing source. This script does NOT run the build itself (the task
 *      brief explicitly forbids that from this script — "Do NOT run builds
 *      (the orchestrator does)"); it expects the capture file to already
 *      exist, and tells you exactly how to produce it if it doesn't.
 *   3. For every (source, target, tier) triple from both passes, computes
 *      translate.ts's own `translationKey()` and skips anything already in
 *      KV (idempotent — decision 9).
 *   4. Translates the rest through translate.ts's own `callWithGuard()` +
 *      `buildSystemPrompt()` + `buildProtectedTerms()` (note A — this
 *      script is FORBIDDEN from re-implementing the API call, the prompt,
 *      the protected-terms block, the output guard, or truncation
 *      handling), under bounded concurrency.
 *   5. Writes the results to a `wrangler kv bulk put` JSON file and shells
 *      out to wrangler, keyed exactly as translationKey() produces — see
 *      "KEY-MATCH VERIFICATION" below for how this is checked BEFORE any
 *      network call is made, not just asserted in a comment.
 *   6. Prints real token counts (from the API response's `usage` block —
 *      never estimated) and cost, per tier and total.
 *
 * WHY THIS SCRIPT NEVER TOUCHES `translate()` ITSELF (only `callWithGuard`
 * et al.): `translate()` is the request-time, cache-first, budget-gated,
 * waitUntil-scheduled entry point — decision 9 is explicit that the warm
 * script "writes KV directly rather than going through translate()'s
 * scheduling path". Going through `translate()` here would mean either
 * faking a KV binding + budget + scheduler (pointless ceremony) or, worse,
 * silently inheriting the per-request 25-call budget, which would make a
 * multi-hundred-field warm run impossible without lying to that budget
 * about what a "render" is. `callWithGuard()` is the documented seam
 * (note A) that composes everything translate() would ALSO have done to
 * produce the model output, without the request-time scaffolding around it.
 *
 * ============================================================================
 * KEY-MATCH VERIFICATION (task brief: "THIS IS THE CRITICAL CORRECTNESS
 * PROPERTY... Verify it — e.g. round-trip one key through both paths and
 * assert equality before writing anything.")
 * ============================================================================
 *
 * This script imports `translationKey` directly from src/lib/translate.ts —
 * the SAME function a live request-time cache miss calls (translate.ts's
 * own `translate()` -> `keyFromHash()`, which is the non-exported sibling
 * `translationKey()` wraps around one already-computed hash). There is
 * only ONE key-computation code path in this codebase; this script does not
 * define a second one. That alone would make key drift structurally
 * impossible (same argument scripts/i18n-list.mjs's own doc comment makes
 * for why IT also imports translationKey() rather than hand-rolling a
 * hasher) — but "imports the same function" is a static argument, and the
 * brief specifically asks for a RUNTIME check, not just a design argument.
 *
 * `verifyKeyRoundTrip()` below runs before a single API call or KV write:
 * it calls `translationKey()` directly (the warm script's own call site)
 * AND separately re-derives the exact key a live request-time cache miss
 * would look up by walking translate.ts's own documented key format
 * (`tr:{TRANSLATION_KEY_VERSION}:{target}:{tier}:{sha256(source)}`) using
 * ONLY primitives translate.ts itself exports (`TRANSLATION_KEY_VERSION`)
 * plus Web Crypto (the same `crypto.subtle.digest` primitive translate.ts's
 * own internal `sha256Hex` uses, available in Node 22 with no import). If
 * those two ever disagree, this script refuses to run — see the assertion
 * at the bottom of `verifyKeyRoundTrip()`. This catches the exact failure
 * mode the brief warns about: a `TRANSLATION_KEY_VERSION` bump, a key-format
 * change, or an import that silently resolved to a stale build of
 * translate.ts, all of which would otherwise make the warm cache "dead
 * weight and nothing will ever notice."
 *
 * ============================================================================
 * TIER ASSIGNMENT (task brief item 1 — "decide and document which are the
 * voice pages")
 * ============================================================================
 *
 * decision 3 splits tiers by CONTENT TYPE ("fast = bios, releases, news,
 * blurbs; quality = chrome, landing/category copy, guides, contact copy,
 * meta descriptions"), and decision 9 separately says "quality tier for the
 * ~12 voice pages." Both are honored by tiering PER FIELD, not per entity —
 * an artist page is NOT wholly "fast" or wholly "quality"; its bio is fast,
 * but the section-level intro paragraph its list page reuses is a landing
 * page's voice copy and gets quality. Concretely, QUALITY tier applies to:
 *
 *   - Chrome strings (all of them — note C: "warm them on the quality tier
 *     — these are the voice lines Patrik reviews").
 *   - The ~12 voice pages, i.e. every FM field that is EDITORIAL/LANDING
 *     copy rather than one-record-per-entity prose:
 *       1. Records division intro   — API_ARTIST::readMore (records list page)
 *       2. Management division intro — API_Management::readMoreClients
 *       3. Nation division intro     — API_Booking::readMoreBooking
 *       4-9. The six API_BOOKING_TAG category descriptions (breadBooking) —
 *            "Artist", "Föreläsare", "Konferencier", "Moderator",
 *            "Underhållare", "Influencer" — each is its own landing-page
 *            voice paragraph at /ninetone-nation/kategori/{tag}.
 *       10. Ninetone Group WebPosts section intro/blocks (company landing)
 *       11. Guider (guides) WebPosts blocks — decision 3 explicitly lists
 *           "guides" as quality tier, and every guide IS its own landing
 *           page (src/pages/guider/[slug].astro).
 *       12. Contact copy — the three contact pages' WebPosts blocks
 *           (Records/Management/Nation "Ninetone Blog"-adjacent contact
 *           sections) — decision 3 explicitly lists "contact copy."
 *     That is exactly 12 distinct voice surfaces, matching decision 9's
 *     count — see VOICE_FIELDS below for the literal list this script
 *     tiers as quality, with each entry commented to this enumeration.
 *
 *   FAST tier applies to everything decision 3 names for it, verbatim:
 *   bios (artist/previous-artist/client/booking-talent presentation
 *   strings), releases (pitch/social copy), news (WebPosts "Ninetone Blog"
 *   entries + API_NEWS records), and team member descriptions (a per-person
 *   blurb, the same shape as a bio — not landing copy).
 *
 * Meta descriptions are derived at RENDER time from tagline+bio
 * (`descriptionWithBioFallback()`, src/lib/schema.ts) rather than being a
 * distinct FM field — there is no separate "meta description" string to
 * warm; the underlying tagline/bio fields are already covered above at
 * their own tier.
 *
 * ============================================================================
 * CONCURRENCY (task brief: "Pick a sane limit and explain it")
 * ============================================================================
 *
 * DEFAULT_CONCURRENCY = 4. Reasoning: Anthropic's default per-org rate
 * limits for Haiku/Sonnet at typical usage tiers comfortably exceed 4
 * concurrent short-prompt requests (this workload is one FM field per call,
 * a few hundred to a couple thousand characters — nothing like a long-context
 * job), so 4 is not fighting the API's own ceiling; it exists to keep this
 * SCRIPT well-behaved as a caller — bounded enough that translate.ts's own
 * 429/529 retry-with-backoff (callAnthropic, MAX_RETRIES=1, doubling from
 * 500ms) stays the exception rather than the steady state, and low enough
 * that a mistake here (a bug that fans out unboundedly) cannot itself
 * become a self-inflicted rate-limit storm. Configurable via
 * `--concurrency=N` for a one-off tune, but 4 is the number this script
 * ships with and recommends.
 *
 * ============================================================================
 * COST GUARD (task brief: "must never be able to run up an unbounded bill
 * by accident")
 * ============================================================================
 *
 * THREE independent guards, not one:
 *   1. DRY-RUN IS THE DEFAULT. Per the brief's own suggestion ("Make this
 *      the safe default if that seems right to you — argue your choice"):
 *      yes. A script that writes real money to a real API is exactly the
 *      shape of command that should require an explicit, positive
 *      confirmation to actually run — the same posture this codebase
 *      already takes with `careful`-guarded destructive git commands. A
 *      developer running `node scripts/translate-warm.mjs` with no flags
 *      (the natural first thing to try) gets a full cost estimate and
 *      writes NOTHING — there is no way to accidentally spend money by
 *      under-reading this script's flags.
 *   2. `--max-calls=N` HARD CEILING (default 2000, which comfortably covers
 *      this site's actual corpus per the dry-run count below, with
 *      headroom — see the printed dry-run summary for the real number).
 *      The script counts exactly how many (source, target, tier) jobs it
 *      is about to run BEFORE calling the API even once; if that count
 *      exceeds `--max-calls`, it refuses to run at all (not "runs the
 *      first N and stops silently" — a partial run that silently drops
 *      the tail is its own kind of surprise). This is what makes "run up
 *      an UNBOUNDED bill by accident" specifically impossible: even with
 *      `--live` and no dry-run, spend is capped by a number the operator
 *      chose, not by however large the FM dataset happens to grow to.
 *   3. EXPLICIT `--live` FLAG required to leave dry-run mode at all — a
 *      typo'd or missing flag fails toward "printed a report, spent
 *      nothing" rather than toward "translated the whole site."
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *   node --env-file=.env scripts/translate-warm.mjs                  # dry run (default)
 *   node --env-file=.env scripts/translate-warm.mjs --live            # actually translate + write KV
 *   node --env-file=.env scripts/translate-warm.mjs --live --max-calls=500
 *   node --env-file=.env scripts/translate-warm.mjs --concurrency=2 --live
 *   node --env-file=.env scripts/translate-warm.mjs --chrome-only --live
 *   node --env-file=.env scripts/translate-warm.mjs --entities-only --live
 *
 * Chrome discovery (note D) — run once before a --live warm that should
 * include chrome:
 *   rm -f i18n-chrome-capture.jsonl
 *   I18N_CAPTURE_CHROME_STRINGS=1 npm run build
 *   node --env-file=.env scripts/translate-warm.mjs --live
 * If i18n-chrome-capture.jsonl is missing, this script still warms entity
 * content and prints an explicit warning that chrome was skipped, rather
 * than silently proceeding as if chrome didn't exist.
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { register } from "node:module";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// PLAIN-NODE COMPAT SHIM FOR src/lib/*.ts — read this before touching it.
//
// This script needs src/lib/ninetone.ts's real FM helpers, not just its
// types (unlike src/lib/sitemap.ts, which only `import type`s from it).
// src/lib/ninetone.ts was written exclusively for Astro/Vite's bundler-mode
// resolver, which tolerates two things plain Node ESM does not, and fixing
// either upstream is out of this task's touch-scope (SECTION 7's brief:
// touch ONLY scripts/translate-warm.mjs, src/lib/t.ts's capture hook, and a
// test file — src/lib/ninetone.ts and src/lib/fm-image-mirror.ts are not on
// that list):
//
//   1. EXTENSIONLESS RELATIVE IMPORTS — e.g. ninetone.ts's own
//      `import { fmFind } from "./filemaker"` (no `.ts`). Vite resolves
//      this silently; plain Node throws ERR_MODULE_NOT_FOUND.
//      (src/lib/translate.ts's own doc comment documents exactly this gap
//      as the reason IT was written with explicit .ts extensions — it's
//      imported directly by test/translate.test.mjs. ninetone.ts predates
//      having any plain-Node importer and was never adjusted the same way.)
//
//   2. `import.meta.env` — a Vite-only global. Under plain Node it's
//      `undefined`, so any module-scope read like src/lib/fm-image-
//      mirror.ts's `import.meta.env.FM_IMAGE_PROXY_BASE ?? "..."` throws
//      immediately on `undefined.FM_IMAGE_PROXY_BASE` instead of reaching
//      its own documented `??` fallback. This is a general gap across
//      src/lib (grep shows ten files reading `import.meta.env` directly),
//      not specific to one file.
//
// Both are fixed here with a Node module customization hook (`node:module`'s
// `register()`), registered BEFORE this script imports anything from
// src/lib — see the two dynamic imports right after this block. The hook
// itself is inlined as a `data:` URL (rather than a second file under
// scripts/) to keep this task's file-touch list to exactly what was asked:
// this file (new), src/lib/t.ts's capture hook, and a test file.
//
//   - `resolve`: a relative specifier with no extension that fails to
//     resolve is retried once with `.ts` appended — mirrors what Vite's
//     resolver already does silently for every existing extensionless
//     import in src/lib.
//   - `load`: for any loaded .ts module whose source mentions
//     `import.meta.env`, prepend `import.meta.env = import.meta.env ?? {};`
//     — makes the property read safe instead of throwing on `undefined.X`,
//     without changing what any fallback VALUE is. Real values (FM_HOST,
//     FM_USER, ANTHROPIC_API_KEY, etc.) still come from `process.env` via
//     each module's own existing `runtimeEnv()`/`readEnv()` fallback (see
//     src/lib/filemaker.ts, src/lib/translate.ts) — this shim only
//     prevents the lookup itself from throwing.
//
// NOTE: `nextLoad()`'s `result.source` for a `.ts` file is a Uint8Array,
// not a string, even though `typeof result.source === "object"` doesn't
// announce that. Decode with `Buffer.from(...).toString("utf8")` before any
// string check — `Uint8Array.prototype.includes` checks for a matching BYTE
// VALUE, not a substring, and would silently never match.
//
// This hook has ZERO effect on the real Astro/Vite build (gh or cf) or on
// `npm test` — nothing outside THIS process ever calls `register()` with it.
// ---------------------------------------------------------------------------
const PLAIN_NODE_TS_LOADER_SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasNoExtension = !/\\.[a-zA-Z0-9]+$/.test(specifier);
    if (isRelative && hasNoExtension) {
      return nextResolve(specifier + ".ts", context);
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith("file://") || !url.endsWith(".ts") || result.source == null) {
    return result;
  }
  const text = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
  if (!text.includes("import.meta.env")) {
    return result;
  }
  return { ...result, source: "import.meta.env = import.meta.env ?? {};\\n" + text };
}
`;
register(`data:text/javascript,${encodeURIComponent(PLAIN_NODE_TS_LOADER_SOURCE)}`, import.meta.url);

// Imported dynamically, AFTER register() above — a static top-level import
// of these would resolve before the hook is registered and fail exactly as
// it did before this shim existed.
const { translationKey, TRANSLATION_KEY_VERSION, callWithGuard, buildProtectedTerms } = await import(
  "../src/lib/translate.ts"
);
const {
  getArtists,
  getPreviousArtists,
  getClients,
  getTeam,
  getBookingCategories,
  getBookingRoster,
  getArtistDetailWithReleases,
  getNews,
  getWebPosts,
} = await import("../src/lib/ninetone.ts");
const CAPTURE_FILE = path.join(ROOT, "i18n-chrome-capture.jsonl");
const BULK_PUT_FILE = path.join(ROOT, ".translate-warm-bulk-put.json");

const KV_BINDING = "CACHE_STATE"; // wrangler.jsonc — the same namespace translate.ts's live cache reads/writes.
const LANGS = ["sv", "en"]; // both directions — decision 4, and note C for chrome specifically.

// ---------------------------------------------------------------------------
// Pricing (per MTok) — claude-api skill, cached 2026-06-24, same table
// translate.ts's own header comment cites. Not invented: matches
// translate.ts's MODEL_IDS comment verbatim (fast=Haiku 4.5 $1/$5,
// quality=Sonnet 5 $2/$10).
// ---------------------------------------------------------------------------
const PRICING_PER_MTOK = {
  fast: { input: 1.0, output: 5.0 },
  quality: { input: 2.0, output: 10.0 },
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
/**
 * Parses `--max-calls=N` / `--concurrency=N`'s value into a positive
 * integer, or returns null on anything else (missing, non-numeric,
 * fractional, zero, negative). A bad value here is NOT silently accepted as
 * NaN: `missing.length > NaN` is always `false`, so an unparseable
 * `--max-calls` would otherwise disable the cost-guard ceiling entirely —
 * exactly the "unbounded bill by accident" failure mode this script exists
 * to prevent (verified against a real `--max-calls=abc` run before this
 * guard was added: the ceiling silently vanished and a 10,144-call dry-run
 * reported no guard violation). Treated as a hard parse error (see the
 * caller below) rather than silently falling back to the default, since a
 * typo'd numeric flag that quietly falls back to "2000" is just as
 * dangerous as one that parses to NaN if the operator's intent was a
 * SMALLER number.
 */
function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseArgs(argv) {
  const args = {
    live: false,
    maxCalls: 2000,
    concurrency: 4,
    chromeOnly: false,
    entitiesOnly: false,
  };
  for (const raw of argv) {
    if (raw === "--live") args.live = true;
    else if (raw === "--dry-run") args.live = false;
    else if (raw.startsWith("--max-calls=")) {
      const parsed = parsePositiveInt(raw.slice("--max-calls=".length));
      if (parsed === null) {
        console.error(`Invalid --max-calls value: ${JSON.stringify(raw.slice("--max-calls=".length))} (must be a positive integer)`);
        process.exitCode = 1;
        args.help = true;
      } else {
        args.maxCalls = parsed;
      }
    } else if (raw.startsWith("--concurrency=")) {
      const parsed = parsePositiveInt(raw.slice("--concurrency=".length));
      if (parsed === null) {
        console.error(`Invalid --concurrency value: ${JSON.stringify(raw.slice("--concurrency=".length))} (must be a positive integer)`);
        process.exitCode = 1;
        args.help = true;
      } else {
        args.concurrency = parsed;
      }
    } else if (raw === "--chrome-only") args.chromeOnly = true;
    else if (raw === "--entities-only") args.entitiesOnly = true;
    else if (raw === "--help" || raw === "-h") {
      args.help = true;
    } else {
      console.error(`Unknown argument: ${raw}`);
      process.exitCode = 1;
      args.help = true;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// KEY-MATCH VERIFICATION — see the file-level doc comment. Runs first,
// before any FM read, any API call, or any KV write.
// ---------------------------------------------------------------------------
async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyKeyRoundTrip() {
  const sample = "Kontakta oss — Ninetone Nation booking förfrågan";
  const target = "en";
  const tier = "quality";

  // Path A: this script's own call site — the exact function/arguments the
  // rest of this script uses for every real key it computes below.
  const keyFromScript = await translationKey(sample, target, tier);

  // Path B: independently re-derived using ONLY translate.ts's own exported
  // version constant (never a hardcoded "v1" literal — a version bump would
  // then correctly fail this check instead of being silently missed) plus a
  // hasher built from the same primitive translate.ts's internal sha256Hex
  // uses (Web Crypto's crypto.subtle.digest("SHA-256", ...)) — not imported
  // from translate.ts (that function isn't exported, by design — see this
  // script's own doc comment on why translationKey() is the one seam meant
  // for external callers), but built from documented, standard primitives
  // so this really is an INDEPENDENT re-derivation, not just calling the
  // same function twice under a different name.
  const hash = await sha256Hex(sample);
  const keyIndependent = `tr:${TRANSLATION_KEY_VERSION}:${target}:${tier}:${hash}`;

  if (keyFromScript !== keyIndependent) {
    throw new Error(
      `KEY ROUND-TRIP VERIFICATION FAILED.\n` +
        `  translationKey() produced: ${keyFromScript}\n` +
        `  independent re-derivation: ${keyIndependent}\n` +
        `translate.ts's key format has changed in a way this script does not match. ` +
        `Refusing to run — writing under the wrong keys would make the warm cache dead weight ` +
        `with nothing to ever notice. Update this script's key derivation (or re-check ` +
        `TRANSLATION_KEY_VERSION / keyFromHash in src/lib/translate.ts) before re-running.`,
    );
  }

  console.log(`Key round-trip verified: ${keyFromScript}`);
  console.log(`  (translationKey("${sample}", "${target}", "${tier}") === tr:${TRANSLATION_KEY_VERSION}:${target}:${tier}:sha256(source), independently re-derived)\n`);
}

// ---------------------------------------------------------------------------
// Entity content walking (task brief item 1) — reuses the FM helpers
// src/lib/sitemap.ts and src/lib/llms.ts already fetch with, plus release
// pitch/social and WebPosts per decision 9.
// ---------------------------------------------------------------------------

/** One translatable job: a source string, its kind, and its tier. */
function job(source, tier, kind = "plain") {
  const text = typeof source === "string" ? source.trim() : "";
  return text ? { source: text, tier, kind } : null;
}

/**
 * VOICE_FIELDS — see file-level doc comment's "TIER ASSIGNMENT" section for
 * the full enumeration and reasoning. Collected as a function so it can run
 * after the other FM reads (booking categories / webposts) it depends on
 * are already in hand — avoids a second redundant fetch of either.
 */
function voiceFieldJobs({ artists, clients, bookingCategories, webPostsBySection }) {
  const jobs = [];

  // 1. Records division intro (API_ARTIST::readMore) — same value on every
  //    row per src/lib/ninetone.ts's Artist type doc comment; read once.
  jobs.push(job(artists[0]?.readMore, "quality", "markdown"));

  // 2. Management division intro (API_Management::readMoreClients).
  jobs.push(job(clients[0]?.readMoreClients, "quality", "markdown"));

  // 3. Nation division intro (API_Booking::readMoreBooking) — sourced from
  //    the booking roster below (getBookingRoster), not bookingCategories,
  //    since that's the field src/pages/ninetone-nation/booking.astro reads.
  // (populated by caller — see collectEntityJobs)

  // 4-9. Six API_BOOKING_TAG category descriptions (breadBooking).
  for (const cat of bookingCategories) {
    jobs.push(job(cat.description, "quality", "markdown"));
  }

  // 10. Ninetone Group WebPosts section intro/blocks (company landing).
  const groupSection = webPostsBySection.get("Ninetone Group");
  if (groupSection) {
    for (const block of groupSection.blocks) {
      jobs.push(job(block.subject, "quality", "title"));
      jobs.push(job(block.message, "quality", "markdown"));
    }
  }

  // 11. Guider (guides) WebPosts blocks — decision 3 explicitly lists guides
  //     as quality tier; every guide is its own landing page.
  const guiderSection = webPostsBySection.get("Guider");
  if (guiderSection) {
    for (const block of guiderSection.blocks) {
      jobs.push(job(block.subject, "quality", "title"));
      jobs.push(job(block.message, "quality", "markdown"));
    }
  }

  // 12. Contact copy — the three division WebPosts sections that back the
  //     /records/contact-records, /management/contact-management, and
  //     /ninetone-nation/contact-ninetone-nation pages. src/lib/ninetone.ts's
  //     WebPostSection type lists "Ninetone Records" / "Ninetone Management" /
  //     "Ninetone Nation" as the section names shared with the division
  //     landing pages themselves — their WebPosts blocks are what the
  //     contact pages render as supporting copy alongside the ContactForm.
  for (const name of ["Ninetone Records", "Ninetone Management", "Ninetone Nation"]) {
    const section = webPostsBySection.get(name);
    if (!section) continue;
    for (const block of section.blocks) {
      jobs.push(job(block.subject, "quality", "title"));
      jobs.push(job(block.message, "quality", "markdown"));
    }
  }

  // EVERY section's own `title`, and every section's blocks — not just the
  // hand-listed ones above.
  //
  // `section.title` was never collected anywhere, and sections such as
  // "Ninetone Group Team" were not in any list. That left /team rendering an
  // untranslated FM heading: the page's own ~21 chrome strings consume almost
  // the whole 25-call per-render budget (Implementation note C), so an
  // unwarmed heading sits at the back of the queue and never gets scheduled —
  // it does NOT self-heal the way a lightly-loaded page's miss does.
  //
  // Note the direction: the Team section's FM copy is authored in ENGLISH, so
  // it is the SWEDISH render that needs translating. Both targets are warmed
  // regardless (decision 4 is bidirectional), so no special-casing here.
  // TIER MUST MATCH WHAT THE PAGE READS. src/lib/t.ts's fmText() — which is
  // what every WebPosts render path uses — always requests the `fast` tier,
  // and the tier is part of the cache key. Warming these on `quality` wrote
  // keys no page will ever look up: verified live on the /team heading, where
  // the quality key held a correct Swedish translation while the page kept
  // rendering English from a permanent `fast`-tier miss. This is exactly the
  // warm-vs-request drift Implementation note A exists to prevent, so these
  // are warmed on BOTH tiers: `fast` is what fmText() reads today, `quality`
  // keeps the higher-quality copy available if a voice surface ever reads it.
  for (const section of webPostsBySection.values()) {
    for (const tier of ["fast", "quality"]) {
      jobs.push(job(section.title, tier, "title"));
      for (const block of section.blocks) {
        jobs.push(job(block.subject, tier, "title"));
        jobs.push(job(block.message, tier, "markdown"));
      }
    }
  }

  return jobs.filter(Boolean);
}

async function collectEntityJobs() {
  console.log("Fetching FM entities...");
  const [artists, previousArtists, clients, team, bookingCategories, bookingRoster, news] = await Promise.all([
    getArtists(),
    getPreviousArtists(),
    getClients(),
    getTeam(),
    getBookingCategories(),
    getBookingRoster(),
    getNews(),
  ]);

  // WebPosts — every category (decision 9: "plus ... WebPosts"). Fetch once
  // (category="*") rather than once per named section.
  const webPostSections = await getWebPosts("*");
  const webPostsBySection = new Map(webPostSections.map((s) => [s.category, s]));

  const jobs = [];

  // --- FAST tier: bios AND card blurbs -----------------------------------
  //
  // `*PresentationShort` is a SEPARATE FIELD from `*PresentationString`, with
  // different text: the Short is the two-line blurb every ArtistCard renders
  // on a listing, the String is the full detail-page bio. Warming only the
  // bio left every card on every listing page a permanent cache miss — and
  // because a listing renders dozens of cards against a 25-call per-render
  // budget, those misses are starved and never self-heal.
  //
  // Measured before this fix: 132 of 544 English routes still contained
  // Swedish text, led by /en/records/artists/previous (561 Swedish words) and
  // /en/management/clients (149) — both card-heavy listings.
  for (const a of artists) {
    jobs.push(job(a["Artist Presentation Title"], "fast", "title"));
    jobs.push(job(a.artistPresentationString, "fast", "markdown"));
    jobs.push(job(a.artistPresentationShort, "fast", "plain"));
  }
  for (const a of previousArtists) {
    jobs.push(job(a["Artist Presentation Title"], "fast", "title"));
    jobs.push(job(a.artistPresentationString, "fast", "markdown"));
    jobs.push(job(a.artistPresentationShort, "fast", "plain"));
  }
  for (const c of clients) {
    jobs.push(job(c.clientPresentationTitle, "fast", "title"));
    jobs.push(job(c.clientPresentationString, "fast", "markdown"));
    jobs.push(job(c.clientPresentationShort, "fast", "plain"));
    // clients.astro falls back to artistPresentationShort when the client
    // variant is empty, so warm whichever the page would actually render.
    jobs.push(job(c.artistPresentationShort, "fast", "plain"));
  }
  // Booking talent bios (bookingPresentationTitle/String) — bookingCategories'
  // portal rows carry the resolved tagline/blurb; the detail page
  // (src/pages/ninetone-nation/[slug].astro) reads bookingPresentationTitle/
  // String directly off the roster row, so use bookingRoster for the exact
  // field names that page renders.
  for (const e of bookingRoster) {
    jobs.push(job(e.bookingPresentationTitle, "fast", "title"));
    jobs.push(job(e.bookingPresentationString, "fast", "markdown"));
  }

  // --- FAST tier: team member descriptions (a per-person blurb, same shape
  //     as a bio, not landing copy) ------------------------------------
  for (const m of team) {
    jobs.push(job(m.title, "fast", "title"));
    jobs.push(job(m.titleDescription, "fast", "title"));
    jobs.push(job(m.DescriptionString ?? m.Description, "fast", "markdown"));
  }

  // --- FAST tier: news (API_NEWS + WebPosts "Ninetone Blog") -------------
  for (const n of news) {
    jobs.push(job(n.Title ?? n.title, "fast", "title"));
    jobs.push(job(n.shortMessage, "fast", "plain"));
    jobs.push(job(n.MessageString ?? n.Message, "fast", "markdown"));
  }
  const blogSection = webPostsBySection.get("Ninetone Blog");
  if (blogSection) {
    for (const block of blogSection.blocks) {
      jobs.push(job(block.subject, "fast", "title"));
      jobs.push(job(block.message, "fast", "markdown"));
    }
  }
  // Ninetone Group Team WebPosts section — team-page supporting copy, same
  // per-person shape as the team bios above, not division landing voice.
  const teamSection = webPostsBySection.get("Ninetone Group Team");
  if (teamSection) {
    for (const block of teamSection.blocks) {
      jobs.push(job(block.subject, "fast", "title"));
      jobs.push(job(block.message, "fast", "markdown"));
    }
  }

  // --- FAST tier: release pitch/social (decision 9: "release pitch/social
  //     text") — one getArtistDetailWithReleases() call per artist+previous
  //     artist, since releases live in a portal keyed by slug. -----------
  const artistsForReleases = [...artists, ...previousArtists].filter((a) => a.SLUG);
  console.log(`Fetching releases for ${artistsForReleases.length} artists (active + previous)...`);
  const releaseResults = await mapWithConcurrency(artistsForReleases, 4, async (a) => {
    const slug = String(a.SLUG ?? "");
    try {
      return await getArtistDetailWithReleases(slug);
    } catch (err) {
      console.error(`  [warn] failed to fetch releases for ${slug}: ${err.message ?? err}`);
      return null;
    }
  });
  for (const detail of releaseResults) {
    if (!detail) continue;
    for (const r of detail.releases) {
      jobs.push(job(r.pitch, "fast", "plain"));
      jobs.push(job(r.social, "fast", "plain"));
    }
  }

  // --- QUALITY tier: the ~12 voice pages ---------------------------------
  const voiceJobs = voiceFieldJobs({ artists, clients, bookingCategories, webPostsBySection });
  // Item 3 (Nation division intro) is sourced from bookingRoster, not
  // bookingCategories — add it here alongside the other voice jobs so
  // voiceFieldJobs() doesn't need a redundant getBookingRoster() call.
  voiceJobs.push(job(bookingRoster[0]?.readMoreBooking, "quality", "markdown"));
  jobs.push(...voiceJobs);

  return jobs.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Chrome job collection (task brief item 2 / note D) — reads the capture
// file a build run with I18N_CAPTURE_CHROME_STRINGS=1 produces. Does NOT
// run the build itself (forbidden — see file header).
// ---------------------------------------------------------------------------
/**
 * Pure JSONL-line parser, factored out of collectChromeJobs() so
 * test/translate-warm.test.mjs can exercise the malformed-line handling and
 * de-duplication without touching the filesystem. One JSON object per line,
 * `{"source": "..."}` — see src/lib/t.ts's captureSourceString() doc comment
 * for the file format this reads. Returns the de-duplicated set of source
 * strings plus a count of lines that failed to parse (never thrown — a
 * malformed line is reported and skipped, matching this script's overall
 * "degrade, don't crash a multi-hundred-item run over one bad line" posture).
 */
function parseChromeCaptureLines(raw) {
  const sources = new Set();
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.source === "string" && parsed.source.trim()) {
        sources.add(parsed.source);
      }
    } catch {
      malformed += 1;
    }
  }
  return { sources, malformed };
}

async function collectChromeJobs() {
  if (!existsSync(CAPTURE_FILE)) {
    console.warn(
      `\n[warn] Chrome capture file not found at ${path.relative(ROOT, CAPTURE_FILE)}.\n` +
        `Chrome strings will NOT be warmed this run. To warm them:\n` +
        `  rm -f ${path.relative(ROOT, CAPTURE_FILE)}\n` +
        `  I18N_CAPTURE_CHROME_STRINGS=1 npm run build\n` +
        `  node --env-file=.env scripts/translate-warm.mjs --live\n`,
    );
    return [];
  }

  const raw = await readFile(CAPTURE_FILE, "utf8");
  const { sources, malformed } = parseChromeCaptureLines(raw);
  if (malformed > 0) {
    console.warn(`[warn] ${malformed} malformed line(s) in the chrome capture file were skipped.`);
  }

  console.log(`Chrome capture: ${sources.size} distinct source string(s) found in ${path.relative(ROOT, CAPTURE_FILE)}.`);

  // Chrome tier is always "quality" (note C) — kind is always "plain": every
  // t()/sharedT() call site uses tier:"quality", kind:"plain" per
  // translate.ts's createT() doc comment ("Deliberately thin: t(source)
  // always translates chrome strings at tier: 'quality' and kind:
  // 'plain'"). This script mirrors that exactly rather than guessing.
  return [...sources].map((source) => job(source, "quality", "plain")).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Bounded concurrency (task brief: "Implement bounded concurrency")
// ---------------------------------------------------------------------------
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Build the full (source, target, tier) work list, de-duplicated, with keys
// pre-computed via translate.ts's own translationKey() (note A / the
// critical correctness property).
// ---------------------------------------------------------------------------
async function buildWorkItems(jobs) {
  // De-dupe by (source, tier) BEFORE fanning out over both target languages
  // — the same source string can legitimately appear from many entities
  // (e.g. many artists sharing a release-pitch template phrase, or the
  // Records readMore intro appearing on every artist row per
  // src/lib/ninetone.ts's own doc comment: "Same value duplicated across
  // all rows"). Translating and caching the same (source, target, tier)
  // twice would be pure waste — translate.ts's own cache key is exactly
  // this triple, so this de-dupe mirrors what the cache would collapse
  // anyway, just before spending a real API call on it.
  const bySourceTier = new Map();
  for (const j of jobs) {
    const dedupeKey = `${j.tier} ${j.source}`;
    if (!bySourceTier.has(dedupeKey)) bySourceTier.set(dedupeKey, j);
  }

  const items = [];
  for (const j of bySourceTier.values()) {
    for (const target of LANGS) {
      const key = await translationKey(j.source, target, j.tier);
      items.push({ source: j.source, target, tier: j.tier, kind: j.kind, key });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// KV: idempotency check via `wrangler kv key list` (task brief item 4 —
// "Use wrangler kv key list ... rather than re-translating").
// ---------------------------------------------------------------------------
async function fetchExistingKeys() {
  console.log(`Listing existing keys in KV namespace "${KV_BINDING}" (prefix "tr:${TRANSLATION_KEY_VERSION}:")...`);
  const { stdout } = await execFileAsync(
    "npx",
    [
      "wrangler",
      "kv",
      "key",
      "list",
      "--binding",
      KV_BINDING,
      "--remote",
      "--prefix",
      `tr:${TRANSLATION_KEY_VERSION}:`,
    ],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const keys = new Set(parsed.map((entry) => entry.name));
  console.log(`  ${keys.size} key(s) already present.\n`);
  return keys;
}

// ---------------------------------------------------------------------------
// Translation (task brief item 3 — via translate.ts's callWithGuard, never
// re-implemented here — note A).
// ---------------------------------------------------------------------------
/**
 * How many successful translations to accumulate before flushing them to KV.
 *
 * WHY FLUSH AT ALL, rather than one bulk put at the end: a full-corpus run is
 * ~10.8k API calls at concurrency 4 — on the order of two hours and ~$10 of
 * real spend. With a single terminal write, ANY failure at 90% (a network
 * blip, an expired wrangler session, an accidental Ctrl-C, a laptop lid)
 * discards every translation made so far, because they exist only in this
 * process's memory. Flushing incrementally makes the run RESUMABLE: whatever
 * reached KV is skipped by the idempotency check on the next run, so a
 * restart costs only the unflushed tail rather than the whole corpus.
 *
 * 250 is a deliberate middle: large enough that `wrangler kv bulk put`'s
 * process-spawn overhead stays negligible against ~250 API calls, small
 * enough that a crash loses at most a couple of minutes of work.
 */
const FLUSH_EVERY = 250;

async function translateWorkItems(items, apiKey, concurrency, onFlush) {
  const results = [];
  let done = 0;
  let pending = [];

  // Serialize flushes: two concurrent `wrangler kv bulk put` invocations
  // would race over the same BULK_PUT_FILE path.
  let flushChain = Promise.resolve();
  const queueFlush = (batch) => {
    if (!onFlush || batch.length === 0) return;
    flushChain = flushChain.then(() => onFlush(batch)).catch((err) => {
      // A failed flush must not abort the run — the entries stay in
      // `results` and the terminal write will retry them.
      console.error(`  [flush] KV write failed (will retry at end): ${err.message ?? err}`);
    });
  };

  await mapWithConcurrency(items, concurrency, async (item) => {
    const protectedTerms = await buildProtectedTerms([]); // no per-entity name to protect at this granularity — FIXED_PROTECTED_TERMS + live booking-category tags still apply.
    let text = null;
    let error = null;
    try {
      text = await callWithGuard(apiKey, item.source, item.target, item.tier, item.kind, protectedTerms);
    } catch (err) {
      error = err;
    }
    done += 1;
    if (done % 25 === 0 || done === items.length) {
      console.log(`  translated ${done}/${items.length}...`);
    }
    if (error) {
      console.error(`  [error] "${item.source.slice(0, 60)}" -> ${item.target}/${item.tier}: ${error.message ?? error}`);
      results.push({ ...item, text: null });
      return;
    }
    if (text === null) {
      console.error(`  [rejected] "${item.source.slice(0, 60)}" -> ${item.target}/${item.tier}: both tiers failed the output-contract guard — skipping.`);
      results.push({ ...item, text: null });
      return;
    }
    results.push({ ...item, text });
    pending.push({ ...item, text });
    if (pending.length >= FLUSH_EVERY) {
      queueFlush(pending);
      pending = [];
    }
  });

  queueFlush(pending);
  await flushChain;

  return results;
}

// ---------------------------------------------------------------------------
// Token/cost accounting (task brief item 5 — real usage, never estimated).
// callWithGuard() itself doesn't return usage, so this script calls the
// same underlying pieces translate.ts's callAnthropic() does, but that
// function isn't exported (only callWithGuard is, per note A's documented
// seam) — so token accounting is done via a SEPARATE, lightweight metering
// wrapper around fetch that inspects the same response callWithGuard()
// already triggers. See withUsageTracking() below.
// ---------------------------------------------------------------------------

/**
 * Wraps globalThis.fetch for the duration of `fn` so every Anthropic
 * Messages API response's `usage` block is captured as a side observation,
 * WITHOUT re-implementing the call itself — the actual request still goes
 * out exactly as translate.ts's callAnthropic() builds it; this only reads
 * the response body a second time (via .clone()) to pull `usage` out, then
 * hands the original Response back to the real caller untouched. This is
 * the one place this script "reaches around" callWithGuard() rather than
 * treating it as a total black box — justified because decision/task item 5
 * requires real usage numbers, callWithGuard()'s return type is (per
 * translate.ts, unchanged by this script) just the translated string, and
 * cloning a Response to inspect it does not alter the request that was
 * sent, the prompt that was assembled, the guard that was applied, or the
 * result callWithGuard() returns — none of the things note A forbids
 * re-implementing.
 */
function withUsageTracking(totalsByTier) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const res = await originalFetch(url, init);
    if (String(url).includes("api.anthropic.com") && res.ok) {
      try {
        const clone = res.clone();
        const json = await clone.json();
        const usage = json?.usage;
        if (usage) {
          // Tier isn't in the response — recover it from the request body's
          // `model` field (translate.ts's callAnthropic sends MODEL_IDS[tier]).
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          const model = body?.model;
          const tier = model === "claude-haiku-4-5" ? "fast" : model === "claude-sonnet-5" ? "quality" : "unknown";
          const bucket = totalsByTier[tier] ?? (totalsByTier[tier] = { input: 0, output: 0, cacheRead: 0, calls: 0 });
          bucket.input += usage.input_tokens ?? 0;
          bucket.output += usage.output_tokens ?? 0;
          bucket.cacheRead += usage.cache_read_input_tokens ?? 0;
          bucket.calls += 1;
        }
      } catch {
        // Metering is best-effort and must never break the real call whose
        // response this function hands back untouched below.
      }
    }
    return res;
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function formatUsd(n) {
  return `$${n.toFixed(4)}`;
}

function printCostReport(totalsByTier) {
  console.log("\n--- Token usage & cost (real API usage, not estimated) ---");
  let grandCost = 0;
  let grandInput = 0;
  let grandOutput = 0;
  let grandCacheRead = 0;
  for (const tier of ["fast", "quality", "unknown"]) {
    const bucket = totalsByTier[tier];
    if (!bucket || bucket.calls === 0) continue;
    const pricing = PRICING_PER_MTOK[tier];
    const cost = pricing ? (bucket.input / 1e6) * pricing.input + (bucket.output / 1e6) * pricing.output : NaN;
    grandCost += Number.isFinite(cost) ? cost : 0;
    grandInput += bucket.input;
    grandOutput += bucket.output;
    grandCacheRead += bucket.cacheRead;
    console.log(
      `  ${tier.padEnd(8)} calls=${bucket.calls}  input=${bucket.input}  output=${bucket.output}` +
        `  cache_read=${bucket.cacheRead}  cost=${Number.isFinite(cost) ? formatUsd(cost) : "n/a"}`,
    );
  }
  console.log(
    `  ${"TOTAL".padEnd(8)} input=${grandInput}  output=${grandOutput}  cache_read=${grandCacheRead}  cost=${formatUsd(grandCost)}`,
  );
}

// ---------------------------------------------------------------------------
// wrangler kv bulk put (task brief item 3).
// ---------------------------------------------------------------------------
async function writeToKv(entries) {
  if (entries.length === 0) {
    console.log("Nothing to write — no successfully translated entries.");
    return;
  }
  const payload = entries.map((e) => ({ key: e.key, value: e.text }));
  // Unique temp path per call: this is now invoked repeatedly (see
  // FLUSH_EVERY) and a single fixed filename would let one flush overwrite
  // the payload another is still handing to wrangler.
  const file = `${BULK_PUT_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(file, JSON.stringify(payload, null, 0), "utf8");
  console.log(`  writing ${entries.length} key(s) to KV namespace "${KV_BINDING}"...`);
  try {
    await execFileAsync(
      "npx",
      ["wrangler", "kv", "bulk", "put", file, "--binding", KV_BINDING, "--remote"],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    console.log(`  KV write complete (${entries.length} key(s)).`);
  } finally {
    await unlink(file).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node --env-file=.env scripts/translate-warm.mjs [--live] [--max-calls=N] [--concurrency=N] [--chrome-only] [--entities-only]\n" +
        "Default is dry-run: reports what would be translated, writes nothing.",
    );
    return;
  }

  await verifyKeyRoundTrip();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && args.live) {
    throw new Error("ANTHROPIC_API_KEY is not set (expected in .env or the environment). Run with `node --env-file=.env scripts/translate-warm.mjs --live`.");
  }

  const jobs = [];
  if (!args.chromeOnly) {
    jobs.push(...(await collectEntityJobs()));
  }
  if (!args.entitiesOnly) {
    jobs.push(...(await collectChromeJobs()));
  }

  console.log(`\nCollected ${jobs.length} translatable field-jobs before target-language expansion and de-dupe.`);

  const workItems = await buildWorkItems(jobs);
  console.log(`${workItems.length} (source, target, tier) combinations after de-dupe + both-language expansion.`);

  const existingKeys = await fetchExistingKeys();
  const missing = workItems.filter((item) => !existingKeys.has(item.key));
  const alreadyCached = workItems.length - missing.length;
  console.log(`${alreadyCached} already cached (skipped — idempotent). ${missing.length} need translation.\n`);

  const byTier = { fast: 0, quality: 0 };
  for (const item of missing) byTier[item.tier] = (byTier[item.tier] ?? 0) + 1;
  console.log("Breakdown of work needed:");
  console.log(`  fast:    ${byTier.fast ?? 0}`);
  console.log(`  quality: ${byTier.quality ?? 0}`);

  // Rough pre-flight cost estimate for the dry-run report ONLY — this is
  // explicitly NOT the "real, not estimated" number task item 5 requires
  // for the post-run report (that one comes from response.usage). This
  // estimate exists solely so `--dry-run` (the default) can print a cost
  // figure before any call has been made, using a conservative average
  // field length measured from this corpus's own source strings.
  const avgChars = missing.length > 0 ? missing.reduce((sum, i) => sum + i.source.length, 0) / missing.length : 0;
  const avgInputTokensEst = Math.ceil(avgChars / 4) + 150; // ~4 chars/token + system-prompt overhead
  const avgOutputTokensEst = Math.ceil(avgChars / 4) + 20;
  let estCost = 0;
  for (const tier of ["fast", "quality"]) {
    const n = byTier[tier] ?? 0;
    const pricing = PRICING_PER_MTOK[tier];
    estCost += n * ((avgInputTokensEst / 1e6) * pricing.input + (avgOutputTokensEst / 1e6) * pricing.output);
  }

  if (missing.length > args.maxCalls) {
    throw new Error(
      `Refusing to proceed: ${missing.length} calls needed exceeds --max-calls=${args.maxCalls}. ` +
        `Raise --max-calls explicitly if this is intended, or narrow scope with --chrome-only/--entities-only.`,
    );
  }

  if (!args.live) {
    console.log("\n=== DRY RUN (default) — nothing was translated or written. ===");
    console.log(`Would make ${missing.length} API call(s) (concurrency=${args.concurrency}, max-calls ceiling=${args.maxCalls}).`);
    console.log(`Rough pre-flight cost estimate (NOT measured — average field length × tier pricing): ${formatUsd(estCost)}`);
    console.log("Re-run with --live to actually translate and write to KV. Real token counts/cost will be printed from API usage, not estimated.");
    return;
  }

  console.log(`\n=== LIVE RUN === Translating ${missing.length} item(s) at concurrency=${args.concurrency}...`);
  const totalsByTier = {};
  const stopTracking = withUsageTracking(totalsByTier);
  let translated;
  // Track what incremental flushes already persisted, so the terminal write
  // only has to cover the tail (plus anything a flush failed to write).
  const flushedKeys = new Set();
  try {
    translated = await translateWorkItems(missing, apiKey, args.concurrency, async (batch) => {
      await writeToKv(batch);
      for (const entry of batch) flushedKeys.add(entry.key);
    });
  } finally {
    stopTracking();
  }

  const successful = translated.filter((t) => t.text !== null);
  const failed = translated.length - successful.length;
  console.log(`\n${successful.length} succeeded, ${failed} failed/rejected (left uncached — will be retried by a future run or a live request-time miss).`);

  const remaining = successful.filter((e) => !flushedKeys.has(e.key));
  if (flushedKeys.size > 0) {
    console.log(`${flushedKeys.size} key(s) already persisted by incremental flushes; writing the remaining ${remaining.length}.`);
  }
  await writeToKv(remaining);
  printCostReport(totalsByTier);
}

// Only auto-run when executed directly (`node scripts/translate-warm.mjs`),
// not when imported — test/translate-warm.test.mjs imports this module for
// its pure helpers (parseArgs, parseChromeCaptureLines, verifyKeyRoundTrip)
// and must NOT trigger a live run (FM reads, API calls, KV writes) merely by
// importing the file to reach them.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error("\nFATAL:", err.message ?? err);
    process.exitCode = 1;
  });
}

// ---------------------------------------------------------------------------
// Exports for test/translate-warm.test.mjs — pure helpers only. Everything
// exported here does no I/O (no FM reads, no Anthropic calls, no KV/wrangler
// shell-outs), so importing this module for tests is side-effect-free beyond
// registering the plain-Node .ts loader hook (harmless — see the doc comment
// on PLAIN_NODE_TS_LOADER_SOURCE above; it only affects module resolution
// within this same process).
// ---------------------------------------------------------------------------
export { parseArgs, verifyKeyRoundTrip, parseChromeCaptureLines, job as buildJob };
