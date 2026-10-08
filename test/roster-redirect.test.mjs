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

// --- Cross-division (2026-10-06) --------------------------------------------
// GSC 16-month export: /ninetone-nation/booking/tommy_nilsson (30 clicks) and
// /management/clients/ronny_and_ragge (22) are Records artists; the
// within-division lookup above cannot see them.

import { crossDivisionTarget, ARTIST_PATH, NATION_PATH, PREVIOUS_ARTIST_PATH } from "../src/lib/roster-redirect.ts";

const candidates = [
  { path: ARTIST_PATH, roster: [{ SLUG: "tommy_nilsson" }, { SLUG: "ronny_and_ragge" }] },
  { path: CLIENT_PATH, roster: [{ SLUG: "mekbrudarna" }] },
  { path: NATION_PATH, roster: [{ SLUG: "anjo" }, { SLUG: "mekbrudarna" }] },
  { path: PREVIOUS_ARTIST_PATH, roster: [{ SLUG: "kuokka" }, { SLUG: "tommy_nilsson" }] },
];

test("a slug missing from its own division redirects to the first other division that has it", () => {
  assert.equal(crossDivisionTarget("tommy_nilsson", candidates), "/records/artists/tommy_nilsson");
  assert.equal(crossDivisionTarget("anjo", candidates), "/ninetone-nation/anjo");
  assert.equal(crossDivisionTarget("kuokka", candidates), "/records/artists/previous/single/kuokka");
});

test("candidate order is the preference order: a current page beats a previous one, Management beats Nation", () => {
  assert.equal(crossDivisionTarget("mekbrudarna", candidates), "/management/clients/mekbrudarna");
  assert.equal(crossDivisionTarget("tommy_nilsson", candidates.slice().reverse()), "/records/artists/previous/single/tommy_nilsson");
});

test("unknown and empty slugs stay a 404 (null); an empty roster (failed load) is skipped", () => {
  assert.equal(crossDivisionTarget("nobody", candidates), null);
  assert.equal(crossDivisionTarget("", candidates), null);
  assert.equal(crossDivisionTarget("anjo", [{ path: ARTIST_PATH, roster: [] }, ...candidates]), "/ninetone-nation/anjo");
});
