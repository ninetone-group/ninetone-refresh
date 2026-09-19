/**
 * Environment reads, in ONE place (2026-09-19).
 *
 * Two rules, both learned the hard way:
 *
 * 1. NEVER read `import.meta.env` by a dynamic name (`env[name]`). Vite cannot
 *    tell which key is wanted, so it inlines the WHOLE environment object into
 *    the bundle: every secret in `.env`, plus the build machine's shell
 *    variables. Always write the key out: `import.meta.env?.PUBLIC_SITE_ORIGIN`. The `?.`
 *    keeps the module loadable under plain Node (tests), where `import.meta.env`
 *    does not exist.
 *
 * 2. A SECRET is read from `process.env` and NOWHERE else. Never write
 *    `import.meta.env.<SECRET>`: Astro replaces that text with the literal value
 *    at build time, and on the Cloudflare target the adapter first copies
 *    `.dev.vars` into process.env, so blanking variables on the command line
 *    does not help. The baked value then sat in the Worker bundle and silently
 *    overrode the secret stored in Cloudflare (rotating it did nothing). On the
 *    Worker, secrets arrive as bindings and nodejs_compat exposes them on
 *    `process.env`; for `astro dev` and the static build, astro.config.mjs
 *    copies `.env` onto `process.env`.
 */

/** `process.env[name]`, guarded for runtimes where `process` is absent. */
export function procEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] || undefined;
}

/**
 * A secret or credential. Takes a NAME only, on purpose: there is no way to
 * hand it `import.meta.env.X`, so a secret can never be baked through here.
 */
export function secretEnv(name: string): string | undefined {
  return procEnv(name);
}

/** Public build-time configuration: the baked value wins (it is the build's
 *  own decision, e.g. PUBLIC_HAS_RUNTIME), the runtime value is the fallback. */
export function publicEnv(baked: unknown, name: string): string | undefined {
  if (typeof baked === "string" && baked) return baked;
  if (typeof baked === "boolean") return String(baked);
  return procEnv(name);
}
