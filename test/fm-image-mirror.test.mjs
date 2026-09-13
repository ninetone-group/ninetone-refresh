/**
 * src/lib/fm-image-mirror.ts — the `?v=<epoch>` edge-cache buster for
 * worker-fm-proxy, plus the invariants the rewrite already had (slug
 * encoding, unmapped layouts untouched). Loads under plain Node because the
 * module's env read is defensive.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { mirrorRecordImages } from "../src/lib/fm-image-mirror.ts";

const PROXY = "https://ninetone-fm-image-proxy.ninetone.workers.dev";
const STREAM = (name) => `https://files.ninetone.com/Streaming_SSL/MainDB/${name}?RCType=EmbeddedRCFileProcessor`;

function artistRows() {
  return [
    { SLUG: "safe", artistPicture_big: STREAM("a.jpg"), artistPicture_small: STREAM("b.jpg"), bio: "x" },
    { SLUG: "två ord/ö", artistPicture_big: STREAM("c.jpg") },
  ];
}

test("with a version every rewritten URL ends in ?v=<version>", async () => {
  const rows = await mirrorRecordImages(artistRows(), { layout: "API_ARTIST", version: "42" });
  assert.equal(rows[0].artistPicture_big, `${PROXY}/artist/safe/big?v=42`);
  assert.equal(rows[0].artistPicture_small, `${PROXY}/artist/safe/small?v=42`);
  assert.equal(rows[1].artistPicture_big, `${PROXY}/artist/tv%C3%A5%20ord%2F%C3%B6/big?v=42`, "slug is still encoded");
  assert.equal(rows[0].bio, "x", "non-URL fields untouched");
});

test("without a version (static build, Node dev) the URL has no query at all", async () => {
  const rows = await mirrorRecordImages(artistRows(), { layout: "API_ARTIST" });
  assert.equal(rows[0].artistPicture_big, `${PROXY}/artist/safe/big`);
  assert.ok(!rows[0].artistPicture_small.includes("?"));
});

test("the version is URL-encoded — the proxy keys its edge cache on the exact `v` value", async () => {
  const rows = await mirrorRecordImages(artistRows(), { layout: "API_ARTIST", version: "a/b c" });
  assert.equal(rows[0].artistPicture_big, `${PROXY}/artist/safe/big?v=a%2Fb%20c`);
});

test("an unmapped layout leaves the FM URL alone, version or not", async () => {
  const before = artistRows();
  const rows = await mirrorRecordImages(structuredClone(before), { layout: "API_SOMETHING_ELSE", version: "42" });
  assert.deepEqual(rows, before);
});

test("portal rows carry the version too (booking categories → Green HeadArtist)", async () => {
  const records = [
    {
      fieldData: { tagBooking: "Artist" },
      portalData: {
        "Green HeadArtist": [
          { "Green HeadArtist::SLUG": "talang", "Green HeadArtist::artistPicture_big": STREAM("d.jpg") },
        ],
      },
    },
  ];
  await mirrorRecordImages(records, { layout: "API_BOOKING_TAG", version: "7" });
  assert.equal(
    records[0].portalData["Green HeadArtist"][0]["Green HeadArtist::artistPicture_big"],
    `${PROXY}/booking/talang/big?v=7`,
  );
});
