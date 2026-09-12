/**
 * Call-site wrapper around src/lib/translate.ts's `createT()`, for Section 4
 * of docs/i18n-phase-2-brief.md ("replace the scattered `lang === "sv" ? … :
 * …` ternaries ... with `t(text)` calls").
 *
 * This file exists to close TWO gaps that only became visible once `t()` was
 * actually wired into real pages/components — both are call-site problems,
 * not translate.ts problems, and translate.ts is out of scope for section 4
 * (see docs/i18n-phase-2-brief.md's file-ownership list), so the fix has to
 * live here instead of there.
 *
 * GAP 1 — ONE BUDGET PER RENDER, NOT ONE BUDGET PER COMPONENT.
 * `createT(locals)` with no `opts.budget` constructs a FRESH `RequestBudget`
 * (default ceiling 25) every time it's called (translate.ts's own doc
 * comment on `createT` says this explicitly). Every page on this site routes
 * through Base.astro, which mounts Header + Footer + CommandPalette as
 * siblings of the page's own content — if each of those called
 * `createT(Astro.locals)` independently with no shared budget, the render
 * would get Header's-own-25 + Footer's-own-25 + CommandPalette's-own-25 +
 * the page's-own-25 = up to 100 uncached calls allowed on one render, four
 * times the ceiling the brief's Build item actually specifies ("max 25
 * uncached calls per render"). `sharedT()` below fixes this by stashing ONE
 * `RequestBudget` on `Astro.locals` (the one object every component in a
 * render tree already shares — src/middleware.ts relies on this same fact
 * for `locals.lang`) and handing that same instance to every `createT()`
 * call for the request, via `opts.budget`.
 *
 * GAP 2 — IDENTICAL STRINGS REPEATED MANY TIMES IN ONE RENDER MUST NOT EACH
 * CONSUME A BUDGET SLOT. `ArtistCard`'s `ctaLabel` prop is the clearest
 * example: src/pages/ninetone-nation/booking.astro renders one `ArtistCard`
 * per active booking talent (`getBookingCategories()` queries with `limit:
 * 100`, src/lib/ninetone.ts) and passes the literal string `"Book"` to every
 * one of them. Naively calling `t("Book")` once per card would mean up to
 * ~100 independent `translate()` calls for the SAME source string on ONE
 * render of ONE page — each an independent cache/override lookup, and on a
 * cold cache each independently burning a budget slot for what is, in
 * effect, one distinct string. `sharedT()` memoizes by source string WITHIN
 * one call to the returned `t`, so "Book" is translated (or scheduled) once
 * per render no matter how many cards ask for it, and every other caller
 * gets the same in-flight promise instead of issuing a duplicate call.
 *
 * WHY NOT JUST FIX THIS IN `createT()` ITSELF: translate.ts is explicitly
 * out of scope for section 4 (docs/i18n-phase-2-brief.md's "Do NOT touch"
 * list) — if it needed a change, the instruction is to stop and report
 * rather than edit it. Both gaps above are fixable entirely at the call
 * site, using only `createT()`'s existing public `opts.budget` and
 * `opts.protect` parameters, so no change to translate.ts was needed.
 */

import {
  createT,
  RequestBudget,
  translate,
  translationLedgerFor,
  waitUntilFromLocals,
  type Lang,
  type TFunction,
} from "./translate.ts";

// `createRequire` itself has zero runtime side effect until invoked — it
// just returns a function. Safe as a top-level import on both deploy
// targets; only `captureSourceString()`'s actual USE of the returned
// `require` is gated behind the capture flag (see below).
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Build-instrumented chrome-string capture (docs/i18n-phase-2-brief.md,
// SECTION 7, Implementation note D) — READ THIS BEFORE TOUCHING IT.
//
// WHY THIS EXISTS: scripts/i18n-list.mjs is a SOURCE scanner — a regex over
// src/**/*.astro looking for literal `t("...")` call sites. Note D found
// that scanner structurally blind to any string that reaches `t()`/`sharedT()`
// through a variable rather than a literal at the call site — an array of
// nav items mapped over, an object of CTA labels keyed by section, etc. That
// blind list is not a corner case: it includes the ENTIRE header nav, the
// ENTIRE homepage portal grid, and the ENTIRE metrics panel, all of which
// render on every one of this site's 546 pages. No source-level regex can
// close that gap by construction (a smarter regex still can't evaluate
// `navItemsSource.map(...)` at parse time) — the only place every one of
// those strings is guaranteed to surface as a plain runtime string is
// INSIDE sharedT() itself, right before it calls translate(). So instead of
// getting smarter at reading source, this hooks the one place that already
// sees every string sharedT is ever asked to translate, and writes each one
// to a JSONL file when a build runs with the capture flag on.
//
// HOW THE WARM SCRIPT USES THIS: scripts/translate-warm.mjs sets
// I18N_CAPTURE_CHROME_STRINGS=1 (via `node --env-file=.env`-style env, or a
// plain shell export) and runs `npm run build` (the gh target — static,
// renders all 546 pages, and every page that mounts Header/Footer/
// CommandPalette/the homepage portals/MetricsPanel calls sharedT() for its
// chrome). Every distinct string sharedT() is ever called with over that
// whole build lands as one line in the capture file. The warm script then
// reads that file, de-duplicates, and treats the result as ground truth for
// "every chrome string this site actually renders" — a strict superset of
// what scripts/i18n-list.mjs can see, per note D's own accounting (304
// statically-visible strings PLUS every blind spot: Header.astro's
// navItemsSource and t(cta.sv), index.astro's portalsSource taglines and
// all eight metricsSource labels/notes, ArtistCard's "View" default,
// Discography's Albums/EPs/Singles, YouTubeFeed's freshness ternary,
// search-result.astro's "Previous artists", and the contact pages' metric
// labels).
//
// MUST STAY COMPLETELY INERT WHEN THE FLAG IS UNSET — this is the load-
// bearing property, not a nice-to-have: this file is imported by every
// single page render on BOTH build targets (gh static preview AND the cf
// Worker in production), so any behavior here that isn't a no-op when
// I18N_CAPTURE_CHROME_STRINGS is unset would ship into production chrome
// rendering. Concretely, "inert" means:
//   - No file handle, no fs import side effect, no I/O of any kind is ever
//     opened or touched unless the flag is truthy at call time.
//   - The flag is read ONCE per module instance into a plain boolean
//     (captureEnabled below), not re-read from process.env on every call —
//     cheap either way, but this keeps the hot path a single boolean check
//     with no property lookup chain.
//   - The write itself is synchronous, best-effort, and wrapped in try/catch
//     — a capture failure (e.g. running under a sandboxed environment with
//     no fs access) must never throw out of sharedT() and break a page
//     render. This is a diagnostic side channel, never a correctness
//     dependency for the request path.
//   - fs/path are imported unconditionally at module scope (a static ESM
//     import has no runtime cost beyond resolving the module graph — it
//     does not open anything), but every actual filesystem operation is
//     gated behind `captureEnabled`. On the Cloudflare Worker target, node:fs
//     does not exist as a real filesystem at all; since `captureEnabled` is
//     only ever set by the local warm-script build (gh target, plain
//     Node), the gated calls are simply never reached there — but see the
//     try/catch above for what happens if that assumption is ever wrong.
//   - No behavior change to the returned translation, no extra await, no
//     change to the memoization or budget logic below — capture is a
//     side-effecting observer bolted onto the existing return path, not a
//     new branch in it.
//
// FILE FORMAT: one JSON object per line (JSONL), `{"source": "<the exact
// string sharedT() was called with>"}` — deliberately minimal (no timestamp,
// no call-site location) because the warm script only needs the SET of
// distinct strings, not provenance. Appended, never truncated, by this
// module — scripts/translate-warm.mjs deletes/recreates the file itself
// before invoking `npm run build`, so this module never needs to know
// whether it's starting a fresh capture or continuing one.
// ---------------------------------------------------------------------------

// Read once per module instance — see "read ONCE" above. `process` is
// guarded the same way translate.ts's own readEnv() guards it, since this
// module (like translate.ts) is reachable from contexts where `process`
// is not guaranteed to exist (the CF Worker isolate under nodejs_compat
// does expose it, but being defensive here costs nothing and matches house
// convention).
const captureEnabled: boolean = (() => {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.I18N_CAPTURE_CHROME_STRINGS === "1";
})();

// Path is fixed rather than configurable — this is a build-instrumentation
// hook for exactly one consumer (scripts/translate-warm.mjs), not a general
// logging facility, so there is no configuration surface to add. Resolved
// relative to process.cwd() (the repo root, since `npm run build` always
// runs from there) rather than import.meta.url, because the latter would
// resolve into src/lib/ (or dist/ under a bundled Worker) — neither of
// which is where a build artifact belongs.
const CAPTURE_FILE_PATH = "i18n-chrome-capture.jsonl";

/**
 * Best-effort, synchronous append of one captured source string. Called
 * from sharedT()'s returned function BEFORE the memo check (see call site
 * below) so a string that this specific request's memo would otherwise
 * dedupe away still gets recorded at least once per PAGE RENDER — the
 * cross-page, cross-request union across the whole `npm run build` run is
 * what the warm script actually reads, so intra-request memoization here is
 * irrelevant to completeness (a string skipped by this request's memo was
 * necessarily captured on its FIRST call in this same request, which is all
 * that matters — the file is a set, de-duplicated by the reader, not a
 * call-count log).
 *
 * Requires `node:fs`'s synchronous `appendFileSync` rather than the async
 * `fs/promises` API on purpose: sharedT()'s returned function is NOT async
 * at the point this fires (the memo-miss path immediately calls baseT()
 * and returns a promise; capture must complete before that, not race it),
 * and introducing a fire-and-forget async write here would mean the last
 * few strings of a build could still be in flight when the build process
 * exits — a sync write side-steps that entirely at a cost (one blocking
 * syscall per distinct chrome string touched, at most a few hundred over an
 * entire 546-page build) that is only ever paid when the capture flag is
 * explicitly on.
 */
function captureSourceString(source: string): void {
  if (!captureEnabled) return; // the entire hot-path cost when unset: one boolean check.
  try {
    // node:fs is resolved lazily, the first time capture is actually used:
    // this module is imported by every page render on both deploy targets,
    // and a top-level `import "node:fs"` would pull it in unconditionally
    // (including on the CF Worker, where it is not a real filesystem).
    // `createRequire` gives a SYNCHRONOUS require in ESM with no side effect
    // until called, so no write can race the process exiting the way an
    // `await import()` on the first capture could.
    if (!requireRef) {
      requireRef = createRequire(import.meta.url);
    }
    const fs = requireRef("node:fs") as typeof import("node:fs");
    fs.appendFileSync(CAPTURE_FILE_PATH, JSON.stringify({ source }) + "\n", "utf8");
  } catch {
    // Never let a diagnostic capture failure break a page render — see
    // "MUST STAY COMPLETELY INERT" above. Silently dropped by design.
  }
}

/** Lazily created synchronous `require`, only ever touched when capture is
 *  enabled — see captureSourceString() above. */
let requireRef: NodeRequire | null = null;

/**
 * Shape this module needs from `Astro.locals`. Deliberately structural (see
 * translate.ts's own `LocalsWithScheduler` for the same reasoning) — no
 * `App.Locals` type exists anywhere in this codebase.
 */
interface LocalsForT {
  lang?: Lang;
  cfContext?: { waitUntil?: (promise: Promise<unknown>) => void };
  /** Stashed by `sharedT()` on first use per request — see GAP 1 above. */
  __i18nBudget?: RequestBudget;
  /** Per-request ledger of resolved translations — see translate.ts's route bundles. */
  __i18nLedger?: Map<string, string>;
}

/**
 * Per-request memo table, keyed off the SAME `locals` object every component
 * in a render shares. A `WeakMap` (not a plain object on `locals` itself)
 * so this module never mutates the shape of `Astro.locals` with anything
 * other than the one budget field it already owns, and so entries are
 * automatically released once a request's `locals` object is garbage
 * collected — no manual per-request cleanup needed. Keyed by locals identity
 * rather than a request id because nothing in this codebase threads a
 * request id through today, and `locals` already IS the one-per-request
 * object every call site has in hand.
 */
const memoTables = new WeakMap<object, Map<string, Promise<string>>>();

/**
 * The one call site every page/component should use instead of calling
 * `createT()` directly (docs/i18n-phase-2-brief.md section 4's wiring
 * choice — see the PR description for the full "why `Astro.locals` over a
 * threaded `t` prop" reasoning). Pass `Astro.locals` straight through.
 *
 * Returns a `TFunction` (`(source: string) => Promise<string>`) exactly like
 * `createT()` does — this is a drop-in wrapper, not a different API — so
 * every call site still reads as `await t("Some copy")`.
 */
export function sharedT(
  locals: LocalsForT,
  opts?: {
    protect?: string[];
  },
): TFunction {
  const l = locals as LocalsForT;
  // GAP 1 fix: create the budget once per request, reuse thereafter. `locals`
  // is the same object for every component in this render (Astro shares one
  // `Astro.locals` across a whole request, including nested components —
  // src/middleware.ts already depends on this for `locals.lang`), so
  // stashing state here is the one place available that doesn't require
  // threading a new prop through every component signature in the app.
  if (!l.__i18nBudget) {
    l.__i18nBudget = new RequestBudget();
  }
  const budget = l.__i18nBudget;

  const baseT = createT(locals, { protect: opts?.protect, budget, ledger: translationLedgerFor(l) });

  // GAP 2 fix: memoize by exact source string for the lifetime of this
  // request's `locals` object. Concurrent callers awaiting the same source
  // string share one in-flight promise rather than each independently
  // calling `translate()` (which would otherwise mean each one separately
  // hashes the string, checks the override file, checks KV, and — on a
  // cache miss — separately calls `budget.tryConsume()`, burning multiple
  // slots on what is semantically one distinct translation job).
  let table = memoTables.get(l);
  if (!table) {
    table = new Map();
    memoTables.set(l, table);
  }
  const memo = table;

  return (source: string): Promise<string> => {
    // Build-instrumented chrome-string capture (note D) — see the doc
    // comment above captureSourceString() for the full rationale. Fires on
    // EVERY call, including a memo hit: this function is the one place in
    // the whole render tree guaranteed to see every source string sharedT()
    // is ever asked to translate, and the warm script only needs the SET of
    // distinct strings across the whole build, not a call count — so
    // capturing ahead of the memo check (rather than only on a miss) is
    // simpler and just as correct. Inert (single boolean check, see above)
    // unless I18N_CAPTURE_CHROME_STRINGS=1.
    captureSourceString(source);

    const cached = memo.get(source);
    if (cached) return cached;
    // .catch here rather than relying on translate() never throwing: the memo
    // stores the promise BEFORE it settles, so a single rejection would be
    // replayed to every later caller in the render with no retry — and since
    // this now runs on every page, that failure would be silent and total.
    // Falling back to the source string makes the module's contract ("never
    // block, never blank a page") explicit at the memo layer instead of an
    // inherited property of translate.ts that a future edit could regress.
    const job = baseT(source).catch(() => source);
    memo.set(source, job);
    return job;
  };
}

// ---------------------------------------------------------------------------
// FM CONTENT (decision 8 + the Definition of done's bio requirement)
// ---------------------------------------------------------------------------

/**
 * Translate a piece of FM-sourced CONTENT — a news title, an excerpt, a bio,
 * a tagline — as opposed to UI chrome.
 *
 * WHY THIS IS SEPARATE FROM sharedT()/t():
 *
 *   - Tier. Chrome is the voice of the site and goes `quality`. Entity prose
 *     is high-volume and goes `fast`, matching how scripts/translate-warm.mjs
 *     warmed it. The tier is part of the cache key, so a mismatch here means
 *     a guaranteed permanent miss against an already-warmed entry — the exact
 *     class of bug Implementation note E describes for double-translation.
 *   - Kind. A bio is markdown and must survive translation byte-for-byte
 *     except the prose (decision 8); a title is a title. Chrome is always
 *     plain.
 *   - Protected names. An artist/client/talent name must never be
 *     "translated" into nonsense, so the entity in scope is passed through
 *     `protect` on top of the fixed list (decision 7).
 *
 * WHY IT REUSES sharedT's BUDGET AND MEMO: a news index renders ~20 cards,
 * each with a title and an excerpt, on top of the page's own chrome. Those
 * all have to answer to ONE per-request ceiling (note C), or a single render
 * could fan out unboundedly. Passing the same `locals` object through
 * `createT`'s `budget` option is what keeps one budget for the whole render.
 *
 * Degrades exactly like chrome: a cache miss returns the SOURCE text and
 * schedules the translation via waitUntil (decision 6). A Swedish news title
 * on an English page for one render is the intended failure mode — never a
 * blank card, never a blocked response.
 */
export function fmText(
  locals: LocalsForT,
  opts?: { protect?: string[]; lang?: Lang },
): (source: string | null | undefined, kind?: "plain" | "markdown" | "title") => Promise<string> {
  const l = locals as LocalsForT;
  if (!l.__i18nBudget) l.__i18nBudget = new RequestBudget();
  const budget = l.__i18nBudget;

  const target = opts?.lang ?? l.lang ?? "sv";
  const waitUntil = waitUntilFromLocals(l);

  // Memoize per (source, kind) on the same per-request table sharedT uses, so
  // a title and a bio with identical text don't collide and a repeated field
  // across cards costs one call.
  let table = memoTables.get(l);
  if (!table) {
    table = new Map();
    memoTables.set(l, table);
  }
  const memo = table;

  return async (source, kind = "plain") => {
    // TRIM before hashing. scripts/translate-warm.mjs's job() trims every
    // source string it collects, so the warm cache is keyed on TRIMMED text.
    // FM fields routinely carry a stray leading/trailing newline, and a
    // single byte of whitespace produces a completely different sha256 — the
    // page would look up a key the warm run never wrote and miss forever.
    //
    // Found via a Nation bio: raw 2378 chars -> key e677db56..., trimmed 2377
    // -> key 547e20fb..., and only the trimmed one existed in KV. 1 of 9
    // Nation bios was affected, which is why some detail pages translated and
    // others silently did not. Trimming is also just correct on its own —
    // leading whitespace is not content worth translating or caching.
    const text = typeof source === "string" ? source.trim() : "";
    if (!text) return text;

    const memoKey = `fm:${kind}:${text}`;
    const hit = memo.get(memoKey);
    if (hit) return hit;

    const job = translate({
      text,
      target,
      tier: "fast",
      kind,
      protect: opts?.protect,
      waitUntil,
      budget,
      ledger: translationLedgerFor(l),
    })
      .then((r) => r.text)
      .catch(() => text);

    memo.set(memoKey, job);
    return job;
  };
}

/** Avoid re-keying locale-resolved FM prose as if it were new source text. */
export function resolveFmDisplayText(
  text: string,
  translateText: (source: string) => Promise<string>,
  alreadyTranslated: boolean,
): Promise<string> {
  return alreadyTranslated ? Promise.resolve(text) : translateText(text);
}
