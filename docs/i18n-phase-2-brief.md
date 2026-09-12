# Phase 2 — Swedish primary, English via Claude translation

Companion to [seo-strategy-2026-09.md](seo-strategy-2026-09.md) and [seo-phase-1-brief.md](seo-phase-1-brief.md). Build spec. Branch `i18n-phase-2` from `seo-phase-1`. Staging only; Fable reviews before merge.

## Decisions (do not reopen)

1. **Swedish is the default locale at the root. English lives under `/en/`.** `astro.config.mjs` i18n: `defaultLocale: "sv"`, `locales: ["sv","en"]`, `routing.prefixDefaultLocale: false`. No automatic redirects by browser language, ever. A language switch in the header points at the exact alternate URL.
2. **One set of pages, no duplicated route files.** On the CF target, `src/middleware.ts` detects a leading `/en` segment, strips it, sets `locals.lang = "en"`, and rewrites to the same page (`next("/records")` style rewrite, or `context.rewrite`, whichever the installed Astro supports). Root requests set `locals.lang = "sv"`. Static GH Pages preview stays single-language Swedish; `/en/` is a CF-only feature guarded by `PUBLIC_HAS_RUNTIME`. Edge-cache keys must include the locale (the pathname already differs, verify the rewrite does not collapse them).
3. **Provider: Anthropic Messages API over `fetch`.** No SDK dependency. Key from the `ANTHROPIC_API_KEY` Worker secret (runtime via the existing `runtimeEnv` pattern) and from `.env` for the local warm script. Mikael's key now, Ninetone's at launch, no code change. Load the `claude-api` skill for exact model IDs, request shape, and prompt-caching syntax; do not write these from memory. Two tiers: `fast` = Haiku 4.5 for bios, releases, news, blurbs; `quality` = Sonnet 5 for UI chrome strings, division landing copy, category intros, guides, contact copy, meta descriptions.
4. **Translation is bidirectional and detection is the model's job.** FM content is mostly Swedish but some records and most hardcoded page copy are English. The system prompt says: translate into `{target}`; if the text is already in `{target}`, return it unchanged. Both directions share one code path.
5. **UI chrome goes through the same pipeline.** Replace the scattered `lang === "sv" ? … : …` ternaries and hardcoded English page copy with `t(text)` calls, where `t` translates the source string into `locals.lang` through the cache. Source strings stay in the code in whichever language they are written today. A human-override file `src/i18n/overrides.json` (`{ "<sha256 of source>": { "sv": "...", "en": "..." } }`) wins over the machine, so Patrik's edits are durable and reviewable in git. Provide `scripts/i18n-list.mjs` that prints every source string with its current sv/en so Patrik can review in one table.
6. **Never block a render on the API.** On a cache miss, return the source text, mark the element's `lang` attribute with the source language, and schedule the translation with `waitUntil` (Astro on CF: `Astro.locals.runtime.ctx.waitUntil`). The next request is cached. Missing content is therefore never invisible, only untranslated for one request.
7. **Cache is permanent, versioned, and keyed on content.** KV key `tr:v1:{target}:{tier}:{sha256(source)}` in the existing `CACHE_STATE` namespace, no TTL. Bump `v1` when the system prompt changes. Names must never be translated: the prompt carries a do-not-translate list built at request time from the entity in scope (artist/client/talent name) plus the fixed list: Ninetone, Ninetone Group, Ninetone Records, Ninetone Management, Ninetone Nation, Sundsvall, Stockholm, every category label in `API_BOOKING_TAG`.
8. **Markdown is preserved.** Bios go through translation before `renderBio`, as markdown, with an instruction to keep all markdown syntax, links and line breaks byte-for-byte except the prose.
9. **Pre-warm from a local script, not from the Worker.** `scripts/translate-warm.mjs` walks every entity via the FM helpers, translates every field that the site renders (reuse the field list the sitemap and llms.txt use, plus release pitch/social text and WebPosts), writes `{key, value}` pairs with the module's own key function, and loads them with `wrangler kv bulk put`. Idempotent: skips keys already present. Prints token counts and cost. Run it against staging before the PR is opened, on the `quality` tier for the ~12 voice pages and `fast` for the rest.
10. **Output contract with the model:** the response is only the translated text, no preamble, no quotes, no commentary. Enforce with the prompt and a guard that rejects responses that start with "Here", "Translation", or contain the source language name as a label; on rejection, retry once with `fast`→`quality`, then fall back to source.

## Build items

- `src/lib/translate.ts`: `translate({ text, target, tier, kind: "plain"|"markdown"|"title", protect: string[] })` → `{ text, cached: boolean, lang: "sv"|"en" }`; `translationKey()`; `t()` for chrome strings bound to `locals.lang`; the waitUntil scheduling; the override lookup; retries with backoff on 429/529; per-request budget (max 25 uncached calls per render, beyond that return source and schedule).
- `src/lib/i18n.ts`: `localizedPath(path, lang)`, `alternatePath(path, lang)`, `otherLang()`, and the hreflang pair builder used by `Base.astro` (`<link rel="alternate" hreflang="sv|en|x-default">`; x-default = Swedish).
- `src/middleware.ts`: locale detection + rewrite as in decision 2; must run before the edge-cache logic and must not break the Publish/contact API routes (`/en/api/*` is a 404, not a rewrite).
- `Base.astro`: `<html lang>` from `locals.lang`; `og:locale` and `og:locale:alternate`; canonical per locale; hreflang pairs; JSON-LD gets `inLanguage`.
- Header language switch: link to `alternatePath(currentPath, otherLang)` with `hreflang` and `lang` attributes on the link; label "EN" / "SV" as today.
- Sitemap: both locales for every URL, with `xhtml:link` alternates. llms.txt: Swedish at `/llms.txt`, English at `/en/llms.txt`.
- Chrome strings: every page and component. Do it file by file; keep source strings verbatim so overrides key correctly. Do not translate `aria-label`s with placeholders or anything inside `<code>`.
- Dates: Swedish format at root (`29 juli 2026`), English at `/en/` (`29 July 2026`), via `Intl.DateTimeFormat` with the locale, replacing the US-format output noted in the design critique.
- Tests (node:test): key stability, override precedence, output-contract guard, `localizedPath`/`alternatePath` round-trips, hreflang builder, middleware rewrite table (`/en/records` → `/records` with lang en; `/records` → sv; `/en/api/contact` → 404; `/en/` → `/`), per-request budget, waitUntil scheduling stub.

## Definition of done

- `npm test` green, both builds green, post-build audit clean.
- On staging: `/` and `/records` render Swedish chrome and Swedish content; `/en/` and `/en/records` render English; the same artist page at both URLs shows the bio in each language with markdown intact and the artist name untouched; `<html lang>` and hreflang pairs correct on both; language switch round-trips; sitemap has both locales; the warm script has been run and the PR description reports how many strings were translated, token totals, and cost.
- `scripts/i18n-list.mjs` output for the chrome strings attached to the PR description so Patrik can review the Swedish voice lines and write overrides.
- Every place a decision above could not be followed as written is listed in the PR description with the substitute.

## Implementation notes (added during execution — binding on later sections)

These do not reopen any decision above; they constrain HOW two of them are
implemented, after findings during the build.

**A. The warm script MUST reuse translate.ts's call path (constrains decision 9).**
Decision 9 correctly has `scripts/translate-warm.mjs` writing KV directly rather
than going through the render-time scheduling path. That stays. But the script
must NOT re-implement any of: the Anthropic API call, the system-prompt
assembly, the protected-terms block, the output-contract guard, or the
truncation (`stop_reason`) handling. Every one of those comes from
`src/lib/translate.ts`, exported for the script's use. Re-implementing them
would let the warm cache and the request-time cache diverge in ways nothing
tests and nobody notices until Patrik reads a bio that reads differently from
the one the site renders. The script owns only: entity walking, tier selection,
key generation via the module's own `translationKey()`, and the
`wrangler kv bulk put` load.

**B. The overrides import is bundler-load-bearing — verified, keep it verified.**
`loadOverrides()` in translate.ts reads `src/i18n/overrides.json` via a dynamic
`import(..., { with: { type: "json" } })` wrapped in `.catch(() => ({}))`. That
catch means a broken import is INDISTINGUISHABLE from an empty overrides file —
which is exactly how this mechanism was silently dead once already (the import
attribute was missing; plain Node ESM rejected it; the catch swallowed it).

Verified on this branch against a real `npm run build:cf`, by temporarily adding
a route that imports `translate()` so the module actually enters the bundle
(without an importer, Vite tree-shakes it out entirely and the check is vacuous):
Vite emits the JSON as a real code-split chunk, `dist/server/chunks/overrides_*.mjs`,
with the fixture hash and values inlined as a JS module, and the importing chunk
resolves it by relative path from the same directory. The mechanism survives the
Cloudflare bundle in its current dynamic form.

Consequences for later sections:
- Do not "simplify" that import without re-running this check. A static
  `import overrides from "../i18n/overrides.json"` is also inlined by Vite and
  is the safer form under a bundler, but it is NOT obviously safe for the warm
  script's plain-Node path — whichever form is chosen must work in BOTH.
- Once section 4 wires `t()` into real pages, the reviewer must re-confirm the
  fixture hash is present in `dist/server/chunks/` on a plain `build:cf` (no
  probe route needed by then), and that the override actually takes effect on
  staging — not merely that `node:test` passes. A second silent death under the
  bundler is the specific failure this note exists to prevent.

**C. Chrome strings must be pre-warmed too (extends decision 9).**
Decision 9 has `scripts/translate-warm.mjs` walking FM *entities*. Measured
during section 4, that is not enough: the homepage render tree
(index + Header + Footer + CommandPalette + the cards they mount) touches
**81 distinct chrome strings**, and the whole site has ~125. The per-request
budget is 25, so on a cold cache roughly 80% of chrome renders untranslated
and only creeps toward complete over many renders.

Raising the budget is the wrong fix. The budget exists to stop one visitor's
cold page load from running up unbounded spend and Worker CPU, which is a
real concern for unbounded FM prose but not for this corpus: the chrome
strings average ~18 characters, and translating **all ~125 of them costs
about $0.08 once**, permanently (the KV cache has no TTL). The correct fix
is to make sure production never does a cold chrome render at all.

So the warm script MUST also warm chrome:
- Discover the strings the same way `scripts/i18n-list.mjs` does (it already
  finds 99 statically-resolvable `t("…")` literals across 56 .astro files and
  honestly reports the ~14 variable-argument call sites it cannot see).
- Warm them on the `quality` tier — these are the voice lines Patrik reviews.
- Warm BOTH directions (`sv` and `en` targets), since decision 4 makes
  translation bidirectional and source strings exist in both languages today.
- The budget stays at 25. It is a runtime safety valve for the uncached
  long tail, not the mechanism by which the site gets translated.

Section 4 also added `src/lib/t.ts` (`sharedT`) because `createT()` alone
gave each component its own 25-call budget (Header + Footer + CommandPalette
+ page = ~100 allowed per render, four times the specified ceiling) and
because one repeated string could burn many slots — `booking.astro` renders
up to 100 ArtistCards all asking for `"Book"`. `sharedT` puts ONE budget on
`Astro.locals` and memoizes by source string per render. Later sections
should call `sharedT(Astro.locals)`, never `createT()` directly.

**D. Warm-script discovery must be build-instrumented, not source-parsed.**
Note C above makes `scripts/i18n-list.mjs` the warm script's discovery
mechanism. Section 4's review showed that is not sufficient on its own:
`i18n-list.mjs` resolves only plain literals passed directly to `t()`, and
roughly 26 of the site's highest-traffic strings are passed from array or
object literals that get mapped over, so they never appear in its table —
including the ENTIRE homepage portal grid, the ENTIRE metrics panel, and the
ENTIRE header nav, which render on all 546 pages. The strings the warm
script would most benefit from warming are exactly the ones it cannot see.

Known blind spots (verified against the 304-string output): `Header.astro`'s
`navItemsSource` (Hem/Records/Nation/Nyheter) and `t(cta.sv)`
(Kontakta oss, Idéer, Demos, Bokning via `sections.ts`); `index.astro`'s
`portalsSource` taglines and all eight `metricsSource` labels/notes;
`ArtistCard`'s "View" default; `Discography`'s Albums/EPs/Singles;
`YouTubeFeed`'s freshness ternary; `search-result.astro`'s "Previous
artists"; and the three metric labels on both contact pages.

So the warm script MUST discover chrome by INSTRUMENTING A BUILD rather than
parsing source: set an env flag that makes `sharedT` (src/lib/t.ts) append
every `source` string it is called with to a JSONL file, run `npm run build`
(the gh target renders all 546 pages and calls every `t()` on every page),
then warm the union of what that captures. This needs no parser, captures
all 304 statically-visible strings PLUS every blind spot above, and stays
correct as new call sites are added — a source scanner silently rots the
moment someone introduces another mapped literal.

Keep `scripts/i18n-list.mjs` as-is regardless: it is the human-facing review
table decision 5 asks for (Patrik reads it to write overrides), and it is
honest about the call sites it cannot resolve. It is a review artifact, not
the warm script's input.

**E. Never translate a prop a caller already translated.**
`RosterStrip.astro` documents the convention and `ArtistCard.astro` broke it:
both its callers resolve `await t("Book")` and pass the result down, so the
component ran `t("Book")` -> "Boka" -> `t("Boka")`. Different sha256 keys, so
the second hop is its own KV entry, its own budget slot and its own override
— and "Boka" appears as a literal nowhere in the source, so no discovery
mechanism can ever warm it. A component translates ONLY the strings it fully
owns (its own defaults); anything a caller supplies arrives already
resolved.

