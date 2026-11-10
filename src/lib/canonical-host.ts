/**
 * One hostname serves the site; the other 301s to it.
 *
 * WHY www. The old site lived on https://www.ninetone.com and 301'd the
 * naked domain there, so every URL Google holds (Search Console export,
 * 2026-10-06: 3,920 clicks on the www homepage vs 277 on the naked one) is
 * a www URL. Keeping www canonical makes the launch a same-host swap
 * rather than a host migration on top of a site migration. Both hostnames
 * are attached to the Worker as Custom Domains (wrangler.jsonc "routes");
 * this redirect is the only thing the naked host does.
 *
 * The canonical host itself is served over HTTPS only: a plain-HTTP request
 * for it gets the same 301. This covers every response the Worker renders.
 * Files the asset layer answers on its own (images, /_astro/*) never reach
 * the Worker and still load over http:// until "Always Use HTTPS" is switched
 * on in the Cloudflare dashboard.
 *
 * Gated on PUBLIC_CANONICAL_HOST (set by package.json "build:cf"): absent
 * in the static build, in dev and in the middleware test bundle, so none of
 * those see a redirect. The decision is a pure function; src/middleware.ts
 * wires it in ahead of every other redirect and the cache.
 */
export function canonicalHostRedirect(url: URL, canonicalHost: string | undefined): string | null {
  if (!canonicalHost) return null;
  const canonical = canonicalHost.toLowerCase();
  const host = url.hostname.toLowerCase();
  // Right host, plain HTTP: send it to HTTPS. Cloudflare's "Always Use HTTPS"
  // is off for the zone, so http://www.ninetone.com/ answered 200 with the
  // full page (found 2026-11-10; Wikipedia links the http:// address). The
  // naked host below already lands on https in the same hop.
  if (host === canonical) return url.protocol === "http:" ? `https://${canonical}${url.pathname}${url.search}` : null;
  // Only the naked twin of the canonical host redirects. Any other host the
  // Worker answers on (the *.workers.dev staging URL, previews) is left alone.
  const naked = canonical.replace(/^www\./, "");
  if (host !== naked) return null;
  return `https://${canonical}${url.pathname}${url.search}`;
}
