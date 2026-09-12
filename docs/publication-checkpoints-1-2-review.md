# Review of publication checkpoints 1–2

Reviewed revision: `758fbdd` (contracts `82460e7`, discovery `758fbdd`). Review only: no implementation edits, deployment, or production writes. Existing passing tests do not cover the counterexamples below.

## Verdict

Architecture direction is consistent with the agreed design, and jobs target both Swedish and English. However, the two logic checkpoints are not yet reliable enough to build production promotion on top. Fix the state/recovery and validation defects below before calling them complete. Runtime workers, scheduling, queue consumers, and serving gates are still future work.

## P1 — crash recovery permanently strands a source version

`persistDiscovery()` writes `newestHash` before the candidate. `discover()` skips a record solely when that hash matches. A crash between those writes leaves no candidate, and the next scan generates no jobs. The comment claiming this repairs itself describes the failure instead.

Local reproduction: seed only newestHash=v1, scan source v1 → changed=[], unchanged=1, jobs=[].

Required: reconcile candidate existence and outstanding work on every scan, with recoverable enqueue intent/outbox semantics. A crash after candidate persistence but before queue submission must also recover. Do not fix just by reversing two writes; both orders have crash windows.

## P1 — concurrent completion loses progress; discovery is not safely idempotent

`recordJobCompletion()` reads and rewrites a shared candidate JSON object. Two different field/locale jobs can read the same completed map and overwrite each other's flags. Re-running `persistDiscovery()` for an identical result also resets completed={}.

Local reproduction using Promise.all on the two locale completions: only **1 of 2** completion flags remained in the candidate, even with an immediately consistent in-memory store. Eventual consistency adds more races. An advisory scan lock and stable job IDs do not solve these state races or stale newestHash overwrites.

Required: serialize candidate/source/job state in the coordinator too, not only release-pointer promotion, or use immutable per-job completion records with an authoritative reconciliation protocol. Test concurrent distinct completions, duplicate scans after progress, out-of-order source snapshots, and completion concurrent with withdrawal. KV's per-key write limits are another reason not to treat it as a mutable high-frequency job-state database.

## P1 — release validation cannot prove completeness

`validateRelease()` infers required source fields from fields present in either translated output. If a required source field disappears from both locale maps, validation silently skips it. `routes` is not checked either.

Local reproduction: a release entity with text={sv:{},en:{}} and routes=[] passes `isReleasePromotable()`, even when the originating source record has a biography.

Required: bind validation to the exact candidate/source manifest and explicit required field/job sets. Require stored validated outputs and the intended route/reference inventory, not just two output object keys. Protected-name validation is declared but not implemented in this validator; do not claim it is enforced here. Test both-side omissions, one-side omissions, blank strings, missing routes, and stale hashes.

## P1 — disappeared records are not discovered as removals

`discover()` only iterates records returned by loadRecords. It recognizes active=false records, but never compares previous entity membership with current membership.

Local reproduction: persisted known record, then loadRecords returns [] → removed.length=0.

Required: compare an authoritative previous inventory with a successfully completed, validated current scan. Do not interpret partial/failed/truncated FM reads as mass deletion. Test actual disappearance, inactivity, reactivation, and stale job completion after removal. A future loader could synthesize tombstones, but that adapter and its contract are not present in the reviewed checkpoint.

## P2 — group selection does not establish the claimed artist-plus-posts rule

`selectPublishable()` follows references in one direction. With two posts referencing an artist, a ready artist can publish while both posts remain pending.

Local reproduction: artist ready; two pending posts reference artist → selected=['new-artist'].

Required: model the intended group explicitly for the known records in a scan, or materialize its dependency closure in both directions as appropriate. Use kind-qualified identities consistently; current selection compares bare ids while release validation also accepts kind:id references. The helper also does not itself merge last-good versions despite its comment. Preserve the honest limitation that later FM saves cannot be anticipated.

## P2 — scan lock release uses an invalid KV TTL

`releaseScanLock()` uses expirationTtl:1; Cloudflare KV requires at least 60 seconds. Use a correct storage primitive; preferably eliminate the advisory KV lock once the coordinator serializes discovery/state. Merely adding delete does not make ownership read/delete atomic.

Official reference: [Cloudflare KV writes, concurrency, expiration, and per-key limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).

## What is aligned

- Both locale jobs are created per populated field, so the design is not one-way Swedish→English. Actual language preservation/validation still depends on the translation consumer, not these pure contracts.
- Pure injected logic, checkpoint documentation, and recognizable Cloudflare names are useful foundations.
- An existing Worker can host additional handlers, provided the final entrypoint preserves Astro fetch and correctly exports scheduled/queue/Durable Object functionality. That wiring is not implemented yet.
- Keeping unfinished publication logic out of production is appropriate. This review makes no changes to deployment authorization from the user's separate implementation session.

## Next action for Opus

Add regression tests for these exact counterexamples and fix checkpoints 1–2 before proceeding to production promotion. Preserve the current site-serving behavior until initial translated release bootstrap, immutable artifacts, consistency fallback, and end-to-end publication tests pass. Passing sequential unit fixtures alone is insufficient for the queue/concurrency requirements.
