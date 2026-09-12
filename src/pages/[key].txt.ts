import type { APIRoute } from "astro";
import { indexNowKey } from "../lib/indexnow.ts";

/**
 * IndexNow key-file verification endpoint — dormant until launch.
 *
 * IndexNow verifies host ownership by fetching `keyLocation`
 * (`${origin}/${key}.txt`, per src/lib/indexnow.ts) and checking the body
 * equals the key exactly. This is a catch-all single-segment route
 * (`/[key].txt`) at the site root, so it must respond ONLY when the
 * requested `key` param matches the configured `INDEXNOW_KEY` — for every
 * other `/whatever.txt` it 404s and lets the request fall through.
 *
 * Route-priority note (why this can't shadow robots.txt/llms.txt): Astro
 * ranks routes by specificity, not file order — static/literal routes
 * (`robots.txt.ts`, `llms.txt.ts`) always win over a dynamic single-param
 * route (`[key].txt.ts`) for the exact same path. `/robots.txt` and
 * `/llms.txt` are matched by their own literal route files before this one
 * is ever considered, on both build targets. There is no other rest-param
 * (`[...x]`) catch-all at the site root that this could collide with either
 * (confirmed by listing every route file under src/pages — the only other
 * dynamic routes live under sub-paths like /news/[slug], not at the root).
 * This route only ever "wins" for a path with no matching static/other
 * dynamic route, i.e. exactly the `${key}.txt` shape IndexNow requests.
 *
 * When INDEXNOW_KEY is unset (always true on staging/preview today), every
 * request here 404s — nothing is exposed, and nothing can be guessed to a
 * valid key since there is none configured.
 */
/**
 * Dynamic routes must enumerate their paths on the static (gh) target. With no
 * INDEXNOW_KEY configured — the state everywhere today — this returns an empty
 * list, so the static build emits no key file at all. That is the correct
 * dormant behaviour: the key file should exist only where the key does. On the
 * cf target this is ignored and the GET handler runs per request.
 */
export function getStaticPaths() {
  const key = indexNowKey();
  return key ? [{ params: { key } }] : [];
}

export const GET: APIRoute = async ({ params }) => {
  const configuredKey = indexNowKey();
  const requestedKey = params.key;

  if (!configuredKey || !requestedKey || requestedKey !== configuredKey) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(configuredKey, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
