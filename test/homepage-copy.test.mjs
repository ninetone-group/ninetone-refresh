import assert from "node:assert/strict";
import test from "node:test";

import { parseHomepageCopy } from "../src/lib/homepage-copy.ts";

// Blocks as getWebPosts() hands them over: FM line breaks are bare "\r", and
// the texts are the ones Patrik entered under category "Ninetone Group" on
// 2026-10-09 (shortened). recordId is FM's portal-row id.
const block = (recordId, subject, message) => ({ recordId, subject, message, ytLinks: [] });

const SECTION = {
  category: "Ninetone Group",
  title: "Välkommen till NINETONE Group",
  blocks: [
    block("1", "Management", "### *Backoffice för offentliga personer*\r\rVi arbetar nära kreatörer och offentliga personer."),
    block("2", "Nation", "### *Talang uppmärksamhet och Live-ögonblick*\r\rVi kopplar samman artister med scener."),
    block("3", "Vi kopplar samman det människor behöver med det de bryr sig om", "Ninetone är länken mellan behov, erbjudanden och publik.\r\r*Vi arbetar där kultur och mänskligt beteende möts.*"),
    block("4", "Inte en label. Inte en byrå. Inte ett traditionellt management.", "## *Ninetone är ett kommunikations- och utvecklingshus.*\r\rMen uppgiften är nästan alltid densamma:\rAtt förstå ett behov."),
    block("5", "Records", "### *Från en idé ut i universum*\r\rVi hjälper artister att förvandla musik till något större."),
    block(
      "55",
      "Vi bygger bron",
      "## *Varje uppdrag börjar med samma fråga: vad behöver kopplas ihop?*\r\rSport · Idrottsklubb\r\r## GIF Sundsvall\r\rAtt förstå klubbens behov av publik.\r\rOrganisation\r\r## Företagarna\r\rAtt tydliggöra värdet i deras tjänster.\r\r## *Olika världar. Samma kärna. Behov. Erbjudande. Människa.*",
    ),
    block("56", "Vad som händer.", "Projekt, releaser, berättelser och människor vi arbetar med just nu."),
    block("57", "Människor, projekt och offentlig uppmärksamhet.", "Här finns artister, kreatörer och profiler."),
    block("58", "Berättelser från skärningspunkten.", "Nyheter från musik, management och publika projekt."),
    block("59", "Ninetone Group", "Ninetone Group är ett svenskt utvecklingshus.\r\rVi är inte bara ett musikbolag.\r\r### *Vi är länken mellan behovet och människorna.*"),
    block("60", "Merchandise, minnen.", "Kläder och saker från Ninetone-världen."),
  ],
};

test("parseHomepageCopy: no section, or an empty one, fills nothing — the page keeps its built-in copy", () => {
  assert.deepEqual(parseHomepageCopy(null), { cards: {} });
  assert.deepEqual(parseHomepageCopy({ category: "Ninetone Group", title: "", blocks: [] }), { cards: {} });
});

test("parseHomepageCopy: hero and positioning are told apart by row id, and their lead line is pulled out of the body", () => {
  const copy = parseHomepageCopy(SECTION);
  assert.deepEqual(copy.hero, {
    heading: "Vi kopplar samman det människor behöver med det de bryr sig om",
    body: "Ninetone är länken mellan behov, erbjudanden och publik.",
    tagline: "Vi arbetar där kultur och mänskligt beteende möts.",
  });
  assert.deepEqual(copy.positioning, {
    heading: "Inte en label. Inte en byrå. Inte ett traditionellt management.",
    tagline: "Ninetone är ett kommunikations- och utvecklingshus.",
    // A single FM line break inside a paragraph is a space, not glued words.
    body: "Men uppgiften är nästan alltid densamma: Att förstå ett behov.",
  });
});

test("parseHomepageCopy: the three division cards are matched by subject", () => {
  const { cards } = parseHomepageCopy(SECTION);
  assert.deepEqual(cards.records, { tagline: "Från en idé ut i universum", blurb: "Vi hjälper artister att förvandla musik till något större." });
  assert.equal(cards.management.tagline, "Backoffice för offentliga personer");
  assert.equal(cards.nation.blurb, "Vi kopplar samman artister med scener.");
});

test("parseHomepageCopy: the bridge block becomes a lead, one case per plain heading, and a closing line with its accent", () => {
  assert.deepEqual(parseHomepageCopy(SECTION).bridge, {
    heading: "Vi bygger bron",
    tagline: "Varje uppdrag börjar med samma fråga: vad behöver kopplas ihop?",
    cases: [
      { kicker: "Sport · Idrottsklubb", heading: "GIF Sundsvall", body: "Att förstå klubbens behov av publik." },
      { kicker: "Organisation", heading: "Företagarna", body: "Att tydliggöra värdet i deras tjänster." },
    ],
    closing: "Olika världar. Samma kärna.",
    closingAccent: "Behov. Erbjudande. Människa.",
  });
});

test("parseHomepageCopy: a bridge case with no kicker keeps its body, and a closing line without an accent stays whole", () => {
  const copy = parseHomepageCopy({
    ...SECTION,
    blocks: [block("55", "Vi bygger bron", "## Ett\r\rFörsta texten.\r\r## Två\r\rAndra texten.\r\r## *Olika världar, samma kärna.*")],
  });
  assert.deepEqual(copy.bridge.cases, [
    { kicker: "", heading: "Ett", body: "Första texten." },
    { kicker: "", heading: "Två", body: "Andra texten." },
  ]);
  assert.equal(copy.bridge.tagline, "");
  assert.equal(copy.bridge.closing, "Olika världar, samma kärna.");
  assert.equal(copy.bridge.closingAccent, "");
});

test("parseHomepageCopy: about keeps its paragraphs apart and lifts the closing line; plain slots are heading plus text", () => {
  const copy = parseHomepageCopy(SECTION);
  assert.deepEqual(copy.about, {
    heading: "Ninetone Group",
    paragraphs: ["Ninetone Group är ett svenskt utvecklingshus.", "Vi är inte bara ett musikbolag."],
    closing: "Vi är länken mellan behovet och människorna.",
  });
  assert.deepEqual(copy.whatsOn, { heading: "Vad som händer.", body: "Projekt, releaser, berättelser och människor vi arbetar med just nu." });
  assert.deepEqual(copy.merch, { heading: "Merchandise, minnen.", body: "Kläder och saker från Ninetone-världen." });
  assert.equal(copy.roster.heading, "Människor, projekt och offentlig uppmärksamhet.");
  assert.equal(copy.news.heading, "Berättelser från skärningspunkten.");
});

test("parseHomepageCopy: an edited headline still lands in its slot; an unknown row and a missing one change nothing else", () => {
  const blocks = SECTION.blocks
    .filter((b) => b.recordId !== "60") // merch block deleted in FM
    .map((b) => (b.recordId === "56" ? { ...b, subject: "Det här händer nu" } : b))
    .concat(block("999", "En helt ny rubrik", "Text som ingen plats läser än."));
  const copy = parseHomepageCopy({ ...SECTION, blocks });
  assert.equal(copy.whatsOn.heading, "Det här händer nu");
  assert.equal(copy.merch, undefined);
  assert.equal(copy.hero.heading, SECTION.blocks[2].subject);
  assert.equal(JSON.stringify(copy).includes("En helt ny rubrik"), false);
});
