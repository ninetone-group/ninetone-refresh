/**
 * Site-wide noindex, decided once for the three places that enforce it:
 * Base.astro's <meta name="robots">, /robots.txt and the X-Robots-Tag
 * header src/middleware.ts puts on every SSR response.
 *
 * Launch (2026-10-08): the cf build ships with PUBLIC_NOINDEX=false (see
 * package.json "build:cf"), so there is no per-deploy flag to forget — but
 * the same Worker also answers on ninetone-site.ninetone.workers.dev, and
 * that host must never be indexed as a copy of the live site. Hence the
 * hostname rule: a *.workers.dev host is noindex regardless of the flag.
 * The gh preview keeps PUBLIC_NOINDEX=true from .env and is unaffected.
 *
 * `envValue` is passed in rather than read here so the rule is a pure
 * function the tests can cover; callers read `import.meta.env.PUBLIC_NOINDEX`
 * themselves (always written out in full — Astro replaces it at build time).
 */
export const STAGING_HOST_SUFFIX = ".workers.dev";

export function noindexFor(hostname: string | undefined, envValue: string | undefined): boolean {
  const envNoindex = String(envValue ?? "true") !== "false";
  const staging = Boolean(hostname && hostname.toLowerCase().endsWith(STAGING_HOST_SUFFIX));
  return envNoindex || staging;
}
