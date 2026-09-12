/**
 * Canonical site origin — the single source of truth for every absolute URL
 * we emit (canonical links, OG URLs, sitemap `<loc>`, llms.txt, JSON-LD
 * `url`/`@id`). Never hardcode a domain anywhere else.
 *
 * Resolution order:
 *   1. `PUBLIC_SITE_ORIGIN` env var, if set — the escape hatch for launch day.
 *      When ninetone.com goes live, this is the only thing that changes.
 *   2. On the CF (server) target, the incoming request's own origin — lets
 *      staging (workers.dev) and any preview deploy self-report correctly
 *      without a config change.
 *   3. The static `site` baked into astro.config.mjs at build time (exposed
 *      by Astro as `import.meta.env.SITE`) — the fallback for the static GH
 *      Pages build, which has no request to inspect.
 *
 * Pure function: no I/O, easy to unit test. Always returns a bare origin
 * (scheme + host, no trailing slash, no path).
 */

/** Strip to a bare origin: scheme + host, no trailing slash, no path/query/hash. */
function toOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Read one env var the same way src/lib/filemaker.ts's `runtimeEnv` does:
 * prefer the value Vite baked into `import.meta.env` at build time, else fall
 * back to `process.env` so a value set as a live Worker binding
 * (nodejs_compat) is still picked up at request time on the CF target.
 *
 * Guarded against `import.meta.env` itself being absent: Vite always
 * provides it, but this module is also imported directly by plain-Node unit
 * tests (node:test, no Vite involved), where `import.meta.env` is undefined.
 */
function readEnv(name: string): string | undefined {
  const meta = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const baked = meta?.[name];
  if (typeof baked === "string" && baked) return baked;
  if (typeof baked === "boolean") return String(baked);
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

export function siteOrigin(request?: Request | { url: string | URL }): string {
  const envOrigin = readEnv("PUBLIC_SITE_ORIGIN");
  if (envOrigin) {
    const parsed = toOrigin(envOrigin);
    if (parsed) return parsed;
  }

  // Request origin only makes sense on the CF (server) target — the static
  // build has no incoming request at build time. PUBLIC_HAS_RUNTIME is the
  // existing project-wide flag for "are we on the server target" (see
  // astro.config.mjs / ContactForm.astro).
  const hasRuntime = readEnv("PUBLIC_HAS_RUNTIME") === "true";
  if (hasRuntime && request) {
    const raw = request instanceof Request ? request.url : String(request.url);
    const parsed = toOrigin(raw);
    if (parsed) return parsed;
  }

  // Static fallback: the `site` configured in astro.config.mjs, exposed by
  // Astro as import.meta.env.SITE.
  const staticSite = readEnv("SITE");
  if (staticSite) {
    const parsed = toOrigin(staticSite);
    if (parsed) return parsed;
  }

  return "";
}

/**
 * Whether `PUBLIC_SITE_ORIGIN` is set — i.e. whether `siteOrigin()` is
 * currently returning the production-shaped domain rather than a GH Pages /
 * request-derived one. Callers that need to know if the GH Pages sub-path
 * base still applies (it doesn't once we're production-shaped, since that
 * sub-path is a preview-only artifact with no meaning on the real domain)
 * use this instead of re-reading the env var themselves.
 */
export function isProductionShaped(): boolean {
  return Boolean(readEnv("PUBLIC_SITE_ORIGIN"));
}

/**
 * Normalize a site-relative path (starting with "/") to what should be
 * concatenated directly onto a bare origin from siteOrigin() — i.e. the
 * inverse problem `url()` solves, but aware that the GH Pages sub-path base
 * must NEVER appear once we're emitting a production-shaped origin.
 *
 * Pure and explicit about its inputs (no `import.meta.env`/`Astro` reads)
 * so it's unit-testable without a real Astro render — this is the exact
 * logic that leaked the "/ninetone-refresh" sub-path into
 * production-shaped canonical/OG URLs before it had any test coverage.
 *
 * @param path            Site-relative path, e.g. "/records/artists/anjo/"
 *                        or (on the static target) already-based
 *                        "/ninetone-refresh/records/artists/anjo/".
 * @param basePrefix      The configured base with no trailing slash, e.g.
 *                        "/ninetone-refresh" or "" (CF target).
 * @param productionShaped Whether siteOrigin() is currently returning the
 *                        production domain (PUBLIC_SITE_ORIGIN is set).
 * @param addBase         The project's url() helper — adds `basePrefix` to a
 *                        path. Injected rather than imported so this stays
 *                        a pure function of its arguments.
 */
export function resolveSitePath(
  path: string,
  basePrefix: string,
  productionShaped: boolean,
  addBase: (path: string) => string,
): string {
  const alreadyBased = basePrefix !== "" && path.startsWith(basePrefix);
  if (productionShaped) {
    // Production origin: the sub-path means nothing there. Strip it if
    // present; if it's already absent (e.g. CF target, base "/"), leave the
    // path alone. Either way, never add it back.
    if (!alreadyBased) return path;
    const rest = path.slice(basePrefix.length);
    return rest.startsWith("/") ? rest : `/${rest || ""}`;
  }
  // Still-preview origin: the sub-path is genuinely required to reach the
  // page. Add it via addBase() unless it's already there (Astro.url.pathname
  // already includes it on the static target — don't double it).
  return alreadyBased ? path : addBase(path);
}

/**
 * The origin JSON-LD builders (src/lib/schema.ts) should concatenate their
 * own site-relative paths onto — i.e. `siteOrigin()` with the GH Pages
 * preview sub-path folded in when we're still preview-shaped, so
 * `${jsonLdOrigin}/records/artists/anjo` resolves to a real, reachable URL
 * instead of 404ing under `/ninetone-refresh/`.
 *
 * schema.ts's builders take a bare `origin` per the brief and do plain
 * string concatenation with paths they're handed — they have no `Astro.url`
 * / `url()` to call resolveSitePath() themselves, and staying pure is the
 * point (unit-tested with plain objects, no Astro render). Folding the base
 * in here, once, at the same call site that already resolves `origin` via
 * `siteOrigin(Astro.request)`, keeps every JSON-LD URL correct on both
 * targets without teaching schema.ts about astro.config.mjs's `base`.
 *
 * On the CF target / once production-shaped, `basePrefix` is empty or
 * `productionShaped` is true, so this is a no-op passthrough of `origin`.
 */
export function jsonLdOrigin(origin: string, basePrefix: string, productionShaped: boolean): string {
  if (!origin) return origin;
  if (productionShaped || !basePrefix) return origin;
  return `${origin}${basePrefix}`;
}

/**
 * Convenience wrapper for pages: the exact recipe Base.astro itself uses to
 * get from `Astro.request` to a JSON-LD-safe origin, so every page building
 * its own breadcrumbs/entity JSON-LD (src/lib/schema.ts) can call one
 * function instead of re-deriving `siteOrigin()` + `isProductionShaped()` +
 * `import.meta.env.BASE_URL` at every call site. Reads `import.meta.env`
 * directly (same as siteOrigin()'s own readEnv()), so — like the rest of
 * this module — it works from both Astro frontmatter and plain node:test.
 */
export function pageJsonLdOrigin(request?: Request | { url: string | URL }): string {
  const basePrefix = String(
    (import.meta as unknown as { env?: Record<string, unknown> }).env?.BASE_URL ?? "/",
  ).replace(/\/$/, "");
  return jsonLdOrigin(siteOrigin(request), basePrefix, isProductionShaped());
}
