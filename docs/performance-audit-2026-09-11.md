# Performance audit — 2026-09-11

## Scope and safety

Diagnostic audit of the page-load regression reported after SEO/i18n work, at repository HEAD `48bc524`. Live checks were bounded and read-only against existing staging URLs. No cache-busting query, Publish/API call, explicit translation API request, cache warming, forced miss, or production write was performed. The audit had no translation-provider telemetry, so it does not claim that an ordinary page GET could not have scheduled background work.

## Executive finding

The strongest source-supported explanation is server-side waiting on edge-cache misses, introduced in two stages. There is no live cold-miss or pre-change timing comparison in this audit, so this is a causal hypothesis supported by code, history, and a controlled dependency experiment rather than a measured historical regression delta:

1. SEO commit `a5b134f` changed a miss from a streamed response to `await res.arrayBuffer()`. This fixed a confirmed zero-byte-response race, but now the browser receives no byte until Astro finishes the entire HTML body.
2. i18n commits beginning at `a55a8e1` put every chrome string through async `t()`. Each distinct string hashes locally and then awaits a Cloudflare KV `get`, even if the source is already in the requested language. Many frontmatters issue these calls sequentially. The homepage has 68 direct `await t(...)` expressions at HEAD; the `a55a8e1` commit record measured 81 distinct chrome strings across its render tree.

The model API itself is not inline on deployed Cloudflare. The adapter supplies `Astro.locals.cfContext`; translation misses schedule model work with its `waitUntil`. Visitors still await the hash, override lookup, environment resolution, and KV lookup for each string.

The bounded staging samples were fast overall. Their individual cache states were not retained, so they cannot all be labeled warm hits. A later, separate probe confirmed that the four tested URL variants were hits at that later moment. The reported wait is consistent with the source-supported miss-path hypothesis and was not reproduced during this sample.

## Reproduction and environment

- Target: `https://ninetone-site.micke-ohlen.workers.dev`.
- Runtime: Astro 7 server output through `@astrojs/cloudflare` 14.3.1.
- Current local revision: `48bc524`.
- A staging response had `Last-Modified: Fri, 11 Sep 2026 20:54:27 GMT`, but exposes no git SHA; live measurements describe the observed deployment without asserting an unverifiable revision.
- Adapter source at `node_modules/@astrojs/cloudflare/dist/utils/cf-helpers.js:23-26` constructs `{ cfContext: ctx }`. Its legacy `runtime.ctx` getter throws. Current scheduling reads the supported property.
- No Chrome MCP was available. No dependency install or build was needed for this diagnostic pass.

## Request critical path

```text
request
  -> KV get("cache-version")
  -> page Cache API match (locale-specific key)
  -> hit: return cached HTML
  -> miss: Astro render
       -> FM/data reads as needed
       -> many t()/fmText() calls
            -> SHA-256 -> override lookup -> resolve env -> awaited translation KV get
            -> miss: schedule model + KV put with waitUntil, return source text
       -> complete all rendering
  -> await complete HTML stream via arrayBuffer()
  -> schedule page-cache put
  -> first byte reaches visitor
```

The cache-version KV lookup precedes the page cache match. During rendering, consecutive `await t(...)` calls create serial dependency depth. `sharedT()` memoizes identical strings (`src/lib/t.ts:294-331`), but does not batch distinct strings. `translate()` awaits `kv.get(key)` (`src/lib/translate.ts:812-817`).

`await res.arrayBuffer()` (`src/middleware.ts:362`) is a correctness mitigation for an evidenced Worker stream-tee race. Removing it directly risks restoring zero-byte 200 responses; a repair must preserve safe, single stream consumption.

## Git history and regression boundaries

| Commit | Change | Performance consequence |
|---|---|---|
| `acee25e` | Ordinary cookies stopped bypassing the page cache. | Consent/analytics cookies share cached pages. This improves cacheability and is not the i18n regression. Authorization, unknown queries, private/no-store/no-cache, `Set-Cookie`, errors, API/admin/404 remain protected. |
| `a5b134f` | Replaced response cloning with full `arrayBuffer()` before visitor/cache copies. | Every edge miss withholds first byte until complete SSR. This predates and compounds i18n; it fixed a real zero-byte response defect. |
| `a55a8e1` | Routed high-traffic chrome through `t()`; homepage gained 66 direct `await t()` expressions in that revision. | Primary i18n regression boundary: many translation KV reads entered the render path, often serialized. |
| `d886a16` et al. | Expanded `t()` across pages/components. | Broadened the overhead to routes and shared Header/Footer/CookieConsent. |
| `0cec832` | Routed FM titles/excerpts/bios through `fmText()`. | Added response-path translation KV reads on entity/news routes. |
| `48bc524` | Added missed homepage FM translations and locale-aware URL binding. | Added homepage translation lookups. URL binding itself is synchronous and not a meaningful cause. |

Locale is path-based (`/` vs `/en`), not cookie-based. The cache key retains `/en`. The earlier security fix removed arbitrary cookie bypass intentionally, because response-side policy protects private responses. An existing consent cookie neither causes this regression nor merges locales.

## Timing evidence

Each target received three GETs with a 20-second timeout. Values are seconds.

| Existing URL/request | TTFB samples | Median | Bytes |
|---|---:|---:|---:|
| `/` | 0.143, 0.074, 0.077 | 0.077 | 87,381 |
| `/` + existing consent cookie | 0.061, 0.161, 0.065 | 0.065 | 87,381 |
| `/en` | 0.064, 0.066, 0.064 | 0.064 | 87,459 |
| `/records` | 1.077, 0.164, 0.064 | 0.164 | 51,006 |
| `/en/records` | 0.068, 0.064, 0.071 | 0.068 | 51,030 |

The timing loop did not retain per-sample cache headers, so the 1.077 s `/records` point is unclassified; calling it a cold miss would overstate the evidence. A subsequent probe showed `/`, `/en`, `/records`, and `/en/records` as both `x-cache: hit` and `cf-cache-status: HIT`.

A controlled local experiment isolated serialization without Cloudflare or Anthropic. Fifty unique `createT()` calls used a mock KV whose `get()` waits 10 ms and always hits. Sequential awaits took 556.7 ms; `Promise.all` took 11.8 ms. This is not a production latency estimate. It proves the current source shape adds roughly the sum of distinct lookup waits, while batching reduces dependency depth to about one wait.

## Browser and asset evidence

The strongest source-supported regression hypothesis is before first byte. Post-TTFB resources are secondary candidates that require a browser trace:

- Homepage HTML measured about 87 KB.
- It references two blocking CSS files: 57,557 and 4,155 bytes in uncompressed curl transfers, plus one 4,341-byte module script.
- It preloads Newsreader roman (132,000 bytes) and italic (146,872 bytes). Italic appears in prominent display copy and may be above-fold critical on this design; without a browser trace this audit cannot classify that preload as wasteful.
- The likely homepage LCP image has `fetchpriority="high"`, explicit dimensions, and no HTML image preload. One direct existing-image sample was a 54,258-byte WebP with 0.389 s TTFB and 0.431 s total. One sample is not a distribution; proxy delay is a hypothesis to test in a browser trace, not a measured LCP contribution.
- The repository's earlier SEO Phase 1b Lighthouse record was FCP 1.9 s, LCP 5.0 s, TBT 0 ms, CLS 0. It predates i18n and is not a before/after baseline. It supports an existing server/image LCP issue.

The small own-JS transfer and historical zero TBT make browser JavaScript an unlikely explanation for a drastic blank-page wait. Full-body buffering plus server awaits better fits that symptom; fonts and the proxy hero then affect LCP.

## Findings and confidence

1. **High that the mechanism exists; medium that it dominates production:** serialized translation KV reads are the strongest source-supported new regression explanation. Code, commit boundary, counts, and the controlled timing experiment agree, but no cold live comparison measures their production share.
2. **High:** full-response buffering magnifies every miss and prevents progressive HTML delivery. It is also a correctness fix and must not simply be reverted.
3. **High:** inline Anthropic generation is not the deployed response-path cause. The adapter supplies `cfContext`; misses use `waitUntil`. KV reads remain inline.
4. **High:** the consent cookie does not bypass the page cache or select locale. Cookie/no-cookie homepage bodies had identical byte counts and similar warm timings.
5. **Medium:** FM translation wiring worsens entity/news miss TTFB. Added lookups are direct evidence; this audit deliberately did not force a live miss.
6. **Low pending trace:** hero proxy delay, CSS, and font prioritization may affect LCP after TTFB. Resource sizes are known, but their actual criticality and LCP contribution are not.

## Prioritized repair plan

1. Eliminate translation I/O only where the authored source language is explicit and matches the target. Do not use `target === "sv"` alone and do not promote the current `åäö` guess into a bypass rule: the homepage deliberately mixes Swedish and English source strings. Preserve explicit human overrides, request budgets, and memoization semantics.
2. Batch consecutive distinct translations with `Promise.all`, especially homepage and shared Header/Footer/CookieConsent. Keep request memoization and the shared 25-miss budget.
3. Add a bounded in-isolate translation read-through cache with in-flight deduplication, backed by permanent KV. This avoids dozens of network KV reads on each page-cache miss.
4. Add `Server-Timing` for cache-version KV, page-cache lookup, Astro render, translation KV count/time, FM time, and body buffering. Capture one natural/deploy miss and warm hit per locale before changing stream behavior.
5. Replace full-body gating only with a Workers-safe, tested cache strategy. Do not restore `res.clone()` teeing blindly; retain the zero-byte correctness evidence.
6. After TTFB fixes, use a browser trace to determine whether italic is required above-fold, whether both blocking CSS files are necessary, and whether an HTML hero preload improves LCP. Change prioritization only from that evidence, then measure three runs.

## Artifacts and commands

This document holds the minimal live timing table. The exact controlled benchmark and its recorded output are committed under `docs/audit-evidence/seo-i18n-2026-09-11/`. Temporary captures `/private/tmp/ninetone-perf-root.headers` and `/private/tmp/ninetone-perf-root.html` contain only public staging output and are not committed. No credentials, private API bodies, or non-public FM data were recorded.

Representative commands:

```sh
curl --silent --show-error --max-time 20 --output /dev/null \
  --write-out 'code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}\n' \
  https://ninetone-site.micke-ohlen.workers.dev/en

rg -n 'await t\(' src/pages/index.astro
git show --stat a5b134f a55a8e1 0cec832 48bc524
nl -ba src/middleware.ts | sed -n '273,376p'
nl -ba src/lib/translate.ts | sed -n '792,856p'
```
