/**
 * Release assembly and promotion — checkpoint 3 of
 * docs/translation-publication-implementation-handoff.md.
 *
 * Builds immutable generations, promotes them in a serialized order, and
 * resolves which generation a request should read. Pure and injected like the
 * rest of this directory: the Durable Object and KV layers are adapters over
 * these functions, so the consistency rules are testable without Cloudflare.
 *
 * THE CONSISTENCY PROBLEM THIS EXISTS TO SOLVE. Workers KV is eventually
 * consistent and has no atomic compare-and-set. A naive `current-generation`
 * pointer is therefore not a publication promise:
 *
 *   - a reader can observe the pointer before the bundle it names is readable
 *   - two concurrent writers can overwrite each other's pointer
 *   - different edges can observe different pointers for some seconds
 *
 * So a pointer ALONE is never treated as readiness. Three rules, each with a
 * test:
 *
 *   1. A generation is only promotable once its bundle is readable AND carries
 *      a readiness marker written after the bundle (`verifyGenerationReadable`).
 *   2. Readers resolve through `resolveGeneration`, which falls back to the
 *      last known-good generation whenever the pointed-at one is missing or
 *      unreadable. A missing artifact must never fall through to live FM.
 *   3. Promotion re-checks source hashes immediately before committing
 *      (`rejectStalePromotion`), so a candidate that FM changed underneath is
 *      marked superseded instead of publishing outdated content.
 *
 * Mixed generations across edges are expected and safe: every generation is
 * internally complete, so a visitor reading an older one sees a consistent
 * older site rather than a new listing linking to an unavailable detail page.
 */

import type { KvLike } from "../cache.ts";
import {
  type Release,
  type ReleaseEntity,
  type SourceRecord,
  type Lang,
  SUPPORTED_LOCALES,
  validateRelease,
} from "./contracts.ts";
import { entityRef } from "./discovery.ts";
import { digestOf } from "./coordinator.ts";

export const RELEASE_PREFIX = "rel:v1:";

export const releaseKeys = {
  /** The immutable bundle. Written once under a generation id, never updated. */
  bundle: (generation: string) => `${RELEASE_PREFIX}bundle:${generation}`,
  /**
   * Readiness marker, written AFTER the bundle.
   *
   * Ordering is the whole point: a reader that sees the marker knows the bundle
   * write already returned. The reverse order would let a reader observe a
   * generation that is not yet readable.
   */
  ready: (generation: string) => `${RELEASE_PREFIX}ready:${generation}`,
  /** Pointer to the current generation. Advisory — never proof of readiness. */
  current: () => `${RELEASE_PREFIX}current`,
  /** Ordered history, newest first. Retained for rollback and fallback. */
  history: () => `${RELEASE_PREFIX}history`,
};

/** How many generations to retain. Enough to roll back; bounded so KV does not grow forever. */
export const RETAINED_GENERATIONS = 5;

export interface ReleaseDeps {
  readonly store: KvLike & { delete?: (key: string) => Promise<void> };
  readonly now?: () => number;
}

/**
 * Assemble a bundle from records whose translations are complete.
 *
 * `translations` maps `entityRef -> locale -> field -> text`. The caller reads
 * those from the translation cache; this function only shapes and validates.
 *
 * `requiredFields` comes from the SOURCE record, not from the translation map,
 * which is the completeness fix the review required: a field that failed to
 * translate is absent from the map, and inferring requirements from the map
 * would make that absence invisible.
 */
export function buildRelease(args: {
  readonly generation: string;
  readonly records: readonly SourceRecord[];
  readonly translations: Readonly<Record<string, Readonly<Record<Lang, Readonly<Record<string, string>>>>>>;
  readonly routesFor: (record: SourceRecord) => readonly string[];
  readonly buildId: string;
  readonly promptVersion: string;
  readonly createdAt: string;
}): Release {
  const entities: ReleaseEntity[] = args.records.map((record) => {
    const ref = entityRef(record.kind, record.id);
    const text = args.translations[ref] ?? ({} as Record<Lang, Record<string, string>>);
    const filled: Record<Lang, Record<string, string>> = { sv: {}, en: {} };
    for (const locale of SUPPORTED_LOCALES) filled[locale] = { ...(text[locale] ?? {}) };

    return {
      kind: record.kind,
      id: ref,
      sourceHash: record.hash,
      references: record.references.map((r) => (r.includes(":") ? r : r)),
      requiredFields: Object.keys(record.fields),
      routes: args.routesFor(record),
      text: filled,
    };
  });

  return {
    generation: args.generation,
    createdAt: args.createdAt,
    entities,
    routes: [...new Set(entities.flatMap((e) => e.routes))],
    buildId: args.buildId,
    promptVersion: args.promptVersion,
  };
}

/**
 * Write a bundle, then its readiness marker.
 *
 * Deliberately two writes in this order. A crash between them leaves a bundle
 * with no marker, which `verifyGenerationReadable` treats as not ready — safe,
 * and repaired by the next promotion attempt. The reverse order would publish a
 * marker for a bundle that may not be readable.
 */
export async function storeRelease(deps: ReleaseDeps, release: Release): Promise<string> {
  const serialized = JSON.stringify(release);

  // Generation keys are immutable. The review found storeRelease() happily
  // overwriting one, which is how an invalid bundle could sit at the same id a
  // valid object was promoted under. Refuse to rewrite a generation whose
  // stored bytes differ.
  const existing = await deps.store.get(releaseKeys.bundle(release.generation));
  if (existing !== null && existing !== serialized) {
    throw new Error(
      `generation ${release.generation} already stored with different content; generations are immutable`,
    );
  }

  const digest = await digestOf(serialized);
  // Already stored byte-for-byte: nothing to write. Generation ids are
  // content-addressed, so an unchanged corpus reaches this branch on every
  // tick — rewriting the bundle and its ready marker each minute was 4,320
  // needless writes a day to the same three keys (review D5), and it churned
  // the marker's timestamp for no reason. The marker is only re-written when
  // it is actually missing (a crash between the two puts).
  if (existing === serialized) {
    const marker = await deps.store.get(releaseKeys.ready(release.generation));
    if (marker !== null) return digest;
  } else {
    await deps.store.put(releaseKeys.bundle(release.generation), serialized);
  }
  await deps.store.put(
    releaseKeys.ready(release.generation),
    JSON.stringify({ at: (deps.now ?? Date.now)(), generation: release.generation, digest }),
  );
  return digest;
}

/**
 * Is this generation actually readable and marked ready?
 *
 * Both checks, not just the marker: KV is eventually consistent, so a marker
 * that has propagated to this edge does not prove the bundle has. Reading the
 * bundle back is what makes "ready" mean something.
 */
export async function verifyGenerationReadable(
  deps: ReleaseDeps,
  generation: string,
): Promise<boolean> {
  const marker = await deps.store.get(releaseKeys.ready(generation));
  if (!marker) return false;
  const bundle = await deps.store.get(releaseKeys.bundle(generation));
  if (!bundle) return false;
  try {
    const parsed = JSON.parse(bundle) as Release;
    if (parsed.generation !== generation || !Array.isArray(parsed.entities)) return false;

    // The marker records the digest of the bytes it was written for. If the
    // stored bundle no longer matches, the marker is describing something that
    // is no longer there — treat the generation as not readable rather than
    // trusting a marker over the artifact.
    const meta = JSON.parse(marker) as { digest?: string };
    if (meta.digest && meta.digest !== (await digestOf(bundle))) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse to promote a candidate whose source changed during preparation.
 *
 * `newestHashes` is read immediately before committing, per the design:
 * "immediately before marking a candidate ready, compare its source hash with
 * the newest discovered hash." Returns the entity refs that are stale; a
 * non-empty result means this release must not be promoted as-is.
 */
export function rejectStalePromotion(
  release: Release,
  newestHashes: Readonly<Record<string, string>>,
): string[] {
  return release.entities
    .filter((entity) => {
      const newest = newestHashes[entity.id];
      return newest !== undefined && newest !== entity.sourceHash;
    })
    .map((entity) => entity.id);
}

export interface PromotionResult {
  readonly promoted: boolean;
  readonly generation: string;
  readonly reason?: "invalid" | "stale" | "unreadable";
  readonly issues?: readonly string[];
}

/**
 * Promote a stored generation to current.
 *
 * Every gate runs before the pointer moves: the bundle must validate, must not
 * be stale, and must be verifiably readable. The pointer write is last and is
 * the only mutable key in the release path — which is why the design wants a
 * Durable Object serializing this call. Without one, two concurrent promotions
 * can still overwrite each other's pointer; both would name a complete,
 * internally consistent generation, so the failure mode is "an older complete
 * site wins" rather than corruption, but it is a real limitation and is stated
 * rather than hidden.
 */
export async function promoteRelease(
  deps: ReleaseDeps,
  release: Release,
  newestHashes: Readonly<Record<string, string>>,
): Promise<PromotionResult> {
  // VALIDATE THE STORED ARTIFACT, NOT THE ARGUMENT.
  //
  // The review reproduced this: store an invalid bundle, then call promotion
  // with a valid object carrying the same generation id -> promoted:true, and
  // visitors would be served the invalid stored bundle. Validation must bind
  // to the bytes that will actually be read, so the argument is used only to
  // name the generation.
  const stored = await readRelease(deps, release.generation);
  if (!stored) {
    return { promoted: false, generation: release.generation, reason: "unreadable" };
  }

  const issues = validateRelease(stored);
  if (issues.length > 0) {
    return {
      promoted: false,
      generation: release.generation,
      reason: "invalid",
      issues: issues.map((i) => `${i.type}:${"entityId" in i ? i.entityId : ""}`),
    };
  }

  const stale = rejectStalePromotion(stored, newestHashes);
  if (stale.length > 0) {
    return { promoted: false, generation: release.generation, reason: "stale", issues: stale };
  }

  if (!(await verifyGenerationReadable(deps, release.generation))) {
    return { promoted: false, generation: release.generation, reason: "unreadable" };
  }

  const historyRaw = await deps.store.get(releaseKeys.history());
  const history: string[] = historyRaw ? (JSON.parse(historyRaw) as string[]) : [];
  const next = [release.generation, ...history.filter((g) => g !== release.generation)];

  await deps.store.put(releaseKeys.history(), JSON.stringify(next.slice(0, RETAINED_GENERATIONS)));
  await deps.store.put(releaseKeys.current(), release.generation);

  return { promoted: true, generation: release.generation };
}

/**
 * Which generation should this request read?
 *
 * The pointer is a hint, not a promise. If the pointed-at generation is not
 * verifiably readable, walk the retained history for the newest one that is.
 * Returns null only when NOTHING is readable — and the caller must then serve
 * its existing behaviour, never live untranslated FM data.
 */
export async function resolveGeneration(deps: ReleaseDeps): Promise<string | null> {
  const current = await deps.store.get(releaseKeys.current());
  if (current && (await verifyGenerationReadable(deps, current))) return current;

  const historyRaw = await deps.store.get(releaseKeys.history());
  const history: string[] = historyRaw ? (JSON.parse(historyRaw) as string[]) : [];
  for (const generation of history) {
    if (generation === current) continue;
    if (await verifyGenerationReadable(deps, generation)) return generation;
  }
  return null;
}

export async function readRelease(deps: ReleaseDeps, generation: string): Promise<Release | null> {
  const raw = await deps.store.get(releaseKeys.bundle(generation));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Release;
  } catch {
    return null;
  }
}

/**
 * Roll back to the newest retained generation that is not the current one.
 *
 * Deliberately does NOT delete the rolled-back-from generation: a rollback is
 * usually a response to a problem someone is still diagnosing, and destroying
 * the evidence makes that harder.
 */
export async function rollback(deps: ReleaseDeps): Promise<string | null> {
  const current = await deps.store.get(releaseKeys.current());
  const historyRaw = await deps.store.get(releaseKeys.history());
  const history: string[] = historyRaw ? (JSON.parse(historyRaw) as string[]) : [];

  for (const generation of history) {
    if (generation === current) continue;
    if (await verifyGenerationReadable(deps, generation)) {
      await deps.store.put(releaseKeys.current(), generation);
      return generation;
    }
  }
  return null;
}

/**
 * Remove entities from a release WITHOUT waiting for translation.
 *
 * The urgent-withdrawal path. A removal must never queue behind prose work, so
 * this derives a new generation from an existing one by filtering rather than
 * by rebuilding. References to removed entities are dropped from the survivors
 * too, so no listing can link to something that is gone.
 */
export function withRemovals(
  release: Release,
  removedRefs: ReadonlySet<string>,
  generation: string,
  createdAt: string,
): Release {
  const entities = release.entities
    .filter((entity) => !removedRefs.has(entity.id))
    .map((entity) => ({
      ...entity,
      references: entity.references.filter((ref) => !removedRefs.has(ref)),
    }));

  return {
    ...release,
    generation,
    createdAt,
    entities,
    routes: [...new Set(entities.flatMap((e) => e.routes))],
  };
}
