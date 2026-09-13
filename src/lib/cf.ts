/**
 * Guarded access to the Cloudflare Workers runtime module.
 *
 * `cloudflare:workers` exposes `env` (bindings: KV, vars, secrets) natively
 * inside workerd — including `astro dev` under the adapter's Vite plugin —
 * and simply doesn't exist under Node (static GH build / plain dev). The
 * dynamic import is @vite-ignore'd so neither bundler mode tries to resolve
 * it; at runtime it either loads or rejects, and we memoize the outcome.
 */

export type CacheStateKv = {
  get(key: string, opts?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};

export type ContactSubmissionsKv = {
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};

export type EmailAddress = { email: string; name?: string };

export type EmailSendResult = { messageId?: string };

export type SendEmailBinding = {
  send(message: {
    to: string | string[];
    from: EmailAddress;
    replyTo?: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<EmailSendResult>;
};

export type RateLimiter = {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
};

export type CfEnv = Record<string, unknown> & {
  CACHE_STATE?: CacheStateKv;
  /** Self-referential service binding (wrangler.jsonc `services`) — the
   *  middleware's stale-while-revalidate asks the Worker to re-render a page
   *  through it. Absent → stale hits render synchronously instead. */
  SELF?: { fetch(input: Request): Promise<Response> };
  PUBLISH_PASSWORD?: string;
  PUBLISH_RATE_LIMITER?: RateLimiter;
  CONTACT_SUBMISSIONS?: ContactSubmissionsKv;
  CONTACT_RATE_LIMITER?: RateLimiter;
  CONTACT_EMAIL?: SendEmailBinding;
};

let cfEnvPromise: Promise<CfEnv | null> | null = null;

export function getCfEnv(): Promise<CfEnv | null> {
  if (!cfEnvPromise) {
    cfEnvPromise = import(/* @vite-ignore */ "cloudflare:workers").then(
      (m: { env?: CfEnv }) => m.env ?? null,
      () => null,
    );
  }
  return cfEnvPromise;
}
