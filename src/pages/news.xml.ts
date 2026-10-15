import type { APIRoute } from "astro";
import { getNews } from "../lib/ninetone";
import { renderBio } from "../lib/markdown";
import { pageJsonLdOrigin } from "../lib/site";
import { fmText, sharedT } from "../lib/t";
import type { Lang } from "../lib/dates";
import { FEED_ITEM_LIMIT, renderNewsFeed } from "../lib/rss";

/**
 * RSS feed of the news section: /news.xml (Swedish) and /en/news.xml
 * (English). Full article text, both languages — see src/lib/rss.ts.
 *
 * Same shape as the sitemap endpoints: prerendered on the static (gh)
 * target, per-request on the Worker where it reads live FM data. The
 * middleware strips "/en" and rewrites to this route with locals.lang set,
 * exactly as it does for the HTML pages, so one file serves both feeds.
 *
 * Translation goes through fmText() with the SAME kinds the news pages use
 * ("title" for the headline, "plain" for the excerpt, "markdown" for the
 * body), so the feed shares every cache key with /news and /news/[slug]
 * (src/lib/admin-content.ts lists them). A string the pages have already
 * served in English is a hit here, and a miss degrades the way the pages
 * do: Swedish text for this render, translation scheduled in the
 * background, and the middleware's short TTL on a budget-refused render
 * lets the next visitor pick up the finished copy.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const origin = pageJsonLdOrigin(request);
  const lang: Lang = (locals as { lang?: Lang } | undefined)?.lang ?? "sv";
  const fm = fmText(locals);
  const t = sharedT(locals);

  const posts = (await getNews()).filter((p) => p.slug).slice(0, FEED_ITEM_LIMIT);

  const items = await Promise.all(
    posts.map(async (p) => ({
      slug: String(p.slug),
      title: await fm(String(p.Title ?? ""), "title"),
      excerpt: await fm(String(p.shortMessage ?? "")),
      contentHtml: renderBio(await fm(String(p.MessageString ?? p.Message ?? ""), "markdown")),
      date: p.Date == null ? undefined : String(p.Date),
      image: p.image_webp ? String(p.image_webp) : undefined,
      author: p["Created By"] ? String(p["Created By"]) : undefined,
      category: p.category ? String(p.category) : undefined,
    })),
  );

  // Same source strings as src/pages/news/index.astro, so the channel head
  // reads like the page it mirrors and costs no new translation.
  const title = `Ninetone Group — ${await t("News")}`;
  const description = await t(
    "Releases, signings, tours, and the occasional unguarded thought, from the house in Sundsvall, with a foot in Stockholm.",
  );

  return new Response(renderNewsFeed({ origin, lang, items, title, description }), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=900",
    },
  });
};
