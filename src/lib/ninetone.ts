/**
 * Ninetone domain wrappers around the FileMaker Data API.
 *
 * Field types are loose (Record<string, unknown>) until we have sample
 * responses — once we do, replace with strict shapes.
 */

import { fmFind, fmFindWithPortals } from "./filemaker";
import { isActiveBookingArtist } from "./booking-status";

export type Artist = Record<string, unknown> & {
  SLUG?: string;
  "Head Artist"?: string;
  artistPresentationShort?: string;
  /** Section-level intro text (markdown). Same value duplicated across all
   * rows on a given list endpoint. Field name varies per layout:
   *   API_ARTIST    → readMore
   *   API_Management → readMoreClients
   *   API_Booking   → readMoreBooking */
  readMore?: string;
  readMoreClients?: string;
  readMoreBooking?: string;
  "Artist Presentation Title"?: string;
  clientPresentationTitle?: string;
  bookingPresentationTitle?: string;
  filterActive?: string;
  filterType?: string;
};

export type ArtistDetail = Artist & Record<string, unknown>;

export type WebPost = Record<string, unknown> & {
  SLUG?: string;
  category?: string;
  title?: string;
  publishDate?: string;
};

export type TeamMember = Record<string, unknown> & {
  SLUG?: string;
  Active?: string;
  sortOrder?: string;
};

// API_ARTIST — roster list (Records active artists)
export function getArtists() {
  return fmFind<Artist>("API_ARTIST", {
    query: [
      {
        filterActive: "==Active",
        filterType: "Music",
        SLUG: "*",
        letterSearch: "==**",
        "Head Artist": "*",
      },
    ],
    sort: [
      { fieldName: "highLight_music", sortOrder: "descend" },
      { fieldName: "Head Artist", sortOrder: "ascend" },
    ],
    limit: 500,
  });
}

// API_ARTIST_DETAIL — single artist + portal data (releases, etc.)
export function getArtistBySlug(slug: string) {
  return fmFind<ArtistDetail>("API_ARTIST_DETAIL", {
    query: [{ filterActive: "==*", SLUG: slug }],
    limit: 1,
  }).then((rows) => rows[0]);
}

// ---------------------------------------------------------------------------
// Releases (discography)
// ---------------------------------------------------------------------------
// Each artist record has a `Green Web Category` portal listing every release
// (Single / EP / Album) with cover art, release date, smart link, and
// per-platform streaming URLs. Plus `Green Web Album::spotifyPitch` and
// `socialMedia` carry the editorial copy the label wrote at release time.

export type ArtistRelease = {
  album: string;
  type: string; // "Single" | "Ep" | "Album"
  releaseDate: string; // FM format MM/DD/YYYY
  cover: string; // streaming URL — gets rewritten to proxy at build time
  pitch: string; // promotional copy from Green Web Album::spotifyPitch
  social: string; // social-media voice copy
  urlRelease: string; // Linkfire-style smart link (preferred CTA)
  streaming: {
    spotify?: string;
    apple?: string;
    amazon?: string;
    youtubeMusic?: string;
    tidal?: string;
  };
};

export type ArtistDetailWithReleases = {
  fieldData: ArtistDetail;
  releases: ArtistRelease[];
};

function pickReleasePortal(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return v ? String(v) : "";
}

// Parse FM date "MM/DD/YYYY" into a Date for sorting. Returns epoch 0 on
// failure so releases with missing dates sort to the end of a
// newest-first (descending) list.
function parseFmDate(s: string): number {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  const [, mm, dd, yyyy] = m;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd)).getTime();
}

// URL for a release cover, keyed by (artist slug, album name). The Worker
// resolves the matching portal row and streams fresh FM bytes per request —
// see worker-fm-proxy/src/index.ts (release/by-album route). Album identity is
// stable across FM edits; the previous positional-index scheme shifted every
// cover by one whenever a release was added or re-dated after a build.
function releaseCoverUrl(slug: string, album: string): string {
  const PROXY_BASE = (
    import.meta.env.FM_IMAGE_PROXY_BASE ??
    "https://ninetone-fm-image-proxy.ninetone.workers.dev"
  ).replace(/\/$/, "");
  return `${PROXY_BASE}/release/${encodeURIComponent(slug)}/by-album/${encodeURIComponent(album)}`;
}

// Pull artist + releases (portalData) by slug. Used by detail pages that
// render a discography. Active or previous, single round-trip.
export async function getArtistDetailWithReleases(slug: string): Promise<ArtistDetailWithReleases | null> {
  const rows = await fmFindWithPortals<ArtistDetail>("API_ARTIST_DETAIL", {
    query: [{ filterActive: "==*", SLUG: slug }],
    limit: 1,
    // FM caps portal rows at whatever the layout's portal shows unless told
    // otherwise — be explicit so a prolific discography never truncates.
    portal: ["Green Web Category"],
    portalLimits: { "Green Web Category": 500 },
  });
  const row = rows[0];
  if (!row) return null;

  const portal = (row.portalData?.["Green Web Category"] ?? []) as Record<string, unknown>[];
  const releases: ArtistRelease[] = portal
    .map((r) => ({
      album: pickReleasePortal(r, "Green Web Category::Album"),
      type: pickReleasePortal(r, "Green Web Category::Type"),
      releaseDate: pickReleasePortal(r, "Green Web Category::Releasedate First"),
      cover: "",
      pitch: pickReleasePortal(r, "Green Web Album::spotifyPitch"),
      social: pickReleasePortal(r, "Green Web Album::socialMedia"),
      urlRelease: pickReleasePortal(r, "Green Web Category::urlRelease"),
      streaming: {
        spotify: pickReleasePortal(r, "Green Web Category::urlSpotify") || undefined,
        apple: pickReleasePortal(r, "Green Web Category::urlAppleMusic") || undefined,
        amazon: pickReleasePortal(r, "Green Web Category::urlAmazonMusic") || undefined,
        youtubeMusic: pickReleasePortal(r, "Green Web Category::urlYoutubeMusic") || undefined,
        tidal: pickReleasePortal(r, "Green Web Category::urlTidal") || undefined,
      },
    }))
    .filter((r) => r.album)
    .sort((a, b) => parseFmDate(b.releaseDate) - parseFmDate(a.releaseDate))
    .map((r) => ({ ...r, cover: releaseCoverUrl(slug, r.album) }));

  return { fieldData: row.fieldData, releases };
}

// Previous artists — same layout, "Not Active". 342 records as of writing,
// so we set a generous ceiling for build-time fetch.
export function getPreviousArtists() {
  return fmFind<ArtistDetail>("API_ARTIST_DETAIL", {
    query: [
      {
        filterActive: "==Not Active",
        filterType: "Music",
        SLUG: "*",
        artistPresentationShort: "*",
        "Head Artist": "==**",
      },
    ],
    sort: [{ fieldName: "Head Artist", sortOrder: "ascend" }],
    offset: "1",
    limit: 1000,
    // List view never reads releases — skip the portal payload on 340+ records.
    portal: [],
  });
}

// API_WEBPOSTS — section-level SEO content. Each FM record represents one
// section (Ninetone Group, Records, Management, Nation, Team, Blog) and the
// per-section text blocks live in the `webPost` portal table.
export type WebPostBlock = {
  subject: string;
  message: string;
  image?: string;
  date?: string;
  ytLinks: string[];
  /**
   * FM's portal-row id — stable identity for this block.
   *
   * Unlike the block's other fields this is NOT prefixed `webPost::`; FM puts
   * it at the row's top level, so `pickStr` cannot reach it. Verified against
   * the live Data API: 31 blocks across the 6 sections carry 31 distinct ids,
   * so it is genuine identity rather than a positional accident.
   *
   * Added for the publication flow (src/lib/publication/fm-source.ts), which
   * needs a block id that survives an edit — deriving identity from the
   * subject, the way src/lib/guides.ts must, means renaming a block reads as
   * a delete plus an unrelated create. Optional and unused by rendering, so
   * nothing about the current pages changes.
   */
  recordId?: string;
};

export type WebPostCategory = {
  category: string;
  title: string;
  blocks: WebPostBlock[];
};

export type WebPostSection =
  | "Ninetone Group"
  | "Ninetone Records"
  | "Ninetone Management"
  | "Ninetone Nation"
  | "Ninetone Group Team"
  | "Ninetone Blog";

function pickStr(row: Record<string, unknown>, key: string): string {
  const v = row[`webPost::${key}`];
  return v ? String(v) : "";
}

export async function getWebPosts(category: string = "*"): Promise<WebPostCategory[]> {
  const records = await fmFindWithPortals<{ category?: string; title?: string; readMore?: string }>(
    "API_WEBPOSTS",
    {
      query: [{ category }],
      limit: 100,
      // The layout's portal shows only 2 rows, and FM returns exactly that
      // many unless told otherwise — every section was silently rendering
      // 2 of its 3–6 content blocks before this was set. Verified 2026-07-02.
      portal: ["webPost"],
      portalLimits: { webPost: 500 },
    },
  );

  return records.map((r) => {
    const portalRows = (r.portalData?.webPost ?? []) as Record<string, unknown>[];
    // Portal rows carry an explicit editor-controlled ordering field. Sort by
    // it (numeric ascending, blanks last); stable sort keeps FM's portal
    // order for ties.
    const orderOf = (row: Record<string, unknown>): number => {
      const raw = pickStr(row, "sortOrder");
      const n = Number(raw);
      return raw !== "" && Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
    };
    const blocks: WebPostBlock[] = [...portalRows]
      .sort((a, b) => orderOf(a) - orderOf(b))
      .map((row) => ({
        subject: pickStr(row, "subject"),
        message: pickStr(row, "message"),
        image: pickStr(row, "image_webp") || undefined,
        date: pickStr(row, "date") || undefined,
        ytLinks: ["ytLinkA", "ytLinkB", "ytLinkC", "ytLinkD"]
          .map((k) => pickStr(row, k))
          .filter(Boolean),
        // Top-level on the portal row, not `webPost::`-prefixed — see the
        // WebPostBlock.recordId comment.
        recordId: row.recordId == null ? undefined : String(row.recordId),
      }))
      .filter((b) => b.subject || b.message);

    return {
      category: String(r.fieldData.category ?? ""),
      title: String(r.fieldData.title ?? ""),
      blocks,
    };
  });
}

/** Convenience: fetch one section by exact category name. */
export async function getWebPostSection(category: WebPostSection): Promise<WebPostCategory | null> {
  const all = await getWebPosts();
  return all.find((c) => c.category === category) ?? null;
}

// API_NEWS — news feed for /news, sorted newest-first. 76 posts as of
// 2026-07-02 — without the explicit limit, FM's default of 100 would start
// silently dropping the oldest posts (and their pages) at post #101.
export function getNews() {
  return fmFind<WebPost>("API_NEWS", {
    query: [{ Message: "*" }],
    sort: [{ fieldName: "Date", sortOrder: "descend" }],
    limit: 500,
  });
}

/**
 * Get news posts that mention a specific artist.
 *
 * Originally one FM substring search per artist (~450 calls/build). We now
 * fetch the full news list once (cached) and filter locally — same case-
 * insensitive substring match FM does on the `Message` field.
 */
export async function getNewsForArtist(artistName: string, limit = 3): Promise<WebPost[]> {
  if (!artistName) return [];
  const all = await getNews();
  const needle = artistName.toLowerCase();
  return all
    .filter((p) => String(p.Message ?? "").toLowerCase().includes(needle))
    .slice(0, limit);
}

// API_USERS — team members
export function getTeam() {
  return fmFind<TeamMember>("API_USERS", {
    query: [{ Active: "==Ja", SLUG: "*" }],
    sort: [{ fieldName: "sortOrder", sortOrder: "ascend" }],
    limit: 500,
  });
}

// API_Management — management clients
export function getClients() {
  return fmFind<Artist>("API_Management", {
    query: [
      {
        filterActive: "==Active",
        filterTypeCombine: "Management",
        SLUG: "*",
        "Head Artist": "*",
      },
    ],
    sort: [
      { fieldName: "highLight_client", sortOrder: "descend" },
      { fieldName: "Head Artist", sortOrder: "ascend" },
    ],
    limit: 500,
  });
}

// API_Booking — Ninetone Nation entertainers (artists + förläsare)
export function getBookingRoster() {
  return fmFind<Artist>("API_Booking", {
    query: [
      {
        filterActive: "==Active",
        filterType: "Booking",
        SLUG: "*",
        filterTypeCombine: "==***",
        tagBooking: "*",
      },
    ],
    limit: 500,
  }).then((rows) => rows.filter(isActiveBookingArtist));
}

// ---------------------------------------------------------------------------
// API_BOOKING_TAG — Nation booking categorized by tag (Artist / Föreläsare /
// Konferencier / Moderator / Underhållare / Influencer). Each FM record is one
// category, and the bookable artists for that category live in the
// `Green HeadArtist` portal table.
// ---------------------------------------------------------------------------

export type BookingCategoryArtist = {
  slug: string;
  name: string;
  imageBig?: string;
  imageSmall?: string;
  blurb: string;
  tagline: string;
  highlight: boolean;
  socials: {
    spotify?: string;
    apple?: string;
    youtubeMusic?: string;
    youtube?: string;
    instagram?: string;
    tiktok?: string;
    twitter?: string;
    facebook?: string;
  };
};

export type BookingCategory = {
  /** Category name (e.g. "Artist", "Föreläsare"). */
  tag: string;
  /** Swedish description blurb shown in the section head. */
  description: string;
  /** All bookable artists tagged with this category. May contain duplicates
   *  across categories — that's intentional, an artist bookable as both an
   *  Artist and a Föreläsare appears in both sections. */
  artists: BookingCategoryArtist[];
};

function pickPortal(row: Record<string, unknown>, key: string): string {
  const v = row[`Green HeadArtist::${key}`];
  return v ? String(v) : "";
}

export async function getBookingCategories(): Promise<BookingCategory[]> {
  const records = await fmFindWithPortals<{ tagBooking?: string; breadBooking?: string }>(
    "API_BOOKING_TAG",
    {
      query: [{ tagBooking: "*" }],
      limit: 100,
      portal: ["Green HeadArtist"],
      portalLimits: { "Green HeadArtist": 500 },
    },
  );

  return records.map((r) => {
    const portalRows = (r.portalData?.["Green HeadArtist"] ?? []) as Record<string, unknown>[];
    // Only show currently-active talents. Not Active = booked through us in
    // the past but not pitchable today. Hides them from the list page AND
    // from getAllActiveBookingSlugs below (single-page generator), so the
    // two stay in lockstep.
    const activeRows = portalRows.filter(isActiveBookingArtist);
    const artists: BookingCategoryArtist[] = activeRows
      .map((row) => ({
        slug: pickPortal(row, "SLUG"),
        name: pickPortal(row, "Head Artist"),
        imageBig: pickPortal(row, "artistPicture_big") || undefined,
        imageSmall: pickPortal(row, "artistPicture_small") || undefined,
        blurb:
          pickPortal(row, "bookingPresentationShort") ||
          pickPortal(row, "clientPresentationShort") ||
          pickPortal(row, "artistPresentationShort"),
        tagline:
          pickPortal(row, "bookingPresentationTitle") ||
          pickPortal(row, "clientPresentationTitle") ||
          pickPortal(row, "Artist Presentation Title"),
        highlight: pickPortal(row, "highLight_client") === "true",
        socials: {
          spotify: pickPortal(row, "url_spotify") || undefined,
          apple: pickPortal(row, "url_applemusic") || undefined,
          youtubeMusic: pickPortal(row, "url_youtube_music") || undefined,
          youtube: pickPortal(row, "url_youtube_link") || undefined,
          instagram: pickPortal(row, "url_instagram") || undefined,
          tiktok: pickPortal(row, "url_tiktok_artist") || undefined,
          twitter: pickPortal(row, "url_twitter") || undefined,
          facebook: pickPortal(row, "url_facebook") || undefined,
        },
      }))
      .filter((a) => a.slug && a.name);

    return {
      tag: String(r.fieldData.tagBooking ?? ""),
      description: String(r.fieldData.breadBooking ?? ""),
      artists,
    };
  });
}

/**
 * The set of talents the Nation /booking list shows. Drives getStaticPaths on
 * /ninetone-nation/[slug].astro so the single-page set EXACTLY matches the
 * list — no orphan links, no 404s for booking-only talents (e.g. Quireboys,
 * Asta Kask) who pass the filter but have no Records or Management page.
 *
 * Uses getBookingCategories under the hood, so the Active filter applied
 * there also applies here.
 */
export async function getAllActiveBookingSlugs(): Promise<string[]> {
  const cats = await getBookingCategories();
  const seen = new Set<string>();
  for (const c of cats) {
    for (const a of c.artists) {
      if (a.slug) seen.add(a.slug);
    }
  }
  return [...seen];
}

/**
 * The full Nation booking page set: every active curated slug, its full
 * API_Booking record, and the union roster for "related" strips.
 *
 * Most curated talents also appear in getBookingRoster() (the strict query);
 * booking-only talents (e.g. Quireboys) are fetched individually by slug.
 * Used by /ninetone-nation/[slug].astro from BOTH paths — getStaticPaths on
 * the static preview and request-time resolution on the live Worker — so the
 * two can never drift.
 */
export async function getBookingPageSet(): Promise<{
  slugs: string[];
  records: Map<string, Record<string, unknown>>;
  allRoster: Record<string, unknown>[];
}> {
  const [slugs, roster] = await Promise.all([getAllActiveBookingSlugs(), getBookingRoster()]);

  const records = new Map<string, Record<string, unknown>>();
  for (const a of roster) {
    const s = String(a.SLUG ?? "");
    if (s) records.set(s, a);
  }

  const missing = slugs.filter((s) => !records.has(s));
  const extras = await Promise.all(
    missing.map((slug) =>
      fmFind<Record<string, unknown>>("API_Booking", {
        query: [{ SLUG: `==${slug}`, filterActive: "==Active" }],
        limit: 1,
      }).then((rows) => rows[0]),
    ),
  );
  for (const r of extras) {
    // Keep the local invariant even if a layout/query is changed in FM:
    // a detail page and its related-roster strip may only contain Active talent.
    if (r && r.SLUG && isActiveBookingArtist(r)) records.set(String(r.SLUG), r);
  }

  return { slugs, records, allRoster: [...records.values()] };
}

// ---------------------------------------------------------------------------
// Phase 2 helpers — promo bar + featured pickers
// ---------------------------------------------------------------------------

export type Promo = {
  /** Short label, e.g. "New release", "On tour", "Just signed". */
  label: string;
  /** One-line message — artist + title etc. */
  message: string;
  /** Optional URL the bar should link to. */
  href?: string;
};

/**
 * Promo bar content. Looks for a WebPosts category named "Promo" and uses its
 * first block: subject = label, message line 1 = message, message line 2 = URL.
 * Returns null if the category doesn't exist or has no usable block — the
 * PromoBar component then renders nothing.
 */
export async function getPromo(): Promise<Promo | null> {
  // We allow either a literal "Promo" category or a typed string fallback.
  // NB: errors propagate — Base.astro decides whether missing promo chrome
  // should take a page down (it doesn't; it catches and logs).
  const all = await getWebPosts();
  const cat = all.find((c) => c.category.toLowerCase() === "promo");
  const block = cat?.blocks[0];
  if (!block || !block.subject) return null;

  // Message field may contain "Headline\nhttps://link" — split.
  const lines = String(block.message ?? "")
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const message = lines.find((l) => !/^https?:\/\//i.test(l)) ?? "";
  const href = lines.find((l) => /^https?:\/\//i.test(l));

  if (!message) return null;
  return { label: block.subject, message, href };
}

/**
 * Top-N records artists, leveraging the existing highLight_music sort order
 * (already applied in getArtists). Returned as the home-page featured strip.
 */
export async function getFeaturedArtists(limit = 6): Promise<Artist[]> {
  const list = await getArtists();
  return list.slice(0, limit);
}

/**
 * "Client in focus" — the most recently added active management client.
 *
 * The public layouts expose no creation-date field, so we order by FM's
 * internal recordId (an ever-increasing serial attached as __recordId by
 * lib/filemaker.ts). Prefers clients that have an image, since the homepage
 * tile is image-led; falls back to the highlight-sorted list head if none
 * qualify. On the live site this updates within the homepage cache TTL of a
 * new client being added in FM — no deploy.
 */
export async function getLatestClient(): Promise<Artist | undefined> {
  const clients = await getClients();
  const byNewest = [...clients].sort(
    (a, b) => Number(b.__recordId ?? 0) - Number(a.__recordId ?? 0),
  );
  return byNewest.find((c) => c.artistPicture_big || c.artistPicture_small) ?? clients[0];
}

/**
 * "Artist in focus" — deterministic artist-of-the-week rotation.
 *
 * Same week → same artist for every visitor, build, and Worker isolate
 * (cache-friendly, no flicker between edge nodes). The week index flips on
 * Mondays 00:00 UTC: epoch day 0 was a Thursday, so +3 days aligns the
 * 7-day window to Monday starts. Pool = active roster with an image, in the
 * existing highlight-first order, so every artist gets a week and
 * highlighted artists cycle back sooner after roster changes.
 */
export async function getArtistOfTheWeek(): Promise<Artist | undefined> {
  const artists = await getArtists();
  const pool = artists.filter((a) => a.artistPicture_big || a.artistPicture_small);
  if (pool.length === 0) return artists[0];
  const weekIndex = Math.floor((Date.now() / 86_400_000 + 3) / 7);
  return pool[weekIndex % pool.length];
}

export async function getFeaturedClients(limit = 6): Promise<Artist[]> {
  const list = await getClients();
  return list.slice(0, limit);
}

export async function getFeaturedBooking(limit = 6): Promise<Artist[]> {
  const list = await getBookingRoster();
  return list.slice(0, limit);
}

/**
 * Pick "related" artists for a detail page strip — artists that share tags
 * with the current one, ranked by overlap. If there aren't enough overlap
 * matches to fill `limit`, top up with random others so the strip is never
 * sparse. The current artist is always excluded.
 *
 * `tagsOf` lets each division pass its own field extractor (Records uses
 * `genre`, Management uses `tags ?? genre`, Nation uses
 * `tagBooking ?? tags ?? genre`).
 */
export function pickRelatedArtists<T extends Record<string, unknown>>(
  current: T,
  pool: T[],
  tagsOf: (a: T) => string[],
  limit = 12,
): T[] {
  const currentSlug = String(current.SLUG ?? "");
  const currentTags = new Set(tagsOf(current).map((t) => t.toLowerCase()).filter(Boolean));

  const others = pool.filter((a) => String(a.SLUG ?? "") !== currentSlug);

  // Score each by tag overlap; keep matches > 0 sorted desc.
  const scored = others
    .map((a) => {
      const tags = tagsOf(a).map((t) => t.toLowerCase());
      const overlap = tags.reduce((n, t) => (currentTags.has(t) ? n + 1 : n), 0);
      return { artist: a, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  const matched = scored.map((s) => s.artist);

  if (matched.length >= limit) return matched.slice(0, limit);

  // Top up with random non-overlapping others. Deterministic shuffle keyed on
  // the current slug so each detail page is stable across rebuilds.
  const matchedSlugs = new Set(matched.map((a) => String(a.SLUG ?? "")));
  const remaining = others.filter((a) => !matchedSlugs.has(String(a.SLUG ?? "")));

  // Mulberry32 PRNG seeded from the slug — deterministic per-page.
  let seed = 0;
  for (let i = 0; i < currentSlug.length; i++) seed = (seed * 31 + currentSlug.charCodeAt(i)) >>> 0;
  function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const shuffled = [...remaining];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return [...matched, ...shuffled].slice(0, limit);
}
