import type { KvLike } from "./cache.ts";

/**
 * Editor-set wordings ("locks") — the runtime twin of src/i18n/overrides.json.
 *
 * An override in the JSON file needs a deploy. A lock is set from /admin and
 * lives in KV, so an editor can pin "this Swedish line reads like THIS in
 * English" and see it on the site a minute later. Same identity as the file:
 * the sha256 of the exact source text, plus the language the wording is for.
 *
 * ONE KV KEY PER LOCK (`tr-lock:v1:<lang>:<hash>`). The first version kept
 * every lock in a single value that each save read and wrote back. KV has no
 * compare-and-swap and no uncached read — a read can return a value from up
 * to a minute ago even in the location that just wrote it — so a save could
 * silently drop the lock saved before it, and an unlock could resurrect a
 * removed one, with both editors told it worked (Codex audit F01,
 * 2026-10-10). A save now writes exactly one key and reads nothing, so there
 * is no other lock for it to lose. A stale read can only DELAY a lock
 * appearing or disappearing; it can never erase one.
 *
 * translate() NEVER READS KV FOR A LOCK. Translations are read per route, not
 * per string (see CLAUDE.md), so it only peeks at the map already in memory
 * (`peekLock`). Loading is the caller's job: the middleware primes it once per
 * render, beside the bundle read it already makes (`primeLocks`, a no-op
 * while the isolate's copy is under a minute old), and the admin API reads
 * the keys it needs directly. That keeps translate()'s read count exactly
 * what test/translate-bundle.test.mjs pins. Priming is one prefix list plus
 * one bulk read; locks are deliberate, hand-made things — dozens, not
 * thousands.
 *
 * A LISTING CAN LAG A WRITE by up to a minute, even where the write was made;
 * only a read BY KEY is refreshed by the write. So the listing alone never
 * decides what is locked. A refresh reads, by key, the union of what is
 * listed, what this isolate already holds, and the ids in a small "recently
 * changed" note (`tr-lock-recent:v1`) that every save updates — and keeps
 * exactly the ones whose value is there. A lock saved a second ago is
 * therefore seen at once by every isolate in that location, and a removed
 * one is gone at once, whatever the listing says. The note is only a hint:
 * losing an entry from it costs speed (the listing catches up), never a lock.
 *
 * Nothing in-flight is ever shared between requests. Only the settled map is
 * kept at module level; a request that finds it stale does its own read with
 * its own timer. A promise parked here would be orphaned when the request
 * that created it ends, and the next render would wait on it forever (the
 * hang fixed in v0.2.5.4/5).
 */
export const LOCK_PREFIX = "tr-lock:v1:";
/** Ids changed lately, newest first. A hint for `load`; see the header. */
export const RECENT_KEY = "tr-lock-recent:v1";
const RECENT_MAX = 50;

type LockLang = "sv" | "en";
export type TranslationLock = { text: string; source: string; at: string };
/** Keyed `<lang>:<hash>` (see `lockId`). */
export type LockMap = Record<string, TranslationLock>;

/**
 * What the real binding offers beyond `KvLike`. Stand-ins used elsewhere in
 * the test suite often lack `list`; for those there are simply no locks.
 */
type LockKv = KvLike & {
  list?(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
  delete?(key: string): Promise<void>;
};

const FRESH_MS = 60_000;
/** After a read that failed or timed out, try again this soon instead of going a full minute without locks. */
const RETRY_MS = 5_000;
const READ_TIMEOUT_MS = 1_500;
const BULK_MAX = 100;
const settled = new WeakMap<object, { locks: LockMap; at: number; version?: string }>();

export const lockId = (target: LockLang, hash: string) => `${target}:${hash}`;
export const lockKey = (target: LockLang, hash: string) => `${LOCK_PREFIX}${lockId(target, hash)}`;

/** A stored value as a lock, or `null` when it is missing or is not one. One bad entry never affects the others. */
function parseLock(raw: unknown): TranslationLock | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TranslationLock> | null;
    return value && typeof value === "object" && typeof value.text === "string" && value.text
      ? { text: value.text, source: String(value.source ?? ""), at: String(value.at ?? "") }
      : null;
  } catch {
    return null;
  }
}

/** Values for `keys`, in order. One bulk read where the binding has it, individual reads otherwise. */
async function readMany(kv: LockKv, keys: string[], cacheTtl = 60): Promise<(string | null)[]> {
  // Each distinct key is read once, whatever the caller repeats.
  const unique = [...new Set(keys)];
  const values = new Map<string, string | null>();
  for (let i = 0; i < unique.length; i += BULK_MAX) {
    const chunk = unique.slice(i, i + BULK_MAX);
    let bulk: unknown = null;
    if (chunk.length > 1) {
      bulk = await (kv as unknown as { get(keys: string[], opts?: { cacheTtl?: number }): Promise<unknown> }).get(chunk, { cacheTtl });
    }
    if (bulk instanceof Map) {
      for (const key of chunk) values.set(key, (bulk.get(key) as string | null | undefined) ?? null);
    } else {
      const each = await Promise.all(chunk.map((key) => kv.get(key, { cacheTtl })));
      chunk.forEach((key, j) => values.set(key, each[j]));
    }
  }
  return keys.map((key) => values.get(key) ?? null);
}

/** The ids in the "recently changed" note. Anything unreadable is simply no hint. */
function parseRecent(raw: unknown): string[] {
  try {
    const value: unknown = typeof raw === "string" && raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

async function listed(kv: LockKv): Promise<string[]> {
  if (typeof kv.list !== "function") return [];
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: LOCK_PREFIX, cursor });
    for (const key of page.keys) ids.push(key.name.slice(LOCK_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return ids;
}

/** Every lock that is there right now: candidates from three places, each confirmed by key. */
async function readAll(kv: LockKv, known: LockMap): Promise<LockMap> {
  const [fromList, recent] = await Promise.all([listed(kv), kv.get(RECENT_KEY, { cacheTtl: 30 }).then(parseRecent)]);
  const ids = [...new Set([...fromList, ...recent, ...Object.keys(known)])];
  const values = await readMany(kv, ids.map((id) => `${LOCK_PREFIX}${id}`));
  const locks: LockMap = {};
  ids.forEach((id, i) => {
    // No value means it was removed (or never finished being saved): not a lock.
    const lock = parseLock(values[i]);
    if (lock) locks[id] = lock;
  });
  return locks;
}

/** One physical refresh of the isolate's map. A slow or failed read keeps the last known map. */
async function load(kv: LockKv, version?: string): Promise<LockMap> {
  let locks = settled.get(kv as object)?.locks ?? {};
  let ok = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fresh = await Promise.race([
      readAll(kv, locks),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), READ_TIMEOUT_MS);
      }),
    ]);
    if (fresh !== undefined) {
      locks = fresh;
      ok = true;
    } else {
      console.warn("[locks] reading the locked wordings timed out; keeping the last known set");
    }
  } catch (err) {
    // keep `locks`
    console.warn("[locks] reading the locked wordings failed; keeping the last known set:", err);
  } finally {
    if (timer) clearTimeout(timer);
  }
  settled.set(kv as object, { locks, at: ok ? Date.now() : Date.now() - FRESH_MS + RETRY_MS, version });
  return locks;
}

/**
 * Every lock, as this isolate knows them. `fresh` skips the isolate's copy.
 * It cannot skip KV's own delay: a lock written at another Cloudflare
 * location can take up to a minute to be listed here.
 *
 * `version` is the site's cache version (the Publish epoch). A copy read
 * under an older version is re-read at once: an editor who locks a line and
 * then refreshes the site must not have pages re-rendered, and cached for
 * their full TTL, from a map that predates the lock.
 */
export async function readLocks(kv: KvLike, opts?: { fresh?: boolean; version?: string }): Promise<LockMap> {
  const known = settled.get(kv as object);
  const sameVersion = opts?.version === undefined || known?.version === opts.version;
  if (!opts?.fresh && known && sameVersion && Date.now() - known.at < FRESH_MS) return known.locks;
  return load(kv, opts?.version ?? known?.version);
}

/** Make sure this isolate holds a recent lock map. Never throws; costs nothing while the copy is fresh. */
export async function primeLocks(kv: KvLike | null | undefined, version?: string): Promise<void> {
  if (kv) await readLocks(kv, { version });
}

/** The locked wording for a source hash, from memory only. Unprimed means no locks. */
export function peekLock(kv: KvLike | null, target: LockLang, hash: string): string | null {
  if (!kv) return null;
  return settled.get(kv as object)?.locks[lockId(target, hash)]?.text || null;
}

/**
 * The locks stored for exactly these ids, read by key — for the admin pages,
 * which must show what is saved rather than what this isolate last listed.
 * The isolate's own copy is brought in line for those ids as well, so what
 * translate() then reports for them is what was just read. Throws when KV
 * cannot be read; the caller decides what that means.
 */
export async function readLockEntries(kv: KvLike, ids: { target: LockLang; hash: string }[]): Promise<Map<string, TranslationLock>> {
  // 30 s is the shortest KV allows; this read backs the "someone else changed it" check.
  const values = await readMany(kv, ids.map((id) => lockKey(id.target, id.hash)), 30);
  const found = new Map<string, TranslationLock>();
  ids.forEach((id, i) => {
    const lock = parseLock(values[i]);
    if (lock) found.set(lockId(id.target, id.hash), lock);
  });
  const known = settled.get(kv as object);
  if (known) {
    const locks = { ...known.locks };
    for (const id of ids) {
      const key = lockId(id.target, id.hash);
      const lock = found.get(key);
      if (lock) locks[key] = lock;
      else delete locks[key];
    }
    settled.set(kv as object, { ...known, locks });
  }
  return found;
}

/**
 * Save one lock, or remove it with `null`. Writes one key and reads nothing,
 * so no other lock can be affected. Throws when the write fails — including
 * KV's limit of one write per second to the same key.
 */
export async function writeLock(kv: KvLike, target: LockLang, hash: string, lock: TranslationLock | null): Promise<void> {
  const store = kv as LockKv;
  if (lock) {
    await store.put(lockKey(target, hash), JSON.stringify(lock));
  } else {
    if (typeof store.delete !== "function") throw new Error("this KV binding cannot delete");
    await store.delete(lockKey(target, hash));
  }
  // Tell the other isolates here which id just changed (see the header). A
  // hint only: if this fails, or two saves cross, the listing still catches up.
  try {
    const id = lockId(target, hash);
    const recent = parseRecent(await store.get(RECENT_KEY, { cacheTtl: 30 }));
    await store.put(RECENT_KEY, JSON.stringify([id, ...recent.filter((other) => other !== id)].slice(0, RECENT_MAX)));
  } catch (err) {
    console.warn("[locks] could not update the recently-changed note:", err);
  }

  // Patch this isolate's copy so the editor's next render here already has
  // it. Only patch: an isolate that never loaded the map must not come to
  // believe this one lock is all there is.
  const known = settled.get(kv as object);
  if (!known) return;
  const locks = { ...known.locks };
  if (lock) locks[lockId(target, hash)] = lock;
  else delete locks[lockId(target, hash)];
  settled.set(kv as object, { ...known, locks });
}
