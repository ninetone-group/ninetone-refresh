# Ninetone — Design System

**One sentence:** Editorial-magazine confidence with restraint — paper canvas, oversized serif headlines, mono labels, brand colors as accents (never backdrops), surgical motion, and the artist-as-hero on every screen.

**Inspired by:** Arturia.com (structural confidence, bento grids, restraint), Pangram Pangram editorial typography, Whalar/Viral Nation methodology cards, Ford/IMG Models editorial-magazine layouts.

---

## 1. Tokens — Tailwind v4 `@theme`

All tokens live in [src/styles/global.css](src/styles/global.css) under `@theme {}` and surface as `bg-ninetone-*` / `text-ninetone-*` / `font-*` Tailwind utilities.

### Color

| Role | Token | Hex | Usage |
|---|---|---|---|
| **Page canvas** | `bg-ninetone-paper` | `#f5f3ee` | Default body background. Editorial warm off-white. |
| Warm canvas | `bg-ninetone-paper-warm` | `#ece8de` | Section bands that need to step forward (merch, news block). |
| Hairlines | `border-ninetone-rule` | `#d9d4c5` | All borders, dividers, section rules. |
| **Ink (deep dark)** | `bg-ninetone-ink` | `#0a1420` | Footer, MetricsPanel, MarqueeBand, Promo bar, dark CTAs. Body text color. |
| Ink soft | `bg-ninetone-ink-soft` | `#1a2230` | Hover state for ink CTAs. |
| **Records accent** | `text-ninetone-red` | `#91000c` | Records division accent. Kicker labels, accent rules, primary CTAs. |
| Records dark | `bg-ninetone-red-dark` | `#6b0009` | Hover state. |
| **Management accent** | `text-ninetone-navy` | `#13486f` | Management division accent. |
| Management dark | `bg-ninetone-navy-dark` | `#0d3450` | Hover. |
| **Nation accent** | `text-ninetone-green` | `#1a936f` | Nation division accent for non-text UI (bg fills, border rules) — text uses the dark variant below (`#1a936f` on paper is 3.48:1, fails AA). |
| Nation dark | `text-ninetone-green-dark` / `bg-ninetone-green-dark` | `#126b51` | All Nation text-scale uses (kickers, links) and the Nation CTA fill — 5.83:1 on paper, AA-compliant. |
| Nation deep | `bg-ninetone-green-deep` | `#0e5540` | Hover state for the Nation CTA (dark → deep, mirroring red → red-dark). |

**Color rule:** Brand colors are **accents, not backdrops.** A division identity is signalled with one accent — usually the kicker label color, the section underline rule, and the CTA button. The page canvas stays paper. The full-color brand backgrounds are reserved for: Footer, PromoBar, MetricsPanel, MarqueeBand, and the *hover state* of the homepage portal cards.

Section accent palette is centralized in [src/lib/sections.ts](src/lib/sections.ts) → `sectionAccent`. Always import from there; never hardcode `bg-ninetone-red` etc. in a component when a `theme` prop is available.

### Typography

| Role | Family | Weights | Loaded as | When to use |
|---|---|---|---|---|
| **Display** (`font-display`) | **Newsreader** (OFL, self-hosted) | variable, wght 400–600 roman / 400–500 italic, opsz 6–72 | `@font-face` in [global.css](src/styles/global.css), files in `public/fonts/`; roman + italic preloaded in [Base.astro](src/layouts/Base.astro) | All h1–h5, italic display taglines, drop-cap ledes. Substitute for paid PP Hatton — soft humanist serif with optical sizing. |
| **Sans** (`font-sans`) | **Space Grotesk** (OFL, self-hosted) | variable, wght 300–700 | same, no preload (not the LCP element) | Body, paragraph, UI labels, nav, CTAs. Substitute for paid PP Supply Sans — engineered geometric grotesque. |
| **Mono** (`font-mono`) | **Space Mono** (OFL, self-hosted) | 400, 700 (static instances; no italic — unused in this codebase) | same, no preload | Kickers, h6, metadata (dates, categories), form labels, small uppercase captions. Substitute for paid PP Supply Mono. |

**Type scale** (in [global.css](src/styles/global.css) `@layer base`):

```css
h1 { font-size: clamp(2.75rem, 7vw, 6.5rem); letter-spacing: -0.035em; }
h2 { font-size: clamp(2rem, 4.5vw, 4rem); letter-spacing: -0.03em; }
h3 { font-size: clamp(1.5rem, 2.4vw, 2rem); letter-spacing: -0.02em; }
h4 { font-size: 1.375rem; letter-spacing: -0.015em; }
h5 { font-size: 1.0625rem; }
h6 { font-mono, 0.75rem, uppercase, tracking 0.08em; } /* mono kicker */
```

All headings: `font-weight: 500` (medium), `line-height: 1.05`, `text-wrap: balance`, `font-variation-settings: "opsz" 72`.

For **page heroes**, override h1 inline with a more aggressive scale: `clamp(2.75rem, 8vw, 7rem)` for detail pages, `clamp(3rem, 9vw, 8rem)` for the homepage hero.

**Italic display** is reserved for one-line taglines under headlines — e.g. detail page sub-titles, contact-page taglines. `font-display + italic + tracking-tight + text-ninetone-ink/75`.

### Editorial utilities (custom CSS classes)

- `.kicker` — small mono uppercase label with a leading hairline. The single most-repeated UI primitive. Always paired with an accent color (`text-ninetone-red`, `text-ninetone-navy`, etc.) or `text-ninetone-ink/55` when neutral.
- `.lede` — applies a Newsreader drop-cap to the first letter of the next paragraph. Used on news article body and detail-page bios.
- `.rule-top` / `.rule-bottom` — `border-color: ninetone-rule` shorthand.
- `.display-italic` — Newsreader italic with proper opsz axis applied.
- `.prose` — typography for FM-rendered markdown bios. Already styled to match the editorial system (italic blockquotes in display serif, accent-red links, etc.).

### Spacing & layout

- **Container:** `mx-auto max-w-7xl px-6` for major sections.
- **Section padding:** `py-20` standard, `py-24` for hero/closing bands. Detail-page tops: `pt-12 md:pt-16`.
- **Grid gaps:** Card grids → `gap-x-6 gap-y-12`. Editorial sections → `gap-10 md:gap-16`.
- **Card grids:** `grid-cols-2 gap-x-6 gap-y-12 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5` is the canonical roster grid (5 cols at xl).
- **Detail page split:** `grid gap-10 md:grid-cols-12 md:gap-16` with `md:col-span-5` (sticky image) + `md:col-span-7` (scrolling content).

### Border radius

Almost universally **square** (`rounded-none` is the default — Tailwind v4 base resets to 0). Where a slight curve appears it's intentional: badges, search inputs, etc. **Do not** add rounded corners to cards, tiles, or buttons. The square aesthetic is a deliberate Arturia/Pangram move.

### Motion

- **Default duration:** 200–300ms.
- **Slow reveal:** 700ms ease-out (image scale on card hover, image opacity on portal reveal).
- **Snap transitions:** 150ms (color overlay flips on portal hover — must precede text color change to avoid contrast bugs).
- **Hover-text-color discipline:** When text changes color on hover and sits over an animated background, **delay the text transition** (`delay-100`) and snap the bg color first. Otherwise mid-transition you get white-on-near-white. See [src/pages/index.astro](src/pages/index.astro) portal pattern.
- `prefers-reduced-motion: reduce` disables marquee animations.
- **Card hover signature:** the `h-1 w-12 bg-accent` mark in the top-left grows to `w-full` on `group-hover` over 300ms. Used on every image-led card (artist, news, merch, team). Do not break this convention.

---

## 2. Components — what to use when

All components live in [src/components/](src/components/) and accept a `theme?: SectionTheme` prop where division coloring matters.

### Chrome
| Component | When |
|---|---|
| [Base.astro](src/layouts/Base.astro) | Wraps every page. Loads fonts, mounts PromoBar + Header + Footer + CommandPalette. |
| [Header.astro](src/components/Header.astro) | Sticky scroll-shrink. Persistent search button + theme CTA + language switch. |
| [Footer.astro](src/components/Footer.astro) | Demo/talent pitch + newsletter capture + 4-column links + ink band. |
| [PromoBar.astro](src/components/PromoBar.astro) | Top dismissible bar. Renders nothing if no `Promo` WebPosts category exists. |
| [CommandPalette.astro](src/components/CommandPalette.astro) | ⌘K overlay, fuzzy search across artists/news/team via Fuse.js. |

### Section heads / heroes
| Component | When |
|---|---|
| [SectionIntro.astro](src/components/SectionIntro.astro) | Editorial section head: kicker + huge h1 + italic tagline + lede column + accent rule. Used on roster pages. |
| [SplitPortalHero.astro](src/components/SplitPortalHero.astro) | Two-portal landing for division indexes (records/, management/, ninetone-nation/). Same hover pattern as homepage portals. |

### Content tiles
| Component | When |
|---|---|
| [ArtistCard.astro](src/components/ArtistCard.astro) | Standard image-led card on roster pages. Surfaces tags + streaming badges from FM `url_*` fields. |
| [NewsCard.astro](src/components/NewsCard.astro) | News tile. Three sizes: `sm` / `md` / `lg`. Use `lg` for lead stories, `sm` for archive grid. |
| [MerchCard.astro](src/components/MerchCard.astro) | Shopify product tile. |
| [BentoTile.astro](src/components/BentoTile.astro) | Asymmetric tile inside `<BentoGrid>`. Sizes: `feature` (2×2), `wide` (2×1), `tall` (1×2), `default` (1×1). Variants: `paper`, `warm`, `ink`, `accent`, `image`. |

### Layout primitives
| Component | When |
|---|---|
| [BentoGrid.astro](src/components/BentoGrid.astro) | Container for `<BentoTile>` children. 4-col on desktop, stacks on mobile. Used on the homepage. |
| [RosterStrip.astro](src/components/RosterStrip.astro) | Horizontal-scroll artist strip — a visual quote that the roster is bigger than the page. Used on homepage and at the bottom of every detail page. |
| [MetricsPanel.astro](src/components/MetricsPanel.astro) | Whalar-style numbers panel. Two variants: `ink` (dark band) and `paper`. |
| [EditorialNewsBlock.astro](src/components/EditorialNewsBlock.astro) | Lead story (col-span-7) + sidebar list (col-span-5). |
| [LatestNewsSection.astro](src/components/LatestNewsSection.astro) | Simple 2-up news block. Used on division index pages. |
| [WebPostsSection.astro](src/components/WebPostsSection.astro) | Renders a FM WebPosts category as a 12-column editorial about-section. |
| [MerchSection.astro](src/components/MerchSection.astro) | Shopify product grid with kicker + heading + blurb header pattern. |
| [MarqueeBand.astro](src/components/MarqueeBand.astro) | Looping artist-name band. Use **once or twice per page max** — surgical, not decorative. |
| [RosterFilters.astro](src/components/RosterFilters.astro) + [RosterIndex.astro](src/components/RosterIndex.astro) | Pair: filter chips + search + grid/index view switch on roster pages. |
| [StreamingRow.astro](src/components/StreamingRow.astro) | Listen + Follow link clusters. Drop on every artist/client/nation detail page. |
| [ContactForm.astro](src/components/ContactForm.astro) | Shared 2-column contact layout: editorial left, form right. Used by all three contact pages. |

### Utilities
| Component | When |
|---|---|
| [ArtistsTabs.astro](src/components/ArtistsTabs.astro) | Current vs Previous tabs on Records pages. |
| [Pagination.astro](src/components/Pagination.astro) | Square-edged pagination with hover-invert. |
| [SocialRow.astro](src/components/SocialRow.astro) | Legacy. Prefer `<StreamingRow>` for new work. |

---

## 3. Page archetypes

Three layouts cover almost every page.

### A. Editorial section page
**Where:** `/news`, `/team`, `/records/artists`, `/management/clients`, `/ninetone-nation/booking`, all contact pages.
**Pattern:** Top section with kicker + oversized h1 + italic tagline + lede column on the right + accent hairline below. Then content (grid, list, form).

### B. Detail page (sticky split)
**Where:** every `[slug]` page.
**Pattern:**
- Breadcrumb kicker top-left
- 12-column grid: image column (col-span-5, `md:sticky md:top-24`) + content column (col-span-7, scrolling)
- Right column order: kicker → oversized h1 → italic tagline → tag row → mobile streaming row → bio (`.prose .lede`) → YouTube grid → Spotify embed → A&R/Manager block → news strip
- Below: optional merch grid, then `<RosterStrip>` "More from {division}"

### C. Homepage / division landing
**Where:** `/`, `/records`, `/management`, `/ninetone-nation`.
**Pattern:** Typographic hero → portal split (homepage) or `<SplitPortalHero>` (division) → bento or content sections → marquee band → roster strip → metrics → news → about → merch.

---

## 4. Voice + copy

- **Sentence case** for headlines. Avoid all-caps display headlines. Use mono uppercase only for kickers, metadata, badges.
- **Cinematic short copy.** "We listen to everything." "Book your next moment." "A house for music, talent, and the people who move them." Avoid agency-speak ("we leverage…", "innovative solutions"). Avoid feature-list dumps.
- **One headline, one tagline, one paragraph.** That's the editorial unit. Don't stack three headings.
- **Italic display for taglines** under headlines. Conveys voice without raising volume.
- **Numbers earn their size.** Metrics panel uses display serif at 5xl–6xl. Don't decorate with icons.

---

## 5. Data conventions

The site is FileMaker-driven. Useful fields surfaced in the design system:

| FM field | Component / page using it |
|---|---|
| `Head Artist`, `SLUG`, `artistPicture_small`, `artistPicture_big` | All artist/client/booking cards + detail heroes |
| `artistPresentationShort` / `clientPresentationString` / `bookingPresentationString` | Card blurb (list) + detail bio fallback |
| `artistPresentationString` (full bio markdown) | Detail page lede |
| `Artist Presentation Title` / `clientPresentationTitle` / `bookingPresentationTitle` | Italic tagline on detail pages |
| `genre` / `tags` / `tagBooking` | Card chips + roster filter |
| `url_spotify`, `url_applemusic`, `url_amazon`, `url_youtube_music`, `url_youtube_link`, `url_instagram`, `url_tiktok_artist`, `url_facebook`, `url_twitter` | `<StreamingRow>` and `<ArtistCard socials={...}>` |
| `url_spotify_artist` (iframe HTML) | Spotify embed on detail page (regex-extract artist ID) |
| `yotubeHighlight_one` / `_two` | Watch grid on detail page |
| `internalAandR`, `Green_internalAandR::userEmail` | "Represented by" block on records detail |
| `internalMgmntManager`, `Green_internalMgmntManagers::userEmail` | "Represented by" on management detail |
| `collectionId` | Per-artist Shopify merch collection on detail page |
| `highLight_music` / `highLight_client` | Sort priority for `getFeaturedArtists()` / `getFeaturedClients()` |

### New FM helpers in [src/lib/ninetone.ts](src/lib/ninetone.ts):
- `getPromo()` — reads a WebPosts category named `Promo`. First block = `{ subject: label, message: line1, line2 = href }`. Returns `null` if not present (PromoBar then renders nothing).
- `getFeaturedArtists(limit)` / `getFeaturedClients(limit)` / `getFeaturedBooking(limit)` — top-N pickers respecting the `highLight_*` sort.

### To enable the promo bar
Create one FM `WebPosts` record with `category = "Promo"` and one portal block:
```
subject:  New release
message:  LINN — Title goes here
          https://open.spotify.com/...
```
The bar appears site-wide, dismissible per-user via `localStorage`.

---

## 6. Accessibility checklist (kept up to date)

- All interactive elements meet `min-h-11` (44px touch target).
- Color contrast: ink-on-paper > 14:1, accent-on-paper red 5.6:1, navy 7.2:1. Green text-scale uses `ninetone-green-dark` (5.83:1) — the base `ninetone-green` (#1a936f) measures **3.48:1 on paper, which fails AA for text** and is restricted to non-text UI (bg fills at ≥3:1, border rules). Corrected 2026-09-09; §1 previously stated 4.6:1 in error.
- Focus rings: rely on browser default ring + `focus:border-ninetone-ink` for inputs. Never `outline-none` without a replacement.
- Hover-only nav avoided — every nav target is also reachable via tab + Enter.
- `prefers-reduced-motion` honored on marquee.
- Reading order matches visual order on detail pages — image is `<aside>`, content is the main column.

---

## 7. What we explicitly avoid

- **Glassmorphism, gradients, neon, soft shadows.** None on the site.
- **All-caps display headlines.** Reserved for kickers/badges.
- **Centered hero text** with no asymmetry — every hero is at least 2-column.
- **Round-corner cards.** Square is a load-bearing brand decision.
- **Stock lifestyle b-roll** as backgrounds. Artist photography is the visual.
- **Three-icon "Our Services" rows.**
- **Mid-paragraph emphasis colors** — bold/italic only.
- **More than one marquee per page.** It loses meaning if it's everywhere.

---

## 8. When extending

1. New page → start with one of the three archetypes (Editorial section / Detail / Landing).
2. New component → check if `BentoTile`, `NewsCard`, or `ArtistCard` can be reused first. If you need a new primitive, follow the kicker-headline-blurb-CTA pattern with the `h-1 w-12 bg-accent` hover mark.
3. New section accent → add to `sectionAccent` in [sections.ts](src/lib/sections.ts), don't hardcode.
4. New data field → if it's per-artist, plumb through `<ArtistCard>` props or `<StreamingRow>` socials interface. If it's site-wide, consider whether a new `getX()` in [ninetone.ts](src/lib/ninetone.ts) belongs.
5. New copy → write it like a magazine cover, not a landing page. Sentence case headline + italic tagline + one paragraph.

---

## 9. References

- **Inspiration:** [Arturia.com](https://www.arturia.com), [Pangram Pangram type specimens](https://pangrampangram.com), [IMG Models](https://www.imgmodels.com), [Whalar](https://whalar.com), Awwwards SOTD music + sound winners 2025–2026.
- **Original paid fonts (referenced for character):** PP Hatton (display) + PP Supply / Supply Mono (sans + mono) by Pangram Pangram. Free substitutes used in production: Newsreader + Space Grotesk + Space Mono, all OFL-licensed and self-hosted from `public/fonts/` (no runtime request to Google Fonts).
- **Tailwind v4** with `@theme` tokens — all design tokens live in [src/styles/global.css](src/styles/global.css).
