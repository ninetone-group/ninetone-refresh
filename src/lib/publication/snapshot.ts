/**
 * Immutable source snapshots — the text a queued job translates.
 *
 * WHY THIS MODULE EXISTS. `TranslationJob` (contracts.ts) carries identity but
 * NO source text, and the queue consumer is forbidden from reading FileMaker
 * (consumer.ts: "Source text for a job. Separate so the consumer never
 * re-reads FM itself."). Without a snapshot there is nowhere for a job's text
 * to come from, so the consumer could only re-fetch FM — which is exactly the
 * failure this design exists to prevent:
 *
 *   FM text changes between enqueue and consume -> the consumer translates the
 *   NEW text but the completion is recorded against the OLD sourceHash, so a
 *   release is assembled from prose that never belonged to that version.
 *
 * A snapshot freezes the text at discovery time. The job names the snapshot;
 * the consumer reads it and nothing else.
 *
 * TWO IDENTITIES, DELIBERATELY SEPARATE. This is the subtle part and the
 * reason `snapshotVersion` is not simply `record.hash`:
 *
 *   contentHash  = sha256(sourceHashInput(...))  — TEXT ONLY, by design.
 *                  contracts.ts deliberately excludes `active` and
 *                  `references` so that moving an artist Active -> Previous ->
 *                  Active does NOT re-translate unchanged prose. This is the
 *                  identity the translation cache keys on.
 *
 *   snapshotVersion = sha256(contentHash + membershipFingerprint) — the
 *                  COMPLETE source version: text AND the membership metadata
 *                  (active flag, references) that decides which listings and
 *                  routes a release must contain.
 *
 * Collapsing them would break one of the two requirements. Using the content
 * hash alone would make a status change invisible to the snapshot, so a
 * release assembled from it would carry stale membership. Folding membership
 * into the content hash would re-translate text on every status change — the
 * paid-work-for-nothing bug that an earlier review already caught once.
 *
 * So: a status change produces a NEW snapshot (membership moved) while every
 * translation is reused (text unchanged, and the translation cache is keyed on
 * sha256(text) per target+tier, not on snapshot identity).
 *
 * MISSING SNAPSHOT => RETRY, NEVER FETCH. `readSnapshot` returns null and the
 * consumer retries. KV is eventually consistent, so a snapshot written moments
 * before a job is delivered can legitimately be invisible at one edge for a
 * short while; retrying resolves it. Falling back to live FM text would
 * silently reintroduce the mismatch above, so this module offers no such path.
 */

import {
  ENTITY_FIELDS,
  SUPPORTED_LOCALES,
  membershipFingerprint,
  sourceHashInput,
  type EntityKind,
  type Lang,
  type SourceRecord,
  type TranslationJob,
} from "./contracts.ts";

/** Snapshot keys share discovery's `pub:v1:` prefix so they stay greppable. */
export const SNAPSHOT_PREFIX = "pub:v1:snap:";

/**
 * One frozen source version.
 *
 * `fields` is the same normalized map the hash was computed over, so a job's
 * text is exactly the text its `contentHash` describes — not a re-read that
 * may have drifted.
 */
export interface SourceSnapshot {
  readonly snapshotVersion: string;
  readonly contentHash: string;
  readonly membership: string;
  readonly kind: EntityKind;
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
  /** Names that must survive translation unchanged, frozen with the text. */
  readonly protect: readonly string[];
  readonly active: boolean;
  readonly references: readonly string[];
  readonly promptVersion: string;
  readonly capturedAt: number;
}

export function snapshotKey(kind: string, id: string, snapshotVersion: string): string {
  return `${SNAPSHOT_PREFIX}${kind}:${id}:${snapshotVersion}`;
}

/** Minimal KV surface this module needs. Matches `KvLike` in src/lib/cache.ts. */
export interface SnapshotStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface SnapshotDeps {
  readonly store: SnapshotStore;
  readonly hash: (input: string) => Promise<string>;
  readonly now?: () => number;
}

/**
 * Compute the complete source version for a record.
 *
 * Takes the record's `hash` as the content hash rather than recomputing it, so
 * a snapshot can never disagree with the candidate/job identity discovery
 * already derived from the same value.
 */
export async function snapshotVersionFor(
  deps: Pick<SnapshotDeps, "hash">,
  record: Omit<SourceRecord, "hash"> & { readonly hash: string },
): Promise<{ snapshotVersion: string; contentHash: string; membership: string }> {
  const membership = membershipFingerprint(record);
  const snapshotVersion = await deps.hash(`content=${record.hash}|${membership}`);
  return { snapshotVersion, contentHash: record.hash, membership };
}

/**
 * Freeze a record's text. Write-once: an existing snapshot is never rewritten.
 *
 * Immutability is what makes at-least-once delivery and crash recovery safe —
 * the same snapshot version always denotes the same bytes, so a redelivered
 * job reads identical text however many times it runs. Re-writing would
 * reintroduce the very drift the snapshot removes.
 */
export async function writeSnapshot(
  deps: SnapshotDeps,
  record: SourceRecord,
  args: { readonly promptVersion: string; readonly protect: readonly string[] },
): Promise<SourceSnapshot> {
  const { snapshotVersion, contentHash, membership } = await snapshotVersionFor(deps, record);
  const key = snapshotKey(record.kind, record.id, snapshotVersion);

  const existing = await deps.store.get(key);
  if (existing) {
    try {
      return JSON.parse(existing) as SourceSnapshot;
    } catch {
      // An unparseable snapshot is corrupt; rewriting it with the same
      // version is safe precisely because the version pins the content.
    }
  }

  const snapshot: SourceSnapshot = {
    snapshotVersion,
    contentHash,
    membership,
    kind: record.kind,
    id: record.id,
    fields: { ...record.fields },
    protect: [...args.protect],
    active: record.active,
    references: [...record.references],
    promptVersion: args.promptVersion,
    capturedAt: (deps.now ?? Date.now)(),
  };
  await deps.store.put(key, JSON.stringify(snapshot));
  return snapshot;
}

/**
 * Read a snapshot back. Returns null when absent or unparseable.
 *
 * Null means RETRY, never "fetch the current text" — see the file comment.
 */
export async function readSnapshot(
  deps: Pick<SnapshotDeps, "store">,
  kind: string,
  id: string,
  snapshotVersion: string,
): Promise<SourceSnapshot | null> {
  const raw = await deps.store.get(snapshotKey(kind, id, snapshotVersion));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SourceSnapshot;
  } catch {
    return null;
  }
}

/**
 * A job bound to the snapshot that holds its text.
 *
 * `snapshotVersion` is what makes the job self-describing: the consumer needs
 * no FM access and no ambient state to find its source. `protect` is filled
 * here — `jobsForRecord()` in contracts.ts hardcodes `protect: []` because it
 * has no access to entity names, which left name protection inert.
 */
export interface SnapshotBoundJob extends TranslationJob {
  readonly snapshotVersion: string;
}

/**
 * Build the jobs for a snapshot: one per translatable non-empty field per
 * locale, each naming the snapshot and carrying the protected names.
 *
 * Mirrors `jobsForRecord()` (contracts.ts) on purpose — same fields, same
 * both-locales rule — but binds the snapshot and fills `protect`. It reads the
 * SNAPSHOT's fields rather than a record's, so a job can only ever exist for
 * text that is already frozen and readable.
 */
export function jobsForSnapshot(snapshot: SourceSnapshot): SnapshotBoundJob[] {
  if (!snapshot.active) return [];
  const jobs: SnapshotBoundJob[] = [];
  for (const { field, kind } of ENTITY_FIELDS[snapshot.kind]) {
    const text = snapshot.fields[field];
    if (!text) continue;
    for (const target of SUPPORTED_LOCALES) {
      jobs.push({
        entityKind: snapshot.kind,
        entityId: snapshot.id,
        sourceHash: snapshot.contentHash,
        field,
        target,
        kind,
        tier: "fast",
        protect: snapshot.protect,
        snapshotVersion: snapshot.snapshotVersion,
      });
    }
  }
  return jobs;
}

/** Outcome of resolving a job's source text. */
export type SourceResolution =
  | { readonly status: "found"; readonly text: string; readonly protect: readonly string[] }
  /** Snapshot not readable yet — retry. NEVER a reason to read FM. */
  | { readonly status: "retry"; readonly reason: "snapshot-missing" }
  /** Snapshot readable but the field is genuinely absent — not retryable. */
  | { readonly status: "absent"; readonly reason: "field-missing" };

/**
 * Resolve a job's source text from its snapshot.
 *
 * The three outcomes are distinct on purpose. A missing SNAPSHOT is transient
 * (KV eventual consistency, or a crash between writing the job and the
 * snapshot) and must retry. A missing FIELD inside a readable snapshot is
 * permanent — the text genuinely is not there — and retrying would loop
 * forever against a queue that eventually dead-letters it for the wrong
 * reason.
 */
export async function resolveJobSource(
  deps: Pick<SnapshotDeps, "store">,
  job: SnapshotBoundJob,
): Promise<SourceResolution> {
  const snapshot = await readSnapshot(deps, job.entityKind, job.entityId, job.snapshotVersion);
  if (!snapshot) return { status: "retry", reason: "snapshot-missing" };

  const text = snapshot.fields[job.field];
  if (!text || !text.trim()) return { status: "absent", reason: "field-missing" };

  return {
    status: "found",
    text,
    protect: job.protect.length > 0 ? job.protect : snapshot.protect,
  };
}

/**
 * Recompute a record's content hash from its fields.
 *
 * Exported so the FM adapter and any verifier derive the hash the same way
 * rather than each re-implementing `sourceHashInput` + sha256 and drifting.
 */
export async function contentHashFor(
  deps: Pick<SnapshotDeps, "hash">,
  record: Omit<SourceRecord, "hash">,
  promptVersion: string,
): Promise<string> {
  return deps.hash(sourceHashInput(record, promptVersion));
}

/** Locale set a complete snapshot must eventually satisfy. */
