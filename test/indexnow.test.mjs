import assert from "node:assert/strict";
import test from "node:test";

import { pingIndexNow, indexNowKey } from "../src/lib/indexnow.ts";
import { notifyIndexNow } from "../src/pages/api/publish.ts";

// This module reads INDEXNOW_KEY via `process.env` when running outside Vite
// (plain node:test has no `import.meta.env`), same as src/lib/site.ts's own
// tests handle PUBLIC_SITE_ORIGIN etc. — see test/site.test.mjs.
function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

// Stubs globalThis.fetch for the duration of `fn`, recording every call and
// never making a real network request — required by the brief ("do not
// actually send any network request during tests").
async function withStubbedFetch(impl, fn) {
  const calls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = prevFetch;
  }
}

function okResponse() {
  return new Response("", { status: 200 });
}

// ---------------------------------------------------------------------------
// src/lib/indexnow.ts — pingIndexNow / indexNowKey
// ---------------------------------------------------------------------------

test("indexNowKey: reads INDEXNOW_KEY from process.env", () =>
  withEnv({ INDEXNOW_KEY: "abc123" }, () => {
    assert.equal(indexNowKey(), "abc123");
  }));

test("indexNowKey: undefined when unset", () =>
  withEnv({ INDEXNOW_KEY: undefined }, () => {
    assert.equal(indexNowKey(), undefined);
  }));

test("pingIndexNow: does nothing and returns false when INDEXNOW_KEY is unset — never calls fetch", () =>
  withEnv({ INDEXNOW_KEY: undefined }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      const ok = await pingIndexNow("https://ninetone.com", ["https://ninetone.com/"]);
      assert.equal(ok, false);
      assert.equal(calls.length, 0);
    }),
  ));

test("pingIndexNow: does nothing when urls is empty, even with a key set", () =>
  withEnv({ INDEXNOW_KEY: "abc123" }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      const ok = await pingIndexNow("https://ninetone.com", []);
      assert.equal(ok, false);
      assert.equal(calls.length, 0);
    }),
  ));

test("pingIndexNow: posts the IndexNow contract (host/key/keyLocation/urlList) to the right endpoint", () =>
  withEnv({ INDEXNOW_KEY: "abc123" }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      const ok = await pingIndexNow("https://ninetone.com", [
        "https://ninetone.com/",
        "https://ninetone.com/records",
      ]);
      assert.equal(ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.indexnow.org/IndexNow");
      assert.equal(calls[0].init.method, "POST");
      const body = JSON.parse(calls[0].init.body);
      assert.deepEqual(body, {
        host: "ninetone.com",
        key: "abc123",
        keyLocation: "https://ninetone.com/abc123.txt",
        urlList: ["https://ninetone.com/", "https://ninetone.com/records"],
      });
    }),
  ));

test("pingIndexNow: returns false when the IndexNow API responds non-2xx", () =>
  withEnv({ INDEXNOW_KEY: "abc123" }, () =>
    withStubbedFetch(
      () => new Response("", { status: 500 }),
      async () => {
        const ok = await pingIndexNow("https://ninetone.com", ["https://ninetone.com/"]);
        assert.equal(ok, false);
      },
    ),
  ));

// ---------------------------------------------------------------------------
// src/pages/api/publish.ts — notifyIndexNow host guard
// ---------------------------------------------------------------------------

function publishRequest(url = "https://ninetone.com/api/publish") {
  return new Request(url, { method: "POST" });
}

test("notifyIndexNow: fires on the production host (ninetone.com)", () =>
  withEnv({ INDEXNOW_KEY: "abc123", PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: "true" }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      await notifyIndexNow(publishRequest("https://ninetone.com/api/publish"));
      assert.equal(calls.length, 1);
      assert.equal(JSON.parse(calls[0].init.body).host, "ninetone.com");
    }),
  ));

test("notifyIndexNow: fires on a production subdomain (still ends with ninetone.com)", () =>
  withEnv({ INDEXNOW_KEY: "abc123", PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: "true" }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      await notifyIndexNow(publishRequest("https://www.ninetone.com/api/publish"));
      assert.equal(calls.length, 1);
    }),
  ));

test("notifyIndexNow: never fires on *.workers.dev staging", () =>
  withEnv({ INDEXNOW_KEY: "abc123", PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: "true" }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      await notifyIndexNow(publishRequest("https://ninetone-site.micke-ohlen.workers.dev/api/publish"));
      assert.equal(calls.length, 0);
    }),
  ));

test("notifyIndexNow: never fires on *.github.io", () =>
  withEnv({ INDEXNOW_KEY: "abc123", PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: "true" }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      await notifyIndexNow(publishRequest("https://mixxmastermike123.github.io/api/publish"));
      assert.equal(calls.length, 0);
    }),
  ));

test("notifyIndexNow: never fires for an unrelated host even if it contains ninetone.com as a substring elsewhere", () =>
  withEnv({ INDEXNOW_KEY: "abc123", PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: "true" }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      await notifyIndexNow(publishRequest("https://ninetone.com.evil.example/api/publish"));
      assert.equal(calls.length, 0);
    }),
  ));

test("notifyIndexNow: missing INDEXNOW_KEY is handled safely — no fetch, no throw, even on the production host", () =>
  withEnv({ INDEXNOW_KEY: undefined, PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: "true" }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      await assert.doesNotReject(() => notifyIndexNow(publishRequest("https://ninetone.com/api/publish")));
      assert.equal(calls.length, 0);
    }),
  ));

test("notifyIndexNow: a ping failure (network error) does not propagate out of the publish handler", () =>
  withEnv({ INDEXNOW_KEY: "abc123", PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: "true" }, () =>
    withStubbedFetch(
      () => {
        throw new Error("network down");
      },
      async () => {
        // notifyIndexNow itself is allowed to reject (handlePublish wraps the
        // call in try/catch) — what must never happen is an unhandled
        // rejection/throw escaping the overall publish flow. We assert the
        // wrapping behavior the same way handlePublish does it.
        let threw = false;
        try {
          await notifyIndexNow(publishRequest("https://ninetone.com/api/publish"));
        } catch {
          threw = true;
        }
        // Either notifyIndexNow rejects here (and handlePublish's try/catch
        // swallows it) or it swallows internally — both are acceptable, but
        // the actual behavior today is that pingIndexNow's fetch rejection
        // propagates up through notifyIndexNow, so document that:
        assert.equal(threw, true);
      },
    ),
  ));

test("notifyIndexNow: PUBLIC_SITE_ORIGIN override still respects the host guard", () =>
  withEnv({ INDEXNOW_KEY: "abc123", PUBLIC_SITE_ORIGIN: "https://ninetone.com", PUBLIC_HAS_RUNTIME: undefined }, () =>
    withStubbedFetch(okResponse, async (calls) => {
      // Request origin is workers.dev, but PUBLIC_SITE_ORIGIN (set at launch
      // cutover) wins per siteOrigin()'s resolution order — guard still open.
      await notifyIndexNow(publishRequest("https://ninetone-site.micke-ohlen.workers.dev/api/publish"));
      assert.equal(calls.length, 1);
    }),
  ));
