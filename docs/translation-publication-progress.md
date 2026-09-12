# Translation-publication implementation — progress

Live progress log for
[the implementation handoff](translation-publication-implementation-handoff.md)
and [the design](translation-publication-plan-2026-09-12.md). Updated after
every section. **Not yet deployed; no new Cloudflare infrastructure exists.**

**Current: 579 tests, both builds green, checkpoint 4.5 complete. Nothing deployed.**

## Resume commands

```sh
nvm use 22
npm test                                  # full suite
node --experimental-strip-types --test test/publication.test.mjs   # this work only
npm run build        # gh target
npm run build:cf     # cf target — ALWAYS rerun immediately before any deploy
```

Both builds write to the same `dist/`. Never run them concurrently, and always
rebuild CF immediately before a Worker deploy — running the gh build afterwards
silently leaves stale server output and `wrangler deploy` ships the wrong bundle.

## Cloudflare resource naming

The user asked that anything new be findable in the Cloudflare dashboard. The
existing `CACHE_STATE` namespace was unidentifiable among seven and had to be
renamed mid-session; that is the mistake this convention exists to avoid.

| Kind | Name | Purpose |
|---|---|---|
| Worker | `ninetone-site` | existing site Worker (cron handler added here, not a second Worker) |
| KV | `ninetone-translations-cache` | existing translation cache (`CACHE_STATE` binding) |
| KV | `ninetone-publication-state` | discovery/job state and release pointers |
| KV | `ninetone-publication-releases` | immutable release bundles |
| Queue | `ninetone-translation-jobs` | field-level translation work |
| Queue | `ninetone-translation-jobs-dlq` | dead letter |
| Durable Object | `NinetonePublicationCoordinator` | serializes candidate state and promotion |

Bindings stay SCREAMING_SNAKE per Worker convention; the *resource* names above
are what appear in the dashboard.

## Status

| Checkpoint | State |
|---|---|
| 0. Baseline committed and pushed | **Done** — `85546d4`, pushed to `origin/i18n-phase-2` |
| 1. Inventory and contracts | **Done, review-corrected** — 6 counterexamples fixed |
| 2. Background preparation | **Done, review-corrected** — immutable completions |
| 3. Safe publication | **Done** (logic) — `release.ts`, 15 tests |
| 4. Serving and lifecycle | **Logic done** — consumer, gating, integration tests; rendering not switched |
| 4.5. Production adapters | **Done** — snapshots, FM adapter, read-back, handler wiring, DO, rendering (inert), section lifecycle |
| 5. Validation and rollout | Not started — needs authorized resource creation |

## Log

### Checkpoint 0 — baseline (done)

Committed the concurrent work found in the tree as `85546d4` and pushed the
branch. That commit is explicitly **not** authored by this work — it holds
another agent's Server-Timing instrumentation, hover-art, RosterIndex
duplicate-translation fixes, WebP banners, and performance evidence. Verified
green before committing rather than reviewed line by line: 366 tests, both
builds, clean post-build audit over 548 pages.

Starting HEAD for the implementation: `85546d4`.

### Checkpoint 1 — inventory and contracts (done)

`src/lib/publication/contracts.ts` (new) + `test/publication.test.mjs` (21
tests). Deliberately pure: no Cloudflare bindings, no FM imports, no Astro
globals, so the rules deciding "is this safe to publish" are testable without
a build or a network.

**Inventory taken from the rendering code, not the warm script.** The two had
already drifted once — the warm script wrote WebPosts titles on the `quality`
tier while `fmText()` reads `fast`, so those keys were never looked up and
/team rendered English under Swedish chrome while a correct translation sat
unused in KV. `ENTITY_FIELDS` is derived from the actual `fm()` call sites,
and a test now pins `ENTITY_TIER === "fast"` against `CHROME_TIER === "quality"`.

Nine entity kinds: artist, previousArtist, client, bookingTalent,
bookingCategory, teamMember, newsPost, webPostSection, guide.

Contracts defined: `SourceRecord` (+ content hash), `TranslationJob` (+ stable
`jobId` for at-least-once dedup), `Candidate` (completeness and supersession),
`Release` (+ `validateRelease`).

Decisions worth recording:

- **Hash, not timestamp.** FM has no reliable modified-at on these layouts
  (sitemap-pages.xml.ts omits lastmod for the same reason). Hashing
  publication-relevant fields makes an unchanged re-save produce no work, and
  makes supersession decidable.
- **`normalizeFields` trims** at the one place the hash is computed, matching
  the warm script's `job()`. A stray trailing newline previously produced a
  different sha256 from the warmed key — a permanent miss affecting 67 of 886
  fields.
- **Both locales are always required**, including a record's own source
  language. Team copy is authored in English while most of the site is
  Swedish; a one-directional assumption leaves one locale permanently
  untranslated.
- **Only fields the source actually has are required**, so an artist with no
  short blurb is not blocked for lacking its translation.
- **`validateRelease` is explicitly mechanical.** It catches missing locales,
  missing fields, empty values, dangling references and duplicate ids. It does
  not and cannot promise linguistic quality — that is what
  `src/i18n/overrides.json` and human review are for.

Tests: 387 total (21 new), all passing.

### Checkpoint 2 — background preparation, logic (done)

`src/lib/publication/discovery.ts` + 16 tests. Everything external is injected
(`loadRecords`, `store`, `hash`), so scan/dedupe/supersede/removal logic runs
locally with no network, no bindings, and no translation spend. The Worker
layer will be a thin adapter over this.

Covered by tests, each matching an acceptance requirement in the handoff:

- unchanged hash produces **no work at all**; an edit is rediscovered
- an inactive record is a removal and generates **zero** translation jobs, so
  a withdrawal is never held behind prose work
- job completion is **idempotent**, which is what makes at-least-once queue
  delivery safe
- a **late completion from an older edit is refused**, not merged, and its
  candidate is marked superseded
- a completion for an unknown candidate is refused rather than creating one
- `selectPublishable` withholds a record whose reference is not ready (the
  artist + two posts scenario), includes the group once all are ready, does
  **not** let one failed record block unrelated ready records, and iterates to
  a fixed point when dropping a record strands another

**Honest limitation recorded in the code:** the scan lock is advisory, not a
mutex — KV has no atomic compare-and-set, so two scanners starting in the same
instant can both proceed. That is tolerable only because discovery is
idempotent (same hashes produce the same candidates and job ids), so a double
scan wastes work rather than corrupting state. Promotion is the operation that
genuinely cannot tolerate a race, which is why the design puts it behind a
Durable Object.

**Also recorded honestly:** discovery cannot detect that several separate FM
saves form one finished editorial transaction. Nothing in the Data API marks a
set of saves as complete. Grouping works only through explicit references on a
record; saves made after a candidate publishes are a subsequent update.

Tests: 403 total (16 new), all passing.

### Checkpoint 3 — safe publication (in progress)

Next: immutable release bundles, serialized promotion with a known-good
fallback, and the KV-eventual-consistency handling (a pointer alone is not
readiness).

### Review corrections (docs/publication-checkpoints-1-2-review.md)

The review found six counterexamples in checkpoints 1–2. **Every one was
reproduced locally before being fixed**, and each is now a regression test in
`test/publication-review-regressions.test.mjs` (15 cases). Re-running the
review's own reproductions afterwards: **6/6 fixed**.

| Finding | Fix |
|---|---|
| P1 crash between `newestHash` and candidate strands the version forever | `discover()` treats a known hash with a MISSING candidate as outstanding work, so the window is closed from either write order. `reconcile()` recovers the second window (candidate persisted, never enqueued) by deriving outstanding jobs from what is missing. |
| P1 concurrent completions lose progress; duplicate scan resets it | Completions are now **immutable per-job records** at their own keys. Writing one never touches another, so concurrency cannot collide and a rescan has no progress field to reset. Candidate state is DERIVED by `reconcile()`. |
| P1 validation cannot prove completeness | `ReleaseEntity` carries an explicit `requiredFields` manifest and `routes`. Requirements no longer come from whichever keys happen to be in the output. |
| P1 disappeared records are not removals | Membership is compared against an authoritative inventory from the last **complete** scan, gated on `inventoryComplete` so a partial FM read can never be read as mass deletion. |
| P2 reverse references publish an artist alone | `selectPublishable()` now binds references in **both** directions and uses kind-qualified identities throughout. |
| P2 invalid KV TTL | `expirationTtl: 1` is rejected by Cloudflare (minimum 60 — verified against the official docs). The lock now deletes; the test fake throws on any TTL below 60, so this cannot pass again against a lenient stub. |

**Two claims withdrawn rather than defended.** The comment saying the crash
window "self-repairs" described the failure — the review was right. And
`validateRelease` no longer claims to check protected names: names are
protected at translation time via `protect`, and verifying afterwards needs
the source text a release entity does not carry. If that check is wanted it
belongs in the queue consumer.

**Also confirmed from the Cloudflare docs while fixing this:** KV allows
**one write per second per key**. That is independent of the lost-update race
and on its own disqualifies a mutable shared candidate blob — a hot candidate
would have produced 429s. It is recorded in the module comment so the pattern
is not reintroduced elsewhere.

**Still outstanding from the review, and not claimed as done:** the coordinator
must serialize candidate/job state, not only release promotion. The immutable
completion records remove the lost-update race that made the current design
unsafe, but the advisory KV scan lock remains advisory. When the Durable Object
lands in checkpoint 3 it should own discovery serialization and the advisory
lock should be deleted. That is written at the lock itself.

Tests: 419 total (15 new regressions; 38 checkpoint tests updated to the
corrected contracts), all passing.

### Checkpoint 3 — safe publication, logic (done)

`src/lib/publication/release.ts` + `test/publication-release.test.mjs` (15
tests). Assembly, promotion gates, generation resolution, rollback, and the
urgent-removal path.

**A pointer is never treated as readiness.** Three rules, each tested:

1. `storeRelease()` writes the bundle, THEN a readiness marker. A crash between
   them leaves a bundle with no marker, which reads as not-ready — safe, and
   repaired by the next attempt. The reverse order would publish a marker for a
   bundle that may not be readable.
2. `verifyGenerationReadable()` checks BOTH the marker and that the bundle
   parses back. KV is eventually consistent, so a marker visible at one edge
   does not prove the bundle is.
3. `resolveGeneration()` walks retained history when the pointer names
   something unreadable, and returns **null** rather than anything partial when
   nothing is readable — the caller then keeps its existing behaviour and never
   falls through to live untranslated FM.

`promoteRelease()` gates on validation, then staleness (`rejectStalePromotion`
re-reads newest hashes immediately before committing), then readability. The
pointer write is last.

Mixed generations across edges are safe by construction: every generation
validates as a whole, so an edge serving an older one shows a consistent older
site rather than a new listing linking to a missing detail page. Tested
explicitly.

`withRemovals()` derives a removal generation by FILTERING an existing one —
no translation involved — and drops references to removed entities from the
survivors so nothing can link to something gone. A late completion cannot
re-promote a superseded bundle and resurrect a withdrawn record; also tested.

**Stated limitation, not hidden:** the current pointer is the one mutable key
in the release path. Without the Durable Object, two concurrent promotions can
still overwrite each other's pointer. Both would name a complete, internally
consistent generation, so the failure mode is "an older complete site wins"
rather than corruption — but it is real, and it is written at `promoteRelease`.
The coordinator in checkpoint 4 is what closes it.

Tests: 434 total (15 new), all passing.

### Checkpoint 4 — serving and lifecycle (partial)

`src/lib/publication/serving.ts` + `test/publication-serving.test.mjs` (9
tests), and `src/worker-entry.ts`.

**One generation per request.** `pinGeneration()` resolves once and the result
is reused, so homepage, lists, detail pages, search and sitemap cannot mix
generations within a render — and a promotion landing mid-render cannot split a
page across two versions. Tested by promoting a new generation between pinning
and lookup.

**No live fallback.** When no generation resolves, `lookup()` returns
`unavailable` and the caller keeps its existing behaviour. It never reaches
into FileMaker for untranslated text; that would be the most natural-looking
mistake to make here and is the failure the whole design exists to prevent.

**Shadow mode is the default.** `publicationMode()` returns "shadow" unless
PUBLICATION_SERVING is exactly "on" — a missing or misspelled variable must
never switch the site's content source. `compareShadow()` reports
onlyInRelease / onlyInLive / differing rather than a verdict, because a
difference is not automatically a defect: a release legitimately withholds an
entity whose translations are still preparing.

**The entrypoint gap the review named is closed.** `wrangler.jsonc`'s `main`
pointed at the adapter's own module, which exports only `{ fetch }`, so there
was nowhere to put `scheduled`/`queue`. `src/worker-entry.ts` re-exports the
adapter's fetch **verbatim** and adds the two handlers beside it. Verified by
bundling it: fetch, scheduled and queue are all present, and fetch is the
adapter's function rather than a wrapper — so if the publication handlers were
deleted tomorrow, serving would be byte-identical.

**Deliberately NOT done, and the honest state of this checkpoint:**

- `main` is still the adapter entrypoint. Switching it is a deploy-time change
  and belongs with the authorized rollout, not with logic work.
- The `scheduled` and `queue` handlers are stubs that log and retry. Wiring
  discovery and the consumer into them against non-existent Cloudflare
  resources would be worse than a handler that reports it is not enabled.
- Rendering still uses `fmText()`. Visitor-triggered translation has NOT been
  removed, because removing it before a bootstrapped release exists would leave
  the site with no content source at all.
- No bootstrap generation exists. That needs authorized translation spend.

Tests: 443 total (9 new), all passing. Both builds green. Nothing deployed.

### Second review corrections (docs/publication-implementation-review-2026-09-12.md)

Four counterexamples, all reproduced before fixing, all now regression tests in
`test/publication-coordinator.test.mjs`. Plus one requirement added mid-session
about status changes. **5/5 verified.**

| Finding | Fix |
|---|---|
| P1 stale scan regresses authoritative state | `src/lib/publication/coordinator.ts`. Every application carries a REVISION; anything computed from an older one is refused. A lock excludes but does not order — scan v1 could take the lock after v2 released it and still write stale data. |
| P1 cross-request navigation can 404 | `lookupWithFallback()` consults NEWER approved generations when the pinned one lacks an entity. Forward-only is the safety property: looking backwards would resurrect withdrawn records. |
| P2 promotion validated the argument, not the artifact | `promoteRelease()` now reads the STORED bundle and validates that; `storeRelease()` refuses to overwrite a generation with different bytes and returns a digest; `verifyGenerationReadable()` checks the digest. |
| P1 removal lost on replay | `pendingRemovals` is a durable outbox that survives until `commitRemovals()`, so a crash between discovery and publication is recoverable. |
| **Status change must not retranslate** | `sourceHashInput()` no longer includes `active` or `references`; `membershipFingerprint()` tracks those separately. |

**My claim that mixed generations were "safe by construction" was too broad.**
It holds within a render and not across navigation, which is exactly what the
review demonstrated. Corrected in the code comments and here.

**The status-change bug was real and mine.** Folding `active` into the content
hash meant Active → Previous → Active produced a new hash both times and
re-translated unchanged text — paid work for nothing. The translation cache is
keyed on `sha256(text)` per target and tier, so identical text is the same
entry regardless of section. Now: same text reuses, only changed or missing
text translates, moving back reuses again. A release is still rebuilt on a
membership change, because listings and route inventories differ — that is
bundle assembly, not translation.

Tests: 461 total, all passing. Both builds green. Nothing deployed.

### Queue consumer, integration tests, gating, dry run

`src/lib/publication/consumer.ts` + `test/publication-integration.test.mjs`
(17 tests). Every test uses a **counting fake provider**, so "zero model calls"
is asserted rather than assumed. No network, no bindings, no spend.

**Cache before spend is the consumer's central rule.** The translation cache is
keyed on `sha256(text)` per target and tier — not on record identity or status
— so `processJob()` resolves the key and looks in KV before calling anything,
and reports `reused` so the saving is observable.

Covered:

| Requirement | Result |
|---|---|
| **Active → Previous → Active, zero model calls** | 2 calls on first publish, **0** across both later transitions |
| Edit after a status change | Only the changed field, both locales; unchanged tagline reused |
| >25 strings without visitor traffic | 60 jobs complete; the 25-cap is a *render* budget, background work is bounded by concurrency |
| Retry and dead letter | Transient failures retried with backoff; exhausted jobs dead-lettered and never cached |
| Output-contract rejection | Fails without caching and without pointless retries |
| Duplicate delivery | Second delivery costs nothing |
| Two records, identical text | Paid once, not twice |
| **Public rendering makes zero model calls** | Asserted against the counted provider, including the unavailable path |
| Deploy gating | A build with new UI copy cannot activate until both locales exist; blank counts as missing |

### Bootstrap dry run — measured

Run against live FM and the real translation cache. **Nothing was translated or
written.**

```
11,883 keys already present
11,819 already cached (skipped — idempotent)
     3 need translation
Estimated cost: $0.0048
```

**This corrects my earlier ~$10 guess by three orders of magnitude**, and the
review was right to refuse it as unverified. The corpus is already warm from
the earlier Phase 2 runs, and because the cache is keyed on text rather than on
record identity, a publication bootstrap reuses all of it.

The 3 remaining are known: the two Anthropic HTTP 503 failures from the
original warm run, plus one of the wrong-language keys deleted during the
language audit. All three heal on the next live run or request.

**Practical consequence:** the bootstrap is effectively free. The spend
conversation I flagged as needing a decision does not arise at this corpus
size. What still needs authorization is deployment, not money.

Tests: 478 total, all passing. Both builds green. Nothing deployed, no
translation calls made.

## Checkpoint 4.5 — production adapters (in progress)

The four review rounds validated the LOGIC. This checkpoint writes the
production adapters that logic was always injected with. Until now every
`DiscoveryDeps`/`ConsumerDeps` field was satisfied only by a test fake:
`grep -rn "lib/publication" src scripts` returned no production importer.

### Why this checkpoint exists (found while wiring, not planned)

Wiring the `src/worker-entry.ts` stubs to "the real discovery + consumer" was
not possible as scoped. Three gaps, each verified against the code:

| Gap | Evidence |
|---|---|
| `ConsumerDeps.sourceFor` is unimplementable from a job | `TranslationJob` (contracts.ts:219-229) carries no source text, and consumer.ts:55 forbids re-reading FM |
| `DiscoveryDeps.loadRecords` has no production implementation | only `test/publication.test.mjs:363` and `test/publication-review-regressions.test.mjs:51` supply one |
| Release assembly has no text source | `buildRelease` (release.ts:85-92) needs `translations[ref][locale][field]`, but `processJob` returns `{status,key}` and discards the text |

Two smaller ones: `sha256Hex` is NOT exported (translate.ts:170), and no
`promptVersion` constant exists anywhere — it is only ever a threaded parameter.

### Decisions taken (user, this session)

1. **Immutable source snapshots.** A job names the exact snapshot + field. A
   missing snapshot RETRIES safely; it must never fall back to current FM text.
2. **Snapshots identify the complete source version**, including membership
   metadata — not merely the text-only content hash. Translation-cache identity
   stays text-only (`sha256(text)` per target+tier) so a status change still
   reuses translations. These are two different identities on purpose.
3. **Protected entity names travel with the job**, closing `protect: []`
   (contracts.ts:278).
4. **webPostSection**: section title modelled separately from its repeated
   blocks, using real FM identity/ordering/parentage.
5. **Releases assemble by reading translations back from KV** and verifying
   completeness. A consumer returning cache keys is fine — the read-back is
   the missing piece.

### Measured FM facts (read-only probe, no writes, no translation)

Probed `API_WEBPOSTS` live to decide the webPostSection grain rather than guess:

- **Portal rows carry a stable `recordId`** (and `modId`). 31 blocks across 6
  sections, **31 unique ids, zero duplicates** — FM gives genuine block
  identity. `fmFindWithPortals` currently DISCARDS it (filemaker.ts:223), which
  is why `guides.ts` had to slugify subjects for identity.
- **`webPost::slug` EXISTS as a field but is empty in all 31 rows.**
  `guides.ts:8-11` says "There is no FM slug field on a webPost portal row" —
  the field exists; the comment's conclusion (derive the slug) is still right,
  its stated reason is not.
- **`webPost::sortOrder` is a TIMESTAMP** (`"02/14/2025 16:08:55"`), never
  numeric, in all 31 rows. `getWebPosts()`'s `orderOf()` does `Number(raw)`,
  so every row yields `MAX_SAFE_INTEGER` — **the sort is a total no-op** and
  ordering is really FM's portal order. Reproduced against the real values.
  PRE-EXISTING, not introduced here; changing it changes rendered output, so it
  is recorded and left alone rather than fixed inside this checkpoint.
- **No "Guider" category exists in FM** (code 401 for `Guider`, `*Guid*`,
  `Guides`). The `guide` entity kind currently yields ZERO records. The adapter
  must treat that as empty-and-fine, not as a failed read.

Section record ids are 1-6; block ids 1-28 plus 39, 40, 54.

### Measured FM entity facts (read-only probes)

Field names and identity were verified against live FM rather than inferred, because
`ENTITY_FIELDS` and the warm script had already drifted apart once before.

| Kind | Layout | Records | Identity field | Unique |
|---|---|---|---|---|
| artist | `API_ARTIST` | 33 | `SLUG` | 33/33 |
| client | `API_Management` | 37 | `SLUG` | 37/37 |
| bookingTalent | `API_Booking` | 72 | `SLUG` | 72/72 |
| teamMember | `API_USERS` | 17 | `SLUG` | 17/17 |
| newsPost | `API_NEWS` | 77 | `slug` (lowercase!) | 77/77 |
| webPostSection | `API_WEBPOSTS` | 6 | `category` + `recordId` | 6/6 |

Every identity field is 100% populated and fully unique — no collision handling needed.

**Prose fields are SPARSE, which the design already anticipates** ("only fields the
source actually has are required"):

- artists: title 25/33, string 31/33, short 31/33
- clients: title 35/37, string 36/37, short 36/37, artistPresentationShort 28/37
- team: title 16/17 (one member has none), titleDescription + DescriptionString 17/17
- **booking: title 10/72, string 11/72** — most roster entries have no bio at all
- news: Title + shortMessage + MessageString all 77/77

Fallback chains confirmed live: `Description` AND `DescriptionString` both exist and are
both 17/17 on team; news has `Title` 77/77 but `title` 0/77, so `ENTITY_FIELDS`'s
capitalized `Title` is right. `Tag` is 0/72 on API_Booking, so booking category identity
comes from `getBookingCategories()`, not a roster field.

### 4.5a — source snapshots (done)

`src/lib/publication/snapshot.ts` + `test/publication-snapshot.test.mjs` (17 tests).

**Two identities, deliberately separate** — this is the user's refinement, and the
reason `snapshotVersion` is not simply `record.hash`:

| Identity | Covers | Purpose |
|---|---|---|
| `contentHash` | text only (`sourceHashInput`) | what the translation cache keys on — status changes reuse translations |
| `snapshotVersion` | `sha256(contentHash + membershipFingerprint)` | the COMPLETE source version — text AND `active`/`references` |

Collapsing them breaks one requirement or the other: the content hash alone makes a
status change invisible to the snapshot (stale membership in a release), while folding
membership into the content hash re-translates unchanged prose on every status change
(the paid-work-for-nothing bug an earlier review already caught).

Tested: `Active -> Previous -> Active` returns to the **original** snapshot version, not
a third one; a reference change is a new source version but not a new content hash.

**Missing snapshot => retry, never fetch.** `resolveJobSource()` has three outcomes, and
the distinction is load-bearing: `retry` (snapshot not readable yet — KV eventual
consistency), `absent` (snapshot readable, field genuinely missing — permanent, so
retrying would loop until the queue dead-lettered it for the wrong reason), `found`.
There is no code path from a job to live FM text. Asserted by a counting store: resolving
costs exactly one KV read.

Snapshots are write-once — a redelivered job reads byte-identical text.

**`protect` is now filled.** `jobsForSnapshot()` replaces `jobsForRecord()`'s hardcoded
`protect: []` with names frozen into the snapshot at discovery time.

### 4.5b — FM source adapter (done)

`src/lib/publication/fm-source.ts` + `test/publication-fm-source.test.mjs` (18 tests).

**All-or-nothing completeness.** Every layout is read independently so one failure does
not hide the others, but ANY failure clears `complete`, which the caller passes to
`discover({ inventoryComplete })`. This is the opposite of the warm script's
catch-and-continue — right for warming a cache, catastrophic here, where a partial read
would look like mass deletion.

**webPostSection grain (the user's decision, implemented):** the section's own `title` is
one record; each portal block is its own record carrying `subject` + `message`.

- **Identity from FM's portal `recordId`** — verified live end-to-end: **31/31 blocks**
  carry one through `getWebPosts()`, ids globally unique across sections. Editing a
  block's subject does NOT change its id (tested), so there is no phantom
  delete-plus-create — the failure mode `guides.ts` still has, since it must slugify the
  subject for identity.
- **Ordering preserved positionally** via `LoadedRecords.blockOrder`, because
  `SourceRecord.fields` is translatable text only and `ReleaseEntity` has no ordering
  field. NOT from `sortOrder` — that is a timestamp and its sort is a proven no-op.
- **Parentage is bidirectional**: the section references its blocks, each block
  references its section, so `selectPublishable()` cannot publish a block whose section
  is not ready.
- **Blast radius**: editing one block leaves every other block's hash unchanged (tested).
  One-record-per-section would have re-translated all 3-6 blocks on any edit.

**One additive change outside the publication module:** `getWebPosts()` now carries
`recordId` on each block (`src/lib/ninetone.ts`). Optional field, unread by rendering —
FM returns it at the portal row's top level, NOT `webPost::`-prefixed, so `pickStr`
could not reach it.

Tests: 513 total (35 new), all passing.

### 4.5c — translation read-back (done)

`src/lib/publication/readback.ts` + `test/publication-readback.test.mjs` (12 tests).

The consumer returning cache keys is correct — the translation cache is
content-addressed, so the key IS the durable handle, and passing prose back through
queue results would be wasteful and racy. The missing half was resolving those keys
back into text at assembly time. That is this module.

**Keys are derived from the SNAPSHOT's frozen text**, never from live FM, so the
translation read back is provably the translation of the text the release will ship.
Tested directly: a translation of some *newer* text sitting in the same cache does not
win.

**Completeness is verified, not assumed.** `readBackEntity()` names the specific
`{ref, locale, field, key}` that is missing, including the cache key so a miss is
diagnosable in KV. Blank counts as missing. Expected fields come from the snapshot,
intersected with `ENTITY_FIELDS`, mirroring `jobsForSnapshot()` exactly — deriving them
differently is how a completeness check drifts from the work actually queued.

**A missing translation is not an error** — it means "still preparing". `readBackAll()`
returns an explicit ready/incomplete split so the caller publishes the ready set and
leaves the rest, rather than stalling publication on work in progress.

**End-to-end test, zero model calls asserted:** the real `processJob()` runs against a
counting fake provider (4 calls: 2 fields x 2 locales), a redelivery costs **0**, then
`readBackAll()` + `buildRelease()` produce a release that `validateRelease()` accepts
with no issues. The negative case is covered too: an incomplete read-back is reported
not-ready, and forcing it into a release anyway fails validation with the missing field
named.

Tests: 525 total (12 new), all passing.

### 4.5d — handler wiring, DO, and config (done)

`src/lib/publication/orchestrate.ts`, `src/lib/publication/coordinator-do.ts`,
rewritten `src/worker-entry.ts`, `wrangler.jsonc`, plus
`test/publication-orchestrate.test.mjs` (22) and
`test/publication-worker-entry.test.mjs` (10).

**The gating rule, stated precisely.** Preparation is gated on BINDINGS; only
promotion is gated on the flag:

| Stage | Gate | Runs in shadow? |
|---|---|---|
| discovery, snapshots, enqueue | `CACHE_STATE`/`PUBLICATION_STATE` present | yes |
| translation (queue consumer) | bindings + `ANTHROPIC_API_KEY` | yes |
| release assembly + store | bindings | yes |
| **promotion** | **`PUBLICATION_SERVING === "on"`** | **no** |

Gating preparation on the flag would mean flipping serving on against a cold,
unprepared release — the opposite of what shadow mode is for. Tested both ways.

**Queue disposition discipline.** `retry` is reserved for the genuinely transient case:

- missing snapshot -> **retry** (KV eventual consistency), zero model calls
- field absent from a readable snapshot -> **ack** (permanent; retrying would loop
  until the queue dead-lettered it for the wrong reason)
- job exhausted its own bounded retries -> **ack**, NOT retry. `processJob` already
  runs 4 internal attempts; telling the queue to retry multiplies that by the queue's
  own retry count — 20 model calls for one field. Measured in the test: 4 calls, once.
- stale/superseded completion -> **ack** (`recordJobCompletion` returned false)

**Ordering:** the snapshot is written BEFORE the job is enqueued, so a job can never
reference a snapshot that does not exist. Asserted by recording write/enqueue order.

**Durable Object.** `NinetonePublicationCoordinator` closes the promotion race
checkpoint 3 left open. All rules stay in the pure `coordinator.ts` functions; the DO
only makes read-modify-write atomic around them, so ordering is testable with
`node --test` and a fake storage — no miniflare. `DurableObject` is injected via
`makeCoordinatorClass()` rather than imported in the module, because importing
`cloudflare:workers` outside workerd would make the module unloadable under
`node --test` and take the suite with it.

**BUILD ARCHITECTURE — verified, and it corrects the plan's assumption.**
`wrangler deploy` does NOT read `wrangler.jsonc`: `.wrangler/deploy/config.json`
redirects it to the GENERATED `dist/server/wrangler.json`, whose `main` is `entry.mjs`.
So `main` in `wrangler.jsonc` is a **Vite build input**. @cloudflare/vite-plugin resolves
it as `virtual:cloudflare/user-entry` and emits
`export * from <entry>; export default mod.default ?? {}` — which is why a `.ts` source
path works, why the adapter's `virtual:astro-cloudflare:config` still resolves, and why
the named DO export survives.

**This makes the shared-dist footgun sharper than recorded: the deploy CONFIG lives in
dist/ too, not just the code.** A gh build leaves no `dist/server/wrangler.json` at all.

**Verified against the real built bundle** (not asserted):

```
export { NinetonePublicationCoordinator, worker_entry_default as default, publicationMode };
var worker_entry_default$1 = { fetch: server_default.fetch, async scheduled(...), async queue(...) }
var server_default = { fetch: handle };   // the adapter's own object
```

`fetch` is the adapter's handler passed through untouched — serving is byte-identical.
`test/publication-worker-entry.test.mjs` imports that bundle with a stubbed
`cloudflare:workers` and drives the real handlers with fake bindings: the DO constructs
and answers RPC, rejects malformed input with 400, `scheduled` is inert without a
binding and never throws out of the handler, and the queue retry/ACK rules hold. Those
tests SKIP (verified: 10 skipped, 0 failed) when `dist/` holds a gh build, so
`npm test` never requires a build.

**wrangler.jsonc resources are declared but COMMENTED OUT**, with the exact blocks to
uncomment. Nothing exists in Cloudflare yet and every id is a placeholder; wrangler
fails hard on a queue or namespace that does not exist, so leaving them live would break
today's deploy. `PUBLICATION_SERVING` is deliberately absent from `vars`.

Tests: 557 total (79 new), all passing. Both builds green; gh audit clean over 548
pages. `dist/` rebuilt to cf afterwards. Nothing deployed, no translation calls.

### 4.5e — rendering integration (done, inert)

`src/lib/publication/render.ts` + `test/publication-render.test.mjs` (13 tests).

**Deliberately a WRAPPER, not an edit to `fmText()`.** `withRelease()` wraps an
existing translator; the fallback path stays byte-for-byte what it is today. That is
what makes step 4 reversible by removing one call rather than by reverting logic inside
the function every page depends on.

**Inertness is proven, not assumed.** With the flag off, `pinForRequest()` does not even
resolve a generation (asserted: zero resolver calls — reading KV per request to then
ignore the result is pure latency), and `withRelease()` returns the ORIGINAL translator
object unwrapped (`assert.equal(wrapped, translator)`). Near-miss flag values — `"ON"`,
`"On"`, `"true"`, `"1"`, `"yes"`, `" on"` — all stay inert.

**One generation per request.** The pin lives on `locals` and is a single shared promise,
so three concurrent lookups resolve once. A promotion landing mid-render cannot split a
page: the pin wins for the whole render (tested by moving the pointer between pins).

**Two different misses, never conflated:** no generation resolves -> `unavailable`,
caller keeps existing behaviour; a generation serves but lacks the entity -> `miss`,
handled forward-only. `resolveFromRelease()` returns **null, never source text**, so
nothing can render untranslated prose as though it were translated. A resolver throw
degrades instead of failing the render.

**Not wired into `fmText()` call sites yet, on purpose.** `withRelease` needs an
`entityId` + `fieldFor` mapping per call site, and a wrong mapping would serve one
record's prose under another's name — it returns the unchanged translator rather than
guess. Threading that through the ~30 call sites is step 4 work, done against a
shadow-validated release, not now.

## Checkpoint 4.5 complete

| Gap at session start | Closed by |
|---|---|
| `ConsumerDeps.sourceFor` unimplementable | `snapshot.ts` — immutable snapshots, job names snapshot + field |
| `DiscoveryDeps.loadRecords` missing | `fm-source.ts` — all 9 kinds, all-or-nothing completeness |
| Release assembly had no text source | `readback.ts` — KV read-back with verified completeness |
| `sha256Hex` not exported | duplicated in `worker-entry.ts`, as translate.ts itself does from http.ts |
| No `promptVersion` constant | `PROMPT_VERSION = "p1"` in `fm-source.ts`, separate from `TRANSLATION_KEY_VERSION` |
| `protect: []` inert | frozen into the snapshot, travels with every job |
| Stub `scheduled`/`queue` | `orchestrate.ts` + rewritten `worker-entry.ts` |
| Promotion race (from checkpoint 3) | `coordinator-do.ts` — `NinetonePublicationCoordinator` |

**Final state: 570 tests passing (92 new), both builds green, gh audit clean over 548
pages, `dist/` left holding the cf build. Nothing deployed. No translation calls made.
No Cloudflare resources created.**

### What step 2 (rollout) now requires — corrected

The original plan said "declare the resources in wrangler.jsonc and switch `main`".
`main` is switched and the resources are written but commented out. Creating them is
the authorized step:

```sh
npx wrangler kv namespace create ninetone-publication-state
npx wrangler kv namespace create ninetone-publication-releases
npx wrangler queues create ninetone-translation-jobs
npx wrangler queues create ninetone-translation-jobs-dlq
# paste the returned ids into wrangler.jsonc, uncomment the block, then:
npm run build:cf && npx wrangler deploy      # ALWAYS in that order, one command
```

`PUBLICATION_SERVING` stays unset. The DO migration (`v1`,
`new_sqlite_classes: ["NinetonePublicationCoordinator"]`) applies on that first deploy.

**The dual-build footgun is worse than recorded and belongs in CLAUDE.md:** the deploy
CONFIG lives in `dist/server/wrangler.json`, not just the code, and a gh build does not
write it at all. `npm run build:cf && npx wrangler deploy` as ONE command is the only
safe shape.

### 4.5f — section lifecycle, corrected

`test/publication-section-lifecycle.test.mjs` (9 tests).

**A framing error of mine, corrected by the user.** I measured that one untranslated
block withholds its whole section and reported it as a "blast radius" concern. That
conflated three different situations which have three different CORRECT behaviours.
Verified each against the real release machinery rather than by reading:

| Situation | Measured behaviour | Correct because |
|---|---|---|
| **New section**, one block still translating | whole group withheld (`selectPublishable` -> `[]`) | ready-before-visible; a half-translated section must never appear |
| **Existing section edited**, new text preparing | candidate generation publishes nothing, but **`g1` stays current** and still contains the section | the live site keeps the last fully translated version — withholding never blanks a published section |
| **Block deleted** | block goes, section + survivors stay, section's dangling ref dropped, **no translation involved** (`withRemovals` filters) | a withdrawal must never queue behind prose work |

The key realisation: withholding only ever affects the **candidate** generation.
`resolveGeneration()` keeps serving `current` until a complete generation is promoted,
so an edit in flight is invisible to visitors rather than destructive. My original
report implied live content could vanish; it cannot.

Also measured: withholding is scoped to the reference group — one preparing section does
not hold back unrelated records (an artist alongside it publishes normally), and at real
scale (6 sections / 31 blocks) one untranslated block withholds 4 records, not 37.

The regression these tests guard: a future change making case 2 behave like case 1, which
would blank a live section during an edit and look like data loss in FileMaker.

**Signatures verified against the REAL translate.ts** (fakes cannot catch this class):
`translationKey("Kort bio.","sv","fast")` -> `tr:v1:sv:fast:<64 hex>`; `callWithGuard.length === 6`,
matching worker-entry.ts's `(apiKey, text, target, tier, kind, await buildProtectedTerms(protect))`
— also confirmed in the built bundle at `dist/server/entry.mjs:1463`.

Tests: 579 total (9 new), all passing.

## Checkpoint 5 — deployment blockers resolved

The deployment review (docs/publication-deployment-blockers-2026-09-12.md) refused
deployment on three findings. **All three were reproduced against current source before
being fixed**, and each is now covered end-to-end through the real entrypoints.

| Blocker | Status |
|---|---|
| B1 `assembleRelease()` had no production caller | Fixed — `runTick()` assembles and stores in shadow |
| B2 `callCoordinator()` had no production caller; the DO binding was declared but unreached | Fixed — every scan applies through the coordinator; promotion approves through it |
| B3 work lost after `persistDiscovery()` was never recovered | Fixed — enqueue is now driven by `reconcile()` |

### B3 reproduced, then fixed

The finding was exact. With a throwing queue on scan 1:

```
scan1 THREW: queue unavailable
scan2 changed: 0 enqueued: 0 unchanged: 1
>>> RECOVERED: NO — jobs lost permanently
```

`discover()` skips a record whose hash is unchanged AND whose candidate exists, so the
record was stranded until someone edited it in FileMaker. The fix is to stop enqueueing
from `result.changed` and enqueue from `reconcile()` instead, which derives outstanding
jobs from MISSING completion records — recoverable from ANY crash point. Same
reproduction after the fix:

```
scan2 changed: 0 enqueued: 2
>>> RECOVERED: YES
```

**This corrected one of my own tests.** `a re-scan with no changes enqueues NOTHING`
asserted the wrong precondition — it never consumed the queue, so it was asserting that
un-translated work must NOT be retried, which is precisely the bug. Replaced by two
tests: no re-enqueue once work has *completed*, and re-enqueue when it never did.

### `runTick()` — the full cron path

`discover -> persist -> reconcile -> snapshot+enqueue outstanding -> apply scan via the
COORDINATOR -> assemble+store -> promote only if PUBLICATION_SERVING=on`.

Generation ids are **content-addressed** (`generationIdFor`), so an unchanged corpus
re-assembles to the same generation instead of writing a new bundle every minute — which
also makes `storeRelease()`'s refuse-to-overwrite check a real invariant.

Routes come from `routesForRecord()`, using the prefixes `buildSitemapEntries()` already
uses (sitemap.ts:200-207). `webPostSection` and `bookingCategory` get none: sections and
blocks are page fragments, category pages come from a filter.

### Verified end-to-end through the BUILT bundle against live FM

Not helper tests — the real `dist/server/entry.mjs` `scheduled` handler, fake bindings,
real FM reads, faked translation provider (no spend), real DO class over fake storage:

```
TICK 1: scanned 557, changed 557, enqueued 3208, coordinatorApplied true,
        inventoryComplete true, failures [], promoted false
TICK 2: changed 0, enqueued 0, ready 557, published 557, withheld 0,
        stored true, promoted false, current pointer null
Release: 557 entities, 1028 routes, VALID, 555/557 carry translated text
By kind: artist 33, previousArtist 341, client 37, bookingTalent 9,
         teamMember 17, newsPost 77, bookingCategory 6, webPostSection 37
```

Counts match the independent live FM probes exactly (33/37/17/77/6, and 37 =
6 sections + 31 blocks). The 2 entities without text are artists whose FM prose fields
are all empty (`requiredFields: []`) — they publish as valid empty entities rather than
blocking. bookingTalent is 9 because only ~11 of 72 roster rows carry
`bookingPresentation*` prose, matching the earlier probe.

Tests: 589 total (19 new), all passing.

## Checkpoint 6 — DEPLOYED, and the two defects only production could show

Deployed to `ninetone-site` (versions 5efbd371 -> 03c86c91 -> c514fa5e). All
Cloudflare bindings live: DO, both KV namespaces, queue producer + consumer + DLQ,
cron `* * * * *`.

Site serving verified immediately after the entrypoint change: `/`, `/records/artists`,
`/en/records/artists`, `/news`, `/team`, `/ninetone-nation/booking` all 200.

### Defect 1 — sequential KV I/O killed every tick

**Symptom in production:** `pub:v1:cand` and `pub:v1:newest` written for all 557
records, `pub:v1:inventory` written, and **zero snapshots**. No jobs enqueued, no
release possible. Ticks were being killed part-way.

**Measured cause:** one scan issues **6,686 KV operations**. Locally against a `Map`
that is 39ms; against remote KV at ~5ms/op it is **~33s of sequential I/O**, far past a
scheduled invocation. Breakdown: `reconcile` 2,228 reads, `discover` 1,115,
`persistDiscovery` 2,229, snapshots the rest.

**Why no test caught it:** every fake store in the suite is a `Map`. The defect exists
only against a real binding — exactly the class the deployment review warned about.

**Fix:** bounded parallelism (`readMany` / `runBounded`), identical keys, values and
results — only concurrency changes. **22.6s -> 1.8s** at simulated latency.

### Defect 2 — assembly was still sequential

**Symptom:** after fix 1, snapshots and all 3,208 completions appeared, but the only
bundles stored held **10 entities** — assembled early while 10 were ready — and no
complete bundle ever landed once all 557 became ready.

**Measured cause:** `readBackAll` does one read per (field, locale) at **concurrency 1**
— 3,342 reads = **21.6s** on its own. The tick died inside that loop every time, and
only succeeded while the ready set was tiny.

**Fix:** batch read-back across fields and entities. **21.6s -> 0.4s.** Whole tick now
~2.2s.

Both are pinned in `test/publication-kv-concurrency.test.mjs` (8 tests), which asserts
on **I/O shape** — peak concurrency and wall time under simulated latency — because
output-based tests cannot see this.

### Live shadow state — verified in production

```
pub:v1:cand 557 | pub:v1:newest 557 | pub:v1:snap 557 | pub:v1:done 3208 | inventory 1
Release g-dfff1310b635e43c: 557 entities, 1028 routes, VALIDATION ISSUES: 0
by kind: artist 33, previousArtist 341, client 37, bookingTalent 9,
         teamMember 17, newsPost 77, bookingCategory 6, webPostSection 37
with text: 555/557   DLQ: empty
rel:v1:current: ABSENT — nothing is served from a release
```

Real translations, both locales, e.g. anjo sv "Anjo är en dynamisk svensk Artist…" /
en "Anjo is a dynamic Swedish artist…". Counts match the independent live FM probes
exactly. All 3,208 translations completed in ~3 minutes with zero dead letters.

Tests: 597 total, all passing.
