import assert from "node:assert/strict";
import test from "node:test";

import { crossRosterTarget } from "../src/lib/roster-redirect.ts";

const previous = [{ SLUG: "am_metro" }, { SLUG: "old-band" }];
const current = [{ SLUG: "halsingefyr" }];

test("an old current-artist URL for a now-previous artist redirects to the previous detail page", () => {
  assert.equal(crossRosterTarget("am_metro", "current", previous), "/records/artists/previous/single/am_metro");
});

test("a previous-artist URL for a re-signed artist redirects to the current detail page", () => {
  assert.equal(crossRosterTarget("halsingefyr", "previous", current), "/records/artists/halsingefyr");
});

test("unknown slugs stay a 404 (null), and the slug is URL-encoded in the target", () => {
  assert.equal(crossRosterTarget("nobody", "current", previous), null);
  assert.equal(crossRosterTarget("", "current", previous), null);
  assert.equal(crossRosterTarget("a b/c", "current", [{ SLUG: "a b/c" }]), "/records/artists/previous/single/a%20b%2Fc");
});
