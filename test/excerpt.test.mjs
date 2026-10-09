import assert from "node:assert/strict";
import test from "node:test";

import { newsExcerpt } from "../src/lib/excerpt.ts";

// Every fixture is a real `shortMessage` / `Message` pair from API_NEWS as it
// rendered on /news on 2026-10-09 (FM line breaks are bare "\r").

test("newsExcerpt: a plain excerpt is returned untouched (its translation cache key must not move)", () => {
  const short = "Hole in one växer explosionsartat på TikTok.";
  assert.equal(newsExcerpt(short, `${short} Mer text följer här.`), short);
});

test("newsExcerpt: an excerpt cut off inside a link target is extended to the end of the sentence, as text", () => {
  const short = "Matkreatören Evelina Collin Reuterfors och [Jämtlands Bryggeri](https://jamtlandsbryggeri.";
  const message = `${short}se/) i samarbete – lanserar signaturöl under våren.\r\rNästa stycke.`;
  assert.equal(
    newsExcerpt(short, message),
    "Matkreatören Evelina Collin Reuterfors och Jämtlands Bryggeri i samarbete – lanserar signaturöl under våren.",
  );
});

// Added by the /ship coverage audit (2026-10-09).
// Value: protects=newsExcerpt completes a link cut mid-URL when the rest of its line has no full stop;
//   fails_when=the no-sentence-end case stops appending the remainder, which leaves "[label](https://www." on the card;
//   why_new=the one extension fixture above ends in a full stop, so this branch never ran;
//   seam=none
test("newsExcerpt: a cut inside a link on a line with no full stop takes the rest of that line and no further", () => {
  // Constructed, unlike the other fixtures: the shape FM's first-full-stop
  // rule gives a body that opens with a link-only line.
  const short = "[Läs om den östgötska finalen hos Sveriges Radio](https://www.";
  const message = `${short}sverigesradio.se/artikel/hans-och-valter-vinner)\r\rAgnes Matsdotter satt i juryn.`;
  assert.equal(newsExcerpt(short, message), "Läs om den östgötska finalen hos Sveriges Radio");
});

test("newsExcerpt: heading markers, emphasis and FM line breaks do not reach the page", () => {
  assert.equal(
    newsExcerpt("## Under helgen återförenas Kent för tre konserter i Stockholm.", ""),
    "Under helgen återförenas Kent för tre konserter i Stockholm.",
  );
  assert.equal(
    newsExcerpt("**Plats och datum:** Falun, 22 februari 2025\r\rMia Elfqvist gästade TV4:s *Efter fem*.", ""),
    "Plats och datum: Falun, 22 februari 2025 Mia Elfqvist gästade TV4:s Efter fem.",
  );
});

test("newsExcerpt: a single FM line break becomes a space, not glued words", () => {
  assert.equal(
    newsExcerpt("Ett nytt kapitel för matprofilen från Sveriges Mästerkock\rEvelina Collin Reuterfors har signerat **avtal**.", ""),
    "Ett nytt kapitel för matprofilen från Sveriges Mästerkock Evelina Collin Reuterfors har signerat avtal.",
  );
});

test("newsExcerpt: literal HTML tags are dropped, their text kept", () => {
  assert.equal(
    newsExcerpt('<h2>Karakou - Soldater</h2>\rKarakou släpper singeln "Soldater".', ""),
    'Karakou - Soldater Karakou släpper singeln "Soldater".',
  );
});

test("newsExcerpt: leading blank lines are trimmed and an empty excerpt stays empty", () => {
  assert.equal(newsExcerpt("\r\rTim Liljegren uppträder på Classic Kalaset.", "\r\rTim Liljegren uppträder på Classic Kalaset. Mer."), "Tim Liljegren uppträder på Classic Kalaset.");
  assert.equal(newsExcerpt("", "Hela brödtexten."), "");
  assert.equal(newsExcerpt(undefined, undefined), "");
});
