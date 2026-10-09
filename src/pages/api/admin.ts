import type { APIRoute } from "astro";
import { getCfEnv } from "../../lib/cf.ts";
import { handleAdmin } from "../../lib/admin-api.ts";
import { getNews, getWebPostSection } from "../../lib/ninetone";

/** POST /api/admin — everything behind /admin. See src/lib/admin-api.ts. */
export const POST: APIRoute = async ({ request }) =>
  handleAdmin(request, await getCfEnv(), {
    getNews: () => getNews(),
    getHomepageSection: () => getWebPostSection("Ninetone Group"),
  });
