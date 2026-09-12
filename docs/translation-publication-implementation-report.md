# Translation-publication implementation — report

Implementation of
[the handoff](translation-publication-implementation-handoff.md) against
[the design](translation-publication-plan-2026-09-12.md), including the
corrections required by
[the checkpoints 1–2 review](publication-checkpoints-1-2-review.md).

**Branch** `i18n-phase-2`, pushed through `2955329`.
**Tests** 443 passing (76 new across four publication suites).
**Builds** gh and cf both green; post-build audit clean over 548 pages.
**Deployed** nothing. Staging still runs `2c070291`, unchanged since before
this work began.

## What this does and does not claim

It is **not** a working publication system. Four of five checkpoints have
their logic implemented and tested; none of it is wired into a request, no
Cloudflare resource exists, and no content is served from a release. The
handoff asked for local implementation and tests before deployment, and that is
the state reached.

What exists is the decision layer — the rules that determine whether content is
safe to publish — built so those rules are verifiable without a network, a
deploy, or translation spend. What does not exist is the machinery that would
act on them.

## Status by checkpoint

| # | Checkpoint | State |
|---|---|---|
| 1 | Inventory and contracts | Done, review-corrected |
| 2 | Background preparation | Logic done, review-corrected; not wired |
| 3 | Safe publication | Logic done; not wired |
| 4 | Serving and lifecycle | **Partial** — resolver and entrypoint only |
| 5 | Validation and rollout | Not started |

## What was built

Four modules under `src/lib/publication/`, each pure and injected so the rules
are testable in isolation, plus one Worker entrypoint.

**`contracts.ts`** — the shapes and the rules. `SourceRecord` with a content
hash, `TranslationJob` with a stable id, `Candidate`, `Release`, and
`validateRelease()`.

The field inventory is derived from the actual `fm()` call sites rather than
from `scripts/translate-warm.mjs`, because those two had already drifted: the
warm script wrote WebPosts titles on the `quality` tier while `fmText()` reads
`fast`, so the keys were never looked up and `/team` rendered English under
Swedish chrome while a correct translation sat unused in KV. A test now pins
`ENTITY_TIER` against `CHROME_TIER`.

**`discovery.ts`** — scan, dedupe, supersede, remove. Content hashes rather
than timestamps, because FM exposes no reliable modified-at on these layouts;
an unchanged re-save therefore produces no work, and supersession is decidable.

**`release.ts`** — immutable generations, promotion gates, resolution,
rollback, and the urgent-removal path.

**`serving.ts`** — one generation pinned per request, shadow-mode comparison,
and an explicit `unavailable` result that never falls back to live FM.

**`worker-entry.ts`** — `scheduled` and `queue` handlers beside Astro's
`fetch`. The adapter entrypoint exports only `{ fetch }`, so there was nowhere
to put them; this re-exports the adapter's handler verbatim rather than
wrapping it, so serving cannot regress through the change.

## The review's six counterexamples

Every one was reproduced locally before being fixed, and re-running the
review's own reproductions afterwards gives **6/6 fixed**. Fifteen regression
tests pin them in `test/publication-review-regressions.test.mjs`.

The central fix: **job progress is no longer a mutable shared object.**
Completions are immutable per-job records at their own keys, so writing one
never touches another. That removes the lost-update race — two locales
finishing concurrently kept only 1 of 2 flags, even against an immediately
consistent store — and makes a duplicate scan harmless, because there is no
progress field left to reset. Candidate state is derived by reading completions
back rather than mutated in place.

While verifying the review's KV TTL claim I confirmed a second, independent
reason the old shape was wrong: **Cloudflare KV allows one write per second per
key.** A hot candidate would have produced 429s regardless of the race. That is
recorded in the module comment so the pattern is not reintroduced elsewhere.

The rest: crash recovery now treats a known hash with a missing candidate as
outstanding work (closing the window from either write order), validation binds
to an explicit `requiredFields` manifest instead of inferring requirements from
output, disappearance is detected by comparing membership against an inventory
from the last **complete** scan, `selectPublishable()` binds references in both
directions with kind-qualified identities, and the scan lock no longer writes an
`expirationTtl` below Cloudflare's minimum of 60.

**Two claims withdrawn rather than defended.** My comment asserting the crash
window "self-repairs" described the failure; the reviewer was right.
`validateRelease()` no longer claims to check protected names — that happens at
translation time via `protect`, and verifying afterwards needs source text a
release entity does not carry. Claiming an unimplemented guarantee is worse
than not having it.

## Consistency: how a pointer is prevented from lying

Workers KV is eventually consistent and has no compare-and-set, so a
`current-generation` pointer is not a publication promise. Three rules, each
tested:

1. `storeRelease()` writes the bundle, **then** a readiness marker. A crash
   between them leaves a bundle with no marker, which reads as not-ready — safe,
   and repaired by the next attempt. The reverse order would advertise a bundle
   that may not be readable.
2. `verifyGenerationReadable()` checks the marker **and** parses the bundle
   back, so a marker that propagated to one edge cannot stand in for a bundle
   that has not.
3. `resolveGeneration()` walks retained history when the pointer names
   something unreadable, and returns **null** rather than anything partial when
   nothing is readable.

Mixed generations across edges are safe by construction: each validates as a
whole, so an edge serving an older one shows a consistent older site rather
than a new listing linking to an unavailable detail page. Tested explicitly,
since it is the handoff's hardest acceptance case.

## Acceptance tests: honest coverage

| Required test | Covered | Notes |
|---|---|---|
| New artist + two related posts withheld until all ready | Yes | `selectPublishable`, both directions |
| Edited record keeps old content; failures never leak source | Partial | Composition rule tested; end-to-end needs wiring |
| >25 new strings complete without visitor traffic | **No** | Needs the queue consumer |
| Duplicate deliveries, overlapping scans, restarts, late jobs | Yes | Regression suite |
| Missing/late KV artifacts, mixed generations | Yes | Release suite |
| Inactive/deleted removed without waiting on translation | Yes | `withRemovals`, priority path |
| Public requests initiate no model calls | **No** | Rendering still uses `fmText()` |
| Deploy with new UI strings cannot expose missing translations | **No** | Needs checkpoint 5 |

Three of eight are not covered, and all three require infrastructure that does
not exist. Passing unit fixtures is not evidence for the queue and concurrency
requirements — the review said so and it remains true.

## What is deliberately not done

- **`wrangler.jsonc` is unchanged.** No cron trigger, no queues, no Durable
  Object, no new KV namespaces. `main` still points at the adapter.
- **`scheduled` and `queue` are stubs** that log and retry. Wiring them against
  resources that do not exist would be worse than a handler reporting it is not
  enabled.
- **Rendering still uses `fmText()`.** Removing visitor-triggered translation
  before a bootstrapped release exists would leave the site with no content
  source at all.
- **No bootstrap generation**, which needs authorized translation spend.
- **The coordinator does not exist.** Immutable completions removed the race
  that made candidate state unsafe, but the scan lock remains advisory and the
  current-generation pointer remains the one mutable key in the release path.
  Two concurrent promotions could still overwrite each other; both would name a
  complete generation, so the failure mode is "an older complete site wins"
  rather than corruption. Real, and written at `promoteRelease` rather than
  hidden.

## What I would want decided before continuing

1. **Translation spend for the bootstrap.** An initial complete generation must
   exist before anything can serve from one. Comparable to the earlier warm
   runs (~$10 range), but I would dry-run it first and report the real number
   rather than commit to that estimate.
2. **Shadow duration.** The design wants bundles generated and compared against
   live output before the switch. How long that runs is a judgement call about
   confidence, not a technical one.
3. **Whether the Durable Object lands before or after shadow.** It is needed
   for correctness under concurrent promotion, but shadow mode never promotes,
   so shadow could begin without it.

## Naming

Per the request that new Cloudflare resources be findable in the dashboard —
the existing `CACHE_STATE` namespace was unidentifiable among seven and had to
be renamed mid-session:

| Kind | Name |
|---|---|
| Worker | `ninetone-site` (cron added to the existing Worker, not a second one) |
| KV | `ninetone-publication-state`, `ninetone-publication-releases` |
| Queue | `ninetone-translation-jobs`, `ninetone-translation-jobs-dlq` |
| Durable Object | `NinetonePublicationCoordinator` |

None of these exist yet; the names are reserved in the progress document so
whoever creates them does so consistently.

## Operational note

`npm run build` and `npm run build:cf` write to the same `dist/`. Running the
gh build after the cf build leaves stale server output and `wrangler deploy`
then ships the wrong bundle. This cost real debugging time twice in earlier
sessions. Always rebuild cf immediately before deploying.
