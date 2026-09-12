/**
 * Translation read-back — turning cached translations into a release bundle.
 *
 * THE GAP THIS FILLS. `buildRelease()` needs
 * `translations[entityRef][locale][field]`, but `processJob()` writes the
 * translated text to KV and returns only `{status, key}` — the text itself is
 * discarded. Nothing reconstructed it, so release assembly had no text source.
 *
 * Returning cache keys from the consumer is the right design: the translation
 * cache is content-addressed (`tr:v1:{target}:{tier}:{sha256(text)}`), so the
 * key IS the durable handle and passing megabytes of prose back through queue
 * results would be wasteful and racy. The missing half is this module, which
 * resolves those keys back into text at assembly time.
 *
 * WHY IT READS FROM THE SNAPSHOT, NOT FROM FM. Every key is derived from the
 * SNAPSHOT's frozen source text, so the translation read back is provably the
 * translation OF THE TEXT THE RELEASE WILL SHIP. Deriving keys from live FM
 * would reintroduce exactly the drift the snapshot exists to remove: FM edited
 * after discovery would produce a key for text that is not in the release.
 *
 * COMPLETENESS IS VERIFIED, NOT ASSUMED. `readBackEntity()` reports which
 * fields are missing per locale rather than silently emitting a partial entity.
 * That matters because `validateRelease()` compares against `requiredFields`
 * from the source manifest — an entity that quietly dropped a field would be
 * caught there, but only after a bundle had been assembled and stored. Failing
 * earlier, with the specific field and locale named, is the difference between
 * "release invalid" and "release invalid BECAUSE anjo's Swedish bio never
 * translated".
 *
 * A MISSING TRANSLATION IS NOT AN ERROR HERE. It means the entity is not ready
 * yet, which is a normal state during preparation: the caller withholds it from
 * the release and it joins a later generation once its jobs complete. Treating
 * it as a failure would stall publication on work that is merely in progress.
 */

import {
  ENTITY_FIELDS,
  SUPPORTED_LOCALES,
  type Lang,
  type SourceRecord,
} from "./contracts.ts";
import { entityRef, runBounded } from "./discovery.ts";
import { type SourceSnapshot } from "./snapshot.ts";

/** Read-only view of the translation cache. */
export interface TranslationReader {
  get(key: string): Promise<string | null>;
}

export interface ReadBackDeps {
  readonly cache: TranslationReader;
  /** Inject translate.ts's `translationKey` — the same function the consumer wrote with. */
  readonly keyFor: (source: string, target: Lang, tier: string) => Promise<string>;
  /**
   * Human override lookup, keyed on sha256 of the SOURCE text.
   *
   * MUST MIRROR translate()'s PRECEDENCE: overrides win over the cache. A
   * release assembled without this can disagree with what the page renders,
   * which is worse than either being wrong alone.
   *
   * This is not hypothetical. Two FM bios are authored in English, and the
   * model returned Swedish for the English request on both — twice for one of
   * them, so re-translating did not help. An override fixed rendering, but the
   * release still read the poisoned cache entry directly and would have
   * shipped Swedish under /en/. Optional so existing callers and tests keep
   * working; omitted means cache-only, which is the old behaviour.
   */
  readonly overrideFor?: (source: string, target: Lang) => Promise<string | null>;
}

/** One field that could not be resolved. */
export interface MissingTranslation {
  readonly ref: string;
  readonly locale: Lang;
  readonly field: string;
  /** The cache key that was looked up — makes a miss diagnosable in KV. */
  readonly key: string;
}

export interface EntityReadBack {
  readonly ref: string;
  /** locale -> field -> translated text. Only fields actually resolved. */
  readonly text: Readonly<Record<Lang, Readonly<Record<string, string>>>>;
  readonly missing: readonly MissingTranslation[];
  /** True when every required field resolved in every locale. */
  readonly complete: boolean;
}

/**
 * Fields a snapshot is expected to have translated.
 *
 * Derived from the SNAPSHOT's own captured fields intersected with
 * `ENTITY_FIELDS`, mirroring `jobsForSnapshot()` exactly. Deriving it any other
 * way is how completeness checks drift from the work actually queued: requiring
 * a field no job existed for would block forever, and requiring fewer would let
 * an entity publish with a gap.
 */
export function expectedFields(snapshot: SourceSnapshot): string[] {
  return ENTITY_FIELDS[snapshot.kind]
    .map(({ field }) => field)
    .filter((field) => {
      const value = snapshot.fields[field];
      return typeof value === "string" && value.trim() !== "";
    });
}

/**
 * Resolve one entity's translations from the cache.
 *
 * Reads every (field, locale) pair the snapshot implies. Never calls a model,
 * never touches FM.
 */
export async function readBackEntity(
  deps: ReadBackDeps,
  snapshot: SourceSnapshot,
  tier: string = "fast",
): Promise<EntityReadBack> {
  const ref = entityRef(snapshot.kind, snapshot.id);
  const text: Record<Lang, Record<string, string>> = { sv: {}, en: {} };
  const missing: MissingTranslation[] = [];

  // BOUNDED-PARALLEL, not sequential. Measured at real scale: 557 ready
  // entities are 3,342 (field, locale) reads, and issued one at a time against
  // remote KV (~5ms) that is ~21.6s — on its own more than a scheduled
  // invocation gets. In production this showed up as a release that assembled
  // while only 10 entities were ready and then never assembled again once all
  // 557 became ready, because the tick died in this loop. The reads are
  // independent, so batching changes nothing but wall time.
  const pairs: { field: string; locale: Lang; source: string }[] = [];
  for (const field of expectedFields(snapshot)) {
    const source = snapshot.fields[field].trim();
    for (const locale of SUPPORTED_LOCALES) pairs.push({ field, locale, source });
  }

  await runBounded(pairs, async ({ field, locale, source }) => {
    const key = await deps.keyFor(source, locale, tier);

    // Overrides first, exactly as translate() does. A human correction must
    // reach the release, not only the rendered page.
    if (deps.overrideFor) {
      const override = await deps.overrideFor(source, locale);
      if (override !== null && override.trim() !== "") {
        text[locale][field] = override;
        return;
      }
    }

    const value = await deps.cache.get(key);
    if (value === null || value.trim() === "") {
      missing.push({ ref, locale, field, key });
      return;
    }
    text[locale][field] = value;
  });

  return { ref, text, missing, complete: missing.length === 0 };
}

export interface ReadBackResult {
  /** Shape `buildRelease()` consumes directly. */
  readonly translations: Readonly<
    Record<string, Readonly<Record<Lang, Readonly<Record<string, string>>>>>
  >;
  /** Refs whose translations are all present — safe to publish. */
  readonly ready: readonly string[];
  /** Refs still preparing, with the specific gaps named. */
  readonly incomplete: readonly string[];
  readonly missing: readonly MissingTranslation[];
}

/**
 * Read back a whole candidate set.
 *
 * Returns the translations map plus an explicit ready/incomplete split, so the
 * caller publishes the ready set and leaves the rest preparing rather than
 * having to infer readiness from the shape of the map.
 */
export async function readBackAll(
  deps: ReadBackDeps,
  snapshots: readonly SourceSnapshot[],
  tier: string = "fast",
): Promise<ReadBackResult> {
  const translations: Record<string, Record<Lang, Record<string, string>>> = {};
  const ready: string[] = [];
  const incomplete: string[] = [];
  const missing: MissingTranslation[] = [];

  // Entities are independent of one another too. runBounded caps total
  // in-flight reads via readBackEntity's own bound, so this stays bounded.
  await runBounded(snapshots, async (snapshot) => {
    const entity = await readBackEntity(deps, snapshot, tier);
    translations[entity.ref] = entity.text as Record<Lang, Record<string, string>>;
    if (entity.complete) ready.push(entity.ref);
    else {
      incomplete.push(entity.ref);
      missing.push(...entity.missing);
    }
  }, 8);

  return { translations, ready, incomplete, missing };
}

/**
 * Records whose translations are ready, in the order given.
 *
 * A convenience for the assembly step: `buildRelease()` takes records, and the
 * read-back decides which of them may go in. An inactive record is excluded
 * here too — a withdrawal is handled by the removal path, not by assembling it
 * into a release with no text.
 */
export function publishableRecords(
  records: readonly SourceRecord[],
  ready: readonly string[],
): SourceRecord[] {
  const readySet = new Set(ready);
  return records.filter((record) => record.active && readySet.has(entityRef(record.kind, record.id)));
}
