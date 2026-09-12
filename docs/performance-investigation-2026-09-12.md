# Persistent page-speed investigation — 2026-09-12

## Checkpoint 0: baseline

- Investigation checkpoint complete; starting source baseline `32dbcd6`. Existing asset-URL changes were committed concurrently as `2255971` and preserved.
- Continue from `perf-handoff-2026-09-12.md`. Translation isolate cache is already implemented; prior serial-KV diagnosis needs fresh measurement.
- Preserve existing uncommitted `src/lib/url.ts` and `test/i18n.test.mjs` changes.
- No deployment, translation warming, cache purge, or form submissions.
- Keep full-body buffering until an alternative preserves the documented zero-byte-response fix; keep translation budget unchanged.

## Section 1: server response path

Local changes implemented and reviewed. Checkpoint: [Server report](performance-server-2026-09-12.md).

- Confirmed redundant work: current artist/client pages pass translated blurbs into `RosterIndex`, which translates them again. `fmText` memoizes source text; translated text has a different key and is not the memo hit claimed by the component comment.
- Fixed locally through an explicit `blurbsTranslated` contract on the two pre-translating callers. The previous-artists index still translates its raw inputs. This removes redundant work on current artist/client pages; it is not claimed as the explanation for the slow Previous Artists sample.
- Added request-local `Server-Timing` for cache-version lookup, page-cache lookup, initial render, body buffering, translation logical/physical KV reads, and FileMaker logical/network waits. Overlapping timings are distinguished from arithmetic sums; categories must not be added together.
- Focused tests: **69/69 passed**. Cloudflare build passed. The instrumented build has not been deployed, so the exact dependency behind the observed 4.462 s miss remains unmeasured.

## Section 2: browser rendering and payload

Complete. [Browser report](performance-browser-2026-09-12.md); retained public evidence: [summary](audit-evidence/performance-2026-09-12/README.md).

- Reproduced Previous Artists delay: `x-cache: miss`, TTFB **4.462 s**, total **4.467 s**; gzip transfer **55,030 bytes**, decoded HTML **439,513 bytes**. This is a confirmed page-cache miss, not proof of a cold isolate.
- Subsequent same-URL/body request: `x-cache: hit`, `cf-cache-status: HIT`, TTFB **0.146 s**. No stage-level timing is available from the deployed bundle yet.
- Unthrottled local browser on a page-cache hit: Previous Artists LCP **184 ms** (text), 3,506 DOM nodes, 551 links, 33 images; no failed requests. Large DOM is real but did not produce a multi-second rendering delay in this sample.
- Homepage loads three initially invisible portal background images totaling about **1.41 MB decoded**. This is a separate browser-resource cost, not an explanation for the measured 4.462 s server wait.

## Verification and next steps

### What the evidence establishes

The reported delay is reproducible in the server's page-cache-miss path. Compressed HTML delivery is not the cause of the measured 4.46 s wait; cached rendering is fast in the unthrottled browser sample. The exact split between FileMaker, translation KV, and rendering on that miss needs the newly instrumented build. A separate avoidable homepage cost is the hidden hover-panel images.

### Next concrete steps

1. Deploy the validated instrumented build to staging, then capture a natural page-cache miss and a hit with cache headers and `Server-Timing`. This audit did not deploy or purge caches.
2. Optimize whichever measured dependency dominates; retain translation budgets, locale correctness, and the buffered-response correctness fix.
3. Delay homepage hover-background requests until needed, then compare browser network/LCP under representative mobile conditions. No image behavior was changed during this investigation.

Saved reproducible browser script: `scripts/perf-browser-trace.mjs`. No secrets, cookies, or private content are in the retained evidence. Existing user work was preserved. Server timing tests and the CF build validate local changes; no live speedup is claimed before deployment.

## Section 3: review of the above, and the fixes actually applied

A verification pass re-derived every claim in sections 1–2 from source rather
than from these documents. Three of them needed correction, and one of the
changes proposed above was a live regression.

### Corrected: the 4.462 s hypothesis ranking was contradicted by this audit's own evidence

`browser-trace-summary.json` contains the control that refutes the leading
explanation. In the same curl series, `/` returned **688 ms** on `x-cache: miss`
and `/en` **767 ms**, against 4,462 ms for `/records/artists/previous`. The
homepage carries *more* serial chrome `await t()` depth (index.astro's 69 plus
Header/Footer/CommandPalette ≈ 103, versus ≈ 42 on previous-artists) and *more*
FM round-trips. Serial translation-KV depth and cold-isolate FM session cost are
therefore bounded well under a second and cannot explain the delta.

Two named suspects are ruled out by code, not measurement:

- **Translation misses cannot produce a slow page.** `src/lib/translate.ts`
  never awaits the Anthropic call inline — on a KV miss it returns source text
  immediately and schedules the job via `waitUntil`. A cold translation cache
  yields a *fast Swedish* page, not a slow one.
- **`arrayBuffer()` buffering is load-bearing**, not overhead; it is the
  documented zero-byte-response mitigation and stays.

The one load on this route with no homepage analogue is
`getPreviousArtists()` (`src/lib/ninetone.ts`) — a single FM find with
`limit: 1000` returning ~341 full `API_ARTIST_DETAIL` records, rendered on
page 1 as 30 cards *plus* a complete A–Ö index of the whole roster. Instrument
**FM payload cost first**; the priors in section 1 were inverted.

### Corrected: `stale-while-revalidate` is a known limitation, not a new bug

`src/middleware.ts` sets the header but has no stale-serve branch, so on
workers.dev one visitor per TTL eats the full regeneration. The module header
already documents this ("the Worker-level Cache API simply expires"). It was
**deliberately left alone**: the cache key embeds the Publish epoch, so any
stale-serve that can match a key without the current epoch silently defeats the
Publish button for up to 6 h, failing per-colo and reading as "flaky FM".

### Fixed: the `blurbsTranslated` contract was wrong on one caller

Section 1's de-duplication added `blurbsTranslated` to both pre-translating
callers. On `management/clients.astro` that assertion was **false**: the page
translates into `clientPresentationString` (what its cards read), while
`RosterIndex` reads `artistPresentationShort`, which the object spread carries
through untranslated. The flag short-circuits `resolveFmDisplayText`, so the
A–Ö index would have rendered Swedish prose on `/en` with **no visible
symptom** — source text is the intended render on a miss, so the page looks
entirely healthy. Verified in isolation before and after the fix.

`records/artists.astro` was correct as written (it translates the same field
the component reads) and is unchanged. `previous/[...page].astro` still must
NOT assert the flag: it passes `allPrevious`, a different and untranslated
array from the 30-record slice it pre-translates.

`test/roster-index-contract.test.mjs` now pins this contract for every caller
and was confirmed to fail against the unfixed code.

### Fixed: hover-only artwork, at ~4x the reported scope

Section 2 measured 1.41 MB across three homepage banners. The identical
pattern lives in `SplitPortalHero.astro`, so `/records`, `/management` and
`/ninetone-nation` carry the same cost — **2,840,088 B across seven files**,
downloaded by every first-time visitor to render something only reachable on
hover, and never reachable at all on touch.

The cause is encoding, not dimensions. All seven are 864x1117 PNGs of
photographic content; the portal grid is full-bleed, so a 640 CSS px column
needs 1280 device px at DPR 2 — they are *undersized*, and downscaling would
make them worse. WebP q82 at identical pixel dimensions: **2,840,088 B ->
113,914 B (-96%)**; the homepage three go from 1,410,758 B to 55,076 B.

Compression is invisible by construction: the layer renders under
`mix-blend-multiply` at `opacity-50` over dark brand colors, which attenuates
every per-pixel error. Verified two ways — arithmetic on the composited
buffers (mean < 0.3/255 per channel), and a CDP capture of the *rendered*
hover state before and after, driven by `CSS.forcePseudoState`:

| rendered hover diff | value |
|---|---:|
| mean abs delta | 0.037 / 255 |
| max abs delta | 3 / 255 |
| subpixels > 5/255 | 0 of 604,800 |

Both URLs route through `src/lib/hover-art.ts` (two call sites cover all ten
references) so a partial rename cannot leave one page silently image-less — a
404 here is pixel-identical to the correct un-hovered state and would not fail
the build. The PNGs stay in `public/images/` as the editable source. `url.ts`
already exempts `.webp` from locale prefixing; `/en` renders were checked on
all four pages.

`image-set()` with a PNG fallback was evaluated and rejected: an inline
`style` attribute cannot express a cascade, and every browser that parses
unprefixed `image-set()` already decodes WebP, while those that do not would
render nothing instead of the PNG. The honest fallback is the design — the
layer is `opacity-0` over a separately-painted brand color, which is exactly
what every touch device already sees.

### Verification

- Full suite **366/366** (361 pre-existing + 5 new contract tests).
- `npm run build:cf` clean; all routes 200 on a local Worker, both locales.
- Not deployed. No cache purge, no translation warming, no FM-side change.

### Still open

- `Server-Timing` ships publicly on every response. Values are numeric with
  fixed metric names (no route, key, or content), and it is the instrument
  needed for the FM-payload question above, so it stays on pre-launch.
  Revisit at launch alongside the noindex flips.
- `public/images/favicon.png` (492 KB, 2234x2234) is referenced nowhere —
  `Base.astro` uses `/favicon.svg`, `/favicon.ico`, `/apple-touch-icon.png`.
  It is dead weight in `dist/`, costs nothing at runtime, and was left in
  place rather than deleted unprompted.
