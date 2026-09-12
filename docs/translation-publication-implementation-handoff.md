# Implementation handoff: translate before publication

## Task and authorization

Implement the agreed background publication workflow described in [the design](translation-publication-plan-2026-09-12.md). The user approved implementation on 2026-09-12, then requested advice about handing it to a fresh session because this thread is crowded. This handoff does not mean implementation is complete. No new publication infrastructure has been deployed.

Work in small sections. Create `docs/translation-publication-progress.md` immediately and update it after every section with files changed, tests, remaining work, and exact resume commands. Preserve existing work. Keep token usage modest; do not repeat the completed audits.

## Agreed product behavior

- Patrik saves normally in FileMaker; no FM code, schema, webhook, or service-account changes are required by the design.
- A scheduled background Worker checks existing public FM layouts every minute. Prevent overlapping scans; deduplicate by content/version hash.
- New content is absent from public pages until both supported language versions and required references are ready. Edits retain their previous complete published version while preparation runs.
- Example acceptance scenario: a candidate contains one new artist plus two related news posts. Withhold that group until all three are ready, then publish it with consistent profile, roster, homepage, news, search, and sitemap data.
- Do not promise to detect future FM saves. If the posts are saved after a candidate has already published, they are a subsequent update. Without an explicit FM completion signal, arbitrary separate saves cannot be known to form one finished editorial transaction. Document discovery/grouping semantics honestly.
- Around 1–2 minutes is a target, not a deadline: detection interval plus translation, validation, and cache propagation. Failure keeps incomplete content unpublished and exposes operational status.
- Deployments must prepare and validate new UI translations before activating that release. Unchanged translations are reused. Publish requests immediate background preparation, not premature cache invalidation.
- Withdrawals/deletions bypass translation work through a prioritized removal path. Never restore an inactive artist by rolling back stale content.

## Current state to preserve

Starting HEAD for this handoff: `2255971`. Recheck status: other work has continued concurrently.

The working tree contains uncommitted performance instrumentation, duplicate-roster-translation fixes, browser evidence, hover-art/image optimizations, and tests. Do not reset, overwrite, or attribute all those changes to this implementation.

Read `CLAUDE.md`, `docs/cms-architecture.md`, the design above, and `docs/performance-investigation-2026-09-12.md`. FileMaker remains the CMS; published snapshots are delivery artifacts, not a replacement editorial database.

Relevant implementation: `src/lib/translate.ts`, `src/lib/t.ts`, `src/lib/filemaker.ts`, `src/lib/ninetone.ts`, `src/middleware.ts`, `src/pages/api/publish.ts`, `src/lib/sitemap.ts`, `scripts/translate-warm.mjs`, and `wrangler.jsonc`.

Do not revert response-body buffering: it prevents a documented zero-byte response race. Do not raise the 25-miss visitor budget as a solution. Move publication work away from visitors. Preserve locale routing, security controls, human overrides, source-language exceptions, and protected artist/song names.

## Implementation checkpoints

1. **Inventory and contracts.** Inventory every public data surface and translation key, including shared chrome, card blurbs, related content, guides, search, and discovery files. Define candidate, published generation, job, and readiness contracts. Reuse the existing key/validation logic.
2. **Background preparation.** Add scheduled discovery and persisted, idempotent translation jobs with bounded concurrency, retry/backoff, failure visibility, and restart recovery. Compare source hashes again before promotion; outdated completions cannot replace newer work. A failed unrelated record must not block all publishing.
3. **Safe publication.** Build immutable complete generations; serialize promotion and retain a known-good fallback. Account for KV eventual consistency: pointer visibility alone is not readiness. Verify mixed-edge-generation navigation cannot yield new listing links to unavailable details.
4. **Serving and lifecycle.** Resolve one published generation per request; serve its content without live FM/translation fallback. Replace visitor-triggered translation and switch Publish to enqueue/status behavior. Bootstrap and validate an initial generation before enabling this path. Code/chrome compatibility must survive deployment and rollback.
5. **Validation and rollout.** Test below, run appropriate builds sequentially, write deployment/rollback instructions, and produce a reviewable staging-ready result. Do not launch production, flip DNS/indexing, or send notifications as part of this handoff. Stage deployment and any translation spend must be explicitly reported and authorized before execution where not already approved.

## Required acceptance tests

- New artist + two known related posts: no premature public appearance; all required translations ready before promotion, including direct routes, snippets, search, and sitemap.
- Edited record keeps old translated content; translation failure and provider timeout never leak source fallback.
- More than 25 new strings eventually complete without visitor traffic or starvation; budget/concurrency remains bounded.
- Duplicate deliveries, overlapping scans, restarts, and older jobs completing late cannot corrupt or regress publication.
- Missing/late KV artifacts and mixed cache generations serve complete content or safe last-good responses, never untranslated live FM data.
- Inactive/deleted records are removed without waiting on translation and remain removed after stale-job completion/rollback.
- Public requests do not initiate model calls; timing and local tests demonstrate prepared-content reads.
- Deploy with new UI strings cannot expose missing translations; initial bootstrap and rollback are tested.

Run existing tests plus meaningful new integration tests. Both builds use `dist/`: never run them concurrently; always rebuild CF immediately before any Worker deployment. Record exact successes and limitations rather than claiming a globally instantaneous switch or perfect automated linguistic validation.
