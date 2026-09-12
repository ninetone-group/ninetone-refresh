// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

/**
 * Dual-target config — one codebase, two deploys:
 *
 *  - `gh` (default): fully static, served from GH Pages under the preview
 *    sub-path. Content is frozen at build time. This is the review-phase
 *    preview and stays alive until launch.
 *  - `cf` (DEPLOY_TARGET=cf): server-rendered on Cloudflare Workers Static
 *    Assets. Every page renders from live FM data behind the tiered edge
 *    cache in src/middleware.ts. This is the production architecture
 *    (docs/cms-architecture.md) — staging on workers.dev until DNS flips.
 *
 * Build commands: `npm run build` (gh) / `npm run build:cf` (cf).
 *
 * History note (why the adapter was once removed): with static output the
 * adapter wrapped the prerender step in Miniflare, whose fetch failed against
 * the FileMaker host. In cf mode nothing fetches FM at build time — pages
 * render on demand — so that failure mode no longer exists.
 */
const TARGET = process.env.DEPLOY_TARGET === "cf" ? "cf" : "gh";

const site =
  TARGET === "cf"
    ? process.env.SITE_URL ?? "https://ninetone-site.ninetone.workers.dev"
    : "https://ninetone-group.github.io";

// Adapter is imported lazily so plain `npm run build` (gh) never loads the
// Cloudflare module graph — it needs Node >=22.15 (module.registerHooks),
// while the static path keeps working on the team's `nvm use 22` default.
const cloudflare = TARGET === "cf" ? (await import("@astrojs/cloudflare")).default : null;

export default defineConfig({
  site,
  // On launch: drop to "/" everywhere (url() becomes a no-op).
  base: TARGET === "cf" ? "/" : "/ninetone-refresh",
  output: TARGET === "cf" ? "server" : "static",
  // Image optimization is unused (plain <img> + FM proxy) — passthrough
  // avoids any IMAGES binding expectations on the Worker.
  adapter: cloudflare ? cloudflare({ imageService: "passthrough" }) : undefined,
  // gh (static): "ignore" — GH Pages serves directory index files
  // (/records/index.html for both /records and /records/), so either shape
  // must keep working with no redirect (there's no server to issue one).
  // cf (server): "never" — canonical shape is the bare path; src/middleware.ts
  // 301s any "/path/" to "/path" ahead of the cache lookup (seo-phase-1b-brief
  // P0 item 5), so a trailing slash is never the URL that gets rendered or
  // cached. Conditional on TARGET the same way `base` and `output` are above.
  trailingSlash: TARGET === "cf" ? "never" : "ignore",
  // SEO Phase 1 §8 — legacy path redirects, both 301.
  //
  // Destinations are written as bare logical paths (no `base` prefix) to
  // match every other route string in this config/codebase; Astro does not
  // prepend `base` to redirect destinations itself (known inconsistency,
  // see withastro/astro#7774), so these are only guaranteed correct on the
  // `cf` target, where `base` is "/" and the bare path IS the real path.
  // That's fine: the `gh` target is the noindexed preview with no inbound
  // links to these legacy paths, and GitHub Pages has no server-side
  // redirect mechanism anyway — Astro's static build falls back to a
  // <meta http-equiv="refresh"> HTML page for `redirects` entries there,
  // which is the correct and expected outcome on that platform, not a bug.
  //
  // DEVIATION FROM BRIEF: the brief's target for /previous-artists is
  // "/records/artists/previous/1", which does not exist. Astro's
  // paginate() (src/pages/records/artists/previous/[...page].astro) emits
  // page 1 at the route's own BARE path and pages 2+ at "/previous/{n}" —
  // confirmed in src/lib/routes.ts's STATIC_ROUTES comment and in a fresh
  // build (dist/records/artists/previous/index.html exists,
  // dist/records/artists/previous/1/ does not). Redirecting to ".../1"
  // would 404. Redirect to the bare path instead, matching the existing
  // (currently-inert on both deploy targets — see public/_redirects and
  // DEPLOY.md) /previous-artists rule and every other internal link to
  // this page (ArtistsTabs.astro, Footer.astro).
  redirects: {
    "/previous-artists": {
      status: 301,
      destination: "/records/artists/previous",
    },
    // The per-artist legacy shapes (/previous-artists/{slug} and
    // /previous-artists/single/{slug}) are deliberately NOT here. The
    // Cloudflare adapter writes dynamic config redirects into _redirects with
    // an "/index.html" suffix on the destination
    // (@astrojs/underscore-redirects), which 404s on an SSR Worker — verified
    // on staging: the clean path returns 200, the /index.html form 404s. Since
    // the static-asset layer answers before the Worker, those generated rules
    // hijacked the very URLs they were meant to rescue, and hand-written
    // corrections alongside them are rejected with "Duplicate rule for path".
    // They are hand-written in public/_redirects instead (which is what
    // actually serves them on cf), mirrored by legacyPreviousArtistTarget()
    // in src/lib/cache-policy.ts as a Worker-side backstop.
    //
    // Only static-destination redirects stay in this block: the adapter writes
    // those without the /index.html suffix, so they work as intended.
    "/blog": {
      status: 301,
      destination: "/news",
    },
  },
  // No integrations: src/pages/sitemap-index.xml.ts + sitemap-pages.xml.ts
  // (SEO Phase 1 §3) replace @astrojs/sitemap with hand-written endpoints
  // that use siteOrigin() and the real FM list helpers — see that file's
  // doc comment for why the integration was dropped rather than kept
  // alongside them.
  integrations: [],
  vite: {
    plugins: [tailwindcss()],
    define: {
      // Baked per build. Part of every edge-cache key (src/middleware.ts) so a
      // DEPLOY naturally starts a fresh cache generation — old-code pages are
      // never served after a release. Content freshness is the KV epoch's job.
      __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
      // Single source of truth for "are we on the Cloudflare (server) target".
      // DEPLOY_TARGET itself is a build-time process.env var, invisible to
      // client <script> tags and not conventionally read from Astro
      // frontmatter — this re-exposes the same decision as a PUBLIC_ var so
      // components can branch consistently in both places via
      // `import.meta.env.PUBLIC_HAS_RUNTIME`.
      "import.meta.env.PUBLIC_HAS_RUNTIME": JSON.stringify(TARGET === "cf"),
    },
    build: {
      rollupOptions: {
        // src/lib/cf.ts imports this dynamically; in the gh/static build it
        // must stay external (Node throws at runtime and we catch it — the
        // cf adapter externalizes it itself).
        external: ["cloudflare:workers"],
      },
    },
  },
  // Phase 2 i18n (docs/i18n-phase-2-brief.md, decision 1) — Swedish is the
  // root locale, English lives under /en/. Swedish is Ninetone's home
  // market and the language most FM content already exists in; English is
  // the secondary/export-facing locale, not the other way around. That's
  // the opposite of Astro's usual English-default convention, hence
  // spelling it out here rather than leaving `defaultLocale: "sv"` to look
  // like a typo.
  //
  // `redirectToDefaultLocale: false` AND no browser-Accept-Language
  // redirect is added anywhere else, on purpose and permanently — decision
  // 1 is emphatic that this never happens. An automatic redirect would
  // mean a Swedish visitor who explicitly typed/clicked an "/en/..." URL
  // (shared link, search result, bookmark) gets bounced back to Swedish
  // against their clearly-stated intent, and there is no reliable browser
  // signal that distinguishes "prefers Swedish" from "is in Sweden but
  // wants the English copy for a client abroad". The only way to change
  // language is the explicit switch in the header, which points at the
  // exact alternate URL via alternatePath() (src/lib/i18n.ts).
  i18n: {
    defaultLocale: "sv",
    locales: ["sv", "en"],
    routing: {
      prefixDefaultLocale: false,
      redirectToDefaultLocale: false,
    },
  },
});
