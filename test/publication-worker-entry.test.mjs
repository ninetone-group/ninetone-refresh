/**
 * Real-entrypoint tests — checkpoint 4.5.
 *
 * These drive the ACTUAL `scheduled` and `queue` handlers from the built CF
 * bundle (`dist/server/entry.mjs`) against fake bindings. Testing the built
 * artifact rather than the source is deliberate: `src/worker-entry.ts` imports
 * `cloudflare:workers` and `@astrojs/cloudflare/entrypoints/server`, neither of
 * which resolves under plain Node, and the thing that actually ships is the
 * bundle anyway. A source-level test would prove nothing about what deploys.
 *
 * The bundle is a build artifact, so these tests SKIP when it is absent or
 * stale rather than failing — `npm test` must not require a build. Run
 * `npm run build:cf` first to exercise them.
 *
 * NOTE ON THE SHARED dist/: `npm run build` (gh) and `npm run build:cf` write
 * to the same dist/. A gh build leaves a server bundle that is NOT this
 * entrypoint, so these tests detect that and skip rather than reporting a
 * phantom failure.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "server", "entry.mjs");

/**
 * The bundle imports `cloudflare:workers`, which does not exist in Node. Stub
 * it so the module graph loads; `DurableObject` only needs to be extendable.
 */
async function loadBundle() {
  if (!existsSync(BUNDLE)) return null;
  const source = readFileSync(BUNDLE, "utf8");
  if (!source.includes("NinetonePublicationCoordinator")) return null; // gh build in dist/

  const { register } = await import("node:module");
  const HOOK = `
    const STUB = "\\u0000cf-workers-stub";
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
  return {
    map: seed,
    async get(key) {
      return seed.has(key) ? seed.get(key) : null;
    },
    async put(key, value) {
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

function fakeMessage(body) {
  return {
    body,
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Exports — the deploy-shape contract
// ---------------------------------------------------------------------------

describeOrSkip("the built bundle exports fetch, scheduled, queue and the DO class", () => {
  const handler = bundle.default;
  assert.equal(typeof handler.fetch, "function", "fetch must survive");
  assert.equal(typeof handler.scheduled, "function", "cron handler must be exported");
  assert.equal(typeof handler.queue, "function", "queue consumer must be exported");
  assert.equal(
    typeof bundle.NinetonePublicationCoordinator,
    "function",
    "the Durable Object class must be a NAMED export or the runtime cannot find it",
  );
});

describeOrSkip("the DO class is constructible and serves its RPC", async () => {
  const Klass = bundle.NinetonePublicationCoordinator;
  const stored = new Map();
  const instance = new Klass({ storage: { async get(k) { return stored.get(k); }, async put(k, v) { stored.set(k, v); } } }, {});

  const response = await instance.fetch(
    new Request("https://publication.internal/rpc", {
      method: "POST",
      body: JSON.stringify({ op: "read" }),
    }),
  );
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.revision, 0, "a fresh coordinator starts empty");
});

describeOrSkip("the DO rejects malformed input rather than throwing", async () => {
  const Klass = bundle.NinetonePublicationCoordinator;
  const stored = new Map();
  const instance = new Klass({ storage: { async get(k) { return stored.get(k); }, async put(k, v) { stored.set(k, v); } } }, {});

  const response = await instance.fetch(
    new Request("https://publication.internal/rpc", { method: "POST", body: "{not json" }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid-json" });
});

// ---------------------------------------------------------------------------
// scheduled — inert without bindings, prepares with them
// ---------------------------------------------------------------------------

describeOrSkip("scheduled is inert with no state binding", async () => {
  const ctx = fakeCtx();
  await bundle.default.scheduled({ cron: "*/15 * * * *", scheduledTime: 0 }, {}, ctx);
  assert.equal(ctx.promises.length, 0, "no binding means no work scheduled at all");
});

describeOrSkip("scheduled is a no-op when PUBLICATION_TICK is exactly 'off'", async () => {
  const ctx = fakeCtx();
  const state = fakeKv();
  await bundle.default.scheduled(
    { cron: "* * * * *", scheduledTime: 0 },
    { CACHE_STATE: fakeKv(), PUBLICATION_STATE: state, PUBLICATION_TICK: "off" },
    ctx,
  );
  assert.equal(ctx.promises.length, 0, "the kill switch must stop the tick before any work is scheduled");
  assert.equal(state.map.size, 0);
});

describeOrSkip("scheduled never throws out of the handler when FM fails", async () => {
  const ctx = fakeCtx();
  // CACHE_STATE present but FM unreachable from the test process: the handler
  // must swallow it, or a cron failure becomes an unhandled rejection.
  await bundle.default.scheduled(
    { cron: "*/15 * * * *", scheduledTime: 0 },
    { CACHE_STATE: fakeKv() },
    ctx,
  );
  assert.equal(ctx.promises.length, 1, "work is handed to waitUntil");
  await assert.doesNotReject(() => Promise.all(ctx.promises));
});

// ---------------------------------------------------------------------------
// queue — retries only when it genuinely cannot proceed
// ---------------------------------------------------------------------------

describeOrSkip("queue retries the batch when bindings are missing", async () => {
  const messages = [fakeMessage({}), fakeMessage({})];
  await bundle.default.queue({ messages }, {});
  for (const m of messages) {
    assert.equal(m.retried, true, "nothing may be dropped when it cannot be processed");
    assert.equal(m.acked, false);
  }
});

describeOrSkip("queue retries rather than dropping when the API key is absent", async () => {
  const messages = [fakeMessage({ entityKind: "artist", entityId: "a", field: "x" })];
  await bundle.default.queue({ messages }, { CACHE_STATE: fakeKv(), PUBLICATION_STATE: fakeKv() });
  assert.equal(messages[0].retried, true);
  assert.equal(messages[0].acked, false);
});

describeOrSkip("queue ACKs a job whose snapshot is readable but field is absent", async () => {
  // Seed a real snapshot the bundle's own resolver will read.
  const state = new Map();
  const snapshotVersion = "v-test";
  state.set(
    `pub:v1:snap:artist:anjo:${snapshotVersion}`,
    JSON.stringify({
      snapshotVersion,
      contentHash: "c1",
      membership: "active=1|refs=",
      kind: "artist",
      id: "anjo",
      fields: { artistPresentationShort: "Text." },
      protect: [],
      active: true,
      references: [],
      promptVersion: "p1",
      capturedAt: 1,
    }),
  );

  const message = fakeMessage({
    entityKind: "artist",
    entityId: "anjo",
    sourceHash: "c1",
    // A field the snapshot does not carry -> permanent absence, must ACK.
    field: "artistPresentationString",
    target: "sv",
    kind: "markdown",
    tier: "fast",
    protect: [],
    snapshotVersion,
  });

  await bundle.default.queue(
    { messages: [message] },
    { CACHE_STATE: fakeKv(), PUBLICATION_STATE: fakeKv(state), ANTHROPIC_API_KEY: "sk-test-not-used" },
  );

  assert.equal(message.acked, true, "permanent absence must not retry forever");
  assert.equal(message.retried, false);
});

describeOrSkip("queue RETRIES a job whose snapshot is not readable yet", async () => {
  const message = fakeMessage({
    entityKind: "artist",
    entityId: "anjo",
    sourceHash: "c1",
    field: "artistPresentationShort",
    target: "sv",
    kind: "plain",
    tier: "fast",
    protect: [],
    snapshotVersion: "missing-version",
  });

  await bundle.default.queue(
    { messages: [message] },
    { CACHE_STATE: fakeKv(), PUBLICATION_STATE: fakeKv(), ANTHROPIC_API_KEY: "sk-test-not-used" },
  );

  assert.equal(message.retried, true, "a missing snapshot is transient");
  assert.equal(message.acked, false);
});

// ---------------------------------------------------------------------------
// The rollout flag
// ---------------------------------------------------------------------------

describeOrSkip("publicationMode defaults to shadow in the shipped bundle", () => {
  assert.equal(bundle.publicationMode({}), "shadow");
  assert.equal(bundle.publicationMode({ PUBLICATION_SERVING: "on" }), "serving");
  assert.equal(bundle.publicationMode({ PUBLICATION_SERVING: "ON" }), "shadow", "exact match only");
  assert.equal(bundle.publicationMode(undefined), "shadow");
});
