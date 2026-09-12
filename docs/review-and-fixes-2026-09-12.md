# SEO + translations + performance: review and fixes — 2026-09-12 (evening)

Orchestrated review of everything landed on `i18n-phase-2` between 2026-09-10
and 2026-09-12 (SEO phases 1/1b, i18n phase 2, the performance investigation,
and the translate-before-publish subsystem). Four read-only investigation
agents (perf hot path, SEO layer, i18n runtime, publication subsystem) reported
to one reviewer, who verified the load-bearing claims independently, measured
staging, and applied the fixes below. **Nothing was deployed.** All changes are
in the working tree, uncommitted, with the test suite at 644/644 and
`npm run build:cf` green.

## 1. The slowness, measured

The deployed bundle (`c514fa5e`) already emits `Server-Timing`, so an uncached
render can be measured directly (an unknown query parameter bypasses the page
cache — the same path a real page-cache miss takes):

| Route (page cache bypassed) | TTFB | What the time was |
|---|---:|---|
| `/records/artists/previous` | 3.94 s | `fmnet 3002 ms (n=3)` — FileMaker itself; `trnkv 457 ms (n=38)` |
| `/` | 4.27 s | `trnkv 3750 ms (n=83)` — 83 **serial** translation KV reads |
| `/en/records/artists/previous` (isolate warm from the previous line) | 0.69 s | FM served from the 60 s in-memory cache |

Two conclusions the earlier documents did not have:

1. **FileMaker is a multi-second term on cold isolates.** The 2026-09-12
   perf report ruled FM out from a warm-isolate measurement, where the 60 s
   in-memory cache hid it. On a cold isolate the previous-artists find set
   costs 3 s.
2. **`Server-Timing` under-counts, and so would any AsyncLocalStorage-based
   per-request state.** The 38 reads recorded for Previous Artists are exactly
   the page's own frontmatter (8 chrome strings + 30 card blurbs); the 341
   RosterIndex reads and every Header/Footer/CommandPalette read were not
   captured. The async context does not survive into Astro child-component
   rendering under workerd. Per-request state that components must see has to
   ride on `Astro.locals`.

Everything else in the perf handoff held up: warm hits are ~0.1 s, CPU is
single-digit milliseconds, the 440 KB HTML is not the cause, `arrayBuffer()`
buffering stays, the 25-call budget stays.

## 2. Fixes applied

### Performance (cold-isolate render cost)

| Change | Where | Effect |
|---|---|---|
| **Route translation bundle** — one KV key per (locale, route) with every translation the last render resolved; read before render, seeds the isolate cache, written back via `waitUntil` only when the ledger changed; 6 h TTL | `src/lib/translate.ts`, `src/middleware.ts`, `src/lib/t.ts` | N serial/parallel translation reads → 1 read on every cold isolate after the first |
| **Bulk KV reads** — reads requested in the same tick are flushed as one `get([...keys])` (≤100), feature-detected, falls back to single reads | `src/lib/translate.ts` | a 341-wide `Promise.all` costs 4 connections instead of ~57 sequential round trips (Workers allow 6 simultaneous connections; KV counts) |
| **`cacheTtl` on translation reads** (6 h, capped at the bundle TTL) | `src/lib/translate.ts` | colo-edge hits for subsequent cold isolates in the same colo |
| **KV miss no longer pinned in the isolate cache** | `src/lib/translate.ts` | an isolate that missed a key re-reads it after the scheduled translation lands; previously it re-scheduled the same model call on every render for its lifetime |
| **Degraded renders cached for 60 s, not the tier TTL** — `RequestBudget.refusedCount` > 0 marks the render; `x-translation: degraded; refused=N` header | `src/lib/translate.ts`, `src/middleware.ts` | a half-translated page can no longer be pinned at the edge for up to 24 h |
| **FM find KV read-through** — 120 s TTL, key = `fm:v1:{cache-version epoch}:{shape}:{layout}:{sha256(body)}` | `src/lib/fm-kv.ts`, `src/lib/filemaker.ts` | a cold isolate reads ~1 MB from KV instead of waiting seconds on FM; Publish still forces a live read because the epoch is in the key; the publication tick keeps this layer warm |

The `sv`/`en` key populations in KV were checked before shipping the degraded
rule: 5,947 Swedish-target and 5,957 English-target entries exist, so Swedish
renders are not systematically degraded.

### SEO

| Finding | Fix |
|---|---|
| P1 — `/en/integritet` and `/en/guider/*` served 200 with Swedish HTML canonicalised to the Swedish URL (crawlable soft-duplicate) | middleware 301s any `/en/` request for a Swedish-only path to the bare path, query preserved (`hasEnglishVersion` is now enforced on the serving side too) |
| P1 — English pagination titles said `· Sida N` | `paginatedTitle(base, page, lang)`; English says `· Page N` |
| P1 — `/en/llms.txt` was byte-identical to Swedish and linked only Swedish URLs; the Swedish manifest had English headings | English manifest links `/en/…` throughout; Swedish manifest uses a static `LLMS_CHROME_SV` table; no live `t()` calls in the endpoint any more |
| P2 — `X-Robots-Tag` in `_headers` never applied to SSR HTML | `harden()` sets it on every Worker response while `PUBLIC_NOINDEX` is not `"false"` — same single flag as the meta tag and robots.txt |
| P2 — `WebSite.potentialAction` targeted the permanently noindexed `/search-result` | removed |
| P2 — 404 pages emitted a self-canonical, hreflang cluster and og:url for a nonexistent URL | `Base` gained `omitCanonical`; `404.astro` passes it |

Verified OK by the SEO review and left alone: sitemap (1,084 locs, both
locales, correct pagination, no assets), `/sitemap.xml` alias, robots, JSON-LD
shapes and escaping, OG, `<html lang>`, redirect layer, search noindex.

### i18n

Both regressions from the 2026-09-11 audit (contact form action under `/en/`,
locale-neutral search links) are confirmed fixed live. The locale routing layer
is sound. New tests pin `sharedT`/`fmText`'s two contracts (one budget per
render, memo by exact string), which had zero coverage.

### Publication subsystem

Correction first: **it is deployed** (`5efbd371 → 03c86c91 → c514fa5e`), with
the cron polling all eight FM layouts every minute in shadow mode. The memory
that said "nothing deployed" was stale.

| Finding | Fix |
|---|---|
| No kill switch: only editing `wrangler.jsonc` and redeploying stops the tick | `PUBLICATION_TICK=off` (a var, dashboard-settable) makes `scheduled` return before any work |
| Stale-scan guard never fired: `runTick` read the coordinator revision *after* the FM scan, so a slow tick carried a fresh revision and regressed `newestHashes` (reproduced) | revision is read before discovery; a real-ordering test drives `runTick` with a faster tick landing mid-read |
| `storeRelease` rewrote the bundle and ready marker every minute for an unchanged generation (4,320 writes/day to 3 keys) | skipped when the stored bytes match; a missing marker is still repaired |

**Still open, must be fixed before `PUBLICATION_SERVING=on`:** `runTick`
writes `rel:v1:current` itself and never calls `promoteRelease()` (bypassing
stored-artifact validation, `rejectStalePromotion`, `verifyGenerationReadable`);
FM deletions never reach the coordinator's removal outbox (deletion works by
membership only; the outbox is dead code); `hasRoute()` has no forward
fallback; nothing drains the DLQ. None of these is visitor-visible in shadow.

## 3. Verification

- `npm test`: 644/644 (605 before; 39 new: `translate-bundle`, `t`,
  `filemaker-kv`, plus middleware/llms/display-title/schema/release/tick/
  worker-entry additions).
- `npm run build:cf`: green; bundle-level tests run against the fresh `dist/`
  (11/11, including the kill switch).
- `tsc --noEmit`: no errors in changed files. `git diff --check`: clean.
- Not verified: the fixes' effect on staging. That needs a deploy
  (`npm run build:cf && npx wrangler deploy`, one command), then one uncached
  GET per route twice: the second cold render should show `trbundle` and a
  `trnkv n=` near zero, and `fmkv` in place of most of `fmnet`.

## 4. Things deliberately not done

- No deploy. Deploying re-arms the every-minute cron; whether to pause it
  (`PUBLICATION_TICK=off`) is a product decision about FM load versus
  discovery freshness.
- Chrome strings are still awaited serially in frontmatter. The route bundle
  makes that free after the first render, so the churn of rewriting every
  component was not worth it.
- The A–Ö index still translates all 341 blurbs; with bulk reads and the bundle
  this is now one read, so the design question ("translate the index at all?")
  is moot for performance.
- `Server-Timing` still ships publicly (numbers only) and still under-counts
  component work; documented above rather than reworked.
