# Translation publication implementation review — 2026-09-12

## Verdict

Not ready for activation. The implementation report correctly describes a partial decision layer, not a working publication system. The new per-job completion records improve the previous design, but the broader claims about overlapping scans and cross-edge navigation are not established.

Reviewed `contracts.ts`, `discovery.ts`, `release.ts`, `serving.ts`, `worker-entry.ts`, configuration and implementation report. No application code changed, resources created, translation calls made or deployments performed in this review.

## Checkpoint 1: validation evidence

Ran `node --experimental-strip-types --test test/publication*.test.mjs` under Node 22: **77 passed, 0 failed**. Full builds and the report's total suite count were not re-verified. Additional local experiments used injected in-memory stores and the actual exported functions; results below expose cases beyond that suite.

## Checkpoint 2: remaining findings

### P1 — overlapping scans can still regress authoritative state

`discovery.ts`, `persistDiscovery()` unconditionally writes `newestHash` and complete inventory; removal markers are mutable too. Immutable completion records do not protect these writes. The advisory-lock comment that a double scan only wastes work is incorrect when scans observe different FM versions.

Reproduction: discover artist v1; discover v2 before persisting either; persist v2, then the delayed v1 scan. **Stored newest hash becomes v1.** This happens with an immediately consistent store; eventual consistency is not needed. Stale scans can also reintroduce withdrawal markers or erase newer inventory membership.

Required: coordinator-owned ordering of discovery/state application as well as promotion. A stale precomputed scan must not be applied after a newer one merely because its write is serialized. Keep the authoritative revision in strongly consistent storage; do not base promotion eligibility solely on potentially stale KV reads.

### P1 — per-request generation pinning does not protect cross-request navigation

`serving.ts`, `pinGeneration()` / `hasRoute()` resolve independently for every request. A complete generation guarantees consistency inside that render only.

Reproduction: edge A has a new generation containing `/artists/new`; edge B has the previous complete generation without it. **`hasRoute` returns true at A and false at B.** A new listing followed by a detail request resolving the old generation can still produce a 404. Cached listing/detail responses can create the same mismatch. The report's assertion that mixed generations are safe by construction is therefore too broad.

Required: define and test a navigation/cache strategy that resolves a newly published detail from an approved complete generation when the locally selected older generation lacks it. An authoritative fallback is one possible approach; any generation affinity must also cover HTML cache keys and direct links. Preserve removal policy when consulting older generations.

### P2 — promotion validates its argument, not the stored artifact served to visitors

`release.ts`, `promoteRelease()` validates the caller's `release`; `verifyGenerationReadable()` only checks the stored generation ID and that `entities` is an array. `storeRelease()` also permits overwriting a generation key despite its immutability comment.

Reproduction: store a bundle with empty SV/EN field maps, then call promotion with a valid bundle carrying the same generation ID. **Promotion returns `{ promoted: true }`; the subsequently read stored bundle has two validation issues.** The API does not enforce the claimed binding between validation and stored content.

Required: validate and bind the exact stored artifact to promotion, preferably via a content digest and coordinator-enforced generation uniqueness. Readiness must identify that artifact, not just a generation string. Test mismatched contents and repeated generation IDs.

### P1 integration gap — deletion delivery must survive discovery persistence

`persistDiscovery()` records a disappearance and removes its identity from inventory. If execution stops before removal publication, the next complete scan no longer emits that disappearance. `reconcile()` loops over current FM records, so an absent record is not recovered there either. A durable removal marker remains, but there is no implemented consumer/replay path for absent-record markers.

Reproduction: persist inventory containing the artist; discover and persist an empty complete scan; discover another empty complete scan. **First scan reports one removal; next reports zero; marker still exists.** This is recoverable state, but recovery is not implemented by the existing scan/reconcile functions.

Required: durable removal outbox/coordinator state, replayed until withdrawal is committed. Test a crash after persistence but before publication, plus later reactivation. Do not describe the urgent deletion acceptance case as end-to-end covered yet.

## Checkpoint 3: additional integration requirements

- `wrangler.jsonc` still selects the Astro adapter; the new entrypoint is not selected. Cron/queue functions are stubs, and rendering still uses the existing translation flow. Adding the wrapper file prepares the entrypoint solution; it does not close runtime wiring.
- “Keep doing exactly what it does today” on unavailable releases is unsafe wording for serving mode: today's flow can fetch FM/source fallback. Shadow may preserve it; serving mode needs an explicit last-approved-release or controlled unavailable response.
- `selectPublishable()` only selects ready connected groups. The assembly layer must merge last-published versions for pending edits. `rejectStalePromotion()` currently rejects any entity whose hash differs from newest, so it needs a deliberate distinction between retaining an approved old version and introducing a superseded candidate.
- Per-job records solve collisions between different jobs. Redelivering the same job still writes the same key, and changes its `at` timestamp; it is not literally an immutable identical-value replay. Define duplicate handling and retry/backoff. Cloudflare documents one write per second per key and eventual visibility: [KV write guidance](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).
- Shadow comparison resolves the current/history pointer. If shadow never promotes, wire a separate prepared-generation selection so comparisons actually inspect candidates.
- Protection lists are currently empty in `jobsForRecord()`. Queue integration must populate/verify protected names and validate actual translation results before completion, including Swedish-source and English-source cases.

## Checkpoint 4: next steps and decisions

1. Finish the coordinator, discovery adapter, queue consumer, artifact validation and serving/cache integration locally. Add regression cases above. Keep activation disabled until bootstrap exists.
2. Implement local integration tests for >25 strings without visitor traffic, zero model calls from public rendering, pending edits retaining approved content, deletion crash recovery and UI-copy deployment gating. Fake providers/local bindings can exercise these boundaries without production resources or translation spend; staging is still needed to validate real platform behavior.
3. Produce the bootstrap dry run before asking about actual spend. The quoted ~$10 is not a verified estimate from this review.
4. Land coordinator correctness before meaningful shadow validation. Choose shadow exit criteria based on successful creation/edit/removal/retry tests and explained comparisons, rather than elapsed time alone.
5. Validate on staging and record evidence before activation. The one-minute discovery interval is a polling cadence, not a guaranteed 1–2 minute publication deadline.

The three requested decisions do not block the remaining local implementation and tests. This review grants no deployment or paid translation authorization.

## Follow-up: moving between active and previous sections

The existing translation KV key (`translationKey()` in `src/lib/translate.ts`) includes source-text hash, target language, tier and key version. It does not include artist/client identity, status or section. Therefore unchanged text can reuse an existing cached translation when an artist or influencer moves sections, provided those key inputs remain unchanged and the entry exists.

Publication job identity separately includes entity kind and source hash. A status/category move may require new publication jobs, but the unfinished consumer must check the shared translation cache before invoking the model. Add an acceptance test: active -> previous -> active with unchanged text updates membership and reuses translations with zero model calls for cached fields. Different source fields/text or missing cache entries may require translation; moving status alone should not.
