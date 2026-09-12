/**
 * `NinetonePublicationCoordinator` — the Durable Object that serializes
 * publication state.
 *
 * WHY A DURABLE OBJECT AT ALL. `KvCoordinator` is documented as NOT safe under
 * concurrency: KV has no compare-and-set, so two callers can interleave
 * read-modify-write. The revision check turns that from silent corruption into
 * a detectable conflict, but a conflict it can only mostly catch. Promotion is
 * the operation that genuinely cannot tolerate a race — two concurrent
 * promotions can otherwise overwrite each other's pointer — and the earlier
 * checkpoints deferred closing that to here.
 *
 * A Durable Object gives single-threaded execution per object id. With one
 * fixed id (`SINGLETON_NAME`) every scan application and every promotion for
 * this site runs in a global queue of one, so `applyScan`'s revision check
 * becomes genuinely sufficient rather than best-effort.
 *
 * THE PURE LOGIC STAYS PURE. This class holds no rules of its own: it calls
 * `applyScan`, `approveGeneration` and `commitRemovals` from coordinator.ts,
 * which are total functions over plain data and fully unit-tested without any
 * Cloudflare runtime. The DO's only job is to make read-modify-write atomic
 * around them. That split is what lets the hard ordering rules be tested with
 * `node --test` and no miniflare.
 *
 * STATE LIVES IN DO STORAGE, NOT KV. The whole point is a single authoritative
 * copy; keeping it in KV would reintroduce the eventual consistency this class
 * exists to escape. `pub:v1:coordinator` in KV remains the KvCoordinator's key
 * and is not read here.
 *
 * NO `cloudflare:workers` IMPORT AT MODULE SCOPE. `DurableObject` is passed in
 * by the entrypoint rather than imported here, so this module stays loadable
 * under plain `node --test` (importing `cloudflare:workers` outside workerd
 * throws). See `makeCoordinatorClass`.
 */

import {
  EMPTY_STATE,
  applyScan,
  approveGeneration,
  commitRemovals,
  servingPlan,
  type ApplyResult,
  type CoordinatorState,
  type PromotionOutcome,
  type ScanApplication,
} from "./coordinator.ts";

/**
 * The single object id every caller uses.
 *
 * One site, one coordinator: sharding would defeat serialization, which is the
 * only reason this object exists.
 */
export const SINGLETON_NAME = "publication";

/** Key the state is stored under inside the DO's own storage. */
export const DO_STATE_KEY = "state";

/** Minimal view of DO storage, so the logic can be tested with a plain fake. */
export interface DurableStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/**
 * The coordinator's behaviour, independent of the Durable Object base class.
 *
 * Extracted so every rule is testable against a fake storage with no workerd,
 * no miniflare and no bindings — the same discipline the rest of this flow
 * follows. The DO class below is a thin shell over this.
 */
export class CoordinatorCore {
  private readonly storage: DurableStorageLike;

  constructor(storage: DurableStorageLike) {
    this.storage = storage;
  }

  async read(): Promise<CoordinatorState> {
    const stored = await this.storage.get<CoordinatorState>(DO_STATE_KEY);
    return stored ?? EMPTY_STATE;
  }

  private async write(state: CoordinatorState): Promise<void> {
    await this.storage.put(DO_STATE_KEY, state);
  }

  /** Apply a scan. Serialized by the DO, so the revision check is authoritative. */
  async applyScan(scan: ScanApplication): Promise<ApplyResult> {
    const result = applyScan(await this.read(), scan);
    if (result.applied) await this.write(result.state);
    return result;
  }

  /** Approve a generation for serving. The operation a race would corrupt. */
  async approve(args: {
    basedOnRevision: number;
    generation: string;
    digest: string;
  }): Promise<PromotionOutcome> {
    const result = approveGeneration(await this.read(), args);
    if (result.promoted) await this.write(result.state);
    return result;
  }

  /** Clear withdrawals once a removal generation has actually been committed. */
  async commitRemovals(refs: readonly string[]): Promise<CoordinatorState> {
    const next = commitRemovals(await this.read(), refs);
    await this.write(next);
    return next;
  }

  /** What should be served right now, plus the fallback chain. */
  async servingPlan(): Promise<{ current: string | null; fallbacks: readonly string[] }> {
    return servingPlan(await this.read());
  }
}

/** RPC surface the Worker calls over. Kept tiny and JSON-shaped. */
export type CoordinatorRequest =
  | { readonly op: "read" }
  | { readonly op: "servingPlan" }
  | { readonly op: "applyScan"; readonly scan: ScanApplication }
  | {
      readonly op: "approve";
      readonly basedOnRevision: number;
      readonly generation: string;
      readonly digest: string;
    }
  | { readonly op: "commitRemovals"; readonly refs: readonly string[] };

/**
 * Dispatch one request against the core.
 *
 * Separate from the DO class so the full RPC surface is testable directly.
 */
export async function handleCoordinatorRequest(
  core: CoordinatorCore,
  request: CoordinatorRequest,
): Promise<unknown> {
  switch (request.op) {
    case "read":
      return core.read();
    case "servingPlan":
      return core.servingPlan();
    case "applyScan":
      return core.applyScan(request.scan);
    case "approve":
      return core.approve({
        basedOnRevision: request.basedOnRevision,
        generation: request.generation,
        digest: request.digest,
      });
    case "commitRemovals":
      return core.commitRemovals(request.refs);
    default: {
      // Exhaustiveness: an unhandled op is a programming error, not input.
      const never: never = request;
      throw new Error(`unknown coordinator op: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Build the Durable Object class.
 *
 * Takes the `DurableObject` base from `cloudflare:workers` as an argument
 * rather than importing it, because that module only exists inside workerd —
 * a module-scope import would make this file unloadable under `node --test`
 * and take the whole publication test suite with it.
 */
export function makeCoordinatorClass(DurableObjectBase: new (...args: never[]) => object): {
  new (state: { storage: DurableStorageLike }, env: unknown): {
    fetch(request: Request): Promise<Response>;
  };
} {
  // @ts-expect-error — the base class is supplied at runtime by the entrypoint.
  return class NinetonePublicationCoordinator extends DurableObjectBase {
    private readonly core: CoordinatorCore;

    constructor(state: { storage: DurableStorageLike }, env: unknown) {
      // @ts-expect-error — forwarded verbatim to the runtime base class.
      super(state, env);
      this.core = new CoordinatorCore(state.storage);
    }

    async fetch(request: Request): Promise<Response> {
      let body: CoordinatorRequest;
      try {
        body = (await request.json()) as CoordinatorRequest;
      } catch {
        return new Response(JSON.stringify({ error: "invalid-json" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      try {
        const result = await handleCoordinatorRequest(this.core, body);
        return new Response(JSON.stringify(result ?? null), {
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    }
  };
}

/** Client-side view of the DO binding. */
export interface CoordinatorStub {
  fetch(input: string, init?: { method?: string; body?: string }): Promise<{ json(): Promise<unknown> }>;
}

export interface CoordinatorNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): CoordinatorStub;
}

/**
 * Call the coordinator from the Worker.
 *
 * The URL is irrelevant to a Durable Object (it is addressed by id, not by
 * host), but `fetch` requires a well-formed one.
 */
export async function callCoordinator<T>(
  namespace: CoordinatorNamespace,
  request: CoordinatorRequest,
): Promise<T> {
  const stub = namespace.get(namespace.idFromName(SINGLETON_NAME));
  const response = await stub.fetch("https://publication.internal/rpc", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return (await response.json()) as T;
}
