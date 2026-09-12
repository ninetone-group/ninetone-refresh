/**
 * Audit every English-target translation in KV for wrong-language values.
 *
 * WHY THIS EXISTS: two entries have been found holding Swedish text under an
 * `en` key — Patrik Frisk's team bio and Corroded's artist bio. In both cases
 * the model translated an already-English source INTO Swedish despite
 * target="en", which decision 4's "return unchanged if already in target"
 * rule should prevent. Re-tested against the same sources and prompt, it now
 * behaves correctly, so this was intermittent rather than a logic error —
 * which is exactly why it needs a sweep rather than a code fix: the bad
 * values are already written, permanently, into a no-TTL cache.
 *
 * Read-only. Prints the offending keys; deleting is a separate, explicit
 * step so this can be run safely at any time.
 *
 * Usage: node --env-file=.env scripts/audit-translation-language.mjs [--delete]
 */
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ACCOUNT = process.env.CF_ACCOUNT_ID ?? "0d392e5c79e386966a98a214ac91a133";
const NAMESPACE = process.env.CF_KV_NAMESPACE_ID ?? "9a5e09f3e19240c192104bb7de0f72a1";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
const CONCURRENCY = TOKEN_CONCURRENCY();
function TOKEN_CONCURRENCY() {
  // wrangler spawns a process per read, so keep that path gentle.
  return (process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN) ? 12 : 6;
}

/**
 * Swedish-vs-English scoring on function words only. Content words are
 * useless here: an English bio about a Swedish band is full of Swedish proper
 * nouns, and "Swedish" itself is an English word. Function words are what
 * actually differ between the two languages in running prose.
 */
const SV = /\b(och|är|från|med|som|för|att|den|det|vi|våra|sina|har|inte|men|till|av|han|hon|sig)\b/gi;
const EN = /\b(and|is|from|with|the|for|that|we|our|has|not|but|to|of|in|on|he|she|his|her)\b/gi;

function looksSwedish(text) {
  const sv = (text.match(SV) ?? []).length;
  const en = (text.match(EN) ?? []).length;
  // Require a real margin: a short string with one stray match proves nothing.
  return sv >= 4 && sv > en * 2;
}

/**
 * Read one value. Uses the REST API when a token is available (fast), and
 * otherwise shells out to wrangler, which authenticates with the OAuth
 * credentials already on this machine — no token needs to be created or
 * pasted just to run an audit.
 */
async function getValue(key) {
  if (TOKEN) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return res.ok ? res.text() : null;
  }
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["wrangler", "kv", "key", "get", key, "--namespace-id", NAMESPACE, "--remote"],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

const keys = readFileSync("/tmp/enkeys.txt", "utf8").split("\n").filter(Boolean);
if (!TOKEN) {
  console.log("No CLOUDFLARE_API_TOKEN set — falling back to wrangler (slower, but uses existing auth).");
}

console.log(`Auditing ${keys.length} English-target translations...`);
let done = 0;
const suspect = [];
await mapWithConcurrency(keys, CONCURRENCY, async (key) => {
  const value = await getValue(key);
  done += 1;
  if (done % 500 === 0) console.log(`  ${done}/${keys.length}`);
  if (value && looksSwedish(value)) suspect.push({ key, value });
});

console.log(`\n${suspect.length} English key(s) hold Swedish-looking text:\n`);
for (const s of suspect) {
  console.log(`  ${s.key}`);
  console.log(`    ${s.value.slice(0, 90).replace(/\s+/g, " ")}`);
}

if (process.argv.includes("--delete") && suspect.length) {
  console.log(`\nDeleting ${suspect.length} bad key(s) so they re-translate on next request...`);

  // Delete via the SAME transport the reads used. The first version of this
  // always used the REST endpoint, which silently no-ops without a token —
  // it printed "Done" while every key survived, which is worse than failing
  // loudly. Verified by re-reading afterwards rather than trusting either
  // transport's exit status: wrangler reports success on a delete whose
  // effect is not yet visible.
  let failed = 0;
  await mapWithConcurrency(suspect, TOKEN ? 6 : 3, async (s) => {
    try {
      if (TOKEN) {
        const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/${encodeURIComponent(s.key)}`;
        const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        await execFileAsync(
          "npx",
          ["wrangler", "kv", "key", "delete", s.key, "--namespace-id", NAMESPACE, "--remote"],
          { maxBuffer: 8 * 1024 * 1024 },
        );
      }
    } catch (err) {
      failed += 1;
      console.error(`  delete FAILED: ${s.key} — ${err.message ?? err}`);
    }
  });

  if (failed) {
    console.error(`\n${failed} of ${suspect.length} delete(s) failed. Re-run; nothing was silently skipped.`);
    process.exitCode = 1;
  } else {
    console.log("Deletes issued. NOTE: KV is eventually consistent — a read can");
    console.log("still return the old value for up to ~60s. Re-run this audit to confirm.");
  }
} else if (suspect.length) {
  console.log("\nRe-run with --delete to remove them.");
}
