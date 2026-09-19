/**
 * YouTube fetch helper — build-time only.
 *
 * Pulls two lists per channel:
 *   - Latest 5 uploads via the public RSS feed (no auth, no quota cost)
 *   - Top 5 most-viewed via the Data API search.list (sorted by viewCount,
 *     time-bounded by FM's expiry-style logic — i.e. across the whole
 *     channel; YouTube doesn't expose a "top N in last X days" without
 *     extra plumbing, so we just take the all-time top 5 and let the
 *     UI labelling speak for itself)
 *
 * Both lists return the same shape so the UI can swap freely between
 * them. Falls back gracefully when YOUTUBE_API_KEY is absent (returns
 * RSS-only results) and when channel resolution fails (returns empty).
 */

import { cached, kvCached } from "./cache";
import { getCfEnv } from "./cf";

// Lazy read with process.env fallback for the Cloudflare Worker runtime,
// where the key arrives as a binding instead of being baked at build.
// A secret: process.env only, never import.meta.env (src/lib/env.ts).
const apiKey = (): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.YOUTUBE_API_KEY;

export interface YouTubeVideo {
  id: string;
  title: string;
  publishedAt: string; // ISO 8601
  thumbnail: string;
  views?: number;
  url: string; // canonical https://www.youtube.com/watch?v=<id>
}

export interface YouTubeFeed {
  latest: YouTubeVideo[];
  topViewed: YouTubeVideo[];
}

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * Extract a YouTube channel ID from a stored URL. FM data is messy — most
 * entries are clean `youtube.com/channel/UC...` URLs, but a handful are
 * `/@handle` shapes, and one or two are malformed (path duplicated, etc.).
 *
 * Returns null for inputs we can't confidently resolve to a UC-prefixed ID
 * synchronously. Handle-based URLs are resolved separately by
 * `resolveChannelByHandle` (async, requires API key).
 */
export function extractChannelId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const url = String(raw).trim();
  if (!url) return null;

  // Direct channel URL: youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx
  // Use match (not exec) and accept the LAST occurrence so a duplicated path
  // like the malformed Ninetone entry resolves correctly if it has one.
  const channelMatch = url.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (channelMatch) return channelMatch[1];

  // Bare ID (rare but defensive)
  if (CHANNEL_ID_RE.test(url)) return url;

  // Handle / vanity URL — needs an API resolve step
  return null;
}

// Handle→channelId resolution barely ever changes — a handle is effectively
// permanent once claimed — so it's cached hard (30 days) in the shared KV
// to keep it off the 100-unit search.list quota on the live site.
const CHANNEL_RESOLVE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Resolve a YouTube handle (/@something) or vanity URL (/c/customname) to
 * a channel ID via the Data API. Returns null if no API key or no match.
 *
 * Cached in the shared `CACHE_STATE` KV (30-day TTL) when running with a
 * runtime (Cloudflare target) so repeated requests across isolates and
 * across days don't re-spend the 100-unit search.list quota; falls back to
 * the in-process cache (effectively "once per build") on the static target
 * or when KV is unavailable.
 */
async function logApiError(endpoint: string, res: Response): Promise<void> {
  let reason = "unknown";
  let message = "";
  try {
    const body = (await res.json()) as {
      error?: { errors?: Array<{ reason?: string }>; status?: string; message?: string };
    };
    reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "unknown";
    message = (body.error?.message ?? "").slice(0, 120);
  } catch {
    // body wasn't JSON — leave reason/message at defaults
  }
  console.warn(
    `[youtube] ${endpoint} HTTP ${res.status} reason=${reason} message=${message}`,
  );
}

async function resolveChannelByHandle(url: string): Promise<string | null> {
  const key = apiKey();
  if (!key) {
    console.warn("[youtube] no YOUTUBE_API_KEY at runtime");
    return null;
  }
  const handleMatch = url.match(/\/@([\w.-]+)/);
  const vanityMatch = url.match(/\/c\/([\w.-]+)/);
  const query = handleMatch?.[1] ?? vanityMatch?.[1];
  if (!query) return null;

  // Normalize so equivalent handle URLs (case, scheme, trailing slash) share
  // one cache entry.
  const normalized = query.toLowerCase();
  const cacheKey = `yt:channel:${normalized}`;

  const cfEnv = await getCfEnv();
  return kvCached<string | null>(cfEnv?.CACHE_STATE, cacheKey, CHANNEL_RESOLVE_TTL_SECONDS, async () => {
    const apiUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    apiUrl.searchParams.set("part", "snippet");
    apiUrl.searchParams.set("q", query);
    apiUrl.searchParams.set("type", "channel");
    apiUrl.searchParams.set("maxResults", "1");
    apiUrl.searchParams.set("key", key);
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) {
        await logApiError("search.list (channel resolve)", res);
        return null;
      }
      const json = (await res.json()) as { items?: Array<{ id: { channelId: string } }> };
      return json.items?.[0]?.id?.channelId ?? null;
    } catch (err) {
      console.warn("[youtube] search.list (channel resolve) threw:", (err as Error)?.message);
      return null;
    }
  });
}

/**
 * Top-level resolver: given an FM-stored URL, return a usable channel ID
 * synchronously when possible, else fall through to handle resolution.
 */
export async function resolveChannelId(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  const direct = extractChannelId(url);
  if (direct) return direct;
  return resolveChannelByHandle(url);
}

/**
 * Parse YouTube channel RSS into YouTubeVideo[]. RSS is the only thing we
 * can use without an API key, and it's quota-free. Returns at most 15
 * entries (YouTube's RSS limit).
 *
 * Hand-rolled parser — RSS is small, structured, predictable, and we'd
 * rather not pull in xml2js for one job.
 */
function parseRss(xml: string): YouTubeVideo[] {
  const entries: YouTubeVideo[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const id = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = block.match(/<title>([^<]+)<\/title>/)?.[1];
    const published = block.match(/<published>([^<]+)<\/published>/)?.[1];
    const thumbnail = block.match(/<media:thumbnail url="([^"]+)"/)?.[1];
    if (id && title && published) {
      entries.push({
        id,
        title: decodeXmlEntities(title),
        publishedAt: published,
        thumbnail: thumbnail ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${id}`,
      });
    }
  }
  return entries;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchLatest(channelId: string): Promise<YouTubeVideo[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml).slice(0, 5);
  } catch {
    return [];
  }
}

// 12 hours — the top-viewed ranking moves slowly; this is the guard against
// burning the daily 10,000-unit Data API quota on search.list (100 units/call).
const TOP_VIEWED_TTL_SECONDS = 12 * 60 * 60;

async function fetchTopViewed(channelId: string): Promise<YouTubeVideo[]> {
  const key = apiKey();
  if (!key) {
    console.warn("[youtube] no YOUTUBE_API_KEY at runtime");
    return [];
  }

  const cfEnv = await getCfEnv();
  return kvCached<YouTubeVideo[]>(
    cfEnv?.CACHE_STATE,
    `yt:top:${channelId}`,
    TOP_VIEWED_TTL_SECONDS,
    () => fetchTopViewedUncached(channelId, key),
  );
}

async function fetchTopViewedUncached(channelId: string, key: string): Promise<YouTubeVideo[]> {
  // Step 1: search.list ordered by viewCount gets us the 5 candidate IDs.
  // 100 quota units per call.
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("channelId", channelId);
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("order", "viewCount");
  searchUrl.searchParams.set("maxResults", "5");
  searchUrl.searchParams.set("key", key);

  let candidateIds: string[];
  try {
    const res = await fetch(searchUrl);
    if (!res.ok) {
      await logApiError("search.list (top viewed)", res);
      return [];
    }
    const json = (await res.json()) as {
      items?: Array<{ id: { videoId: string } }>;
    };
    candidateIds = (json.items ?? []).map((i) => i.id.videoId).filter(Boolean);
  } catch (err) {
    console.warn("[youtube] search.list (top viewed) threw:", (err as Error)?.message);
    return [];
  }
  if (candidateIds.length === 0) return [];

  // Step 2: videos.list to get actual viewCount + canonical title/thumbnail.
  // search results are slightly stale and don't include statistics.
  // 1 quota unit per call (much cheaper than search).
  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,statistics");
  videosUrl.searchParams.set("id", candidateIds.join(","));
  videosUrl.searchParams.set("key", key);

  try {
    const res = await fetch(videosUrl);
    if (!res.ok) {
      await logApiError("videos.list (top viewed)", res);
      return [];
    }
    const json = (await res.json()) as {
      items?: Array<{
        id: string;
        snippet: {
          title: string;
          publishedAt: string;
          thumbnails?: Record<string, { url: string }>;
        };
        statistics?: { viewCount?: string };
      }>;
    };
    return (json.items ?? [])
      .map((v) => ({
        id: v.id,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        thumbnail:
          v.snippet.thumbnails?.maxres?.url ??
          v.snippet.thumbnails?.standard?.url ??
          v.snippet.thumbnails?.high?.url ??
          `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        views: v.statistics?.viewCount ? Number(v.statistics.viewCount) : undefined,
        url: `https://www.youtube.com/watch?v=${v.id}`,
      }))
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  } catch (err) {
    console.warn("[youtube] videos.list (top viewed) threw:", (err as Error)?.message);
    return [];
  }
}

/**
 * Public entry point. Pass in a channel ID (use `resolveChannelId` if you
 * only have a URL). Returns both lists; either may be empty if the fetch
 * failed or API key is missing.
 */
export function getYouTubeFeed(channelId: string): Promise<YouTubeFeed> {
  return cached<YouTubeFeed>("yt-feed", channelId, async () => {
    const [latest, topViewed] = await Promise.all([
      fetchLatest(channelId),
      fetchTopViewed(channelId),
    ]);
    return { latest, topViewed };
  });
}
