# Browser and payload investigation — 2026-09-12

## Checkpoint 1: scope and initial live response evidence

- This report owns browser rendering and HTML payload evidence only. Server
  instrumentation is tracked separately in `performance-server-2026-09-12.md`.
- The subsequently committed asset-prefix fix (`2255971`) is preserved and is
  outside this investigation.
- No deployment, cache purge/warm, cache-busting request, form submission, or
  source behavior change has been made.
- Browser tooling found: local Google Chrome and cached Playwright Chromium
  headless shells; the latter supplied the trace below.

### Bounded staging fetches

These are one `curl --compressed` GET per public URL on 2026-09-12. The
persisted selected headers and timings are in
[`audit-evidence/performance-2026-09-12/browser-trace-summary.json`](audit-evidence/performance-2026-09-12/browser-trace-summary.json).
They are observations, not cold-isolate measurements; response cache state must
be read from their saved headers before interpreting them.

| Route | HTTP | TTFB | Total | compressed transfer |
|---|---:|---:|---:|---:|
| `/` | 200 | 0.688 s | 0.689 s | 13,650 B |
| `/en` | 200 | 0.767 s | 0.768 s | 13,495 B |
| `/records/artists/previous` | 200 | 4.462 s | 4.467 s | 55,030 B |

The handoff's 440 KB prior-page value was uncompressed/decoded HTML. It should
not be compared directly with the 55 KB content-encoded transfer above.

### Source finding: roster index impact needs qualification

`RosterIndex.astro` has no `<img>` elements. The normal Records and Management
list pages render it with `display: none`; its text and links still increase
HTML parse/DOM cost but do not cause image requests while hidden. The Previous
Artists page renders it inside a collapsed `max-height: 0` panel and explicitly
passes `visible`, so it is in the DOM and carries every index entry. It duplicates
artist name, blurb, tags and link relative to the card grid, but not artist images.

This source evidence establishes document duplication, not that it is the cause
of the slow TTFB nor that hidden-tab images are downloaded. The browser trace
will measure DOM counts, loaded resources and LCP separately.

## Checkpoint 2: live cache comparison and Chrome trace

### Same URL, miss then subsequent hit

The first bounded compressed fetch of `/records/artists/previous` returned
`x-cache: miss`, `x-cache-ttl: 21600`, and gzip content encoding. Its TTFB was
4.462 s and its decoded body was 439,513 B. A subsequent repeat, 130 seconds
later (first response `date: 07:54:15 GMT`; second `date: 07:56:25 GMT`),
returned the byte-identical body with `x-cache: hit`, `cf-cache-status: HIT`,
`age: 130`, and a 0.146 s TTFB. The repeat's `cache-control` was
`public, max-age=60, s-maxage=21600, stale-while-revalidate=21600`.

This is a strong page-cache-miss versus hit observation. It is **not** a cold
isolate measurement: the isolate age and all server substeps are unknown. No
`Server-Timing` header was present, so this report cannot allocate the 4.462 s
miss to FM, translations, Astro render, or body buffering.

### Headless Chromium capture

`scripts/perf-browser-trace.mjs` is the retained reproduction harness. It used
the already-installed cached Playwright Chromium headless shell, an empty
browser profile, and CDP `Performance`, `Network`, and DOM resource timing.
It navigated `/`, `/en`, and `/records/artists/previous` once each, without
forms, queries, cache purge, warm, or writes. It waited 3.5 seconds after load
before reading LCP candidates. The compact, public-only retained summary is
[`audit-evidence/performance-2026-09-12/browser-trace-summary.json`](audit-evidence/performance-2026-09-12/browser-trace-summary.json);
the full temporary CDP JSON was intentionally not retained.

| Route | page-cache state seen by Chrome | DOM nodes | links | `img` elements | captured LCP | loading failures |
|---|---|---:|---:|---:|---|---:|
| `/` | `x-cache: hit`, `cf-cache-status: HIT` | 778 | 102 | 33 | H1 text, 496 ms | 0 |
| `/en` | `x-cache: hit`, `cf-cache-status: HIT` | 778 | 102 | 33 | H1 text, 156 ms | 0 |
| `/records/artists/previous` | `x-cache: hit`, `cf-cache-status: HIT` | 3,506 | 551 | 33 | P text, 184 ms | 0 |

This is a local desktop headless trace without network or CPU throttling, so
these LCP values are useful for resource selection and page shape, not a field
performance promise. In particular, the prior miss/hit experiment is the
relevant evidence for the slow first page response; the trace intentionally
observed hits after that cache was populated.

### Actual homepage payload waste: hidden portal banners load

On the fresh-profile homepage navigation Chrome downloaded all three portal
background images, even though each image container starts at `opacity-0` and
only becomes visible on hover. They are inline CSS `background-image` values
in `src/pages/index.astro` and show as `initiatorType: css` in the browser:

| Resource | decoded bytes | browser start–end |
|---|---:|---:|
| `/images/recordsBanner.png` | 268,647 B | 350–463 ms |
| `/images/managementBanner.png` | 717,369 B | 350–476 ms |
| `/images/nationBanner.png` | 424,742 B | 350–512 ms |

Those images total **1,410,758 decoded bytes**. The same navigation also
downloaded the intentionally preloaded Newsreader roman and italic faces
(132,000 B and 146,872 B), while the main global CSS transfer was 10,678 B
compressed / 57,557 B decoded. Total resource transfer in that capture was
1,776,177 B. This is confirmed browser behavior, not a raw-source estimate.

It affects real first-load bandwidth and connection contention, but neither
the observed homepage LCP candidate nor the browser failures attribute an LCP
delay to these banners. The least speculative follow-up is to defer these
hover-only backgrounds, then re-run this same trace with a fresh profile and
measure the before/after resource list. Do not call it an LCP fix without that
comparison.

### HTML weight and RosterIndex conclusion

The Previous Artists miss transfers only 55,030 gzip bytes but expands to
439,513 B of HTML. Its 3,506 nodes and 551 links are materially larger than
the homepage's 778 nodes and 102 links. The `RosterIndex` is present inside
the collapsed panel and repeats text/link metadata for the overall roster; it
does not contain images, and the trace recorded the same 33 `img` elements as
the homepage. Therefore its proven costs are SSR/HTML transfer/decompression,
HTML parsing, DOM memory, and link count. The evidence does not support a
claim that it causes hidden roster image downloads.

### English asset route evidence

A bounded direct request returned `404` for `/en/images/LogoDark.svg` (the
root `/images/LogoDark.svg` returned `200`). The deployed English homepage's
actual header request was `/images/LogoDark.svg`, so its Chrome trace had no
asset failure. Commit `2255971` addresses this route construction issue and
was not changed by this investigation.

## Next browser actions after a source change

1. Test deferred portal backgrounds in a fresh Chrome profile and compare the
   exact resource list/bytes; keep the hover interaction visually functional.
2. If changing the Previous Artists index, compare decoded HTML, DOM nodes,
   links, and page-cache-miss/hit TTFB separately. Do not infer server-time
   savings from DOM counts alone.
3. Re-run the trace after Server-Timing lands so a natural page-cache miss can
   be correlated with server phases. Preserve the full-body buffering safety
   fix until an alternative has its own correctness evidence.
