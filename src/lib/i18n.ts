/**
 * Pure path/URL helpers for Phase 2 i18n (docs/i18n-phase-2-brief.md).
 *
 * Deliberately Astro-free: no `Astro.url`, no `import.meta.env`, no request
 * object. Everything here is a string-in/string-out function so it can be
 * unit-tested with plain node:test and so src/middleware.ts — which runs
 * through esbuild in test/middleware.test.mjs with astro:middleware stubbed
 * out — can import it without dragging any Astro runtime along.
 *
 * Decision 1 (docs/i18n-phase-2-brief.md): Swedish is the root locale.
 * "sv" therefore maps to the BARE path with no prefix; "en" is the only
 * locale that ever gets a `/en` segment. There is no `/sv` prefix — it is
 * not in the locales list as a path segment, only as a value of Lang.
 *
 * `trailingSlash: "never"` on the cf target (astro.config.mjs) means every
 * path this module produces or consumes is expected to carry no trailing
 * slash except the bare root "/". These helpers do not themselves 301
 * anything — src/middleware.ts's existing trailingSlashRedirectTarget()
 * owns that — but they normalize defensively (see stripLocale) so a
 * trailing slash on the input never produces a double slash or a wrong
 * split on the output.
 */

import type { Lang } from "./translate.ts";

/** The other of the two supported locales. Total function — Lang has exactly two values. */
export function otherLang(lang: Lang): Lang {
  return lang === "sv" ? "en" : "sv";
}

/**
 * Split a request path into its locale-free path and detected language.
 *
 * This is the detection primitive src/middleware.ts's rewrite is built on,
 * so its edge cases are the ones that matter most:
 *
 *   "/"            → { path: "/",        lang: "sv" }  root — Swedish, decision 1
 *   "/en"          → { path: "/",        lang: "en" }  bare "/en", no trailing slash
 *   "/en/"         → { path: "/",        lang: "en" }  same, defensively normalized
 *   "/en/records"  → { path: "/records", lang: "en" }
 *   "/records"     → { path: "/records", lang: "sv" }  no prefix — default locale
 *   "/enterprise"  → { path: "/enterprise", lang: "sv" }  NOT locale-prefixed —
 *                     see below, this is the case that breaks a naive
 *                     startsWith("/en") check.
 *   "/english-x"   → { path: "/english-x", lang: "sv" }  same reasoning.
 *
 * The `/en` segment must be matched as a whole path SEGMENT, not as a
 * string prefix. `path.startsWith("/en")` alone would also match
 * "/enterprise" and "/english-something", silently truncating them to
 * "terprise" / "glish-something" and mis-tagging them as English. The
 * fix is requiring the character after "en" to be "/" or the end of the
 * string — i.e. a real segment boundary — via the regex below rather than
 * a substring check.
 */
export function stripLocale(path: string): { path: string; lang: Lang } {
  const m = /^\/en(\/.*)?$/.exec(path);
  if (!m) return { path, lang: "sv" };
  const rest = m[1] ?? "";
  // "/en" and "/en/" both mean "root, in English". Anything else strips the
  // "/en" segment and keeps the rest as-is (rest already starts with "/").
  if (rest === "" || rest === "/") return { path: "/", lang: "en" };
  return { path: rest, lang: "en" };
}

/**
 * The URL for `path` (a locale-free, bare path starting with "/") in `lang`.
 *
 * sv is the default locale with no prefix (decision 1 — prefixDefaultLocale
 * is false), so `localizedPath("/records", "sv")` is just "/records". en
 * always gets a leading "/en" segment, with one exception: the root path
 * "/" in English is "/en", never "/en/" — trailingSlash:"never" on the cf
 * target means "/en/" is not a shape this site renders, and naively
 * concatenating would produce exactly that ("/en" + "/" = "/en/").
 *
 * `path` is expected to already be locale-free (i.e. the output of
 * stripLocale, or a route the caller knows is bare). Passing an
 * already-prefixed path back in would double-prefix it — callers that hold
 * a possibly-prefixed CURRENT path should use alternatePath() instead,
 * which strips first.
 */
export function localizedPath(path: string, lang: Lang): string {
  const bare = path === "" ? "/" : path;
  if (lang === "sv") return bare;
  if (bare === "/") return "/en";
  return `/en${bare}`;
}

/**
 * Given the CURRENT path — which may already carry a "/en" prefix — return
 * the URL of its alternate in `lang`. This is what the header language
 * switch calls: it doesn't know or care whether the current page is
 * already localized, it just wants "the other version of this page".
 *
 * Strips whatever locale is currently present (via stripLocale, so the
 * segment-boundary guard applies here too) and re-applies `lang`. This
 * makes the operation idempotent on the TARGET language regardless of the
 * source: alternatePath("/en/records", "en") === "/en/records", not a
 * double prefix.
 *
 * Round-trip stability (asserted in test/i18n.test.mjs): for any bare sv
 * path p, alternatePath(alternatePath(p, "en"), "sv") === p. Because
 * stripLocale + localizedPath are inverses of each other at each segment
 * boundary, this holds for "/", "/records", "/en" itself (as a literal
 * path someone lands on), and paths with multiple segments alike.
 */
export function alternatePath(currentPath: string, lang: Lang): string {
  const { path } = stripLocale(currentPath);
  return localizedPath(path, lang);
}

/**
 * The header language-switch href: given the CURRENT rendered path and the
 * CURRENT locale (from `locals.lang`, never re-derived from the path — see
 * below), return the URL of the other language's version of this page.
 *
 * WHY THIS TAKES `currentLang` AS A SEPARATE PARAMETER INSTEAD OF CALLING
 * `alternatePath(currentPath, otherLang(detectedLang))` where `detectedLang`
 * comes from sniffing `currentPath` itself (e.g. via `stripLocale`): on the
 * cf target, `src/middleware.ts` REWRITES the request before Astro renders
 * the page — `/en/records` becomes a render of the `/records` route, and
 * `next(renderTarget)` is called with the STRIPPED path. That means
 * `Astro.url.pathname` inside every page/component, Header.astro included,
 * is ALREADY locale-free by the time this code runs — there is no `/en`
 * segment left to find. `stripLocale("/records")` would return `{ path:
 * "/records", lang: "sv" }` regardless of whether the visitor is actually on
 * `/records` (Swedish) or `/en/records` (English, rewritten) — the pathname
 * alone cannot distinguish the two post-rewrite. The middleware does not
 * stash the original pre-rewrite path on `locals` (only `locals.lang`), so
 * `locals.lang` — set once, correctly, by the one piece of code that saw the
 * real request path before rewriting it — is the ONLY reliable signal for
 * "which language is this render in". Callers MUST pass that in as
 * `currentLang` rather than trying to recover it from `currentPath`.
 *
 * `currentPath` itself is still run through `alternatePath()` (which calls
 * `stripLocale` internally) rather than assumed bare, because this function
 * is also correct — harmlessly — for a caller that DOES still have a
 * possibly-`/en`-prefixed path (the gh/static target never rewrites
 * anything, so there `Astro.url.pathname` could in principle carry a
 * locale prefix if one ever existed there; decision 2 means it currently
 * never does, but this function doesn't need to assume that).
 */
export function switchHref(currentPath: string, currentLang: Lang): string {
  return alternatePath(currentPath, otherLang(currentLang));
}

/** One <link rel="alternate" hreflang> entry: absolute URL + the hreflang value it's tagged with. */
export interface HreflangLink {
  hreflang: "sv" | "en" | "x-default";
  href: string;
}

/**
 * The hreflang set for Base.astro: sv, en, and x-default (= Swedish, per
 * decision 1 — sv is the root/default locale, so x-default and sv point at
 * the identical URL).
 *
 * Takes `origin` as a plain string rather than resolving it internally so
 * this module stays Astro-free and reuses the ONE origin helper the repo
 * already has (siteOrigin() in src/lib/site.ts) instead of inventing a
 * second one — callers (Base.astro) are expected to pass
 * `siteOrigin(Astro.request)` straight through. `origin` is a bare
 * scheme+host with no trailing slash (siteOrigin()'s own contract), so
 * `${origin}${path}` is the correct concatenation with no separator logic
 * needed here.
 *
 * `currentPath` is treated the same way alternatePath() treats it — it may
 * already carry "/en" — since Base.astro's Astro.url.pathname is exactly
 * that shape.
 */
export function hreflangLinks(currentPath: string, origin: string): HreflangLink[] {
  const { path } = stripLocale(currentPath);
  const svHref = `${origin}${localizedPath(path, "sv")}`;

  // A Swedish-only page gets NO English alternate (SEO audit P1). Claiming
  // one pointed at a URL that returns Swedish HTML with a Swedish canonical —
  // an hreflang target must be canonical in its own language. A single-locale
  // page correctly advertises only itself plus x-default.
  if (!hasEnglishVersion(path)) {
    return [
      { hreflang: "sv", href: svHref },
      { hreflang: "x-default", href: svHref },
    ];
  }

  const enHref = `${origin}${localizedPath(path, "en")}`;
  return [
    { hreflang: "sv", href: svHref },
    { hreflang: "en", href: enHref },
    { hreflang: "x-default", href: svHref },
  ];
}

// ---------------------------------------------------------------------------
// Locale availability (SEO audit 2026-09-11, P1)
// ---------------------------------------------------------------------------

/**
 * Paths that exist ONLY in Swedish, as path prefixes.
 *
 * `integritet` is the privacy policy and `guider/*` are the guides: both pin
 * `lang="sv"` on <Base>, which wins over `locals.lang`, so `/en/integritet`
 * returns Swedish HTML with a Swedish canonical. Translating a privacy
 * policy's rights and retention language is a product decision nobody has
 * taken, so the content exception itself is deliberate — what was wrong was
 * advertising an English version of it anyway.
 *
 * Before this, the sitemap emitted an `/en/` <loc> for every Swedish-only
 * page and Base emitted an `hreflang="en"` alternate for it, so a
 * non-canonical URL sat in the sitemap claiming to be the English alternate
 * of a page that canonicalizes to Swedish. Google's localized-versions
 * guidance expects an hreflang target to be canonical in its own language;
 * this was neither.
 *
 * ONE rule, consumed by every surface that can disagree: the hreflang builder
 * (Base.astro), the sitemap's locale expansion (src/lib/sitemap.ts), and the
 * header language switch. Add a prefix here and all three stay consistent.
 */
const SWEDISH_ONLY_PREFIXES = ["/integritet", "/guider"] as const;

/**
 * Does this path have a genuine English version?
 *
 * Takes a locale-free path (the output of `stripLocale`), so a caller holding
 * a possibly-prefixed current path should strip first.
 */
export function hasEnglishVersion(path: string): boolean {
  const bare = stripLocale(path).path;
  return !SWEDISH_ONLY_PREFIXES.some(
    (prefix) => bare === prefix || bare.startsWith(`${prefix}/`),
  );
}
