import assert from "node:assert/strict";
import test from "node:test";

import { crossRosterTarget, CLIENT_PATH, PREVIOUS_CLIENT_PATH } from "../src/lib/roster-redirect.ts";

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

// --- Management clients (2026-09-14, "Tidigare klienter") -------------------
// The four GSC 404s that motivated the section: /management/clients/{slug}
// for a Not Active client must 301 to the previous-client detail page.

const previousClients = [{ SLUG: "bangarden_customs" }, { SLUG: "raketforskaren" }, { SLUG: "luddze_" }, { SLUG: "johanna_and_marcus" }];
const currentClients = [{ SLUG: "active-client" }];

test("an old client URL for a now-previous client redirects to the previous-client detail page", () => {
  for (const slug of ["bangarden_customs", "raketforskaren", "luddze_", "johanna_and_marcus"]) {
    assert.equal(
      crossRosterTarget(slug, "current", previousClients, "management"),
      `/management/clients/previous/single/${slug}`,
    );
  }
  assert.equal(PREVIOUS_CLIENT_PATH, "/management/clients/previous/single");
});

test("a previous-client URL for a re-signed client redirects back to the current client page", () => {
  assert.equal(crossRosterTarget("active-client", "previous", currentClients, "management"), "/management/clients/active-client");
  assert.equal(CLIENT_PATH, "/management/clients");
});

test("the management pair never produces a records path, and unknown client slugs stay a 404", () => {
  assert.equal(crossRosterTarget("nobody", "current", previousClients, "management"), null);
  assert.equal(crossRosterTarget("", "previous", currentClients, "management"), null);
  // A slug that happens to exist in the RECORDS previous roster is not the
  // management sibling's business — the caller passes the sibling list.
  assert.equal(crossRosterTarget("am_metro", "current", previousClients, "management"), null);
  assert.ok(!crossRosterTarget("bangarden_customs", "current", previousClients, "management").startsWith("/records"));
});

test("omitting the division keeps the original records behaviour (existing call sites unchanged)", () => {
  assert.equal(crossRosterTarget("am_metro", "current", previous), crossRosterTarget("am_metro", "current", previous, "records"));
});
