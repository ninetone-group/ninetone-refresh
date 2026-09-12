/**
 * FM -> SourceRecord adapter tests — checkpoint 4.5.
 *
 * Getters are injected, so these run with no FM, no network and no spend. The
 * fixtures use the field names and shapes PROBED from live FileMaker (counts
 * recorded in docs/translation-publication-progress.md), so a drift between
 * ENTITY_FIELDS and the real layouts shows up here.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  PROMPT_VERSION,
  blockIdOf,
  blockOrderOf,
  loadSourceRecords,
  protectedNamesFor,
} from "../src/lib/publication/fm-source.ts";

async function testHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Shapes mirror live FM: raw fieldData spread for slug kinds, mapped for the rest. */
function getters(overrides = {}) {
  return {
    getArtists: async () => [
      {
        SLUG: "anjo",
        "Head Artist": "Anjo",
        "Artist Presentation Title": "Titel",
        artistPresentationString: "Lång bio.",
        artistPresentationShort: "Kort bio.",
      },
    ],
    getPreviousArtists: async () => [
      { SLUG: "gamle", "Head Artist": "Gamle", artistPresentationShort: "Förr." },
    ],
    getClients: async () => [
      {
        SLUG: "kund",
        "Head Artist": "Kund AB",
        clientPresentationTitle: "Kundtitel",
        clientPresentationString: "Kundbio.",
        clientPresentationShort: "Kort kund.",
      },
    ],
    getBookingRoster: async () => [
      {
        SLUG: "talang",
        "Head Artist": "Talang",
        bookingPresentationTitle: "Bokningstitel",
        bookingPresentationString: "Bokningsbio.",
      },
    ],
    getTeam: async () => [
      {
        SLUG: "mikael",
        userNameCalc: "Mikael Ohlen",
        title: "VD",
        titleDescription: "Leder bolaget.",
        DescriptionString: "Lång beskrivning.",
        Description: "Skall ignoreras.",
      },
    ],
    getNews: async () => [
      // Live FM: lowercase `slug`, capitalized `Title`.
      { slug: "nyhet-1", Title: "Rubrik", shortMessage: "Kort.", MessageString: "Brödtext." },
    ],
    getBookingCategories: async () => [{ tag: "Artist", description: "Artistbeskrivning.", artists: [] }],
    getWebPosts: async () => [
      {
        category: "Ninetone Group",
        title: "Sektionstitel",
        blocks: [
          { recordId: "1", subject: "Block ett", message: "Text ett." },
          { recordId: "2", subject: "Block två", message: "Text två." },
        ],
      },
    ],
    ...overrides,
  };
}

function deps(overrides = {}, onFailure) {
  return { getters: getters(overrides), hash: testHash, onFailure };
}

const refOf = (r) => `${r.kind}:${r.id}`;

// ---------------------------------------------------------------------------
// Coverage and identity
// ---------------------------------------------------------------------------

test("loads every entity kind with the probed identity fields", async () => {
  const { records, complete, failures } = await loadSourceRecords(deps());
  assert.equal(complete, true);
  assert.deepEqual(failures, []);

  const byKind = {};
  for (const r of records) (byKind[r.kind] ??= []).push(r.id);

  assert.deepEqual(byKind.artist, ["anjo"]);
  assert.deepEqual(byKind.previousArtist, ["gamle"]);
  assert.deepEqual(byKind.client, ["kund"]);
  assert.deepEqual(byKind.bookingTalent, ["talang"]);
  assert.deepEqual(byKind.teamMember, ["mikael"]);
  assert.deepEqual(byKind.newsPost, ["nyhet-1"], "news uses lowercase `slug`");
  assert.deepEqual(byKind.bookingCategory, ["Artist"]);
});

test("only ENTITY_FIELDS fields are captured", async () => {
  const { records } = await loadSourceRecords(deps());
  const team = records.find((r) => r.kind === "teamMember");
  assert.deepEqual(Object.keys(team.fields).sort(), [
    "DescriptionString",
    "title",
    "titleDescription",
  ]);
  assert.equal(team.fields.Description, undefined, "the non-contract fallback is not captured");
});

test("a record with no identity is skipped, never given a synthetic id", async () => {
  const { records } = await loadSourceRecords(
    deps({ getArtists: async () => [{ SLUG: "", "Head Artist": "Namnlös", artistPresentationShort: "X." }] }),
  );
  assert.equal(records.filter((r) => r.kind === "artist").length, 0);
});

test("sparse prose fields do not block a record", async () => {
  // Live FM: bookingPresentationTitle is populated on only 10 of 72 rows.
  const { records } = await loadSourceRecords(
    deps({ getBookingRoster: async () => [{ SLUG: "tom", "Head Artist": "Tom" }] }),
  );
  const talent = records.find((r) => r.kind === "bookingTalent");
  assert.ok(talent, "a record with no prose is still a record");
  assert.deepEqual(talent.fields, {});
});

// ---------------------------------------------------------------------------
// webPostSection grain: section title separate from repeated blocks
// ---------------------------------------------------------------------------

test("section title and blocks are separate records", async () => {
  const { records } = await loadSourceRecords(deps());
  const sections = records.filter((r) => r.kind === "webPostSection");

  const section = sections.find((r) => r.id === "Ninetone Group");
  assert.deepEqual(section.fields, { title: "Sektionstitel" }, "section carries only its title");

  const blocks = sections.filter((r) => r.id.includes("#"));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].fields, { subject: "Block ett", message: "Text ett." });
  assert.equal(blocks[0].fields.title, undefined, "a block never carries the section title");
});

test("blocks use FM recordId for stable identity", async () => {
  const { records } = await loadSourceRecords(deps());
  const ids = records.filter((r) => r.id.includes("#")).map((r) => r.id);
  assert.deepEqual(ids, ["Ninetone Group#1", "Ninetone Group#2"]);
});

test("editing a block's subject does NOT change its id", async () => {
  const before = await loadSourceRecords(deps());
  const after = await loadSourceRecords(
    deps({
      getWebPosts: async () => [
        {
          category: "Ninetone Group",
          title: "Sektionstitel",
          blocks: [
            { recordId: "1", subject: "HELT NY RUBRIK", message: "Text ett." },
            { recordId: "2", subject: "Block två", message: "Text två." },
          ],
        },
      ],
    }),
  );

  const idsOf = (r) => r.records.filter((x) => x.id.includes("#")).map((x) => x.id);
  assert.deepEqual(idsOf(after), idsOf(before), "identity survives an edit — no phantom delete");

  const b = (r) => r.records.find((x) => x.id === "Ninetone Group#1");
  assert.notEqual(b(after).hash, b(before).hash, "but the content hash does change");
});

test("reordering blocks keeps identity and updates order", async () => {
  const { records, blockOrder } = await loadSourceRecords(
    deps({
      getWebPosts: async () => [
        {
          category: "Ninetone Group",
          title: "T",
          blocks: [
            { recordId: "2", subject: "Block två", message: "Text två." },
            { recordId: "1", subject: "Block ett", message: "Text ett." },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(
    blockOrder.map((b) => [b.ref, b.order]),
    [
      ["webPostSection:Ninetone Group#2", 0],
      ["webPostSection:Ninetone Group#1", 1],
    ],
  );
  // Reordering must not change either block's content hash.
  const one = records.find((r) => r.id === "Ninetone Group#1");
  assert.ok(one.fields.subject === "Block ett");
});

test("parentage is bidirectional", async () => {
  const { records, blockOrder } = await loadSourceRecords(deps());
  const section = records.find((r) => r.id === "Ninetone Group");
  const block = records.find((r) => r.id === "Ninetone Group#1");

  assert.ok(
    section.references.includes("webPostSection:Ninetone Group#1"),
    "section references its blocks",
  );
  assert.deepEqual(block.references, ["webPostSection:Ninetone Group"], "block references its section");
  assert.equal(blockOrder[0].parentRef, "webPostSection:Ninetone Group");
});

test("a block without recordId falls back to a deterministic ordinal", async () => {
  const { records } = await loadSourceRecords(
    deps({
      getWebPosts: async () => [
        { category: "Sek", title: "T", blocks: [{ subject: "A", message: "B" }] },
      ],
    }),
  );
  assert.ok(records.some((r) => r.id === "Sek#idx0"));
  assert.equal(blockIdOf("Sek", {}, 3), "Sek#idx3");
  assert.equal(blockOrderOf(2), 2);
});

test("editing one block does not change another block's hash", async () => {
  const before = await loadSourceRecords(deps());
  const after = await loadSourceRecords(
    deps({
      getWebPosts: async () => [
        {
          category: "Ninetone Group",
          title: "Sektionstitel",
          blocks: [
            { recordId: "1", subject: "Ändrad", message: "Ändrad text." },
            { recordId: "2", subject: "Block två", message: "Text två." },
          ],
        },
      ],
    }),
  );
  const two = (r) => r.records.find((x) => x.id === "Ninetone Group#2").hash;
  assert.equal(two(after), two(before), "blast radius stays on the edited block");
});

// ---------------------------------------------------------------------------
// All-or-nothing completeness
// ---------------------------------------------------------------------------

test("a failed layout clears `complete` and is reported", async () => {
  const seen = [];
  const { records, complete, failures } = await loadSourceRecords(
    deps(
      {
        getNews: async () => {
          throw new Error("FM 500");
        },
      },
      (layout, error) => seen.push([layout, String(error)]),
    ),
  );

  assert.equal(complete, false, "a partial read must never look complete");
  assert.deepEqual(failures, ["API_NEWS"]);
  assert.equal(seen.length, 1);
  assert.ok(records.length > 0, "other layouts still load — one failure does not hide the rest");
  assert.equal(records.filter((r) => r.kind === "newsPost").length, 0);
});

test("an empty layout is complete-and-fine, not a failure", async () => {
  // Live FM has no "Guider" category at all, so guides legitimately yield zero.
  const { complete, failures, records } = await loadSourceRecords(
    deps({ getWebPosts: async () => [] }),
  );
  assert.equal(complete, true);
  assert.deepEqual(failures, []);
  assert.equal(records.filter((r) => r.kind === "webPostSection").length, 0);
});

test("every layout failing still returns a well-formed result", async () => {
  const boom = async () => {
    throw new Error("down");
  };
  const { records, complete, failures } = await loadSourceRecords(
    deps({
      getArtists: boom,
      getPreviousArtists: boom,
      getClients: boom,
      getBookingRoster: boom,
      getTeam: boom,
      getNews: boom,
      getBookingCategories: boom,
      getWebPosts: boom,
    }),
  );
  assert.deepEqual(records, []);
  assert.equal(complete, false);
  assert.equal(failures.length, 8);
});

// ---------------------------------------------------------------------------
// Hashing and protected names
// ---------------------------------------------------------------------------

test("an unchanged read produces identical hashes", async () => {
  const a = await loadSourceRecords(deps());
  const b = await loadSourceRecords(deps());
  assert.deepEqual(
    a.records.map((r) => [refOf(r), r.hash]),
    b.records.map((r) => [refOf(r), r.hash]),
  );
});

test("the prompt version participates in the hash", async () => {
  const a = await loadSourceRecords(deps());
  const b = await loadSourceRecords({ ...deps(), promptVersion: "p2" });
  assert.notEqual(a.records[0].hash, b.records[0].hash);
  assert.equal(PROMPT_VERSION, "p1");
});

test("protected names are collected per entity", async () => {
  const { protectedNames } = await loadSourceRecords(deps());
  assert.deepEqual(protectedNames["artist:anjo"], ["Anjo"]);
  assert.deepEqual(protectedNames["client:kund"], ["Kund AB"]);
  assert.deepEqual(protectedNames["teamMember:mikael"], ["Mikael Ohlen"]);
  assert.deepEqual(protectedNames["bookingCategory:Artist"], ["Artist"]);
  assert.equal(
    protectedNames["webPostSection:Ninetone Group"],
    undefined,
    "a section has no entity name to protect",
  );
});

test("protectedNamesFor reads the right field per kind", () => {
  assert.deepEqual(protectedNamesFor("artist", { "Head Artist": "X" }), ["X"]);
  assert.deepEqual(protectedNamesFor("teamMember", { userNameCalc: "Y" }), ["Y"]);
  assert.deepEqual(protectedNamesFor("newsPost", { Title: "Z" }), [], "a headline is not a name");
  assert.deepEqual(protectedNamesFor("artist", { "Head Artist": "  " }), [], "blank is dropped");
});
