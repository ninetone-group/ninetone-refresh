/**
 * Real-entrypoint tests for the FM warm-up cron.
 *
 * These drive the ACTUAL `scheduled` handler from the built CF bundle
 * (`dist/server/entry.mjs`) with a stubbed `fetch` and a fake KV, and assert
 * that the keys the warm path WRITES are the keys the render path READS —
 * the whole point of the cron. Testing the built artifact rather than the
 * source is deliberate: `src/worker-entry.ts` imports `cloudflare:workers`
 * and `@astrojs/cloudflare/entrypoints/server`, neither of which resolves
 * under plain Node, and the thing that actually ships is the bundle anyway.
 *
 * The bundle is a build artifact, so these tests SKIP when it is absent or
 * stale rather than failing — `npm test` must not require a build. Run
 * `npm run build:cf` first to exercise them (CI does; see ci.yml).
 *
 * NOTE ON THE SHARED dist/: `npm run build` (gh) and `npm run build:cf` write
 * to the same dist/. A gh build leaves a server bundle that is NOT this
 * entrypoint, so these tests detect that and skip rather than reporting a
 * phantom failure. Self-contained on purpose (the loader is copied from
 * test/publication-worker-entry.test.mjs, not shared) so the two files can
 * evolve independently.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fmKvKey } from "../src/lib/fm-kv.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "server", "entry.mjs");

/**
 * The bundle imports `cloudflare:workers`, which does not exist in Node. Stub
 * it so the module graph loads. Its `env` is EMPTY here on purpose: the warm
 * path must reach KV through the binding `scheduled` receives, which is what
 * makes it testable at all.
 */
async function loadBundle() {
  if (!existsSync(BUNDLE)) return null;
  const source = readFileSync(BUNDLE, "utf8");
  if (!source.includes("NinetonePublicationCoordinator")) return null; // gh build in dist/

  const { register } = await import("node:module");
  const HOOK = `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") {
        return { url: "data:text/javascript," + encodeURIComponent(
          "export class DurableObject { constructor(state, env) { this.ctx = state; this.env = env; } }\\n" +
          "export class WorkerEntrypoint {}\\nexport class WorkflowEntrypoint {}\\nexport const env = {};"
        ), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `;
  register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

  try {
    return await import(`file://${BUNDLE}`);
  } catch {
    return null;
  }
}

const bundle = await loadBundle();
const describeOrSkip = bundle ? test : test.skip;

function fakeKv(seed = new Map()) {
  const puts = [];
  const gets = [];
  return {
    map: seed,
    puts,
    gets,
    async get(key, opts) {
      gets.push([key, opts]);
      return seed.has(key) ? seed.get(key) : null;
    },
    async put(key, value, opts) {
      puts.push([key, value, opts]);
      seed.set(key, value);
    },
    async delete(key) {
      seed.delete(key);
    },
  };
}

function fakeCtx() {
  const promises = [];
  return { promises, waitUntil: (p) => promises.push(p) };
}

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** FM (sessions + every `_find`) and Shopify, recorded. */
function stubFetch() {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (url.endsWith("/sessions")) return json({ response: { token: "tok" }, messages: [{ code: "0", message: "OK" }] });
    if (url.includes("/_find")) {
      return json({
        response: {
          data: [
            {
              fieldData: {
                SLUG: "safe",
                "Head Artist": "Safe",
                filterActive: "Active",
                artistPicture_small: "https://files.ninetone.com/Streaming_SSL/MainDB/x.jpg?RCType=EmbeddedRCFileProcessor",
              },
              recordId: "1",
            },
          ],
        },
        messages: [{ code: "0", message: "OK" }],
      });
    }
    if (url.includes("myshopify.com")) return json({ products: [] });
    return new Response(`not stubbed: ${url}`, { status: 500 });
  };
  return calls;
}

function warmEnv(extra = {}) {
  return {
    CACHE_STATE: fakeKv(new Map([["cache-version", "7"]])),
    FM_USER: "u",
    FM_PASS: "p",
    PUBLICATION_TICK: "off",
    ...extra,
  };
}

// filemaker.ts / shopify.ts read credentials from process.env under
// nodejs_compat; build:cf bakes nothing.
process.env.FM_USER = "u";
process.env.FM_PASS = "p";
process.env.SHOPIFY_ADMIN_TOKEN = "t";

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// The switches — checked FIRST so the in-memory cache the warm run fills
// below cannot mask a missing early return.
// ---------------------------------------------------------------------------

describeOrSkip("FM_WARM=off → zero fetches, nothing scheduled", async () => {
  const calls = stubFetch();
  const ctx = fakeCtx();
  await bundle.default.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, warmEnv({ FM_WARM: "off" }), ctx);
  assert.equal(ctx.promises.length, 0, "the kill switch must stop the warm-up before any work is scheduled");
  assert.equal(calls.length, 0);
});

describeOrSkip("no CACHE_STATE → nothing to warm, nothing scheduled", async () => {
  const calls = stubFetch();
  const ctx = fakeCtx();
  await bundle.default.scheduled(
    { cron: "*/5 * * * *", scheduledTime: Date.now() },
    { FM_USER: "u", FM_PASS: "p", PUBLICATION_TICK: "off" },
    ctx,
  );
  assert.equal(ctx.promises.length, 0);
  assert.equal(calls.length, 0);
});

describeOrSkip("the minute cron with PUBLICATION_TICK=off still does nothing (the publication branch keeps its own switch)", async () => {
  const calls = stubFetch();
  const ctx = fakeCtx();
  await bundle.default.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, warmEnv(), ctx);
  assert.equal(ctx.promises.length, 0);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The warm run
// ---------------------------------------------------------------------------

describeOrSkip("the warm cron runs every page find in refresh mode and writes the keys the render path reads", async () => {
  const calls = stubFetch();
  const ctx = fakeCtx();
  const env = warmEnv();
  const kv = env.CACHE_STATE;

  await bundle.default.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, env, ctx);
  assert.equal(ctx.promises.length, 1, "the work runs inside waitUntil");
  await assert.doesNotReject(() => Promise.all(ctx.promises));

  const finds = calls.filter((c) => c.url.includes("/_find") && c.method === "POST");
  assert.ok(finds.length >= 9, `expected the eight list getters + the homepage per-slug find, got ${finds.length}`);
  assert.equal(calls.filter((c) => c.url.endsWith("/sessions")).length, 1, "one FM session for the whole pass");

  // The homepage's per-slug find (artist of the week → API_ARTIST_DETAIL,
  // limit 1) — only reachable because the stubbed roster carries a SLUG and
  // an artistPicture_small, exactly what getArtistOfTheWeek() selects on.
  const detail = finds.find((c) => c.url.includes("/layouts/API_ARTIST_DETAIL/_find") && c.body?.limit === 1);
  assert.ok(detail, "the artist-of-the-week detail find must run");
  assert.deepEqual(detail.body.query, [{ filterActive: "==*", SLUG: "safe" }]);

  const shopify = calls.filter((c) => c.url.includes("myshopify.com"));
  assert.equal(shopify.length, 1, "one Shopify read");
  assert.match(shopify[0].url, /limit=10&status=active$/, "the homepage's limit, no collection when the var is unset");

  // Every write is under the current epoch — and under a prefix the render
  // path (fm-kv.ts / shopify.ts) actually reads.
  assert.ok(kv.puts.length >= 10, `expected ≥10 KV writes, got ${kv.puts.length}`);
  for (const [key, , opts] of kv.puts) {
    assert.ok(/^fm:v1:7:(f|p):/.test(key) || /^shopify:v1:7:/.test(key), `unexpected key ${key}`);
    if (key.startsWith("fm:")) assert.equal(opts.expirationTtl, 360, `${key} must carry the warm TTL`);
  }
  assert.ok(kv.puts.some(([key]) => key.startsWith("shopify:v1:7:products:")), "the Shopify list is warmed too");

  // The exact key /team's render computes — proves the warm path and the
  // render path agree on epoch, shape, layout and body hash.
  const teamKey = await fmKvKey(
    "7",
    "API_USERS",
    { query: [{ Active: "==Ja", SLUG: "*" }], sort: [{ fieldName: "sortOrder", sortOrder: "ascend" }], limit: 500 },
    false,
  );
  const team = kv.puts.find(([key]) => key === teamKey);
  assert.ok(team, "the warm path must write exactly the key the /team render reads");

  // The epoch flowed through the loader into the image URLs inside the entry.
  const teamRows = JSON.parse(team[1]);
  assert.equal(
    teamRows[0].artistPicture_small,
    "https://ninetone-fm-image-proxy.ninetone.workers.dev/team/safe/small?v=7",
    "image URLs inside a KV entry carry the same epoch as its key",
  );

  // Refresh mode: the entries themselves were never read, only the epoch.
  assert.ok(!kv.gets.some(([key]) => key.startsWith("fm:") || key.startsWith("shopify:")), "no read-before-write in refresh mode");
});

describeOrSkip("the nightly cron counts releases with ONE portal find and stores metrics:v1:releases", async () => {
  const calls = stubFetch();
  const P = "Green Web Category";
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/layouts/API_ARTIST_DETAIL/_find")) {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
      return json({ response: { data: [
        { fieldData: { SLUG: "a" }, portalData: { [P]: [{ [P + "::Album"]: "One" }, { [P + "::Album"]: "Two" }, { [P + "::Album"]: "Two" }] }, recordId: "1" },
        { fieldData: { SLUG: "b" }, portalData: { [P]: [{ [P + "::Album"]: "One" }, { [P + "::Album"]: "" }] }, recordId: "2" },
      ] }, messages: [{ code: "0", message: "OK" }] });
    }
    return original(input, init);
  };
  const env = warmEnv();
  const ctx = fakeCtx();
  await bundle.default.scheduled({ cron: "0 4 * * *", scheduledTime: Date.now() }, env, ctx);
  await Promise.all(ctx.promises);

  const finds = calls.filter((c) => c.url.includes("/_find"));
  assert.equal(finds.length, 1, "exactly one FM find");
  assert.deepEqual(finds[0].body.portal, [P]);
  assert.equal(finds[0].body.limit, 1000);
  const stored = env.CACHE_STATE.puts.filter(([key]) => key === "metrics:v1:releases");
  assert.equal(stored.length, 1);
  assert.equal(JSON.parse(stored[0][1]).count, 3, "distinct (artist, album) pairs");
  assert.ok(!env.CACHE_STATE.puts.some(([key]) => key.startsWith("fm:v1:")), "the 6 MB payload is not written into the FM read-through");
});

describeOrSkip("a failing FM find does not stop the other loaders or reject waitUntil", async () => {
  const calls = stubFetch();
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/layouts/API_NEWS/_find")) return new Response("<html>maintenance</html>", { status: 503 });
    return inner(input, init);
  };
  const ctx = fakeCtx();
  const env = warmEnv();
  await bundle.default.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, env, ctx);
  await assert.doesNotReject(() => Promise.all(ctx.promises));
  const layouts = new Set(calls.filter((c) => c.url.includes("/_find")).map((c) => c.url.match(/\/layouts\/([^/]+)\/_find/)[1]));
  assert.ok(layouts.has("API_USERS") && layouts.has("API_BOOKING_TAG"), "loaders after the failing one still ran");
  assert.ok(!env.CACHE_STATE.puts.some(([key]) => key.includes(":API_NEWS:")), "the failed layout wrote nothing");
});
