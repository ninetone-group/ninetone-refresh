# Ninetone Refresh

Astro + Tailwind v4 site for Ninetone Group, built statically and deployed to GitHub Pages. FileMaker-driven content. Cloudflare Worker handles image bytes (the runtime layer GH Pages lacks).

## Stack

- **Framework:** Astro 7. `output` is conditional on `DEPLOY_TARGET` ([astro.config.mjs](astro.config.mjs)): `"static"` for the GH Pages build, `"server"` via `@astrojs/cloudflare` for `build:cf`. The adapter was dropped once and is back — read the config comment before removing it again.
- **Hosting:** GitHub Pages via GitHub Actions ([.github/workflows/deploy.yml](.github/workflows/deploy.yml))
- **Image proxy:** Cloudflare Worker at [worker-fm-proxy/](worker-fm-proxy/) — see [DEPLOY.md](DEPLOY.md) for *why* this exists; it's load-bearing
- **Styling:** Tailwind v4 (Vite plugin) + `@tailwindcss/typography`. Stylesheets are
  **inlined** into every page (`build.inlineStylesheets: "always"`, Lighthouse 2026-09-14) —
  there is no external CSS request; don't "fix" the missing `<link rel="stylesheet">`.
- **Client router:** Astro's `<ClientRouter />` is mounted in [Base.astro](src/layouts/Base.astro);
  pages swap in place instead of reloading. **Every hoisted `<script>` must bind inside a
  function registered on `astro:page-load`** (the script itself runs once per full load), and
  every `is:inline` behaviour script carries `data-astro-rerun`. Global `document`/`window`
  listeners are registered once and look elements up at event time. Pinned by
  `test/client-router-contract.test.mjs`. The language switch (`data-lang-switch`) keeps the
  reader's place and plays the decode sweep — see the script at the end of Base.astro.
- **Search:** `fuse.js` client-side
- **Markdown:** `marked`
- **Sitemap:** hand-written per-locale endpoints (`src/pages/sitemap-*.xml.ts`) — `@astrojs/sitemap` was removed
- **Node:** >=22.19.0 (use `nvm use 22` — system default 20.x will fail)

## Run

```bash
nvm use 22
npm run dev      # local dev (port 4321 / falls back to 4322)
npm run build    # production build
npm run preview  # serve built output
npm test         # node --experimental-strip-types --test test/*.test.mjs
```

**A `src/lib` module imported directly by a test must use `.ts` import extensions.** The
suite runs under plain Node, which has no bundler-style extension resolution, so an
extensionless specifier that works fine under Astro/Vite throws `ERR_MODULE_NOT_FOUND` at
test time. Most of `src/lib` already uses the extension; the handful that omit it
(`ninetone.ts`, `shopify.ts`, `youtube.ts`) are the ones no test imports directly.

**Both build targets share `dist/`.** `npm run build` (gh) and `npm run build:cf` (cf)
overwrite each other. This bites harder than it looks, because `wrangler deploy` does
**not** read `wrangler.jsonc` — `.wrangler/deploy/config.json` redirects it to the
*generated* `dist/server/wrangler.json`. So a stale `dist/` ships both the wrong code
**and** the wrong deploy config (bindings, DO migrations, cron triggers), and a gh build
does not write that config at all. Always deploy as one command:

```bash
npm run deploy:cf   # = npm run build:cf && wrangler deploy — never separate these
```

The GitHub workflow only deploys the GH Pages preview (`npm run build`). The Worker is
never deployed from CI — it ships from your machine with the command above.

Release bookkeeping lives in `VERSION` (`MAJOR.MINOR.PATCH.MICRO`) and
[CHANGELOG.md](CHANGELOG.md). Bump both in the same commit as the change they describe.

## Layout

- `src/pages/` — Astro routes
- `src/components/` — reusable Astro components
- `src/layouts/` — page layouts (only `Base.astro`)
- `src/lib/` — helpers (FileMaker fetch, Shopify, sections palette, etc.)
- `src/lib/publication/` — translate-before-publish subsystem (shadow mode; nothing is served from it)
- `scripts/` — build/ops scripts. `perf-cold-probe.mjs` fetches staging routes with a
  cache-busting query and prints the `Server-Timing` breakdown (`trbundle`, `trnkv`,
  `fmkv`, `fmnet`) so a slow render can be attributed. Read-only: no writes, no model calls.
- `src/styles/` — Tailwind entrypoints + design tokens
- `public/` — static assets
- `_old/` — legacy DivHunt SPA artifacts (ignored — do not edit)
- `worker-fm-proxy/` — Cloudflare Worker that serves FM images. Has its own `node_modules`. Deploy with `cd worker-fm-proxy && npm run deploy` (= `wrangler deploy -c wrangler.toml`; a bare `wrangler deploy` there follows the parent repo's `.wrangler/deploy/config.json` redirect and deploys the SITE from `dist/` instead — verified 2026-09-13).

## FM data + image proxy invariants

- **Build-time data**: every FM read goes through [src/lib/filemaker.ts](src/lib/filemaker.ts), which caches the bearer token (12 min TTL, FM expires at 15) and per-call responses. Don't bypass.
- **On the Worker, FM finds also go through a KV read-through** — [src/lib/fm-kv.ts](src/lib/fm-kv.ts), 300 s TTL, keyed by the same Publish epoch the edge cache uses. The in-memory cache is per isolate, so without this every recycled isolate paid FM in full. A Publish bumps the epoch and forces a live read. No KV binding (static build, Node dev) means a straight FM call, so it is never a correctness layer.
- **Translations are read per route, not per string.** [src/lib/translate.ts](src/lib/translate.ts) writes one bundle per route under a `trb:` key; the middleware reads it in a single KV round trip, and any remaining individual reads are batched into KV bulk gets. Check the bundle path before adding a new per-string read.
- **Image URLs rotate AND expire.** FileMaker `Streaming_SSL/RCFileProcessor` URLs are session-bound — they 401 within ~15 min of being generated. A static site that embeds them is broken by tomorrow morning.
- **Every FM image URL gets rewritten** to a Worker proxy URL during the build by [src/lib/fm-image-mirror.ts](src/lib/fm-image-mirror.ts). The Worker holds a live session token and resolves fresh streaming URLs per request.
- **To add a new image-bearing layout**: add it to `LAYOUT_CONFIG` in [src/lib/fm-image-mirror.ts](src/lib/fm-image-mirror.ts) AND add a matching route in [worker-fm-proxy/src/index.ts](worker-fm-proxy/src/index.ts), then redeploy both.
- **Image components use `.fm-img-frame` + `.fm-img`** for the shimmer skeleton + fade-in pattern. Defined in [src/styles/global.css](src/styles/global.css). Wire `onload="this.classList.add('is-loaded'); this.closest('.fm-img-frame')?.classList.add('is-ready')"` on the `<img>`.
- **Production CMS architecture is documented in [docs/cms-architecture.md](docs/cms-architecture.md).** Read it before proposing cutover work or runtime FM patterns. The target state is FM as live headless CMS via Cloudflare Workers + tiered edge caching, decided — don't re-litigate the architecture.
- **The publication cron is paused.** `PUBLICATION_TICK: "off"` in [wrangler.jsonc](wrangler.jsonc) `vars` stops the every-minute discovery tick; the subsystem is shadow-only and serves no visitor. It is a var, not a secret, so it can be flipped from the Cloudflare dashboard without a redeploy. Remove the line (or set anything but `"off"`) to resume.
- **Don't propose changes on the FM side.** Ninetone's FM is a sophisticated production platform doing heavy real-time aggregation. The Data API is our integration surface. No new endpoints, no schema changes, no extended session timeouts, no "could FM expose X" asks. Work with the system, not against it.

## Path-aware URLs

The site is served from a sub-path (`/ninetone-refresh/`) on GH Pages. **Every internal link / image src / fetch URL must go through `url()` from [src/lib/url.ts](src/lib/url.ts)**, OR be rendered by a component that already wraps it (BentoTile, etc.). Plain `href="/foo"` 404s. When going public on the production domain, drop `base` from `astro.config.mjs` and the helper becomes a no-op.

## Design system

**Source of truth:** [DESIGN.md](DESIGN.md). Always read it before adding or restyling components — it is short and load-bearing.

**One-line summary:** Editorial-magazine confidence with restraint — paper canvas, oversized Newsreader serif headlines (h1 `clamp(2.75rem, 7vw, 6.5rem)`), Space Mono kickers, brand colors (`red`/`navy`/`green`) used as accents only, square corners, surgical motion.

**Hard rules — do not break:**

1. **Page canvas is `bg-ninetone-paper`.** Brand-color full backgrounds are reserved for Footer / PromoBar / MetricsPanel / MarqueeBand / portal-card hover state. Don't paint a page or section in `bg-ninetone-red`/`navy`/`green`.
2. **Section identity comes from the kicker + accent rule + CTA color**, not from the canvas. Drive coloring through `sectionAccent[theme]` from [src/lib/sections.ts](src/lib/sections.ts) — never hardcode `bg-ninetone-red`/etc. when a `theme` prop is available.
3. **Kicker = mono uppercase 11px tracked 0.12em with leading hairline.** Use the `.kicker` class. It's the most-repeated UI primitive.
4. **Square corners.** No `rounded-md` on cards/tiles/buttons. Tailwind v4 base radius is 0 — keep it that way unless the element is a badge or input.
5. **Card hover signature:** `h-1 w-12 bg-{accent}` mark in the top-left grows to `w-full` on `group-hover` over 300ms. Same on every image-led card.
6. **Hover-text-color discipline.** When text changes color on hover *over an animated background*, snap the bg color first (150ms) and delay the text transition (`delay-100 group-hover:delay-100`). Otherwise mid-transition produces white-on-near-white. See the homepage portal pattern in [src/pages/index.astro](src/pages/index.astro) — copy from there.
7. **Sentence case for headlines.** All-caps is for kickers/badges only.
8. **Italic display for taglines** under headlines (`font-display italic` with `text-ninetone-ink/75`). Keeps voice without raising volume.
9. **Three-archetype rule:** every page is one of (a) Editorial section page (kicker + h1 + lede + accent rule), (b) Detail page (sticky split, image col-span-5 / content col-span-7), (c) Landing/portal. See DESIGN.md §3.
10. **No new fonts** without updating both [Base.astro](src/layouts/Base.astro) `<link>` AND `--font-*` tokens in [global.css](src/styles/global.css). Current stack: Newsreader (display) + Space Grotesk (sans) + Space Mono (mono). All Google Fonts, all OFL.
11. **Paper-canvas is the brand — no dark mode pre-launch.** Don't propose a site-wide dark toggle; the editorial paper identity is load-bearing. Post-launch, the only defensible surface for `prefers-color-scheme` is the news article reading pages, not the brand surface.
12. **Hide empty list sections, don't render empty-state copy.** When a category/list has zero items, filter it out of the render entirely (see `populatedCategories` pattern in [src/pages/ninetone-nation/booking.astro](src/pages/ninetone-nation/booking.astro)). FM data stays untouched so sections reappear automatically when populated. Exception: explicit user-action results (search, filter) — those *should* show an empty state.

**Reusable primitives — check before building anew:** `BentoTile`, `ArtistCard`, `NewsCard`, `MerchCard`, `RosterStrip`, `MetricsPanel`, `EditorialNewsBlock`, `MarqueeBand`, `StreamingRow`, `ContactForm`, `SectionIntro`, `SplitPortalHero`. Full inventory in DESIGN.md §2.

**FM data conventions** (Phase 2/3 surface area): see DESIGN.md §5. New data helpers go in [src/lib/ninetone.ts](src/lib/ninetone.ts) — `getPromo`, `getFeaturedArtists/Clients/Booking`, etc.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke context-save
- Code quality, health check → invoke health
