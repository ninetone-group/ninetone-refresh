#!/usr/bin/env node
/**
 * Data-parity audit: FileMaker (pre-migration) vs Ninetone Office (production
 * source since 2026-11-01, v0.3.3.3).
 *
 * Runs every find the site issues (the bodies in src/lib/ninetone.ts, copied
 * verbatim) against BOTH sources and diffs the answers record by record and
 * field by field. Records are keyed by SLUG (lowercase `slug` for news,
 * `category` for web posts, `tagBooking` for booking categories); release
 * portal rows by Album, booking-category portal rows by `Green HeadArtist::SLUG`,
 * web post blocks by the portal row `recordId` the homepage binds to.
 *
 * READ-ONLY. Plain finds on FileMaker (one session, closed at the end), plain
 * GETs on Office, no KV, no cache, no writes to either system. Writes only the
 * two report files named on the command line. Never prints a credential.
 *
 *   node scripts/office-parity-audit.mjs                 # report + JSON under docs/audit-evidence/
 *   node scripts/office-parity-audit.mjs --out X.md --json Y.json
 *   node scripts/office-parity-audit.mjs --no-detail     # skip the per-slug detail finds
 *
 * Needs FM_HOST, FM_DB, FM_USER, FM_PASS, OFFICE_API_ORIGIN, OFFICE_API_TOKEN
 * in .env (or the environment). Node 22.
 *
 * Every differing field value lands in exactly one bucket:
 *   identical  same string on both sides
 *   intended   a normalisation docs/handoff-codex-report-2026-11-01.md §2 declares
 *              (CRLF/CR → LF, dates to MM/DD/YYYY, image re-addressing, letterSearch,
 *              Cover_Picture dropped, ids re-minted, division defaults, MessageString =
 *              body, url_youtube_link taken from FM "url youtube(1)")
 *   cosmetic   invisible on the site: whitespace, letter case the site lowercases,
 *              "" vs "false" on highlight flags, Unicode normalisation form,
 *              timestamp spelling in webPost::sortOrder (NaN either way)
 *   image      an image field that is filled on one side only (listed separately)
 *   unused     a field the site never reads on that layout (FileMaker internals that
 *              Office does not emit, or division fields Office fills on every layout)
 *   differs    a real content difference in a field the site shows
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const OUT_MD = path.resolve(ROOT, arg("--out", `docs/audit-evidence/office-parity-${TODAY}/report.md`));
const OUT_JSON = path.resolve(ROOT, arg("--json", `docs/audit-evidence/office-parity-${TODAY}/results.json`));
const RUN_DETAIL = !args.includes("--no-detail");

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
}
loadEnv();
const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k} (set it in .env or the environment)`);
    process.exit(2);
  }
  return v;
};
const FM_HOST = need("FM_HOST");
const FM_DB = need("FM_DB");
const FM_USER = need("FM_USER");
const FM_PASS = need("FM_PASS");
const OFFICE_ORIGIN = new URL(need("OFFICE_API_ORIGIN")).origin;
const OFFICE_TOKEN = need("OFFICE_API_TOKEN");

// ---------------------------------------------------------------------------
// Transports (minimal, faithful to src/lib/filemaker.ts and src/lib/office.ts)
// ---------------------------------------------------------------------------
const FIND_TIMEOUT_MS = 90_000;

class FileMaker {
  #token = null;
  get #db() {
    return `https://${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}`;
  }
  async login() {
    const res = await fetch(`${this.#db}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${FM_USER}:${FM_PASS}`)}` },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`FM session failed: HTTP ${res.status}`);
    this.#token = (await res.json()).response.token;
  }
  async logout() {
    if (!this.#token) return;
    await fetch(`${this.#db}/sessions/${this.#token}`, { method: "DELETE" }).catch(() => {});
    this.#token = null;
  }
  /** Same body translation as fmRequestUntimed: portalLimits → `limit.<portal>`. */
  async find(layout, body, retry = true) {
    if (!this.#token) await this.login();
    const { portalLimits, ...rest } = body;
    const payload = { ...rest };
    for (const [p, n] of Object.entries(portalLimits ?? {})) payload[`limit.${p}`] = String(n);
    const res = await fetch(`${this.#db}/layouts/${layout}/_find`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FIND_TIMEOUT_MS),
    });
    if (res.status === 401 && retry) {
      this.#token = null;
      return this.find(layout, body, false);
    }
    const json = await res.json();
    if (json.messages?.some((m) => m.code === "401")) return { rows: [], foundCount: 0 };
    if (!res.ok) throw new Error(`FM ${layout}: HTTP ${res.status}, code ${(json.messages ?? []).map((m) => m.code).join(",")}`);
    const info = json.response.dataInfo ?? {};
    if (info.foundCount > info.returnedCount && body.limit !== 1) {
      throw new Error(`FM ${layout}: returned ${info.returnedCount} of ${info.foundCount} (site would raise limit)`);
    }
    return { rows: json.response.data, foundCount: info.foundCount ?? json.response.data.length };
  }
}

async function officeFind(layout, body) {
  const url = new URL(`/api/integrations/website/v1/layouts/${layout}`, OFFICE_ORIGIN);
  url.searchParams.set("q", JSON.stringify(body));
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${OFFICE_TOKEN}`, Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(FIND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Office ${layout}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.schema_version !== 1) throw new Error(`Office ${layout}: schema_version ${json.schema_version}`);
  const info = json.response.dataInfo;
  if (info.foundCount > info.returnedCount && body.limit !== 1) {
    throw new Error(`Office ${layout}: returned ${info.returnedCount} of ${info.foundCount} (site would throw "would truncate")`);
  }
  return { rows: json.response.data, foundCount: info.foundCount };
}

// ---------------------------------------------------------------------------
// Fields the site reads, per layout (docs/handoff-codex-database-migration-2026-10-26.md
// §4, checked against the pages with grep on 2026-11-01). Anything else is "unused".
// ---------------------------------------------------------------------------
const URL_SET = ["url_spotify", "url_applemusic", "url_amazon", "url_youtube_music", "url_youtube_link", "url_instagram", "url_tiktok_artist", "url_twitter", "url_facebook", "url_spotify_artist"];
// Read on every profile layout (list cards, detail pages, search index, homepage pickers).
const PROFILE_COMMON = [
  "SLUG", "Head Artist", "artistPresentationShort", "artistPicture_big", "artistPicture_small", "genre",
  "internalAandR", "Green_internalAandR::userEmail", "yotubeHighlight_one", "yotubeHighlight_two", "collectionId",
  ...URL_SET, "filterActive",
];
// Read only where the Records pages render the record (artist detail, previous artist, llms.txt).
const RECORDS_ONLY = ["Artist Presentation Title", "artistPresentationString"];
const RELEASE_PORTAL_FIELDS = [
  "Album", "Type", "Releasedate First", "urlRelease", "urlSpotify", "urlAppleMusic", "urlAmazonMusic", "urlYoutubeMusic", "urlTidal", "coverPicture_webp", "Cover_Picture",
].map((f) => `Green Web Category::${f}`).concat(["Green Web Album::spotifyPitch", "Green Web Album::socialMedia"]);
const USED_FIELDS = {
  API_ARTIST: new Set([...PROFILE_COMMON, ...RECORDS_ONLY, "readMore", "highLight_music"]),
  API_ARTIST_DETAIL: new Set([...PROFILE_COMMON, ...RECORDS_ONLY, "highLight_music", ...RELEASE_PORTAL_FIELDS]),
  API_Management: new Set([...PROFILE_COMMON, "clientPresentationTitle", "clientPresentationString", "clientPresentationShort", "tags", "internalMgmntManager", "Green_internalMgmntManagers::userEmail", "readMoreClients", "highLight_client"]),
  API_Booking: new Set([...PROFILE_COMMON, "bookingPresentationTitle", "bookingPresentationString", "bookingPresentationShort", "tagBooking", "tags", "readMoreBooking", "filterType", "filterTypeCombine"]),
  API_BOOKING_TAG: new Set([
    "tagBooking", "breadBooking",
    ...["SLUG", "Head Artist", "artistPicture_big", "artistPicture_small", "bookingPresentationShort", "clientPresentationShort", "artistPresentationShort", "bookingPresentationTitle", "clientPresentationTitle", "Artist Presentation Title", "highLight_client", "filterActive", ...URL_SET].map((f) => `Green HeadArtist::${f}`),
  ]),
  API_NEWS: new Set(["slug", "Title", "shortMessage", "MessageString", "Message", "Date", "image_webp", "category", "Created By", "ytLinkA", "ytLinkB", "ytLinkC", "ytLinkD"]),
  API_WEBPOSTS: new Set(["category", "title", "recordId", ...["subject", "message", "image_webp", "date", "sortOrder", "ytLinkA", "ytLinkB", "ytLinkC", "ytLinkD"].map((f) => `webPost::${f}`)]),
  API_USERS: new Set(["SLUG", "userNameCalc", "title", "titleDescription", "DescriptionString", "Description", "userPhoto", "userPhotoSmall", "userEmail", "Phone", "sortOrder", "Active"]),
};
const isUsed = (layout, field) => USED_FIELDS[layout]?.has(field) ?? true;

// ---------------------------------------------------------------------------
// The queries the site runs — bodies copied from src/lib/ninetone.ts
// ---------------------------------------------------------------------------
const nfc = (s) => String(s ?? "").normalize("NFC");
const bySlug = (r) => nfc(r.SLUG);
const releasePortal = { name: "Green Web Category", key: (row) => nfc(row["Green Web Category::Album"]).trim(), dropEmptyKey: true, statusField: null };
const Q = {
  getArtists: {
    layout: "API_ARTIST",
    body: {
      query: [{ filterActive: "==Active", filterType: "Music", SLUG: "*", letterSearch: "==**", "Head Artist": "*" }],
      sort: [{ fieldName: "highLight_music", sortOrder: "descend" }, { fieldName: "Head Artist", sortOrder: "ascend" }],
      limit: 500,
    },
    key: bySlug,
    used: "/records/artists, homepage, search, sitemap, llms.txt, warm cron",
  },
  getArtistsWithReleases: {
    layout: "API_ARTIST_DETAIL",
    body: { query: [{ filterType: "Music", SLUG: "*" }], limit: 1000, portal: ["Green Web Category"], portalLimits: { "Green Web Category": 500 } },
    key: bySlug,
    portal: releasePortal,
    used: "nightly release count (every Music artist, any status, with discography)",
  },
  getPreviousArtists: {
    layout: "API_ARTIST_DETAIL",
    body: {
      query: [{ filterActive: "==Not Active", filterType: "Music", SLUG: "*", artistPresentationShort: "*", "Head Artist": "==**" }],
      sort: [{ fieldName: "Head Artist", sortOrder: "ascend" }],
      offset: "1",
      limit: 1000,
      portal: [],
    },
    key: bySlug,
    used: "/records/artists/previous",
  },
  getClients: {
    layout: "API_Management",
    body: {
      query: [{ filterActive: "==Active", filterTypeCombine: "Management", SLUG: "*", "Head Artist": "*" }],
      sort: [{ fieldName: "highLight_client", sortOrder: "descend" }, { fieldName: "Head Artist", sortOrder: "ascend" }],
      limit: 500,
    },
    key: bySlug,
    used: "/management/clients, homepage, search, sitemap",
  },
  getPreviousClients: {
    layout: "API_Management",
    body: {
      query: [{ filterActive: "==Not Active", filterTypeCombine: "Management", SLUG: "*", "Head Artist": "*" }],
      sort: [{ fieldName: "Head Artist", sortOrder: "ascend" }],
      limit: 500,
    },
    key: bySlug,
    postFilter: { name: "hasProfileImage()", fn: hasProfileImage },
    used: "/management/clients/previous (rows without a usable picture are dropped after the fetch)",
  },
  getBookingRoster: {
    layout: "API_Booking",
    body: { query: [{ filterActive: "==Active", filterType: "Booking", SLUG: "*", filterTypeCombine: "==***", tagBooking: "*" }], limit: 500 },
    key: bySlug,
    postFilter: { name: "isActiveBookingArtist()", fn: (r) => r.filterActive === "Active" },
    used: "/ninetone-nation/[slug] related strips, homepage featured booking",
  },
  getPreviousBooking: {
    layout: "API_Booking",
    body: { query: [{ filterActive: "==Not Active", filterType: "Booking", SLUG: "*" }], limit: 500 },
    key: bySlug,
    used: "homepage 'profiles since the start' count",
  },
  getBookingCategories: {
    layout: "API_BOOKING_TAG",
    body: { query: [{ tagBooking: "*" }], limit: 100, portal: ["Green HeadArtist"], portalLimits: { "Green HeadArtist": 500 } },
    key: (r) => nfc(r.tagBooking),
    portal: { name: "Green HeadArtist", key: (row) => nfc(row["Green HeadArtist::SLUG"]), statusField: "Green HeadArtist::filterActive" },
    used: "/ninetone-nation/booking, /ninetone-nation/kategori/*, which talent pages exist",
  },
  getNews: {
    layout: "API_NEWS",
    body: { query: [{ Message: "*" }], sort: [{ fieldName: "Date", sortOrder: "descend" }], limit: 500 },
    key: (r) => nfc(r.slug),
    used: "/news, /news/[slug], /news.xml, sitemap, admin, artist news strips",
  },
  getWebPosts: {
    layout: "API_WEBPOSTS",
    body: { query: [{ category: "*" }], limit: 100, portal: ["webPost"], portalLimits: { webPost: 500 } },
    key: (r) => nfc(r.category),
    portal: { name: "webPost", key: (row) => String(row.recordId ?? ""), isWebPost: true },
    used: "homepage copy, section intros, promo bar, guides, FAQ (all categories)",
  },
  getTeam: {
    layout: "API_USERS",
    body: { query: [{ Active: "==Ja", SLUG: "*" }], sort: [{ fieldName: "sortOrder", sortOrder: "ascend" }], limit: 500 },
    key: bySlug,
    used: "/team, /team/[slug]",
  },
};
const webPostCategory = (category) => ({
  layout: "API_WEBPOSTS",
  body: { query: [{ category }], limit: 100, portal: ["webPost"], portalLimits: { webPost: 500 } },
  key: (r) => nfc(r.category),
  portal: { name: "webPost", key: (row) => String(row.recordId ?? ""), isWebPost: true },
  used: `getWebPosts("${category}")`,
  requestedCategory: category,
});
const artistDetail = (slug) => ({
  layout: "API_ARTIST_DETAIL",
  body: { query: [{ filterActive: "==*", SLUG: slug }], limit: 1, portal: ["Green Web Category"], portalLimits: { "Green Web Category": 500 } },
  key: bySlug,
  portal: releasePortal,
  used: `/records/artists/${slug} (getArtistDetailWithReleases)`,
});
const bookingBySlug = (slug) => ({
  layout: "API_Booking",
  body: { query: [{ SLUG: `==${slug}`, filterActive: "==Active" }], limit: 1 },
  key: bySlug,
  used: `getBookingPageSet() extra lookup for curated talent ${slug}`,
});

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------
const IMAGE_FIELDS = new Set([
  "artistPicture_big", "artistPicture_small", "Artist Presentation Picture", "artistPresentationPicture",
  "image_webp", "userPhoto", "userPhotoSmall", "coverPicture_webp", "Cover_Picture",
]);
const bare = (k) => (k.includes("::") ? k.slice(k.lastIndexOf("::") + 2) : k);
const isImageField = (k) => IMAGE_FIELDS.has(bare(k));
const isDateField = (k) => /^(Date|Releasedate First|date)$/.test(bare(k));
const FM_IMAGE = /^https?:\/\/files\.ninetone\.com\/Streaming_SSL\//i;
const OFFICE_IMAGE = /^\/api\/office-images\//;
const FM_IMAGE_ERROR = /\[MBS\]/;
const str = (v) => (v == null ? "" : String(v));
const nl = (s) => s.replace(/\r\n?/g, "\n");
const trimWs = (s) => s.split("\n").map((l) => l.replace(/[ \t ]+$/g, "").replace(/^[ \t ]+/g, "")).join("\n").trim();
function dateKey(s) {
  let m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function timestampKey(s) {
  let m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2}):(\d{2})\s*$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")} ${m[4].padStart(2, "0")}:${m[5]}:${m[6]}`;
  m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return null;
}
function hasProfileImage(row) {
  const ok = (v) => /^https?:\/\//i.test(v) || OFFICE_IMAGE.test(v);
  return ok(str(row.artistPicture_small).trim()) || ok(str(row.artistPicture_big).trim());
}
/** Image state of one value. */
function imageState(v) {
  const s = str(v).trim();
  if (!s) return "empty";
  if (FM_IMAGE_ERROR.test(s)) return "error";
  if (FM_IMAGE.test(s) || OFFICE_IMAGE.test(s) || /^https?:\/\//i.test(s)) return "present";
  return "other";
}

/**
 * Compare one field of a matched record. `fmRec`/`offRec` are the whole
 * records, for the cross-field rules the Codex mapping declares.
 */
function classify(layout, field, fmRec, offRec) {
  const f = str(fmRec[field]);
  const o = str(offRec[field]);
  if (f === o) return { kind: "identical" };
  const b = bare(field);
  if (b === "recordId" || b === "__recordId") return { kind: "intended", reason: "record id re-minted" };
  if (!isUsed(layout, field)) return { kind: "unused" };
  if (isImageField(field)) {
    if (b === "Cover_Picture" && o === "") return { kind: "intended", reason: "Cover_Picture no longer emitted" };
    const fs = imageState(f);
    const os = imageState(o);
    if (fs === "present" && os === "present") return { kind: "intended", reason: "image re-addressed" };
    if (fs === "error" && os === "empty") return { kind: "intended", reason: "FM [MBS] error row → empty" };
    return { kind: "image", reason: `${fs} on FM, ${os} on Office` };
  }
  if (b === "letterSearch" && o === "**") return { kind: "intended", reason: "letterSearch compatibility marker" };
  const fn = nl(f);
  const on = nl(o);
  if (fn === on) return { kind: "intended", reason: "line endings" };
  if (fn.normalize("NFC") === on.normalize("NFC")) return { kind: "cosmetic", reason: "Unicode normalisation form" };
  if (isDateField(field)) {
    const dk = dateKey(f);
    if (dk && dk === dateKey(o)) return { kind: "intended", reason: "date format" };
    if (!dk && f.trim() !== "" && o === "") return { kind: "intended", reason: "invalid date → empty" };
  }
  if (b === "sortOrder" && field.includes("::")) {
    const tk = timestampKey(f);
    if (tk && tk === timestampKey(o)) return { kind: "cosmetic", reason: "timestamp spelling in webPost::sortOrder (NaN for the site either way)" };
  }
  if (f.trim() !== "" && o.trim() !== "" && /^-?\d+(\.\d+)?$/.test(f.trim()) && Number(f) === Number(o)) return { kind: "intended", reason: "number format" };
  if (b === "filterTypeCombine" && f.trim() === "" && o.trim() !== "") return { kind: "intended", reason: "filterTypeCombine division default when missing" };
  if (b === "filterType" && fn.split("\n").map((s) => s.trim()).includes(o.trim())) return { kind: "intended", reason: "filterType scope value (FM multi-value → one division)" };
  if (/^highLight_/.test(b) && f.trim() === "" && o.trim() === "false") return { kind: "cosmetic", reason: '"" → "false" on a highlight flag (site tests === "true")' };
  if (b === "url_youtube_link" && f.trim() === "" && o.trim() !== "" && o.trim() === str(fmRec["url youtube(1)"]).trim()) return { kind: "intended", reason: 'url_youtube_link taken from FM "url youtube(1)" (declared import event)' };
  if (b === "MessageString" && layout === "API_NEWS" && nl(o).normalize("NFC") === nl(str(fmRec.Message)).normalize("NFC")) return { kind: "intended", reason: "MessageString now equals Message (declared: fields.body for both)" };
  if (b === "Type" && field.startsWith("Green Web Category::") && f.trim().toLowerCase() === o.trim().toLowerCase()) return { kind: "cosmetic", reason: "letter case in release Type (site lowercases)" };
  if (trimWs(fn).normalize("NFC") === trimWs(on).normalize("NFC")) return { kind: "cosmetic", reason: "leading/trailing whitespace" };
  return { kind: "differs" };
}

function excerpt(v, n = 110) {
  const s = str(v).replace(/\r\n?|\n/g, "⏎").replace(/\|/g, "\\|");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function diffContext(a, b) {
  a = nl(str(a));
  b = nl(str(b));
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const win = (s) => s.slice(Math.max(0, i - 25), i + 60);
  return { at: i, fm: excerpt(win(a), 90), office: excerpt(win(b), 90) };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------
const KINDS = ["identical", "intended", "cosmetic", "image", "unused", "differs"];
const emptyStats = () => ({ matched: 0, fieldStats: Object.fromEntries(KINDS.map((k) => [k, 0])), reasons: {}, diffs: [], cosmetic: [], unused: {}, images: {} });

function indexBy(rows, keyFn, flatten) {
  const map = new Map();
  const dupes = [];
  const empties = [];
  for (const r of rows) {
    const rec = flatten(r);
    const k = keyFn(rec);
    if (!k) {
      empties.push(rec);
      continue;
    }
    if (map.has(k)) dupes.push(k);
    else map.set(k, rec);
  }
  return { map, dupes, empties };
}

function diffRecords(layout, fmMap, offMap) {
  const out = emptyStats();
  for (const [k, fm] of fmMap) {
    const off = offMap.get(k);
    if (!off) continue;
    out.matched++;
    const fields = new Set([...Object.keys(fm), ...Object.keys(off)]);
    for (const field of fields) {
      const f = fm[field];
      const o = off[field];
      if (isImageField(field) && isUsed(layout, field) && bare(field) !== "Cover_Picture") {
        const st = (out.images[field] ??= { both: 0, fmOnly: 0, officeOnly: 0, neither: 0, fmError: 0, fmOnlyKeys: [], officeOnlyKeys: [], fmErrorKeys: [] });
        const fs = imageState(f);
        const os = imageState(o);
        if (fs === "error") {
          st.fmError++;
          st.fmErrorKeys.push(k);
        }
        const fp = fs === "present";
        const op = os === "present";
        if (fp && op) st.both++;
        else if (fp) {
          st.fmOnly++;
          st.fmOnlyKeys.push(k);
        } else if (op) {
          st.officeOnly++;
          st.officeOnlyKeys.push(k);
        } else st.neither++;
      }
      const c = classify(layout, field, fm, off);
      out.fieldStats[c.kind]++;
      if (c.reason && c.kind !== "image") out.reasons[c.reason] = (out.reasons[c.reason] ?? 0) + 1;
      if (c.kind === "cosmetic") out.cosmetic.push({ key: k, field, reason: c.reason });
      if (c.kind === "unused") {
        const u = (out.unused[field] ??= { count: 0, fmFilled: 0, officeFilled: 0, example: null });
        u.count++;
        if (str(f).trim()) u.fmFilled++;
        if (str(o).trim()) u.officeFilled++;
        u.example ??= { key: k, fm: excerpt(f, 60), office: excerpt(o, 60) };
      }
      if (c.kind === "differs") {
        const long = str(f).length > 110 || str(o).length > 110;
        out.diffs.push({ key: k, field, fm: excerpt(f), office: excerpt(o), ...(long ? { context: diffContext(f, o) } : {}), fmLen: str(f).length, officeLen: str(o).length });
      }
    }
  }
  return out;
}

function mergeStats(into, from, parent) {
  into.matched += from.matched;
  for (const k of KINDS) into.fieldStats[k] += from.fieldStats[k];
  for (const [r, n] of Object.entries(from.reasons)) into.reasons[r] = (into.reasons[r] ?? 0) + n;
  into.diffs.push(...from.diffs.map((x) => ({ parent, ...x })));
  into.cosmetic.push(...from.cosmetic.map((x) => ({ parent, ...x })));
  for (const [field, u] of Object.entries(from.unused)) {
    const t = (into.unused[field] ??= { count: 0, fmFilled: 0, officeFilled: 0, example: null });
    t.count += u.count;
    t.fmFilled += u.fmFilled;
    t.officeFilled += u.officeFilled;
    t.example ??= u.example;
  }
  for (const [field, st] of Object.entries(from.images)) {
    const t = (into.images[field] ??= { both: 0, fmOnly: 0, officeOnly: 0, neither: 0, fmError: 0, fmOnlyKeys: [], officeOnlyKeys: [], fmErrorKeys: [] });
    for (const n of ["both", "fmOnly", "officeOnly", "neither", "fmError"]) t[n] += st[n];
    for (const n of ["fmOnlyKeys", "officeOnlyKeys", "fmErrorKeys"]) t[n].push(...st[n].map((k) => (parent ? `${parent} → ${k}` : k)));
  }
}

/** Order of keys present on both sides, compared positionally. */
function orderCheck(fmKeys, offKeys) {
  const common = new Set(fmKeys.filter((k) => offKeys.includes(k)));
  const a = fmKeys.filter((k) => common.has(k));
  const b = offKeys.filter((k) => common.has(k));
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i === a.length ? { same: true, common: a.length } : { same: false, common: a.length, firstDiffAt: i, fm: a.slice(i, i + 5), office: b.slice(i, i + 5) };
}

function nameOf(rec) {
  return str(rec["Head Artist"] || rec.userNameCalc || rec.Title || rec.title || rec.tagBooking || "");
}
function statusOf(rec) {
  return rec.filterActive ?? rec.Active;
}

async function runQuery(fm, name, spec) {
  const t0 = Date.now();
  const [fmRes, offRes] = await Promise.all([
    fm.find(spec.layout, spec.body).then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, error: e.message })),
    officeFind(spec.layout, spec.body).then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, error: e.message })),
  ]);
  const result = {
    name,
    layout: spec.layout,
    used: spec.used,
    body: spec.body,
    ms: Date.now() - t0,
    fm: { ok: fmRes.ok, error: fmRes.error, count: fmRes.rows?.length ?? 0, foundCount: fmRes.foundCount },
    office: { ok: offRes.ok, error: offRes.error, count: offRes.rows?.length ?? 0, foundCount: offRes.foundCount },
  };
  if (!fmRes.ok || !offRes.ok) return result;

  const flat = (r) => ({ ...r.fieldData, __recordId: r.recordId });
  const fmIdx = indexBy(fmRes.rows, spec.key, flat);
  const offIdx = indexBy(offRes.rows, spec.key, flat);
  result.fm.duplicateKeys = fmIdx.dupes;
  result.office.duplicateKeys = offIdx.dupes;
  result.fm.emptyKeyRows = fmIdx.empties.length;
  result.office.emptyKeyRows = offIdx.empties.length;
  result.keys = { fm: [...fmIdx.map.keys()], office: [...offIdx.map.keys()] };
  result.statuses = { fm: Object.fromEntries([...fmIdx.map].map(([k, r]) => [k, statusOf(r)])), office: Object.fromEntries([...offIdx.map].map(([k, r]) => [k, statusOf(r)])) };

  // Field inventory
  const fmFields = new Set();
  const offFields = new Set();
  for (const r of fmIdx.map.values()) for (const k of Object.keys(r)) fmFields.add(k);
  for (const r of offIdx.map.values()) for (const k of Object.keys(r)) offFields.add(k);
  result.fields = {
    onlyFm: [...fmFields].filter((f) => !offFields.has(f) && f !== "__recordId").map((f) => ({ field: f, used: isUsed(spec.layout, f) })),
    onlyOffice: [...offFields].filter((f) => !fmFields.has(f) && f !== "__recordId").map((f) => ({ field: f, used: isUsed(spec.layout, f) })),
  };

  if (spec.postFilter) {
    const keep = (idx) => [...idx.map.values()].filter(spec.postFilter.fn).length;
    result.postFilter = { name: spec.postFilter.name, fm: keep(fmIdx), office: keep(offIdx) };
  }

  const fmKeys = result.keys.fm;
  const offKeys = result.keys.office;
  const portalInfo = (side, k) => {
    if (!spec.portal) return {};
    const rec = (side === "fm" ? fmRes : offRes).rows.find((r) => spec.key(flat(r)) === k);
    const rows = rec?.portalData?.[spec.portal.name] ?? [];
    const active = spec.portal.statusField ? rows.filter((row) => row[spec.portal.statusField] === "Active").length : undefined;
    return { portalRows: rows.length, ...(active !== undefined ? { portalActive: active } : {}) };
  };
  const prefixNote = (k) => (spec.requestedCategory && k !== spec.requestedCategory ? "FileMaker word-prefix match on the category; the site uses the exact category" : undefined);
  result.missingOnOffice = fmKeys.filter((k) => !offIdx.map.has(k)).map((k) => ({ key: k, name: nameOf(fmIdx.map.get(k)), status: statusOf(fmIdx.map.get(k)), note: prefixNote(k), ...portalInfo("fm", k) }));
  result.missingOnFm = offKeys.filter((k) => !fmIdx.map.has(k)).map((k) => ({ key: k, name: nameOf(offIdx.map.get(k)), status: statusOf(offIdx.map.get(k)), note: prefixNote(k), ...portalInfo("office", k) }));
  result.order = spec.body.sort || spec.layout === "API_BOOKING_TAG" || spec.layout === "API_WEBPOSTS" ? orderCheck(fmKeys, offKeys) : undefined;
  result.records = diffRecords(spec.layout, fmIdx.map, offIdx.map);

  if (spec.portal) {
    const p = spec.portal;
    const agg = {
      name: p.name,
      fmRows: 0,
      officeRows: 0,
      fmEmptyKeyRows: 0,
      officeEmptyKeyRows: 0,
      fmDupes: [],
      officeDupes: [],
      missingOnOffice: [],
      missingOnFm: [],
      orderDiffers: [],
      parentsCompared: 0,
      records: emptyStats(),
      webPostBlocks: p.isWebPost ? [] : undefined,
    };
    const fmRowsByParent = new Map(fmRes.rows.map((r) => [spec.key(flat(r)), r.portalData?.[p.name] ?? []]));
    const offRowsByParent = new Map(offRes.rows.map((r) => [spec.key(flat(r)), r.portalData?.[p.name] ?? []]));
    for (const rows of fmRowsByParent.values()) agg.fmRows += rows.length;
    for (const rows of offRowsByParent.values()) agg.officeRows += rows.length;
    for (const parent of fmKeys.filter((k) => offIdx.map.has(k))) {
      agg.parentsCompared++;
      const fi = indexBy(fmRowsByParent.get(parent), p.key, (x) => x);
      const oi = indexBy(offRowsByParent.get(parent), p.key, (x) => x);
      agg.fmEmptyKeyRows += fi.empties.length;
      agg.officeEmptyKeyRows += oi.empties.length;
      agg.fmDupes.push(...fi.dupes.map((d) => `${parent} → ${d}`));
      agg.officeDupes.push(...oi.dupes.map((d) => `${parent} → ${d}`));
      const fmap = fi.map;
      const omap = oi.map;
      const label = (row) => (p.isWebPost ? excerpt(row["webPost::subject"], 60) : p.statusField ? str(row[p.statusField]) : undefined);
      if (p.isWebPost) {
        const unmatchedFm = [...fmap.keys()].filter((k) => !omap.has(k));
        const unmatchedOff = [...omap.keys()].filter((k) => !fmap.has(k));
        for (const k of unmatchedFm) {
          const subj = str(fmap.get(k)["webPost::subject"]).trim();
          const hit = unmatchedOff.find((ok) => str(omap.get(ok)["webPost::subject"]).trim() === subj && subj);
          if (hit) agg.webPostBlocks.push({ section: parent, event: "id changed", fmRecordId: k, officeRecordId: hit, subject: excerpt(subj, 60) });
        }
      }
      for (const k of fmap.keys()) if (!omap.has(k)) agg.missingOnOffice.push({ parent, key: k, label: label(fmap.get(k)) });
      for (const k of omap.keys()) if (!fmap.has(k)) agg.missingOnFm.push({ parent, key: k, label: label(omap.get(k)) });
      const ord = orderCheck([...fmap.keys()], [...omap.keys()]);
      if (!ord.same) agg.orderDiffers.push({ parent, ...ord });
      const d = diffRecords(spec.layout, fmap, omap);
      mergeStats(agg.records, d, parent);
      if (p.isWebPost) {
        // Site-visible block order: sortOrder numeric asc, blanks last, stable.
        const siteOrder = (map) => {
          const n = (row) => {
            const raw = str(row["webPost::sortOrder"]);
            const v = Number(raw);
            return raw !== "" && Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
          };
          return [...map.entries()].sort((a, b) => n(a[1]) - n(b[1])).map(([k]) => k);
        };
        const so = orderCheck(siteOrder(fmap), siteOrder(omap));
        if (!so.same) agg.webPostBlocks.push({ section: parent, event: "rendered block order differs", ...so });
        for (const x of d.diffs) agg.webPostBlocks.push({ section: parent, event: "field differs", recordId: x.key, field: x.field, fm: x.fm, office: x.office, context: x.context });
        for (const x of d.cosmetic) agg.webPostBlocks.push({ section: parent, event: `cosmetic: ${x.reason}`, recordId: x.key, field: x.field });
      }
    }
    result.portal = agg;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const fm = new FileMaker();
const results = [];
const log = (m) => console.error(m);
try {
  await fm.login();
  log(`FileMaker ${FM_HOST} ↔ Office ${OFFICE_ORIGIN}`);
  for (const [name, spec] of Object.entries(Q)) {
    log(`… ${name} (${spec.layout})`);
    results.push(await runQuery(fm, name, spec));
  }

  // Dependent finds, derived the way the pages derive them.
  const cats = results.find((r) => r.name === "getBookingCategories");
  const tags = new Set([...(cats?.keys?.fm ?? []), ...(cats?.keys?.office ?? [])]);
  const sectionCategories = ["Ninetone Group", "Ninetone Records", "Ninetone Management", "Ninetone Nation", "Ninetone Group Team", "Promo", "Guider", ...[...tags].filter(Boolean).map((t) => `FAQ ${t}`)];
  for (const c of sectionCategories) {
    log(`… getWebPosts("${c}")`);
    results.push(await runQuery(fm, `getWebPosts("${c}")`, webPostCategory(c)));
  }

  // Curated Nation talents missing from the strict roster: per-slug lookup (getBookingPageSet).
  const roster = results.find((r) => r.name === "getBookingRoster");
  if (cats?.fm.ok && cats?.office.ok && roster?.fm.ok && roster?.office.ok) {
    const curated = new Set();
    const [fmCats, offCats] = await Promise.all([fm.find(Q.getBookingCategories.layout, Q.getBookingCategories.body), officeFind(Q.getBookingCategories.layout, Q.getBookingCategories.body)]);
    for (const src of [fmCats, offCats]) for (const rec of src.rows) for (const row of rec.portalData?.["Green HeadArtist"] ?? []) if (row["Green HeadArtist::filterActive"] === "Active" && row["Green HeadArtist::SLUG"]) curated.add(nfc(row["Green HeadArtist::SLUG"]));
    const inRoster = new Set([...roster.keys.fm, ...roster.keys.office]);
    const extras = [...curated].filter((s) => !inRoster.has(s));
    log(`… ${extras.length} curated Nation talents outside the strict roster`);
    for (const slug of extras) results.push(await runQuery(fm, `API_Booking by slug ${slug}`, bookingBySlug(slug)));
  }

  // Per-slug artist detail (the find every /records/artists/[slug] page makes).
  if (RUN_DETAIL) {
    const active = results.find((r) => r.name === "getArtists");
    if (active?.keys) {
      const slugs = [...new Set([...active.keys.fm, ...active.keys.office])].sort();
      log(`… ${slugs.length} per-slug API_ARTIST_DETAIL finds`);
      for (const slug of slugs) results.push(await runQuery(fm, `getArtistDetailWithReleases("${slug}")`, artistDetail(slug)));
    }
  }
} finally {
  await fm.logout();
}

// ---------------------------------------------------------------------------
// Cross-reference: where else does a key appear on the other side, with what status?
// ---------------------------------------------------------------------------
const base = results.filter((r) => Q[r.name] && r.keys);
function locate(side, key, exceptQuery) {
  const hits = [];
  for (const r of base) {
    if (r.name === exceptQuery) continue;
    const st = r.statuses?.[side]?.[key];
    if (st !== undefined) hits.push(`${r.name} (${st || "no status"})`);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const md = [];
const h = (n, t) => md.push(`${"#".repeat(n)} ${t}`, "");
const p = (t = "") => md.push(t, "");
const table = (head, rows) => {
  if (!rows.length) return p("_none_");
  md.push(`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`);
  for (const r of rows) md.push(`| ${r.map((c) => str(c)).join(" | ")} |`);
  md.push("");
};
const code = (s) => `\`${str(s).replace(/`/g, "'")}\``;
const list = (items, cap = 60) => {
  if (!items.length) return p("_none_");
  for (const it of items.slice(0, cap)) md.push(`- ${it}`);
  if (items.length > cap) md.push(`- … ${items.length - cap} more in the JSON`);
  md.push("");
};
const statsOf = (r) => [r.records, r.portal?.records].filter(Boolean);
const total = (r, kind) => sum(statsOf(r).map((s) => s.fieldStats[kind]));

const okResults = results.filter((r) => r.fm.ok && r.office.ok);
const failed = results.filter((r) => !r.fm.ok || !r.office.ok);
const detail = okResults.filter((r) => r.name.startsWith("getArtistDetailWithReleases("));
const main = okResults.filter((r) => !r.name.startsWith("getArtistDetailWithReleases("));
const totals = {
  queries: results.length,
  matched: sum(okResults.flatMap((r) => statsOf(r).map((s) => s.matched))),
  missingOnOffice: sum(okResults.map((r) => r.missingOnOffice.length)),
  missingOnFm: sum(okResults.map((r) => r.missingOnFm.length)),
  fieldStats: Object.fromEntries(KINDS.map((k) => [k, sum(okResults.map((r) => total(r, k)))])),
  reasons: {},
};
for (const r of okResults) for (const s of statsOf(r)) for (const [reason, n] of Object.entries(s.reasons)) totals.reasons[reason] = (totals.reasons[reason] ?? 0) + n;

h(1, `Office data-parity audit — ${TODAY}`);
p(`FileMaker \`${FM_HOST}\` (pre-migration data) against Ninetone Office \`${OFFICE_ORIGIN}\` (production source since 2026-11-01). Generated by \`scripts/office-parity-audit.mjs\` at ${new Date().toISOString()}; read-only on both sides. Full detail: \`${path.relative(ROOT, OUT_JSON)}\`.`);
p("Every differing value is in one bucket. **Intended** = a normalisation the Codex report (docs/handoff-codex-report-2026-11-01.md §2) declares. **Cosmetic** = invisible on the site (whitespace, case the site lowercases, `\"\"` vs `\"false\"` on highlight flags, Unicode form, timestamp spelling). **Image** = an image field filled on one side only. **Unused** = a field the site never reads on that layout. **Differs** = a real content difference in a field the site shows.");

h(2, "Totals");
table(
  ["Measure", "Value"],
  [
    ["Queries run against both sources", totals.queries],
    ["Queries that failed on a side", failed.length],
    ["Records + portal rows matched and compared", totals.matched],
    ["Records missing on Office (present in FileMaker)", totals.missingOnOffice],
    ["Records new on Office (absent in FileMaker)", totals.missingOnFm],
    ...KINDS.map((k) => [`Field values: ${k}`, totals.fieldStats[k]]),
  ],
);
p("Intended and cosmetic differences by reason:");
table(["Reason", "Count"], Object.entries(totals.reasons).sort((a, b) => b[1] - a[1]));

if (failed.length) {
  h(2, "Queries that failed");
  table(["Query", "FileMaker", "Office"], failed.map((r) => [code(r.name), r.fm.ok ? `ok (${r.fm.count})` : r.fm.error, r.office.ok ? `ok (${r.office.count})` : r.office.error]));
}

h(2, "Per query");
p("FM / Office = records returned (after the site's own post-filter where it has one, shown as `raw → kept`). Differs / Image / Cosmetic / Unused count field values on matched records and portal rows.");
table(
  ["Query", "Layout", "FM", "Office", "Missing on Office", "New on Office", "Order", "Differs", "Image", "Cosmetic", "Unused", "Intended"],
  main.map((r) => [
    code(r.name),
    r.layout,
    r.postFilter ? `${r.fm.count} → ${r.postFilter.fm}` : r.fm.count,
    r.postFilter ? `${r.office.count} → ${r.postFilter.office}` : r.office.count,
    r.missingOnOffice.length,
    r.missingOnFm.length,
    r.order ? (r.order.same ? "same" : `differs @${r.order.firstDiffAt}`) : "n/a",
    total(r, "differs"),
    total(r, "image"),
    total(r, "cosmetic"),
    total(r, "unused"),
    total(r, "intended"),
  ]),
);
if (detail.length) {
  p(`Per-slug artist detail finds (${detail.length}, one per active artist on either side): ` +
    `${detail.filter((r) => r.fm.count === 1 && r.office.count === 1).length} found on both, ` +
    `${detail.filter((r) => r.fm.count === 1 && r.office.count === 0).length} FileMaker only, ` +
    `${detail.filter((r) => r.fm.count === 0 && r.office.count === 1).length} Office only; ` +
    `release rows missing on Office ${sum(detail.map((r) => r.portal?.missingOnOffice.length ?? 0))}, new on Office ${sum(detail.map((r) => r.portal?.missingOnFm.length ?? 0))}; ` +
    `field values differing ${sum(detail.map((r) => total(r, "differs")))}, image-state changes ${sum(detail.map((r) => total(r, "image")))}.`);
}

h(2, "Records missing on either side");
for (const r of main) {
  if (!r.missingOnOffice.length && !r.missingOnFm.length) continue;
  h(3, `${r.name} (${r.layout})`);
  const fmt = (m, otherSide) => {
    const parts = [code(m.key)];
    if (m.name) parts.push(`— ${m.name}`);
    if (m.status) parts.push(`[${otherSide === "office" ? "FM" : "Office"}: ${m.status}]`);
    if (m.portalRows !== undefined) parts.push(`· ${m.portalRows} portal rows${m.portalActive !== undefined ? `, ${m.portalActive} Active` : ""}`);
    if (m.note) parts.push(`· ${m.note}`);
    const where = locate(otherSide, m.key, r.name);
    if (where.length) parts.push(`· on ${otherSide === "office" ? "Office" : "FileMaker"} in: ${where.join(", ")}`);
    return parts.join(" ");
  };
  if (r.missingOnOffice.length) {
    p(`In FileMaker, not on Office (${r.missingOnOffice.length}):`);
    list(r.missingOnOffice.map((m) => fmt(m, "office")));
  }
  if (r.missingOnFm.length) {
    p(`On Office, not in FileMaker (${r.missingOnFm.length}):`);
    list(r.missingOnFm.map((m) => fmt(m, "fm")));
  }
}
const detailMissing = detail.filter((r) => r.fm.count !== r.office.count);
if (detailMissing.length) {
  h(3, "Per-slug artist detail");
  list(detailMissing.map((r) => `${code(r.name)} — FM ${r.fm.count}, Office ${r.office.count}`));
}

h(2, "Record order");
p("The site renders list queries in the order the source returns them (FileMaker sorts: highlight first, then name; news by date; team by sortOrder). Only keys present on both sides are compared.");
table(
  ["Query", "Common keys", "Order", "First difference (FM / Office)"],
  main.filter((r) => r.order).map((r) => [code(r.name), r.order.common, r.order.same ? "same" : `differs at #${r.order.firstDiffAt}`, r.order.same ? "" : `${r.order.fm.map(code).join(", ")} / ${r.order.office.map(code).join(", ")}`]),
);
const dupes = okResults.flatMap((r) => [...(r.fm.duplicateKeys ?? []).map((k) => [code(r.name), "FileMaker", code(k)]), ...(r.office.duplicateKeys ?? []).map((k) => [code(r.name), "Office", code(k)])]);
if (dupes.length) {
  h(3, "Duplicate record keys");
  table(["Query", "Side", "Key"], dupes);
}

h(2, "Fields that really differ (fields the site shows)");
p("Grouped by field across every query; portal fields carry their table prefix. Values are excerpts, ⏎ marks a line break. For long texts the Context column shows the text around the first differing character. A record reached by several queries is listed once.");
const byField = new Map();
for (const r of okResults) for (const s of statsOf(r)) for (const d of s.diffs) (byField.get(d.field) ?? byField.set(d.field, []).get(d.field)).push({ query: r.name, ...d });
const uniq = (ds) => {
  const seen = new Set();
  return ds.filter((d) => {
    const id = `${d.parent ?? ""}|${d.key}|${d.fm}|${d.office}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};
if (!byField.size) p("_none_");
else {
  table(["Field", "Distinct records", "Queries"], [...byField.entries()].sort((a, b) => uniq(b[1]).length - uniq(a[1]).length).map(([f, ds]) => [code(f), uniq(ds).length, [...new Set(ds.map((d) => d.query.replace(/\(.*$/, "(…)")))].join(", ")]));
  for (const [field, ds] of [...byField.entries()].sort((a, b) => uniq(b[1]).length - uniq(a[1]).length)) {
    const rows = uniq(ds);
    h(3, `${field} (${rows.length})`);
    table(
      ["Record", "Query", "FileMaker", "Office", "Context"],
      rows.slice(0, 60).map((d) => [code(d.parent ? `${d.parent} → ${d.key}` : d.key), d.query.replace(/\(".*"\)$/, "(…)"), d.fm || "_empty_", d.office || "_empty_", d.context ? `@${d.context.at}: ${d.context.fm} ⟷ ${d.context.office}` : ""]),
    );
    if (rows.length > 60) p(`… ${rows.length - 60} more in the JSON.`);
  }
}

h(2, "Cosmetic differences");
const cos = {};
for (const r of okResults) for (const s of statsOf(r)) for (const c of s.cosmetic) {
  const k = `${c.reason}|${c.field}`;
  cos[k] = (cos[k] ?? 0) + 1;
}
table(["Reason", "Field", "Count"], Object.entries(cos).sort((a, b) => b[1] - a[1]).map(([k, n]) => [...k.split("|").map((x, i) => (i ? code(x) : x)), n]));

h(2, "Fields the site never reads");
p("Differences in fields no page, feed or getter consumes on that layout. Mostly FileMaker internals Office does not emit, and division fields Office fills on every layout where FileMaker left them empty. Listed so nothing is hidden; none of this reaches a visitor.");
const unusedAgg = {};
for (const r of main) for (const s of statsOf(r)) for (const [field, u] of Object.entries(s.unused)) {
  const t = (unusedAgg[`${r.layout}|${field}`] ??= { layout: r.layout, field, count: 0, fmFilled: 0, officeFilled: 0, example: u.example });
  t.count += u.count;
  t.fmFilled += u.fmFilled;
  t.officeFilled += u.officeFilled;
}
table(
  ["Layout", "Field", "Records", "Filled in FM", "Filled on Office", "Example (FM → Office)"],
  Object.values(unusedAgg).sort((a, b) => a.layout.localeCompare(b.layout) || b.count - a.count).map((u) => [u.layout, code(u.field), u.count, u.fmFilled, u.officeFilled, `${u.example?.fm || "_empty_"} → ${u.example?.office || "_empty_"}`]),
);
h(3, "Field inventory: present on one side only");
table(
  ["Query", "Only in FileMaker", "Only on Office"],
  main.filter((r) => r.fields && (r.fields.onlyFm.length || r.fields.onlyOffice.length)).map((r) => [
    code(r.name),
    r.fields.onlyFm.map((f) => `${code(f.field)}${f.used ? " **(read by the site)**" : ""}`).join(", ") || "—",
    r.fields.onlyOffice.map((f) => `${code(f.field)}${f.used ? " **(read by the site)**" : ""}`).join(", ") || "—",
  ]),
);

h(2, "Image fields");
p("State of every image field the site reads, on matched records: both sides hold a URL, only one side does, or neither. `FM error` = FileMaker rows holding `[MBS] Invalid image reference` (test rows, see src/lib/profile-image.ts); these are counted as empty on the FileMaker side. `Green Web Category::Cover_Picture` is left out: Office no longer emits it by design and the site reads `coverPicture_webp`.");
const imgRows = [];
const imgLists = [];
for (const r of main) for (const s of statsOf(r)) for (const [field, st] of Object.entries(s.images)) {
  imgRows.push([code(r.name), code(field), st.both, st.fmOnly, st.officeOnly, st.neither, st.fmError]);
  if (st.fmOnlyKeys.length) imgLists.push(`${code(r.name)} ${code(field)} — **URL in FileMaker, empty on Office**: ${st.fmOnlyKeys.map(code).join(", ")}`);
  if (st.officeOnlyKeys.length) imgLists.push(`${code(r.name)} ${code(field)} — empty in FileMaker, URL on Office: ${st.officeOnlyKeys.slice(0, 40).map(code).join(", ")}${st.officeOnlyKeys.length > 40 ? ` … ${st.officeOnlyKeys.length - 40} more` : ""}`);
  if (st.fmErrorKeys.length) imgLists.push(`${code(r.name)} ${code(field)} — FM error rows: ${st.fmErrorKeys.slice(0, 40).map(code).join(", ")}${st.fmErrorKeys.length > 40 ? ` … ${st.fmErrorKeys.length - 40} more` : ""}`);
}
table(["Query", "Field", "Both", "FM only", "Office only", "Neither", "FM error"], imgRows);
list(imgLists, 60);
h(3, "Records the site lists with no image on Office");
p("Per list query: matched records whose Office image field is empty. `Lost` = FileMaker held a real URL there.");
const emptyOffice = [];
for (const r of main.filter((x) => Q[x.name])) for (const s of statsOf(r)) for (const [field, st] of Object.entries(s.images)) {
  const empties = st.neither + st.fmOnly;
  if (empties) emptyOffice.push([code(r.name), code(field), empties, st.fmOnly, st.fmOnlyKeys.map(code).join(", ")]);
}
table(["Query", "Field", "Empty on Office", "Lost", "Lost records"], emptyOffice);

h(2, "Release portals (keyed by Album within artist)");
for (const r of main.filter((x) => x.portal?.name === "Green Web Category")) {
  const a = r.portal;
  h(3, r.name);
  table(
    ["Measure", "FileMaker", "Office"],
    [
      ["Portal rows", a.fmRows, a.officeRows],
      ["Rows with empty Album (dropped by the site)", a.fmEmptyKeyRows, a.officeEmptyKeyRows],
      ["Duplicate Album within one artist (one release for the site)", a.fmDupes.length, a.officeDupes.length],
      ["Artists compared", a.parentsCompared, a.parentsCompared],
      ["Release rows matched", a.records.matched, a.records.matched],
    ],
  );
  p(`Releases in FileMaker but not on Office (${a.missingOnOffice.length}):`);
  list(a.missingOnOffice.map((m) => `${code(m.parent)} → ${code(m.key)}`));
  p(`Releases on Office but not in FileMaker (${a.missingOnFm.length}):`);
  list(a.missingOnFm.map((m) => `${code(m.parent)} → ${code(m.key)}`));
  p(`Artists whose release rows come back in a different order: ${a.orderDiffers.length}. The site re-sorts by release date, so order only matters for equal or missing dates.`);
  p("Release field values: " + KINDS.map((k) => `${k} ${a.records.fieldStats[k]}`).join(", ") + ".");
}
if (detail.length) {
  h(3, "Per-slug detail finds (active artists)");
  const agg = { fmRows: 0, officeRows: 0, missOff: [], missFm: [], diffs: 0, image: 0 };
  for (const r of detail) {
    agg.fmRows += r.portal?.fmRows ?? 0;
    agg.officeRows += r.portal?.officeRows ?? 0;
    agg.missOff.push(...(r.portal?.missingOnOffice ?? []));
    agg.missFm.push(...(r.portal?.missingOnFm ?? []));
    agg.diffs += total(r, "differs");
    agg.image += total(r, "image");
  }
  table(["Measure", "FileMaker", "Office"], [["Release rows across active artists", agg.fmRows, agg.officeRows], ["Release rows missing", agg.missOff.length, agg.missFm.length]]);
  list(agg.missOff.map((m) => `FileMaker only: ${code(m.parent)} → ${code(m.key)}`));
  list(agg.missFm.map((m) => `Office only: ${code(m.parent)} → ${code(m.key)}`));
}

h(2, "Web post blocks");
p("Blocks are keyed by portal row `recordId` (the homepage binds slots to ids 3, 4, 55–60). `id changed` = the same subject exists under a new id. `rendered block order differs` compares the order the site shows after its own sortOrder sort.");
const web = main.find((x) => x.name === "getWebPosts");
if (web?.portal) {
  const a = web.portal;
  table(["Measure", "FileMaker", "Office"], [["Sections (categories)", web.fm.count, web.office.count], ["Blocks", a.fmRows, a.officeRows], ["Blocks matched by recordId", a.records.matched, a.records.matched]]);
  p(`Sections only in FileMaker: ${web.missingOnOffice.map((m) => code(m.key)).join(", ") || "none"}. Sections only on Office: ${web.missingOnFm.map((m) => code(m.key)).join(", ") || "none"}.`);
  p(`Blocks in FileMaker, not on Office (${a.missingOnOffice.length}):`);
  list(a.missingOnOffice.map((m) => `${code(m.parent)} · id ${code(m.key)} · ${m.label || "_no subject_"}`));
  p(`Blocks on Office, not in FileMaker (${a.missingOnFm.length}):`);
  list(a.missingOnFm.map((m) => `${code(m.parent)} · id ${code(m.key)} · ${m.label || "_no subject_"}`));
  const events = a.webPostBlocks;
  p(`Changes on matched blocks (${events.length}):`);
  table(
    ["Section", "Event", "Block", "Field", "FileMaker", "Office"],
    events.map((e) => [
      e.section,
      e.event,
      e.recordId ? code(e.recordId) : e.fmRecordId ? `${code(e.fmRecordId)} → ${code(e.officeRecordId)}` : e.firstDiffAt !== undefined ? `at #${e.firstDiffAt}: ${e.fm.map(code).join(", ")} / ${e.office.map(code).join(", ")}` : "",
      e.field ? code(e.field) : e.subject ?? "",
      e.fm === undefined ? "" : e.fm || "_empty_",
      e.office === undefined ? "" : e.office || "_empty_",
    ]),
  );
  const home = main.find((x) => x.name === 'getWebPosts("Ninetone Group")');
  if (home?.portal) {
    const ids = ["3", "4", "55", "56", "57", "58", "59", "60"];
    const missing = home.portal.missingOnOffice.filter((m) => ids.includes(m.key));
    p(`Homepage slot ids (3, 4, 55–60): ${missing.length ? `**MISSING on Office: ${missing.map((m) => m.key).join(", ")}**` : `all present on Office (${home.portal.records.matched} Ninetone Group blocks matched by id)`}.`);
  }
  p("Per-section blocks on both sides, with the site-visible text fields identical or not:");
  const perSection = [];
  for (const sec of web.keys.fm.filter((k) => web.keys.office.includes(k))) {
    const d = a.records.diffs.filter((x) => x.parent === sec).length;
    const miss = a.missingOnOffice.filter((x) => x.parent === sec).length + a.missingOnFm.filter((x) => x.parent === sec).length;
    perSection.push([code(sec), d === 0 && miss === 0 ? "identical" : `${d} field values differ, ${miss} blocks unmatched`]);
  }
  table(["Section", "Blocks"], perSection);
}

h(2, "Method");
p("One FileMaker Data API session (closed at the end) and bearer GETs on the Office website API. Every body is the one the getter in src/lib/ninetone.ts sends, including sort, limit, offset and portal limits. No cache layer sits in between, so both answers are live. Values are compared as strings after `String()`; keys and values are compared in Unicode NFC. Images are compared by state (URL present / empty / error), never by bytes.");
p("Dependent finds follow the pages: `getWebPosts(category)` for every section the site asks for (homepage, three divisions, team, Promo, Guider, and `FAQ <tag>` for every booking category on either side), a per-slug `API_Booking` find for curated talents outside the strict roster, and a per-slug `API_ARTIST_DETAIL` find with the release portal for every active artist on either side.");
p("Fields the site reads per layout are listed in `USED_FIELDS` in the script, taken from docs/handoff-codex-database-migration-2026-10-26.md §4 and checked against the pages with grep. A FileMaker field absent from that list is reported under \"Fields the site never reads\" rather than as a content difference.");

fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_MD, md.join("\n"));
// Keep the JSON useful but bounded: drop per-record status maps and key lists for the per-slug detail finds.
const slim = results.map((r) => (r.name.startsWith("getArtistDetailWithReleases(") ? { ...r, keys: undefined, statuses: undefined, fields: undefined } : r));
fs.writeFileSync(OUT_JSON, JSON.stringify({ generated: new Date().toISOString(), fmHost: FM_HOST, officeOrigin: OFFICE_ORIGIN, totals, results: slim }, null, 1));
log(`\nReport: ${path.relative(ROOT, OUT_MD)}\nJSON:   ${path.relative(ROOT, OUT_JSON)}`);
console.log(JSON.stringify({ totals, failed: failed.map((r) => r.name) }, null, 2));
