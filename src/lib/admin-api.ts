import { isCrossSite, json, readLimitedBody, sha256Hex } from "./http.ts";
import type { CfEnv } from "./cf.ts";
import type { KvLike } from "./cache.ts";
import { issueAdminToken, safeEqual, verifyAdminToken } from "./admin-auth.ts";
import { healthOf, homepageItem, newsItems, shownFor, type ContentItem, type ContentString } from "./admin-content.ts";
import { describeHomepageBlocks, parseHomepageCopy } from "./homepage-copy.ts";
import { renderBio } from "./markdown.ts";
import type { WebPostCategory } from "./ninetone.ts";
import { breaksMarkdownStructure, normalizeLineEndings, type Lang } from "./translate.ts";
import { lockId, readLocks, writeLock } from "./translation-locks.ts";

/**
 * The one endpoint behind /admin (POST /api/admin, JSON, `action` picks the
 * operation). One endpoint means one place that checks who is asking.
 *
 *   login                         password in, eight-hour token out
 *   blocks                        homepage FM blocks and the slots they fill
 *   items                         what can be reviewed (homepage + news)
 *   review   { item }             each string, what both sites show, lock state
 *   lock     { item, string, lang, text }
 *   unlock   { item, string, lang }
 *   health                        translation state of every listed string
 *   flush                         same cache flush as Publish, minus IndexNow
 *
 * A lock is the only action that changes what visitors read, so it is the
 * only one with rules: the source is looked up on the server from the item
 * and string ids (the client never supplies the text being overridden), and
 * the new wording must keep the original's paragraphs and links. For article
 * text that means the links the page would actually render — every href,
 * whatever its scheme — so a lock cannot add, drop or repoint a link.
 */
export type AdminDeps = {
  getNews(): Promise<readonly Record<string, unknown>[]>;
  getHomepageSection(): Promise<WebPostCategory | null>;
  now?: () => number;
};

const LANGS: Lang[] = ["sv", "en"];
const fail = (status: number, error: string) => json(status, { ok: false, error });

async function loadItems(deps: AdminDeps): Promise<ContentItem[]> {
  const [posts, section] = await Promise.all([deps.getNews(), deps.getHomepageSection()]);
  return [homepageItem(parseHomepageCopy(section)), ...newsItems(posts)];
}

const sourceHash = (string: ContentString) => sha256Hex(normalizeLineEndings(string.source));

/**
 * Every link and image the text would render as Markdown — http(s), mailto:,
 * tel:, site-relative alike, with href and src told apart so a link cannot
 * be swapped for an image of the same address.
 */
const renderedLinks = (markdown: string) =>
  [...renderBio(markdown).matchAll(/\s(href|src)="([^"]*)"/g)]
    .map((match) => `${match[1]}=${match[2]}`)
    .sort()
    .join("\n");

const SAVE_FAILED = "Could not save right now. Nothing was changed.";

export async function handleAdmin(request: Request, env: CfEnv | null, deps: AdminDeps): Promise<Response> {
  if (isCrossSite(request)) return fail(403, "Cross-site request rejected");

  const kv = env?.CACHE_STATE as KvLike | undefined;
  const secret = env?.PUBLISH_PASSWORD;
  const limiter = env?.PUBLISH_RATE_LIMITER;
  if (!kv || !secret || !limiter) return fail(503, "Admin is only available on the live (Cloudflare) deployment");

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readLimitedBody(request, 64_000));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "Invalid body");
    body = parsed as Record<string, unknown>;
  } catch (err) {
    return err instanceof RangeError ? fail(413, "Request too large") : fail(400, "Invalid body");
  }

  const action = String(body.action ?? "");
  const now = deps.now?.() ?? Date.now();

  if (action === "login") {
    // The only place the password is checked, so the only place guessing has
    // to be slowed. Fail closed if the limiter itself is unavailable.
    try {
      const key = await sha256Hex(request.headers.get("cf-connecting-ip") ?? "unknown");
      if (!(await limiter.limit({ key })).success) return fail(429, "Too many attempts");
    } catch {
      return fail(503, "Login protection is unavailable");
    }
    const password = String(body.password ?? "");
    if (!password || !(await safeEqual(password, secret))) return fail(401, "Wrong password");
    return json(200, { ok: true, ...(await issueAdminToken(kv, secret, now)) });
  }

  if (!(await verifyAdminToken(body.token, kv, secret, now))) return fail(401, "Not signed in");

  try {
    if (action === "flush") {
      await kv.put("cache-version", now.toString(36));
      return json(200, { ok: true });
    }

    if (action === "blocks") {
      const section = await deps.getHomepageSection();
      return json(200, { ok: true, found: section !== null, ...describeHomepageBlocks(section) });
    }

    const items = await loadItems(deps);

    if (action === "items") {
      return json(200, { ok: true, items: items.map(({ id, label, path }) => ({ id, label, path })) });
    }

    // Everything below reads translation state, so it needs the lock map as
    // it is right now, not this isolate's minute-old copy.
    const locks = await readLocks(kv, { fresh: true });

    if (action === "health") {
      return json(200, { ok: true, report: await healthOf(items, kv) });
    }

    const item = items.find((candidate) => candidate.id === body.item);
    if (!item) return fail(404, "No such item");

    if (action === "review") {
      const strings = await Promise.all(
        item.strings.map(async (string) => {
          const hash = await sourceHash(string);
          const [sv, en] = await Promise.all(
            LANGS.map(async (lang) => {
              const shown = await shownFor(string, lang, kv);
              return {
                ...shown,
                locked: lockId(lang, hash) in locks,
                // The source language needs no wording, and a line pinned in
                // overrides.json is decided in code.
                lockable: shown.origin === "cached" || shown.origin === "miss" || shown.origin === "locked",
              };
            }),
          );
          return { id: string.id, label: string.label, kind: string.kind, source: string.source, sv, en };
        }),
      );
      return json(200, { ok: true, item: { id: item.id, label: item.label, path: item.path }, strings });
    }

    if (action === "lock" || action === "unlock") {
      const string = item.strings.find((candidate) => candidate.id === body.string);
      const lang = LANGS.find((candidate) => candidate === body.lang);
      if (!string || !lang) return fail(404, "No such text");
      const hash = await sourceHash(string);

      if (action === "unlock") {
        try {
          await writeLock(kv, lang, hash, null);
        } catch {
          return fail(503, SAVE_FAILED);
        }
        return json(200, { ok: true });
      }

      const origin = (await shownFor(string, lang, kv)).origin;
      if (origin === "same-language") return fail(409, "This text is already written in that language");
      if (origin === "override") return fail(409, "This wording is pinned in the site's code");

      const text = normalizeLineEndings(String(body.text ?? "")).trim();
      if (!text) return fail(422, "The wording is empty");
      if (text.length > Math.max(400, string.source.length * 3)) return fail(422, "The wording is far longer than the original");
      // Checked for every kind, not only article text: a lock is keyed on
      // the source text alone, so a wording saved for a plain excerpt is
      // also served wherever the same text is rendered as Markdown.
      if (renderedLinks(string.source) !== renderedLinks(text) || breaksMarkdownStructure(string.source, text)) {
        return fail(422, "Keep the same paragraphs and the same links as the original");
      }
      try {
        await writeLock(kv, lang, hash, { text, source: string.source.slice(0, 120), at: new Date(now).toISOString() });
      } catch {
        return fail(503, SAVE_FAILED);
      }
      return json(200, { ok: true });
    }

    return fail(400, "Unknown action");
  } catch (err) {
    console.error("[admin] action failed:", action, err);
    return fail(502, "Could not read the content right now");
  }
}
