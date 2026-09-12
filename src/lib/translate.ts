/**
 * Claude-backed translation for Phase 2 i18n (docs/i18n-phase-2-brief.md).
 *
 * Two independent jobs live here:
 *
 *   1. `translate()` — the general-purpose "translate this text into
 *      {target}" primitive. Used for FM prose (bios, releases, news) and for
 *      hardcoded chrome copy alike; both go through the SAME cache and the
 *      SAME output contract, because both have the same failure modes (an
 *      API hiccup must never 500 or blank a page, a proper noun must never
 *      get "translated" into nonsense).
 *   2. `createT()` — the ergonomic per-request binding pages/components call
 *      as `t("Some copy")`. It closes over `locals.lang` so call sites don't
 *      have to thread the target language through every call.
 *
 * Provider: raw `fetch` against the Anthropic Messages API, no SDK — the
 * brief is explicit that this repo does not take on `@anthropic-ai/sdk` as a
 * dependency for what is, at the volumes involved, a handful of fields per
 * request. Model IDs below were pulled from the bundled `claude-api` skill at
 * implementation time (skill cache date 2026-06-24), not from training-data
 * memory, because model ID strings drift and a stale one is a silent 404 in
 * production:
 *
 *   fast    → claude-haiku-4-5   ($1 / $5 per MTok)  — bios, releases, news, blurbs
 *   quality → claude-sonnet-5    ($2 / $10 per MTok) — chrome, landing/category
 *                                                       copy, guides, contact
 *                                                       copy, meta descriptions
 *
 * WHY A PERMANENT KV CACHE (decision 7): FM content barely changes week to
 * week, and a translation of a given source string never needs to change
 * unless the system prompt itself changes (hence the `v1` version prefix,
 * bumped by hand when the prompt is edited — every existing translation
 * becomes an intentional cache miss exactly once, not a silent staleness
 * bug). Keying on `sha256(source)` rather than an entity id means an edited
 * FM field is automatically a new key — no invalidation logic needed, the
 * old translation simply stops being addressed.
 *
 * WHY THIS WRITES `CACHE_STATE` DIRECTLY (`kv.get`/`kv.put`) INSTEAD OF
 * ROUTING THROUGH `kvCached()` (src/lib/cache.ts): `kvCached` is built for a
 * different shape of problem — a single, short, numeric TTL per namespace,
 * plus a negative-result guard that intentionally shortens the TTL of an
 * empty/null result so a transient API hiccup can't pin "no data" for the
 * full period. Neither concern applies here: this cache has NO TTL at all
 * (permanence is the entire point — see above), the key already varies per
 * call (content-addressed, not one shared namespace key), and "no result
 * yet" is not a value this module ever stores — a miss returns source text
 * to the caller and simply does not write to KV until a real translation
 * exists (see `translateAndStore`). Forcing this through `kvCached`'s
 * TTL-shaped API would mean inventing a fake "TTL" for a cache that must
 * never expire, which is more confusing than reading `kv.get`/`kv.put`
 * directly.
 *
 * WHY NEVER BLOCK A RENDER (decision 6): translation is a "nice to have,
 * eventually" feature bolted onto a "the page must render" requirement. The
 * FM data layer (src/lib/filemaker.ts, src/lib/cache.ts) already treats an
 * external API as something that degrades, never something that blocks —
 * this module holds to the same discipline. A cache miss returns the source
 * text immediately (so the page is fast and never blank) and reports the
 * SOURCE language so the caller can set an honest `lang` attribute on the
 * element; the actual translation is scheduled to run after the response is
 * already on the wire, and lands in KV for the next request.
 */

// Explicit .ts extensions on these relative imports (unlike most src/lib
// files, which omit them under Vite's resolver): this module is imported
// DIRECTLY by test/translate.test.mjs under plain `node
// --experimental-strip-types`, which has no bundler-style extension
// resolution — an extensionless specifier throws ERR_MODULE_NOT_FOUND at
// test time even though it works fine under Astro/Vite. Same convention
// src/pages/api/publish.ts already uses for the same reason (it too is
// imported directly by a node:test file).
import { getCfEnv } from "./cf.ts";
import type { KvLike } from "./cache.ts";
import { timeServer } from "./server-timing.ts";

// ---------------------------------------------------------------------------
// Env resolution
// ---------------------------------------------------------------------------

/**
 * Same two-step resolution as src/lib/filemaker.ts's `runtimeEnv` and
 * src/lib/site.ts's `readEnv`: prefer whatever Vite baked into
 * `import.meta.env` at build time, else fall back to `process.env` so a
 * value supplied as a live Worker binding (nodejs_compat) or a plain
 * shell/`.env` var (the local warm script, plain `node:test`) is still
 * picked up. `import.meta.env` itself is guarded because this module is
 * imported directly by node:test with no Vite involved.
 */
function readEnv(name: string): string | undefined {
  const meta = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const baked = meta?.[name];
  if (typeof baked === "string" && baked) return baked;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/**
 * Resolve the Anthropic API key. On the Worker it arrives as a secret
 * binding via `getCfEnv()` (mirroring how PUBLISH_PASSWORD etc. are read);
 * locally and in the warm script it comes from `.env` / the shell via
 * `process.env`. Async because `getCfEnv()` is (it dynamic-imports
 * `cloudflare:workers`, which does not exist under Node and must be probed
 * rather than assumed) — every call site here is already async, so this
 * costs nothing.
 */
async function resolveApiKey(): Promise<string | undefined> {
  const env = await getCfEnv();
  const fromBinding = env?.ANTHROPIC_API_KEY;
  if (typeof fromBinding === "string" && fromBinding) return fromBinding;
  return readEnv("ANTHROPIC_API_KEY");
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Lang = "sv" | "en";
export type Tier = "fast" | "quality";
export type Kind = "plain" | "markdown" | "title";

export interface TranslateOptions {
  text: string;
  target: Lang;
  tier: Tier;
  kind?: Kind; // default "plain"
  /** Extra do-not-translate strings beyond the fixed list — entity names in scope (artist/client/talent). */
  protect?: string[];
  /**
   * Injected scheduler for post-response work, so callers/tests control it
   * explicitly instead of this module reaching into Astro globals. See
   * `waitUntilFromLocals()` below for the helper that builds one from
   * `Astro.locals`.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Injectable KV, defaults to the live CACHE_STATE binding via getCfEnv(). Lets tests avoid getCfEnv() entirely. */
  kv?: KvLike | null;
  /** Injectable budget tracker — see `RequestBudget` below. Omit to run unbudgeted (e.g. the warm script). */
  budget?: RequestBudget;
  /**
   * Per-request ledger of every (KV key → value) this call resolved from the
   * cache. The middleware writes it back as the route's translation bundle —
   * see "Per-route translation bundles" below. Carried on `Astro.locals` by
   * src/lib/t.ts (the same object the budget rides on), NOT in
   * AsyncLocalStorage: measured on staging, the async context does not
   * survive into Astro child-component rendering under workerd (only a page's
   * own frontmatter reads were captured), so an ALS ledger would have missed
   * every string Header, Footer, RosterIndex and every card resolve.
   */
  ledger?: Map<string, string>;
}

export interface TranslateResult {
  text: string;
  cached: boolean;
  /** The language the returned `text` is actually IN — "target" on a cache hit, "source" (best-effort-detected) on a miss. */
  lang: Lang;
}

// ---------------------------------------------------------------------------
// Cache key (decision 7)
// ---------------------------------------------------------------------------

/**
 * Bump this when the system prompt (buildSystemPrompt below) changes in any
 * way that could change output — wording, the do-not-translate mechanism,
 * the output-contract rules. Every existing KV entry keyed under the old
 * version becomes an ordinary cache miss (re-translated once, on next
 * access) rather than silently serving text translated under a prompt that
 * no longer reflects house style.
 */
export const TRANSLATION_KEY_VERSION = "v1";

/**
 * SHA-256 hex digest via Web Crypto — the same primitive src/lib/http.ts's
 * `sha256Hex` and src/pages/api/publish.ts already use, so this module stays
 * consistent with house practice rather than introducing a second hashing
 * approach. Not imported from http.ts directly: that module is documented as
 * dependency-free for Cloudflare API routes specifically, and duplicating six
 * lines here avoids coupling this module's import graph to it.
 */
async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * `tr:v1:{target}:{tier}:{sha256(source)}` — content-addressed, so an edited
 * FM field or chrome string is automatically a fresh key with no explicit
 * invalidation step. `tier` is part of the key (not just an implementation
 * detail) because fast and quality genuinely produce different prose for the
 * same input — collapsing them onto one key would mean whichever tier ran
 * first silently wins forever, even if a later call asks for the other.
 *
 * MUST STAY PURE (brief, decision 7 / Build item): scripts/translate-warm.mjs
 * imports this from plain Node to write the exact same keys the live site
 * will later read. No `import.meta.env`, no Astro, no network — a
 * side-effect creeping in here would make the warm script's keys silently
 * diverge from request-time keys, which is a "translations never used"
 * class of bug that would go unnoticed until a manual KV diff.
 */
export async function translationKey(source: string, target: Lang, tier: Tier): Promise<string> {
  const hash = await sha256Hex(source);
  return keyFromHash(hash, target, tier);
}

/**
 * Same key format as `translationKey`, but takes an already-computed hash
 * instead of re-hashing `source` (P2: `translate()` needs the sha256 of the
 * source text for BOTH the override lookup and the cache key, and hashing
 * twice per call was pure waste). Not exported — `translationKey(source,
 * target, tier)` stays the one public, hash-from-source entry point the warm
 * script (decision 9) and external callers use; this is purely an internal
 * factoring so `translate()` can hash once and reuse the result.
 */
function keyFromHash(hash: string, target: Lang, tier: Tier): string {
  return `tr:${TRANSLATION_KEY_VERSION}:${target}:${tier}:${hash}`;
}

// ---------------------------------------------------------------------------
// Overrides (decision 5)
// ---------------------------------------------------------------------------

type OverridesFile = Record<string, Partial<Record<Lang, string>>>;

// Loaded once per module instance (build, or per Worker isolate) — overrides
// are a file shipped in the repo, not something that changes between
// requests, so re-reading it per call would be pure waste.
//
// `with { type: "json" }` is REQUIRED here, not optional decoration: plain
// Node 22 ESM (the runtime test/translate.test.mjs actually runs under)
// throws `... needs an import attribute of "type: json"` on a bare
// `import("../i18n/overrides.json")` with no attribute — verified directly
// against this file. An earlier version of this comment claimed import
// attributes "vary in support" and omitted them for that reason; that
// reasoning was backwards for JSON specifically — Node requires the
// attribute, and Vite/Astro's bundler-mode resolver (moduleResolution:
// "Bundler", resolveJsonModule: true in the shared tsconfig) accepts it as
// well, so including it is what actually works identically everywhere.
// Without it, `loadOverrides()`'s `.catch(() => ({}))` below silently
// swallowed the failure and every override lookup quietly no-op'd — decision
// 5 never actually fired, and the only reason it went unnoticed is that the
// bug and an empty `overrides.json` fixture produce the same observable
// behavior (see test/translate.test.mjs's P1-7 fix for how this was caught).
let overridesPromise: Promise<OverridesFile> | null = null;

function loadOverrides(): Promise<OverridesFile> {
  if (!overridesPromise) {
    overridesPromise = import("../i18n/overrides.json", { with: { type: "json" } })
      .then((m) => (m.default ?? m) as OverridesFile)
      .catch(() => ({}) as OverridesFile);
  }
  return overridesPromise;
}

/**
 * Override lookup keyed the same way the live cache is — sha256 of the exact
 * source string — so a human edit in overrides.json and a machine
 * translation for the same source string are indistinguishable to the
 * lookup path. `overrides.json` shape: `{ "<sha256 of source>": { "sv":
 * "...", "en": "..." } }` (documented here since JSON cannot hold comments).
 *
 * Takes the already-computed hash (P2) rather than the source string itself
 * — `translate()` needs this same hash a moment later for the KV cache key,
 * and hashing the same string twice per call was pure waste.
 */
export async function lookupOverride(hash: string, target: Lang): Promise<string | null> {
  const overrides = await loadOverrides();
  const entry = overrides[hash];
  const value = entry?.[target];
  return typeof value === "string" && value ? value : null;
}

// ---------------------------------------------------------------------------
// Do-not-translate list (decision 7)
// ---------------------------------------------------------------------------

/**
 * Fixed do-not-translate list, per the brief verbatim. These are proper
 * nouns that must survive translation byte-for-byte regardless of which
 * entity or page is being translated — a division name or city name
 * "translated" into English/Swedish would be a factual error, not a style
 * choice.
 */
export const FIXED_PROTECTED_TERMS: readonly string[] = [
  "Ninetone",
  "Ninetone Group",
  "Ninetone Records",
  "Ninetone Management",
  "Ninetone Nation",
  "Sundsvall",
  "Stockholm",
];

/**
 * SUBSTITUTION (documented per the brief's own "list every substitution"
 * rule): the brief says to build the booking-category part of the
 * do-not-translate list by "import[ing]" `API_BOOKING_TAG`. That name does
 * not exist as an exported constant anywhere in this codebase — it is only
 * an FM *layout* name (see the fmFindWithPortals("API_BOOKING_TAG", ...)
 * call in src/lib/ninetone.ts), and the six category label strings it
 * returns (Artist, Föreläsare, Konferencier, Moderator, Underhållare,
 * Influencer) exist ONLY as live FM data behind `getBookingCategories()`,
 * an async network call. There is no synchronous, hand-copyable list to
 * import — hand-copying the six strings here would be exactly the drift risk
 * CLAUDE.md warns against ("names must never be translated" stops being true
 * the day someone renames a category in FM and this file isn't updated).
 *
 * Resolved by importing `getBookingCategories` itself (not a copy of its
 * output) and reading `.tag` off each live category at request time, same as
 * any other FM read in this codebase. This keeps the protected-term list
 * correct by construction instead of by discipline. The cost is that
 * `buildProtectedTerms()` is async and makes one (cached — see
 * src/lib/ninetone.ts's use of src/lib/filemaker.ts's fmFindWithPortals,
 * which is wrapped in the existing 60s in-process cache) FM read; callers
 * that already have the booking categories in scope should prefer passing
 * the tags through `protect` directly rather than triggering a redundant
 * fetch.
 */
async function bookingCategoryTags(): Promise<string[]> {
  try {
    const { getBookingCategories } = await import("./ninetone.ts");
    const categories = await getBookingCategories();
    return categories.map((c) => c.tag).filter((tag): tag is string => Boolean(tag));
  } catch (err) {
    // Never let a translation call fail because the booking-category fetch
    // failed — worst case, a category label gets translated on some render,
    // which is a quality nit, not a broken page. Matches this module's
    // overall "degrade, never block" posture.
    console.error("[translate] failed to load API_BOOKING_TAG labels for do-not-translate list:", err);
    return [];
  }
}

/**
 * Full protected-term list for one call: caller-supplied `protect` (the
 * entity in scope — an artist/client/talent name) + the fixed list + the
 * live booking-category tags. Exported so `t()` and tests can build the same
 * list without duplicating the assembly rule.
 */
export async function buildProtectedTerms(protect: readonly string[] = []): Promise<string[]> {
  const tags = await bookingCategoryTags();
  // De-duplicate — the same name could appear in `protect` AND the fixed
  // list (e.g. a component protecting "Ninetone Nation" itself). A duplicate
  // in the prompt's do-not-translate list is harmless but noisy.
  const deduped = new Set([...protect, ...FIXED_PROTECTED_TERMS, ...tags]);
  // Sorted (P1-8), not just deduplicated: `bookingCategoryTags()` reads live
  // FM data through `getBookingCategories()`, and FM does not guarantee
  // stable ordering across requests — `[...new Set(...)]` alone would let
  // the do-not-translate line in the system prompt vary in ORDER between
  // otherwise-identical calls even though its CONTENT is unchanged. Prompt
  // caching (P1-8, see `callAnthropic`) is a byte-exact prefix match — a
  // reordered do-not-translate list would silently break the cache on every
  // call whose only difference is FM's response order, defeating the whole
  // point of adding `cache_control` in the first place.
  return [...deduped].sort();
}

// ---------------------------------------------------------------------------
// System prompt / output contract (decisions 4, 8, 10)
// ---------------------------------------------------------------------------

const KIND_INSTRUCTIONS: Record<Kind, string> = {
  plain: "The input is plain prose text.",
  markdown:
    "The input is Markdown. Preserve ALL Markdown syntax, links, and line breaks byte-for-byte — " +
    "only translate the prose content. Do not add, remove, or reformat any Markdown structure.",
  title: "The input is a short title or heading. Keep it concise; do not add trailing punctuation that wasn't there.",
};

/**
 * One prompt, both directions (decision 4): rather than branching on
 * "detected source language", the model is simply told what the TARGET is
 * and instructed to return the input unchanged if it's already in that
 * language. This is strictly simpler than running a separate
 * language-detection step, and it's the model's actual strength — Claude
 * reads the input either way, so asking it to also decide "is this already
 * {target}?" is free relative to the translation itself.
 */
/**
 * Exported alongside `callWithGuard` for the warm script (Implementation
 * note A): the script must never assemble its own system prompt. Also the
 * unit of the `cache_control` prompt-cache prefix — see `callAnthropic`.
 */
export function buildSystemPrompt(target: Lang, kind: Kind, protectedTerms: readonly string[]): string {
  const targetName = target === "sv" ? "Swedish" : "English";
  const protectLine =
    protectedTerms.length > 0
      ? `Never translate, transliterate, or alter these exact strings wherever they appear: ${protectedTerms.join(", ")}.`
      : "";

  return [
    `You are a professional translator. Translate the user's message into ${targetName}.`,
    `If the message is already written in ${targetName}, return it completely unchanged.`,
    KIND_INSTRUCTIONS[kind],
    protectLine,
    // Output contract (decision 10): the guard below rejects anything that
    // doesn't hold to this, so the prompt and the guard must describe the
    // exact same contract or the retry-then-fallback path fires constantly
    // on well-formed output.
    "Respond with ONLY the translated text. No preamble, no quotation marks around the " +
      'output, no commentary, no labels like "Translation:" or "Here is the translation:", ' +
      "and do not name the source language anywhere in your response.",
  ]
    .filter(Boolean)
    .join(" ");
}

// Both label names, unconditionally (P1-4 fix — see the doc comment on
// `violatesOutputContract` for why this replaced a `sourceLang`-scoped
// list).
const ALL_LANGUAGE_LABEL_NAMES = ["swedish", "svenska", "english", "engelska"] as const;
const ALL_LANGUAGE_LABEL_NAMES_ALT = ALL_LANGUAGE_LABEL_NAMES.join("|");

// "Here ... translat..." / "Här är ... översätt..." — the shape a preamble
// actually takes ("Here is the translation:", "Heres the translated text",
// "Här är översättningen:"), not a bare "starts with here/här är" check.
// Anchoring on the word stem translat/översätt (English or Swedish alike, so
// this catches a preamble in either translation direction — decision 4 is
// bidirectional) rather than a colon position means ordinary sentences that
// happen to start with "Here" ("Here comes the sun...") or "Här är"
// ("Här är låtarna som...", plain Swedish for "Here are the songs that...")
// are never touched, because neither contains "translat"/"översätt" within
// a few words of the opening. The `.{0,20}?` gap tolerates "Here IS THE
// translation" / "Here's the translated text" without also matching a
// sentence that merely mentions translation forty words in.
const HERE_PREAMBLE_RE = /^here.{0,20}?translat/i;
const SV_PREAMBLE_RE = /^här är.{0,20}?översätt/i;
const LABEL_PREAMBLE_RE = /^(translation|översättning)\s*:/i;

/**
 * Output-contract guard (decision 10). Anthropic's own text response is
 * whatever Claude wrote — there is no structured-output enforcement in play
 * here (this is plain prose translation, not a schema), so the contract is
 * enforced entirely on this side: reject anything that looks like the model
 * added a preamble or a label instead of just answering.
 *
 * CORRECTED (P0-3): the original version of this guard rejected real,
 * publishable copy — verified false positives included "Här är låtarna som
 * definierade hans karriär." (ordinary Swedish, matched a bare `^här är`
 * prefix that had nothing to do with a translation preamble), "Here comes
 * the sun — the band's breakout single." (matched a bare `^here` prefix for
 * the same reason), "Swedish-Norwegian duo formed in 2019." and
 * "English-language debut album." (both matched a label-prefix regex whose
 * `[:\-]` alternation treated a hyphen glued to a compound adjective as if
 * it were a "Label: text" separator). Each false positive silently burned a
 * doubled fast→quality API escalation on every request forever (the
 * content-addressed permanent cache never gets a chance to write, so
 * nothing self-heals) and the render never actually got translated text —
 * a correctness bug with a real ongoing cost, not just a style nit.
 *
 * Checked as a set of narrow, specific patterns rather than one broad
 * heuristic (e.g. "response contains a colon") to keep false-positive rate
 * low — legitimate translated prose can absolutely contain a colon or a
 * hyphenated compound adjective.
 */
export function violatesOutputContract(response: string): boolean {
  const trimmed = response.trim();
  if (!trimmed) return true;
  if (HERE_PREAMBLE_RE.test(trimmed) || SV_PREAMBLE_RE.test(trimmed) || LABEL_PREAMBLE_RE.test(trimmed)) return true;

  // "contain the source language name as a label" (brief, decision 10) —
  // read narrowly as a label-shaped prefix ("Swedish:", "(English)") rather
  // than "the word appears anywhere", since a translated sentence that
  // happens to legitimately discuss Sweden/England (or a hyphenated
  // adjective like "Swedish-Norwegian") must not be rejected.
  //
  // P1-4 fix: this used to take a `sourceLang` parameter and only check
  // THAT language's names (plus the target's) — e.g. calling this en→en
  // would only ever check for "English"/"Engelska" labels, so a genuinely
  // wrong "Svenska: Boka oss" response for an already-English string sailed
  // straight through the guard and got cached permanently. All four names
  // (Swedish, Svenska, English, Engelska) are now always checked regardless
  // of direction — a label in either language is equally a contract
  // violation, and there is no case where checking fewer names is correct.
  // Two label shapes, matched separately rather than with one clever pattern:
  //   "Swedish: ..."                     — bare name, COLON separator only.
  //                                         A dash is deliberately excluded
  //                                         here (P0-3): "Swedish-Norwegian"
  //                                         and "English-language" are real,
  //                                         common compound adjectives in
  //                                         music-label copy, and a dash
  //                                         glued directly to the next word
  //                                         is never how a translator labels
  //                                         a response — a genuine label-dash
  //                                         reads "Swedish - Hej", with
  //                                         space on both sides, which the
  //                                         `\s-\s` alternative still catches.
  //   "(English) ..."                    — parenthesized, the closing paren
  //                                         IS the separator (no colon/dash
  //                                         follows it in natural phrasing).
  const bareLabelRe = new RegExp(`^(${ALL_LANGUAGE_LABEL_NAMES_ALT})\\s*(:|\\s-\\s)`, "i");
  const parenLabelRe = new RegExp(`^\\((${ALL_LANGUAGE_LABEL_NAMES_ALT})\\)`, "i");
  if (bareLabelRe.test(trimmed) || parenLabelRe.test(trimmed)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Per-request budget (decision — Build item)
// ---------------------------------------------------------------------------

const MAX_UNCACHED_CALLS_PER_RENDER = 25;

/**
 * Tracks uncached API calls across one render. A page can legitimately touch
 * dozens of translatable strings (chrome + FM fields); without a ceiling a
 * single cold render (fresh deploy, or the first hit after a prompt-version
 * bump invalidates everything) could fire dozens of concurrent Anthropic
 * calls and either blow the request's CPU-time budget on the Worker or rack
 * up an unbounded bill from one visitor's page load. Past the budget,
 * `translate()` degrades exactly like a cache miss during an outage: return
 * source, schedule for later. One instance is meant to be created per
 * request and threaded through every `translate()` call for that render (via
 * `TranslateOptions.budget` or a `createT()` binding); a fresh instance per
 * call would defeat the point.
 */
export class RequestBudget {
  // Not TS parameter-property shorthand (`constructor(private readonly
  // max...)`) — this repo's test runner invokes plain Node's
  // `--experimental-strip-types`, which only strips type syntax and does not
  // support that shorthand's implicit field declaration+assignment; it
  // throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at parse time. Explicit fields
  // + a plain constructor body work under both the strip-only test runner
  // and Astro's full TS pipeline.
  private readonly max: number;
  private used = 0;
  private refused = 0;

  constructor(max: number = MAX_UNCACHED_CALLS_PER_RENDER) {
    this.max = max;
  }

  /** True (and consumes one slot) if a call is still allowed this render. */
  tryConsume(): boolean {
    if (this.used >= this.max) {
      this.refused += 1;
      return false;
    }
    this.used += 1;
    return true;
  }

  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }

  /** Uncached strings this render scheduled (each rendered as source text). */
  get consumedCount(): number {
    return this.used;
  }

  /**
   * Every string that rendered as SOURCE text this render: the ones scheduled
   * (consumed) plus the ones refused. Non-zero means the page is incomplete
   * in its target language, whether or not the ceiling was reached — an
   * edited FM field alone makes one miss (Codex review, 2026-09-12).
   */
  get missCount(): number {
    return this.used + this.refused;
  }

  /**
   * How many uncached strings this render had to leave untranslated AND
   * unscheduled because the ceiling was already reached. Non-zero means the
   * rendered page is knowingly incomplete in its target language — the
   * middleware uses this to keep such a page out of the long-TTL edge cache
   * (see "degraded" in src/middleware.ts).
   */
  get refusedCount(): number {
    return this.refused;
  }
}

// ---------------------------------------------------------------------------
// waitUntil scheduling (decision 6)
// ---------------------------------------------------------------------------

/**
 * Minimal shape this module needs from `Astro.locals` to find a scheduler.
 * Deliberately structural (not imported from an `App.Locals` type) because
 * no such type exists in this codebase yet (no env.d.ts) — defining one here
 * would make this module the accidental source of truth for the global
 * Locals shape, which is out of scope for a translation helper.
 */
export interface LocalsWithScheduler {
  /**
   * What `@astrojs/cloudflare` 14.3.1 actually sets: `createLocals(ctx)` in
   * the adapter's own `dist/utils/cf-helpers.js` always assigns
   * `{ cfContext: ctx }`, where `ctx` is the Worker's real
   * `ExecutionContext` (the thing with `.waitUntil`) — verified directly in
   * `node_modules/@astrojs/cloudflare/dist/utils/cf-helpers.js`. This is
   * live on every CF request, not a maybe.
   */
  cfContext?: { waitUntil?: (promise: Promise<unknown>) => void };
}

/**
 * AMBIGUITY IN THE BRIEF, RESOLVED — corrected version: decision 6 names
 * `Astro.locals.runtime.ctx.waitUntil` as the CF path. That name is REMOVED
 * in the adapter version this repo runs. The same `createLocals()` in
 * `@astrojs/cloudflare` 14.3.1 also defines a non-enumerable `locals.runtime`
 * whose `ctx` (and `env`/`cf`/`caches`) accessors unconditionally THROW:
 * "Astro.locals.runtime.ctx has been removed in Astro v6. Use
 * 'Astro.locals.cfContext' instead." `locals.runtime` itself is always a
 * real object (never undefined), so `locals?.runtime?.ctx` does NOT
 * short-circuit — optional chaining only guards against `null`/`undefined`
 * receivers, not a throwing getter, so reading `.ctx` throws the moment it's
 * touched regardless of the `?.` in front of it. Code that ever falls back
 * to `locals.runtime?.ctx?.waitUntil` (the shape the brief describes)
 * crashes on literally every request where `cfContext` is missing or
 * incomplete — i.e. the fallback branch, the one meant to catch the
 * degraded case, is the one guaranteed to blow up.
 *
 * Resolved by reading ONLY `cfContext.waitUntil` — the adapter's real,
 * currently-supported binding — and never touching `locals.runtime` at all.
 * `src/middleware.ts`'s own `cfContext?.waitUntil` pattern already assumed
 * this was the live path; this function now matches that assumption instead
 * of second-guessing it with a fallback to a deliberately-throwing shim.
 */
export function waitUntilFromLocals(
  locals: LocalsWithScheduler | null | undefined,
): ((promise: Promise<unknown>) => void) | undefined {
  return locals?.cfContext?.waitUntil;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API call (decision 3)
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Model IDs from the claude-api skill's current model table (cached
// 2026-06-24) — NOT from training-data recall. `fast`/`quality` map exactly
// to decision 3's tier assignment.
const MODEL_IDS: Record<Tier, string> = {
  fast: "claude-haiku-4-5",
  quality: "claude-sonnet-5",
};

const MAX_RETRIES = 1; // one retry beyond the initial attempt, per transient status
const RETRYABLE_STATUS = new Set([429, 529]);
const BASE_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Non-streaming default per the claude-api skill's own guidance ("For
// non-streaming requests, default to ~16000 (keeps responses under SDK HTTP
// timeouts)"). The original 4096 truncated any long-form field — a bio, a
// /guider/ article — mid-sentence; a truncated response has neither a
// preamble nor a label, so it sailed straight through the old guard and got
// written into the permanent, content-addressed, no-TTL cache with no way to
// self-heal (P1-5). 16000 output tokens covers this site's longest FM prose
// fields with headroom and stays well inside Haiku/Sonnet's non-streaming
// timeout budget for a single short system+user exchange.
const MAX_OUTPUT_TOKENS = 16000;

type AnthropicCallResult = { text: string; truncated: boolean };

/**
 * One call to the Messages API for a given tier. No thinking, no tools — this
 * is a single short-prompt, short-output text transform, the "Single text
 * classification/summarization/extraction/Q&A" case the skill's own
 * surface-selection table calls out for the plain Messages API rather than
 * any agentic surface. The system prompt carries `cache_control: {type:
 * "ephemeral"}` (P1-8, per the skill's prompt-caching syntax) — the same
 * do-not-translate list, kind instructions, and output-contract text repeat
 * verbatim on every call for a given (target, kind) pair, and `tier` is
 * already a request-level fork (see `translationKey`), so a warm cache
 * within a render burst is a real, free saving. NOTE for the PR: whether
 * this actually hits depends on the rendered system prompt clearing the
 * API's minimum cacheable-prefix length (model-dependent, per the skill) —
 * a short do-not-translate list could fall under that floor and silently
 * not cache. This needs a `cache_read_input_tokens` measurement against
 * staging traffic before it can be called a win, not just declared one.
 *
 * Retries on 429 (rate limited) and 529 (Anthropic overloaded) with a fixed
 * backoff, per decision 3/Build item ("retries with backoff on 429/529").
 * Every other non-2xx is a hard failure for this attempt — the caller
 * (`callWithGuard`) is what escalates fast→quality on a bad *response* (or a
 * truncated one — see `truncated` below); network/HTTP failure escalation is
 * not part of the contract and instead propagates so `translate()` can fall
 * back to source text.
 */
async function callAnthropic(apiKey: string, system: string, userText: string, tier: Tier): Promise<AnthropicCallResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: MODEL_IDS[tier],
          max_tokens: MAX_OUTPUT_TOKENS,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: userText }],
        }),
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw err;
    }

    if (res.ok) {
      const json = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        stop_reason?: string;
      };
      const textBlock = json.content?.find((b) => b.type === "text");
      // stop_reason === "max_tokens" (P1-5): the response was cut off
      // mid-generation. `callAnthropic` never used to look at this field at
      // all, so a truncated fragment — no preamble, no label, indistinguish-
      // able in shape from a correct short answer — passed the output-
      // contract guard and got written into the permanent, content-addressed
      // cache with no TTL to ever expire it. Signaling `truncated: true`
      // lets `callWithGuard` treat this exactly like a contract violation:
      // retry once at the escalated tier, then fall back to source rather
      // than caching a fragment forever.
      return { text: textBlock?.text ?? "", truncated: json.stop_reason === "max_tokens" };
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      lastErr = new Error(`Anthropic API HTTP ${res.status}`);
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }

    throw new Error(`Anthropic API HTTP ${res.status}`);
  }
  throw lastErr instanceof Error ? lastErr : new Error("Anthropic API call failed");
}

/** True when a call result should be discarded — either the output-contract guard or truncation (P1-5) rejects it. */
function isRejected(result: AnthropicCallResult): boolean {
  return result.truncated || violatesOutputContract(result.text);
}

/**
 * Runs one tier, checks the output contract AND truncation, and on
 * rejection retries once at the OTHER tier (decision 10: "on rejection,
 * retry once escalating fast→quality, then fall back to source" — extended
 * to also cover a `stop_reason: "max_tokens"` truncation, P1-5, since a cut-
 * off fragment is just as unfit to cache permanently as a preamble-polluted
 * one). A `quality`-tier call that is still rejected has nowhere further to
 * escalate, so its result is discarded and the caller falls back to source —
 * never returns contract-violating or truncated text to a page.
 */
/**
 * EXPORTED FOR THE WARM SCRIPT (docs/i18n-phase-2-brief.md, Implementation
 * note A). `scripts/translate-warm.mjs` writes KV directly per decision 9
 * rather than going through `translate()`'s scheduling path — but it must
 * produce byte-identical values to what a request-time miss would eventually
 * cache under the same key. That means it has to enter here, at the seam
 * that already composes prompt assembly + the protected-terms block + the
 * API call + the output-contract guard + truncation handling + fast→quality
 * escalation.
 *
 * The alternative — the script re-implementing any part of that — is the
 * specific failure the note forbids: the warm cache and the request-time
 * cache would drift in ways no test covers, surfacing only when someone
 * reads a bio that differs from the one the site renders. Keep this the
 * single path to the model for BOTH callers.
 */
export async function callWithGuard(
  apiKey: string,
  text: string,
  target: Lang,
  tier: Tier,
  kind: Kind,
  protectedTerms: readonly string[],
): Promise<string | null> {
  const system = buildSystemPrompt(target, kind, protectedTerms);
  const first = await callAnthropic(apiKey, system, text, tier);
  if (!isRejected(first)) return first.text;

  const escalated: Tier = tier === "fast" ? "quality" : "fast";
  if (escalated === tier) return null; // no further tier to try
  const second = await callAnthropic(apiKey, system, text, escalated);
  if (!isRejected(second)) return second.text;

  return null;
}

/**
 * Very rough best-effort source-language guess for the ONE thing it's used
 * for: choosing which `lang` to report back on a cache miss (decision 6), so
 * the caller can set an honest `lang` attribute on the still-untranslated
 * element. This is intentionally not a real language detector —
 * Swedish-specific letters are a strong, cheap signal for this site's actual
 * content (Swedish FM prose vs English page chrome), and a wrong guess here
 * only affects the `lang` attribute for ONE render before the real
 * translation lands in cache; it never affects what gets sent to the model
 * (the system prompt handles "already in {target}" itself, so this
 * function's result is not passed to Anthropic at all) and, since P1-4, no
 * longer feeds `violatesOutputContract` either — that guard now checks all
 * four language-label names unconditionally rather than trusting a guess.
 */
function guessSourceLang(text: string): Lang {
  return /[åäöÅÄÖ]/.test(text) ? "sv" : "en";
}

// ---------------------------------------------------------------------------
// translate()
// ---------------------------------------------------------------------------

/**
 * Translate `text` into `target`. Cache-first, never blocks a render on the
 * network call (decision 6):
 *
 *   1. Override file (human-authored, always wins — decision 5).
 *   2. KV cache, keyed by `translationKey()` (decision 7).
 *   3. Miss: return `text` unchanged, tagged with the GUESSED source
 *      language, and schedule the real translation via `waitUntil` (or
 *      inline `await` if no scheduler is available — see
 *      `waitUntilFromLocals`) so the NEXT request is a cache hit.
 *
 * The per-request `budget` (decision — Build item) gates step 3's network
 * call specifically: once exhausted, remaining strings on that render behave
 * exactly like a miss with no scheduler — source text now, nothing
 * scheduled, so a single expensive render can't fan out an unbounded number
 * of concurrent Anthropic calls.
 */
/**
 * Isolate-level read-through cache for resolved translations (performance
 * audit 2026-09-11, repair item 3).
 *
 * THE PROBLEM: every `t()`/`fmText()` call awaits a Cloudflare KV `get` before
 * the render can continue, and Astro frontmatter issues them one after
 * another. The audit's controlled benchmark — 50 distinct strings against a
 * mock KV with a 10 ms hit — measured 578 ms sequential versus 11.8 ms
 * batched: the render pays roughly the SUM of every distinct lookup. The
 * homepage alone has ~68 of them, and `sharedT`'s memo only dedupes within a
 * single request, so the next page-cache miss re-reads all of them again.
 *
 * WHY THIS HELPS: a Worker isolate serves many requests. Translations are
 * permanently cached and content-addressed (decision 7) — a given key's value
 * can never change without the source changing, which changes the key. So a
 * value read once is valid for the isolate's lifetime, and every later render
 * in that isolate skips the network entirely.
 *
 * IN-FLIGHT DEDUPLICATION: the map stores the PROMISE, not the value, so two
 * concurrent renders asking for the same key issue one KV read rather than
 * two. A rejected read is evicted so a transient failure cannot be pinned.
 *
 * BOUNDED: plain FIFO eviction at a fixed ceiling, the same approach and
 * reasoning as src/lib/cache.ts's `MAX_ENTRIES` — request-derived keys must
 * not grow a long-lived isolate's memory without limit.
 *
 * NOT a correctness layer: a miss here still falls through to KV, and a miss
 * there still returns source text and schedules the model call.
 */
const ISOLATE_CACHE_MAX = 5000;

/**
 * Keyed by the KV BINDING OBJECT, not globally.
 *
 * A single global map would let a value read through one KV instance be
 * served to a caller holding a different one. In production there is only
 * ever the one CACHE_STATE binding, so this changes nothing there — but it is
 * the difference between "correct because the environment happens to have one
 * binding" and "correct by construction", and it is exactly what the test
 * suite exposed: tests that inject their own stub KV were being served values
 * another test had cached under the same key.
 *
 * WeakMap so an isolate that somehow holds several bindings does not pin
 * their caches after the binding itself is gone.
 */
type IsolateEntry = { job: Promise<string | null>; at: number };

/**
 * Entries AGE OUT. Values are content-addressed, but a value can still be
 * corrected by hand (the language auditor deletes a wrong-language entry and
 * the next miss regenerates it). Without an age, an isolate that read the old
 * value — or was seeded with it from a bundle — would serve it forever and,
 * through the ledger, write it into a fresh bundle when the old one expired,
 * so the bundle TTL bounded nothing (Codex review, 2026-09-12). One hour: a
 * re-read per key per isolate per hour is nothing next to bulk reads.
 */
let isolateEntryTtlMs = 60 * 60 * 1000;
/** Test hook. */
export function setIsolateEntryTtlForTests(ms: number): void {
  isolateEntryTtlMs = ms;
}

const isolateCaches = new WeakMap<object, Map<string, IsolateEntry>>();

function isolateCacheFor(kv: KvLike): Map<string, IsolateEntry> {
  let isolateCache = isolateCaches.get(kv as unknown as object);
  if (!isolateCache) {
    isolateCache = new Map<string, IsolateEntry>();
    isolateCaches.set(kv as unknown as object, isolateCache);
  }
  return isolateCache;
}

function isolateCacheSet(kv: KvLike, key: string, job: Promise<string | null>): void {
  const isolateCache = isolateCacheFor(kv);
  isolateCache.set(key, { job, at: Date.now() });
  if (isolateCache.size > ISOLATE_CACHE_MAX) {
    const oldest = isolateCache.keys().next().value as string | undefined;
    if (oldest && oldest !== key) isolateCache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Physical KV reads: batched into bulk `get([...keys])` calls
// ---------------------------------------------------------------------------

/**
 * WHY BATCH. A Worker invocation may hold at most SIX outbound connections at
 * once, and KV `get()` counts (Cloudflare "Limits" — simultaneous open
 * connections). A `Promise.all` over N translation reads is therefore not
 * N-wide but six-wide: the 341-entry A–Ö index on /records/artists/previous
 * paid ~57 sequential KV round trips on a cold isolate, which is the bulk of
 * the 4.4 s page-cache miss measured on 2026-09-12. KV's bulk read
 * (`get(string[])`, up to 100 keys, one connection, returns a Map) turns that
 * into four.
 *
 * HOW. Reads requested within the same macrotask are collected per binding
 * and flushed together on a zero-delay timer. Serial `await t()` chains
 * still flush one key at a time (a batch of one takes the plain single-key
 * path, so nothing changes for them — the route bundle below is what fixes
 * serial depth); parallel fans (Promise.all over a list) land in one batch.
 *
 * FEATURE-DETECTED. A binding whose `get` does not understand an array (the
 * test stubs, or a future runtime without bulk reads) returns something that
 * is not a Map; the batch then falls back to individual reads, still in
 * parallel. Bulk never changes WHAT is read, only how many connections it
 * costs.
 */
const BULK_READ_MAX = 100;

/**
 * Colo-edge cache for translation reads — deliberately SHORT (the documented
 * minimum is 30 s). KV caches negative lookups for the same cacheTtl as hits,
 * so a long TTL here would pin every MISS at the colo: a translation the
 * scheduled job writes seconds later would stay invisible in that colo for
 * the whole window, prolonging untranslated output and re-scheduling the
 * same job. Hits lose nothing from the short TTL — the isolate cache and the
 * route bundle already keep them off the network.
 */
const KV_READ_OPTS = { cacheTtl: 30 } as const;

type PendingRead = {
  key: string;
  settle: (value: string | null) => void;
  fail: (err: unknown) => void;
};

type BulkKvLike = KvLike & {
  get(keys: string[], opts?: { cacheTtl?: number }): Promise<unknown>;
};

const pendingReads = new WeakMap<object, PendingRead[]>();

/**
 * A queued read that is never flushed (timer dropped with the I/O context,
 * isolate torn down mid-request) would otherwise hang forever — and because
 * isolateCachedRead holds the in-flight promise, it would pin that key for
 * the isolate's lifetime. A miss is always a safe answer here, so the wait is
 * bounded: past this, the read resolves null and the entry is evicted.
 */
let kvReadTimeoutMs = 5000;
/** Test hook — shortens the bound so the orphaned-flush path can be exercised. */
export function setKvReadTimeoutForTests(ms: number): void {
  kvReadTimeoutMs = ms;
}

function queueKvRead(kv: KvLike, key: string): Promise<string | null> {
  let pending = pendingReads.get(kv as unknown as object);
  if (!pending) {
    pending = [];
    pendingReads.set(kv as unknown as object, pending);
    setTimeout(() => {
      void flushKvReads(kv);
    }, 0);
  }
  return new Promise<string | null>((settle, fail) => {
    const timer = setTimeout(() => {
      console.error(`[translate] KV read for ${key} did not settle within ${kvReadTimeoutMs} ms — treating as a miss`);
      settle(null);
    }, kvReadTimeoutMs);
    pending!.push({
      key,
      settle: (value) => {
        clearTimeout(timer);
        settle(value);
      },
      fail: (err) => {
        clearTimeout(timer);
        fail(err);
      },
    });
  });
}

async function readChunk(kv: KvLike, chunk: PendingRead[]): Promise<void> {
  if (chunk.length === 1) {
    const [only] = chunk;
    try {
      only.settle(await timeServer("trnkv", () => kv.get(only.key, KV_READ_OPTS)));
    } catch (err) {
      only.fail(err);
    }
    return;
  }

  const keys = chunk.map((p) => p.key);
  let bulk: unknown = null;
  try {
    bulk = await timeServer("trnkv", () => (kv as BulkKvLike).get(keys, KV_READ_OPTS));
  } catch (err) {
    for (const p of chunk) p.fail(err);
    return;
  }

  if (bulk instanceof Map) {
    for (const p of chunk) {
      const value = bulk.get(p.key);
      p.settle(typeof value === "string" ? value : null);
    }
    return;
  }

  // Binding without bulk support: individual reads, in parallel.
  await Promise.all(
    chunk.map(async (p) => {
      try {
        p.settle(await timeServer("trnkv", () => kv.get(p.key, KV_READ_OPTS)));
      } catch (err) {
        p.fail(err);
      }
    }),
  );
}

async function flushKvReads(kv: KvLike): Promise<void> {
  const pending = pendingReads.get(kv as unknown as object);
  pendingReads.delete(kv as unknown as object);
  if (!pending || pending.length === 0) return;
  const chunks: PendingRead[][] = [];
  for (let i = 0; i < pending.length; i += BULK_READ_MAX) chunks.push(pending.slice(i, i + BULK_READ_MAX));
  await Promise.all(chunks.map((chunk) => readChunk(kv, chunk)));
}

function isolateCachedRead(kv: KvLike, key: string): Promise<string | null> {
  const isolateCache = isolateCacheFor(kv);
  const existing = isolateCache.get(key);
  if (existing && Date.now() - existing.at < isolateEntryTtlMs) return existing.job;
  if (existing) isolateCache.delete(key); // aged out: revalidate against KV

  const job = queueKvRead(kv, key)
    .then((value) => {
      // A MISS IS NOT A CACHEABLE VALUE. The promise is shared while in flight
      // (concurrent readers dedupe onto it), but once it resolves null it must
      // leave the map: the scheduled translation writes the real value to KV
      // moments later, and an isolate that pinned the miss would never read it
      // back — it would serve source text and re-schedule the same model call
      // on every render for its whole lifetime (2026-09-12 i18n review, D1).
      if (value === null) isolateCache.delete(key);
      return value;
    })
    .catch((err) => {
      // Evict so a transient KV failure is retried rather than pinned for the
      // isolate's lifetime; the caller still treats null as a miss.
      isolateCache.delete(key);
      console.error(`[translate] KV read failed for ${key} — treating as a miss:`, err);
      return null;
    });

  isolateCacheSet(kv, key, job);
  return job;
}

// ---------------------------------------------------------------------------
// Per-route translation bundles (one KV read per render, not one per string)
// ---------------------------------------------------------------------------

/**
 * THE REMAINING COST after the isolate cache and bulk reads: a COLD isolate
 * still pays one KV round trip per distinct string, and Astro frontmatter
 * awaits chrome strings one after another — ~100 serial reads on the
 * homepage. Isolates are recycled constantly, so "cold" is the common case
 * for the first visitor of a page-cache miss, and that visitor is the one
 * who feels the site as slow.
 *
 * A route bundle is the set of (KV key → value) pairs one render actually
 * resolved, stored under ONE key per (locale, route). The middleware reads
 * it before rendering and seeds the isolate cache, so every string the page
 * needs is already in memory: the whole render costs one KV round trip
 * instead of hundreds. Anything the bundle lacks (new FM text, new chrome
 * copy) simply falls through to the per-key path above, and the ledger of
 * what the render used is written back when it differs from what was
 * preloaded.
 *
 * NOT A CORRECTNESS LAYER. Entries are the same content-addressed keys as
 * the live cache (`tr:{version}:{target}:{tier}:{sha256(source)}`), so an
 * edited FM field changes its key and the bundle can never serve a stale
 * value for it — it can only be silent about it. A value that was deleted
 * from KV by hand (scripts/audit-translation-language.mjs) can linger in a
 * bundle until the bundle's TTL lapses; the TTL bounds that to hours, the
 * same window the isolate cache already had. Overrides (overrides.json) are
 * consulted before KV and are unaffected.
 *
 * The ledger is a plain Map handed in through `TranslateOptions.ledger`;
 * `translationLedgerFor(locals)` below is how t.ts and the middleware agree
 * on the one Map per request.
 */
export const TRANSLATION_BUNDLE_TTL_SECONDS = 6 * 60 * 60;

/** Minimal locals shape the ledger rides on — the same object as the budget. */
export interface LocalsWithLedger {
  __i18nLedger?: Map<string, string>;
}

/** The one per-request ledger, created on first touch and shared by every caller holding `locals`. */
export function translationLedgerFor(locals: LocalsWithLedger): Map<string, string> {
  if (!locals.__i18nLedger) locals.__i18nLedger = new Map<string, string>();
  return locals.__i18nLedger;
}

export function translationBundleKey(lang: Lang, path: string): string {
  return `trb:${TRANSLATION_KEY_VERSION}:${lang}:${path}`;
}

/** Pre-populate the isolate cache; existing entries (possibly in flight) win. */
export function seedIsolateCache(kv: KvLike, entries: Record<string, string>): void {
  const isolateCache = isolateCacheFor(kv);
  const now = Date.now();
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== "string") continue;
    const held = isolateCache.get(key);
    if (held && now - held.at < isolateEntryTtlMs) continue; // a live entry wins over a bundle
    isolateCacheSet(kv, key, Promise.resolve(value));
  }
}

/**
 * Read one route's bundle and seed the isolate cache from it. Returns the
 * bundle (for the change comparison on write-back) or null on a miss or any
 * malformed value — a bad bundle is just a miss, never an error.
 */
export async function loadTranslationBundle(
  kv: KvLike,
  bundleKey: string,
): Promise<Record<string, string> | null> {
  try {
    const raw = await kv.get(bundleKey);
    if (typeof raw !== "string" || !raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") entries[key] = value;
    }
    seedIsolateCache(kv, entries);
    return entries;
  } catch (err) {
    console.error(`[translate] bundle read failed for ${bundleKey} — ignoring:`, err);
    return null;
  }
}

/**
 * Write the render's ledger back as the route's bundle when it differs from
 * what was preloaded. Meant for `waitUntil` — never awaited in the visitor's
 * path. Returns whether a write happened.
 */
export async function storeTranslationBundleIfChanged(
  kv: KvLike,
  bundleKey: string,
  previous: Record<string, string> | null,
  ledger: ReadonlyMap<string, string>,
): Promise<boolean> {
  if (ledger.size === 0 || typeof kv.put !== "function") return false;
  if (previous) {
    const prevKeys = Object.keys(previous);
    let same = prevKeys.length === ledger.size;
    if (same) {
      for (const [key, value] of ledger) {
        if (previous[key] !== value) {
          same = false;
          break;
        }
      }
    }
    if (same) return false;
  }
  try {
    await kv.put(bundleKey, JSON.stringify(Object.fromEntries(ledger)), {
      expirationTtl: TRANSLATION_BUNDLE_TTL_SECONDS,
    });
    return true;
  } catch (err) {
    console.error(`[translate] bundle write failed for ${bundleKey}:`, err);
    return false;
  }
}

export async function translate(options: TranslateOptions): Promise<TranslateResult> {
  const { text, target, tier, kind = "plain", protect = [], waitUntil, budget } = options;

  if (!text || !text.trim()) {
    return { text, cached: true, lang: target };
  }

  // Hashed once (P2) and reused for both the override lookup and the KV
  // cache key below — both are keyed on sha256(source text), and hashing
  // twice per call was pure duplicate work.
  const hash = await sha256Hex(text);

  const override = await lookupOverride(hash, target);
  if (override !== null) {
    return { text: override, cached: true, lang: target };
  }

  const key = keyFromHash(hash, target, tier);
  const kv = options.kv !== undefined ? options.kv : (await getCfEnv())?.CACHE_STATE ?? null;

  if (kv) {
    // Read through the isolate cache (see its doc comment): a hit costs no
    // network round-trip at all, which is what removes the serialized-KV
    // dependency depth the performance audit measured. Errors are handled
    // inside isolateCachedRead(), which resolves null on failure — same
    // "a read failure is just a miss" posture as kvCached.
    const raw = await timeServer("trnread", () => isolateCachedRead(kv, key));
    if (raw !== null) {
      options.ledger?.set(key, raw);
      return { text: raw, cached: true, lang: target };
    }
  }

  const sourceLang = guessSourceLang(text);

  // Cache miss. Return source immediately; the API call (if budget AND a
  // scheduler are both available) is scheduled — NEVER awaited inline into
  // the visitor's response path.
  //
  // CORRECTED: an earlier version of this function awaited the translation
  // job inline when no `waitUntil` was available, on the reasoning that it
  // "upholds correctness, just loses non-blocking latency." That reasoning
  // was wrong — decision 6 ("never block a render on the API") has no
  // carve-out, and by the time this branch runs, source text has ALREADY
  // been selected as the return value; the job's only remaining output is a
  // KV write for next time. There is nothing left to be "correct" about by
  // waiting — the source text render already IS the correct behavior on a
  // miss. Awaiting here just adds a live network round-trip (up to two
  // model calls plus backoff) into whatever Astro frontmatter called
  // `translate()`, which is precisely the render-blocking failure mode
  // decision 6 exists to prevent. No scheduler is therefore treated exactly
  // like an exhausted budget: skip the call, return source, do not schedule
  // anything. The only two ways a translation actually gets produced are
  // (a) a real `waitUntil` from `Astro.locals.cfContext`, or (b) the
  // pre-warm script (decision 9), which calls the API directly and bulk-
  // loads KV out of band — it does not go through this function's
  // scheduling path at all.
  const hasBudget = budget ? budget.tryConsume() : true;
  const schedule = waitUntil;
  if (hasBudget && schedule) {
    const job = translateAndStore({ text, target, tier, kind, protect, kv, key });
    schedule(job.catch((err) => console.error("[translate] background translation failed:", err)));
  }

  return { text, cached: false, lang: sourceLang };
}

/**
 * The actual network call + guard + KV write, factored out from
 * `translate()` so the scheduled path has a single named implementation
 * that can be tested on its own.
 *
 * There is exactly ONE caller: the `waitUntil`-scheduled branch in
 * `translate()`. An earlier revision also called this inline when no
 * scheduler was present; that path was removed as a decision 6 violation
 * (see the CORRECTED note in `translate()`), so nothing here ever runs in
 * a visitor's render path.
 */
async function translateAndStore(args: {
  text: string;
  target: Lang;
  tier: Tier;
  kind: Kind;
  protect: string[];
  kv: KvLike | null;
  key: string;
}): Promise<void> {
  const { text, target, tier, kind, protect, kv, key } = args;

  const apiKey = await resolveApiKey();
  if (!apiKey) {
    console.error("[translate] ANTHROPIC_API_KEY not set — skipping translation, source text stays cached-miss");
    return;
  }

  const protectedTerms = await buildProtectedTerms(protect);
  const result = await callWithGuard(apiKey, text, target, tier, kind, protectedTerms);
  if (result === null) {
    // Both tiers rejected (or only one was available and it was rejected) —
    // per decision 10, "then fall back to source": do not cache a bad
    // result, do not cache the source either (a future request should try
    // again fresh rather than pin "translation permanently failed").
    console.error(`[translate] rejected on both tiers (contract violation or truncation) for key ${key} — falling back to source`);
    return;
  }

  if (kv) {
    try {
      await kv.put(key, result);
    } catch (err) {
      console.error(`[translate] KV write failed for ${key}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// createT() — chrome-string helper bound to locals.lang
// ---------------------------------------------------------------------------

export type TFunction = (source: string) => Promise<string>;

/**
 * Factory rather than a single global `t()`: each Astro component/page
 * renders against its own `Astro.locals` (and therefore its own
 * `locals.lang` and its own scheduler), and Astro components can run
 * concurrently within one render — a shared module-level `t` bound to
 * "whichever locals were seen last" would leak one request's language into
 * another's output under concurrent rendering. `createT(locals)` returns a
 * fresh, correctly-scoped closure per call site.
 *
 * Deliberately thin: `t(source)` always translates chrome strings at
 * `tier: "quality"` (decision 3: "quality = ... UI chrome strings") and
 * `kind: "plain"` — callers with markdown or titles, or FM prose needing the
 * `fast` tier, call `translate()` directly instead of through `t()`.
 *
 * BUDGETED BY DEFAULT (P1-6 fix): `opts.budget` used to default straight to
 * `undefined`, which `translate()` treats as "no budget, always allowed" —
 * i.e. every `createT()` binding was silently unbounded unless the caller
 * remembered to pass one in. The brief's Section 5 goal is to wire `t()`
 * into every page's chrome strings; a page with many chrome strings hitting
 * a cold cache (fresh deploy, or a `TRANSLATION_KEY_VERSION` bump) would
 * fire an unbounded number of concurrent Anthropic calls with no ceiling —
 * exactly the failure mode `RequestBudget` exists to prevent. `createT` now
 * constructs its OWN `RequestBudget` (the default 25-call ceiling) unless
 * the caller opts out. Opt-out is explicit and distinct from "didn't think
 * about it": pass `budget: null` (not simply omitting the option) to run
 * unbounded — `translate()` already treats both `null` and `undefined` as
 * "no budget", so `null` here reads as a deliberate choice rather than an
 * accidental default.
 */
export function createT(
  locals: LocalsWithScheduler & { lang?: Lang },
  opts?: { protect?: string[]; kv?: KvLike | null; budget?: RequestBudget | null; ledger?: Map<string, string> },
): TFunction {
  const target = locals.lang ?? "sv";
  const waitUntil = waitUntilFromLocals(locals);
  // `"budget" in (opts ?? {})` distinguishes "caller wrote `budget: null`"
  // from "caller didn't mention budget at all" — a plain `opts?.budget ??
  // new RequestBudget()` cannot tell those apart, since both read as
  // `undefined` through optional chaining, which would make explicit
  // opt-out impossible to express.
  const budget = opts && "budget" in opts ? opts.budget ?? undefined : new RequestBudget();
  return async (source: string) => {
    const result = await translate({
      text: source,
      target,
      tier: "quality",
      kind: "plain",
      protect: opts?.protect,
      waitUntil,
      kv: opts?.kv,
      budget,
      ledger: opts?.ledger,
    });
    return result.text;
  };
}
