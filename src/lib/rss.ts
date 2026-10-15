import { localizedPath } from "./i18n.ts";
import { fmDateToIso } from "./fm-date.ts";
import type { Lang } from "./dates.ts";

/**
 * RSS 2.0 for /news.xml and /en/news.xml (asked for by Patrik, 2026-10-15).
 *
 * Pure: the endpoint (src/pages/news.xml.ts) reads FM, translates and renders
 * the Markdown, then hands this module plain values. Nothing here touches
 * Astro, KV or the network, so test/rss.test.mjs can pin the document shape
 * under plain Node.
 *
 * Every item carries the full article as `content:encoded` (Mikael's call:
 * full text, both languages) and the excerpt as `description`, so a reader
 * that ignores the content namespace still shows something sensible. The
 * image rides along as `media:content`; an `<enclosure>` needs a byte length
 * the proxy does not know up front.
 */

/** How many articles the feed carries. Readers poll often; the archive is on /news. */
export const FEED_ITEM_LIMIT = 20;

export interface FeedItem {
  slug: string;
  title: string;
  /** Plain-text excerpt (newsExcerpt output, translated). */
  excerpt: string;
  /** Full article body as rendered HTML (renderBio output, translated). */
  contentHtml: string;
  /** FM "MM/DD/YYYY" publish date. */
  date?: string;
  /** Absolute proxy URL, already rewritten by fm-image-mirror. */
  image?: string;
  author?: string;
  category?: string;
}

export interface FeedInput {
  /** Scheme + host (+ preview base path), no trailing slash — pageJsonLdOrigin(). */
  origin: string;
  lang: Lang;
  items: FeedItem[];
  /** Channel title and description, already in `lang`. */
  title: string;
  description: string;
}

const CHANNEL_LANGUAGE: Record<Lang, string> = { sv: "sv-SE", en: "en" };

export function feedPath(lang: Lang): string {
  return localizedPath("/news.xml", lang);
}

/**
 * RFC 822 date for `<pubDate>`. API_NEWS has a date, not a timestamp, so the
 * day is published at midnight UTC — the same value the sitemap `lastmod`
 * and the article JSON-LD state.
 */
export function rssDate(fmDate: string | undefined): string | undefined {
  const iso = fmDateToIso(fmDate);
  if (!iso) return undefined;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toUTCString();
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CDATA cannot contain "]]>" — split the sequence so the document stays well-formed. */
function cdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

export function renderNewsFeed(input: FeedInput): string {
  const { origin, lang } = input;
  const self = `${origin}${feedPath(lang)}`;
  const home = `${origin}${localizedPath("/news", lang)}`;

  const items = input.items
    .filter((item) => item.slug && item.title)
    .slice(0, FEED_ITEM_LIMIT)
    .map((item) => {
      const link = `${origin}${localizedPath(`/news/${item.slug}`, lang)}`;
      const pubDate = rssDate(item.date);
      const parts = [
        `<title>${escapeXml(item.title)}</title>`,
        `<link>${escapeXml(link)}</link>`,
        // The Swedish URL is the article's identity in both feeds: the same
        // story must not show up twice for a reader subscribed to both.
        `<guid isPermaLink="true">${escapeXml(`${origin}/news/${item.slug}`)}</guid>`,
        pubDate ? `<pubDate>${pubDate}</pubDate>` : "",
        item.category ? `<category>${escapeXml(item.category)}</category>` : "",
        item.author ? `<dc:creator>${escapeXml(item.author)}</dc:creator>` : "",
        item.excerpt ? `<description>${escapeXml(item.excerpt)}</description>` : "",
        item.contentHtml ? `<content:encoded>${cdata(item.contentHtml)}</content:encoded>` : "",
        item.image ? `<media:content url="${escapeXml(item.image)}" medium="image" />` : "",
      ].filter(Boolean);
      return `<item>${parts.join("")}</item>`;
    });

  const lastBuild = items.length ? rssDate(input.items[0]?.date) : undefined;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">`,
    `<channel>`,
    `<title>${escapeXml(input.title)}</title>`,
    `<link>${escapeXml(home)}</link>`,
    `<description>${escapeXml(input.description)}</description>`,
    `<language>${CHANNEL_LANGUAGE[lang]}</language>`,
    `<atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml" />`,
    lastBuild ? `<lastBuildDate>${lastBuild}</lastBuildDate>` : "",
    `<ttl>15</ttl>`,
    ...items,
    `</channel>`,
    `</rss>`,
  ]
    .filter(Boolean)
    .join("\n");
}
