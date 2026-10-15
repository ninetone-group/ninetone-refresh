import assert from "node:assert/strict";
import test from "node:test";

import { renderNewsFeed, rssDate, feedPath, escapeXml, FEED_ITEM_LIMIT } from "../src/lib/rss.ts";

const ORIGIN = "https://www.ninetone.com";

const item = (over = {}) => ({
  slug: "ny-singel",
  title: "Ny singel & turné",
  excerpt: "Första meningen.",
  contentHtml: "<p>Hela <strong>texten</strong>.</p>",
  date: "10/12/2026",
  image: "https://ninetone-fm-image-proxy.ninetone.workers.dev/news/ny-singel",
  author: "Patrik",
  category: "Records",
  ...over,
});

const render = (over = {}) =>
  renderNewsFeed({ origin: ORIGIN, lang: "sv", items: [item()], title: "Ninetone Group — Nyheter", description: "Beskrivning.", ...over });

test("feedPath: sv at the root, en under /en", () => {
  assert.equal(feedPath("sv"), "/news.xml");
  assert.equal(feedPath("en"), "/en/news.xml");
});

test("rssDate: FM MM/DD/YYYY becomes RFC 822 at midnight UTC; junk is undefined", () => {
  assert.equal(rssDate("10/12/2026"), "Mon, 12 Oct 2026 00:00:00 GMT");
  assert.equal(rssDate(""), undefined);
  assert.equal(rssDate(undefined), undefined);
  assert.equal(rssDate("not a date"), undefined);
});

test("channel: title, link, self link, language and ttl for the Swedish feed", () => {
  const xml = render();
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"'));
  assert.match(xml, /<channel>\n<title>Ninetone Group — Nyheter<\/title>\n<link>https:\/\/www\.ninetone\.com\/news<\/link>/);
  assert.match(xml, /<language>sv-SE<\/language>/);
  assert.match(xml, /<atom:link href="https:\/\/www\.ninetone\.com\/news\.xml" rel="self" type="application\/rss\+xml" \/>/);
  assert.match(xml, /<lastBuildDate>Mon, 12 Oct 2026 00:00:00 GMT<\/lastBuildDate>/);
  assert.match(xml, /<ttl>15<\/ttl>/);
});

test("item: link, guid, date, author, category, escaped description, CDATA body, media image", () => {
  const xml = render();
  assert.match(xml, /<item><title>Ny singel &amp; turné<\/title><link>https:\/\/www\.ninetone\.com\/news\/ny-singel<\/link>/);
  assert.match(xml, /<guid isPermaLink="true">https:\/\/www\.ninetone\.com\/news\/ny-singel<\/guid>/);
  assert.match(xml, /<pubDate>Mon, 12 Oct 2026 00:00:00 GMT<\/pubDate>/);
  assert.match(xml, /<category>Records<\/category><dc:creator>Patrik<\/dc:creator>/);
  assert.match(xml, /<description>Första meningen\.<\/description>/);
  assert.match(xml, /<content:encoded><!\[CDATA\[<p>Hela <strong>texten<\/strong>\.<\/p>\]\]><\/content:encoded>/);
  assert.match(xml, /<media:content url="https:\/\/ninetone-fm-image-proxy\.ninetone\.workers\.dev\/news\/ny-singel" medium="image" \/>/);
});

test("english feed: /en links and language, but the guid stays the Swedish URL", () => {
  const xml = render({ lang: "en" });
  assert.match(xml, /<link>https:\/\/www\.ninetone\.com\/en\/news<\/link>/);
  assert.match(xml, /<language>en<\/language>/);
  assert.match(xml, /<atom:link href="https:\/\/www\.ninetone\.com\/en\/news\.xml"/);
  assert.match(xml, /<item><title>[^<]*<\/title><link>https:\/\/www\.ninetone\.com\/en\/news\/ny-singel<\/link>/);
  assert.match(xml, /<guid isPermaLink="true">https:\/\/www\.ninetone\.com\/news\/ny-singel<\/guid>/);
});

test("optional fields are omitted, not emitted empty", () => {
  const xml = render({ items: [item({ date: "", image: undefined, author: "", category: undefined, excerpt: "" })] });
  const itemXml = xml.slice(xml.indexOf("<item>"));
  for (const tag of ["pubDate", "media:content", "dc:creator", "category", "description"]) {
    assert.ok(!itemXml.includes(`<${tag}`), `${tag} must be absent from the item`);
  }
  assert.ok(!xml.includes("<lastBuildDate>"));
});

test("a body containing ]]> cannot break out of the CDATA section", () => {
  const xml = render({ items: [item({ contentHtml: "<p>a]]>b</p>" })] });
  assert.match(xml, /<!\[CDATA\[<p>a\]\]\]\]><!\[CDATA\[>b<\/p>\]\]>/);
});

test("items without a slug or title are dropped and the feed is capped", () => {
  const many = Array.from({ length: FEED_ITEM_LIMIT + 5 }, (_, i) => item({ slug: `p-${i}` }));
  const xml = render({ items: [item({ slug: "" }), item({ title: "" }), ...many] });
  assert.equal((xml.match(/<item>/g) ?? []).length, FEED_ITEM_LIMIT);
  assert.ok(!xml.includes("<title></title>"));
});

test("escapeXml covers the five XML specials", () => {
  assert.equal(escapeXml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
});
