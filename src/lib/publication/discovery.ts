/**
 * Discovery and job state — checkpoint 2 of
 * docs/translation-publication-implementation-handoff.md, reworked after
 * docs/publication-checkpoints-1-2-review.md found six counterexamples in the
 * first version. Each is reproduced as a test in
 * test/publication-review-regressions.test.mjs.
 *
 * Everything external is injected (`loadRecords`, `store`, `hash`), so the
 * scan/dedupe/supersede/removal logic is testable locally with no network, no
 * bindings, and no translation spend. The Worker layer is a thin adapter.
 *
 * THE CENTRAL CHANGE FROM THE REVIEW: job progress is no longer a mutable
 * shared JSON object.
 *
 * The first version stored one `completed` map per candidate and had every job
 * completion read-modify-write it. That loses updates — two locales finishing
 * concurrently left 1 of 2 flags even against an immediately consistent
 * in-memory store — and Cloudflare KV separately caps writes to ONE PER SECOND
 * PER KEY, so a hot candidate would also have produced 429s. Verified against
 * the official write-key-value-pairs documentation.
 *
 * Completions are now IMMUTABLE PER-JOB RECORDS at their own keys. Writing one
 * never touches another, so concurrent completions cannot collide, a
 * redelivery rewrites an identical value, and candidate state is DERIVED by
 * reading them back (`reconcile`) rather than mutated in place. That also
 * makes a duplicate scan harmless: there is no progress field left to reset.
 *
 * WHAT THIS STILL DOES NOT PROMISE. A scan sees FileMaker at one instant.
 * Nothing in the Data API marks several saves as one finished editorial
 * transaction, so grouping works only through explicit references on a record;
 * saves made after a candidate publishes are a subsequent update. The design
 * asks for that limitation to be stated rather than implied away.
 */

import type { KvLike } from "../cache.ts";
import {
  type Candidate,
  type SourceRecord,
  type TranslationJob,
  isSuperseded,
  jobId,
  jobsForRecord,
} from "./contracts.ts";

/** Where discovery state lives. Prefixed so it is greppable alongside `tr:v1:`. */
export const STATE_PREFIX = "pub:v1:";

/**
 * Cloudflare KV rejects `expirationTtl` below 60 seconds.
 *
 * The first version released the scan lock with `expirationTtl: 1`, which
 * would have thrown in production while passing against a fake that did not
 * model the limit. Exported so tests can assert against the real constraint
 * rather than a guess.
 */
export const MIN_KV_EXPIRATION_TTL_SECONDS = 60;

export const stateKeys = {
  /** Newest hash seen for an entity — the supersession reference point. */
  newestHash: (kind: string, id: string) => `${STATE_PREFIX}newest:${kind}:${id}`,
  /** Candidate metadata for one source version. Written ONCE, never updated. */
  candidate: (kind: string, id: string, hash: string) => `${STATE_PREFIX}cand:${kind}:${id}:${hash}`,
  /** One immutable completion record per job. Its existence IS the progress. */
  completion: (jobIdValue: string) => `${STATE_PREFIX}done:${jobIdValue}`,
  /** Authoritative inventory of entity ids seen by the last COMPLETE scan. */
  inventory: () => `${STATE_PREFIX}inventory`,
  scanLock: () => `${STATE_PREFIX}scan-lock`,
  removal: (kind: string, id: string) => `${STATE_PREFIX}remove:${kind}:${id}`,
};

/** Kind-qualified identity. The review found bare ids compared against `kind:id` references. */
export function entityRef(kind: string, id: string): string {
  return id.includes(":") ? id : `${kind}:${id}`;
}

export interface DiscoveryResult {
  readonly changed: readonly SourceRecord[];
  readonly removed: readonly { kind: string; id: string }[];
  readonly unchanged: number;
  readonly jobs: readonly TranslationJob[];
  /**
   * Whether this scan saw a complete view of FM, carried from the discover()
   * call so persistDiscovery() cannot forget it. A caller that had to repeat
   * the flag would eventually pass it to one and not the other, and the
   * failure mode of that mistake is either "never detect deletions" or
   * "withdraw the whole site from a partial read".
   */
  readonly inventoryComplete: boolean;
  /** Entity refs seen by this scan; persisted as the inventory when complete. */
  readonly seen: readonly string[];
}

export interface DiscoveryDeps {
  readonly store: KvLike & { delete?: (key: string) => Promise<void> };
  readonly hash: (input: string) => Promise<string>;
  readonly loadRecords: () => Promise<readonly SourceRecord[]>;
  readonly now?: () => number;
}

export interface DiscoverOptions {
  /**
   * Did `loadRecords` return a COMPLETE view of FileMaker?
   *
   * Defaults to false, deliberately. Membership-based removal is the one
   * operation where a partial read is catastrophic: a truncated or failed FM
   * response would otherwise look like every record was deleted and withdraw
   * the whole site. The caller must affirmatively state that the scan
   * succeeded in full before disappearance is treated as deletion.
   */
  readonly inventoryComplete?: boolean;
}

export const SCAN_LOCK_TTL_SECONDS = 300;

/**
 * Advisory scan lock.
 *
 * KV has no atomic compare-and-set, so two scanners starting in the same
 * instant can both proceed. That is tolerable HERE and nowhere else: discovery
 * is idempotent — the same hashes produce the same candidates and job ids, and
 * completions are immutable — so a double scan wastes work rather than
 * corrupting state. Promotion genuinely cannot tolerate a race, which is why
 * the design puts it behind a Durable Object. When the coordinator exists it
 * should own discovery serialization too and this advisory lock should go.
 */
export async function acquireScanLock(deps: DiscoveryDeps, holder: string): Promise<boolean> {
  const key = stateKeys.scanLock();
  if (await deps.store.get(key)) return false;
  await deps.store.put(key, holder, { expirationTtl: SCAN_LOCK_TTL_SECONDS });
  return true;
}

export async function releaseScanLock(deps: DiscoveryDeps, holder: string): Promise<void> {
  const key = stateKeys.scanLock();
  const existing = await deps.store.get(key);
  // Only the holder clears it: a scanner whose lock already expired must not
  // clear a lock a different scanner has since taken. Deleting rather than
  // writing a short TTL — KV rejects expirationTtl below 60, so the previous
  // `expirationTtl: 1` would have thrown in production.
  if (existing !== holder) return;
  if (deps.store.delete) await deps.store.delete(key);
  else await deps.store.put(key, "", { expirationTtl: MIN_KV_EXPIRATION_TTL_SECONDS });
}

/**
 * Compare current FM state with persisted state.
 *
 * A record is outstanding when its hash is new OR when its candidate is
 * missing. That second clause is the crash-recovery fix: the first version
 * skipped a record whenever the hash matched, so a crash between writing the
 * newest hash and writing the candidate left a version with no candidate and
 * no jobs, permanently. Reconciling candidate EXISTENCE on every scan — rather
 * than trusting the hash alone — closes that window from either write order.
 */

/**
 * Read many independent keys with bounded parallelism.
 *
 * WHY THIS EXISTS, MEASURED. A full scan of the real corpus (557 records) issues
 * 6,686 KV operations, of which `discover()` and `reconcile()` contribute 3,343
 * point reads. Executed sequentially against remote KV (~5ms each) that is ~33s
 * of pure I/O, and the scheduled invocation was killed part-way through: in
 * production the candidate and newest-hash keys were written for all 557
 * records but NOT ONE snapshot, because execution never reached them.
 *
 * Local tests never caught it — a Map-backed fake answers in microseconds, so
 * the same scan completes in 39ms. The cost only exists against a real binding.
 *
 * These reads are genuinely independent (one key per record), so issuing them
 * in bounded batches changes no semantics whatsoever — same keys, same values,
 * same order of the results array. The bound matters: an unbounded fan-out of
 * thousands of concurrent subrequests is its own failure mode.
 */
export const KV_READ_CONCURRENCY = 24;

export async function runBounded<T>(
  items: readonly T[],
  task: (item: T, index: number) => Promise<void>,
  concurrency: number = KV_READ_CONCURRENCY,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await task(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

export async function readMany(
  store: Pick<KvLike, "get">,
  keys: readonly string[],
  concurrency: number = KV_READ_CONCURRENCY,
): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(keys.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= keys.length) return;
      out[index] = await store.get(keys[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()),
  );
  return out;
}

export async function discover(
  deps: DiscoveryDeps,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const records = await deps.loadRecords();
  const changed: SourceRecord[] = [];
  const removed: { kind: string; id: string }[] = [];
  const jobs: TranslationJob[] = [];
  let unchanged = 0;

  const seen = new Set<string>();

  // Batched, not sequential: see readMany()'s comment for the measurement that
  // forced this. Semantics are identical — the same two keys per active record.
  const active = records.filter((r) => r.active);
  const previousHashes = await readMany(
    deps.store,
    active.map((r) => stateKeys.newestHash(r.kind, r.id)),
  );
  const candidateBlobs = await readMany(
    deps.store,
    active.map((r) => stateKeys.candidate(r.kind, r.id, r.hash)),
  );
  const previousByRef = new Map<string, string | null>();
  const candidateByRef = new Map<string, string | null>();
  active.forEach((r, i) => {
    const ref = entityRef(r.kind, r.id);
    previousByRef.set(ref, previousHashes[i]);
    candidateByRef.set(ref, candidateBlobs[i]);
  });

  for (const record of records) {
    const ref = entityRef(record.kind, record.id);
    seen.add(ref);

    if (!record.active) {
      removed.push({ kind: record.kind, id: record.id });
      continue;
    }

    const previous = previousByRef.get(ref) ?? null;
    const candidateExists = Boolean(candidateByRef.get(ref));

    if (previous === record.hash && candidateExists) {
      unchanged += 1;
      continue;
    }

    changed.push(record);
    jobs.push(...jobsForRecord(record));
  }

  // Membership-based removal: an entity in the last complete inventory that is
  // absent now has been deleted in FM. Gated on inventoryComplete because a
  // partial read must never be read as mass deletion.
  if (options.inventoryComplete) {
    const raw = await deps.store.get(stateKeys.inventory());
    const previousInventory: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    for (const ref of previousInventory) {
      if (seen.has(ref)) continue;
      const [kind, ...rest] = ref.split(":");
      removed.push({ kind, id: rest.join(":") });
    }
  }

  return {
    changed,
    removed,
    unchanged,
    jobs,
    inventoryComplete: options.inventoryComplete === true,
    seen: [...seen],
  };
}

/**
 * Persist a scan.
 *
 * Candidate metadata is written ONCE per source version and never rewritten,
 * so re-running this for an identical scan cannot discard progress — the first
 * version reset `completed` to `{}` and threw away finished translation work.
 * Progress now lives in separate immutable completion keys that this function
 * does not touch at all.
 */
export async function persistDiscovery(
  deps: DiscoveryDeps,
  result: DiscoveryResult,
  keyVersion: string,
): Promise<void> {
  // Bounded-parallel, not sequential. Per-record writes are independent; see
  // readMany()'s comment for the production failure sequential I/O caused.
  // Candidate writes stay write-once (the get-then-put is per record, and two
  // workers never touch the same record), so immutability is unaffected.
  await runBounded(result.changed, async (record) => {
    const key = stateKeys.candidate(record.kind, record.id, record.hash);
    if (!(await deps.store.get(key))) {
      const candidate: Omit<Candidate, "completed" | "state"> & { state: Candidate["state"] } = {
        entityKind: record.kind,
        entityId: record.id,
        sourceHash: record.hash,
        state: "preparing",
        requiredJobIds: jobsForRecord(record).map((job) => jobId(job, keyVersion)),
      };
      await deps.store.put(key, JSON.stringify(candidate));
    }
    await deps.store.put(stateKeys.newestHash(record.kind, record.id), record.hash);

    // A record that came back must not stay marked for removal.
    const removalKey = stateKeys.removal(record.kind, record.id);
    if (await deps.store.get(removalKey)) {
      if (deps.store.delete) await deps.store.delete(removalKey);
      else await deps.store.put(removalKey, "");
    }
  });

  await runBounded(result.removed, async (entry) => {
    await deps.store.put(
      stateKeys.removal(entry.kind, entry.id),
      JSON.stringify({ ...entry, at: (deps.now ?? Date.now)() }),
    );
  });

  // Only a COMPLETE scan may rewrite the inventory. Persisting a partial
  // view would make the next scan read the missing records as deletions.
  if (result.inventoryComplete) {
    const removedRefs = new Set(result.removed.map((r) => entityRef(r.kind, r.id)));
    const inventory = result.seen.filter((ref) => !removedRefs.has(ref));
    await deps.store.put(stateKeys.inventory(), JSON.stringify(inventory));
  }
}

/**
 * Record one completed job as an IMMUTABLE key of its own.
 *
 * Writing this never touches another job's key, so concurrent completions
 * cannot overwrite each other and a redelivery simply rewrites an identical
 * value. Returns false when the completion is stale — an older queue message
 * finishing after a newer edit — which the design requires be refused rather
 * than merged.
 */
export async function recordJobCompletion(
  deps: DiscoveryDeps,
  job: TranslationJob,
  keyVersion: string,
): Promise<boolean> {
  const candidateKey = stateKeys.candidate(job.entityKind, job.entityId, job.sourceHash);
  if (!(await deps.store.get(candidateKey))) return false;

  const newest = await deps.store.get(stateKeys.newestHash(job.entityKind, job.entityId));
  if (newest !== null && newest !== job.sourceHash) return false;

  const id = jobId(job, keyVersion);
  await deps.store.put(
    stateKeys.completion(id),
    JSON.stringify({ at: (deps.now ?? Date.now)(), sourceHash: job.sourceHash }),
  );
  return true;
}

export interface ReconciledState {
  /** Candidates with their completion state derived from immutable records. */
  readonly candidates: readonly Candidate[];
  /** Jobs with no completion record — safe to (re-)enqueue at any time. */
  readonly jobs: readonly TranslationJob[];
  /** Entity ids whose candidate is complete and current. */
  readonly readyIds: ReadonlySet<string>;
  readonly removals: readonly { kind: string; id: string }[];
}

/**
 * Rebuild authoritative state by reading completion records back.
 *
 * This is what makes recovery work from any crash point: outstanding jobs are
 * derived from what is MISSING rather than from a progress field that may
 * never have been written. A crash after persisting a candidate but before
 * enqueueing leaves every job outstanding here, so re-enqueueing is always
 * safe and never double-counts.
 */
export async function reconcile(deps: DiscoveryDeps, keyVersion: string): Promise<ReconciledState> {
  const records = await deps.loadRecords();
  const candidates: Candidate[] = [];
  const jobs: TranslationJob[] = [];
  const readyIds = new Set<string>();
  const removals: { kind: string; id: string }[] = [];

  // PREFETCH, BATCHED. reconcile() was the single largest source of sequential
  // KV reads at real scale — 2,228 of a scan's 6,686 operations, because it
  // reads one completion key per job (two locales per field per record). Those
  // reads are independent, so batching them changes nothing but wall time.
  // See readMany()'s comment for the production failure this fixes.
  const active = records.filter((r) => r.active);
  const newestList = await readMany(
    deps.store,
    active.map((r) => stateKeys.newestHash(r.kind, r.id)),
  );
  const removalList = await readMany(
    deps.store,
    active.map((r) => stateKeys.removal(r.kind, r.id)),
  );
  const newestByRef = new Map<string, string | null>();
  const removalByRef = new Map<string, string | null>();
  active.forEach((r, i) => {
    const ref = entityRef(r.kind, r.id);
    newestByRef.set(ref, newestList[i]);
    removalByRef.set(ref, removalList[i]);
  });

  const allJobIds: string[] = [];
  const jobsByRef = new Map<string, TranslationJob[]>();
  for (const record of active) {
    const recordJobs = jobsForRecord(record);
    jobsByRef.set(entityRef(record.kind, record.id), recordJobs);
    for (const job of recordJobs) allJobIds.push(jobId(job, keyVersion));
  }
  const completionList = await readMany(
    deps.store,
    allJobIds.map((id) => stateKeys.completion(id)),
  );
  const completionById = new Map<string, boolean>();
  allJobIds.forEach((id, i) => completionById.set(id, Boolean(completionList[i])));

  for (const record of records) {
    // An ACTIVE record is not removed, whatever a stale marker says. The
    // marker is cleared by persistDiscovery() when the record returns, but
    // reconcile() must not depend on that write having landed first — a
    // reactivated record that still carried a marker would otherwise stay
    // invisible until something happened to clear it.
    if (!record.active) {
      removals.push({ kind: record.kind, id: record.id });
      continue;
    }
    const ref = entityRef(record.kind, record.id);
    if (removalByRef.get(ref)) {
      // Marker present but the record is active again: treat it as live and
      // let the next persist clear the marker.
      if (deps.store.delete) await deps.store.delete(stateKeys.removal(record.kind, record.id));
    }

    const newest = newestByRef.get(ref) ?? null;
    const recordJobs = jobsByRef.get(ref) ?? jobsForRecord(record);
    const completed: Record<string, boolean> = {};

    for (const job of recordJobs) {
      const id = jobId(job, keyVersion);
      const done = completionById.get(id) ?? false;
      completed[id] = done;
      if (!done) jobs.push(job);
    }

    const requiredJobIds = recordJobs.map((job) => jobId(job, keyVersion));
    const candidate: Candidate = {
      entityKind: record.kind,
      entityId: record.id,
      sourceHash: record.hash,
      state: "preparing",
      requiredJobIds,
      completed,
    };

    const complete = requiredJobIds.every((id) => completed[id]);
    const stale = isSuperseded(candidate, newest ?? undefined);
    candidates.push({ ...candidate, state: stale ? "superseded" : complete ? "ready" : "preparing" });
    if (complete && !stale) readyIds.add(entityRef(record.kind, record.id));
  }

  return { candidates, jobs, readyIds, removals };
}

export function pendingReferences(record: SourceRecord, readyIds: ReadonlySet<string>): string[] {
  return record.references.filter((ref) => !readyIds.has(ref));
}

/**
 * Records that can go into the next release.
 *
 * Follows references in BOTH directions. The first version followed them only
 * outward, so two unpublished posts referencing a ready artist left the artist
 * publishing alone — exactly the premature appearance the acceptance scenario
 * forbids. A record is publishable only when every member of its reference
 * group, in either direction, is also publishable.
 *
 * Iterates to a fixed point: dropping one record can strand another that
 * referenced it, transitively.
 *
 * Identities are kind-qualified throughout (`entityRef`), because the review
 * found bare ids being compared against `kind:id` references.
 */
export function selectPublishable(
  records: readonly SourceRecord[],
  readyIds: ReadonlySet<string>,
): SourceRecord[] {
  const refOf = (r: SourceRecord) => entityRef(r.kind, r.id);

  // Undirected adjacency: a reference in either direction binds the two.
  const neighbours = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const record of records) {
    const from = refOf(record);
    for (const to of record.references) {
      add(from, to);
      add(to, from);
    }
  }

  let included = records.filter((r) => r.active && readyIds.has(refOf(r)));

  for (;;) {
    const present = new Set(included.map(refOf));
    const next = included.filter((r) => {
      const linked = neighbours.get(refOf(r));
      if (!linked) return true;
      for (const other of linked) {
        // A linked record must be in this release. If it is not a known record
        // at all, it cannot be satisfied and the group waits.
        if (!present.has(other)) return false;
      }
      return true;
    });
    if (next.length === included.length) return next;
    included = next;
  }
}
