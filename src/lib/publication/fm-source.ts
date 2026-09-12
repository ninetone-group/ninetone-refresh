/**
 * FileMaker -> SourceRecord adapter. The production `loadRecords` the
 * publication flow was always injected with, and never had.
 *
 * WHAT THIS IS FOR. `discovery.ts` takes `loadRecords: () => Promise<readonly
 * SourceRecord[]>` and every other layer is pure logic over the result. Until
 * this module existed, only test fakes supplied it.
 *
 * ALL-OR-NOTHING, DELIBERATELY. `discover()` defaults `inventoryComplete` to
 * false because membership-based removal is the one operation where a partial
 * read is catastrophic: a truncated FM response would look like every record
 * was deleted and withdraw the whole site. So `loadSourceRecords()` returns an
 * explicit `complete` flag and NEVER silently drops a failed layout — if a
 * fetch throws, the flag goes false and the caller must not treat absence as
 * deletion. This is the opposite of the warm script's per-artist
 * catch-and-continue, which is right for warming a cache and wrong here.
 *
 * FIELD NAMES ARE VERIFIED AGAINST LIVE FM, NOT INFERRED. `ENTITY_FIELDS` and
 * the warm script drifted apart once before (WebPosts titles were written on
 * the `quality` tier while `fmText()` read `fast`, so the keys were never
 * looked up). The names below were probed against the live Data API, with
 * populated-counts recorded in docs/translation-publication-progress.md.
 * Getting one wrong does not fail loudly — `normalizeFields()` drops an absent
 * field and `jobsForSnapshot()` then emits no job for it, which validates
 * cleanly as a complete-but-empty release.
 *
 * WHY IT READS ninetone.ts RATHER THAN RAW FM FOR SOME KINDS. For artist,
 * previousArtist, client, bookingTalent, teamMember and newsPost, the getters
 * spread raw `fieldData`, so property names ARE FM field names and match
 * ENTITY_FIELDS directly. For bookingCategory and webPostSection, ninetone.ts
 * RENAMES on the way out (`breadBooking` -> `description`, `webPost::subject`
 * -> `subject`), and ENTITY_FIELDS was written against the post-rename shape.
 * Reading raw FM for those two would silently produce empty fields.
 */

import type { EntityKind, SourceRecord } from "./contracts.ts";
import { normalizeFields } from "./contracts.ts";
import { contentHashFor } from "./snapshot.ts";

/**
 * Prompt/key version folded into every content hash.
 *
 * Changing this re-hashes and re-translates EVERY record, so it changes only
 * when the translation prompt changes in a way that invalidates existing
 * output. It is deliberately separate from `TRANSLATION_KEY_VERSION` in
 * translate.ts: that one keys the translation CACHE (sha256(text) per target
 * and tier), while this one keys SOURCE VERSIONS. Bumping the cache version
 * discards translations; bumping this one only re-derives record identity.
 */
export const PROMPT_VERSION = "p1";

/** A section's own record, and its blocks, are separate publishable units. */
export const WEBPOST_SECTION_KIND: EntityKind = "webPostSection";

export interface LoadedRecords {
  readonly records: readonly SourceRecord[];
  /**
   * True only when EVERY layout was read successfully. The caller passes this
   * straight to `discover({ inventoryComplete })`; false means a disappearance
   * must not be read as a deletion.
   */
  readonly complete: boolean;
  /** Layouts that failed, for logging. Empty when `complete` is true. */
  readonly failures: readonly string[];
  /**
   * Structure a `SourceRecord` cannot carry: block ordering and parentage.
   *
   * `SourceRecord.fields` is `Record<string,string>` of TRANSLATABLE text only,
   * and `ReleaseEntity` has no ordering field, so the position of a webPost
   * block inside its section has nowhere to live on the record itself. Keeping
   * it here — rather than smuggling it into a field or relying on array order
   * surviving JSON round-trips — means rendering can reconstruct a section
   * exactly without re-reading FM.
   */
  readonly blockOrder: readonly BlockPlacement[];
  /** Per-entity protected names, frozen into snapshots by the caller. */
  readonly protectedNames: Readonly<Record<string, readonly string[]>>;
}

/** Where one webPost block sits inside its section. */
export interface BlockPlacement {
  /** Kind-qualified ref of the block record. */
  readonly ref: string;
  /** Kind-qualified ref of the section the block belongs to. */
  readonly parentRef: string;
  /** Position within the section, ascending. See `blockOrderOf`. */
  readonly order: number;
}

/** The ninetone.ts getters this adapter needs, injected so it stays testable. */
export interface FmGetters {
  getArtists(): Promise<readonly Record<string, unknown>[]>;
  getPreviousArtists(): Promise<readonly Record<string, unknown>[]>;
  getClients(): Promise<readonly Record<string, unknown>[]>;
  getBookingRoster(): Promise<readonly Record<string, unknown>[]>;
  getTeam(): Promise<readonly Record<string, unknown>[]>;
  getNews(): Promise<readonly Record<string, unknown>[]>;
  getBookingCategories(): Promise<readonly BookingCategoryLike[]>;
  getWebPosts(category?: string): Promise<readonly WebPostCategoryLike[]>;
}

export interface BookingCategoryLike {
  readonly tag: string;
  readonly description: string;
  readonly artists?: readonly { readonly slug?: string; readonly name?: string }[];
}

export interface WebPostCategoryLike {
  readonly category: string;
  readonly title: string;
  readonly blocks: readonly WebPostBlockLike[];
}

export interface WebPostBlockLike {
  readonly subject?: string;
  readonly message?: string;
  /** FM portal row id — stable block identity. See `blockIdOf`. */
  readonly recordId?: string | number;
}

export interface LoadDeps {
  readonly getters: FmGetters;
  readonly hash: (input: string) => Promise<string>;
  readonly promptVersion?: string;
  /** Swallows and records a layout failure instead of throwing. */
  readonly onFailure?: (layout: string, error: unknown) => void;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * Stable block identity inside a webPost section.
 *
 * Probed against live FM: portal rows carry a `recordId` that is unique across
 * ALL sections (31 blocks, 31 distinct ids, zero collisions), so it is real
 * identity rather than a positional accident. `fmFindWithPortals` currently
 * discards it, which is why `guides.ts` had to slugify the subject instead —
 * and why editing a guide's title there changes its id, producing a phantom
 * delete plus a phantom create rather than an update.
 *
 * Falls back to the ordinal ONLY when no recordId is present, so a portal
 * shape without ids still produces deterministic (if edit-fragile) ids rather
 * than throwing.
 */
export function blockIdOf(section: string, block: WebPostBlockLike, index: number): string {
  const raw = block.recordId;
  const id = raw == null || raw === "" ? `idx${index}` : String(raw);
  return `${section}#${id}`;
}

/**
 * Ordering for a section's blocks.
 *
 * ORDER IS POSITIONAL, NOT `sortOrder`. Probed live: `webPost::sortOrder` holds
 * a TIMESTAMP string ("02/14/2025 16:08:55") in all 31 rows, never a number, so
 * `getWebPosts()`'s `Number(raw)` yields NaN and every row collapses to
 * MAX_SAFE_INTEGER — the sort is a total no-op and the real order is FM's
 * portal order. That is a pre-existing rendering quirk, recorded in the
 * progress doc and deliberately NOT changed here (fixing it would change what
 * the site renders, which is not this checkpoint's job).
 *
 * So this adapter preserves the order it is given rather than inventing one,
 * and records it explicitly so a release can reproduce it without depending on
 * array order surviving serialization.
 */
export function blockOrderOf(index: number): number {
  return index;
}

/** One record per publishable unit, assembled and hashed. */
async function makeRecord(
  deps: LoadDeps,
  kind: EntityKind,
  id: string,
  raw: Record<string, unknown>,
  options: { readonly active?: boolean; readonly references?: readonly string[] } = {},
): Promise<SourceRecord> {
  const base = {
    kind,
    id,
    fields: normalizeFields(kind, raw),
    references: options.references ? [...options.references] : [],
    active: options.active ?? true,
  };
  const hash = await contentHashFor(deps, base, deps.promptVersion ?? PROMPT_VERSION);
  return { ...base, hash };
}

/**
 * Load every publishable record from FileMaker.
 *
 * Each layout is read independently so one failure does not hide the others,
 * but ANY failure clears `complete` — see the file comment.
 */
export async function loadSourceRecords(deps: LoadDeps): Promise<LoadedRecords> {
  const records: SourceRecord[] = [];
  const failures: string[] = [];
  const blockOrder: BlockPlacement[] = [];
  const protectedNames: Record<string, readonly string[]> = {};

  const remember = (kind: EntityKind, id: string, raw: Readonly<Record<string, unknown>>): void => {
    const names = protectedNamesFor(kind, raw);
    if (names.length) protectedNames[`${kind}:${id}`] = names;
  };

  const attempt = async (layout: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(layout);
      deps.onFailure?.(layout, error);
    }
  };

  // --- Slug-identified entities -------------------------------------------
  //
  // Identity fields were probed live and are 100% populated and unique:
  // SLUG on artists (33), clients (37), booking (72), team (17); lowercase
  // `slug` on news (77). A record with no id is skipped rather than given a
  // synthetic one — a synthetic id would change whenever the data moved and
  // produce phantom deletes.
  const slugKinds: {
    kind: EntityKind;
    layout: string;
    idField: string;
    load: () => Promise<readonly Record<string, unknown>[]>;
  }[] = [
    { kind: "artist", layout: "API_ARTIST", idField: "SLUG", load: deps.getters.getArtists },
    {
      kind: "previousArtist",
      layout: "API_ARTIST(previous)",
      idField: "SLUG",
      load: deps.getters.getPreviousArtists,
    },
    { kind: "client", layout: "API_Management", idField: "SLUG", load: deps.getters.getClients },
    {
      kind: "bookingTalent",
      layout: "API_Booking",
      idField: "SLUG",
      load: deps.getters.getBookingRoster,
    },
    { kind: "teamMember", layout: "API_USERS", idField: "SLUG", load: deps.getters.getTeam },
    // News uses a LOWERCASE `slug`; `SLUG` is 0/77 on this layout.
    { kind: "newsPost", layout: "API_NEWS", idField: "slug", load: deps.getters.getNews },
  ];

  for (const spec of slugKinds) {
    await attempt(spec.layout, async () => {
      const rows = await spec.load();
      for (const row of rows) {
        const id = str(row[spec.idField]).trim();
        if (!id) continue;
        records.push(await makeRecord(deps, spec.kind, id, row));
        remember(spec.kind, id, row);
      }
    });
  }

  // --- Booking categories -------------------------------------------------
  //
  // ninetone.ts RENAMES `breadBooking` -> `description`, and ENTITY_FIELDS
  // lists `description`, so this reads the mapped shape. `Tag` is 0/72 on
  // API_Booking, so the tag comes from the category record, not the roster.
  await attempt("API_BOOKING_TAG", async () => {
    const categories = await deps.getters.getBookingCategories();
    for (const category of categories) {
      const id = str(category.tag).trim();
      if (!id) continue;
      records.push(
        await makeRecord(deps, "bookingCategory", id, { description: category.description }),
      );
      remember("bookingCategory", id, { tag: category.tag });
    }
  });

  // --- WebPost sections and their blocks ----------------------------------
  //
  // MODELLED SEPARATELY, per the decision recorded in the progress doc. A
  // section record carries the section's own `title`; each portal row becomes
  // its own record carrying `subject` + `message`.
  //
  // Why not one record per section with the blocks concatenated: SourceRecord.
  // fields is Record<string,string> with no arrays, so 3-6 blocks would have
  // to be flattened into one field. Editing one block would then change the
  // whole section's hash and re-translate every other block with it — paid
  // work for text that did not change. Separate records keep the blast radius
  // of an edit to the block that was edited.
  //
  // Ordering and parentage are preserved explicitly: `order` is the block's
  // position in the section's already-sorted array, and each block REFERENCES
  // its parent section so `selectPublishable()` cannot publish a block whose
  // section is not ready.
  await attempt("API_WEBPOSTS", async () => {
    const sections = await deps.getters.getWebPosts("*");
    for (const section of sections) {
      const sectionId = str(section.category).trim();
      if (!sectionId) continue;

      const blockRefs = section.blocks.map(
        (block, index) => `${WEBPOST_SECTION_KIND}:${blockIdOf(sectionId, block, index)}`,
      );

      // Section record: its own title only. `subject`/`message` belong to
      // blocks, so normalizeFields drops them here.
      records.push(
        await makeRecord(
          deps,
          WEBPOST_SECTION_KIND,
          sectionId,
          { title: section.title },
          { references: blockRefs },
        ),
      );

      // Block records, in section order.
      const parentRef = `${WEBPOST_SECTION_KIND}:${sectionId}`;
      for (const [index, block] of section.blocks.entries()) {
        const blockId = blockIdOf(sectionId, block, index);
        records.push(
          await makeRecord(
            deps,
            WEBPOST_SECTION_KIND,
            blockId,
            { subject: block.subject, message: block.message },
            { references: [parentRef] },
          ),
        );
        blockOrder.push({
          ref: `${WEBPOST_SECTION_KIND}:${blockId}`,
          parentRef,
          order: blockOrderOf(index),
        });
      }
    }
  });

  return {
    records,
    complete: failures.length === 0,
    failures,
    blockOrder,
    protectedNames,
  };
}

/**
 * Protected names for a record — the entity's own name, which
 * `jobsForRecord()` cannot supply because contracts.ts has no FM knowledge.
 *
 * Kept separate from `buildProtectedTerms()` in translate.ts: that adds the
 * fixed list and the live booking-category tags at translation time. This
 * supplies only the per-entity part, which must be frozen into the snapshot so
 * a job carries it without re-reading FM.
 */
export function protectedNamesFor(
  kind: EntityKind,
  raw: Readonly<Record<string, unknown>>,
): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    const text = str(value).trim();
    if (text) names.add(text);
  };

  switch (kind) {
    case "artist":
    case "previousArtist":
    case "client":
    case "bookingTalent":
      add(raw["Head Artist"]);
      break;
    case "teamMember":
      add(raw.userNameCalc);
      break;
    case "bookingCategory":
      add(raw.tag);
      break;
    default:
      break;
  }
  return [...names];
}
