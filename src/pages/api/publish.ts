import type { APIRoute } from "astro";
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { readLimitedBody, json, isCrossSite, sha256Hex } from "../../lib/http.ts";
import { siteOrigin } from "../../lib/site.ts";
import { staticRoutePaths } from "../../lib/routes.ts";
import { pingIndexNow } from "../../lib/indexnow.ts";

/**
 * "Publish now" — instant cache flush for editors (docs/cms-architecture.md).
 *
 * Bumps the `cache-version` epoch in KV. Every edge-cache key embeds the
 * version (src/middleware.ts), so bumping it orphans all cached copies at
 * once — the next visitor renders fresh from FM. No Cloudflare purge-API
 * token needed, works on workers.dev and the production domain alike.
 *
 * Effect propagates within ~a minute (the version lookup is edge-cached 60s)
 * plus the 60s data-cache TTL. Editor mental model: "edits appear within the
 * hour on their own — hit Publish to make it a minute."
 *
 * Auth: single shared password (PUBLISH_PASSWORD secret). Deliberately
 * simple for v1 — one org, trusted editors, HTTPS.
 */

import { getCfEnv, type CfEnv } from "../../lib/cf.ts";

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ab, bb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]).then((values) => values.map((value) => new Uint8Array(value)));
  return cryptoTimingSafeEqual(ab, bb);
}

export async function handlePublish(request: Request, env: CfEnv | null): Promise<Response> {
  if (isCrossSite(request)) {
    return json(403, { ok: false, error: "Cross-site request rejected" });
  }
  const kv = env?.CACHE_STATE;
  const expected = env?.PUBLISH_PASSWORD;
  const limiter = env?.PUBLISH_RATE_LIMITER;

  if (!kv || !expected || !limiter) {
    return json(503, {
      ok: false,
      error: "Publish is only available on the live (Cloudflare) deployment",
    });
  }

  const connectingIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rateKey = await sha256Hex(connectingIp);
  try {
    if (!(await limiter.limit({ key: rateKey })).success) {
      return json(429, { ok: false, error: "Too many attempts" });
    }
  } catch {
    return json(503, { ok: false, error: "Publish protection is unavailable" });
  }

  let password = "";
  try {
    const raw = await readLimitedBody(request, 4_096);
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const body = JSON.parse(raw) as { password?: string } | null;
      password = String(body?.password ?? "");
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      password = new URLSearchParams(raw).get("password") ?? "";
    } else {
      return json(415, { ok: false, error: "Unsupported content type" });
    }
  } catch (err) {
    if (err instanceof RangeError) return json(413, { ok: false, error: "Request too large" });
    return json(400, { ok: false, error: "Invalid body" });
  }

  if (!password || !(await timingSafeEqual(password, expected))) {
    return json(401, { ok: false, error: "Wrong password" });
  }

  const version = `${Date.now().toString(36)}`;
  try {
    await kv.put("cache-version", version);
  } catch {
    return json(503, { ok: false, error: "Publish is temporarily unavailable" });
  }

  // IndexNow — dormant until launch (docs/seo-phase-1-brief.md §10). Only
  // fires once the site is actually production-shaped (siteOrigin() host
  // ends with "ninetone.com" — never on *.workers.dev staging or the GH
  // Pages *.github.io preview). A failed or skipped ping must never affect
  // the publish response: the epoch bump above already succeeded and is the
  // real effect; this is best-effort extra credit. Awaited (not fire-and-
  // forget) because a Worker can cut off unawaited async work once the
  // response is returned — there's no waitUntil plumbing in this codebase to
  // extend instead — but errors are always swallowed, never thrown onward.
  try {
    await notifyIndexNow(request);
  } catch (err) {
    console.error("IndexNow ping failed:", err);
  }

  return json(200, { ok: true, version });
}

/**
 * Best-effort IndexNow notification, split out so its own errors (bad
 * origin, fetch failure, etc.) can't reach the publish response. Exported
 * for direct unit testing of the host guard without needing a live network.
 */
export async function notifyIndexNow(request: Request): Promise<void> {
  const origin = siteOrigin(request);
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    return;
  }
  // Dot-anchored: "evilninetone.com" must not pass (2026-09-12 review).
  if (host !== "ninetone.com" && !host.endsWith(".ninetone.com")) return;

  const urls = staticRoutePaths().map((path) => `${origin}${path === "/" ? "" : path}`);
  await pingIndexNow(origin, urls);
}

export const POST: APIRoute = async ({ request }) => handlePublish(request, await getCfEnv());
