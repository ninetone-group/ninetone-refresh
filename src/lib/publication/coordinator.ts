/**
 * Publication coordinator — the serialization point for ALL mutable
 * publication state, not only release promotion.
 *
 * Required by docs/publication-implementation-review-2026-09-12.md, which
 * showed that immutable per-job completion records were not sufficient: the
 * remaining mutable writes (`newestHash`, the inventory, removal markers, and
 * the current-generation pointer) can still be regressed by a delayed scan or
 * a concurrent promotion.
 *
 * THE DEFECT THIS EXISTS TO FIX, reproduced before it was written:
 *
 *   discover v1; discover v2 before persisting either; persist v2, then let
 *   the delayed v1 scan persist -> stored newestHash becomes v1.
 *
 * An immediately consistent store is enough to produce that; eventual
 * consistency is not required. The advisory lock does not help, because both
 * scans were legal when they started and the damage happens at apply time.
 *
 * THE MECHANISM: every state application carries a monotonically increasing
 * REVISION, and the coordinator refuses to apply a revision older than the one
 * already recorded. Ordering is therefore decided by what the coordinator has
 * already accepted, not by which write happens to arrive last. That is the
 * "keep the authoritative revision in strongly consistent storage" requirement
 * — a Durable Object provides exactly this, and this module is written so the
 * DO is a thin adapter over it rather than the place the logic lives.
 *
 * WHY NOT JUST A LOCK: a lock makes writes mutually exclusive but does not
 * make them ordered. Scan v1 could take the lock after scan v2 released it and
 * still write stale data. Revisions order; locks only exclude.
 */

import type { KvLike } from "../cache.ts";

export interface CoordinatorState {
  /** Highest applied revision. Monotonic; never decreases. */
  readonly revision: number;
  /** entityRef -> newest known source hash. */
  readonly newestHashes: Readonly<Record<string, string>>;
  /** entityRefs present in the last complete scan. */
  readonly inventory: readonly string[];
  /**
   * Withdrawals awaiting publication, as a durable outbox.
   *
   * The review found that a removal observed by one scan disappeared from the
   * next: `persistDiscovery` dropped the entity from the inventory, so the
   * following scan saw nothing missing and re-emitted nothing. A marker
   * existed but nothing replayed it. These entries persist until a removal
   * generation is actually committed.
   */
  readonly pendingRemovals: readonly { readonly ref: string; readonly at: number }[];
  /** Generation currently approved for serving, with the digest it was validated at. */
  readonly current: { readonly generation: string; readonly digest: string } | null;
  /** Newest-first history of approved generations, for fallback and rollback. */
  readonly history: readonly { readonly generation: string; readonly digest: string }[];
}

export const EMPTY_STATE: CoordinatorState = {
  revision: 0,
  newestHashes: {},
  inventory: [],
  pendingRemovals: [],
  current: null,
  history: [],
};

export const COORDINATOR_STATE_KEY = "pub:v1:coordinator";
export const RETAINED_GENERATIONS = 5;

export interface ScanApplication {
  /** Revision this scan was computed from. Rejected if older than the applied one. */
  readonly basedOnRevision: number;
  readonly newestHashes: Readonly<Record<string, string>>;
  /** Only written when the scan saw a complete view of FM. */
  readonly inventory?: readonly string[];
  readonly removals: readonly string[];
  /** Refs that came back; clears their pending removal. */
  readonly reactivated?: readonly string[];
}

export type ApplyResult =
  | { readonly applied: true; readonly state: CoordinatorState }
  | { readonly applied: false; readonly reason: "stale-revision"; readonly state: CoordinatorState };

/**
 * Apply a scan, refusing anything computed from an older revision.
 *
 * Pure: takes the current state and returns the next one, so ordering rules
 * are testable without a Durable Object or any store at all. The DO's job is
 * only to make read-modify-write atomic around this function.
 */
export function applyScan(state: CoordinatorState, scan: ScanApplication): ApplyResult {
  if (scan.basedOnRevision < state.revision) {
    return { applied: false, reason: "stale-revision", state };
  }

  const newestHashes = { ...state.newestHashes, ...scan.newestHashes };

  const pending = new Map(state.pendingRemovals.map((r) => [r.ref, r]));
  for (const ref of scan.removals) {
    if (!pending.has(ref)) pending.set(ref, { ref, at: state.revision + 1 });
  }
  // A record that came back must not stay queued for withdrawal.
  for (const ref of scan.reactivated ?? []) pending.delete(ref);

  return {
    applied: true,
    state: {
      ...state,
      revision: state.revision + 1,
      newestHashes,
      inventory: scan.inventory ?? state.inventory,
      pendingRemovals: [...pending.values()],
    },
  };
}

/**
 * Mark a withdrawal as published, removing it from the outbox.
 *
 * Separate from `applyScan` deliberately: the outbox entry must survive until
 * the removal is COMMITTED, not merely observed. That is what makes a crash
 * between discovery and publication recoverable — the next pass still sees the
 * pending removal and can replay it.
 */
export function commitRemovals(state: CoordinatorState, refs: readonly string[]): CoordinatorState {
  const done = new Set(refs);
  return {
    ...state,
    revision: state.revision + 1,
    pendingRemovals: state.pendingRemovals.filter((r) => !done.has(r.ref)),
    inventory: state.inventory.filter((ref) => !done.has(ref)),
  };
}

export type PromotionOutcome =
  | { readonly promoted: true; readonly state: CoordinatorState }
  | {
      readonly promoted: false;
      readonly reason: "stale-revision" | "digest-mismatch" | "duplicate-generation";
      readonly state: CoordinatorState;
    };

/**
 * Approve a generation for serving.
 *
 * Binds to a CONTENT DIGEST, not just a generation id. The review showed
 * promotion validating the caller's object while a different, invalid bundle
 * sat at the same generation key — promotion returned true and visitors would
 * have been served the invalid one. The digest is computed from the stored
 * artifact by the caller and recorded here, so "approved" names an exact
 * artifact rather than a string.
 *
 * Also refuses to reuse a generation id that has already been approved with a
 * different digest, which is what makes the immutability claim real rather
 * than merely commented.
 */
export function approveGeneration(
  state: CoordinatorState,
  args: { readonly basedOnRevision: number; readonly generation: string; readonly digest: string },
): PromotionOutcome {
  if (args.basedOnRevision < state.revision) {
    return { promoted: false, reason: "stale-revision", state };
  }

  const previous = state.history.find((h) => h.generation === args.generation);
  if (previous && previous.digest !== args.digest) {
    return { promoted: false, reason: "duplicate-generation", state };
  }

  const entry = { generation: args.generation, digest: args.digest };
  const history = [entry, ...state.history.filter((h) => h.generation !== args.generation)];

  return {
    promoted: true,
    state: {
      ...state,
      revision: state.revision + 1,
      current: entry,
      history: history.slice(0, RETAINED_GENERATIONS),
    },
  };
}

/**
 * The generation a request should serve, plus every approved generation that
 * may still be reachable.
 *
 * `fallbacks` is what closes the cross-request navigation hole: a detail
 * request whose locally resolved generation lacks the entity may consult a
 * NEWER approved generation, so a link from a freshly published listing does
 * not 404 at an edge that has not caught up. Only approved generations are
 * consultable, so a withdrawn record cannot be resurrected through this path.
 */
export function servingPlan(state: CoordinatorState): {
  readonly current: string | null;
  readonly fallbacks: readonly string[];
} {
  return {
    current: state.current?.generation ?? null,
    fallbacks: state.history.map((h) => h.generation),
  };
}

/**
 * KV-backed coordinator, for local tests and as the shape the Durable Object
 * adapter implements.
 *
 * NOT SAFE UNDER CONCURRENCY ON ITS OWN, and deliberately named so. KV has no
 * compare-and-set, so two callers can still interleave read-modify-write here.
 * The revision check turns that from silent corruption into a detectable
 * conflict — a stale application is refused rather than applied — but genuine
 * mutual exclusion requires the Durable Object. Using this in production
 * without the DO would be relying on the revision check to catch what it can
 * only mostly catch.
 */
export class KvCoordinator {
  // Explicit field + plain assignment rather than a TS parameter property:
  // `node --experimental-strip-types` (this repo's test runner) rejects the
  // shorthand with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Same constraint
  // src/lib/translate.ts's RequestBudget already works around.
  private readonly store: KvLike;

  constructor(store: KvLike) {
    this.store = store;
  }

  async read(): Promise<CoordinatorState> {
    const raw = await this.store.get(COORDINATOR_STATE_KEY);
    if (!raw) return EMPTY_STATE;
    try {
      return JSON.parse(raw) as CoordinatorState;
    } catch {
      return EMPTY_STATE;
    }
  }

  async write(state: CoordinatorState): Promise<void> {
    await this.store.put(COORDINATOR_STATE_KEY, JSON.stringify(state));
  }

  async applyScan(scan: ScanApplication): Promise<ApplyResult> {
    const state = await this.read();
    const result = applyScan(state, scan);
    if (result.applied) await this.write(result.state);
    return result;
  }

  async approve(args: { basedOnRevision: number; generation: string; digest: string }): Promise<PromotionOutcome> {
    const state = await this.read();
    const result = approveGeneration(state, args);
    if (result.promoted) await this.write(result.state);
    return result;
  }

  async commitRemovals(refs: readonly string[]): Promise<CoordinatorState> {
    const next = commitRemovals(await this.read(), refs);
    await this.write(next);
    return next;
  }
}

/**
 * Content digest for a stored artifact.
 *
 * Deliberately over the exact serialized bytes the store holds, so a digest
 * mismatch means the artifact differs — not merely that some field was
 * reordered during a round trip.
 */
export async function digestOf(serialized: string): Promise<string> {
  const bytes = new TextEncoder().encode(serialized);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
