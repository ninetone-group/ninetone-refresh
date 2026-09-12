# Server performance investigation — 2026-09-12

## Scope and safety

Server-side investigation of the persistent page-speed report after the i18n work. This track owns request timing in middleware, translation reads, FileMaker reads, and response buffering. It does not deploy, purge caches, warm translations, change the 25-call translation budget, or revert the `arrayBuffer()` zero-byte-response mitigation.

## Starting checkpoint

- Repository HEAD at start: `32dbcd6`; concurrent static-asset work advanced it to `2255971` during this track.
- Existing user work in `src/lib/url.ts` and `test/i18n.test.mjs` is out of scope and will not be touched.
- Prior evidence: warm edge-cache hits are generally about 0.07–0.15 s; cache-busted SSR samples about 0.08–0.18 s; a reportedly natural cold isolate has reached roughly 4–5 s, but no stage-level measurements separated that request.
- The isolate translation read-through cache is already implemented. This investigation will measure it rather than repeat that repair.
- First task: introduce request-local timing that distinguishes cache-version KV, edge-cache lookup, Astro render, translation KV read count/wall time, FileMaker wait count/wall time, and response buffering.

## Evidence log

### Implemented locally (not deployed)

`Server-Timing` now separates:

- `cachever`: cache-version KV read.
- `cache`: Worker Cache API lookup.
- `render`: the await of Astro's route render.
- `buffer`: consumption of the rendered response body. Astro streams HTML, so work that occurs while the body is consumed appears here rather than being incorrectly attributed to `render`.
- `trnread`: logical translation-cache waits, including isolate hits and waits on an in-flight read.
- `trnkv`: physical translation KV reads. An isolate hit increments `trnread` but not `trnkv`.
- `fmread`: logical FileMaker data waits, including in-memory hits and in-flight deduplication.
- `fmnet`: uncached FileMaker request work, including token acquisition, HTTP, JSON parsing, and a bounded authentication retry.

For metrics with concurrent calls, `dur` is the union of their time intervals (elapsed wall time). The description contains `n` and the arithmetic `sum` of individual waits. The sums overlap and must not be added to each other or to request elapsed time. Metrics use fixed names and numeric values only; no route, cache key, layout, error, credential, or content value enters the header.

The timing store uses Workers-supported `AsyncLocalStorage`, enabled by this project's existing `nodejs_compat` flag. A concurrent-request test verifies request isolation. The response header is attached after middleware finishes and after the Worker Cache API copy is constructed, so a later Worker invocation refreshes the header instead of replaying the timing that created that cache entry. An outer CDN cache can still replay the original response headers without invoking the Worker; interpret `Server-Timing` only alongside `x-cache` and `cf-cache-status`. No response is forcibly buffered for telemetry. Cache misses already consume the body because of the existing zero-byte-response mitigation. Cache-hit and bypass responses remain streamed, so body work that happens after their headers are returned is intentionally absent from these application timings.

### Bounded staging observations

Three ordinary GETs against the existing deployment on 2026-09-12 (no query-string cache bust, purge, warm call, or write):

| Route | TTFB | Total | Body bytes | Observed cache state |
|---|---:|---:|---:|---|
| `/` | 0.200 s | 0.210 s | 87,761 | `x-cache: hit`, `cf-cache-status: HIT` |
| `/en` | 0.217 s | 0.230 s | 87,739 | `x-cache: hit`, `cf-cache-status: HIT` |
| `/records/artists/previous` | 0.068 s | 0.195 s | 439,513 | `x-cache: hit`, `cf-cache-status: HIT` |

These establish only warm-hit behavior. They do not explain the reported 4–5 second natural cold-isolate request because the local instrumentation has not been deployed. The 440 KB previous-roster HTML body adds about 0.13 s after TTFB in this sample; compression and browser rendering still need the browser track's evidence, so this is not a causal allocation.

### Confirmed duplicate translation path

`RosterIndex.astro` claimed already-translated blurbs cost one request-memo hit. The claim was false: `fmText()` keys the request memo by the exact input text. The artists and clients pages replace the Swedish source field with its English translation before passing their arrays into `RosterIndex`; the component then asked `fmText()` to translate that English output again under a distinct memo and KV key. This produced one extra logical translation read per unique blurb and, on a miss, could consume the translation budget for unnecessary English-to-English background jobs. The fix adds an explicit `blurbsTranslated` contract for the two pre-translating callers; the previous-artists caller keeps the component translation. Its production time share remains unmeasured until the timing build is deployed.

### Verification

- Focused Node tests: 69 passing across middleware, translation, and server timing.
- Cloudflare server build: passed with Wrangler logging redirected to `/private/tmp`.
- `git diff --check`: clean.

Primary runtime references: [Cloudflare Workers AsyncLocalStorage](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/), [Workers Headers](https://developers.cloudflare.com/workers/runtime-apis/headers/), and [Workers Response](https://developers.cloudflare.com/workers/runtime-apis/response/). The implementation uses only the supported `AsyncLocalStorage` constructor, `run()`, and `getStore()` subset plus standard response headers.
