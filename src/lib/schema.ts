/**
 * Pure JSON-LD builders. Every function here returns a plain object — no I/O,
 * no Astro globals — so each is unit-testable in isolation (see
 * test/schema.test.mjs). Callers (pages) gather data that is already in
 * scope from existing `src/lib/ninetone.ts` fetches and pass it in; nothing
 * here performs a new FileMaker read.
 *
 * Rendering (escaping "<" so a literal "</script>" in FM string data can't
 * break out of the <script type="application/ld+json"> tag) is owned by
 * src/components/JsonLd.astro, not here — these builders just produce data.
 *
 * `origin` is always the bare origin from `siteOrigin()` (src/lib/site.ts) —
 * never hardcoded, never re-derived here.
 */

import { externalUrl } from "./url.ts";
import { renderBio } from "./markdown.ts";

// ---------------------------------------------------------------------------
// Rendering helper (shared by src/components/JsonLd.astro)
// ---------------------------------------------------------------------------

/**
 * Serialize a JSON-LD object/array for embedding inside a
 * `<script type="application/ld+json">` tag via `set:html`.
 *
 * JSON.stringify() output can legally contain the substring "</script>"
 * inside a string value (e.g. FM bio text with that literal substring),
 * which would otherwise close the tag early and leak the remainder as
 * visible markup. Replacing "<" with its unicode escape "<" neutralizes
 * that while staying valid JSON (JSON strings may contain any unicode
 * escape) — the JSON-LD consumer parses the script contents as text, not as
 * executable JS, so the escape is transparent to it.
 */
export function toEscapedJsonLd(value: Record<string, unknown> | Record<string, unknown>[]): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** The organization's name, in one place — used by organization() and by the
 *  publisher node repeated on article-type schemas. */
export const ORG_NAME = "Ninetone Group";

/**
 * Square wordmark for Organization.logo (seo-phase-1b-brief.md P1 item 10).
 *
 * Distinct from og-default.png, which stays the 1200x630 social card: Google's
 * Organization logo guidance expects the logo itself, and a 1.91:1 card gets
 * cropped awkwardly in a knowledge panel. public/logo-square.png is 512x512,
 * the wordmark centred on the paper canvas.
 */
export const ORG_LOGO_SIZE = 512;
export function logoUrl(origin: string): string {
  return `${origin}/logo-square.png`;
}

/** Stable @id for the Organization node — referenced by every other entity's
 *  `publisher`/`memberOf` via this same string, so JSON-LD consumers can
 *  resolve the graph without re-fetching the org node. */
export function orgId(origin: string): string {
  return `${origin}/#org`;
}

/**
 * Publisher node for article-type schemas.
 *
 * A bare `{"@id": …}` reference is valid JSON-LD — the full Organization node
 * is on the same page, so a graph-aware consumer resolves it — but Google's
 * article validators read the publisher in isolation and report name/logo as
 * missing. Repeating @type/name/logo alongside the @id costs a few bytes and
 * satisfies both readings: the @id still links it to the org node emitted by
 * organization(), so nothing is duplicated as a *separate* entity.
 */
export function publisherNode(origin: string): Record<string, unknown> {
  return {
    "@id": orgId(origin),
    "@type": "Organization",
    name: ORG_NAME,
    logo: {
      "@type": "ImageObject",
      url: logoUrl(origin),
      width: ORG_LOGO_SIZE,
      height: ORG_LOGO_SIZE,
    },
  };
}

/** Strip HTML tags after markdown rendering, collapse whitespace, and
 *  optionally cap length — used for any field JSON-LD wants as plain text
 *  (descriptions, articleBody) where the source is FM markdown. */
export function markdownToPlainText(markdown: string | null | undefined, maxLength?: number): string {
  if (!markdown) return "";
  const html = renderBio(markdown);
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength).replace(/\s+\S*$/, "")}…`;
  }
  return text;
}

/**
 * Meta-description fallback (seo-phase-1b-brief.md P1 item 7): a short FM
 * tagline/blurb makes a thin `<meta name="description">` — Google's own
 * guidance and most SEO tooling flag anything under ~70 characters as too
 * short to be useful in a search snippet. When the tagline is too short (or
 * blank), fall back to the entity's bio, rendered to plain text via
 * markdownToPlainText() (already word-boundary-safe — see that function's
 * `.replace(/\s+\S*$/, "")` truncation) and capped at ~150 characters, which
 * is the conventional meta-description length ceiling.
 *
 * Pure and reused by every entity detail page's `<Base description=…>` — no
 * new truncation logic duplicated per page.
 */
export function descriptionWithBioFallback(
  tagline: string | null | undefined,
  bioMarkdown: string | null | undefined,
  minTaglineLength = 70,
  maxBioLength = 150,
): string {
  const trimmedTagline = String(tagline ?? "").trim();
  if (trimmedTagline.length >= minTaglineLength) return trimmedTagline;
  const bioFallback = markdownToPlainText(bioMarkdown, maxBioLength);
  return bioFallback || trimmedTagline;
}

/**
 * FM date fields (release dates, news post dates) are "MM/DD/YYYY" — convert
 * to ISO-8601 for JSON-LD, or return undefined when the value doesn't match
 * rather than guess/fabricate a date. Shared by every page that needs to
 * turn an FM date string into a JSON-LD `datePublished`/`dateModified`
 * (previously duplicated in three page files — see PR history).
 */
export function fmDateToIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const m = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** Collect only the http(s) values from a set of candidate social URLs,
 *  reusing the project's existing external-URL validator so JSON-LD never
 *  emits a `mailto:`, empty string, or malformed value as `sameAs`. */
function sameAsFrom(...candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const valid = externalUrl(candidate);
    if (valid && !seen.has(valid)) {
      seen.add(valid);
      out.push(valid);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export interface OrganizationOptions {
  /** Instagram URL from Footer socials, when present — the brief calls this
   *  out explicitly as conditional; everything else in the base list is
   *  always included. */
  instagram?: string | null;
}

export function organization(origin: string, opts: OrganizationOptions = {}): Record<string, unknown> {
  const sameAs = sameAsFrom(
    "https://www.wikidata.org/wiki/Q7038555",
    // Both the English and Swedish Wikipedia articles exist (verified via the
    // MediaWiki API: en pageid 25086793; Wikidata Q7038555 carries both
    // enwiki and svwiki sitelinks) — include both for entity reconciliation.
    // Footer only links the Swedish one, but sameAs isn't limited to what
    // Footer happens to surface.
    "https://en.wikipedia.org/wiki/Ninetone_Records",
    "https://sv.wikipedia.org/wiki/Ninetone_Records",
    "https://www.linkedin.com/company/ninetone",
    "https://www.facebook.com/ninetone",
    "https://www.youtube.com/c/Ninetone",
    "https://soundcloud.com/ninetonegroup",
    opts.instagram,
  );

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": orgId(origin),
    name: ORG_NAME,
    url: origin,
    logo: {
      "@type": "ImageObject",
      url: logoUrl(origin),
      width: ORG_LOGO_SIZE,
      height: ORG_LOGO_SIZE,
    },
    sameAs,
    contactPoint: [
      {
        "@type": "ContactPoint",
        email: "booking@ninetone.com",
        contactType: "sales",
        areaServed: "SE",
      },
      {
        "@type": "ContactPoint",
        email: "office@ninetone.com",
        contactType: "customer service",
        areaServed: "SE",
      },
    ],
    address: {
      "@type": "PostalAddress",
      addressLocality: "Sundsvall",
      addressCountry: "SE",
    },
  };
}

// ---------------------------------------------------------------------------
// WebSite (+ SearchAction)
// ---------------------------------------------------------------------------

export function website(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: ORG_NAME,
    url: origin,
    publisher: { "@id": orgId(origin) },
    // No SearchAction. Its only possible target, /search-result, is
    // permanently noindexed (src/pages/search-result.astro) and Google's
    // sitelinks-searchbox requires a crawlable results page — advertising
    // one it may not crawl is a validator warning, not a feature.
  };
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

export interface BreadcrumbItem {
  name: string;
  /** Site-relative path, e.g. "/records/artists/anjo". */
  path: string;
}

export function breadcrumbs(origin: string, items: BreadcrumbItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${origin}${item.path.startsWith("/") ? item.path : `/${item.path}`}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// MusicGroup (Records artist detail)
// ---------------------------------------------------------------------------

export interface MusicGroupAlbum {
  name: string;
  /** ISO date string, e.g. "2024-05-17". Omit if unknown/unparseable. */
  datePublished?: string;
  image?: string;
  url?: string;
}

export interface MusicGroupInput {
  slug: string;
  name: string;
  /** Site-relative path the artist's page actually lives at, e.g.
   *  "records/artists/anjo" (active roster) or
   *  "records/artists/previous/single/anjo" (previous-artist archive).
   *  Defaults to `records/artists/{slug}` — the active-roster shape — when
   *  omitted, so existing callers keep working unchanged. Mirrors
   *  `PersonOptions.path`, which solves the same problem for Person. */
  path?: string;
  /** Tagline or first ~200 chars of bio, already plain text — pass through
   *  markdownToPlainText() before calling if the source is markdown. */
  description?: string;
  image?: string;
  socials?: {
    spotify?: string | null;
    apple?: string | null;
    youtubeMusic?: string | null;
    youtube?: string | null;
    instagram?: string | null;
    tiktok?: string | null;
    facebook?: string | null;
    twitter?: string | null;
  };
  /** Include only when releases are in scope on the calling page. */
  albums?: MusicGroupAlbum[];
}

export function musicGroup(origin: string, artist: MusicGroupInput): Record<string, unknown> {
  const s = artist.socials ?? {};
  const sameAs = sameAsFrom(
    s.spotify,
    s.apple,
    s.youtubeMusic,
    s.youtube,
    s.instagram,
    s.tiktok,
    s.facebook,
    s.twitter,
  );

  const rawPath = artist.path ?? `records/artists/${artist.slug}`;
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const url = `${origin}${path}`;

  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "MusicGroup",
    "@id": `${url}/#entity`,
    name: artist.name,
    url,
    memberOf: { "@id": orgId(origin) },
  };
  if (artist.image) node.image = artist.image;
  if (artist.description) node.description = artist.description;
  if (sameAs.length > 0) node.sameAs = sameAs;

  if (artist.albums && artist.albums.length > 0) {
    node.album = artist.albums.map((album) => {
      const albumNode: Record<string, unknown> = {
        "@type": "MusicAlbum",
        name: album.name,
      };
      if (album.datePublished) albumNode.datePublished = album.datePublished;
      if (album.image) albumNode.image = album.image;
      if (album.url) albumNode.url = album.url;
      return albumNode;
    });
  }

  return node;
}

// ---------------------------------------------------------------------------
// Person (management clients, team, Nation talent)
// ---------------------------------------------------------------------------

export type PersonRole = "client" | "team" | "nation";

export interface PersonOptions {
  role: PersonRole;
  /** Path segment the person's page lives at, e.g. "management/clients/anjo",
   *  "team/some-person", or "ninetone-nation/anjo". */
  path: string;
  jobTitle?: string;
  worksFor?: boolean;
  image?: string;
  description?: string;
  socials?: {
    spotify?: string | null;
    apple?: string | null;
    youtubeMusic?: string | null;
    youtube?: string | null;
    instagram?: string | null;
    tiktok?: string | null;
    facebook?: string | null;
    twitter?: string | null;
  };
  /** Nation talent only: booking category tag(s), e.g. ["Artist"]. Mapped to
   *  `additionalType` entries. */
  bookingCategories?: string[];
}

export function person(origin: string, name: string, opts: PersonOptions): Record<string, unknown> {
  const s = opts.socials ?? {};
  const sameAs = sameAsFrom(
    s.spotify,
    s.apple,
    s.youtubeMusic,
    s.youtube,
    s.instagram,
    s.tiktok,
    s.facebook,
    s.twitter,
  );

  const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const url = `${origin}${path}`;

  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": `${url}/#entity`,
    name,
    url,
  };
  if (opts.image) node.image = opts.image;
  if (opts.description) node.description = opts.description;
  if (sameAs.length > 0) node.sameAs = sameAs;
  if (opts.jobTitle) node.jobTitle = opts.jobTitle;
  if (opts.worksFor) node.worksFor = { "@id": orgId(origin) };

  if (opts.role === "nation") {
    node.offers = {
      "@type": "Offer",
      availability: "https://schema.org/InStock",
      url: `${origin}/ninetone-nation/contact-ninetone-nation`,
    };
    if (opts.bookingCategories && opts.bookingCategories.length > 0) {
      node.additionalType = opts.bookingCategories;
    }
  }

  return node;
}

// ---------------------------------------------------------------------------
// NewsArticle
// ---------------------------------------------------------------------------

export interface NewsArticleInput {
  slug: string;
  headline: string;
  /** Byline as shown on the page (FM "Created By"). Omitted when blank. */
  author?: string;
  /** ISO date string. */
  datePublished: string;
  /** ISO date string. Falls back to datePublished when absent. */
  dateModified?: string;
  image?: string;
  /** Plain text (already stripped of markdown/HTML) — pass FM markdown
   *  through markdownToPlainText() first. */
  articleBody?: string;
}

export function newsArticle(origin: string, post: NewsArticleInput): Record<string, unknown> {
  const url = `${origin}/news/${post.slug}`;
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "@id": `${url}/#article`,
    headline: post.headline,
    datePublished: post.datePublished,
    dateModified: post.dateModified || post.datePublished,
    publisher: publisherNode(origin),
    mainEntityOfPage: url,
  };
  if (post.author) node.author = { "@type": "Person", name: post.author };
  if (post.image) node.image = post.image;
  if (post.articleBody) node.articleBody = post.articleBody;
  return node;
}

// ---------------------------------------------------------------------------
// Article (generic — guides and other non-news editorial content)
// ---------------------------------------------------------------------------
// newsArticle() above is deliberately NewsArticle-typed for /news posts.
// Guides (src/pages/guider/[slug].astro) are evergreen how-to/reference
// content, not news, so schema.org's generic Article type is the correct
// fit rather than reusing NewsArticle — same field shape and same
// "@id"/mainEntityOfPage pattern, just a different @type and a caller-
// supplied path (guides live at /guider/{slug}, not /news/{slug}).

export interface ArticleInput {
  /** Site-relative path the article lives at, e.g. "/guider/some-guide". */
  path: string;
  headline: string;
  /** Byline as shown on the page. Omitted when blank. */
  author?: string;
  /** ISO date string. Omit when no real publish date exists. */
  datePublished?: string;
  /** ISO date string. Falls back to datePublished when absent (matches
   *  newsArticle()'s behavior) — never fabricated when neither is known. */
  dateModified?: string;
  image?: string;
  /** Plain text (already stripped of markdown/HTML) — pass FM markdown
   *  through markdownToPlainText() first. */
  articleBody?: string;
}

export function article(origin: string, input: ArticleInput): Record<string, unknown> {
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const url = `${origin}${path}`;
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": `${url}/#article`,
    headline: input.headline,
    publisher: publisherNode(origin),
    mainEntityOfPage: url,
  };
  if (input.author) node.author = { "@type": "Person", name: input.author };
  if (input.datePublished) {
    node.datePublished = input.datePublished;
    node.dateModified = input.dateModified || input.datePublished;
  } else if (input.dateModified) {
    node.dateModified = input.dateModified;
  }
  if (input.image) node.image = input.image;
  if (input.articleBody) node.articleBody = input.articleBody;
  return node;
}

// ---------------------------------------------------------------------------
// CollectionPage
// ---------------------------------------------------------------------------

export interface CollectionPageInput {
  name: string;
  /** Site-relative path of the collection page itself. */
  path: string;
  items: BreadcrumbItem[];
}

export function collectionPage(origin: string, input: CollectionPageInput): Record<string, unknown> {
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const url = `${origin}${path}`;
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${url}/#collection`,
    name: input.name,
    url,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: input.items.length,
      itemListElement: input.items.map((item, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: item.name,
        url: `${origin}${item.path.startsWith("/") ? item.path : `/${item.path}`}`,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// FAQPage
// ---------------------------------------------------------------------------

export interface FaqItem {
  q: string;
  a: string;
}

export function faqPage(items: FaqItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// ContactPage
// ---------------------------------------------------------------------------

export function contactPage(origin: string, path: string): Record<string, unknown> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${origin}${p}`;
  return {
    "@context": "https://schema.org",
    "@type": "ContactPage",
    "@id": `${url}/#contact`,
    url,
    about: { "@id": orgId(origin) },
  };
}
