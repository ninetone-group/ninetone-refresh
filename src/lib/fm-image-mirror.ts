/**
 * FileMaker image URL rewriter.
 *
 * FM `Streaming_SSL/RCFileProcessor` URLs rotate per API call AND expire with
 * the session token (~15 min). A static site can't refresh them at request
 * time, so we rewrite every FM image URL to point at our Cloudflare Worker
 * proxy, which holds a live FM session token and resolves a fresh URL on each
 * request.
 *
 * The proxy is the runtime layer the static site lacks. See worker-fm-proxy/.
 *
 * Build-time only — never imported by client code.
 */

const FM_STREAMING_RE = /^https?:\/\/files\.ninetone\.com\/Streaming_SSL\//i;

const PROXY_BASE = (
  import.meta.env.FM_IMAGE_PROXY_BASE ??
  "https://ninetone-fm-image-proxy.ninetone.workers.dev"
).replace(/\/$/, "");

// Map (FM layout) → (proxy "kind" route segment). Layouts not in this map
// won't have their image URLs rewritten — the original FM URL passes through,
// which will 401 once the session token rotates. That's fine for layouts
// without public-facing image consumers; if a future layout needs proxying,
// add it here AND add the matching route in worker-fm-proxy/src/index.ts.
interface LayoutConfig {
  kind: string;
  slugField: string;
}

const LAYOUT_CONFIG: Record<string, LayoutConfig> = {
  // SLUG (uppercase) is the identifier on roster/detail layouts.
  API_ARTIST: { kind: "artist", slugField: "SLUG" },
  API_ARTIST_DETAIL: { kind: "artist", slugField: "SLUG" },
  API_Management: { kind: "client", slugField: "SLUG" },
  API_CLIENT: { kind: "client", slugField: "SLUG" },
  API_CLIENT_DETAIL: { kind: "client", slugField: "SLUG" },
  API_Booking: { kind: "booking", slugField: "SLUG" },
  API_BOOKING: { kind: "booking", slugField: "SLUG" },
  API_BOOKING_DETAIL: { kind: "booking", slugField: "SLUG" },
  API_BOOKING_TAG: { kind: "booking", slugField: "SLUG" },
  // News uses lowercase `slug`.
  API_NEWS: { kind: "news", slugField: "slug" },
  API_WEBPOSTS: { kind: "news", slugField: "slug" },
  API_USERS: { kind: "team", slugField: "SLUG" },
};

// Map FM field name → proxy "variant" route segment.
const FIELD_TO_VARIANT: Record<string, string> = {
  artistPicture_big: "big",
  artistPicture_small: "small",
  "Artist Presentation Picture": "big",
  artistPresentationPicture: "big",
  image_webp: "cover",
  userPhoto: "big",
  userPhotoSmall: "small",
};

interface MirrorContext {
  /** FM layout the records came from. Drives kind + slug field via LAYOUT_CONFIG. */
  layout: string;
}

function rewrite(kind: string, slug: string, variant: string): string {
  return `${PROXY_BASE}/${kind}/${encodeURIComponent(slug)}/${variant}`;
}

/**
 * Walk a record (or array of records) and replace every FM streaming URL with
 * a proxy URL keyed on the record's slug. Mutates in place. Skips records
 * missing the slug field — those keep the original URL (which will 401 later,
 * but at least nothing crashes).
 */
export async function mirrorRecordImages<T>(records: T, ctx: MirrorContext): Promise<T> {
  const config = LAYOUT_CONFIG[ctx.layout];
  if (!config) return records; // unmapped layout, leave URLs alone
  const { kind, slugField } = config;

  // Strip a possible "Tablename::" prefix from a portal field name. FM portal
  // rows return keys like "Green HeadArtist::artistPicture_big" — we want the
  // bare "artistPicture_big" so it matches FIELD_TO_VARIANT and the slug
  // extraction below.
  const bareField = (k: string): string => {
    const idx = k.indexOf("::");
    return idx === -1 ? k : k.slice(idx + 2);
  };

  // Find slug at this object level, checking both bare field name and any
  // prefixed variants (portal rows).
  const findSlug = (rec: Record<string, unknown>): string | undefined => {
    if (typeof rec[slugField] === "string") return rec[slugField] as string;
    for (const k of Object.keys(rec)) {
      if (bareField(k) === slugField && typeof rec[k] === "string") return rec[k] as string;
    }
    return undefined;
  };

  const walk = (obj: unknown, parentSlug?: string) => {
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, parentSlug);
      return;
    }
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;

    // FM record shape from fmFind: each row may be a flat fieldData blob, or
    // a wrapper { fieldData, portalData } from fmFindWithPortals. Pull slug
    // from whichever level has it.
    const fieldData = (rec.fieldData ?? rec) as Record<string, unknown>;
    const slug = parentSlug ?? findSlug(fieldData);

    for (const k of Object.keys(rec)) {
      const v = rec[k];
      if (typeof v === "string" && FM_STREAMING_RE.test(v)) {
        const variant = FIELD_TO_VARIANT[bareField(k)];
        if (variant && slug) {
          rec[k] = rewrite(kind, slug, variant);
        }
        // Unknown field: leave original URL. Will likely 401 later but won't crash.
      } else if (v && typeof v === "object") {
        // For portal rows, each row has its own slug field — don't carry
        // parent slug down. Only pass parentSlug when descending into nested
        // wrappers like { fieldData, portalData } on the same record.
        const isPortalContainer = k === "portalData";
        walk(v, isPortalContainer ? undefined : slug);
      }
    }

    // Nested fieldData / portalData rows: fieldData carries the same slug.
    if (fieldData !== rec) walk(fieldData, slug);
  };
  walk(records);
  return records;
}
