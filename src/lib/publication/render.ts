/**
 * Rendering integration — serving prose from a published release.
 *
 * WHAT THIS CHANGES TODAY: nothing. `publicationMode()` returns "shadow"
 * unless PUBLICATION_SERVING is exactly "on", and `releaseLookup()` returns a
 * resolver that reports `unavailable` in every other mode, which makes
 * `fmText()` fall through to its existing behaviour byte-for-byte. The switch
 * in step 4 of the rollout is turning the variable on, not editing this file.
 *
 * WHY THE LOOKUP IS PINNED PER REQUEST. `pinGeneration()` resolves the serving
 * generation ONCE and every lookup in the render reuses it, so a promotion
 * landing mid-render cannot split one page across two generations — a listing
 * from the new release linking to a detail page from the old one. The pin
 * lives on `locals`, the same per-request object `fmText()` already hangs its
 * budget and memo table on.
 *
 * WHY A MISS IS NOT A FALLBACK TO LIVE TRANSLATION, EXCEPT DELIBERATELY.
 * There are two different misses and they must not be conflated:
 *
 *   - NO GENERATION RESOLVES (nothing published yet, or KV cannot be read):
 *     `unavailable`. The caller keeps its existing behaviour. This is the
 *     safe, reversible state and it is what every request sees today.
 *   - A GENERATION IS SERVING BUT LACKS THIS ENTITY: `miss`. Handled by
 *     `lookupWithFallback()`, which consults NEWER approved generations only.
 *     Forward-only is the safety property — looking backwards would resurrect
 *     a withdrawn record.
 *
 * Neither case may silently render untranslated source as though it were
 * translated. That is why `resolveFromRelease` returns `null` rather than the
 * source text: the caller decides, and today's caller is `fmText()`, whose
 * documented degradation (return source, schedule translation) is unchanged.
 */

import type { Lang } from "./contracts.ts";
import { publicationMode, type PublicationMode, type RequestGeneration } from "./serving.ts";

/** Per-request pin, stashed on `locals` so one render sees one generation. */
const PIN_KEY = "__publicationPin";

export interface PinnedRelease {
  readonly mode: PublicationMode;
  /** Null when nothing resolved — the caller keeps its existing behaviour. */
  readonly generation: RequestGeneration | null;
}

export interface LocalsWithPin {
  [PIN_KEY]?: Promise<PinnedRelease>;
}

export interface RenderDeps {
  readonly env: Readonly<Record<string, unknown>> | null | undefined;
  /** Resolves the serving generation. Injected so this is testable with no KV. */
  readonly resolve: () => Promise<RequestGeneration | null>;
}

/**
 * Pin the generation for this request, once.
 *
 * Returns the SAME promise for every caller on the same `locals`, so
 * concurrent lookups during one render cannot each resolve a different
 * generation.
 */
export function pinForRequest(locals: LocalsWithPin, deps: RenderDeps): Promise<PinnedRelease> {
  const existing = locals[PIN_KEY];
  if (existing) return existing;

  const pinned = (async (): Promise<PinnedRelease> => {
    const mode = publicationMode(deps.env);
    // Shadow and off never serve from a release, so do not even resolve one:
    // reading KV per request to then ignore the result is pure latency.
    if (mode !== "serving") return { mode, generation: null };
    try {
      return { mode, generation: await deps.resolve() };
    } catch {
      // A failure to resolve must degrade to existing behaviour, never throw
      // a render. This is the same "degrade, never block" posture translate.ts
      // takes for its own cache.
      return { mode, generation: null };
    }
  })();

  locals[PIN_KEY] = pinned;
  return pinned;
}

/** Lookup result for one field. `null` means "not served from a release". */
export type ReleaseText = string | null;

/**
 * Resolve one entity field from the pinned release.
 *
 * Returns null — never the source text — whenever the release cannot answer,
 * so the caller's existing degradation path stays in charge.
 */
export async function resolveFromRelease(
  pinned: PinnedRelease,
  lookup: (
    generation: RequestGeneration,
    entityId: string,
    locale: Lang,
  ) => Promise<{ status: string; text?: Readonly<Record<string, string>> }>,
  entityId: string,
  locale: Lang,
  field: string,
): Promise<ReleaseText> {
  if (!pinned.generation) return null;

  const result = await lookup(pinned.generation, entityId, locale);
  if (result.status !== "hit" || !result.text) return null;

  const value = result.text[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Wrap an existing `fmText`-shaped translator so it prefers the release.
 *
 * Deliberately a WRAPPER rather than an edit to `fmText()` itself. The
 * fallback path must stay exactly what it is today — that is what makes this
 * reversible by removing one call rather than by reverting logic inside the
 * function every page depends on.
 *
 * `entityFor` maps a source string back to the (entityId, field) that produced
 * it. A caller that cannot supply one gets the unchanged translator, which is
 * the correct default: a release lookup keyed on the wrong entity would serve
 * one record's prose under another's name.
 */
export function withRelease<T extends (source: string | null | undefined, kind?: string) => Promise<string>>(
  translator: T,
  args: {
    readonly pinned: PinnedRelease;
    readonly locale: Lang;
    readonly entityId: string | null;
    readonly fieldFor: (source: string) => string | null;
    readonly lookup: (
      generation: RequestGeneration,
      entityId: string,
      locale: Lang,
    ) => Promise<{ status: string; text?: Readonly<Record<string, string>> }>;
  },
): T {
  if (!args.pinned.generation || !args.entityId) return translator;

  const wrapped = async (source: string | null | undefined, kind?: string): Promise<string> => {
    const text = typeof source === "string" ? source.trim() : "";
    if (!text) return translator(source, kind);

    const field = args.fieldFor(text);
    if (!field) return translator(source, kind);

    const fromRelease = await resolveFromRelease(
      args.pinned,
      args.lookup,
      args.entityId as string,
      args.locale,
      field,
    );
    return fromRelease ?? translator(source, kind);
  };

  return wrapped as T;
}

/**
 * Is the release path actually serving for this request?
 *
 * Exported for operational logging and for the shadow comparison, so "why is
 * this page not coming from a release" has an answer that is not a guess.
 */
export function servingFromRelease(pinned: PinnedRelease): boolean {
  return pinned.mode === "serving" && pinned.generation !== null;
}
