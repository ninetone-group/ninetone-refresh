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
function readEnv(name: string): string | undefined {
  const meta = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const baked = meta?.[name];
  if (typeof baked === "string" && baked) return baked;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

export function indexNowKey(): string | undefined {
  return readEnv("INDEXNOW_KEY");
}

/**
 * Notify IndexNow that `urls` changed. `origin` must be a bare origin (see
 * src/lib/site.ts `siteOrigin()`) — `host` is derived from it, and every
 * entry in `urlList` must share that host per the IndexNow spec.
 *
 * Returns `false` (never throws) when `INDEXNOW_KEY` is unset or `urls` is
 * empty — there is nothing to ping, and callers (the Publish handler) must
 * never let this block or fail an otherwise-successful publish.
 */
export async function pingIndexNow(origin: string, urls: string[]): Promise<boolean> {
  const key = indexNowKey();
  if (!key || urls.length === 0) return false;

  const host = new URL(origin).host;
  const body = {
    host,
    key,
    keyLocation: `${origin}/${key}.txt`,
    urlList: urls,
  };

  const res = await fetch("https://api.indexnow.org/IndexNow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.ok;
}
