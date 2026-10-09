import type { KvLike } from "./cache.ts";

/**
 * Editor-set wordings ("locks") — the runtime twin of src/i18n/overrides.json.
 *
 * An override in the JSON file needs a deploy. A lock is set from /admin and
 * lives in KV, so an editor can pin "this Swedish line reads like THIS in
 * English" and see it on the site a minute later. Same key as the file: the
 * sha256 of the exact source text, plus the language the wording is for.
 *
 * ONE KV VALUE HOLDS EVERY LOCK, on purpose. Translations are read per route,
 * not per string (see CLAUDE.md); a per-string lock key would put a KV round
 * trip back on every string of every render. Instead the whole map is small
 * (a lock is a deliberate, hand-made thing — dozens, not thousands) and is
 * held in memory.
 *
 * translate() NEVER READS KV FOR A LOCK. It only peeks at the map already in
 * memory (`peekLock`). Loading is the caller's job: the middleware primes it
 * once per render, beside the bundle read it already makes (`primeLocks`, a
 * no-op while the isolate's copy is under a minute old), and the admin API
 * reads it fresh. That keeps translate()'s read count exactly what
 * test/translate-bundle.test.mjs pins.
 *
 * KNOWN LIMIT — ONE MAP, READ THEN WRITTEN. A save reads the map and writes
 * it back. KV has no compare-and-swap and no uncached read, so two saves at
 * the same moment, or within about a minute from different Cloudflare
 * locations, can each write a map that lacks the other's lock; both editors
 * are told it saved. One editor at a time is safe. The fix is one KV key per
 * lock with the map rebuilt from a prefix list, so a stale read can only
 * delay a lock, never erase one. Listed under 0.3.2.0 in CHANGELOG.md.
 *
 * Nothing in-flight is ever shared between requests. Only the settled map is
 * kept at module level; a request that finds it stale does its own read with
 * its own timer. A promise parked here would be orphaned when the request
 * that created it ends, and the next render would wait on it forever (the
 * hang fixed in v0.2.5.4/5).
 */
export const LOCKS_KEY = "tr-locks:v1";

type LockLang = "sv" | "en";
export type TranslationLock = { text: string; source: string; at: string };
export type LockMap = Record<string, TranslationLock>;

const FRESH_MS = 60_000;
/** After a read that failed or timed out, try again this soon instead of going a full minute without locks. */
const RETRY_MS = 5_000;
const READ_TIMEOUT_MS = 1_500;
const settled = new WeakMap<object, { locks: LockMap; at: number; version?: string }>();

export const lockId = (target: LockLang, hash: string) => `${target}:${hash}`;

/** The stored value as a lock map; `null` when it is there but is not one. Nothing stored is an empty map. */
function parse(raw: string | null): LockMap | null {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as LockMap) : null;
  } catch {
    return null;
  }
}

/**
 * One physical read. `ok` is true only when KV answered in time with a value
 * that is a lock map (or with nothing). Rendering does not care — it takes
 * `locks` either way — but a WRITE must: saving on top of a read that failed
 * would store this isolate's guess and erase every lock it did not know about.
 */
async function load(kv: KvLike, version?: string): Promise<{ locks: LockMap; ok: boolean }> {
  // A slow or failed read keeps the last known map rather than blocking or
  // dropping every lock for a minute.
  let locks = settled.get(kv as object)?.locks ?? {};
  let ok = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      kv.get(LOCKS_KEY, { cacheTtl: 60 }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), READ_TIMEOUT_MS);
      }),
    ]);
    if (raw !== undefined) {
      const stored = parse(raw);
      ok = stored !== null;
      locks = stored ?? {};
    }
  } catch {
    // keep `locks`
  } finally {
    if (timer) clearTimeout(timer);
  }
  settled.set(kv as object, { locks, at: ok ? Date.now() : Date.now() - FRESH_MS + RETRY_MS, version });
  return { locks, ok };
}

/**
 * The lock map. `fresh` skips this isolate's copy — for the admin pages. It
 * cannot skip KV's own cache: KV has no uncached read, and a value written
 * at another Cloudflare location can take up to a minute to show here.
 *
 * `version` is the site's cache version (the Publish epoch). A copy read
 * under an older version is re-read at once: an editor who locks a line and
 * then refreshes the site must not have pages re-rendered, and cached for
 * their full TTL, from a lock map that predates the lock.
 */
export async function readLocks(kv: KvLike, opts?: { fresh?: boolean; version?: string }): Promise<LockMap> {
  const known = settled.get(kv as object);
  const sameVersion = opts?.version === undefined || known?.version === opts.version;
  if (!opts?.fresh && known && sameVersion && Date.now() - known.at < FRESH_MS) return known.locks;
  return (await load(kv, opts?.version ?? known?.version)).locks;
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
 * Set a lock, or remove it with `null`. Returns the map as written.
 *
 * Throws, and writes nothing, when the stored map could not be read first.
 */
export async function writeLock(kv: KvLike, target: LockLang, hash: string, lock: TranslationLock | null): Promise<LockMap> {
  const known = settled.get(kv as object);
  const current = await load(kv, known?.version);
  if (!current.ok) throw new Error("lock map unreadable; refusing to overwrite it");
  const locks = { ...current.locks };
  if (lock) locks[lockId(target, hash)] = lock;
  else delete locks[lockId(target, hash)];
  await kv.put(LOCKS_KEY, JSON.stringify(locks));
  settled.set(kv as object, { locks, at: Date.now(), version: known?.version });
  return locks;
}
