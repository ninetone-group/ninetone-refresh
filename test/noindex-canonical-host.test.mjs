import assert from "node:assert/strict";
import test from "node:test";

import { noindexFor } from "../src/lib/noindex.ts";
import { canonicalHostRedirect } from "../src/lib/canonical-host.ts";

// --- noindex (launch 2026-10-08) -------------------------------------------
// The cf build ships PUBLIC_NOINDEX=false; the workers.dev staging host must
// stay noindex anyway, and the gh preview (flag unset/true) stays noindex.

test("flag off + live host -> indexable", () => {
  assert.equal(noindexFor("www.ninetone.com", "false"), false);
  assert.equal(noindexFor("ninetone.com", "false"), false);
});

test("flag off + *.workers.dev host -> still noindex (staging is never a copy of the live site)", () => {
  assert.equal(noindexFor("ninetone-site.ninetone.workers.dev", "false"), true);
  assert.equal(noindexFor("NINETONE-SITE.NINETONE.WORKERS.DEV", "false"), true);
});

test("flag unset or anything but 'false' -> noindex on every host (the preview default)", () => {
  assert.equal(noindexFor("www.ninetone.com", undefined), true);
  assert.equal(noindexFor("www.ninetone.com", "true"), true);
  assert.equal(noindexFor("ninetone-group.github.io", "1"), true);
  assert.equal(noindexFor(undefined, undefined), true);
});

// --- canonical host --------------------------------------------------------
// www stays canonical (every URL Google holds is www); the naked domain 301s.

const CANON = "www.ninetone.com";

test("naked domain redirects to www with path and query kept", () => {
  assert.equal(
    canonicalHostRedirect(new URL("https://ninetone.com/records/artists/anjo?x=1"), CANON),
    "https://www.ninetone.com/records/artists/anjo?x=1",
  );
  assert.equal(canonicalHostRedirect(new URL("https://ninetone.com/"), CANON), "https://www.ninetone.com/");
  assert.equal(canonicalHostRedirect(new URL("http://NINETONE.COM/en/news"), CANON), "https://www.ninetone.com/en/news");
});

test("the canonical host itself and any other host (staging, previews) are left alone", () => {
  assert.equal(canonicalHostRedirect(new URL("https://www.ninetone.com/news"), CANON), null);
  assert.equal(canonicalHostRedirect(new URL("https://ninetone-site.ninetone.workers.dev/news"), CANON), null);
  assert.equal(canonicalHostRedirect(new URL("https://preview.ninetone.com/"), CANON), null);
  assert.equal(canonicalHostRedirect(new URL("https://localhost:4321/"), CANON), null);
});

test("no canonical host configured (static build, dev, tests) -> never redirects", () => {
  assert.equal(canonicalHostRedirect(new URL("https://ninetone.com/"), undefined), null);
  assert.equal(canonicalHostRedirect(new URL("https://ninetone.com/"), ""), null);
});
