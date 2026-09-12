/**
 * Direct unit coverage for the two pure redirect-target helpers in
 * src/lib/cache-policy.ts.
 *
 * These were previously exercised only INDIRECTLY, through the esbuild-
 * bundled middleware in test/middleware.test.mjs. That bundle gates the
 * redirect branch on `PUBLIC_HAS_RUNTIME` (see the define in that file), so
 * the helpers' own edge cases — in particular the "/previous-artists/single"
 * listing-vs-slug guard, whose absence redirects into a 404 — had no test
 * that would fail if the guard were deleted.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSearch,
  legacyPreviousArtistTarget,
  trailingSlashRedirectTarget,
} from "../src/lib/cache-policy.ts";

// --- legacyPreviousArtistTarget -------------------------------------------

test("legacyPreviousArtistTarget: both legacy shapes reach today's detail path", () => {
  assert.equal(
    legacyPreviousArtistTarget("/previous-artists/kuokka"),
    "/records/artists/previous/single/kuokka",
  );
  assert.equal(
    legacyPreviousArtistTarget("/previous-artists/single/kuokka"),
    "/records/artists/previous/single/kuokka",
  );
  // A trailing slash on the legacy link resolves to the same canonical target,
  // not to a second redirect hop.
  assert.equal(
    legacyPreviousArtistTarget("/previous-artists/kuokka/"),
    "/records/artists/previous/single/kuokka",
  );
});

test("legacyPreviousArtistTarget: bare '/previous-artists/single' is the LISTING, not a slug", () => {
  // Without the guard this becomes /records/artists/previous/single/single —
  // a permanent redirect into a 404. public/_redirects carries the same rule.
  assert.equal(
    legacyPreviousArtistTarget("/previous-artists/single"),
    "/records/artists/previous",
  );
  assert.equal(
    legacyPreviousArtistTarget("/previous-artists/single/"),
    "/records/artists/previous",
  );
});

test("legacyPreviousArtistTarget: returns null for anything it does not own", () => {
  // The bare listing is owned by astro.config.mjs's static `redirects`.
  assert.equal(legacyPreviousArtistTarget("/previous-artists"), null);
  assert.equal(legacyPreviousArtistTarget("/previous-artists/"), null);
  // Deeper than one slug segment is not a legacy shape.
  assert.equal(legacyPreviousArtistTarget("/previous-artists/single/a/b"), null);
  // Unrelated paths, and the modern path itself, must never be rewritten —
  // rewriting the destination would be a redirect loop.
  assert.equal(legacyPreviousArtistTarget("/records/artists/previous/single/kuokka"), null);
  assert.equal(legacyPreviousArtistTarget("/"), null);
  assert.equal(legacyPreviousArtistTarget("/news/some-post"), null);
});

// --- trailingSlashRedirectTarget ------------------------------------------

test("trailingSlashRedirectTarget: strips exactly one trailing slash", () => {
  assert.equal(trailingSlashRedirectTarget("/records/"), "/records");
  assert.equal(trailingSlashRedirectTarget("/records/artists/anjo/"), "/records/artists/anjo");
});

test("trailingSlashRedirectTarget: null when there is nothing to canonicalize", () => {
  // Root is never redirected — stripping would produce "", not a path.
  assert.equal(trailingSlashRedirectTarget("/"), null);
  assert.equal(trailingSlashRedirectTarget("/records"), null);
});

test("trailingSlashRedirectTarget: honours the SKIP list it shares with the cache bypass", () => {
  // A redirect here would bounce a POST /api/contact/ and, for /404, feed the
  // nested-rewrite path the middleware deliberately never caches.
  assert.equal(trailingSlashRedirectTarget("/api/contact/"), null);
  assert.equal(trailingSlashRedirectTarget("/404/"), null);
});

// --- canonicalSearch -------------------------------------------------------

test("canonicalSearch: tracking-only params collapse onto the bare cache key", () => {
  assert.equal(canonicalSearch(""), "");
  assert.equal(canonicalSearch("?utm_source=newsletter&utm_medium=email"), "");
});

test("canonicalSearch: any meaningful param returns null so the request bypasses the shared cache", () => {
  // /search-result?q=… must never be served another visitor's cached answer.
  assert.equal(canonicalSearch("?q=anjo"), null);
  // One real param alongside tracking params still disqualifies the whole URL.
  assert.equal(canonicalSearch("?utm_source=x&q=anjo"), null);
});

// ---------------------------------------------------------------------------
// 2026-09-12 adversarial review: doubled slashes
// ---------------------------------------------------------------------------
import { collapseSlashes } from "../src/lib/cache-policy.ts";

test("collapseSlashes: folds every run of slashes and returns null when already canonical", () => {
  assert.equal(collapseSlashes("//evil.com/"), "/evil.com/");
  assert.equal(collapseSlashes("/en//admin/publish"), "/en/admin/publish");
  assert.equal(collapseSlashes("///a////b"), "/a/b");
  assert.equal(collapseSlashes("/records/artists"), null);
  assert.equal(collapseSlashes("/"), null);
});
