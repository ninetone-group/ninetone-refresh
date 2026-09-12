import type { APIRoute } from "astro";
import { renderSitemapIndexResponse } from "./sitemap-index.xml.ts";

/**
 * `/sitemap.xml` alias (seo-phase-1b-brief.md P0 item 4) — the conventional
 * path some crawlers and third-party tools probe for instead of reading
 * robots.txt's `Sitemap:` line. That line keeps pointing at
 * `/sitemap-index.xml` (the one URL actually submitted to search engines —
 * see sitemap-index.xml.ts's doc comment); this file must not change that.
 *
 * Shares the exact builder (renderSitemapIndexResponse) rather than
 * duplicating the origin-resolution + XML-assembly logic, so the two
 * endpoints can never drift into serving different documents. Same
 * per-target behavior as sitemap-index.xml.ts: prerendered to a real
 * dist/sitemap.xml file on the static (gh) target, rendered per-request on
 * the cf (server) target.
 */
export const GET: APIRoute = renderSitemapIndexResponse;
