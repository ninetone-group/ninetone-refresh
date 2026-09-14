import assert from "node:assert/strict";
import test from "node:test";

import { hasProfileImage } from "../src/lib/profile-image.ts";

const MBS = "[MBS] Invalid image reference: [MBS] Failed to read image.";

test("hasProfileImage: a proxy or FM streaming URL in either field counts", () => {
  assert.equal(hasProfileImage({ artistPicture_small: "https://ninetone-fm-image-proxy.ninetone.workers.dev/client/x/small", artistPicture_big: "" }), true);
  assert.equal(hasProfileImage({ artistPicture_small: "", artistPicture_big: "https://files.ninetone.com/Streaming_SSL/MainDB/abc.jpg?RCType=EmbeddedRCFileProcessor" }), true);
  assert.equal(hasProfileImage({ artistPicture_small: MBS, artistPicture_big: "https://files.ninetone.com/Streaming_SSL/MainDB/abc.jpg" }), true);
});

test("hasProfileImage: the FM plugin error string, blanks and missing fields do not", () => {
  // The exact shape seen on 20 former clients (2026-09-14): error in BOTH fields.
  assert.equal(hasProfileImage({ artistPicture_small: MBS, artistPicture_big: MBS }), false);
  assert.equal(hasProfileImage({ artistPicture_small: "", artistPicture_big: "" }), false);
  assert.equal(hasProfileImage({}), false);
  assert.equal(hasProfileImage({ artistPicture_small: "   ", artistPicture_big: null }), false);
  assert.equal(hasProfileImage({ artistPicture_small: "not a url", artistPicture_big: undefined }), false);
});
