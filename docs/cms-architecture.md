# CMS architecture — FileMaker as a live headless CMS

Forward-looking architecture for the production cutover (preview → ninetone.com on Cloudflare). Not in effect today. Today the site is static-built from FM at deploy time; the only runtime FM dependency is the image proxy. This doc captures the target state so when we cut over we don't relitigate the decisions.

For the **current** deploy and proxy architecture, see [DEPLOY.md](../DEPLOY.md) and [api-filemaker.md](api-filemaker.md). This doc is the *next* step.

---

## Goal

Make FileMaker a true live headless CMS. When Ninetone edits a record (artist, client, news, team, promo) the change appears on ninetone.com within minutes — automatically — without a developer running a build.

Non-goals: replacing FileMaker, building a parallel CMS, changing how Ninetone edits content, asking FM IT for new endpoints or schema changes.

---

## Why this is the right shape

Ninetone's FM is a sophisticated production platform doing real-time aggregation across social/streaming platforms. We are guests on it. The architecture is designed around three principles:

1. **FM stays the source of truth.** No mirror DB. No copy-pasted content. No second CMS to keep in sync.
2. **Be a respectful API consumer.** Heavy caching, single shared session, predictable load. FM never needs to scale for us.
3. **No FM-side changes required.** We use the standard Data API. No new endpoints, no new layouts (beyond what we already have), no new server config. Even the session timeout stays at FM's default 15 min.

---

## How it works at runtime

Site moves from `output: "static"` (rebuild to update) to `output: "server"` on Cloudflare Workers Static Assets. Each page render is dynamic, but heavily cached at the Cloudflare edge.

Three caches working together:

### 1. Cloudflare edge — full rendered HTML

Cloudflare caches the response of `GET /artist/chan-fuze` at every edge node for the page's TTL. Subsequent visitors anywhere in the world hit edge cache (~20ms) without touching our Worker, our FM session, or FM Server.

### 2. Worker — FM response cache

When the edge cache misses, the Worker runs. Before hitting FM, it checks an in-isolate cache keyed by query shape. FM API responses are cached at this layer too. Multiple URLs that need the same underlying FM record (e.g. roster list + individual artist page) share one FM call.

The in-isolate cache is per isolate, and workerd recycles isolates constantly, so as built this layer sits behind a second one: [src/lib/fm-kv.ts](../src/lib/fm-kv.ts) is a KV read-through for FM finds with a 300s TTL, keyed by the same Publish epoch as the edge cache. Any isolate can reuse a find another isolate performed in the last five minutes. A Publish bumps the epoch and forces a live read, so the freshness contract above is unchanged; 300s is the shortest page tier, so nothing is served staler than its own tier already allows. Translations get the same treatment one level up — one bundle per route (`trb:` keys) read in a single KV round trip instead of one read per string.

### 3. Image proxy — same as today

Already documented in [DEPLOY.md](../DEPLOY.md). Stays as-is; just moves to a custom subdomain at cutover so edge caching engages. See [project_deploy_architecture memory](#) and the existing [worker-fm-proxy/](../worker-fm-proxy/) code.

---

## TTL tiers — content-aware caching

Flat TTLs (one timeout for everything) are wrong for an editorial site. Different content changes at different rates. Tier them:

| Content | TTL | Reason |
|---|---|---|
| Team page + team detail | 24h | Changes a few times a year |
| Static pages (about, contact) | 24h | Same |
| Roster lists (artists, clients, booking) | 6h | Signings/drops happen but not constantly |
| Artist/client/booking detail | 1h | Bio edits happen, not time-critical |
| News index + articles | 15min | News needs to feel fresh |
| Homepage | 5min | Promo bar + featured rotate often |
| Images | 1 week | Once uploaded, rarely change |
| Anything urgent | Publish button (see below) | Manual override |

Rough math at peak (100 unique URLs, 4 views/hour each = 400 page views/hour):
- Flat 15-min TTL → ~400 FM hits/hour
- Tiered TTL → ~125 FM hits/hour
- **~70% FM load reduction** vs. flat caching, with strictly better freshness for the things that need it (homepage 5min beats flat 15min).

All TTLs are paired with `stale-while-revalidate`: when a cache entry expires, the next visitor still gets the stale version instantly (~20ms) while Cloudflare fetches fresh in the background. Cache misses are invisible to users.

---

## Token strategy — one shared session, 12-min refresh

The Worker holds **one** FM access token in isolate memory. Refreshes at 12 min (FM expires at 15). All visitor traffic uses that one token.

This is **Option A** from the architecture discussion. Alternatives (per-visitor session, per-request session) were considered and rejected:

| | One shared (chosen) | Per visitor | Per request |
|---|---|---|---|
| FM `/sessions` POSTs/day | ~120 | 1× daily visitors | Massive |
| Latency cost | None (token pre-warm) | 200–500ms first request/visitor | 200–500ms every request |
| FM session-table pressure | Minimal | Higher | Severe |
| Security | All three identical: token never leaves Worker isolate, credential in CF secret store | | |

Don't ask FM IT for an extended session timeout. Default 15 min is fine. Token refresh costs are already negligible (~5 POSTs/hour). Asking for non-default config burns goodwill without measurable benefit.

---

## Editor freshness — the Publish button

Tiered TTLs mean some edits take up to an hour to appear (artist detail). For editors who need instant publish:

A simple admin page (password-protected) with a **"Publish now"** button that calls the Cloudflare cache-purge API. Flushes all site caches. Next visitor anywhere in the world triggers a fresh FM read.

Mental model for editors: "edits appear within an hour automatically — hit Publish to make it instant."

This is sufficient. Don't over-engineer:
- **Don't** wire FM script triggers → webhook → selective cache invalidation in v1. It's elegant but it's coordination work with Ninetone IT and adds operational complexity. Defer until we measure actual editor frustration with the manual button.
- **Don't** add ETag/304 logic in v1. Same reasoning — nice to have, costs complexity, only matters if FM load becomes a problem (it won't at our scale).

Both are easy to add later if needed.

---

## What FM IT will need from us

When the cutover meeting happens:

**The ask:**
1. One dedicated read-only Data API user (`web_runtime` or similar). Stored encrypted in Cloudflare secret store; never appears in code or logs.
2. Confirmation that ~150 reads/hour at peak is fine (it will be).
3. Outbound network reachability from Cloudflare edge to FM Data API endpoint. No firewall changes on their side (Cloudflare initiates the connection).

**The pitch:**
> "Ninetone's FM is the source of truth. The site reads from it on every page request with aggressive tiered caching — your FM sees ~150 reads/hour at peak, regardless of visitor count. We use the standard Data API with one shared session, refreshed every 12 min. No new endpoints. No schema changes. No session-timeout exceptions. We're designing the site to be the gentlest possible consumer of your platform."

**Questions for them** (treat as collaboration, not just announcement):
1. Do you already have a service-account naming convention for external Data API users?
2. Any layouts you'd prefer we *not* hit, or fields that are expensive to materialize?
3. Maintenance windows or known degraded periods we should be aware of?
4. How would you prefer cache invalidation handled — manual button is fine, or do you want to wire a webhook from FM script triggers?
5. Appetite for a periodic audit feed (daily summary of our call count / cache hit rate)?

---

## What's NOT in scope for v1

- FM script triggers → webhook invalidation (defer)
- ETag/304 conditional fetches (defer)
- Per-visitor sessions (rejected — Option A is correct)
- Per-record TTL overrides (defer — tier-by-content-type is enough)
- Surfacing FM's social/streaming aggregation data on the site (Phase 2 — see below)

## Phase 2 — the data-rich site (future conversation)

Ninetone's FM aggregates real-time social/streaming data. Once the basic CMS architecture is live and trusted, there's a second conversation worth having about surfacing that data on the site:

- Live Spotify monthly listeners + 30-day trend on artist pages
- "Trending now" tiles driven by cross-platform momentum
- Real engagement metrics on management client pages
- News articles auto-decorated with relevant streaming stats
- Booking filters by recent engagement

This would make ninetone.com structurally different from a typical label brochure site — a living dashboard of who's actually moving. Don't raise this in the initial cutover meeting. Earn the trust first by being a model API citizen for several months, then have the richer conversation.

---

## Cutover checklist (when we get there)

1. Add Cloudflare Workers Static Assets to the Astro project (`@astrojs/cloudflare` adapter, output: "server").
2. Wire FM Data API client into runtime (currently it's build-time only — move it).
3. Implement tiered TTL middleware. One small route-to-TTL mapping table.
4. Pair every cached response with `Cache-Control: public, max-age=N, stale-while-revalidate=N`.
5. Move image-proxy Worker to `images.ninetone.com` (or path-route on `ninetone.com`).
6. Provision the dedicated FM service account.
7. Build the Publish admin page + button.
8. Test end-to-end: edit FM record → verify TTL behavior → click Publish → verify instant flush.
9. Drop `base` from astro.config; flip `PUBLIC_NOINDEX` off; point DNS at Cloudflare.

This is ~1 focused week of work. Mostly mechanical, no novel engineering. The hard part (the architecture) is decided in this doc.

---

## In one sentence

FM stays the CMS; the site becomes a fast live view of it via Cloudflare Workers + tiered edge caching; FM load drops vs. today; editors get a Publish button for instant control; no FM-side changes required.
