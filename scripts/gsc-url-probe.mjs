#!/usr/bin/env node
// Fetch every www.ninetone.com / ninetone.com URL in a GSC Pages.csv export against the
// live site and report what each one resolves to.
//
//   node scripts/gsc-url-probe.mjs docs/seo/gsc/2026-10-12 [--host https://www.ninetone.com]
//
// Read-only: one GET per URL, six in flight, redirects followed manually so the chain
// is visible. Prints a status summary, every non-200 URL, every redirect chain of two or
// more hops, and the redirect patterns by count. Use it after each new export to see the
// legacy-URL migration draining and to catch 404s before GSC reports them.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = args.find((x) => !x.startsWith("--"));
const hostIdx = args.indexOf("--host");
const host = hostIdx >= 0 ? args[hostIdx + 1] : null;
if (!dir) {
  console.error("usage: gsc-url-probe.mjs <exportDir> [--host https://staging.example]");
  process.exit(1);
}

const rows = fs
  .readFileSync(path.join(dir, "Pages.csv"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => {
    const parts = line.split(",");
    parts.pop();
    parts.pop();
    const impressions = Number(parts.pop());
    const clicks = Number(parts.pop());
    return { url: parts.join(","), clicks, impressions };
  })
  .filter((r) => /^https?:\/\/(www\.)?ninetone\.com\//.test(r.url));

const rewrite = (u) => (host ? u.replace(/^https?:\/\/(www\.)?ninetone\.com/, host) : u);

console.error(`probing ${rows.length} URLs${host ? ` on ${host}` : ""}`);
const out = [];
let i = 0;
async function worker() {
  while (i < rows.length) {
    const r = rows[i++];
    let cur = rewrite(r.url);
    const chain = [];
    let status = 0;
    try {
      for (let hops = 0; hops < 6; hops++) {
        const res = await fetch(cur, {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": "ninetone-gsc-url-probe" },
        });
        status = res.status;
        if (![301, 302, 307, 308].includes(status)) break;
        cur = new URL(res.headers.get("location"), cur).href;
        chain.push(`${status} -> ${cur}`);
      }
    } catch (e) {
      status = `ERR ${e.message}`;
    }
    out.push({ ...r, final: status, finalUrl: cur, chain });
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
out.sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions);

const strip = (u) => u.replace(/^https?:\/\/(www\.)?ninetone\.com/, "").replace(host ?? "\u0000", "");

const counts = {};
for (const o of out) {
  const k = o.final === 200 ? (o.chain.length ? "200 via redirect" : "200") : String(o.final);
  counts[k] ??= { n: 0, clicks: 0 };
  counts[k].n++;
  counts[k].clicks += o.clicks;
}
console.log("## Status summary");
for (const [k, v] of Object.entries(counts)) console.log(`${k.padEnd(18)} ${String(v.n).padStart(5)} URLs  ${String(v.clicks).padStart(7)} clicks`);

console.log("\n## Not 200 (clicks, impressions, url, chain)");
for (const o of out.filter((x) => x.final !== 200)) console.log(String(o.clicks).padStart(5), String(o.impressions).padStart(6), strip(o.url), "=>", o.final, o.chain.map(strip).join(" | "));

console.log("\n## Two or more hops");
for (const o of out.filter((x) => x.chain.length > 1)) console.log(String(o.clicks).padStart(5), strip(o.url), "=>", o.chain.map(strip).join(" | "));

const patterns = {};
for (const o of out.filter((x) => x.chain.length)) {
  const k = o.chain
    .map((c) => strip(c).replace(/\/[^/]+$/, "/<slug>"))
    .join(" | ");
  patterns[k] ??= { n: 0, clicks: 0 };
  patterns[k].n++;
  patterns[k].clicks += o.clicks;
}
console.log("\n## Redirect patterns");
for (const [k, v] of Object.entries(patterns).sort((x, y) => y[1].clicks - x[1].clicks)) console.log(String(v.n).padStart(5), "URLs", String(v.clicks).padStart(7), "clicks  ", k);

const jsonOut = path.join(dir, "probe-result.json");
if (args.includes("--save")) {
  fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
  console.error(`saved ${jsonOut}`);
}
