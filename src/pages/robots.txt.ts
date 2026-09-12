import type { APIRoute } from "astro";
import { pageJsonLdOrigin } from "../lib/site.ts";

/**
 * robots.txt as an endpoint rather than a static file, so the same build can
 * serve either shape depending on `PUBLIC_NOINDEX` — no separate
 * preview-vs-production file to remember to swap. See
 * docs/seo-strategy-2026-09.md Appendix A for "Variant A" (allow-all +
 * Content-Signal) and the three-noindex-flips-together launch checklist.
 *
 * Mirrors the exact env-flag read in src/layouts/Base.astro (`envNoindex`) —
 * same default (noindex unless explicitly disabled) so this can never drift
 * from the meta-tag behavior.
 */
export function buildRobotsTxt(origin: string, envNoindex: boolean): string {
  if (envNoindex) {
    return "User-agent: *\nDisallow: /\n";
  }

  // Variant A from docs/seo-strategy-2026-09.md Appendix A: allow every
  // crawler, including AI training bots — this is marketing content whose
  // whole purpose is to be known. Fallback "Variant B" (block training bots
  // only) is a config change away if Patrik objects; not implemented here.
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap-index.xml`,
    "Content-Signal: ai-train=yes, search=yes, ai-input=yes",
    "",
  ].join("\n");
}

// Static target: no incoming Request at build time, so this must be
// prerendered like every other page on the "gh" build (output: "static").
// On the "cf" target (output: "server") a plain export with no prerender
// flag renders per-request by default, which is what we want here since the
// disallow-all/allow-all branch depends on a runtime env var. Setting
// prerender = true unconditionally would be wrong on the cf target (it
// would freeze the response at build time, defeating PUBLIC_NOINDEX being
// flippable without a rebuild) — so this is intentionally NOT set here;
// Astro's per-target default (static => prerendered, server => SSR) is
// exactly the behavior both targets need.
export const GET: APIRoute = async ({ request }) => {
  const envNoindex = String(import.meta.env.PUBLIC_NOINDEX ?? "true") !== "false";
  // pageJsonLdOrigin(), not a bare siteOrigin(): on the still-preview gh
  // target the site is served from a sub-path (/ninetone-refresh-preview),
  // and the Sitemap: line must point at a URL that actually resolves there.
  // Mirrors src/pages/sitemap-pages.xml.ts's own reasoning for the same fix.
  const origin = pageJsonLdOrigin(request);
  const body = buildRobotsTxt(origin, envNoindex);

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
