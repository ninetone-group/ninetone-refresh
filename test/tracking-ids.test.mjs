/**
 * Tracker inventory carried over from the old ninetone.com (read off its live
 * HTML on 2026-09-13: GA4 G-X26Z7RRXTY, Meta Pixel 199979048106038, Microsoft
 * Clarity project pro0undslz; no Tag Manager, no TikTok pixel, no consent
 * tooling). The new site gates every tracker behind Consent Mode v2 and only
 * loads them once PUBLIC_NOINDEX is off, so a wrong id would surface only
 * after launch — pin the ids and the placeholder guard at the source.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = readFileSync(path.join(ROOT, "src/layouts/Base.astro"), "utf8");
const constant = (name) => base.match(new RegExp(`const ${name} = "([^"]+)"`))?.[1];

test("the three trackers the old site ran carry the same ids", () => {
  assert.equal(constant("GA4_ID"), "G-X26Z7RRXTY");
  assert.equal(constant("META_PIXEL_ID"), "199979048106038");
  assert.equal(constant("CLARITY_ID"), "pro0undslz");
});

test("trackers the old site never had stay placeholders, which the guard keeps off", () => {
  assert.match(constant("GTM_ID"), /-PLACEHOLDER$/);
  assert.match(constant("TIKTOK_PIXEL_ID"), /-PLACEHOLDER$/);
  assert.match(base, /const isPlaceholder = \(id: string\) => id\.endsWith\("-PLACEHOLDER"\)/);
});

test("Consent Mode v2 defaults to denied before any tracker script", () => {
  // The template only — the frontmatter's comments mention script URLs too.
  const template = base.slice(base.indexOf("<!doctype html>"));
  const consentAt = template.indexOf("gtag('consent', 'default'");
  const firstTracker = Math.min(...["gtm.js?id=", "gtag/js?id=", "fbevents.js", "clarity.ms/tag/"].map((s) => template.indexOf(s)).filter((i) => i >= 0));
  assert.ok(consentAt > 0 && consentAt < firstTracker, "consent default must precede every tracker");
  assert.match(template.slice(consentAt, consentAt + 400), /analytics_storage: 'denied'/);
});
