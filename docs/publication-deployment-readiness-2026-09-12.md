# Publication deployment readiness — 2026-09-12

This file records the Cloudflare preparation state continuously. It does not
authorize or record a deployment.

## Resources

Cloudflare account access was verified through Wrangler 4.130.0. Existing
resources were listed before creation to avoid duplicates.

| Resource | Dashboard name | State |
| --- | --- | --- |
| KV | `ninetone-publication-state` | Created; bound as `PUBLICATION_STATE` |
| KV | `ninetone-publication-releases` | Created; bound as `PUBLICATION_RELEASES` |
| Queue | `ninetone-translation-jobs` | Created; producer and consumer prepared |
| Dead-letter queue | `ninetone-translation-jobs-dlq` | Created; configured for failed jobs |
| Durable Object | `NinetonePublicationCoordinator` | Binding and first SQLite migration prepared; class is created on deployment |
| Worker | `ninetone-site` | Existing Worker; no second Worker is needed |

The Worker already has an `ANTHROPIC_API_KEY` secret. Only the secret name was
listed; its value was never read, printed or rewritten. `PUBLICATION_SERVING`
is absent, so release-backed visitor serving remains disabled.

## Prepared configuration

`wrangler.jsonc` now contains the two real KV IDs, queue producer/consumer,
dead-letter policy, Durable Object binding and `v1` SQLite migration. Discovery
is scheduled every minute with `* * * * *`, matching the agreed freshness goal.

The Cloudflare build must be the final build before deployment because
`.wrangler/deploy/config.json` redirects Wrangler to
`dist/server/wrangler.json`. Generated configuration must therefore be checked,
not only the source `wrangler.jsonc`.

## Deployment gate

Infrastructure is prepared, but deployment is blocked by application wiring
findings in [publication-deployment-blockers-2026-09-12.md](publication-deployment-blockers-2026-09-12.md): the coordinator and release assembly are not reached by the runtime path,
and failed enqueue/translation work is not durably recovered on an unchanged
subsequent scan. Enabling the cron before those are fixed can create incomplete
shadow state and paid retry traffic without producing a releasable bundle.

No Worker deployment has been performed and no translation request has been
made during this preparation.

## Validation completed

- `npm run build:cf` completed successfully and was left as the final build.
- The generated `dist/server/wrangler.json` contains all five KV bindings, the
  translation queue consumer/producer, dead-letter queue, coordinator binding,
  `v1` SQLite migration and the one-minute cron.
- The generated bundle exports the Astro fetch handler, `scheduled`, `queue`
  and `NinetonePublicationCoordinator`.
- `wrangler deploy --dry-run` completed successfully against the redirected
  generated config and listed every expected binding. Dry-run uploaded nothing.
- `wrangler types` completed and generated `worker-configuration.d.ts` from the
  prepared source configuration.

The build emitted existing dynamic-route warnings but no build failure. An
initial Wrangler type-generation attempt was blocked by the filesystem sandbox
from opening a temporary localhost port; rerunning with the required permission
completed successfully.
