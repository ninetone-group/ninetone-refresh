# Deploy guide — preview environment

**Live preview:** https://ninetone-group.github.io/ninetone-refresh/

Stack:
- **Build + host:** GitHub Actions builds; GitHub Pages serves the static `dist/`
- **Image proxy:** Cloudflare Worker (`worker-fm-proxy/`) holds a live FM session token and serves images on every request — the runtime layer the static site lacks. See "FM image proxy Worker" below.
- **Auth (planned):** Cloudflare Access in front of GH Pages, via DNS proxying
- **Auto-rebuild on FM content change:** FileMaker → GitHub `repository_dispatch` webhook → Actions rebuilds → Pages republishes

This doc covers the **preview** deployment. When the site is ready to replace `www.ninetone.com`, repoint DNS, drop the `base` path in `astro.config.mjs`, set `PUBLIC_NOINDEX=false`, and remove the noindex layers (see "Going public" at the bottom).

---

## Why GitHub Pages, not Cloudflare Pages

We initially deployed to Cloudflare Pages. Their build runners returned `500 {"messages":[{"code":"802","message":"Unable to open file"}]}` from the FileMaker session endpoint on every build, while the same call from this laptop, Postman, and GitHub Actions runners (with multiple User-Agents and simulated CF headers) all returned HTTP 200. We never identified what specifically about Cloudflare's build environment trips FM's response — likely a privilege rule or proxy filter — but we don't need to: GitHub Actions runners reach FM fine, so we build there.

The Cloudflare Pages project (if it still exists) can be deleted.

---

## How the build runs

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) does it all. Triggers:

- **Push to `main`** — every code change rebuilds.
- **`repository_dispatch` event `fm-content-changed`** — FM admin POSTs here when content changes (see "FileMaker auto-rebuild" below).
- **Manual trigger** — Actions tab → Run workflow.

Build steps:
1. Checkout
2. `actions/setup-node` Node 22.19.0 (cache: npm)
3. `npm ci`
4. `npm run build` with all `FM_*` and `SHOPIFY_*` env vars from repo secrets
5. `touch dist/.nojekyll` (so Pages doesn't strip `_astro/`)
6. Upload `dist/` artifact and deploy via `actions/deploy-pages@v4`

Concurrency is `group: pages, cancel-in-progress: false` — new runs cancel queued ones, but never abort a running deploy.

---

## Required repo secrets

Already set on `ninetone-group/ninetone-refresh`. To rotate:

```bash
gh secret set <NAME> --body "<value>" --repo ninetone-group/ninetone-refresh
```

Required:

| Secret | Source |
|---|---|
| `FM_HOST` | `files.ninetone.com` |
| `FM_DB` | `Ninetone Group AB` |
| `FM_USER` | from `.env` |
| `FM_PASS` | from `.env` |
| `SHOPIFY_SHOP_DOMAIN` | `fc6d3a-d9.myshopify.com` |
| `SHOPIFY_PUBLIC_STORE_URL` | `https://shop.ninetone.com` |
| `SHOPIFY_ADMIN_TOKEN` | from `.env` |
| `SHOPIFY_HOMEPAGE_COLLECTION_ID` | `514085060873` |
| `YOUTUBE_API_KEY` | optional — Google Cloud Console → YouTube Data API v3 |

`PUBLIC_NOINDEX=true` is hardcoded in the workflow until launch — flip it there, not in secrets.

`YOUTUBE_API_KEY` powers the per-Management-client YouTube section (latest 5 + top-viewed 5). Free tier (10k quota/day) is plenty: ~5,400 quota units per build for 54 active clients with channels. Without the key, the section degrades gracefully to RSS-only (Latest tab visible, Most viewed tab hidden). Restrict the key to "YouTube Data API v3" + HTTP referrer `*.github.io` is unnecessary since it's used server-side at build time only — leave referrer restrictions OFF, or it'll 403 in CI.

---

## FM image proxy Worker

**Why it exists.** FileMaker `Streaming_SSL/RCFileProcessor` URLs (artist photos, news covers, team headshots) **rotate on every API call AND expire when the session token does (~15 min).** Embedding them in static HTML means images break within minutes of deploy. Confirmed empirically: a URL captured at build T=0 returns 401 within hours, while DivHunt's production site shows the same image because their server re-fetches a fresh URL on every request.

GitHub Pages can't refresh tokens at request time. A tiny Cloudflare Worker can — it holds a live FM session token in isolate memory, refreshes when stale, resolves a fresh streaming URL per request, and streams the bytes through. **The Worker IS the runtime layer.** Static HTML embeds proxy URLs like `https://ninetone-fm-image-proxy.../artist/<slug>/big`; nothing FM-specific ever appears in the deployed HTML.

Lives in [`worker-fm-proxy/`](worker-fm-proxy/). Code reference: [`worker-fm-proxy/src/index.ts`](worker-fm-proxy/src/index.ts). Deploy instructions: [`worker-fm-proxy/README.md`](worker-fm-proxy/README.md).

### Routes

| Route | Source layout | Field |
|---|---|---|
| `/healthz` | — | sanity check (auths to FM, returns `{ok: true}`) |
| `/artist/:slug/big` | `API_ARTIST_DETAIL` | `artistPicture_big` |
| `/artist/:slug/small` | `API_ARTIST_DETAIL` | `artistPicture_small` |
| `/client/:slug/big` | `API_Management` | `artistPicture_big` |
| `/client/:slug/small` | `API_Management` | `artistPicture_small` |
| `/booking/:slug/big` | `API_Booking` | `artistPicture_big` |
| `/booking/:slug/small` | `API_Booking` | `artistPicture_small` |
| `/news/:slug/cover` | `API_NEWS` | `image_webp` |
| `/team/:slug/big` | `API_USERS` | `userPhoto` |
| `/team/:slug/small` | `API_USERS` | `userPhotoSmall` |

To add a new image-bearing layout, edit the `ROUTES` table in [`worker-fm-proxy/src/index.ts`](worker-fm-proxy/src/index.ts) AND the `LAYOUT_CONFIG` + `FIELD_TO_VARIANT` maps in [`src/lib/fm-image-mirror.ts`](src/lib/fm-image-mirror.ts), then redeploy both: `cd worker-fm-proxy && npx wrangler deploy` and push the site repo.

### Token + caching behavior

- Worker holds the FM session token in module-scope (per-isolate). Refreshes at 12 min (FM expires at 15, leaves 3-min buffer).
- One auth call per ~12 min per warm isolate. Roughly 5 auth calls per hour per region under continuous traffic, regardless of image volume.
- Image bytes are cached at the edge through the Cache API (`caches.default`, `x-fm-status: hit`) for 6 h (`s-maxage=21600`); browsers cache for 1 day. The cache key is the path plus only the `?v=<publish-epoch>` query the site appends, so a Publish is the buster and stray query strings cannot force FM reads. Before 2026-09-13 the header alone was set and nothing cached — every image request went to FileMaker (230–900 ms each).
- 401-on-find triggers a one-time token refresh + retry (handles the rare clock-drift case where our 12-min cache outlives FM's 15-min server-side expiry).

### Worker secrets

Set via `wrangler secret put`:

```bash
cd worker-fm-proxy
npx wrangler secret put FM_USER
npx wrangler secret put FM_PASS
```

Non-secret config (`FM_HOST`, `FM_DB`) is in `worker-fm-proxy/wrangler.toml` under `[vars]`. Cloudflare account that owns the Worker is whichever account ran `wrangler login`.

### Updating the Worker

```bash
cd worker-fm-proxy
nvm use 22
npx wrangler deploy
```

Adds new routes, fixes bugs, etc. Live within ~30s. The site repo doesn't need a redeploy unless the proxy URL or path scheme changes.

### Static-side rewriting

[`src/lib/fm-image-mirror.ts`](src/lib/fm-image-mirror.ts) walks every record returned by `fmFind` / `fmFindWithPortals`, finds fields with `https://files.ninetone.com/Streaming_SSL/...` URLs, and rewrites them to proxy URLs based on the layout name + record slug. So consumers (templates, search index) never see raw FM URLs — they're already swapped at build time. This is invoked transparently inside `src/lib/filemaker.ts`.

If you ever need to opt a layout *out* of proxying (rare), remove it from `LAYOUT_CONFIG` and the original FM URL passes through. Useful only for admin-internal layouts whose image fields don't surface publicly.

---

## FileMaker auto-rebuild

GitHub fires Actions workflows when you POST to its `dispatches` endpoint with the right event type. The FM admin needs to add **one script step** to the existing publish workflow.

### What to send the FM admin

> Could you add one script step to the publish/save workflow?
>
> Step: **Insert from URL**
> URL: `https://api.github.com/repos/ninetone-group/ninetone-refresh/dispatches`
> Method: POST
> Headers:
> ```
> Accept: application/vnd.github.v3+json
> Authorization: Bearer <PASTE THE TOKEN I'M ABOUT TO SEND>
> Content-Type: application/json
> ```
> Body:
> ```json
> {"event_type":"fm-content-changed"}
> ```
>
> Every time you publish, the website rebuilds itself within ~90s. Please don't share the token — it's scoped to one repo and one action only.

### Generating the token

GitHub fine-grained PAT scoped to **only** the `ninetone-refresh` repo with **Contents: Read** + **Metadata: Read** + **Actions: Write** permissions. Set expiry to 1 year, store it in the FM admin's password manager. To rotate: regenerate, send the new value, the FM admin updates the script step.

Generate at: https://github.com/settings/personal-access-tokens

(If you don't want to create a fine-grained PAT manually, the workflow currently allows manual triggers in the Actions tab, so any rebuild-from-FM cadence can be deferred until the FM admin is ready.)

---

## Auth: Cloudflare Access in front of GitHub Pages (TODO)

Deferred until needed. When ready, the path is:

1. **Set up Cloudflare DNS for the project** — point a subdomain like `preview.ninetone.com` at GitHub Pages via CNAME `ninetone-group.github.io`. Add the custom domain in the GH Pages settings. Drop the `base` from `astro.config.mjs` (now serving from `/`).
2. **Cloudflare → Zero Trust → Access → Applications → Add → Self-hosted.** Domain: `preview.ninetone.com`. Identity provider: One-time PIN (or Google). Policy: allowlist your email(s). Done.

Until this is in place, the site is publicly reachable but **noindexed at three layers**:
- `<meta name="robots" content="noindex,...">` in every HTML page
- `public/robots.txt` sitewide `Disallow: /`
- `X-Robots-Tag` header in `public/_headers` (note: GH Pages ignores `_headers` — only the meta and robots.txt apply right now)

So nothing gets indexed by Google, but anyone with the URL can view. Treat the URL as semi-private until Access is live.

---

## Verify noindex is working

```bash
URL="https://ninetone-group.github.io/ninetone-refresh/"

curl -s "$URL" | grep -i 'name="robots"'
# expect: <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">

curl -s "$URL/robots.txt"
# expect: User-agent: *  /  Disallow: /
```

---

## Going public (later)

Two questions to answer when you're ready:

1. **What domain?** — if `www.ninetone.com` (most likely), the DivHunt site has to come down or be rerouted first.
2. **What host?** — stay on GitHub Pages, or move to Cloudflare Pages / Workers Static Assets for better infra.

### Common cutover steps (regardless of host)

Same checklist for any production host:

1. **`astro.config.mjs`:** drop `base: "/ninetone-refresh"`; set `site: "https://www.ninetone.com"`.
2. **Workflow:** flip `PUBLIC_NOINDEX: 'false'` in `.github/workflows/deploy.yml`.
3. **`public/robots.txt`:** delete (or replace with a real one referencing the real sitemap).
4. **`public/_headers`:** delete the `X-Robots-Tag` block (or keep on a host that honors `_headers` — see below).
5. **Cloudflare Access:** delete the Application in Zero Trust (no more login wall).
6. **Repo visibility:** can flip private if you upgrade to GH Pro; required public if you stay on GH Pages free.
7. **DNS:** repoint `www.ninetone.com` from DivHunt to the new host (instructions below per option).
8. **Worker stays as-is** — the FM image proxy is host-independent; same URL keeps working.

### Option 1: Stay on GitHub Pages with a custom domain

GH Pages supports custom domains for free. The flow:

1. In the repo: **Settings → Pages → Custom domain** → enter `www.ninetone.com` → Save. Check "Enforce HTTPS" once DNS is verified (a few minutes after step 2).
2. At your DNS provider (currently wherever `ninetone.com` lives — Cloudflare, GoDaddy, etc.), set a **CNAME** record:
   ```
   www → ninetone-group.github.io
   ```
   For the apex (`ninetone.com` without the `www`), use **A records** pointing to GitHub's IPs (185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153) — GitHub publishes these.
3. Wait for DNS propagation (~minutes). GH Pages auto-provisions a Let's Encrypt cert.

**What you keep / lose vs alternatives:**
- ✅ Free (public repo) or $4/mo (private via Pro)
- ✅ Same workflow, same build, same Worker — zero changes beyond the cutover steps above
- ✅ HTTPS with auto-renewing cert
- ❌ `public/_headers` and `public/_redirects` still ignored (cache headers, custom redirects don't work natively)
- ❌ No native auth layer (OK because we removed Access at launch anyway)
- ❌ No per-PR preview deployments (you'd need a separate workflow + branch deploys)
- ❌ Slower edge: Fastly's POPs cover Sweden well but Cloudflare is generally faster globally

### Option 2: Switch to Cloudflare Pages (recommended for production)

We avoided CF Pages during the preview phase because their build runners get blocked by FileMaker — `500 + FM 802` on every build. **The fix is to keep building on GitHub Actions and use Cloudflare Pages "Direct Upload" mode**, which skips CF's build environment entirely. The Worker proxy is unaffected — it stays where it is.

Migration shape (~30 min):

1. **Create a Pages project** in Direct Upload mode (Cloudflare → Workers & Pages → Create → Pages → Upload assets).
2. **Update `.github/workflows/deploy.yml`** — replace the GH Pages deploy steps with:
   ```yaml
   - name: Deploy to Cloudflare Pages
     uses: cloudflare/wrangler-action@v3
     with:
       apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
       accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
       command: pages deploy dist --project-name=ninetone
   ```
3. **Add the two CF secrets** to the GH repo (`CLOUDFLARE_API_TOKEN` with Pages:Edit, `CLOUDFLARE_ACCOUNT_ID`).
4. **Custom domain** in Pages settings → add `www.ninetone.com`. CF auto-creates the CNAME if `ninetone.com` is on Cloudflare DNS.

**What you gain:**
- ✅ `public/_headers` works natively — cache control, X-Robots-Tag, security headers
- ✅ `public/_redirects` works (currently dead)
- ✅ Cloudflare's edge (better than Fastly globally)
- ✅ Per-PR preview deployments out of the box
- ✅ One-click rollback to a previous deploy
- ✅ Cloudflare Access available if you want to gate staging branches
- ✅ Faster cache invalidation after deploy
- ❌ Slightly more dashboard surface to manage
- ❌ Adds a CF API token to GH secrets

### Option 3: Switch to Cloudflare Workers Static Assets

Same idea as Option 2 but using Workers instead of Pages. Functionally similar for a static-only site. Workers Static Assets is Cloudflare's newer pattern — they may eventually consolidate Pages into it. For now, Pages is the more mature path with better dashboard UX. Pick this only if you want to add SSR/edge logic later in the same Worker.

### Recommendation

**For preview (now):** stay on GH Pages. Works, free, simple.

**For production:** superseded — see the next section. The live-data architecture
(docs/cms-architecture.md) landed as a second build target in this repo, which
replaces the static-hosting options above for production.

The Worker we built for FM images keeps working unchanged across all options — host-independent.

---

## Live site on Cloudflare Workers (implemented 2026-07-02)

The repo now has **two build targets** from one codebase (astro.config.mjs):

| | `npm run build` (gh) | `npm run build:cf` (cf) |
|---|---|---|
| Output | static, 540+ pages | `output: "server"`, rendered per request |
| Host | GH Pages under `/ninetone-refresh/` | Worker `ninetone-site` + Static Assets |
| Content | frozen at build | **live from FM**, tiered edge cache |
| Node | ≥22.19 (`package.json` engines floor) | ≥22.19; the adapter needs `module.registerHooks` |

How live data works (see src/middleware.ts + src/lib/cache.ts):
1. Edge cache per route with tiered TTLs — homepage 5 min, news 15 min, detail 1 h, rosters 6 h, team 24 h. Cache keys embed a **version epoch** from KV.
2. On miss, the page renders from FM through a 60s in-isolate data cache with in-flight dedup and stale-on-error (an FM hiccup serves last-known-good instead of a 500).
3. **Publish button** (`/admin/publish`, password = `PUBLISH_PASSWORD` secret) bumps the KV epoch → whole site is fresh within ~a minute. Editors never trigger deploys; deploys are for code only.
4. Edge caching is live on `*.workers.dev` too (verified: `x-cache: hit` in ~20ms). Cache keys embed the KV epoch (content invalidation via Publish) AND a per-build id — so every deploy automatically starts a fresh cache generation and old-code pages are never served after a release.
5. Cold renders read FM through a KV read-through (src/lib/fm-kv.ts, 300s, keyed by the same Publish epoch) and translations as one bundle per route (`trb:` keys), so a recycled isolate does not pay FM or per-string KV in full. `node scripts/perf-cold-probe.mjs` fetches staging routes with a cache-busting query and prints the `Server-Timing` split (`trbundle`, `trnkv`, `fmkv`, `fmnet`) — read-only, no purge, no writes, no model calls.

Local prod-like run: `npm run preview:cf` (wrangler dev on the built output; secrets from `.dev.vars`, gitignored).

**CI does not deploy the Worker.** `.github/workflows/deploy.yml` builds and publishes the
GH Pages preview only. The Worker ships from a developer machine, always as one command:
`npm run deploy:cf` (= `npm run build:cf && wrangler deploy`).

### Publication cron — paused

`wrangler.jsonc` declares a one-minute cron trigger for the translate-before-publish
discovery tick, but `vars.PUBLICATION_TICK` is set to `"off"`, which stops the tick
entirely. The subsystem is shadow-only (`PUBLICATION_SERVING` is absent), so nothing
visitor-facing depends on it and the polling bought nothing. `PUBLICATION_TICK` is a var,
not a secret, so it can be flipped in the Cloudflare dashboard without a redeploy. To
resume discovery, remove the line or set it to anything but `"off"`.

The subsystem still owns real bindings that a deploy provisions, paused or not: the
`PUBLICATION_COORDINATOR` Durable Object (`NinetonePublicationCoordinator`, sqlite
migration `v1`), the `ninetone-translation-jobs` queue plus its DLQ, and the
`PUBLICATION_STATE` / `PUBLICATION_RELEASES` KV namespaces. Deploying to a fresh account
means creating all of them — another reason `dist/` staleness matters, since the deploy
config wrangler actually reads is the generated one.

### Accounts + config redirect — read before deploying

Two gotchas discovered on first deploy (2026-07-02):

1. **`build:cf` writes `.wrangler/deploy/config.json` at the repo root.** Any
   `wrangler deploy` run anywhere under the repo — including inside
   `worker-fm-proxy/` — gets redirected to the SITE's built config. Deploy the
   image proxy with its config pinned: `npx wrangler deploy -c wrangler.toml`.
   (At the repo root the redirect is what you want: plain `npx wrangler deploy`
   deploys the site.)
2. **Three Cloudflare accounts on this login** (the stadsauktions account,
   micke.ohlen@gmail.com's account `0d392e5c…`, and Ninetone's own account
   `39f8beab…` where Mikael is Administrator). **Since 2026-09-12 everything
   Ninetone deploys to Ninetone's account**: `ninetone-site` at
   `ninetone-site.ninetone.workers.dev`, `ninetone-fm-image-proxy` at
   `ninetone-fm-image-proxy.ninetone.workers.dev`, five KV namespaces, the
   coordinator DO, the queue + DLQ. Both Worker configs pin `account_id` to
   it, so a deploy can never land elsewhere; wrangler's per-project cache in
   `node_modules/.cache/wrangler/wrangler-account.json` no longer matters.
   The original copies on the gmail account are retired and not deployed to.
   `wrangler login` must be authorised for Ninetone's account (the OAuth
   consent screen lets you pick accounts — pick all of them).

### Staging deploy (workers.dev)

```bash
npx wrangler login                     # as micke.ohlen@gmail.com (see above)
rm -f node_modules/.cache/wrangler/wrangler-account.json  # drop stale account pin

# 1. image proxy FIRST (new by-album cover route), config pinned:
cd worker-fm-proxy && npx wrangler deploy -c wrangler.toml && cd ..

# 2. KV namespaces must live on the same account — recreate if they were made
#    elsewhere, then update each id in wrangler.jsonc:
npx wrangler kv namespace create CACHE_STATE
npx wrangler kv namespace create SESSION
npx wrangler kv namespace create CONTACT_SUBMISSIONS
npx wrangler kv namespace create PUBLICATION_STATE
npx wrangler kv namespace create PUBLICATION_RELEASES

# 3. the site:
nvm use 22                             # ≥22.19; adapter needs module.registerHooks
npm run deploy:cf                      # build + deploy as ONE command
                                       # root redirect → dist/server/wrangler.json

# 4. one-time secrets (values from .env), pinned to the site worker:
npx wrangler secret put FM_USER --name ninetone-site
npx wrangler secret put FM_PASS --name ninetone-site
npx wrangler secret put SHOPIFY_ADMIN_TOKEN --name ninetone-site
npx wrangler secret put YOUTUBE_API_KEY --name ninetone-site
npx wrangler secret put PUBLISH_PASSWORD --name ninetone-site  # gates /admin/publish
```

**Order matters:** the site now addresses release covers as
`/release/<slug>/by-album/<album>` — the image proxy must be redeployed
**before** the next GH Pages push or site deploy, or discography covers 404.
The old positional `/release/<slug>/<n>` route is kept for HTML built earlier.

### At launch (ninetone.com)

1. Point DNS at Cloudflare, add the custom domain to the `ninetone-site` Worker.
2. Set `SITE_URL=https://www.ninetone.com` for `build:cf`, flip `PUBLIC_NOINDEX=false`.
3. Move the image proxy to a subdomain (edge-caches images) — or fold it into the site Worker.
4. Provision the dedicated read-only FM service account (docs/cms-architecture.md has the FM IT script).
5. GH Pages preview can be retired or kept as a design sandbox.
