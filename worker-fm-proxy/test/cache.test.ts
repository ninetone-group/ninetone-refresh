import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

// Cache API layer in front of FM. Node has no `caches` global, so every test
// installs a Map-backed fake and removes it in `finally` — security.test.ts
// keeps covering the "no Cache API → resolve through FM every time" path.

// CACHE_STATE mirrors the site's KV: the current Publish epoch is "7", so
// `?v=7` is the one buster the proxy honours (security audit 2026-09-14).
const env = {
  FM_HOST: "files.ninetone.com",
  FM_DB: "Ninetone Group AB",
  FM_USER: "user",
  FM_PASS: "pass",
  CACHE_STATE: { get: async (key: string) => (key === "cache-version" ? "7" : null) },
};

const IMAGE_BYTES = [1, 2, 3];

/**
 * Mimics caches.default closely enough to matter: put() consumes the body
 * (so a stream that errors mid-way rejects the put, like the real thing) and
 * match() hands back a fresh Response each time, so a stored entry can be
 * served more than once.
 */
function fakeCache() {
  const store = new Map<string, { bytes: Uint8Array; headers: Headers; status: number }>();
  const puts: string[] = [];
  const cache = {
    async match(key: Request) {
      const entry = store.get(key.url);
      if (!entry) return undefined;
      return new Response(entry.bytes.slice(), { status: entry.status, headers: new Headers(entry.headers) });
    },
    async put(key: Request, res: Response) {
      puts.push(key.url);
      const bytes = new Uint8Array(await res.arrayBuffer());
      store.set(key.url, { bytes, headers: new Headers(res.headers), status: res.status });
    },
  };
  return { cache, store, puts };
}

function installCaches(cache: unknown) {
  (globalThis as { caches?: unknown }).caches = { default: cache };
  return () => {
    delete (globalThis as { caches?: unknown }).caches;
  };
}

/** Collects waitUntil promises so a test can await the background cache.put. */
function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } }, settle: () => Promise.all(pending) };
}

function request(path: string, origin?: string) {
  return new Request(`https://proxy.example${path}`, { headers: origin ? { Origin: origin } : {} });
}

/** fetch stub answering the FM session, the artist/release finds, and the streaming URL. */
function fmFetch(opts: { record?: unknown; imageStatus?: number; body?: BodyInit | null } = {}) {
  const calls: string[] = [];
  const impl = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/sessions")) return Response.json({ response: { token: "test-token" } });
    if (url.includes("/_find")) {
      const record = opts.record === undefined
        ? {
            fieldData: { artistPicture_big: "https://files.ninetone.com/Streaming_SSL/image" },
            portalData: {
              "Green Web Category": [
                {
                  "Green Web Category::Album": "Debut",
                  "Green Web Category::coverPicture_webp": "https://files.ninetone.com/Streaming_SSL/cover",
                  "Green Web Category::Releasedate First": "1/2/2024",
                },
              ],
            },
          }
        : opts.record;
      return Response.json({ response: { data: record === null ? [] : [record] } });
    }
    if (url.includes("/Streaming_SSL/")) {
      return new Response(opts.body === undefined ? new Uint8Array(IMAGE_BYTES) : opts.body, {
        status: opts.imageStatus ?? 200,
        headers: { "Content-Type": "image/webp" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { impl: impl as typeof fetch, calls };
}

test("first request misses, streams from FM and stores under the canonical key (pathname + v only)", async () => {
  const originalFetch = globalThis.fetch;
  const { impl, calls } = fmFetch();
  globalThis.fetch = impl;
  const { cache, puts } = fakeCache();
  const restore = installCaches(cache);
  const { ctx, settle } = fakeCtx();
  try {
    const res = await worker.fetch(request("/artist/safe/big?v=7&junk=1"), env, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-fm-status"), "miss");
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=86400, s-maxage=21600");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], IMAGE_BYTES);
    await settle();
    assert.deepEqual(puts, ["https://proxy.example/artist/safe/big?v=7"]);
    assert.ok(calls.some((u) => u.includes("/Streaming_SSL/")), "resolved through FM on a miss");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("second request is a hit: no FM calls, same bytes, CORS reflects THIS request's origin", async () => {
  const originalFetch = globalThis.fetch;
  const { impl, calls } = fmFetch();
  globalThis.fetch = impl;
  const { cache } = fakeCache();
  const restore = installCaches(cache);
  const { ctx, settle } = fakeCtx();
  try {
    const first = await worker.fetch(request("/artist/safe/big?v=7", "https://ninetone.com"), env, ctx);
    assert.equal(first.headers.get("Access-Control-Allow-Origin"), "https://ninetone.com");
    const firstBytes = [...new Uint8Array(await first.arrayBuffer())];
    await settle();
    const callsAfterMiss = calls.length;

    const second = await worker.fetch(request("/artist/safe/big?v=7&other=1", "https://www.ninetone.com"), env, ctx);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-fm-status"), "hit");
    assert.equal(second.headers.get("Access-Control-Allow-Origin"), "https://www.ninetone.com");
    assert.equal(second.headers.get("Content-Type"), "image/webp");
    assert.equal(second.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], firstBytes);
    assert.equal(calls.length, callsAfterMiss, "a hit must not touch FM");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("never stores errors: 404 (no record) and 502 (upstream failure) leave the cache empty", async () => {
  const originalFetch = globalThis.fetch;
  const { cache, puts } = fakeCache();
  const restore = installCaches(cache);
  const { ctx, settle } = fakeCtx();
  try {
    globalThis.fetch = fmFetch({ record: null }).impl;
    const notFound = await worker.fetch(request("/artist/missing/big?v=7"), env, ctx);
    assert.equal(notFound.status, 404);

    globalThis.fetch = fmFetch({ imageStatus: 500 }).impl;
    const upstreamFail = await worker.fetch(request("/artist/safe/big?v=7"), env, ctx);
    assert.equal(upstreamFail.status, 502);

    await settle();
    assert.deepEqual(puts, []);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("only the current epoch is a buster: ?v=8 (not the epoch) collapses onto the bare key, ?v=7 does not", async () => {
  const originalFetch = globalThis.fetch;
  const { impl, calls } = fmFetch();
  globalThis.fetch = impl;
  const { cache, puts } = fakeCache();
  const restore = installCaches(cache);
  const { ctx, settle } = fakeCtx();
  try {
    const bare = await worker.fetch(request("/artist/safe/big"), env, ctx);
    assert.equal(bare.status, 200);
    await settle();
    const wrongEpoch = await worker.fetch(request("/artist/safe/big?v=8"), env, ctx);
    assert.equal(wrongEpoch.headers.get("x-fm-status"), "hit", "a foreign v must not mint a key or an FM read");
    const junk = await worker.fetch(request("/artist/safe/big?v=../../etc"), env, ctx);
    assert.equal(junk.headers.get("x-fm-status"), "hit");
    const epoch = await worker.fetch(request("/artist/safe/big?v=7"), env, ctx);
    assert.equal(epoch.headers.get("x-fm-status"), "miss", "the real epoch is still a deliberate buster");
    await settle();
    assert.deepEqual(puts, ["https://proxy.example/artist/safe/big", "https://proxy.example/artist/safe/big?v=7"]);
    assert.equal(calls.filter((u) => u.includes("/_find")).length, 2);
  } finally {
    restore();
    globalThis.fetch = originalFetch;
  }
});

test("without a CACHE_STATE binding no v is ever honoured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fmFetch().impl;
  const { cache, puts } = fakeCache();
  const restore = installCaches(cache);
  const { ctx, settle } = fakeCtx();
  try {
    const { CACHE_STATE: _omit, ...noKv } = env;
    await worker.fetch(request("/artist/safe/big?v=7"), noKv, ctx);
    await settle();
    assert.deepEqual(puts, ["https://proxy.example/artist/safe/big"]);
  } finally {
    restore();
    globalThis.fetch = originalFetch;
  }
});

test("surplus path segments are a 404 before the cache or FM: /artist/safe/big/extra never resolves", async () => {
  const originalFetch = globalThis.fetch;
  const { impl, calls } = fmFetch();
  globalThis.fetch = impl;
  const { cache, puts } = fakeCache();
  const restore = installCaches(cache);
  const { ctx, settle } = fakeCtx();
  try {
    for (const path of ["/artist/safe/big/extra?v=7", "/artist/safe/big/", "/release/safe/by-album/Debut/more", "/release/safe/0/x", "/healthz/x", "/artist/safe", "/artist//safe/big", "//artist/safe/big"]) {
      const res = await worker.fetch(request(path), env, ctx);
      assert.equal(res.status, 404, path);
    }
    await settle();
    assert.deepEqual(puts, []);
    assert.equal(calls.length, 0, "no FM session, find or stream for a malformed path");
  } finally {
    restore();
    globalThis.fetch = originalFetch;
  }
});

test("cache misses are metered per client IP: over budget → 429, limiter failure → 503, hits are never metered", async () => {
  const originalFetch = globalThis.fetch;
  const { impl, calls } = fmFetch();
  globalThis.fetch = impl;
  const { cache } = fakeCache();
  const restore = installCaches(cache);
  const { ctx, settle } = fakeCtx();
  try {
    const seen: string[] = [];
    let allow = true;
    const limited = { ...env, IMAGE_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { seen.push(key); return { success: allow }; } } };
    const withIp = (path: string) => new Request(`https://proxy.example${path}`, { headers: { "cf-connecting-ip": "203.0.113.9" } });

    const miss = await worker.fetch(withIp("/artist/safe/big"), limited, ctx);
    assert.equal(miss.status, 200);
    await settle();
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0], "203.0.113.9", "the IP is hashed, never used raw as a key");

    const hit = await worker.fetch(withIp("/artist/safe/big"), limited, ctx);
    assert.equal(hit.headers.get("x-fm-status"), "hit");
    assert.equal(seen.length, 1, "a hit does not touch the limiter");

    allow = false;
    const over = await worker.fetch(withIp("/artist/other/big"), limited, ctx);
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("Retry-After"), "60");
    const findsBefore = calls.filter((u) => u.includes("/_find")).length;
    assert.equal(findsBefore, 1, "a limited miss never reaches FM");

    const broken = { ...env, IMAGE_RATE_LIMITER: { limit: async () => { throw new Error("binding down"); } } };
    const unavailable = await worker.fetch(withIp("/artist/third/big"), broken, ctx);
    assert.equal(unavailable.status, 503, "fail closed when the limiter itself fails");
  } finally {
    restore();
    globalThis.fetch = originalFetch;
  }
});

test("release covers are cached too, and /healthz is never looked up or stored", async () => {
  const originalFetch = globalThis.fetch;
  const { impl } = fmFetch();
  globalThis.fetch = impl;
  const { cache, puts } = fakeCache();
  let matches = 0;
  const counting = { ...cache, match: async (key: Request) => { matches++; return cache.match(key); } };
  const restore = installCaches(counting);
  const { ctx, settle } = fakeCtx();
  try {
    const cover = await worker.fetch(request("/release/safe/by-album/Debut?v=7"), env, ctx);
    assert.equal(cover.status, 200);
    await settle();
    assert.deepEqual(puts, ["https://proxy.example/release/safe/by-album/Debut?v=7"]);
    const hit = await worker.fetch(request("/release/safe/by-album/Debut?v=7"), env, ctx);
    assert.equal(hit.headers.get("x-fm-status"), "hit");

    const matchesBeforeHealth = matches;
    const health = await worker.fetch(request("/healthz?v=7"), env, ctx);
    assert.equal(health.status, 200);
    await settle();
    assert.equal(matches, matchesBeforeHealth, "/healthz must not consult the cache");
    assert.equal(puts.length, 1, "/healthz must not be stored");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("a put that fails (body over the size cap mid-stream) is logged, not thrown, and nothing is stored", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  // No Content-Length, so the header check passes and capStream errors the
  // tee'd stream once 15 MiB have gone by — that rejects the cache.put.
  const big = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      for (let i = 0; i < 16; i++) controller.enqueue(big);
      controller.close();
    },
  });
  globalThis.fetch = fmFetch({ body }).impl;
  const { cache, store } = fakeCache();
  const restore = installCaches(cache);
  const { ctx, settle } = fakeCtx();
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const res = await worker.fetch(request("/artist/safe/big?v=7"), env, ctx);
    assert.equal(res.status, 200);
    await assert.rejects(res.arrayBuffer(), /size cap/);
    await settle();
    assert.equal(store.size, 0);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /cache\.put failed/);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("without a caches global the worker still serves images straight from FM", async () => {
  const originalFetch = globalThis.fetch;
  const { impl, calls } = fmFetch();
  globalThis.fetch = impl;
  assert.equal(typeof (globalThis as { caches?: unknown }).caches, "undefined");
  try {
    const a = await worker.fetch(request("/artist/safe/big?v=7"), env);
    const b = await worker.fetch(request("/artist/safe/big?v=7"), env);
    assert.equal(a.headers.get("x-fm-status"), "miss");
    assert.equal(b.headers.get("x-fm-status"), "miss");
    assert.equal(calls.filter((u) => u.includes("/Streaming_SSL/")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
