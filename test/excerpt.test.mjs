import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";

import { newsExcerpt, profileTeaser } from "../src/lib/excerpt.ts";

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

// --- profileTeaser -----------------------------------------------------------
// Office returns the whole biography in the "short" fields (2026-11-10). The
// fixture is Walter FM's, as the homepage tile showed it on /en/ that day.
const WALTER_FM =
  "Walter FM is the music project of songwriter and multi-instrumentalist Walter Metsärinne from Helsinki. " +
  "Here guitar-driven indie meets quieter folk tones, with influences from Kent, Smashing Pumpkins, Radiohead and Sufjan Stevens. " +
  "The music moves between melancholy and hope, with room for both powerful passages and more stripped-down moments. " +
  "After playing with various indie rock bands, Walter began his solo career in 2019 with The Walter Metsärinne EP.";

test("profileTeaser: a biography in the short field ends at the last full sentence that fits", () => {
  assert.equal(
    profileTeaser(WALTER_FM),
    "Walter FM is the music project of songwriter and multi-instrumentalist Walter Metsärinne from Helsinki.",
  );
  // Room for two sentences: both are kept, nothing is cut mid-sentence.
  assert.equal(
    profileTeaser(WALTER_FM, 240),
    "Walter FM is the music project of songwriter and multi-instrumentalist Walter Metsärinne from Helsinki. " +
      "Here guitar-driven indie meets quieter folk tones, with influences from Kent, Smashing Pumpkins, Radiohead and Sufjan Stevens.",
  );
});

test("profileTeaser: text that already fits is shown as written", () => {
  const short = "Karakou är Uppsalabandet som förenar svensk indiepop och rock med ärliga texter.";
  assert.equal(profileTeaser(short), short);
  assert.equal(profileTeaser("x".repeat(200)), "x".repeat(200));
  assert.equal(profileTeaser(""), "");
  assert.equal(profileTeaser(undefined), "");
});

test("profileTeaser: a first sentence longer than the limit is cut at a word, with an ellipsis", () => {
  const long =
    "Ninetone Records är stolta över att presentera en av Sveriges mest lovande artister inom modern country, " +
    "en låtskrivare och innehållsskapare från Falun som förenar dalacountry med en personlig närvaro i sociala medier, " +
    "och som på kort tid har byggt en trogen publik";
  const out = profileTeaser(long);
  assert.ok(out.endsWith("…"), out);
  assert.ok(out.length <= 201, String(out.length));
  assert.ok(long.startsWith(out.slice(0, -1)), "the teaser is a prefix of the text");
  assert.match(long.slice(out.length - 1), /^[\s,]/, "the cut is between words");
  assert.doesNotMatch(out, /[\s,]…$/, "no space or comma before the ellipsis");
});

test("profileTeaser: a short opening sentence is not used alone, and full stops inside names do not end a sentence", () => {
  // "Hej." would leave a 4-character tile; the word cut is used instead.
  const stub = `Hej. ${"ord ".repeat(80)}`;
  assert.ok(profileTeaser(stub).endsWith("…"));
  assert.ok(profileTeaser(stub).length > 150);
  // "J.O.X" and "bl.a. med" are not sentence ends.
  const dotted = `J.O.X har bl.a. med sina svenska melodier och sin elektroniska dansenergi nått en publik på över 3.5 miljoner lyssnare. ${"Mer text följer här. ".repeat(10)}`;
  assert.equal(
    profileTeaser(dotted, 130),
    "J.O.X har bl.a. med sina svenska melodier och sin elektroniska dansenergi nått en publik på över 3.5 miljoner lyssnare.",
  );
});

test("profileTeaser: line breaks in the field become spaces", () => {
  assert.equal(profileTeaser("Rad ett.\r\rRad två."), "Rad ett. Rad två.");
});

test("homepage: no profile 'short' field reaches a tile without profileTeaser", () => {
  // The two "of the week" tiles took the field as it came; when Office began
  // returning the full biography there, the tiles overflowed (2026-11-10).
  const source = fs.readFileSync(new URL("../src/pages/index.astro", import.meta.url), "utf8");
  const reads = source.split("\n").filter((line) => /PresentationShort/.test(line) && !/^\s*(\/\/|\*)/.test(line));
  assert.ok(reads.length >= 2, "the page still reads the short fields as a fallback");
  for (const line of reads) assert.match(line, /profileTeaser\(/, line.trim());
});
