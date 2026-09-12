# Translation-safe publication plan — 2026-09-12

## Decision

Move translation out of visitor rendering and make publication a versioned release process. FileMaker remains the live source of truth and is discovered through its existing read-only Data API. A new or edited record becomes publicly visible only after every required translation and derived surface has passed automated validation. Visitors read a last-good published snapshot; they never start translation work.

The current fallback is unsuitable as a publication mechanism. `sharedT()` and `fmText()` correctly share one per-render budget, but the ceiling is 25 **uncached** calls across both UI chrome and FM prose. A large cold render can therefore leave later content untranslated indefinitely when the same ordering repeats. A miss also returns source text immediately, and middleware can cache that complete fallback HTML for the route TTL. Translation reaching KV later does not guarantee the next visitor sees it.

## Proposed flow

1. A Cron Trigger runs a read-only FileMaker discovery job on a short interval. It fetches the existing layouts through `src/lib/filemaker.ts`, normalizes public records, and computes a source hash from every publication-relevant field plus record identity, status, relationships, translation prompt version, and locale set.
2. Discovery compares those hashes with persisted job state. For each new hash it creates a deduplicated job and sends field-level translation work to Cloudflare Queues. The stable job identity should include entity, source hash, target locale, field, kind, and translation-key version.
3. Queue consumers translate with bounded concurrency. Queue delivery is at least once, so writes must be idempotent. Retry transient provider failures with backoff; send exhausted jobs to a dead-letter queue and expose them in operational status. A later discovery pass can safely re-enqueue missing work.
4. When all required work for a source version exists, build one immutable release bundle. It contains the localized entities and every derived projection that can expose them: detail and list route inputs, homepage selections, related-content links, search index, sitemap, feeds/LLM surfaces, and route existence data.
5. Validate the bundle, then promote it. Validation should check field presence, expected locale, output contract, protected names, valid Markdown/URLs, relationship closure, unique slugs, and that every linked route exists in the same bundle. These checks detect mechanical publication defects; they do not promise perfect linguistic quality. Human overrides remain possible and produce a new candidate release.

## Publication and consistency

Store bundles under immutable generation IDs and retain several known-good generations. Never assemble a release at request time from independently updated KV keys. A single release identifier must select the complete bundle for a request, so homepage, lists, detail pages, search, and sitemap cannot mix generations.

Workers KV is eventually consistent and concurrent pointer writes can overwrite each other. It is safe for immutable, read-heavy release payloads, but a naive `current-version` KV key is not an atomic publication promise. Use one serialized coordinator, preferably a Durable Object, to own candidate state and promotion order. Before promotion it verifies that the immutable bundle is complete and readable. Requests may temporarily observe the old generation while caches propagate, but both old and new generations are internally complete. If the stronger coordinator is deferred, use a self-contained bundle plus a readiness marker and make readers fall back to the last-good generation whenever either is missing; never treat a pointer alone as proof of readiness.

Promotion must reject stale completion: immediately before marking a candidate ready, compare its source hash with the newest discovered hash. If FileMaker changed during translation, mark the old candidate superseded. Completion from an older queue message must never overwrite state for the newer edit.

New records stay absent until their candidate is ready. Failed edits leave the prior published version live. Inactive or deleted records are different: discovery should create a high-priority removal release that filters the entity and all references without waiting for translation, then invalidate the affected route and shared projections. This prevents an urgent withdrawal being held behind prose work.

A failed record need not block unrelated ready records: compose the candidate from validated new versions plus last-good versions of pending edits, omitting pending new records. Validate that combined release. Cache propagation is not globally simultaneous, even with a coordinator. Retain published generations and explicitly test new-list-link → detail navigation across mixed cache generations; version-pinned navigation or a safe lookup of an already-published complete detail version must prevent transient 404s. A missing artifact must never fall through to live, untranslated FileMaker data.

The admin **Publish** action should enqueue immediate discovery and return a job/release status. It must keep the current generation live and must not purge it first. The UI should say that publication is processing, then report ready, failed, or superseded; it should not promise a fixed minute when translation-provider latency is unknown.

UI chrome belongs to the release prerequisite too. Warm and validate all supported chrome strings whenever the translation prompt version, overrides, or application build changes. Missing chrome blocks that release rather than falling back during a visitor request.

## Practical rollout

1. Add persisted discovery/job state, the scheduled scan, idempotent queue workers, retries, DLQ visibility, and source-hash supersession. Keep current serving behavior while measuring candidate completeness.
2. Generate and validate immutable bundles in shadow mode; compare their route/search/sitemap membership and translated fields with current output.
3. Switch reads to the last-good release, remove visitor translation scheduling, and change Publish from cache-version bumping to refresh enqueueing.
4. Add release history, rollback, stale-job/DLQ alerts, translation latency, pending-record age, and a protected urgent-removal path.

Cloudflare references: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), and [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
