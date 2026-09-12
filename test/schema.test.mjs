import assert from "node:assert/strict";
import test from "node:test";

import {
  orgId,
  markdownToPlainText,
  descriptionWithBioFallback,
  organization,
  website,
  breadcrumbs,
  musicGroup,
  person,
  newsArticle,
  article,
  collectionPage,
  faqPage,
  contactPage,
  toEscapedJsonLd,
  fmDateToIso,
} from "../src/lib/schema.ts";

const ORIGIN = "https://ninetone.com";

test("toEscapedJsonLd: escapes '<' so a literal '</script>' in string data can't break out of the tag", () => {
  const serialized = toEscapedJsonLd({ description: "Click here</script><script>alert(1)</script>" });
  assert.ok(!serialized.includes("</script>"));
  assert.ok(serialized.includes("\\u003c/script>"));
  // Still valid JSON once unescaped by the browser's JS engine reading the
  // unicode escape back to "<" — round-trips to the original value.
  assert.equal(JSON.parse(serialized).description, "Click here</script><script>alert(1)</script>");
});

test("toEscapedJsonLd: handles an array of entries the same way a single object is handled", () => {
  const serialized = toEscapedJsonLd([{ a: 1 }, { b: "<x>" }]);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed, [{ a: 1 }, { b: "<x>" }]);
});

test("orgId: stable @id string derived from origin", () => {
  assert.equal(orgId(ORIGIN), "https://ninetone.com/#org");
});

test("markdownToPlainText: strips markdown/HTML and collapses whitespace", () => {
  const md = "**Bold**\n\nSome [link](https://example.com) text.\n\nMore.";
  const text = markdownToPlainText(md);
  assert.ok(!text.includes("*"));
  assert.ok(!text.includes("<"));
  assert.ok(text.includes("Bold"));
  assert.ok(text.includes("link"));
});

test("markdownToPlainText: returns empty string for null/undefined", () => {
  assert.equal(markdownToPlainText(null), "");
  assert.equal(markdownToPlainText(undefined), "");
});

test("markdownToPlainText: truncates to maxLength with an ellipsis, breaking on a word boundary", () => {
  const text = markdownToPlainText("word ".repeat(100), 50);
  assert.ok(text.length <= 51); // 50 + ellipsis char
  assert.ok(text.endsWith("…"));
});

// seo-phase-1b-brief.md P1 item 7: meta description fallback.
test("descriptionWithBioFallback: keeps the tagline when it's 70+ characters", () => {
  const tagline = "A".repeat(70);
  assert.equal(descriptionWithBioFallback(tagline, "some bio text"), tagline);
});

test("descriptionWithBioFallback: keeps a tagline longer than 70 characters unchanged", () => {
  const tagline = "This is a nicely long tagline that easily clears the seventy character floor.";
  assert.ok(tagline.length > 70);
  assert.equal(descriptionWithBioFallback(tagline, "irrelevant bio"), tagline);
});

test("descriptionWithBioFallback: falls back to bio when tagline is under 70 characters", () => {
  const shortTagline = "Short tagline.";
  assert.ok(shortTagline.length < 70);
  const bio = "word ".repeat(60).trim();
  const result = descriptionWithBioFallback(shortTagline, bio);
  assert.notEqual(result, shortTagline);
  assert.ok(result.length <= 151); // 150 + ellipsis char
  assert.ok(result.startsWith("word word"));
});

test("descriptionWithBioFallback: bio fallback is cut at a word boundary, not mid-word", () => {
  const bio = "word ".repeat(60).trim();
  const result = descriptionWithBioFallback("", bio);
  // markdownToPlainText's truncation strips a trailing partial token before
  // appending the ellipsis, so the character before "…" is never mid-word —
  // it's either a full "word" or the space that followed one.
  assert.ok(result.endsWith("word…") || result.endsWith(" …"));
});

test("descriptionWithBioFallback: falls back to bio when tagline is empty", () => {
  const bio = "A perfectly serviceable bio sentence.";
  assert.equal(descriptionWithBioFallback("", bio), bio);
});

test("descriptionWithBioFallback: empty tagline and empty bio yields empty string", () => {
  assert.equal(descriptionWithBioFallback("", ""), "");
  assert.equal(descriptionWithBioFallback(null, null), "");
});

test("organization: has the correct @type, @id, and always-present sameAs entries", () => {
  const org = organization(ORIGIN);
  assert.equal(org["@type"], "Organization");
  assert.equal(org["@id"], "https://ninetone.com/#org");
  assert.equal(org.name, "Ninetone Group");
  assert.equal(org.url, ORIGIN);
  // Organization.logo is the SQUARE wordmark, not the 1.91:1 social card —
  // Google's logo guidance expects the logo itself, and og-default.png would
  // be cropped in a knowledge panel (seo-phase-1b P1 item 10).
  assert.equal(org.logo["@type"], "ImageObject");
  assert.equal(org.logo.url, "https://ninetone.com/logo-square.png");
  assert.equal(org.logo.width, 512);
  assert.equal(org.logo.height, 512);
  assert.deepEqual(org.sameAs, [
    "https://www.wikidata.org/wiki/Q7038555",
    "https://en.wikipedia.org/wiki/Ninetone_Records",
    "https://sv.wikipedia.org/wiki/Ninetone_Records",
    "https://www.linkedin.com/company/ninetone",
    "https://www.facebook.com/ninetone",
    "https://www.youtube.com/c/Ninetone",
    "https://soundcloud.com/ninetonegroup",
  ]);
});

test("organization: sameAs includes BOTH Wikipedia language editions (en and sv both exist — verified against MediaWiki/Wikidata)", () => {
  const org = organization(ORIGIN);
  assert.ok(org.sameAs.includes("https://en.wikipedia.org/wiki/Ninetone_Records"));
  assert.ok(org.sameAs.includes("https://sv.wikipedia.org/wiki/Ninetone_Records"));
});

test("organization: includes Instagram when passed, appended after the base list", () => {
  const org = organization(ORIGIN, { instagram: "https://www.instagram.com/ninetonemanagement/" });
  assert.ok(org.sameAs.includes("https://www.instagram.com/ninetonemanagement/"));
  assert.equal(org.sameAs.at(-1), "https://www.instagram.com/ninetonemanagement/");
});

test("organization: rejects a non-http(s) Instagram value rather than emitting it", () => {
  const org = organization(ORIGIN, { instagram: "not-a-url" });
  assert.ok(!org.sameAs.some((s) => s.includes("not-a-url")));
});

test("organization: two contactPoints — booking@ (sales) and office@ (customer service), both SE", () => {
  const org = organization(ORIGIN);
  assert.equal(org.contactPoint.length, 2);
  const booking = org.contactPoint.find((c) => c.email === "booking@ninetone.com");
  const office = org.contactPoint.find((c) => c.email === "office@ninetone.com");
  assert.ok(booking);
  assert.equal(booking.contactType, "sales");
  assert.equal(booking.areaServed, "SE");
  assert.ok(office);
  assert.equal(office.contactType, "customer service");
  assert.equal(office.areaServed, "SE");
});

test("organization: address is Sundsvall, SE with no street", () => {
  const org = organization(ORIGIN);
  assert.equal(org.address["@type"], "PostalAddress");
  assert.equal(org.address.addressLocality, "Sundsvall");
  assert.equal(org.address.addressCountry, "SE");
  assert.equal(org.address.streetAddress, undefined);
});

test("website: no SearchAction — /search-result is permanently noindexed, so a sitelinks searchbox target would be uncrawlable", () => {
  const site = website(ORIGIN);
  assert.equal(site["@type"], "WebSite");
  assert.equal(site.publisher["@id"], orgId(ORIGIN));
  assert.equal(site.potentialAction, undefined);
});

test("breadcrumbs: builds a positioned ItemList with absolute URLs", () => {
  const crumbs = breadcrumbs(ORIGIN, [
    { name: "Records", path: "/records" },
    { name: "Artists", path: "/records/artists" },
    { name: "Anjo", path: "/records/artists/anjo" },
  ]);
  assert.equal(crumbs["@type"], "BreadcrumbList");
  assert.equal(crumbs.itemListElement.length, 3);
  assert.equal(crumbs.itemListElement[0].position, 1);
  assert.equal(crumbs.itemListElement[0].item, "https://ninetone.com/records");
  assert.equal(crumbs.itemListElement[2].position, 3);
  assert.equal(crumbs.itemListElement[2].item, "https://ninetone.com/records/artists/anjo");
});

test("breadcrumbs: tolerates a path missing its leading slash", () => {
  const crumbs = breadcrumbs(ORIGIN, [{ name: "Records", path: "records" }]);
  assert.equal(crumbs.itemListElement[0].item, "https://ninetone.com/records");
});

test("musicGroup: builds MusicGroup with memberOf pointing at the org node", () => {
  const artist = musicGroup(ORIGIN, {
    slug: "anjo",
    name: "Anjo",
    description: "A Swedish artist.",
    image: "https://proxy.example/anjo.jpg",
    socials: {
      spotify: "https://open.spotify.com/artist/x",
      instagram: "https://instagram.com/anjo",
      apple: null,
    },
  });
  assert.equal(artist["@type"], "MusicGroup");
  assert.equal(artist["@id"], "https://ninetone.com/records/artists/anjo/#entity");
  assert.equal(artist.url, "https://ninetone.com/records/artists/anjo");
  assert.deepEqual(artist.memberOf, { "@id": orgId(ORIGIN) });
  assert.deepEqual(artist.sameAs, ["https://open.spotify.com/artist/x", "https://instagram.com/anjo"]);
});

test("musicGroup: omits sameAs/image/description when none are provided", () => {
  const artist = musicGroup(ORIGIN, { slug: "x", name: "X" });
  assert.equal(artist.sameAs, undefined);
  assert.equal(artist.image, undefined);
  assert.equal(artist.description, undefined);
});

test("musicGroup: filters out non-http(s) social values via externalUrl()", () => {
  const artist = musicGroup(ORIGIN, {
    slug: "x",
    name: "X",
    socials: { spotify: "mailto:not-a-social@example.com", instagram: "https://instagram.com/x" },
  });
  assert.deepEqual(artist.sameAs, ["https://instagram.com/x"]);
});

test("musicGroup: includes album array only when albums are passed (releases already in page scope)", () => {
  const withAlbums = musicGroup(ORIGIN, {
    slug: "anjo",
    name: "Anjo",
    albums: [{ name: "Single One", datePublished: "2024-05-17", image: "https://x/cover.jpg", url: "https://x/link" }],
  });
  assert.equal(withAlbums.album.length, 1);
  assert.equal(withAlbums.album[0]["@type"], "MusicAlbum");
  assert.equal(withAlbums.album[0].name, "Single One");
  assert.equal(withAlbums.album[0].datePublished, "2024-05-17");

  const withoutAlbums = musicGroup(ORIGIN, { slug: "anjo", name: "Anjo" });
  assert.equal(withoutAlbums.album, undefined);
});

test("musicGroup: an album with no datePublished omits that field rather than faking one", () => {
  const artist = musicGroup(ORIGIN, {
    slug: "anjo",
    name: "Anjo",
    albums: [{ name: "Undated" }],
  });
  assert.equal(artist.album[0].datePublished, undefined);
});

test("musicGroup: defaults to /records/artists/{slug} when no path override is given (active roster)", () => {
  const artist = musicGroup(ORIGIN, { slug: "anjo", name: "Anjo" });
  assert.equal(artist.url, "https://ninetone.com/records/artists/anjo");
  assert.equal(artist["@id"], "https://ninetone.com/records/artists/anjo/#entity");
});

test("musicGroup: an explicit path overrides the default — fixes the previous-artist 404 (url must match where the page actually lives)", () => {
  const artist = musicGroup(ORIGIN, {
    slug: "anjo",
    name: "Anjo",
    path: "records/artists/previous/single/anjo",
  });
  assert.equal(artist.url, "https://ninetone.com/records/artists/previous/single/anjo");
  assert.equal(artist["@id"], "https://ninetone.com/records/artists/previous/single/anjo/#entity");
});

test("musicGroup: path override tolerates a missing leading slash", () => {
  const artist = musicGroup(ORIGIN, { slug: "x", name: "X", path: "/records/artists/previous/single/x" });
  assert.equal(artist.url, "https://ninetone.com/records/artists/previous/single/x");
});

test("person: management client — Person with sameAs, no jobTitle, no offers", () => {
  const p = person(ORIGIN, "A Client", {
    role: "client",
    path: "management/clients/a-client",
    socials: { instagram: "https://instagram.com/aclient" },
  });
  assert.equal(p["@type"], "Person");
  assert.equal(p["@id"], "https://ninetone.com/management/clients/a-client/#entity");
  assert.equal(p.url, "https://ninetone.com/management/clients/a-client");
  assert.deepEqual(p.sameAs, ["https://instagram.com/aclient"]);
  assert.equal(p.jobTitle, undefined);
  assert.equal(p.offers, undefined);
});

test("person: team member — Person + jobTitle + worksFor pointing at org", () => {
  const p = person(ORIGIN, "Jane Doe", {
    role: "team",
    path: "team/jane-doe",
    jobTitle: "Head of A&R",
    worksFor: true,
  });
  assert.equal(p.jobTitle, "Head of A&R");
  assert.deepEqual(p.worksFor, { "@id": orgId(ORIGIN) });
});

test("person: team member without worksFor:true omits the field", () => {
  const p = person(ORIGIN, "Jane Doe", { role: "team", path: "team/jane-doe" });
  assert.equal(p.worksFor, undefined);
});

test("person: Nation talent — Person + offers.InStock + booking contact URL + additionalType from categories", () => {
  const p = person(ORIGIN, "DJ Someone", {
    role: "nation",
    path: "ninetone-nation/dj-someone",
    bookingCategories: ["Artist", "Konferencier"],
  });
  assert.equal(p.offers["@type"], "Offer");
  assert.equal(p.offers.availability, "https://schema.org/InStock");
  assert.equal(p.offers.url, "https://ninetone.com/ninetone-nation/contact-ninetone-nation");
  assert.deepEqual(p.additionalType, ["Artist", "Konferencier"]);
});

test("person: Nation talent with no booking categories omits additionalType but keeps offers", () => {
  const p = person(ORIGIN, "DJ Someone", { role: "nation", path: "ninetone-nation/dj-someone" });
  assert.ok(p.offers);
  assert.equal(p.additionalType, undefined);
});

test("newsArticle: dateModified falls back to datePublished when absent", () => {
  const article = newsArticle(ORIGIN, {
    slug: "some-post",
    headline: "Some Headline",
    datePublished: "2026-01-01",
  });
  assert.equal(article.dateModified, "2026-01-01");
  assert.equal(article["@id"], "https://ninetone.com/news/some-post/#article");
  assert.equal(article.mainEntityOfPage, "https://ninetone.com/news/some-post");
  // publisher is the full node (inline name/logo for Google's article
  // validator) but still carries the org @id — see publisherNode().
  assert.equal(article.publisher["@id"], orgId(ORIGIN));
});

test("newsArticle: explicit dateModified is preserved, not overwritten", () => {
  const article = newsArticle(ORIGIN, {
    slug: "some-post",
    headline: "Some Headline",
    datePublished: "2026-01-01",
    dateModified: "2026-01-05",
  });
  assert.equal(article.dateModified, "2026-01-05");
});

// ---------------------------------------------------------------------------
// article (Section 7 — guides route: generic Article, not NewsArticle)
// ---------------------------------------------------------------------------

test("article: builds an Article node keyed on the caller-supplied path, not a hardcoded /news/ shape", () => {
  const a = article(ORIGIN, {
    path: "/guider/hur-man-bokar",
    headline: "Hur man bokar",
    datePublished: "2026-01-05",
    image: "https://x/cover.jpg",
    articleBody: "Plain text body.",
  });
  assert.equal(a["@type"], "Article");
  assert.equal(a["@id"], "https://ninetone.com/guider/hur-man-bokar/#article");
  assert.equal(a.mainEntityOfPage, "https://ninetone.com/guider/hur-man-bokar");
  assert.equal(a.headline, "Hur man bokar");
  assert.equal(a.datePublished, "2026-01-05");
  assert.equal(a.dateModified, "2026-01-05");
  assert.equal(a.image, "https://x/cover.jpg");
  assert.equal(a.articleBody, "Plain text body.");
  assert.equal(a.publisher["@id"], orgId(ORIGIN));
});

test("article: tolerates a path missing its leading slash", () => {
  const a = article(ORIGIN, { path: "guider/x", headline: "X" });
  assert.equal(a.mainEntityOfPage, "https://ninetone.com/guider/x");
});

test("article: explicit dateModified is preserved, not overwritten by datePublished", () => {
  const a = article(ORIGIN, {
    path: "/guider/x",
    headline: "X",
    datePublished: "2026-01-01",
    dateModified: "2026-01-10",
  });
  assert.equal(a.dateModified, "2026-01-10");
});

test("article: omits datePublished/dateModified entirely rather than fabricating a date when neither is known", () => {
  const a = article(ORIGIN, { path: "/guider/x", headline: "X" });
  assert.equal(a.datePublished, undefined);
  assert.equal(a.dateModified, undefined);
});

test("article: omits image/articleBody when not provided", () => {
  const a = article(ORIGIN, { path: "/guider/x", headline: "X", datePublished: "2026-01-01" });
  assert.equal(a.image, undefined);
  assert.equal(a.articleBody, undefined);
});

test("collectionPage: CollectionPage + ItemList with the right numberOfItems", () => {
  const cp = collectionPage(ORIGIN, {
    name: "Booking",
    path: "/ninetone-nation/booking",
    items: [
      { name: "Talent A", path: "/ninetone-nation/a" },
      { name: "Talent B", path: "/ninetone-nation/b" },
    ],
  });
  assert.equal(cp["@type"], "CollectionPage");
  assert.equal(cp.mainEntity["@type"], "ItemList");
  assert.equal(cp.mainEntity.numberOfItems, 2);
  assert.equal(cp.mainEntity.itemListElement[1].url, "https://ninetone.com/ninetone-nation/b");
});

test("faqPage: maps {q, a} pairs to Question/Answer nodes", () => {
  const faq = faqPage([{ q: "What is this?", a: "An answer." }]);
  assert.equal(faq["@type"], "FAQPage");
  assert.equal(faq.mainEntity.length, 1);
  assert.equal(faq.mainEntity[0]["@type"], "Question");
  assert.equal(faq.mainEntity[0].name, "What is this?");
  assert.equal(faq.mainEntity[0].acceptedAnswer["@type"], "Answer");
  assert.equal(faq.mainEntity[0].acceptedAnswer.text, "An answer.");
});

test("contactPage: ContactPage node pointing back at the org", () => {
  const cp = contactPage(ORIGIN, "/records/contact-records");
  assert.equal(cp["@type"], "ContactPage");
  assert.equal(cp.url, "https://ninetone.com/records/contact-records");
  assert.deepEqual(cp.about, { "@id": orgId(ORIGIN) });
});

test("contactPage: tolerates a path missing its leading slash", () => {
  const cp = contactPage(ORIGIN, "records/contact-records");
  assert.equal(cp.url, "https://ninetone.com/records/contact-records");
});

// fmDateToIso() was previously duplicated verbatim in three page files
// (records/artists/[slug].astro, previous/single/[slug].astro, news/[slug].astro)
// — centralized here so there's one implementation and one set of tests.
test("fmDateToIso: converts FM's MM/DD/YYYY to ISO-8601, zero-padded", () => {
  assert.equal(fmDateToIso("8/2/2024"), "2024-08-02");
  assert.equal(fmDateToIso("12/25/2023"), "2023-12-25");
});

test("fmDateToIso: returns undefined for an unparseable value rather than guessing", () => {
  assert.equal(fmDateToIso("not-a-date"), undefined);
  assert.equal(fmDateToIso("2024-08-02"), undefined); // already-ISO input is not MM/DD/YYYY
  assert.equal(fmDateToIso(""), undefined);
  assert.equal(fmDateToIso(null), undefined);
  assert.equal(fmDateToIso(undefined), undefined);
});

// --- publisher node + author (Google article validator findings) ------------
test("newsArticle publisher carries name and logo inline, not just @id", () => {
  const n = newsArticle(ORIGIN, { slug: "s", headline: "H", datePublished: "2024-01-01" });
  const pub = n.publisher;
  assert.equal(pub["@id"], `${ORIGIN}/#org`, "still linked to the org node");
  assert.equal(pub["@type"], "Organization");
  assert.equal(pub.name, "Ninetone Group");
  assert.equal(pub.logo["@type"], "ImageObject");
  assert.ok(String(pub.logo.url).startsWith("http"), "logo url is absolute");
});

test("newsArticle emits author when present and omits it when blank", () => {
  const withAuthor = newsArticle(ORIGIN, {
    slug: "s", headline: "H", datePublished: "2024-01-01", author: "Anna Andersson",
  });
  assert.deepEqual(withAuthor.author, { "@type": "Person", name: "Anna Andersson" });

  for (const blank of [undefined, ""]) {
    const n = newsArticle(ORIGIN, { slug: "s", headline: "H", datePublished: "2024-01-01", author: blank });
    assert.ok(!("author" in n), `author omitted for ${JSON.stringify(blank)}`);
  }
});

test("article() uses the same inline publisher and optional author", () => {
  const a = article(ORIGIN, { path: "/guider/g", headline: "G", author: "Team" });
  assert.equal(a.publisher.name, "Ninetone Group");
  assert.equal(a.publisher["@id"], `${ORIGIN}/#org`);
  assert.deepEqual(a.author, { "@type": "Person", name: "Team" });
  assert.ok(!("author" in article(ORIGIN, { path: "/guider/g", headline: "G" })));
});
