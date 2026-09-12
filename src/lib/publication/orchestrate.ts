/**
 * Orchestration — the sequence the Worker's `scheduled` and `queue` handlers
 * run, with every Cloudflare dependency injected.
 *
 * WHY NOT PUT THIS IN worker-entry.ts. Logic written directly inside a handler
 * can only be exercised by deploying, or by standing up miniflare. Everything
 * here is a function over injected dependencies, so the whole cron and consumer
 * sequence is unit-testable with `node --test` and fake bindings — the same
 * discipline the rest of this flow follows. `worker-entry.ts` stays a thin
 * adapter that resolves bindings and calls in here.
 *
 * SHADOW IS THE DEFAULT, AND PREPARATION IS NOT GATED ON IT. This is the
 * distinction that decides what the flag actually controls:
 *
 *   - discovery, snapshots, translation, release ASSEMBLY and storage all run
 *     in shadow. They change no response: a prepared release nothing serves
 *     from is inert.
 *   - only PROMOTION — making a generation the one serving answers come from —
 *     is gated on PUBLICATION_SERVING being exactly "on".
 *
 * Gating preparation on the flag would mean flipping serving on against a cold,
 * unprepared release, which is the opposite of what shadow mode is for.
 *
 * NOTHING HERE EVER READS LIVE FM FOR TEXT. Discovery reads FM to find what
 * changed and freezes it into a snapshot; from that point on, translation and
 * assembly read the snapshot. That is the invariant the whole design rests on.
 */

import {
  entityRef,
  persistDiscovery,
  recordJobCompletion,
  reconcile,
  runBounded,
  type DiscoveryDeps,
  type ReconciledState,
} from "./discovery.ts";
import { discover } from "./discovery.ts";
import type { SourceRecord } from "./contracts.ts";
import {
  jobsForSnapshot,
  resolveJobSource,
  writeSnapshot,
  type SnapshotBoundJob,
  type SnapshotDeps,
  type SourceSnapshot,
} from "./snapshot.ts";
import { processJob, type ConsumerDeps, type JobOutcome } from "./consumer.ts";
import { loadSourceRecords, PROMPT_VERSION, type LoadDeps, type LoadedRecords } from "./fm-source.ts";
import { readBackAll, publishableRecords, type ReadBackDeps } from "./readback.ts";
import { buildRelease, storeRelease, type ReleaseDeps } from "./release.ts";
import { validateRelease } from "./contracts.ts";
import { publicationMode, type PublicationMode } from "./serving.ts";

/** What one discovery run did. Returned for logging and for tests to assert on. */
export interface DiscoveryRunResult {
  /** Authoritative state derived from completion records. Drives assembly. */
  readonly reconciled: ReconciledState;
  /** Frozen snapshots for this scan, by kind-qualified ref. */
  readonly snapshotsByRef: ReadonlyMap<string, SourceSnapshot>;
  readonly mode: PublicationMode;
  readonly scanned: number;
  readonly changed: number;
  readonly removed: number;
  readonly unchanged: number;
  /** Jobs enqueued. Zero when nothing changed — the "no work at all" property. */
  readonly enqueued: number;
  readonly snapshots: number;
  /** False when any FM layout failed; removals are NOT trusted in that case. */
  readonly inventoryComplete: boolean;
  readonly failures: readonly string[];
}

export interface QueueProducerLike {
  send(message: unknown): Promise<void>;
  sendBatch?(messages: readonly { body: unknown }[]): Promise<void>;
}

export interface DiscoveryRunDeps {
  readonly discovery: DiscoveryDeps;
  readonly snapshots: SnapshotDeps;
  readonly load: LoadDeps;
  readonly queue: QueueProducerLike | null;
  readonly env: Readonly<Record<string, unknown>>;
  readonly keyVersion: string;
  readonly promptVersion?: string;
  readonly log?: (message: string, detail?: unknown) => void;
}

/**
 * One cron tick: read FM, detect change, freeze snapshots, enqueue work.
 *
 * ORDER MATTERS AND IS DELIBERATE. The snapshot is written BEFORE the job is
 * enqueued, so a job can never reference a snapshot that does not exist yet.
 * The reverse order would make `resolveJobSource` return `retry` for a message
 * that is in fact valid, burning queue retries on a self-inflicted race. A
 * crash between the two leaves an orphan snapshot, which is harmless: it is
 * write-once, keyed by content, and the next scan re-enqueues the job.
 */
export async function runDiscovery(deps: DiscoveryRunDeps): Promise<DiscoveryRunResult> {
  const mode = publicationMode(deps.env);
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;

  const loaded: LoadedRecords = await loadSourceRecords(deps.load);
  if (loaded.failures.length) {
    deps.log?.("[publication] FM layers failed; removals will not be trusted", loaded.failures);
  }

  // `inventoryComplete` is passed truthfully: false whenever ANY layout failed,
  // so a partial read can never be read as mass deletion.
  const result = await discover(
    { ...deps.discovery, loadRecords: async () => loaded.records },
    { inventoryComplete: loaded.complete },
  );

  await persistDiscovery(
    { ...deps.discovery, loadRecords: async () => loaded.records },
    result,
    deps.keyVersion,
  );

  // RECONCILE, THEN ENQUEUE FROM WHAT IS OUTSTANDING — not from `result.changed`.
  //
  // This is the crash-recovery property, and it is why the scan does not simply
  // enqueue what it just detected. `discover()` skips a record whose hash is
  // unchanged AND whose candidate exists, so if anything failed AFTER
  // persistDiscovery() — the queue was down, the isolate died mid-send — the
  // next scan would report `unchanged` and enqueue nothing, stranding that
  // record until someone edited it in FileMaker. Reproduced before fixing:
  // a throwing queue on scan 1 left scan 2 reporting `changed: 0, enqueued: 0`.
  //
  // `reconcile()` instead derives outstanding jobs from what is MISSING — it
  // reads completion records back and returns every job that has none. That is
  // recoverable from ANY crash point, and it makes re-enqueueing always safe
  // because completions are immutable and keyed by job id, so a redelivery
  // rewrites an identical value.
  const reconciled = await reconcile(
    { ...deps.discovery, loadRecords: async () => loaded.records },
    deps.keyVersion,
  );

  // Freeze a snapshot for every record with outstanding work, then enqueue from
  // the SNAPSHOT. Snapshots are write-once, so re-freezing an already-frozen
  // record is a no-op read rather than a rewrite.
  const outstandingByRef = new Map<string, SourceRecord>();
  for (const job of reconciled.jobs) {
    outstandingByRef.set(entityRef(job.entityKind, job.entityId), null as unknown as SourceRecord);
  }
  for (const record of loaded.records) {
    const ref = entityRef(record.kind, record.id);
    if (outstandingByRef.has(ref)) outstandingByRef.set(ref, record);
  }

  let enqueued = 0;
  const snapshots: SourceSnapshot[] = [];
  const queued: SnapshotBoundJob[] = [];

  // Index outstanding jobs once rather than re-scanning the list per record:
  // at real scale that inner filter was O(records x jobs).
  const outstandingFieldsByRef = new Map<string, Set<string>>();
  for (const job of reconciled.jobs) {
    const ref = entityRef(job.entityKind, job.entityId);
    let set = outstandingFieldsByRef.get(ref);
    if (!set) {
      set = new Set();
      outstandingFieldsByRef.set(ref, set);
    }
    set.add(`${job.field}:${job.target}`);
  }

  // Bounded-parallel: snapshot writes are independent and write-once.
  await runBounded([...outstandingByRef.entries()], async ([ref, record]) => {
    if (!record) return; // job for a record FM no longer returns; removal path handles it
    const protect = loaded.protectedNames[ref] ?? [];
    const snapshot = await writeSnapshot(deps.snapshots, record, { promptVersion, protect });
    snapshots.push(snapshot);

    // Only the jobs that are actually outstanding. Re-sending completed jobs
    // would be free (the consumer reads the cache first) but pointless traffic.
    const outstandingIds = outstandingFieldsByRef.get(ref) ?? new Set<string>();
    const jobs = jobsForSnapshot(snapshot).filter((j) =>
      outstandingIds.has(`${j.field}:${j.target}`),
    );
    if (jobs.length) queued.push(...jobs);
  });

  // Also snapshot records that are complete, so release assembly has their
  // frozen text without re-reading FM.
  const readyToSnapshot = loaded.records.filter((record) => {
    if (!record.active) return false;
    const ref = entityRef(record.kind, record.id);
    return !outstandingByRef.has(ref) && reconciled.readyIds.has(ref);
  });
  await runBounded(readyToSnapshot, async (record) => {
    const ref = entityRef(record.kind, record.id);
    snapshots.push(
      await writeSnapshot(deps.snapshots, record, {
        promptVersion,
        protect: loaded.protectedNames[ref] ?? [],
      }),
    );
  });

  if (deps.queue && queued.length) {
    if (deps.queue.sendBatch) {
      // Cloudflare caps a batch at 100 messages.
      for (let i = 0; i < queued.length; i += 100) {
        await deps.queue.sendBatch(queued.slice(i, i + 100).map((body) => ({ body })));
      }
    } else {
      for (const job of queued) await deps.queue.send(job);
    }
    enqueued = queued.length;
  }

  return {
    reconciled,
    snapshotsByRef: new Map(snapshots.map((s) => [entityRef(s.kind, s.id), s])),
    mode,
    scanned: loaded.records.length,
    changed: result.changed.length,
    removed: result.removed.length,
    unchanged: result.unchanged,
    enqueued,
    snapshots: snapshots.length,
    inventoryComplete: loaded.complete,
    failures: loaded.failures,
  };
}

/** What one queue message did, and what the handler should do with it. */
export type MessageDisposition =
  | { readonly action: "ack"; readonly outcome: JobOutcome | { status: "stale" | "absent" } }
  /** Snapshot not readable yet — genuinely transient. */
  | { readonly action: "retry"; readonly reason: "snapshot-missing" };

export interface ConsumeDeps {
  readonly consumer: Omit<ConsumerDeps, "sourceFor" | "protectFor">;
  readonly snapshots: Pick<SnapshotDeps, "store">;
  readonly discovery: DiscoveryDeps;
  readonly keyVersion: string;
  readonly log?: (message: string, detail?: unknown) => void;
}

/**
 * Process one queued translation job.
 *
 * RETRY IS RESERVED FOR THE TRANSIENT CASE. `processJob` already exhausts its
 * own bounded retry schedule internally, so telling the queue to retry a
 * `failed` job multiplies those attempts by the queue's own retry count — four
 * internal attempts times five deliveries is twenty model calls for one field.
 * A failed job is therefore ACKed and left for the next scan to rediscover;
 * only an unreadable snapshot retries.
 *
 * A stale completion is ACKed too. `recordJobCompletion` returning false means
 * the candidate is gone or superseded — that message will never become valid,
 * so retrying it is pure waste.
 */
export async function consumeJob(
  deps: ConsumeDeps,
  job: SnapshotBoundJob,
): Promise<MessageDisposition> {
  const resolution = await resolveJobSource(deps.snapshots, job);

  if (resolution.status === "retry") {
    return { action: "retry", reason: "snapshot-missing" };
  }
  if (resolution.status === "absent") {
    // The snapshot is readable and the field genuinely is not in it. Retrying
    // would loop until the queue dead-lettered it for the wrong reason.
    return { action: "ack", outcome: { status: "absent" } };
  }

  const outcome = await processJob(
    {
      ...deps.consumer,
      sourceFor: async () => resolution.text,
      protectFor: async () => resolution.protect,
    },
    job,
  );

  if (outcome.status === "translated" || outcome.status === "reused") {
    const recorded = await recordJobCompletion(deps.discovery, job, deps.keyVersion);
    if (!recorded) {
      deps.log?.("[publication] completion refused (superseded or unknown candidate)", {
        entity: `${job.entityKind}:${job.entityId}`,
        field: job.field,
      });
      return { action: "ack", outcome: { status: "stale" } };
    }
  }

  return { action: "ack", outcome };
}

export interface AssembleDeps {
  /** Derives the generation id from the assembled CONTENT. Preferred over `generation`. */
  readonly generationFor?: (
    records: readonly SourceRecord[],
    translations: Readonly<Record<string, unknown>>,
  ) => Promise<string>;
  readonly readback: ReadBackDeps;
  readonly release: ReleaseDeps;
  readonly promptVersion?: string;
  readonly buildId: string;
  readonly generation: string;
  readonly createdAt: string;
  readonly routesFor: (record: SourceRecord) => readonly string[];
  readonly log?: (message: string, detail?: unknown) => void;
}

export interface AssembleResult {
  readonly generation: string;
  readonly stored: boolean;
  readonly digest: string | null;
  readonly published: number;
  readonly withheld: readonly string[];
  readonly issues: readonly unknown[];
}

/**
 * Assemble and STORE a release. Never promotes it — see the file comment.
 *
 * Storing without promoting is exactly what shadow mode needs: the bundle
 * exists and can be compared against live output, while nothing serves from it.
 */
export async function assembleRelease(
  deps: AssembleDeps,
  records: readonly SourceRecord[],
  snapshots: readonly SourceSnapshot[],
): Promise<AssembleResult> {
  const readBack = await readBackAll(deps.readback, snapshots);
  const publishable = publishableRecords(records, readBack.ready);

  if (!publishable.length) {
    return {
      generation: deps.generation,
      stored: false,
      digest: null,
      published: 0,
      withheld: readBack.incomplete,
      issues: [],
    };
  }

  // The generation id covers the TRANSLATIONS too, not only the source
  // versions — see runTick() for the production failure that forced this.
  // `createdAt`/`buildId` are deliberately excluded so an unchanged corpus
  // still re-assembles to the same id instead of a new bundle every minute.
  const generation = deps.generationFor
    ? await deps.generationFor(publishable, readBack.translations)
    : deps.generation;

  const release = buildRelease({
    generation,
    records: publishable,
    translations: readBack.translations,
    routesFor: deps.routesFor,
    buildId: deps.buildId,
    promptVersion: deps.promptVersion ?? PROMPT_VERSION,
    createdAt: deps.createdAt,
  });

  const issues = validateRelease(release);
  if (issues.length) {
    // A bundle that does not validate is never stored. Storing it would put a
    // readable-but-broken generation within reach of the fallback chain.
    deps.log?.("[publication] release failed validation; not stored", issues.slice(0, 5));
    return {
      generation,
      stored: false,
      digest: null,
      published: 0,
      withheld: readBack.incomplete,
      issues,
    };
  }

  const digest = await storeRelease(deps.release, release);
  return {
    generation,
    stored: true,
    digest,
    published: publishable.length,
    withheld: readBack.incomplete,
    issues: [],
  };
}

/**
 * Should a stored generation be promoted?
 *
 * The ONE decision the rollout flag controls. Everything else runs in shadow.
 */
export function shouldPromote(env: Readonly<Record<string, unknown>>): boolean {
  return publicationMode(env) === "serving";
}

/**
 * Routes an entity is expected to serve, both locales.
 *
 * Prefixes are taken from `buildSitemapEntries()` in src/lib/sitemap.ts
 * (sitemap.ts:200-207), which is the authoritative mapping the real pages and
 * the sitemap already agree on. Duplicating the strings here rather than
 * importing that function is deliberate — it takes an origin and builds full
 * URLs for a sitemap, while a release needs bare paths — but the prefixes must
 * not drift, so they are listed together and tested against the same values.
 *
 * `webPostSection` and `bookingCategory` deliberately get NO routes: sections
 * are page FRAGMENTS rendered inside division pages, not pages of their own,
 * and category pages are generated from a filter rather than per-entity. An
 * entity with no routes still publishes; it simply contributes none.
 */
const ROUTE_PREFIX: Readonly<Record<string, string | null>> = {
  artist: "/records/artists",
  previousArtist: "/records/artists/previous/single",
  client: "/management/clients",
  teamMember: "/team",
  bookingTalent: "/ninetone-nation",
  newsPost: "/news",
  guide: "/guider",
  bookingCategory: null,
  webPostSection: null,
};

export function routesForRecord(record: SourceRecord): string[] {
  const prefix = ROUTE_PREFIX[record.kind];
  if (!prefix) return [];
  // A block id carries a '#'; blocks are fragments, never routes.
  if (record.id.includes("#")) return [];
  const sv = `${prefix}/${record.id}`;
  return [sv, `/en${sv}`];
}

/**
 * A deterministic generation id for a set of ready entities.
 *
 * Content-addressed rather than time-based, so an unchanged corpus re-assembles
 * to the SAME generation and `storeRelease()`'s "refuse to overwrite a
 * generation with different bytes" check becomes a genuine invariant instead of
 * a new bundle every minute. `Date.now()` would also defeat the immutability
 * the whole release path depends on.
 */
/**
 * Order-independent digest of an assembled translation map.
 *
 * MUST NOT USE `JSON.stringify` ON THE MAP. Its output depends on key
 * INSERTION order, and read-back fills those keys in parallel, so two runs over
 * identical content produce different strings — and therefore different
 * generation ids. Observed in production: five generations written in a few
 * minutes, all 557 entities, all byte-identical in content, differing only in
 * whether `artistPresentationShort` was inserted before or after
 * `artistPresentationString`. A cron every minute then wrote a new immutable
 * bundle every minute.
 *
 * Sorting every level makes the digest a function of CONTENT alone.
 */
export function canonicalTranslations(
  translations: Readonly<Record<string, unknown>>,
): string {
  const parts: string[] = [];
  for (const ref of Object.keys(translations).sort()) {
    const byLocale = (translations[ref] ?? {}) as Record<string, Record<string, string>>;
    for (const locale of Object.keys(byLocale).sort()) {
      const fields = byLocale[locale] ?? {};
      for (const field of Object.keys(fields).sort()) {
        parts.push(`${ref}\u0000${locale}\u0000${field}\u0000${fields[field]}`);
      }
    }
  }
  return parts.join("\u0001");
}

export async function generationIdFor(
  hash: (input: string) => Promise<string>,
  refs: readonly string[],
  hashes: readonly string[],
): Promise<string> {
  const digest = await hash([...refs].sort().join("|") + "::" + [...hashes].sort().join("|"));
  return `g-${digest.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// The full cron tick — discovery, assembly, and coordinator ordering.
// ---------------------------------------------------------------------------

export interface TickDeps extends DiscoveryRunDeps {
  /** Release bundle store (PUBLICATION_RELEASES). */
  readonly release: ReleaseDeps;
  readonly readbackCache: ReadBackDeps["cache"];
  readonly keyFor: ReadBackDeps["keyFor"];
  /** Override lookup; see ReadBackDeps.overrideFor for why the release needs it. */
  readonly overrideFor?: ReadBackDeps["overrideFor"];
  readonly buildId: string;
  readonly now: () => number;
  /**
   * Coordinator RPC. Injected so the tick is testable without a Durable
   * Object; production passes a client bound to PUBLICATION_COORDINATOR.
   */
  readonly coordinator: {
    applyScan(scan: {
      basedOnRevision: number;
      newestHashes: Record<string, string>;
      inventory?: readonly string[];
      removals: readonly string[];
    }): Promise<{ applied: boolean; state: { revision: number } }>;
    read(): Promise<{ revision: number }>;
    approve(args: {
      basedOnRevision: number;
      generation: string;
      digest: string;
    }): Promise<{ promoted: boolean }>;
  } | null;
}

export interface TickResult {
  readonly discovery: DiscoveryRunResult;
  readonly coordinatorApplied: boolean | null;
  readonly assembled: AssembleResult | null;
  readonly promoted: boolean;
  readonly mode: PublicationMode;
}

/**
 * One complete cron tick.
 *
 * ORDER: discover -> apply the scan through the COORDINATOR (so ordering is
 * serialized and a stale scan is refused) -> assemble and store a release from
 * what is ready -> promote ONLY when PUBLICATION_SERVING is on.
 *
 * Assembly runs in shadow. That is the whole point of shadow mode: a release
 * bundle exists and can be compared against live output while nothing serves
 * from it. A tick that only discovered and translated would leave nothing to
 * validate, which is the gap the deployment review correctly refused to deploy.
 */
export async function runTick(deps: TickDeps): Promise<TickResult> {
  // Revision FIRST, then the FM scan. `basedOnRevision` must describe the
  // coordinator state as of when this tick's FM read STARTED: reading it
  // after discovery let a slow tick (FM read at T0, revision read at T0+2s)
  // carry a revision newer than a faster tick that had already applied, so
  // the stale scan passed `applyScan`'s check and regressed `newestHashes`
  // (2026-09-12 publication review, D2 — reproduced against runTick).
  const before = deps.coordinator ? await deps.coordinator.read() : null;
  const discovery = await runDiscovery(deps);
  const mode = publicationMode(deps.env);

  // --- Coordinator: serialize authoritative state -------------------------
  //
  // Routed through the DO so two overlapping ticks cannot interleave
  // read-modify-write. `applyScan` refuses anything computed from an older
  // revision, which is only genuinely sufficient because the DO serializes.
  let coordinatorApplied: boolean | null = null;
  if (deps.coordinator && before) {
    const newestHashes: Record<string, string> = {};
    for (const [ref, snapshot] of discovery.snapshotsByRef) {
      newestHashes[ref] = snapshot.contentHash;
    }
    const applied = await deps.coordinator.applyScan({
      basedOnRevision: before.revision,
      newestHashes,
      // Only claim an inventory when the FM read was COMPLETE, or a partial
      // read would look like mass deletion at the coordinator too.
      ...(discovery.inventoryComplete ? { inventory: [...discovery.snapshotsByRef.keys()] } : {}),
      removals: discovery.reconciled.removals.map((r) => entityRef(r.kind, r.id)),
    });
    coordinatorApplied = applied.applied;
    if (!applied.applied) {
      deps.log?.("[publication] scan refused by coordinator (stale revision); skipping assembly");
      return { discovery, coordinatorApplied, assembled: null, promoted: false, mode };
    }
  }

  // --- Assembly: build and STORE a release from what is ready -------------
  const readySnapshots: SourceSnapshot[] = [];
  const readyRecords: SourceRecord[] = [];
  for (const ref of discovery.reconciled.readyIds) {
    const snapshot = discovery.snapshotsByRef.get(ref);
    if (!snapshot) continue;
    readySnapshots.push(snapshot);
    readyRecords.push({
      kind: snapshot.kind,
      id: snapshot.id,
      hash: snapshot.contentHash,
      fields: snapshot.fields,
      references: snapshot.references,
      active: snapshot.active,
    });
  }

  if (!readySnapshots.length) {
    deps.log?.("[publication] nothing ready yet; no release assembled");
    return { discovery, coordinatorApplied, assembled: null, promoted: false, mode };
  }

  // The generation id must cover the TRANSLATIONS, not only the source
  // versions. Snapshot versions alone are not enough: a poisoned cache entry
  // corrected by hand (or a re-translation) changes the release's content while
  // every source version stays identical, so the id would be unchanged and
  // `storeRelease()` — which refuses to rewrite a generation with different
  // bytes, correctly — would throw on every tick and no release could ever be
  // stored again. Observed in production: two English bios that the model had
  // returned in Swedish were fixed, and assembly then silently threw forever.
  //
  // Hashing the assembled entity text as well means a content change always
  // produces a NEW immutable generation, which is what immutability is for.
  const assembled = await assembleRelease(
    {
      readback: {
        cache: deps.readbackCache,
        keyFor: deps.keyFor,
        overrideFor: deps.overrideFor,
      },
      release: deps.release,
      buildId: deps.buildId,
      generation: "unused",
      generationFor: async (records, translations) =>
        generationIdFor(
          deps.snapshots.hash,
          records.map((r) => entityRef(r.kind, r.id)),
          [
            ...readySnapshots.map((s) => s.snapshotVersion),
            await deps.snapshots.hash(canonicalTranslations(translations)),
          ],
        ),
      createdAt: new Date(deps.now()).toISOString(),
      routesFor: routesForRecord,
      promptVersion: deps.promptVersion ?? PROMPT_VERSION,
      log: deps.log,
    },
    readyRecords,
    readySnapshots,
  );

  // --- Promotion: the ONE step the rollout flag gates ----------------------
  let promoted = false;
  if (assembled.stored && assembled.digest && shouldPromote(deps.env) && deps.coordinator) {
    const state = await deps.coordinator.read();
    const outcome = await deps.coordinator.approve({
      basedOnRevision: state.revision,
      generation: assembled.generation,
      digest: assembled.digest,
    });
    promoted = outcome.promoted;
    if (promoted) {
      // The pointer the serving path reads. Written only after the coordinator
      // approved, so two concurrent promotions cannot both win.
      await deps.release.store.put("rel:v1:current", assembled.generation);
      const historyRaw = await deps.release.store.get("rel:v1:history");
      const history: string[] = historyRaw ? (JSON.parse(historyRaw) as string[]) : [];
      const next = [assembled.generation, ...history.filter((g) => g !== assembled.generation)];
      await deps.release.store.put("rel:v1:history", JSON.stringify(next.slice(0, 5)));
    }
  }

  return { discovery, coordinatorApplied, assembled, promoted, mode };
}
