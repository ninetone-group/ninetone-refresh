# v0.2.0.0 — Swedish primary, English via Claude translation, plus SEO, performance and publication (shadow)

Branch `i18n-phase-2` → `main`. This PR carries everything since the site went
server-rendered on Cloudflare: SEO phases 1 and 1b (branch `seo-phase-1`, never
merged), i18n phase 2, the 2026-09-12 review and performance fixes, and the
translate-before-publish subsystem in shadow mode. Staging is at Worker version
`279c87cb`. **Still noindexed** — `PUBLIC_NOINDEX` is untouched.

| | |
|---|---|
| Commits | 57 |
| Files changed | 195 (+43,870 / −931) |
| Tests | **646** passing (was 200 at the SEO branch point) |
| Builds | `npm run build` and `npm run build:cf` both green; post-build audit clean (548 pages) |
| Version | `0.2.0.0` (VERSION and CHANGELOG.md introduced with this PR) |

## Since `ff58788` — 2026-09-12

Full report: [review-and-fixes-2026-09-12.md](review-and-fixes-2026-09-12.md).
Four read-only review agents (perf hot path, SEO layer, i18n runtime,
publication subsystem) reported to one reviewer, who verified the load-bearing
claims independently and measured staging with `Server-Timing`.

**The slowness, measured.** Warm edge hits were always ~0.1 s. A page-cache
miss on a cold isolate paid one KV round trip per translated string (homepage:
83 serial reads, 3.75 s) and, on Previous Artists, 3.0 s of FileMaker time.
Fixes, all verified live:

- **Route translation bundle** — one KV key per (locale, route) with every
  translation the last render resolved; read before render, seeds the isolate
  cache, written back only when changed. N reads → 1.
- **KV bulk reads** — same-tick reads flushed as one `get([...keys])` (≤100).
  Workers allow six simultaneous connections, so a 341-wide `Promise.all` was
  effectively six-wide.
- **FileMaker KV read-through** (`src/lib/fm-kv.ts`, 300 s, keyed by the Publish
  epoch). Previous Artists cold render: 3.9 s → 0.84 s.
- A KV miss is no longer pinned in the isolate cache; the edge `cacheTtl` on
  translation reads is short (KV caches negative lookups too).
- A render whose translation budget refused strings is cached 60 s, not the
  tier TTL — decided after the streamed body is buffered, where components run.

**SEO.** `/en/` for Swedish-only pages 301s to the Swedish URL; English
pagination titles say "Page"; the English `llms.txt` links English pages and the
Swedish one is Swedish; `X-Robots-Tag` covers SSR HTML; no `SearchAction` to
the noindexed search page; 404s emit no canonical/hreflang/og:url.

**Publication subsystem.** Deployed in shadow mode (no visitor path reads it).
Its cron is **paused** via `PUBLICATION_TICK=off` in `wrangler.jsonc`; delete
that line and redeploy to resume discovery. Fixed: the stale-scan guard now
reads the coordinator revision before the FM scan; unchanged releases are not
rewritten every minute. Open before `PUBLICATION_SERVING=on`: route promotion
through `promoteRelease()`, durable FM-deletion withdrawals, `hasRoute()`
forward fallback, DLQ draining.

**Two review findings on the first deploy, fixed the same evening:** the long
`cacheTtl` pinned misses per colo for hours; the degraded check ran before the
body was buffered. Both reproduced in tests.

**Deploy note.** The GitHub workflow only rebuilds the GitHub Pages preview
from `main`. The Cloudflare Worker deploys with
`npm run build:cf && npx wrangler deploy` (one command — the two builds share
`dist/`).

## Phase 2 — what this does

Swedish becomes the site's default locale at the root. English lives under `/en/`, rendered from the same page files, with copy translated by Claude and cached permanently in KV. No route files were duplicated; no page was forked per language.

Companion to [i18n-phase-2-brief.md](i18n-phase-2-brief.md). Every decision in that brief was treated as settled; where one could not be followed as written, the substitute is listed under [Deviations](#deviations-from-the-brief) below. SEO phases 1 and 1b are described in [seo-phase-1-pr.md](seo-phase-1-pr.md) and [seo-phase-1b-pr.md](seo-phase-1b-pr.md).

## Architecture

**One set of pages.** `src/middleware.ts` detects a leading `/en` segment, strips it, sets `locals.lang`, and rewrites to the same page via `next(payload)`. Root requests are Swedish. `/en/api/*` and `/en/en/*` are deliberate 404s.

**Translation.** `src/lib/translate.ts` calls the Anthropic Messages API over plain `fetch` — no SDK dependency. Two tiers: `claude-haiku-4-5` (fast) for bios, releases and news; `claude-sonnet-5` (quality) for chrome, division copy and guides. Model IDs came from the `claude-api` skill, not from memory.

**Cache.** `tr:v1:{target}:{tier}:{sha256(source)}` in `CACHE_STATE`, no TTL. Keying on the source hash means an edited FM field is automatically a new key — there is no invalidation logic to get wrong. Bump `v1` when the system prompt changes.

**Renders never block on the API.** A cache miss returns the source text immediately, reports the source language so the caller can set an honest `lang` attribute, and schedules the real call via `waitUntil`. The next request is cached.

**Human overrides win.** `src/i18n/overrides.json`, keyed by `sha256(source)`, beats the machine every time. `node scripts/i18n-list.mjs` prints the full review table (see [below](#chrome-strings-for-review)).

## Definition of done

- [x] `npm test` green — 348 tests
- [x] Both builds green, post-build audit clean
- [x] `scripts/i18n-list.mjs` output attached
- [x] Warm script run against staging — numbers below
- [x] Deviations listed
- [x] Staging verification (see [Staging checklist](#staging-checklist))

## Warm run

Run against staging (`CACHE_STATE`, the same namespace the Worker reads) on 2026-09-11.

| | |
|---|---|
| Strings translated | **10,286** (2 failed on transient HTTP 503, left uncached) |
| Keys in KV | **10,814** |
| Input tokens | 3,072,826 |
| Output tokens | 1,318,054 |
| **Total cost** | **$10.01** |

Per tier — real API `usage`, not estimated:

| Tier | Model | Calls | Input | Output | Cost |
|---|---|---|---|---|---|
| `fast` | claude-haiku-4-5 | 9,536 | 2,875,162 | 1,287,801 | $9.31 |
| `quality` | claude-sonnet-5 | 750 | 197,664 | 30,253 | $0.70 |

The `fast` tier dominates because decision 9 includes release pitch/social copy across 374 artists. The estimate before the run was $10.29; actual came in 3% under.

**Chrome discovery:** `I18N_CAPTURE_CHROME_STRINGS=1 npm run build` captured **336 distinct strings**, versus 304 from source parsing — including all 15 blind spots note D names (header nav, homepage portals, metrics panel). Warmed on the `quality` tier in both directions.

**`cache_read=0`** — prompt caching never hit. The system prompt is ~300 tokens, below the minimum cacheable prefix, so `cache_control` silently no-ops as [follow-up 4](#follow-ups-not-in-this-pr) predicted. Not a defect; worth removing or revisiting if the prompt ever grows past the threshold.

**Resumability was load-bearing.** The script originally accumulated everything in memory and did one `wrangler kv bulk put` at the end — a two-hour run where any failure at 90% would have discarded ~$9 of translation. It now flushes every 250 translations. Verified by killing a run mid-flight: KV had climbed 28 → 528, the work survived, and the restart correctly resumed at 10,288 items instead of 10,788 because the idempotency check skipped what was already written.

## Chrome strings for review

Full table: `node scripts/i18n-list.mjs`. **305 distinct source strings across 56 `.astro` files.**

Patrik: the `sha256` column is the override key. To pin a line, edit `src/i18n/overrides.json`:

```json
{ "<sha256 from the table>": { "sv": "...", "en": "..." } }
```

An override wins over the machine translation and takes effect on the next render — no rebuild needed. Overrides live in git, so every edit is reviewable.

Sample:

```
sha256       | source                                           | override sv                 | override en
-------------+--------------------------------------------------+-----------------------------+----------------------------
4efca0d10c5… | About                                            | (none — machine translated) | (none — machine translated)
358422b0565… | Alla rättigheter förbehålls.                     | (none — machine translated) | (none — machine translated)
406ebeda2a5… | All artists                                      | (none — machine translated) | (none — machine translated)
c86164e4e7a… | A release.                                       | (none — machine translated) | (none — machine translated)
```

`i18n-list.mjs` is honest about what it cannot see: it lists ~20 call sites that pass a variable rather than a literal (`t(p.tagline)`, `t(m.label)`, …). Those strings **are** warmed — see the build-instrumentation note under Deviations — but they cannot appear in this static table.

### Translation quality — where the machine needs a human

Audited every short UI label against what the warm run actually stored. The pattern is consistent and worth knowing before the review pass: **longer prose translates well; bare context-free words are where it fails.** A single word gives the model no way to tell a verb from a noun.

Three errors found and already pinned in `overrides.json`:

| Source | Machine stored | Corrected to | Why it was wrong |
|---|---|---|---|
| `View` | **Vy** | **Visa** | "Vy" is the noun (a vista). The string is a button meaning "show this artist" — a verb. |
| `All` | **All** | **Alla** | Swedish "all" only modifies uncountable nouns; a countable plural takes "alla". |
| `All clients` | **All klienter** | **Alla klienter** | Same rule, and here the model had context and still slipped. |

Telling detail: the same model renders `All artists` → "Alla artister" and `All news` → "Alla nyheter" correctly. It is specifically the bare filter-chip word and one compound that went wrong, which is exactly the surface decision 5's override file exists for.

The rest of the audited labels are correct: `Book` → Boka, `Watch` → Titta, `Search` → Sök, `Read` → Läs, `About` → Om, `Archive` → Arkiv, `News` → Nyheter, `Follow` → Följ, `Latest` → Senaste. `Merch` and `Team` correctly stayed untranslated.

**Recommendation for the review pass:** start with the short labels. They are the highest-visibility strings on the site and had a meaningful error rate; the long-form bios and taglines read well in spot checks.

### Near-duplicate copy worth consolidating

Found while converting; deliberately **not** changed, because merging them changes visible copy and that is a decision for you, not for this PR. Each variant is its own cache entry, its own override, and its own budget slot:

1. `Latest stories` / `Latest stories.` / `Latest story` — `LatestNewsSection`, `EditorialNewsBlock`, `index.astro`
2. Four variants of the Nation tagline across `ninetone-nation/index.astro`, `booking.astro`, `contact-ninetone-nation.astro`
3. The same news lede twice inside `news/index.astro`, differing only by a comma vs a period

## Deviations from the brief

Listed per the Definition of done: *"Every place a decision above could not be followed as written is listed in the PR description with the substitute."*

**1. `Astro.locals.runtime.ctx.waitUntil` does not exist in Astro 7 (decision 6).**
The brief names that path for scheduling. In `@astrojs/cloudflare` 14.3.1 it is a getter that *throws* by design (`cf-helpers.js:27-51`: "has been removed in Astro v6"), and optional chaining does not protect against a throwing getter. The adapter populates `locals.cfContext` instead, which is what the code reads. **Substitute:** `locals.cfContext.waitUntil`, verified at the adapter source.

**2. `API_BOOKING_TAG` is not an importable constant (decision 7).**
The brief says to build the do-not-translate list from "every category label in `API_BOOKING_TAG`". That is an FM *layout name*, not an exported constant — the labels exist only as live data behind `getBookingCategories()`. **Substitute:** the protected-terms builder imports that helper dynamically and reads the live tags, rather than hand-copying six strings that would silently drift.

**3. Chrome pre-warming is not in decision 9's scope, but is required (note C).**
Decision 9's warm script walks FM *entities*. Measured: the homepage render tree alone touches **81 distinct chrome strings** against the 25-call per-render budget, so on a cold cache ~80% of chrome would render untranslated. Raising the budget is the wrong lever — it exists to stop one visitor's cold load running up unbounded spend and Worker CPU. The chrome corpus is small (~18 characters average; the whole set costs roughly $0.08 once, permanently). **Substitute:** the warm script warms chrome too, on the quality tier, in both directions. The budget stays at 25 as a runtime safety valve.

**4. Warm-script discovery is build-instrumented, not source-parsed (note D).**
`i18n-list.mjs` resolves only literals passed directly to `t()`. About 26 of the highest-traffic strings come from array/object literals that are mapped over — the entire header nav, homepage portal grid and metrics panel, all of which render on every one of 546 pages. The strings most worth warming were exactly the ones a source scanner cannot see. **Substitute:** `I18N_CAPTURE_CHROME_STRINGS=1 npm run build` makes `sharedT` append every source string it actually sees to a JSONL file; the warm script warms that union. Verified: instrumentation captured **336 distinct strings including all 15 named blind spots**, versus 304 from source parsing. The hook is completely inert when the flag is unset (verified: no file handles, no behaviour change).

**5. `src/lib/t.ts` (`sharedT`) was added, beyond the brief's build items.**
`createT()` alone gave *each component* its own 25-call budget — Header + Footer + CommandPalette + page ≈ 100 allowed per render, four times the specified ceiling — and one repeated string could burn many slots (`booking.astro` renders up to 100 `ArtistCard`s all asking for `"Book"`). **Substitute:** `sharedT` puts one budget on `Astro.locals` and memoizes by source string per render. Call it, never `createT()` directly.

**6. `llms.txt` entity content is served in source language.**
The brief left room for this ("serve whatever is already in the KV cache and untranslated otherwise"). `/en/llms.txt` translates its 21 chrome literals live; the hundreds of entity lines are not translated per-request — that would need either an unbounded `waitUntil` fan-out or a budget far past 25. Entity translation is the warm script's job. `llms.txt` is a low-traffic machine-readable artifact, so this is a deliberate simplification, not an oversight.

**7. `/en/` is Cloudflare-only; the GitHub Pages preview stays Swedish (decision 2, as written).**
Consequences worth stating: the language switch is **hidden** on the static preview, because `/en/` genuinely 404s there and the old control was already broken (it rendered "SV" with an href pointing back at the same page). The static sitemap lists Swedish URLs only — a sitemap advertising dead links is wrong regardless of who reads it — while still declaring the true `sv`/`en`/`x-default` alternate structure. `dist/en/llms.txt` returns "Not found" on gh.

**8. `integritet.astro` and `guider/*` stay Swedish end to end.**
Both pin `lang="sv"` on `<Base>`, which predates this phase and wins over `locals.lang`. Machine-translating a privacy policy's rights and retention language carries accuracy risk nobody asked us to take. Making them bilingual is a product decision. `admin/publish.astro` stays English: internal tool, noindex.

## Defects found and fixed

These were caught by review and each was reproduced before being fixed. Listed because several are the kind that ship silently.

**Every English page canonicalized to its Swedish twin.** `Astro.url.pathname` is the *post-rewrite* path, so `/en/records` claimed `rel=canonical` of `/records` while the hreflang block simultaneously advertised that same page as the English alternate. Google resolves that contradiction in favour of canonical — the entire English corpus would have been folded into Swedish and dropped from the index, and `og:url` inherits the value, so every English link shared to Slack or LinkedIn would have unfurled the Swedish page.

**`/en/admin/publish` and `/en/404` silently lost their cache bypass.** `cache-policy`'s SKIP patterns are anchored, so a leading `/en` defeated them while the rewrite still reached the real route. Verified directly: `/admin` → BYPASS, `/en/admin` → CACHED. The Publish console would have been stored at the edge for an hour. Not credential disclosure (the secret is checked in `/api/publish`), but SKIP is what every future private route will rely on.

**The overrides mechanism was entirely dead.** The dynamic JSON import lacked its import attribute, plain Node ESM rejected it, and `loadOverrides()`'s catch-to-`{}` made a broken import indistinguishable from an empty file. Fixed, covered by a real fixture, and verified to survive the Cloudflare bundler as a code-split chunk — a second silent death under the bundler was the specific risk.

**The output-contract guard rejected ordinary label copy.** "Here comes the sun", "Swedish-Norwegian duo", "English-language debut album" all tripped it. Rejected translations are deliberately not cached, so each false positive would have burned a doubled fast→quality escalation on *every* request forever and never rendered translated.

**Truncated responses were cached permanently.** A `stop_reason: "max_tokens"` fragment has neither preamble nor label, so it passed the guard and landed in a no-TTL, content-addressed key that could never self-heal. Now treated as a rejection; `max_tokens` raised to 16000.

**`ArtistCard` double-translated its CTA.** Both callers already resolved `await t("Book")` and passed the result down, so the chain was `t("Book")` → "Boka" → `t("Boka")`. Different keys, and "Boka" exists as a literal nowhere — so no discovery mechanism could ever warm it, making the CTA a guaranteed permanent cache miss. It also fed an override's *output* back into a second translation.

**`Discography` rendered 30 bare `<time>` elements per artist page.** Locale threading was correct, but with no `datetime` attribute the machine-readable value became locale-dependent prose — worse than the stable `10/31/2024` it replaced. All 2538 `<time>` elements site-wide now carry a real ISO `datetime`.

**Two bugs the builders caught mid-implementation:** `ttlFor()` had to use the stripped path (no TTL rule matches a leading `/en`, so every English page would have silently fallen to `DEFAULT_TTL`), and `Astro.rewrite("/404")` re-invokes the middleware with a *shared* `locals` object, so `lang` is set only on first touch or the inner pass stomps an outer "en" back to "sv".

## Verification

Beyond the test suite, each new guard was mutation-tested — the fix reverted, confirming the test fails, then restored:

| Mutation | Result |
|---|---|
| Cache key built from stripped path | 1 test fails (locale collision) |
| `shouldBypassCache` given the raw path | 2 tests fail (`/en/admin`, `/en/404`) |
| `/en/en` guard removed | 1 test fails |
| Legacy redirect given the raw path | 1 test fails |
| `xmlns:xhtml` dropped from `<urlset>` | 2 tests fail |
| `sv` locale swapped to `en-GB` | 6 tests fail |
| UTC-noon anchor removed (`TZ=America/Los_Angeles`) | 5 tests fail |

Verified directly rather than by inspection: `Intl` output matches the brief exactly (`29 juli 2026` / `29 July 2026`) with full ICU present; the gh build makes **no** API calls with `ANTHROPIC_API_KEY` empty and renders Swedish source copy; the built sitemap declares `xmlns:xhtml` exactly once with `x-default` = Swedish on every entry; and a warmed KV key computed by `translationKey()` round-trips to a real translation ("Kontakta oss" → "Contact us").

## Staging checklist

Against `https://ninetone-site.micke-ohlen.workers.dev`:

Deployed with `npx wrangler deploy` from this branch. Version `65f24e31` at the time of this checklist; `279c87cb` as of 2026-09-12 evening.

| Check | Result |
|---|---|
| `/` renders Swedish chrome + content | ✅ `<html lang="sv">` |
| `/records` renders Swedish | ✅ `<html lang="sv">` |
| `/en` renders English | ✅ `<html lang="en">` |
| `/en/records` renders English | ✅ `<html lang="en">` |
| Canonical is per-locale | ✅ `/records` → `/records`; `/en/records` → `/en/records` |
| hreflang pairs correct on both | ✅ sv / en / x-default, consistent with canonical |
| Language switch round-trips | ✅ `switchHref` verified both directions |
| Sitemap has both locales | ✅ 1086 `<loc>` = 543 × 2, `xmlns:xhtml` declared once |
| Warm script run before PR | ✅ numbers above |

**`waitUntil` self-healing verified live**, which is decision 6's whole contract. A cold string rendered as Swedish source on the English page (never blank, never blocking), and after a few requests the Worker had written the translation to KV and it rendered in English:

```
before:  Utforska   Följ    Alla rättigheter förbehålls
after:   Explore    Follow  All rights reserved
```

**Not yet verified on staging** — needs a human with the FM data in front of them: that the same artist page at both URLs shows the bio in each language with markdown intact and the artist name untouched. The protected-terms list and markdown `kind` are unit-tested, but I have not eyeballed a real bio side by side.

## Follow-ups (not in this PR)

1. **Consolidate the near-duplicate copy** listed above — a copy decision.
2. **`CommandPalette`'s client-side `SECTION_LABELS`** cannot call `t()` (browser-side, no `Astro.locals`). Four other scripts were bridged via `data-i18n-*` attributes; this one needs a slightly larger data bridge.
3. **`src/lib/ninetone.ts` uses extensionless relative imports**, which Vite resolves but plain Node cannot (`filemaker.ts` was fixed on 2026-09-12). The warm script routes around it with an inline module hook. Worth fixing at the source eventually.
4. **Prompt caching is declared but unmeasured.** `cache_control` is set on the system prompt; it may fall below the minimum cacheable prefix and silently no-op. Measure `cache_read_input_tokens` on staging before assuming it helps.
5. **`BreadcrumbList` carries `inLanguage`**, which is technically an `ItemList` rather than a `CreativeWork`. Harmless (page-level, no `@id`), unlike the `Organization`/`WebSite` case that was fixed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
