/**
 * IndexNow — dormant until launch.
 *
 * IndexNow (https://www.indexnow.org) lets a site push "this URL changed"
 * notifications to participating search engines (Bing, Yandex, and others
 * that read the shared feed) instead of waiting for a crawl. We ship the
 * plumbing now so flipping it on at launch is a one-line change (see
 * src/pages/api/publish.ts), not a build.
 *
 * Protocol (https://www.indexnow.org/documentation): POST a JSON body with
 * `host`, `key`, `keyLocation`, and `urlList` to the IndexNow API. The engine
 * verifies ownership by fetching `keyLocation` and checking its body equals
 * `key` — that's what src/pages/[key].txt.ts serves.
 *
 * Env resolution mirrors src/lib/filemaker.ts's `runtimeEnv` / src/lib/site.ts's
 * `readEnv`: prefer whatever Vite baked into `import.meta.env` at build time,
 * else fall back to `process.env` so a value set as a live Worker secret
 * (nodejs_compat) is picked up at request time on the CF target. Read lazily
 * (inside the function, not module scope) for the same reason those modules
 * do — the Worker isolate must see its own bindings, not the build machine's.
 */
import { secretEnv } from "./env.ts";

export function indexNowKey(): string | undefined {
  return secretEnv("INDEXNOW_KEY");
}

/** The IndexNow request itself (https://www.indexnow.org/documentation). Rejects on a network failure. */
function postIndexNow(origin: string, key: string, urls: string[]): Promise<Response> {
  return fetch("https://api.indexnow.org/IndexNow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(origin).host,
      key,
      keyLocation: `${origin}/${key}.txt`,
      urlList: urls,
    }),
  });
}

/** What IndexNow answered. `why` is filled only when the request was not accepted. */
export interface IndexNowResult {
  ok: boolean;
  /** HTTP status, or 0 when no request was made or it never got an answer. */
  status: number;
  why?: string;
}

/**
 * Notify IndexNow that `urls` changed and say what it answered. `origin` must
 * be a bare origin (see src/lib/site.ts `siteOrigin()`) — `host` is derived
 * from it, and every entry in `urlList` must share that host per the IndexNow
 * spec.
 *
 * Never throws. The reason for a refusal is kept because a yes/no is not
 * enough to act on: the first live run of the sitemap sync (2026-11-10) was
 * refused and nothing recorded whether that was the key, the key file or the
 * URL list. The key itself is cut out of the reason before it is returned.
 */
export async function submitIndexNow(origin: string, urls: string[]): Promise<IndexNowResult> {
  const key = indexNowKey();
  if (!key) return { ok: false, status: 0, why: "INDEXNOW_KEY is not set" };
  if (urls.length === 0) return { ok: false, status: 0, why: "no URLs to report" };

  try {
    const res = await postIndexNow(origin, key, urls);
    if (res.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => "")).split(key).join("<key>").replace(/\s+/g, " ").trim();
    return { ok: false, status: res.status, why: `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, why: `request failed: ${message.split(key).join("<key>").slice(0, 300)}` };
  }
}

/**
 * Yes/no form of submitIndexNow, for the Publish handler.
 *
 * Returns `false` when `INDEXNOW_KEY` is unset or `urls` is empty — there is
 * nothing to ping, and callers (the Publish handler) must never let this block
 * or fail an otherwise-successful publish. A network failure rejects, as it
 * always has; the Publish handler catches it.
 */
export async function pingIndexNow(origin: string, urls: string[]): Promise<boolean> {
  const key = indexNowKey();
  if (!key || urls.length === 0) return false;

  return (await postIndexNow(origin, key, urls)).ok;
}
