# Security audit — Cloudflare account migration and subsequent changes

Date: 2026-09-14. Reviewed through `c614134` against the parent of migration commit `ba27694` (September 12–14). This covers 79 changed files, with deeper inspection of the Worker configurations, middleware, image proxy, cache/data access, new routes, CI, and migration script. Existing contact/Publish handlers and markdown rendering were also checked as security boundaries.

Three actionable security findings were identified. The most urgent is a live deployment with working FileMaker access remaining in the personal account. No remediation or deployment was performed; this report is the only repository change.

## 1. P1 / High — The retired personal-account deployment still has live FileMaker access

Migration references: `wrangler.jsonc:13–20`, `worker-fm-proxy/wrangler.toml:2–3`.

The configurations pin future deployments to Ninetone's account, but this does not disable the old deployments or remove their credentials. The comments describe the original copies as retired.

Live checks on September 14:

| Endpoint | Result |
| --- | --- |
| `https://ninetone-site.micke-ohlen.workers.dev/admin/publish` | HTTP 200; title `Publish \| Ninetone Admin` |
| `https://ninetone-fm-image-proxy.micke-ohlen.workers.dev/healthz` | HTTP 200; `tokenCached:false`, `token:ok`, `fmFind:ok` |
| Corresponding Ninetone-account endpoints | Publish page accessible; proxy FileMaker check successful |

The old proxy successfully acquired a session and performed a FileMaker read; this is stronger evidence than merely finding an old hostname online. Ninetone's upstream data remains accessible through a deployment outside the new account's controls and current deployment process. Old-account access, stale code, and any forgotten triggers remain a separate security boundary. This is not evidence that anyone has compromised either account, or that Publish authentication can be bypassed.

Remediation: decommission the old site and proxy after checking remaining image consumers; remove their credentials and triggers. Revoke obsolete upstream credentials or rotate shared credentials in coordination with the new Workers. Verify that the retired endpoints no longer provide application/FM access. Disabling only the public hostname does not revoke credentials or stop scheduled jobs.

## 2. P2 / Medium — Withdrawn content survives successful 404 revalidation

References: `src/middleware.ts:417–423`, `src/middleware.ts:470–476`; introduced by the September 13 stale-while-revalidate change.

The cache now retains successful pages for seven days. A stale hit starts a SELF revalidation, but the caller consumes the response without examining its status. The inner middleware returns a new 404, redirect, or private/no-store response without deleting the previously cached public 200.

Concrete scenario: a previously published team/profile page is removed in FileMaker without an epoch-changing Publish. Once the ordinary page tier expires, fresh rendering correctly returns 404, but every ordinary request still receives the old profile. The old body can remain available until the seven-day hard expiration or cache eviction. A Publish epoch bump avoids this particular scenario.

Local reproduction against the real bundled middleware:

```text
request 1: visitor 200, body WITHDRAWN PROFILE; background 404; cache deletions 0
request 2: visitor 200, body WITHDRAWN PROFILE; background 404; cache deletions 0
```

Security impact: withdrawn personal information or other removed content remains publicly retrievable after the application has established that it should no longer be served.

Remediation: evict the old entry when authoritative revalidation returns 404/410, a replacement redirect, or a response that must no longer be publicly cached. Preserve stale-on-error behavior separately for transient upstream failures. Add regression coverage for withdrawal, not just successful 200 refreshes.

## 3. P2 / Medium — Untrusted image versions and extra path segments bypass the new cache

References: `worker-fm-proxy/src/index.ts:441–443`, `worker-fm-proxy/src/index.ts:472–484`, route parsing in `resolveImage()`.

The cache key includes an arbitrary client-supplied `v` parameter and the entire pathname. The resolver ignores surplus path segments for ordinary image routes. Consequently, many distinct public URLs resolve to the same image while each forces another authenticated FileMaker lookup and image fetch. No application rate-limit binding or check exists in the proxy configuration/handler. An account-level mitigation could reduce this risk, but it could not be verified.

Local reproduction using mocked upstream responses and a functioning Cache API:

```text
/artist/example/big?v=one
/artist/example/big?v=two
/artist/example/big/extra?v=one
=> 3 FileMaker finds, 3 cache entries, the same image
```

The general unthrottled-proxy exposure was noted in the September 9 audit. The September 13 cache does not close it: the new version parameter provides a direct, unlimited cache-busting input. A script can repeat this against one known image, increasing FileMaker load, Worker work, and bandwidth without authentication. No live load test was performed.

Remediation: enforce exact route arity and canonical paths; bind cache invalidation to a server-validated epoch/version rather than accepting unlimited independent client versions. Add a fail-closed per-client rate limiter and an upstream concurrency/request budget, covering the workers.dev endpoint as well as any custom domain. CORS is not an access-control substitute for these public GETs.

## Dependency findings — existing vulnerable tooling remains installed

The root `npm audit --json` completed against the registry and reported **5 high, 0 critical** package entries. These represent two underlying advisory families, not five independently demonstrated website vulnerabilities:

- `wrangler@4.130.0` → `miniflare@5.20260908.0-alpha` → `sharp@0.35.2`, with propagated entries for Wrangler, Miniflare, and the Cloudflare Vite plugin. Astro's separate `sharp@0.35.4` is patched. The affected image-decoding path requires untrusted input reaching the vulnerable native decoder; no remotely reachable production-Worker exploit was established. The registry reports a Wrangler update to `4.131.2` as a fix. See the [sharp advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
- `smol-toml@1.6.1`, used by Astro and its internal helpers, is covered by a malformed-TOML denial-of-service advisory. No public TOML upload/parse endpoint was found in the reviewed application. This is a dependency/build-tool exposure, not a demonstrated unauthenticated website DoS. See the [smol-toml advisory](https://github.com/advisories/GHSA-7w5x-hrqm-74c2).

Update the affected dependency trees and lockfiles, then rerun the application/proxy suites and Cloudflare build. Do not treat a package-manager severity as proof of production exploitability. The proxy has its own dependency tree; the fresh registry audit above covers the root tree only.

## Verification and limits

- Application tests: **753/753 passed**.
- Image-proxy tests: **14/14 passed**.
- The two cache scenarios above were reproduced separately against current code with mocked upstreams; existing tests do not prevent them.
- Current tracked files and the migration-to-HEAD patch were scanned for recognizable credential patterns. Six existing local secret values were compared against that patch without displaying their values. No matches were found. This is not a complete all-history secret scan or a credential-rotation audit.
- Publish/contact authorization, body limits, rate-limit failure behavior, fixed contact recipients, and markdown/URL defenses were inspected. No new bypass, stored XSS, open redirect, or secret disclosure was demonstrated in the reviewed changes.
- Public checks were limited to robots, Publish-page GETs, and image-proxy health checks. No Publish action, form submission, email, destructive probe, or stress test was performed.
- Cloudflare API requests using the available local credential returned HTTP 401 / error 10000. Account membership/MFA, deployed bindings, secret rotation, WAF rules, cron state, old-account resource cleanup, and zone/TLS controls remain **unverified**. Source configuration is not proof of deployed account state.
- No new build/deployment was performed. The installed dependency tree and passing tests do not prove that either live Worker runs this exact HEAD.

Worker review reference: [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## Remediation status — 2026-09-14 (v0.2.4.2)

| Finding | Status |
| --- | --- |
| 1. Personal-account deployments | **Done.** Both Workers deleted from the Gmail account (the site first had to be removed as consumer of its queue). KV namespaces and queues on that account hold no credentials and were left in place. FM credential rotation is Patrik's call; the site does not depend on it. |
| 2. Withdrawn content survives revalidation | **Done.** `src/middleware.ts` evicts the cached entry when the authoritative re-render is not a cacheable 200 (SELF path and the synchronous fallback). Regression tests in `test/middleware.test.mjs`. |
| 3. Proxy cache-busting / arity / no rate limit | **Done.** `worker-fm-proxy`: `?v=` validated against the Publish epoch via a read-only `CACHE_STATE` binding, exact route arity, per-IP rate limit on cache misses (`IMAGE_RATE_LIMITER`, 120/min, fail-closed). Tests in `worker-fm-proxy/test/cache.test.ts`. |
| Dependencies | **Done.** Wrangler 4.131.2 in both trees; `npm audit fix` on the root tree → 0 advisories. |
