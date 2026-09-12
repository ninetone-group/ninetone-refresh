/**
 * Worker entrypoint — adds `scheduled`, `queue` and the publication Durable
 * Object alongside Astro's `fetch`.
 *
 * WHY A CUSTOM ENTRYPOINT AT ALL. wrangler.jsonc's `main` pointed straight at
 * `@astrojs/cloudflare/entrypoints/server`, which exports only `{ fetch }`.
 * A Cron Trigger, a Queue consumer and a Durable Object all need their own
 * exports on the same Worker, and there is nowhere to put them in the
 * adapter's own module.
 *
 * HOW THIS ACTUALLY GETS BUILT (verified, not assumed). `main` is NOT read by
 * wrangler at deploy time: `.wrangler/deploy/config.json` redirects every
 * `wrangler deploy` to the GENERATED `dist/server/wrangler.json`, whose `main`
 * is `entry.mjs`. `main` here is a Vite build input — @cloudflare/vite-plugin
 * resolves it as `virtual:cloudflare/user-entry` and emits
 * `export * from <user entry>; export default mod.default ?? {}`. Two
 * consequences that this file depends on:
 *   1. A TypeScript source path works, and the adapter's
 *      `virtual:astro-cloudflare:config` import resolves, because Vite (not
 *      wrangler's esbuild) does the bundling.
 *   2. NAMED exports survive, which is how the Durable Object class below
 *      reaches the runtime.
 *
 * THE ONE RULE HERE: `fetch` must remain EXACTLY the adapter's handler. Every
 * page, API route, redirect, and the whole tiered edge cache in
 * src/middleware.ts depend on it. This file re-exports it untouched rather
 * than wrapping it, so visitor behaviour cannot regress through this change —
 * if the publication handlers were deleted tomorrow, serving would be
 * byte-identical.
 *
 * ROLLOUT POSTURE. `publicationMode()` returns "shadow" unless
 * PUBLICATION_SERVING is exactly "on", and a missing or misspelled variable
 * must never switch the site's content source. In shadow, discovery and
 * translation run and releases are PREPARED and STORED, but nothing is
 * promoted and rendering still uses `fmText()`. Deploying this file with no
 * new vars changes no response.
 *
 * ALL LOGIC LIVES IN src/lib/publication/orchestrate.ts, injected. This file
 * only resolves bindings and calls in. Logic written inline here could only be
 * exercised by deploying.
 */

declare const __BUILD_ID__: string;

import astro from "@astrojs/cloudflare/entrypoints/server";
// Static, matching the adapter's own handler (which imports `env` from here).
// The Durable Object base class must be available at module evaluation time
// because the class below is declared at module scope.
import { DurableObject } from "cloudflare:workers";

import { callCoordinator, makeCoordinatorClass } from "./lib/publication/coordinator-do.ts";
import { consumeJob, runTick } from "./lib/publication/orchestrate.ts";
import { publicationMode } from "./lib/publication/serving.ts";
import type { SnapshotBoundJob } from "./lib/publication/snapshot.ts";
import { loadSourceRecords } from "./lib/publication/fm-source.ts";

/** Bindings the publication handlers use. All optional: absence disables them. */
interface PublicationEnv {
  readonly CACHE_STATE?: KvBindingLike;
  readonly PUBLICATION_STATE?: KvBindingLike;
  readonly PUBLICATION_RELEASES?: KvBindingLike;
  readonly TRANSLATION_JOBS?: { send(body: unknown): Promise<void>; sendBatch?(messages: readonly { body: unknown }[]): Promise<void> };
  readonly PUBLICATION_COORDINATOR?: unknown;
  readonly PUBLICATION_SERVING?: string;
  /** Exactly "off" disables the cron tick without a config change — the only
   *  way to stop the every-minute FM polling other than editing wrangler.jsonc
   *  and redeploying. Anything else (absent, "on", typos) leaves it running. */
  readonly PUBLICATION_TICK?: string;
  readonly ANTHROPIC_API_KEY?: string;
}

/** Is the scheduled tick switched off by the PUBLICATION_TICK var? */
export function tickDisabled(env: { readonly PUBLICATION_TICK?: unknown }): boolean {
  return env.PUBLICATION_TICK === "off";
}

interface KvBindingLike {
  get(key: string, opts?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface QueueMessageLike<T> {
  readonly body: T;
  ack(): void;
  retry(): void;
}

interface QueueBatchLike<T> {
  readonly messages: readonly QueueMessageLike<T>[];
}

/**
 * SHA-256 hex, matching translate.ts's own (un-exported) `sha256Hex`.
 *
 * Duplicated rather than imported for the same reason translate.ts duplicates
 * it from http.ts: six lines beats coupling this entrypoint's import graph to
 * a module documented as dependency-free.
 */
async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * State store for discovery and snapshots.
 *
 * Prefers the dedicated `ninetone-publication-state` namespace and falls back
 * to CACHE_STATE so the handlers still work before that namespace exists. The
 * key prefixes (`pub:v1:`) do not collide with the translation cache (`tr:v1:`).
 */
function stateStore(env: PublicationEnv): KvBindingLike | null {
  return env.PUBLICATION_STATE ?? env.CACHE_STATE ?? null;
}

export default {
  /**
   * Astro's handler, re-exported verbatim. Do not wrap: see the file comment.
   */
  fetch: astro.fetch,

  /**
   * Cron Trigger — one full publication tick.
   *
   * Discovers FM edits, freezes snapshots, enqueues translation work, applies
   * the scan through the coordinator, and ASSEMBLES + STORES a release from
   * whatever is ready. All of that runs in shadow and changes no response;
   * only promotion is gated on PUBLICATION_SERVING.
   *
   * Assembly deliberately runs here rather than being deferred: a tick that
   * only discovered and translated would leave nothing to validate against
   * live output, which is exactly the gap that blocked the first deployment.
   */
  async scheduled(
    _event: { cron: string; scheduledTime: number },
    env: PublicationEnv,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    // Kill switch (2026-09-12 review, D1): a dashboard var flip stops the
    // every-minute FM polling immediately, without touching the bindings.
    if (tickDisabled(env)) {
      console.log("[publication] scheduled: PUBLICATION_TICK=off; skipping");
      return;
    }
    const store = stateStore(env);
    if (!store) {
      console.log("[publication] scheduled: no state binding; skipping");
      return;
    }
    const releases = env.PUBLICATION_RELEASES ?? store;
    const cache = env.CACHE_STATE;
    if (!cache) {
      console.log("[publication] scheduled: no translation cache binding; skipping");
      return;
    }

    // Gated on BINDINGS, not on PUBLICATION_SERVING. Preparation must run in
    // shadow — gating it on the flag would mean flipping serving on against a
    // cold, unprepared release.
    ctx.waitUntil(
      (async () => {
        try {
          const [nine, { translationKey, lookupOverride }] = await Promise.all([
            import("./lib/ninetone.ts"),
            import("./lib/translate.ts"),
          ]);

          // The coordinator serializes scan application and promotion. Absent
          // binding -> null, and runTick() then skips ordering rather than
          // silently applying unserialized state.
          const namespace = env.PUBLICATION_COORDINATOR as
            | Parameters<typeof callCoordinator>[0]
            | undefined;
          const coordinator = namespace
            ? {
                read: () => callCoordinator<{ revision: number }>(namespace, { op: "read" }),
                applyScan: (scan: never) =>
                  callCoordinator<{ applied: boolean; state: { revision: number } }>(namespace, {
                    op: "applyScan",
                    scan,
                  }),
                approve: (args: {
                  basedOnRevision: number;
                  generation: string;
                  digest: string;
                }) => callCoordinator<{ promoted: boolean }>(namespace, { op: "approve", ...args }),
              }
            : null;

          const result = await runTick({
            discovery: { store, hash: sha256Hex, loadRecords: async () => [] },
            snapshots: { store, hash: sha256Hex },
            load: {
              getters: {
                getArtists: nine.getArtists,
                getPreviousArtists: nine.getPreviousArtists,
                getClients: nine.getClients,
                getBookingRoster: nine.getBookingRoster,
                getTeam: nine.getTeam,
                getNews: nine.getNews,
                getBookingCategories: nine.getBookingCategories,
                getWebPosts: nine.getWebPosts,
              } as Parameters<typeof loadSourceRecords>[0]["getters"],
              hash: sha256Hex,
            },
            queue: env.TRANSLATION_JOBS ?? null,
            env: env as unknown as Record<string, unknown>,
            keyVersion: "v1",
            release: { store: releases },
            readbackCache: { get: (key: string) => cache.get(key) },
            keyFor: (source: string, target: string, tier: string) =>
              translationKey(source, target as "sv" | "en", tier as "fast" | "quality"),
            // Overrides must reach the RELEASE, not only rendering — otherwise a
            // human correction fixes the page while the bundle still ships the
            // bad machine output. Hashed on the source, same as translate().
            overrideFor: async (source: string, target: "sv" | "en") =>
              lookupOverride(await sha256Hex(source), target),
            buildId: typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "unknown",
            now: () => Date.now(),
            coordinator: coordinator as never,
            log: (message, detail) => console.log(message, detail ?? ""),
          });

          console.log(
            "[publication] tick",
            JSON.stringify({
              mode: result.mode,
              scanned: result.discovery.scanned,
              changed: result.discovery.changed,
              enqueued: result.discovery.enqueued,
              ready: result.discovery.reconciled.readyIds.size,
              coordinatorApplied: result.coordinatorApplied,
              generation: result.assembled?.generation ?? null,
              stored: result.assembled?.stored ?? false,
              published: result.assembled?.published ?? 0,
              withheld: result.assembled?.withheld.length ?? 0,
              promoted: result.promoted,
              inventoryComplete: result.discovery.inventoryComplete,
              failures: result.discovery.failures,
            }),
          );
        } catch (error) {
          console.error("[publication] tick failed", error);
        }
      })(),
    );
  },

  /**
   * Queue consumer — translation jobs.
   *
   * Retry is reserved for the genuinely transient case (an unreadable
   * snapshot). A job whose own bounded retries are exhausted is ACKed rather
   * than retried: telling the queue to retry would multiply four internal
   * attempts by the queue's own retry count for a single field.
   */
  async queue(batch: QueueBatchLike<SnapshotBoundJob>, env: PublicationEnv): Promise<void> {
    const store = stateStore(env);
    const cache = env.CACHE_STATE;

    if (!store || !cache) {
      // Without bindings nothing can be processed OR safely dropped.
      for (const message of batch.messages) message.retry();
      return;
    }

    const [{ translationKey, callWithGuard, buildProtectedTerms }] = await Promise.all([
      import("./lib/translate.ts"),
    ]);

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("[publication] queue: no ANTHROPIC_API_KEY; retrying batch");
      for (const message of batch.messages) message.retry();
      return;
    }

    const consumer = {
      cache: {
        get: (key: string) => cache.get(key),
        put: (key: string, value: string) => cache.put(key, value),
      },
      keyFor: (source: string, target: string, tier: string) =>
        translationKey(source, target as "sv" | "en", tier as "fast" | "quality"),
      translateFn: async ({
        text,
        target,
        tier,
        kind,
        protect,
      }: {
        text: string;
        target: string;
        tier: string;
        kind: string;
        protect: readonly string[];
      }) =>
        callWithGuard(
          apiKey,
          text,
          target as "sv" | "en",
          tier as "fast" | "quality",
          kind as "plain" | "markdown" | "title",
          await buildProtectedTerms(protect),
        ),
    };

    for (const message of batch.messages) {
      try {
        const disposition = await consumeJob(
          {
            consumer: consumer as never,
            snapshots: { store },
            discovery: { store, hash: sha256Hex, loadRecords: async () => [] },
            keyVersion: "v1",
            log: (m, d) => console.log(m, d ?? ""),
          },
          message.body,
        );

        if (disposition.action === "retry") message.retry();
        else message.ack();
      } catch (error) {
        console.error("[publication] queue message failed", error);
        // An unexpected throw is not the same as a translation failure: it may
        // well be transient (a binding hiccup), so let the queue retry it.
        message.retry();
      }
    }
  },
};

/**
 * The publication coordinator Durable Object.
 *
 * Exported by NAME because that is how the runtime finds a DO class, and the
 * Cloudflare Vite plugin's generated entry does `export * from <user entry>`,
 * so this survives the build. `DurableObject` is imported here (not in the
 * coordinator module) so that module stays loadable under `node --test`.
 */
export const NinetonePublicationCoordinator = makeCoordinatorClass(
  DurableObject as unknown as new (...args: never[]) => object,
);

/** Re-exported so operational tooling can read the flag the same way. */
export { publicationMode };
