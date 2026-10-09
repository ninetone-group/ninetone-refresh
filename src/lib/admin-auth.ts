import { timingSafeEqual } from "node:crypto";
import type { KvLike } from "./cache.ts";

/**
 * Sessions for /admin. The password (PUBLISH_PASSWORD) is typed once; the
 * login answers with a token good for eight hours, and every other admin
 * call carries the token instead.
 *
 * Why not send the password each time, the way /api/publish does: the admin
 * pages make many calls, and the password check sits behind a 10-per-minute
 * rate limit that exists to slow guessing. An editor locking a dozen lines
 * must not be throttled, so the calls after login have to be checkable
 * without that limit — which is only safe if a token cannot be made by
 * guessing.
 *
 * THE SIGNING KEY IS NOT THE PASSWORD. The first version signed tokens with
 * the password itself, and the pre-landing review showed what that means:
 * anyone can compute the token a guessed password would produce and send it
 * to an unthrottled action, so the token check becomes an unlimited
 * password-guessing oracle (and a leaked token an offline one). Tokens are
 * signed with 32 random bytes the Worker generates on the first login and
 * keeps in KV. Nobody outside can compute a signature, right guess or not.
 *
 * A token is `<expiry>.<HMAC over the expiry and a hash of the password>`.
 * Stateless, so there is nothing per session to store or clean up; the
 * password hash in the signed message means changing the password ends
 * every open session, and deleting the KV key does the same.
 */
export const SESSION_KEY = "admin-session-key:v1";
const SESSION_MS = 8 * 60 * 60 * 1000;
const enc = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Constant-time comparison of two strings of any length (both are hashed first). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return timingSafeEqual(new Uint8Array(ha), new Uint8Array(hb));
}

/** The signing key. Created only at login (`create`); a token check never mints one. */
async function signingKey(kv: KvLike, create: boolean): Promise<string | null> {
  const stored = await kv.get(SESSION_KEY);
  if (stored) return stored;
  if (!create) return null;
  const fresh = hex(crypto.getRandomValues(new Uint8Array(32)));
  await kv.put(SESSION_KEY, fresh);
  return fresh;
}

async function sign(key: string, expires: number, password: string): Promise<string> {
  const passwordHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(password)));
  const hmacKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", hmacKey, enc.encode(`ninetone-admin:${expires}:${passwordHash}`)));
}

/** Call only after the password has been checked. */
export async function issueAdminToken(kv: KvLike, password: string, now = Date.now()): Promise<{ token: string; expires: number }> {
  const key = (await signingKey(kv, true)) as string;
  const expires = now + SESSION_MS;
  return { token: `${expires}.${await sign(key, expires, password)}`, expires };
}

export async function verifyAdminToken(token: unknown, kv: KvLike, password: string, now = Date.now()): Promise<boolean> {
  if (typeof token !== "string") return false;
  const [stamp, signature, ...rest] = token.split(".");
  const expires = Number(stamp);
  if (rest.length || !signature || !Number.isSafeInteger(expires)) return false;
  if (expires <= now || expires > now + SESSION_MS) return false;
  const key = await signingKey(kv, false);
  if (!key) return false;
  return safeEqual(signature, await sign(key, expires, password));
}
