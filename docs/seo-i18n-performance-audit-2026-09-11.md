# SEO, translations, and performance audit — 2026-09-11

## Checkpoint 0 — scope and baseline

- Status: audit complete; findings saved at each section boundary. No application changes or deployments performed.
- Starting revision: `48bc524`; working tree clean at start.
- Scope: audit recent SEO and translation additions; diagnose the reported page-load regression with source/history and measured evidence.
- Preserve the FileMaker live CMS architecture, locale behavior, and security controls. Do not add SEO packages or replace architecture merely to satisfy a checklist.
- Budget discipline: ASTRA coordinates/reviews; SOL/TERRA perform bounded investigations. Save evidence before further work; avoid duplicate builds and bulk translation/AI calls.

## Section 1 — SEO

Complete and reviewed. Detailed checkpoint: [SEO audit](seo-audit-2026-09-11.md).

- Confirmed live: `/en/integritet` returns Swedish HTML with a Swedish canonical, yet hreflang and sitemap advertise an English counterpart. Swedish-only guide pages have the same source-level contradiction.
- Confirmed live: normal Swedish/English roster pages have correct self-canonicals and reciprocal hreflang.
- Live sitemap: **1,086 unique URLs**, 543 per locale. Locale availability needs filtering for Swedish-only content.
- Secondary findings: Swedish homepage has an English description; search results lack a permanent route-specific noindex for launch.
- Current preview-wide noindex is intentional, not a defect. Full existing test suite: **349/349 passed**; integration findings still stand.

## Section 2 — translations

Complete and reviewed. Detailed checkpoint: [Translation audit](translations-audit-2026-09-11.md).

- Confirmed regression: English contact forms locale-prefix their action to `/en/api/contact`, while middleware rejects `/en/api/*`. See the section report for source evidence and remediation.
- Confirmed regression: both search interfaces consume locale-neutral result links and send English visitors to Swedish pages.
- Secondary issues: untranslated command-palette labels; Swedish-only policy/guide pages need consistent locale discovery metadata.
- Existing targeted i18n, middleware, date, and translation tests: **100/100 passed**. They do not cover the two functional integration bugs above. No application changes made.

## Section 3 — page-load regression

Complete and reviewed. Detailed checkpoint: [Performance audit](performance-audit-2026-09-11.md). Reproducible benchmark and recorded output are saved in `docs/audit-evidence/seo-i18n-2026-09-11/`.

- AI translation itself is scheduled in the background on misses; the awaited translation-KV reads remain in the response path. Inline AI generation is not supported as the explanation by the reviewed Cloudflare implementation.
- Strongest explanation: SEO commit `a5b134f` buffers complete HTML to fix zero-byte responses; i18n commits starting at `a55a8e1` add many serial translation-KV waits before that body completes. Current homepage has 68 direct `await t()` expressions. This compounds **cache-miss TTFB**, not necessarily warm-cache performance.
- Bounded live median TTFB: `/` 77 ms; `/en` 64 ms; `/records` 164 ms; `/en/records` 68 ms. A later probe confirmed cache hits; individual timing samples did not retain cache headers. The 1.077 s roster outlier cannot be labeled a cold miss.
- Controlled mock experiment: 50 unique translations with a 10 ms KV delay took 556.7 ms sequentially versus 11.8 ms in parallel. This demonstrates serialization cost, **not a measured production speedup**.
- Ordinary consent cookies do not bypass the current page cache. Earlier cookie-bypass behavior has already been changed; it is not the current regression.
- No historical/current cold-load pair or current browser trace was captured. Fonts and hero-image delivery remain secondary candidates; no new Lighthouse/LCP/INP score is claimed.

## Verification and next actions

The full existing suite passed **349/349**; the targeted translation subset passed **100/100** (included coverage, not an additional 100 distinct tests). These passing tests do not exercise the broken contact/search compositions or enforce a latency budget. No builds were needed for this audit.

Recommended implementation order:

1. Repair the locale-neutral contact API action and preserve language on client-generated search navigation; add integration regressions.
2. Batch independent translation reads on the homepage and shared components. Preserve request budgets, memoization, editorial overrides, locale separation, and fallback behavior. Only bypass translation for explicitly known source-language content; the current site contains mixed-language source strings.
3. Instrument natural cache misses with server timings before considering a streaming redesign. Preserve the existing protection against zero-byte responses. Consider a bounded translation read-through cache with defined invalidation.
4. Align Swedish-only route availability across canonical, hreflang, sitemap, and language switch; localize homepage metadata and permanently noindex internal search.
5. Verify cold/warm behavior after implementation on the affected deployment, then investigate fonts/images with a browser trace if LCP remains slow.

Resume from this file and the three linked reports. The user was asked which deployment/page feels slow; no answer was available at this checkpoint, so live checks used the configured Cloudflare staging host. GitHub static-preview behavior was reviewed only where noted, not timed as a substitute for Cloudflare SSR.
