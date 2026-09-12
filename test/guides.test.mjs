import assert from "node:assert/strict";
import test from "node:test";

import {
  slugifyTitle,
  guidesFromCategory,
  findGuideBySlug,
  parseFaqFromMarkdown,
} from "../src/lib/guides.ts";

// ---------------------------------------------------------------------------
// slugifyTitle
// ---------------------------------------------------------------------------

test("slugifyTitle: lowercases and hyphenates a plain ASCII title", () => {
  assert.equal(slugifyTitle("How to book an artist"), "how-to-book-an-artist");
});

test("slugifyTitle: strips Swedish diacritics rather than percent-encoding them", () => {
  assert.equal(slugifyTitle("Så bokar du en föreläsare"), "sa-bokar-du-en-forelasare");
});

test("slugifyTitle: collapses punctuation runs to a single hyphen and trims edges", () => {
  assert.equal(slugifyTitle("  What's the cost?! "), "what-s-the-cost");
});

// ---------------------------------------------------------------------------
// guidesFromCategory
// ---------------------------------------------------------------------------

function block(overrides = {}) {
  return { subject: "", message: "", ytLinks: [], ...overrides };
}

test("guidesFromCategory: returns [] for a null/undefined category (Guider category absent — the expected default)", () => {
  assert.deepEqual(guidesFromCategory(null), []);
  assert.deepEqual(guidesFromCategory(undefined), []);
});

test("guidesFromCategory: returns [] when the category exists but has zero usable blocks", () => {
  const category = { category: "Guider", title: "Guider", blocks: [] };
  assert.deepEqual(guidesFromCategory(category), []);
});

test("guidesFromCategory: maps each block to a slugged guide, preserving portal order", () => {
  const category = {
    category: "Guider",
    title: "Guider",
    blocks: [
      block({ subject: "First guide", message: "Body one.", date: "01/05/2026" }),
      block({ subject: "Second guide", message: "Body two.", image: "https://x/img.jpg" }),
    ],
  };
  const guides = guidesFromCategory(category);
  assert.equal(guides.length, 2);
  assert.equal(guides[0].slug, "first-guide");
  assert.equal(guides[0].title, "First guide");
  assert.equal(guides[0].message, "Body one.");
  assert.equal(guides[0].date, "01/05/2026");
  assert.equal(guides[1].slug, "second-guide");
  assert.equal(guides[1].image, "https://x/img.jpg");
});

test("guidesFromCategory: skips blocks with no usable subject rather than emitting a blank-slug guide", () => {
  const category = {
    category: "Guider",
    title: "Guider",
    blocks: [block({ subject: "", message: "orphan body" }), block({ subject: "Real guide", message: "ok" })],
  };
  const guides = guidesFromCategory(category);
  assert.equal(guides.length, 1);
  assert.equal(guides[0].slug, "real-guide");
});

test("guidesFromCategory: two titles that slugify identically get -2, -3... suffixes rather than colliding", () => {
  const category = {
    category: "Guider",
    title: "Guider",
    blocks: [
      block({ subject: "Booking guide", message: "first" }),
      block({ subject: "Booking guide", message: "second" }),
      block({ subject: "Booking guide!", message: "third" }), // same slug after normalization
    ],
  };
  const guides = guidesFromCategory(category);
  assert.deepEqual(
    guides.map((g) => g.slug),
    ["booking-guide", "booking-guide-2", "booking-guide-3"],
  );
});

// ---------------------------------------------------------------------------
// findGuideBySlug
// ---------------------------------------------------------------------------

test("findGuideBySlug: finds the matching guide by slug", () => {
  const category = {
    category: "Guider",
    title: "Guider",
    blocks: [block({ subject: "Alpha guide", message: "a" }), block({ subject: "Beta guide", message: "b" })],
  };
  const found = findGuideBySlug(category, "beta-guide");
  assert.ok(found);
  assert.equal(found.title, "Beta guide");
});

test("findGuideBySlug: returns null when nothing matches, or the category is absent", () => {
  const category = { category: "Guider", title: "Guider", blocks: [block({ subject: "Alpha guide" })] };
  assert.equal(findGuideBySlug(category, "nonexistent"), null);
  assert.equal(findGuideBySlug(null, "anything"), null);
});

// ---------------------------------------------------------------------------
// parseFaqFromMarkdown
// ---------------------------------------------------------------------------

test("parseFaqFromMarkdown: returns [] when there is no FAQ/Vanliga frågor section (the expected default)", () => {
  const md = "# A guide\n\nSome intro text.\n\n## Another section\n\nMore text.";
  assert.deepEqual(parseFaqFromMarkdown(md), []);
});

test("parseFaqFromMarkdown: returns [] for empty/null/undefined input", () => {
  assert.deepEqual(parseFaqFromMarkdown(""), []);
  assert.deepEqual(parseFaqFromMarkdown(null), []);
  assert.deepEqual(parseFaqFromMarkdown(undefined), []);
});

test("parseFaqFromMarkdown: parses '## Vanliga frågor' with H3 questions and following paragraphs", () => {
  const md = [
    "# En guide",
    "",
    "Intro text.",
    "",
    "## Vanliga frågor",
    "",
    "### Hur bokar jag?",
    "",
    "Du bokar genom att kontakta oss via formuläret.",
    "",
    "### Vad kostar det?",
    "",
    "Det beror på artist och datum.",
  ].join("\n");
  const items = parseFaqFromMarkdown(md);
  assert.equal(items.length, 2);
  assert.equal(items[0].q, "Hur bokar jag?");
  assert.equal(items[0].a, "Du bokar genom att kontakta oss via formuläret.");
  assert.equal(items[1].q, "Vad kostar det?");
  assert.equal(items[1].a, "Det beror på artist och datum.");
});

test("parseFaqFromMarkdown: also recognizes the English '## FAQ' heading, case-insensitively", () => {
  const md = ["## faq", "", "### Is this free?", "", "No, it is not."].join("\n");
  const items = parseFaqFromMarkdown(md);
  assert.equal(items.length, 1);
  assert.equal(items[0].q, "Is this free?");
  assert.equal(items[0].a, "No, it is not.");
});

test("parseFaqFromMarkdown: matches an ATX closing sequence on the H2 heading ('## FAQ ##' is valid CommonMark for 'FAQ')", () => {
  const md = ["## FAQ ##", "", "### Is this free? ###", "", "No, it is not."].join("\n");
  const items = parseFaqFromMarkdown(md);
  assert.equal(items.length, 1);
  assert.equal(items[0].q, "Is this free?");
  assert.equal(items[0].a, "No, it is not.");
});

test("parseFaqFromMarkdown: stops at the next H2, ignoring content after the FAQ section", () => {
  const md = [
    "## Vanliga frågor",
    "",
    "### Fråga ett",
    "",
    "Svar ett.",
    "",
    "## Nästa sektion",
    "",
    "### Detta ska inte tolkas",
    "",
    "Detta är inte en FAQ.",
  ].join("\n");
  const items = parseFaqFromMarkdown(md);
  assert.equal(items.length, 1);
  assert.equal(items[0].q, "Fråga ett");
  assert.ok(!items.some((i) => i.q.includes("Detta")));
});

test("parseFaqFromMarkdown: a question with no following paragraph text is dropped, not emitted with an empty answer", () => {
  const md = ["## FAQ", "", "### Orphan question", "", "### Real question", "", "Real answer."].join("\n");
  const items = parseFaqFromMarkdown(md);
  assert.equal(items.length, 1);
  assert.equal(items[0].q, "Real question");
});

test("parseFaqFromMarkdown: multi-line answer paragraph (soft-wrapped) is joined with spaces", () => {
  const md = ["## FAQ", "", "### En fråga", "", "Rad ett", "rad två", "rad tre."].join("\n");
  const items = parseFaqFromMarkdown(md);
  assert.equal(items.length, 1);
  assert.equal(items[0].a, "Rad ett rad två rad tre.");
});
