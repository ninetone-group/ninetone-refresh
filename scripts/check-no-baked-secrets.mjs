#!/usr/bin/env node
/**
 * Deploy gate (2026-09-19): fail if any local secret VALUE appears in dist/.
 *
 * The Cloudflare build must carry no credentials; they live as Worker secrets.
 * On 2026-09-19 the bundle was found to contain the FM password, the Shopify
 * admin token, the Anthropic key and the publish password, baked from the
 * deploying laptop's .env. Two causes: a secret missing from build:cf's blank
 * list, and `import.meta.env[name]` (a dynamic read makes Vite inline the whole
 * environment). This script is the backstop for both, and for the next one.
 *
 * Runs at the end of `npm run build:cf`, so `npm run deploy:cf` never reaches
 * `wrangler deploy` with a secret in the bundle. Values are never printed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ENV_FILES = [".env", ".env.local", ".env.production", ".dev.vars"];
// Anything whose NAME looks like a credential, plus the known ones.
const SECRET_NAME = /(PASS|PASSWORD|TOKEN|SECRET|API_KEY|_KEY)$|^(FM_USER)$/;
const MIN_LENGTH = 8; // shorter values would match ordinary text

const secrets = new Map();
for (const file of ENV_FILES) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (SECRET_NAME.test(m[1]) && !m[1].startsWith("PUBLIC_") && value.length >= MIN_LENGTH) secrets.set(m[1], value);
  }
}

const files = [];
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js|json|html|txt|map)$/.test(p)) files.push(p);
  }
})("dist");

if (!files.length) {
  console.error("[secrets-gate] dist/ is empty: nothing to check, refusing to pass.");
  process.exit(1);
}

const leaks = [];
for (const p of files) {
  const text = readFileSync(p, "utf8");
  for (const [name, value] of secrets) if (text.includes(value)) leaks.push(`${name} in ${p}`);
}

if (leaks.length) {
  console.error(`[secrets-gate] FAILED: ${leaks.length} secret value(s) baked into the build:`);
  for (const l of leaks) console.error(`  - ${l}`);
  console.error("Do NOT deploy. Read the key statically via src/lib/env.ts and add it to build:cf's blank list.");
  process.exit(1);
}
console.log(`[secrets-gate] ok: ${secrets.size} local secret(s) checked against ${files.length} files, none baked.`);
