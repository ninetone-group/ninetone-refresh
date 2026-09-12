# Publication deployment preparation: runtime blockers

Reviewed during resource preparation on 2026-09-12. User authorized preparing Cloudflare resources and using the existing local development Anthropic key for staging. No publication activation is authorized by this preparation step.

## Confirmed from current source

1. `src/lib/publication/orchestrate.ts:234` defines `assembleRelease()`, but no production caller exists anywhere in `src`. Therefore the configured cron/queue flow will not assemble shadow releases for comparison.
2. `src/lib/publication/coordinator-do.ts` defines `callCoordinator()`, but no production caller exists. Declaring the Durable Object binding does not route discovery through it. `worker-entry.ts` invokes `runDiscovery()`, which directly uses KV-backed `discover()` and `persistDiscovery()`.
3. `runDiscovery()` persists candidate/newest state before writing snapshots and sending jobs, and only enqueues `result.changed`. `discover()` skips matching hashes with existing candidates. A failed snapshot write/send after persistence is therefore not automatically repaired by the next unchanged scan. Similarly, `consumeJob()` acknowledges exhausted translation failures, but the next unchanged scan does not rediscover their missing completions. Wire durable reconciliation/outbox replay before enabling background work.

## Required before a useful shadow deployment

Wire coordinator ordering, durable outstanding-work recovery, and snapshot-based release assembly/storage into the actual runtime path. Verify through the real entrypoints that a cron tick followed by queue completion produces a readable shadow release; repeat after an injected crash between persistence and enqueue. Prove that failed translation jobs remain recoverable without visitor traffic or FM edits. Do not treat passing isolated helper tests or exported handlers as evidence of these connections.

Cloudflare resource creation, secret preparation and configuration validation may proceed independently. Keep the distinction between resources prepared and the publication system ready for deployment explicit in the readiness report.
