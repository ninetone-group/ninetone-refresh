import assert from "node:assert/strict";
import test from "node:test";

import {
  INDEXNOW_MAX_URLS,
  INDEXNOW_RETRY_AFTER_MS,
  INDEXNOW_SNAPSHOT_KEY,
  changedUrls,
  indexNowSyncDisabled,
  parseSitemap,
  syncIndexNow,
} from "../src/lib/indexnow-sync.ts";

const ORIGIN = "https://www.ninetone.com";

/** A urlset in the exact shape renderUrlsetXml() writes (src/lib/sitemap.ts). */
function sitemap(entries) {
  const urls = entries
    .map(([path, lastmod]) => {
      const loc = `${ORIGIN}${path}`;
      const alt = `<xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}/en${path}"/>`;
      return `<url><loc>${loc.replace(/&/g, "&amp;")}</loc>${alt}${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}<changefreq>monthly</changefreq></url>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`;
}

function fakeKv(initial) {
  const map = new Map(initial ? [[INDEXNOW_SNAPSHOT_KEY, JSON.stringify(initial)]] : []);
  const puts = [];
  return {
    map,
    puts,
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => {
      puts.push(key);
      map.set(key, value);
    },
    stored: () => JSON.parse(map.get(INDEXNOW_SNAPSHOT_KEY)),
  };
}

/** Runs one pass against a sitemap; records what was pinged. */
async function run({ kv, entries, xml, accept = true, now = 1_000_000, throws = false }) {
  const pinged = [];
  const result = await syncIndexNow({
    kv,
    loadSitemap: async () => (xml !== undefined ? xml : sitemap(entries)),
    ping: async (urls) => {
      pinged.push(urls);
      if (throws) throw new Error("network");
      return accept;
    },
    now: () => now,
  });
  return { result, pinged };
}

const BASE = [
  ["/", ""],
  ["/news", ""],
  ["/news/karakou_slapper_soldater", "2026-10-30"],
  ["/records/artists/karakou", ""],
];

test("parseSitemap: every <url> as loc → lastmod, alternates ignored, entities decoded", () => {
  const parsed = parseSitemap(sitemap([...BASE, ["/search?a=1&b=2", ""]]));
  assert.equal(parsed.size, 5);
  assert.equal(parsed.get(`${ORIGIN}/news/karakou_slapper_soldater`), "2026-10-30");
  assert.equal(parsed.get(`${ORIGIN}/`), "");
  assert.ok(parsed.has(`${ORIGIN}/search?a=1&b=2`));
  assert.ok(!parsed.has(`${ORIGIN}/en/news`), "an hreflang alternate is not a sitemap entry of its own");
  assert.equal(parseSitemap("<urlset></urlset>").size, 0);
  assert.equal(parseSitemap("not xml").size, 0);
});

test("changedUrls: new URLs and changed lastmod only", () => {
  const previous = new Map([["a", ""], ["b", "2026-10-01"], ["gone", ""]]);
  const current = new Map([["a", ""], ["b", "2026-11-01"], ["c", ""]]);
  assert.deepEqual(changedUrls(previous, current), ["b", "c"]);
  assert.deepEqual(changedUrls(current, current), []);
});

test("first run reports the whole sitemap once and records it", async () => {
  const kv = fakeKv();
  const { result, pinged } = await run({ kv, entries: BASE });
  assert.deepEqual(result, { outcome: "seeded", count: 4 });
  assert.deepEqual(pinged, [BASE.map(([path]) => `${ORIGIN}${path}`)]);
  assert.equal(Object.keys(kv.stored().urls).length, 4);
  assert.equal(kv.stored().failedAt, undefined);

  // Second pass, same sitemap: nothing sent, nothing written.
  const again = await run({ kv, entries: BASE });
  assert.deepEqual(again.result, { outcome: "unchanged", count: 0 });
  assert.deepEqual(again.pinged, []);
  assert.equal(kv.puts.length, 1, "an unchanged sitemap costs no KV write");
});

test("a new article and a re-dated article are reported; everything else is not", async () => {
  const kv = fakeKv();
  await run({ kv, entries: BASE });
  const next = [
    ["/", ""],
    ["/news", ""],
    ["/news/karakou_slapper_soldater", "2026-11-10"], // edited
    ["/news/simon_imhauser_en_varldsmastare_ninetone", "2026-11-09"], // new
    ["/records/artists/karakou", ""],
  ];
  const { result, pinged } = await run({ kv, entries: next });
  assert.deepEqual(result, { outcome: "pinged", count: 2 });
  assert.deepEqual(pinged, [[
    `${ORIGIN}/news/karakou_slapper_soldater`,
    `${ORIGIN}/news/simon_imhauser_en_varldsmastare_ninetone`,
  ]]);
  assert.equal(kv.stored().urls[`${ORIGIN}/news/karakou_slapper_soldater`], "2026-11-10");
});

test("a URL that left the sitemap is dropped from the record without a ping", async () => {
  const kv = fakeKv();
  await run({ kv, entries: BASE });
  const { result, pinged } = await run({ kv, entries: BASE.slice(0, 3) });
  assert.deepEqual(result, { outcome: "unchanged", count: 0 });
  assert.deepEqual(pinged, []);
  assert.equal(Object.keys(kv.stored().urls).length, 3);
});

test("a refused ping records nothing as reported, backs off, then reports again", async () => {
  const kv = fakeKv();
  const t0 = 5_000_000;
  const refused = await run({ kv, entries: BASE, accept: false, now: t0 });
  assert.deepEqual(refused.result, { outcome: "failed", count: 4 });
  assert.deepEqual(kv.stored().urls, {}, "nothing counts as reported");
  assert.equal(kv.stored().failedAt, t0);

  // Inside the back-off: the sitemap is not even fetched.
  let fetched = false;
  const waiting = await syncIndexNow({
    kv,
    loadSitemap: async () => {
      fetched = true;
      return sitemap(BASE);
    },
    ping: async () => {
      throw new Error("must not ping during back-off");
    },
    now: () => t0 + INDEXNOW_RETRY_AFTER_MS - 1,
  });
  assert.deepEqual(waiting, { outcome: "backoff", count: 0 });
  assert.equal(fetched, false);

  // After it: the same URLs go out again, and the failure mark is cleared.
  const retried = await run({ kv, entries: BASE, now: t0 + INDEXNOW_RETRY_AFTER_MS });
  assert.deepEqual(retried.result, { outcome: "seeded", count: 4 });
  assert.equal(kv.stored().failedAt, undefined);
});

test("a ping that throws is a failure, not a crash, and keeps what was already reported", async () => {
  const kv = fakeKv();
  await run({ kv, entries: BASE });
  const next = [...BASE, ["/records/artists/annika_ljungberg", ""]];
  const { result } = await run({ kv, entries: next, throws: true, now: 9_000_000 });
  assert.deepEqual(result, { outcome: "failed", count: 1 });
  assert.equal(Object.keys(kv.stored().urls).length, 4, "the earlier report is kept");
  assert.equal(kv.stored().failedAt, 9_000_000);
  // After the back-off only the one new URL is sent — not the whole sitemap again.
  const retried = await run({ kv, entries: next, now: 9_000_000 + INDEXNOW_RETRY_AFTER_MS });
  assert.deepEqual(retried.result, { outcome: "pinged", count: 1 });
  assert.deepEqual(retried.pinged, [[`${ORIGIN}/records/artists/annika_ljungberg`]]);
});

test("a sitemap that lost most of its URLs is ignored, so they are not reported as new when they return", async () => {
  const many = Array.from({ length: 40 }, (_, i) => [`/records/artists/artist_${i}`, ""]);
  const kv = fakeKv();
  await run({ kv, entries: many });
  // Office unreachable: the roster reads failed and the sitemap holds 10 URLs.
  const partial = await run({ kv, entries: many.slice(0, 10) });
  assert.deepEqual(partial.result, { outcome: "unhealthy", count: 10 });
  assert.deepEqual(partial.pinged, []);
  assert.equal(Object.keys(kv.stored().urls).length, 40, "the record is untouched");
  // Back to normal: nothing to report.
  const recovered = await run({ kv, entries: many });
  assert.deepEqual(recovered.result, { outcome: "unchanged", count: 0 });
  assert.deepEqual(recovered.pinged, []);
});

test("no sitemap, an empty sitemap and an unreadable record are all handled", async () => {
  const kv = fakeKv();
  assert.deepEqual((await run({ kv, xml: null })).result, { outcome: "no-sitemap", count: 0 });
  assert.deepEqual((await run({ kv, xml: "<urlset></urlset>" })).result, { outcome: "no-sitemap", count: 0 });
  assert.equal(kv.puts.length, 0);

  // A record from some other shape is treated as no record at all.
  kv.map.set(INDEXNOW_SNAPSHOT_KEY, "{not json");
  assert.equal((await run({ kv, entries: BASE })).result.outcome, "seeded");
  kv.map.set(INDEXNOW_SNAPSHOT_KEY, JSON.stringify({ v: 2, urls: {} }));
  assert.equal((await run({ kv, entries: BASE })).result.outcome, "seeded");
});

test("more URLs than one request takes: the rest go out on the next pass", async () => {
  const entries = Array.from({ length: INDEXNOW_MAX_URLS + 5 }, (_, i) => [`/p/${i}`, ""]);
  const kv = fakeKv();
  const first = await run({ kv, entries });
  assert.deepEqual(first.result, { outcome: "seeded", count: INDEXNOW_MAX_URLS });
  assert.equal(Object.keys(kv.stored().urls).length, INDEXNOW_MAX_URLS);
  const second = await run({ kv, entries });
  assert.deepEqual(second.result, { outcome: "pinged", count: 5 });
  assert.equal(second.pinged[0][0], `${ORIGIN}/p/${INDEXNOW_MAX_URLS}`);
});

test("indexNowSyncDisabled: exactly 'off' and nothing else", () => {
  assert.equal(indexNowSyncDisabled({ INDEXNOW_SYNC: "off" }), true);
  assert.equal(indexNowSyncDisabled({ INDEXNOW_SYNC: "OFF" }), false);
  assert.equal(indexNowSyncDisabled({ INDEXNOW_SYNC: "" }), false);
  assert.equal(indexNowSyncDisabled({}), false);
});
