#!/usr/bin/env node
// Compare two Google Search Console export folders (docs/seo/gsc/<date>/).
//
//   node scripts/gsc-compare.mjs docs/seo/gsc/2026-10-12 docs/seo/gsc/2026-11-12
//
// Prints: last-30-day run rate from Chart.csv, clicks/impressions by host and by
// www section from Pages.csv, and the biggest page and query movers. Read-only.
// Note that GSC's Pages/Queries exports are "top 1000" over the export's whole date
// range, so a longer or shorter range changes the totals; the Chart.csv comparison
// is the one that is apples to apples.

import fs from "node:fs";
import path from "node:path";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: gsc-compare.mjs <baselineDir> <newDir>");
  process.exit(1);
}

function readCsv(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const parts = line.split(",");
      const position = Number(parts.pop());
      parts.pop(); // CTR, derived
      const impressions = Number(parts.pop());
      const clicks = Number(parts.pop());
      return { key: parts.join(","), clicks, impressions, position };
    });
}

const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(2) + "%" : "-");
const delta = (x, y) => {
  const d = y - x;
  const p = x ? ` (${d >= 0 ? "+" : ""}${((100 * d) / x).toFixed(0)}%)` : "";
  return `${d >= 0 ? "+" : ""}${d}${p}`;
};

function section(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^(www\.)?ninetone\.com$/.test(u.host)) return null;
  const s = u.pathname.split("/").filter(Boolean);
  if (s.length === 0) return "/";
  if (s[0] === "en") return "/en/*";
  const two = ["records", "management", "ninetone-nation"].includes(s[0]) && s.length > 1;
  const base = "/" + s.slice(0, two ? 2 : 1).join("/");
  return s.length > (two ? 2 : 1) ? base + "/*" : base;
}

function groupBy(rows, fn) {
  const out = new Map();
  for (const r of rows) {
    const k = fn(r.key);
    if (k == null) continue;
    const g = out.get(k) ?? { n: 0, clicks: 0, impressions: 0 };
    g.n++;
    g.clicks += r.clicks;
    g.impressions += r.impressions;
    out.set(k, g);
  }
  return out;
}

function table(title, left, right, keys) {
  console.log(`\n## ${title}`);
  console.log(
    "section".padEnd(40),
    "clicks".padStart(14),
    "→".padStart(8),
    "impressions".padStart(14),
    "→".padStart(8),
    "ctr".padStart(14),
  );
  for (const k of keys) {
    const l = left.get(k) ?? { clicks: 0, impressions: 0 };
    const r = right.get(k) ?? { clicks: 0, impressions: 0 };
    console.log(
      k.padEnd(40),
      String(l.clicks).padStart(7),
      String(r.clicks).padStart(7),
      delta(l.clicks, r.clicks).padStart(8),
      String(l.impressions).padStart(7),
      String(r.impressions).padStart(7),
      delta(l.impressions, r.impressions).padStart(8),
      pct(l.clicks, l.impressions).padStart(7),
      pct(r.clicks, r.impressions).padStart(7),
    );
  }
}

// --- Chart: run rate -------------------------------------------------------
const chartA = readCsv(a, "Chart.csv");
const chartB = readCsv(b, "Chart.csv");
console.log(`# GSC compare: ${path.basename(a)} → ${path.basename(b)}`);
if (chartA.length && chartB.length) {
  const lastA = chartA.slice(-30);
  const lastB = chartB.slice(-30);
  console.log("\n## Last 30 days in each export (Chart.csv)");
  console.log(`${lastA[0].key}..${lastA.at(-1).key}  clicks ${sum(lastA, "clicks")}  impressions ${sum(lastA, "impressions")}  ctr ${pct(sum(lastA, "clicks"), sum(lastA, "impressions"))}`);
  console.log(`${lastB[0].key}..${lastB.at(-1).key}  clicks ${sum(lastB, "clicks")}  impressions ${sum(lastB, "impressions")}  ctr ${pct(sum(lastB, "clicks"), sum(lastB, "impressions"))}`);
  console.log(`delta: clicks ${delta(sum(lastA, "clicks"), sum(lastB, "clicks"))}, impressions ${delta(sum(lastA, "impressions"), sum(lastB, "impressions"))}`);

  // Same calendar window a year earlier, when the export reaches that far back.
  const first = lastB[0].key;
  const lastYear = chartB.filter((r) => {
    const d = new Date(r.key);
    d.setFullYear(d.getFullYear() + 1);
    const k = d.toISOString().slice(0, 10);
    return k >= first && k <= lastB.at(-1).key;
  });
  if (lastYear.length >= 25) {
    console.log(`same window last year: clicks ${sum(lastYear, "clicks")}  impressions ${sum(lastYear, "impressions")}  (${lastYear.length} days)`);
  }
}

// --- Pages: hosts and sections ---------------------------------------------
const pagesA = readCsv(a, "Pages.csv");
const pagesB = readCsv(b, "Pages.csv");
if (pagesA.length && pagesB.length) {
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  };
  const hA = groupBy(pagesA, host);
  const hB = groupBy(pagesB, host);
  table("By host (Pages.csv, top 1000 each)", hA, hB, [...new Set([...hA.keys(), ...hB.keys()])].sort((x, y) => (hB.get(y)?.clicks ?? 0) - (hB.get(x)?.clicks ?? 0)));

  const sA = groupBy(pagesA, section);
  const sB = groupBy(pagesB, section);
  table("www.ninetone.com by section", sA, sB, [...new Set([...sA.keys(), ...sB.keys()])].sort((x, y) => (sB.get(y)?.clicks ?? 0) - (sB.get(x)?.clicks ?? 0)));

  const mapA = new Map(pagesA.map((r) => [r.key, r]));
  const mapB = new Map(pagesB.map((r) => [r.key, r]));
  const movers = [...new Set([...mapA.keys(), ...mapB.keys()])]
    .filter((k) => /ninetone\.com/.test(k) && !/^https?:\/\/(shop|link)\./.test(k))
    .map((k) => ({ k, a: mapA.get(k)?.clicks ?? 0, b: mapB.get(k)?.clicks ?? 0 }))
    .map((m) => ({ ...m, d: m.b - m.a }))
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    .slice(0, 25);
  console.log("\n## Biggest www page movers (clicks, baseline → new)");
  for (const m of movers) console.log(String(m.a).padStart(6), String(m.b).padStart(6), delta(m.a, m.b).padStart(12), m.k.replace(/^https?:\/\/(www\.)?ninetone\.com/, ""));

  const newUrls = pagesB.filter((r) => !mapA.has(r.key) && /\/\/www\.ninetone\.com\//.test(r.key)).sort((x, y) => y.impressions - x.impressions).slice(0, 20);
  console.log("\n## New www URLs in the index (not in baseline), by impressions");
  for (const r of newUrls) console.log(String(r.clicks).padStart(6), String(r.impressions).padStart(7), r.position.toFixed(1).padStart(6), r.key.replace("https://www.ninetone.com", ""));
}

// --- Queries ----------------------------------------------------------------
const qA = readCsv(a, "Queries.csv");
const qB = readCsv(b, "Queries.csv");
if (qA.length && qB.length) {
  const brand = /\b(nine ?tone|9 ?tone|ninton|nintone|ninetoon|ninestone|ninetoone|ninetene|ninetones)/i;
  const bA = qA.filter((r) => brand.test(r.key));
  const bB = qB.filter((r) => brand.test(r.key));
  console.log("\n## Brand queries");
  console.log(`baseline: ${bA.length} queries, ${sum(bA, "clicks")} clicks, ${sum(bA, "impressions")} impressions`);
  console.log(`new:      ${bB.length} queries, ${sum(bB, "clicks")} clicks, ${sum(bB, "impressions")} impressions`);
  for (const q of ["ninetone", "ninetone records", "ninetone group ab", "ninetone group"]) {
    const x = qA.find((r) => r.key === q);
    const y = qB.find((r) => r.key === q);
    console.log(`  ${q.padEnd(20)} position ${x?.position ?? "-"} → ${y?.position ?? "-"}   clicks ${x?.clicks ?? 0} → ${y?.clicks ?? 0}`);
  }

  const mapA = new Map(qA.map((r) => [r.key, r]));
  const mapB = new Map(qB.map((r) => [r.key, r]));
  const movers = [...new Set([...mapA.keys(), ...mapB.keys()])]
    .map((k) => ({ k, a: mapA.get(k)?.clicks ?? 0, b: mapB.get(k)?.clicks ?? 0 }))
    .map((m) => ({ ...m, d: m.b - m.a }))
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    .slice(0, 20);
  console.log("\n## Biggest query movers (clicks, baseline → new)");
  for (const m of movers) console.log(String(m.a).padStart(6), String(m.b).padStart(6), delta(m.a, m.b).padStart(12), m.k);
}
