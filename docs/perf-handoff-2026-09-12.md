# Page-speed handoff — 2026-09-12

Written at the end of the i18n Phase 2 session for a fresh context. Branch
`i18n-phase-2`, staging `ninetone-site.micke-ohlen.workers.dev`, deploy
`0109e3f6`. **Nothing here is a fix — it is a starting point with measurements
attached, so the next session does not re-derive what is already known.**

## Read these first

- [performance-audit-2026-09-11.md](performance-audit-2026-09-11.md) — the CODEX
  performance audit. Its diagnosis is sound and its repair plan is still the
  right shape. Items 1–3 are done; items 4–6 are not.
- [audit-evidence/seo-i18n-2026-09-11/](audit-evidence/seo-i18n-2026-09-11/) —
  the controlled serialization benchmark. Re-run and reproduced: 578 ms
  sequential vs 11.8 ms parallel for 50 distinct strings against a 10 ms mock KV.

## What was already done

| Audit repair item | Status |
|---|---|
| 1. Avoid translation I/O where source language is known | Partial — see "not done" below |
| 2. Batch consecutive translations with `Promise.all` | **Not done** |
| 3. Isolate-level read-through cache with in-flight dedup | **Done** (`src/lib/translate.ts`, `isolateCachedRead`) |
| 4. `Server-Timing` instrumentation | **Not done** — do this first |
| 5. Replace full-body gating | **Not done, and do not attempt blind** |
| 6. Browser trace for fonts/CSS/LCP | **Not done** |

The isolate cache is the one substantive change. Translations are permanently
cached and content-addressed, so a value read once is valid for the isolate's
lifetime; later renders in that isolate skip KV entirely. It is keyed by the KV
binding object, not globally — a global map let one test's value reach another's
stub, and production having a single binding made that correct only by accident.

## Current measurements (2026-09-12, staging)

Warm, `x-cache: hit`:

| Route | TTFB |
|---|---:|
| `/` | 0.073 s |
| `/en` | 0.081 s |
| `/news` | 0.072 s |
| `/records/artists` | 0.069–0.145 s |

Cold, cache-busted (full SSR):

| Route | TTFB |
|---|---:|
| `/` | 0.077 s |
| `/en` | 0.151 s |
| `/news` | 0.085 s |
| `/records/artists` | 0.176 s |

A genuinely cold isolate still costs **~4–5 s** on the first hit, then drops to
~0.1 s as the isolate cache fills. That first-hit cost is the remaining TTFB
problem and is not yet explained — it could be isolate startup, FM fetches, the
KV cache-version read, or the body buffering, and no instrumentation currently
separates them.

## The strongest untouched lead: HTML payload size

Not raised by the audits. Measured today, uncompressed:

| Route | HTML |
|---|---:|
| `/` | 88 KB |
| `/news` | 165 KB |
| `/management/clients` | 225 KB |
| `/records/artists` | 228 KB |
| **`/records/artists/previous`** | **440 KB** |

440 KB of HTML for one page is a lot, and it is plausibly the actual felt
slowness rather than TTFB — which is now mostly double-digit milliseconds.

Likely cause worth checking first: `RosterIndex` renders a full A–Ö list of
every artist *in addition to* the card grid, so the same roster appears twice in
the document, each entry carrying a name, blurb and tags. `src/components/RosterIndex.astro`
is mounted by `records/artists.astro`, `management/clients.astro`, and
`records/artists/previous/[...page].astro` — exactly the three heaviest pages.

Worth asking: does the A–Ö index need to be server-rendered at all, or could it
be built client-side from the existing `/search-index.json`?

## Do not do these

- **Do not revert `await res.arrayBuffer()`** in `src/middleware.ts`. It looks
  like an obvious TTFB win and it is not: it fixes a confirmed zero-byte-response
  race where `res.clone()` teed a stream whose branches were consumed at
  different rates, throwing `ResponseSentError` and handing visitors an empty
  200. The failure was captured live via `wrangler tail`, 3/3 requests on a heavy
  detail page. Any replacement must be a tested Workers-safe strategy, not a
  revert. See the long comment at the `arrayBuffer()` call site.
- **Do not raise the 25-call translation budget** to fix slowness. It exists to
  stop one visitor's cold load running up unbounded spend and Worker CPU. The
  correct lever is pre-warming (`scripts/translate-warm.mjs`), which is cheap —
  recent runs cost $0.10 and $0.29.
- **Do not add an SEO or performance package** to satisfy a checklist. The FM
  live-CMS architecture is settled (`docs/cms-architecture.md`).

## Suggested order

1. **Instrument before changing anything.** Add `Server-Timing` for: cache-version
   KV read, page-cache lookup, FM fetches, translation KV count and total time,
   Astro render, body buffering. Capture one natural cold miss and one warm hit
   per locale. Right now nobody can say which of those dominates the ~4–5 s
   first-isolate hit, and the audit was careful not to guess.
2. **Then the browser trace** the audit asked for — fonts (two preloaded
   Newsreader faces, 132 KB + 147 KB), two blocking CSS files, and the FM-proxy
   hero image. TTFB is largely fixed; LCP probably is not.
3. **Then the HTML weight**, starting with the duplicated roster above.
4. **Only then** consider streaming, with the zero-byte evidence in hand.

## Context worth carrying over

- Translation correctness is settled and should not be re-opened: a 544-route
  sweep is at 539 clean, and the 5 flagged routes are all correct by design
  (`/en/integritet` is deliberately Swedish; the rest are song titles and
  third-party YouTube video titles). A corpus audit of all 5,930 English KV
  entries found 3 wrong-language values, all deleted and verified self-healing.
- `scripts/audit-translation-language.mjs` re-runs that corpus audit. Note KV is
  eventually consistent — a read can return a deleted value for ~60 s — and
  `wrangler kv key get` writes part of its error banner to **stdout**, so only
  its exit code reliably distinguishes a missing key from a present one.
- New FM content auto-translates with no deploy: a miss renders source text and
  schedules the translation via `waitUntil`. The exception is new hardcoded UI
  copy on a page already over the 25-call budget — that does not self-heal and
  needs a warm run.
- `npm run build` (gh) and `npm run build:cf` (cf) write to the **same `dist/`**.
  Running the gh build after the cf build silently leaves stale server output, and
  `wrangler deploy` will then ship the wrong bundle. This cost real debugging time
  twice in the last session. Always `npm run build:cf` immediately before deploying.

## State

354 tests pass. Both builds green. Post-build audit clean (548 pages). Branch
`i18n-phase-2` is unmerged by instruction; `docs/i18n-phase-2-pr.md` still needs
updating for everything after `ff58788`.
