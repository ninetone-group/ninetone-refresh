#!/usr/bin/env node
/**
 * Copy every key/value of one KV namespace to another, across accounts.
 *
 *   node scripts/kv-copy-namespace.mjs <srcAccount> <srcNamespace> <dstAccount> <dstNamespace> [--dry-run]
 *
 * Uses CLOUDFLARE_API_TOKEN if set, else the wrangler OAuth token from
 * ~/.wrangler/config/default.toml — which must be authorised for BOTH
 * accounts (tick every account on the consent screen in `wrangler login`). Reads with the bulk-get API (100
 * keys per call), writes with the bulk-put API (chunks of 2,000). Values are
 * copied verbatim; expiration is carried over when present. Idempotent —
 * re-running overwrites with identical bytes.
 *
 * Written 2026-09-12 to move the ~12k-entry translation cache from the
 * gmail-account CACHE_STATE to Ninetone's account, which is far cheaper than
 * re-translating (~$10) and keeps the human-reviewed corpus intact.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const [src, srcNs, dst, dstNs, ...flags] = process.argv.slice(2);
if (!src || !srcNs || !dst || !dstNs) {
  console.error("usage: kv-copy-namespace.mjs <srcAccount> <srcNamespace> <dstAccount> <dstNamespace> [--dry-run]");
  process.exit(2);
}
const dryRun = flags.includes("--dry-run");

// CLOUDFLARE_API_TOKEN (an API token created in the dashboard with "Workers
// KV Storage: Read" on the source account and "…: Edit" on the destination)
// takes precedence over the wrangler OAuth token, for the case where the
// OAuth consent screen was not authorised for every account involved.
const token =
  process.env.CLOUDFLARE_API_TOKEN ||
  readFileSync(`${homedir()}/.wrangler/config/default.toml`, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) throw new Error("no token: set CLOUDFLARE_API_TOKEN or run `npx wrangler login`");
const API = "https://api.cloudflare.com/client/v4";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const json = await res.json();
  if (!json.success) throw new Error(`${path}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

// 1. List every key in the source (paginated).
const keys = [];
let cursor = "";
do {
  const q = new URLSearchParams({ limit: "1000", ...(cursor ? { cursor } : {}) });
  const res = await fetch(`${API}/accounts/${src}/storage/kv/namespaces/${srcNs}/keys?${q}`, { headers });
  const json = await res.json();
  if (!json.success) throw new Error(`list: ${JSON.stringify(json.errors)}`);
  keys.push(...json.result);
  cursor = json.result_info?.cursor ?? "";
} while (cursor);
console.log(`source keys: ${keys.length}`);
if (dryRun) process.exit(0);

// 2. Bulk-get values, 100 at a time, with modest concurrency.
const pairs = [];
const CHUNK = 100;
const chunks = [];
for (let i = 0; i < keys.length; i += CHUNK) chunks.push(keys.slice(i, i + CHUNK));
let done = 0;
async function worker() {
  while (chunks.length) {
    const chunk = chunks.shift();
    const result = await api(`/accounts/${src}/storage/kv/namespaces/${srcNs}/bulk/get`, {
      method: "POST",
      body: JSON.stringify({ keys: chunk.map((k) => k.name) }),
    });
    const values = result.values ?? result;
    for (const k of chunk) {
      const value = values[k.name];
      if (value === null || value === undefined) continue; // expired between list and get
      const pair = { key: k.name, value: typeof value === "string" ? value : JSON.stringify(value) };
      if (k.expiration) pair.expiration = k.expiration;
      pairs.push(pair);
    }
    done += chunk.length;
    if (done % 2000 < CHUNK) console.log(`  read ${done}/${keys.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`values read: ${pairs.length}`);

// 3. Bulk-put into the destination, 2,000 pairs per call (API max 10,000).
const PUT = 2000;
let written = 0;
for (let i = 0; i < pairs.length; i += PUT) {
  const batch = pairs.slice(i, i + PUT);
  await api(`/accounts/${dst}/storage/kv/namespaces/${dstNs}/bulk`, { method: "PUT", body: JSON.stringify(batch) });
  written += batch.length;
  console.log(`  wrote ${written}/${pairs.length}`);
}
console.log(`done: ${written} keys copied`);
