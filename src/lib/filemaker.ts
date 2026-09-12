/**
 * FileMaker Data API client.
 *
 * Token caching: FM tokens expire after ~15 min idle. We cache for 12 min to be safe.
 * Response caching: short-TTL in-memory via src/lib/cache.ts (with stale-on-error).
 * Runs at build time for the static GH Pages preview AND at request time on the
 * Cloudflare Worker (server output) — the token never reaches the browser in
 * either mode.
 */

// `.ts` extensions on purpose: plain Node (the test runner, with
// --experimental-strip-types) cannot resolve extension-less imports, and
// test/filemaker-kv.test.mjs imports this module directly.
import { cached, type KvLike } from "./cache.ts";
import { getCfEnv } from "./cf.ts";
import { mirrorRecordImages } from "./fm-image-mirror.ts";
import { fmFindViaKv } from "./fm-kv.ts";
import { timeServer } from "./server-timing.ts";

/**
 * Env resolution that works in all four contexts:
 *  - `astro dev` / static CI build: Vite bakes `import.meta.env.X` from .env / shell env
 *  - Cloudflare build (`build:cf`): FM vars are blanked at build so nothing is baked
 *  - Worker runtime: secrets arrive as bindings; nodejs_compat exposes them on process.env
 * Read lazily (inside functions, not module scope) so the Worker isolate sees
 * its bindings instead of whatever the build machine had.
 */
function runtimeEnv(baked: string | undefined, name: string): string | undefined {
  if (baked) return baked;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

const fmHost = () => runtimeEnv(import.meta.env.FM_HOST, "FM_HOST") ?? "files.ninetone.com";
const fmDb = () => runtimeEnv(import.meta.env.FM_DB, "FM_DB") ?? "Ninetone Group AB";
const fmUser = () => runtimeEnv(import.meta.env.FM_USER, "FM_USER");
const fmPass = () => runtimeEnv(import.meta.env.FM_PASS, "FM_PASS");

const TOKEN_TTL_MS = 12 * 60 * 1000;

let cachedToken: { value: string; expires: number } | null = null;
let tokenInFlight: Promise<string> | null = null;

function dbPath(): string {
  return `https://${fmHost()}/fmi/data/vLatest/databases/${encodeURIComponent(fmDb())}`;
}

/**
 * Get (or create) the shared FM session token. Concurrent callers share one
 * in-flight request — Astro renders pages in parallel and the Worker serves
 * concurrent visitors, so without dedup every cold call would open its own
 * FM session and leave it idling for 15 min.
 */
function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires) return Promise.resolve(cachedToken.value);
  if (!tokenInFlight) {
    tokenInFlight = createSession().finally(() => {
      tokenInFlight = null;
    });
  }
  return tokenInFlight;
}

async function createSession(): Promise<string> {
  const user = fmUser();
  const pass = fmPass();
  if (!user || !pass) {
    throw new Error("FM_USER / FM_PASS env vars not set");
  }

  const auth = btoa(`${user}:${pass}`);
  const res = await fetch(`${dbPath()}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(`FM session failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { response: { token: string } };
  cachedToken = { value: json.response.token, expires: Date.now() + TOKEN_TTL_MS };
  return cachedToken.value;
}

type FmFindResponse<T> = {
  response: {
    dataInfo?: { foundCount: number; returnedCount: number };
    data: { fieldData: T; portalData?: Record<string, unknown[]>; recordId: string }[];
  };
  messages: { code: string; message: string }[];
};

export type FmFindBody = {
  query: Record<string, string>[];
  sort?: { fieldName: string; sortOrder: "ascend" | "descend" }[];
  offset?: string;
  limit?: number;
  /** Portal tables to include. When set, FM returns ONLY these portals —
   *  pass `[]` on list fetches against portal-heavy layouts to slim the payload. */
  portal?: string[];
  /** Per-portal row caps, sent as `limit.<portalName>`. FM returns only as many
   *  portal rows as the LAYOUT's portal is configured to show unless this is
   *  set (API_WEBPOSTS shows 2!) — always set it when portal data matters. */
  portalLimits?: Record<string, number>;
};

// Cross-isolate KV read-through for finds — see src/lib/fm-kv.ts.
async function liveKv(): Promise<KvLike | null> {
  const env = await getCfEnv();
  return env?.CACHE_STATE ?? null;
}

export function fmFind<T = Record<string, unknown>>(
  layout: string,
  body: FmFindBody,
): Promise<T[]> {
  return timeServer("fmread", () =>
    cached(`fm-${layout}`, body, async () =>
      fmFindViaKv<T>(await liveKv(), layout, body, false, () => fmFindUncached<T>(layout, body)),
    ),
  );
}

export type FmRecord<T> = { fieldData: T; portalData?: Record<string, unknown[]> };

/**
 * Same as fmFind, but also returns each record's portalData. Used by
 * layouts whose related-table content matters (e.g. API_WEBPOSTS, where
 * the SEO blocks live in `webPost` portal rows).
 */
export function fmFindWithPortals<T = Record<string, unknown>>(
  layout: string,
  body: FmFindBody,
): Promise<FmRecord<T>[]> {
  return timeServer("fmread", () =>
    cached(`fm-portals-${layout}`, body, async () =>
      fmFindViaKv<FmRecord<T>>(await liveKv(), layout, body, true, () => fmFindUncachedWithPortals<T>(layout, body)),
    ),
  );
}

async function fmRequest<T>(
  layout: string,
  body: FmFindBody,
  isRetry = false,
): Promise<FmFindResponse<T> | null> {
  return timeServer("fmnet", () => fmRequestUntimed<T>(layout, body, isRetry));
}

async function fmRequestUntimed<T>(
  layout: string,
  body: FmFindBody,
  isRetry: boolean,
): Promise<FmFindResponse<T> | null> {
  const token = await getToken();

  // portalLimits is our ergonomic alias — FM wants flat `limit.<portal>` keys.
  const { portalLimits, ...rest } = body;
  const payload: Record<string, unknown> = { ...rest };
  if (portalLimits) {
    for (const [portalName, n] of Object.entries(portalLimits)) {
      payload[`limit.${portalName}`] = String(n);
    }
  }

  const res = await fetch(`${dbPath()}/layouts/${layout}/_find`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  // FM returns 401 if the token expired between cache check and request.
  // Drop the cache and retry once. The flag prevents infinite recursion if
  // creds are actually wrong (will surface the 401 on the second try).
  if (res.status === 401 && !isRetry) {
    cachedToken = null;
    return fmRequest<T>(layout, body, true);
  }

  // A proxy/maintenance page in front of FM answers with HTML — surface the
  // layout + status instead of a bare JSON SyntaxError.
  let json: FmFindResponse<T>;
  try {
    json = (await res.json()) as FmFindResponse<T>;
  } catch {
    throw new Error(`FM find ${layout} failed: HTTP ${res.status}, non-JSON response body`);
  }

  // FM returns 404 + message code 401 when query matches no records — that's not an error
  const noRecords = json.messages?.some((m) => m.code === "401");
  if (noRecords) return null;

  if (!res.ok) {
    const codes = (json.messages ?? []).map((message) => message.code).join(",") || "unknown";
    throw new Error(`FM find ${layout} failed: HTTP ${res.status}, code ${codes}`);
  }

  // Truncation tripwire: FM's default limit is 100 records. If a query matched
  // more than we got back, the site would silently build/render incomplete —
  // fail loudly instead. limit:1 lookups intentionally take the first match.
  const info = json.response.dataInfo;
  if (info && info.foundCount > info.returnedCount && body.limit !== 1) {
    throw new Error(
      `FM find ${layout} returned ${info.returnedCount} of ${info.foundCount} matching records — raise \`limit\` on this query`,
    );
  }

  return json;
}

async function fmFindUncached<T = Record<string, unknown>>(
  layout: string,
  body: FmFindBody,
): Promise<T[]> {
  const json = await fmRequest<T>(layout, body);
  if (!json) return [];
  // Attach FM's internal recordId (an ever-increasing serial) as __recordId.
  // The public layouts expose no creation-date field, so this is the only
  // creation-order signal — used e.g. for "latest addition" picks.
  const rows = json.response.data.map((r) => ({ ...r.fieldData, __recordId: r.recordId }));
  // FM streaming URLs expire with the session token; rewrite them to point at
  // the FM image proxy Worker, which holds a live token and resolves a fresh
  // URL on each request. See src/lib/fm-image-mirror.ts.
  await mirrorRecordImages(rows, { layout });
  return rows;
}

async function fmFindUncachedWithPortals<T = Record<string, unknown>>(
  layout: string,
  body: FmFindBody,
): Promise<FmRecord<T>[]> {
  const json = await fmRequest<T>(layout, body);
  if (!json) return [];
  const rows = json.response.data.map((r) => ({ fieldData: r.fieldData, portalData: r.portalData }));
  await mirrorRecordImages(rows, { layout });
  return rows;
}
