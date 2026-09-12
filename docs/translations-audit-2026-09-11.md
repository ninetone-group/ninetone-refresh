# Translation and locale audit — 2026-09-11

## Scope and method

- Status: complete; this file is the translation-only review checkpoint.
- Baseline: `48bc524` (`fix(i18n): keep the locale across every internal link, and fix the switch`).
- Constraints: source/history review and targeted existing tests only. No production mutation, cache warming, AI translation calls, builds, or changes to the FileMaker live-CMS architecture.
- Review areas: locale routing and link preservation; language switch; search and date localization; translation call context; request isolation, cache keying, and fallback behavior.

## Findings

### P1 — English contact forms are routed to a deliberate 404 (verified)

- Evidence: `src/components/ContactForm.astro:10` replaces `url` with `urlFor(Astro.locals)`, and `src/components/ContactForm.astro:84` derives the form action through it. On an English render this produces `/en/api/contact`; both the native form action at `:161` and client-side `fetch(form.action)` at `:324` use that URL.
- Conflict: `src/middleware.ts:198-210` explicitly rejects `^/en/api(/|$)` with HTTP 404 so locale-prefixed API routes cannot reach handlers. The intended contact endpoint is the locale-neutral `/api/contact`.
- Impact: every runtime contact form on `/en/...` fails before the API handler. Swedish and static-mailto modes are unaffected.
- Cause: commit `48bc524` applied the locale-bound internal-link helper to an API action, despite API routes being excluded from locale routing.
- Fix: retain locale binding for visitor navigation links, but use the base-aware non-locale `url("/api/contact")` for the action. Add a regression test covering this composition and the middleware’s intentional `/en/api/contact` 404.

### P1 — Both search surfaces lose the selected locale (verified)

- Evidence: `src/components/CommandPalette.astro:137-155` and `src/pages/search-result.astro:137-143` always fetch the locale-neutral `/search-index.json`. `src/pages/search-index.json.ts:34-128` neither reads `locals.lang` nor localizes its returned `href` values (`:56`, `:69`, `:82`, `:95`, `:108`, `:121`). The two browser renderers then write those bare hrefs into result anchors (`CommandPalette:230-243`; `search-result:150-154` and its result template).
- Impact: an English visitor who opens a command-palette or search-results item is sent to Swedish. This bypasses the `urlFor(Astro.locals)` sweep because the links are constructed in client scripts from a shared JSON endpoint.
- Fix: make the index response locale-aware and use a locale-specific request URL (or include locale-free route data and prefix client links from the current locale). The cache and response key must vary by locale if translated search text is served. Add an end-to-end/rendered regression assertion for an `/en/` search result href.

### P2 — Command palette chrome remains English on Swedish pages (verified)

- Evidence: the server-rendered shell is translated at `src/components/CommandPalette.astro:15-28`, but the client-only `SECTION_LABELS` object is hardcoded English at `:112-119`, and empty states default to English at `:204-211`. The component documents this gap at `:8-14`.
- Impact: Swedish visitors receive English category labels and empty-state copy after opening the palette. This is especially visible on every page because the component is mounted from the base layout.
- Fix: pass translated labels and empty-state strings as server-rendered data attributes, following `src/pages/search-result.astro:79-133`; avoid browser translation calls.

### P2 — `/en/` policy and guide pages deliberately retain Swedish (SEO alignment pending)

- Evidence: `src/layouts/Base.astro:62-106` correctly prefers `Astro.locals.lang`, but the only two explicit `lang="sv"` call sites override it: `src/pages/integritet.astro:5` and `src/pages/guider/[slug].astro:83`. The policy page remains hardcoded Swedish; the guide route also does not use `fmText` for its FM body before rendering.
- Status: this is a deliberate content exception, not a confirmed functional defect. SEO must verify whether the hreflang/sitemap exposure matches that exception before a routing or translation change is proposed.
- Follow-up: decide whether to translate these route bodies and remove the forced Swedish prop, or exclude them from English sitemap/hreflang and locale navigation.

## Verification performed

- Source/history review through `48bc524`; no runtime calls, cache writes, translation calls, or builds.
- Verified the contact failure by code-path composition: `urlFor` adds `/en`; middleware’s regex returns 404 before route dispatch.
- Verified search-link and command-palette failures by tracing request and DOM construction paths.
- Targeted tests passed: `node --experimental-strip-types --test test/i18n.test.mjs test/middleware.test.mjs test/dates.test.mjs test/translate.test.mjs` — 100/100. The suite already verifies locale-distinct edge-cache keys, `/en/api/contact` is a 404, path/switch invariants, dates, translation-key target/tier separation, override precedence, request budget, and async fallback scheduling. It does not cover the ContactForm action or either client search surface.
- Request-isolation/cache review: no defect confirmed. `sharedT` stores its memo and 25-call budget on the per-request locals object (`src/lib/t.ts:254-322`), and the translation cache key includes version, target locale, tier, and content hash (`src/lib/translate.ts:175-205`). Middleware preserves the raw locale-prefixed pathname for the edge-cache key (`src/middleware.ts:184-196,300-302`).

## Prioritized fixes

1. Correct the English contact form action (P1) and test it.
2. Make search index request/result hrefs locale-safe (P1) and test both search UIs.
3. Localize command-palette client-only labels through server-rendered data (P2).
4. Have the SEO review determine whether the deliberate Swedish policy/guide exception aligns with sitemap and hreflang (P2).

## Conclusion

Locale routing, language switching, date formatting, translation cache keying, request budgeting, and edge-cache locale separation are covered by the targeted suite and source review. The final link-preservation sweep missed API actions and client-generated search links; these are the highest-impact implementation fixes. No source changes were made by this audit.
