/**
 * Serving from a published generation — checkpoint 4 of
 * docs/translation-publication-implementation-handoff.md.
 *
 * One generation is resolved per request and every piece of content on that
 * page comes from it, so homepage, lists, detail pages, search and sitemap
 * cannot mix generations within a single render.
 *
 * SHADOW MODE IS THE DEFAULT, deliberately.
 *
 * The design's rollout step 2 says to generate and validate bundles in shadow
 * first, comparing their membership and fields against current output, before
 * anything serves from them. So `publicationMode()` returns "shadow" unless
 * PUBLICATION_SERVING is explicitly "on", and in shadow mode `lookup()` reports
 * what it WOULD have served without changing a single response. Switching a
 * live site's entire content source on the same deploy that first introduces
 * that source is not a risk worth taking, and the handoff is explicit that
 * current serving behaviour must be preserved until bootstrap and end-to-end
 * tests pass.
 *
 * NO LIVE FALLBACK. When a generation cannot be resolved, `lookup()` returns
 * `{ status: "unavailable" }` and the caller keeps doing exactly what it does
 * today. It never reaches into FileMaker for untranslated text — that is the
 * failure the whole design exists to prevent, and it would be the most
 * natural-looking mistake to make here.
 */

import type { Release, ReleaseEntity, Lang } from "./contracts.ts";
import { type ReleaseDeps, resolveGeneration, readRelease } from "./release.ts";

export type PublicationMode = "off" | "shadow" | "serving";

/**
 * Read the rollout mode from env.
 *
 * Defaults to "shadow" when the flag is absent rather than "serving": a missing
 * or misspelled variable must never silently switch the site's content source.
 */
export function publicationMode(env: Readonly<Record<string, unknown>> | null | undefined): PublicationMode {
  const raw = env?.PUBLICATION_SERVING;
  if (raw === "on" || raw === true) return "serving";
  if (raw === "off") return "off";
  return "shadow";
}

export interface LookupHit {
  readonly status: "hit";
  readonly generation: string;
  readonly entity: ReleaseEntity;
  readonly text: Readonly<Record<string, string>>;
}

export interface LookupMiss {
  readonly status: "miss";
  readonly generation: string;
}

export interface LookupUnavailable {
  readonly status: "unavailable";
}

export type LookupResult = LookupHit | LookupMiss | LookupUnavailable;

/**
 * A generation pinned for the lifetime of one request.
 *
 * Resolved once and reused, so two components on the same page cannot read
 * different generations — the "homepage, lists, detail pages, search and
 * sitemap cannot mix generations" requirement. Pinning also means a promotion
 * landing mid-render cannot split a single page across two versions.
 */
export interface RequestGeneration {
  readonly generation: string | null;
  readonly release: Release | null;
  /**
   * Newer approved generations this request may consult for an entity its own
   * generation lacks. Newest first.
   *
   * This closes the cross-request navigation hole the review reproduced: edge
   * A serves a new generation containing /artists/new while edge B still
   * serves the previous one, so a visitor following a link from A gets a 404
   * at B. Per-request pinning guarantees consistency WITHIN a render and
   * nothing across renders — my earlier claim that mixed generations were
   * "safe by construction" was too broad.
   *
   * Only APPROVED generations are consultable, so this cannot resurrect a
   * withdrawn record: a removal produces a new approved generation without it,
   * and older generations are never consulted for entities the current one
   * deliberately dropped (see `lookupWithFallback`).
   */
  readonly newerApproved: readonly string[];
}

export async function pinGeneration(
  deps: ReleaseDeps,
  options: { readonly newerApproved?: readonly string[] } = {},
): Promise<RequestGeneration> {
  const generation = await resolveGeneration(deps);
  if (!generation) return { generation: null, release: null, newerApproved: [] };
  const release = await readRelease(deps, generation);
  // A generation that resolves but does not read back is treated as absent
  // rather than as an empty site.
  if (!release) return { generation: null, release: null, newerApproved: [] };
  return { generation, release, newerApproved: options.newerApproved ?? [] };
}

/**
 * Resolve an entity, consulting NEWER approved generations when this request's
 * generation does not have it.
 *
 * Direction matters and is the safety property: only generations approved
 * AFTER this one are consulted. Looking backwards would resurrect withdrawn
 * records, since an older generation still contains what a removal dropped.
 * Looking forward can only surface something already approved for publication.
 */
export async function lookupWithFallback(
  deps: ReleaseDeps,
  pinned: RequestGeneration,
  entityId: string,
  locale: Lang,
): Promise<LookupResult> {
  const direct = lookup(pinned, entityId, locale);
  if (direct.status !== "miss") return direct;

  for (const generation of pinned.newerApproved) {
    if (generation === pinned.generation) continue;
    const release = await readRelease(deps, generation);
    const entity = release?.entities.find((e) => e.id === entityId);
    if (entity) {
      return { status: "hit", generation, entity, text: entity.text[locale] ?? {} };
    }
  }
  return direct;
}

export function lookup(pinned: RequestGeneration, entityId: string, locale: Lang): LookupResult {
  if (!pinned.release || !pinned.generation) return { status: "unavailable" };

  const entity = pinned.release.entities.find((e) => e.id === entityId);
  if (!entity) return { status: "miss", generation: pinned.generation };

  return {
    status: "hit",
    generation: pinned.generation,
    entity,
    text: entity.text[locale] ?? {},
  };
}

/** Does this release serve the given route? Used to decide 404 vs render. */
export function hasRoute(pinned: RequestGeneration, path: string): boolean {
  return Boolean(pinned.release?.routes.includes(path));
}

export interface ShadowComparison {
  readonly generation: string | null;
  /** Entities the release has that live rendering did not produce. */
  readonly onlyInRelease: readonly string[];
  /** Entities live rendering produced that the release lacks. */
  readonly onlyInLive: readonly string[];
  /** Entity ids present in both but whose text differs for some field. */
  readonly differing: readonly string[];
}

/**
 * Compare a prepared release against what the site currently renders.
 *
 * This is the whole point of shadow mode: run it for a while, confirm the
 * membership and field sets agree, and only then flip PUBLICATION_SERVING.
 * Reporting a difference is not automatically a defect — a release
 * legitimately withholds an entity whose translations are still preparing —
 * which is why this returns the three sets rather than a boolean verdict.
 */
export function compareShadow(
  pinned: RequestGeneration,
  liveEntities: readonly { id: string; text: Readonly<Record<Lang, Readonly<Record<string, string>>>> }[],
): ShadowComparison {
  if (!pinned.release) {
    return {
      generation: null,
      onlyInRelease: [],
      onlyInLive: liveEntities.map((e) => e.id),
      differing: [],
    };
  }

  const releaseById = new Map(pinned.release.entities.map((e) => [e.id, e]));
  const liveById = new Map(liveEntities.map((e) => [e.id, e]));

  const onlyInRelease = [...releaseById.keys()].filter((id) => !liveById.has(id));
  const onlyInLive = [...liveById.keys()].filter((id) => !releaseById.has(id));

  const differing: string[] = [];
  for (const [id, live] of liveById) {
    const entity = releaseById.get(id);
    if (!entity) continue;
    for (const locale of ["sv", "en"] as const) {
      const a = entity.text[locale] ?? {};
      const b = live.text[locale] ?? {};
      const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
      if ([...fields].some((f) => (a[f] ?? "") !== (b[f] ?? ""))) {
        differing.push(id);
        break;
      }
    }
  }

  return { generation: pinned.generation, onlyInRelease, onlyInLive, differing };
}

// ---------------------------------------------------------------------------
// Deploy gating (handoff: "Deployments must prepare and validate new UI
// translations before activating that release")
// ---------------------------------------------------------------------------

export interface ChromeGateResult {
  readonly ready: boolean;
  /** Chrome strings with no translation in one or both locales. */
  readonly missing: readonly { readonly source: string; readonly locale: Lang }[];
}

/**
 * Is the chrome for THIS build fully translated?
 *
 * A deploy that introduces new UI copy must not activate its release until
 * that copy exists in both locales. Without this gate the new strings would
 * fall back to source at render time — which is precisely the visitor-facing
 * untranslated text the whole design removes.
 *
 * Deliberately takes the string list as an argument rather than discovering it
 * here: the authoritative list comes from instrumenting a build
 * (I18N_CAPTURE_CHROME_STRINGS), because source parsing misses strings passed
 * from mapped literals — the header nav, homepage portals and metrics panel
 * were all invisible to the parser and render on every page.
 */
export function chromeGate(
  chromeStrings: readonly string[],
  translated: Readonly<Record<string, Readonly<Record<Lang, string | undefined>>>>,
): ChromeGateResult {
  const missing: { source: string; locale: Lang }[] = [];
  for (const source of chromeStrings) {
    for (const locale of ["sv", "en"] as const) {
      const value = translated[source]?.[locale];
      if (value === undefined || value.trim() === "") missing.push({ source, locale });
    }
  }
  return { ready: missing.length === 0, missing };
}

/**
 * Should this release be activated for serving?
 *
 * Combines the content gate (the release validates) with the chrome gate and
 * the rollout mode. Returns a reason rather than a bare boolean so operational
 * status can say WHY a deploy is not serving yet — "preparing" and "broken"
 * need very different responses.
 */
export function activationDecision(args: {
  readonly mode: PublicationMode;
  readonly releaseValid: boolean;
  readonly chrome: ChromeGateResult;
  readonly generation: string | null;
}): { readonly activate: boolean; readonly reason: string } {
  if (args.mode !== "serving") return { activate: false, reason: `mode:${args.mode}` };
  if (!args.generation) return { activate: false, reason: "no-generation" };
  if (!args.releaseValid) return { activate: false, reason: "release-invalid" };
  if (!args.chrome.ready) {
    return { activate: false, reason: `chrome-missing:${args.chrome.missing.length}` };
  }
  return { activate: true, reason: "ready" };
}
