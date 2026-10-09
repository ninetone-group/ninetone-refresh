import assert from "node:assert/strict";
import test from "node:test";

import { handleAdmin } from "../src/lib/admin-api.ts";
import { issueAdminToken, verifyAdminToken } from "../src/lib/admin-auth.ts";
import { translate, translationKey } from "../src/lib/translate.ts";
import { LOCKS_KEY, peekLock, primeLocks, readLocks } from "../src/lib/translation-locks.ts";

const PASSWORD = "correct horse battery staple";
const NOW = 1_800_000_000_000;

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => {
      store.set(key, value);
    },
  };
}

function fakeEnv(kv, { allow = true } = {}) {
  return { CACHE_STATE: kv, PUBLISH_PASSWORD: PASSWORD, PUBLISH_RATE_LIMITER: { limit: async () => ({ success: allow }) } };
}

// One Swedish article (two paragraphs, one link) and a minimal homepage section.
const BODY = "Agnes satt i juryn när tävlingen avgjordes.\r\r[Läs mer hos Sveriges Radio](https://www.sverigesradio.se/artikel/finalen)";
const deps = {
  now: () => NOW,
  getNews: async () => [{ slug: "agnes", Title: "Agnes i juryn", shortMessage: "Agnes satt i juryn när tävlingen avgjordes.", Message: BODY }],
  getHomepageSection: async () => ({
    category: "Ninetone Group",
    title: "",
    blocks: [
      { recordId: "3", subject: "Vi kopplar samman det människor behöver med det de bryr sig om", message: "Ninetone är länken mellan behov och publik.", ytLinks: [] },
      { recordId: "777", subject: "Ett nytt block", message: "Som ingen plats läser än.", ytLinks: [] },
    ],
  }),
};

const call = (env, body) =>
  handleAdmin(new Request("https://www.ninetone.com/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, deps);

async function signedIn(env) {
  const res = await call(env, { action: "login", password: PASSWORD });
  return (await res.json()).token;
}

test("admin tokens: valid until they expire, and only for the password and the signing key that issued them", async () => {
  const kv = fakeKv();
  const { token, expires } = await issueAdminToken(kv, PASSWORD, NOW);
  assert.equal(await verifyAdminToken(token, kv, PASSWORD, NOW + 60_000), true);
  assert.equal(await verifyAdminToken(token, kv, PASSWORD, expires + 1), false);
  // Changing the password, or losing the signing key, ends the session.
  assert.equal(await verifyAdminToken(token, kv, "another password", NOW), false);
  assert.equal(await verifyAdminToken(token, fakeKv(), PASSWORD, NOW), false);
  // A token check never creates a signing key.
  const empty = fakeKv();
  assert.equal(await verifyAdminToken(token, empty, PASSWORD, NOW), false);
  assert.equal(empty.store.size, 0);
  // A forged far-future expiry with a made-up signature, and plain junk.
  assert.equal(await verifyAdminToken(`${NOW + 9e12}.${"0".repeat(64)}`, kv, PASSWORD, NOW), false);
  for (const junk of [undefined, "", "abc", `${expires}`, `${expires}.`]) assert.equal(await verifyAdminToken(junk, kv, PASSWORD, NOW), false);
});

test("admin: login needs the password and is rate limited; every other action needs a token", async () => {
  const kv = fakeKv();
  assert.equal((await call(fakeEnv(kv), { action: "login", password: "wrong" })).status, 401);
  assert.equal((await call(fakeEnv(kv, { allow: false }), { action: "login", password: PASSWORD })).status, 429);
  for (const action of ["blocks", "items", "review", "lock", "unlock", "health", "flush"]) {
    assert.equal((await call(fakeEnv(kv), { action, item: "homepage" })).status, 401, action);
    assert.equal((await call(fakeEnv(kv), { action, token: "1.2" })).status, 401, action);
  }
  assert.equal(kv.store.size, 0);
});

test("admin: unavailable off Cloudflare, and cross-site posts are refused", async () => {
  assert.equal((await call(null, { action: "login", password: PASSWORD })).status, 503);
  const crossSite = new Request("https://www.ninetone.com/api/admin", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
  assert.equal((await handleAdmin(crossSite, fakeEnv(fakeKv()), deps)).status, 403);
});

test("admin blocks: shows which slot each FM block fills, and flags the one nothing reads", async () => {
  const env = fakeEnv(fakeKv());
  const res = await (await call(env, { action: "blocks", token: await signedIn(env) })).json();
  assert.deepEqual(res.blocks, [
    { recordId: "3", subject: "Vi kopplar samman det människor behöver med det de bryr sig om", fills: "Hero (top of the page)" },
    { recordId: "777", subject: "Ett nytt block", fills: null },
  ]);
  assert.equal(res.unfilled.includes("Positioning band"), true);
  assert.equal(res.unfilled.includes("Hero (top of the page)"), false);
});

test("admin review + lock: a locked English wording is what translate() then serves, and unlock restores the machine text", async () => {
  const kv = fakeKv({ [await translationKey("Agnes i juryn", "en", "fast")]: "Agnes on the jury (machine)" });
  const env = fakeEnv(kv);
  const token = await signedIn(env);

  const before = await (await call(env, { action: "review", token, item: "news:agnes" })).json();
  const title = before.strings.find((s) => s.id === "title");
  assert.equal(title.en.text, "Agnes on the jury (machine)");
  assert.equal(title.en.origin, "cached");
  assert.equal(title.en.lockable, true);
  // The excerpt is Swedish prose: the Swedish site shows it as written and it cannot be "locked" there.
  const excerpt = before.strings.find((s) => s.id === "excerpt");
  assert.equal(excerpt.sv.origin, "same-language");
  assert.equal(excerpt.sv.lockable, false);
  assert.equal(excerpt.en.origin, "miss");

  assert.equal((await call(env, { action: "lock", token, item: "news:agnes", string: "title", lang: "en", text: "Agnes joins the jury" })).status, 200);
  const served = await translate({ text: "Agnes i juryn", target: "en", tier: "fast", kind: "title", kv });
  assert.deepEqual([served.text, served.origin], ["Agnes joins the jury", "locked"]);
  const after = await (await call(env, { action: "review", token, item: "news:agnes" })).json();
  assert.equal(after.strings.find((s) => s.id === "title").en.locked, true);

  assert.equal((await call(env, { action: "unlock", token, item: "news:agnes", string: "title", lang: "en" })).status, 200);
  assert.equal((await translate({ text: "Agnes i juryn", target: "en", tier: "fast", kind: "title", kv })).text, "Agnes on the jury (machine)");
});

test("admin lock: refuses a wording that drops a paragraph, changes a link, is empty, or targets the source language", async () => {
  const kv = fakeKv();
  const env = fakeEnv(kv);
  const token = await signedIn(env);
  const lock = (extra) => call(env, { action: "lock", token, item: "news:agnes", lang: "en", ...extra });

  assert.equal((await lock({ string: "body", text: "Agnes sat on the jury. [Read more](https://www.sverigesradio.se/artikel/finalen)" })).status, 422);
  assert.equal((await lock({ string: "body", text: "Agnes sat on the jury.\n\n[Read more](https://evil.example/phish)" })).status, 422);
  assert.equal((await lock({ string: "title", text: "   " })).status, 422);
  assert.equal((await lock({ string: "excerpt", lang: "sv", text: "Något annat." })).status, 409);
  assert.equal((await lock({ string: "nope", text: "x" })).status, 404);

  // --- Rows added by the /ship test coverage audit, 2026-10-09 (pass 1) ---
  // Value: protects=a lock is refused when it adds a link to plain text, is far too long, names an unknown item or language, or targets a code-pinned line;
  //   fails_when=the structure check is narrowed to markdown strings, or the length, item, language or overrides.json guard leaves the lock action;
  //   why_new=the rows above cover only a dropped paragraph, a changed link, an empty wording, the source language and an unknown string id;
  //   seam=none
  assert.equal((await lock({ string: "title", text: "Agnes joins the jury https://evil.example/win" })).status, 422);
  assert.equal((await lock({ string: "title", text: "A".repeat(401) })).status, 422);
  assert.equal((await lock({ string: "title", lang: "de", text: "Agnes in der Jury" })).status, 404);
  assert.equal((await lock({ item: "news:missing", string: "title", text: "x" })).status, 404);
  // "Kontakta oss" is pinned in src/i18n/overrides.json: review reports it as decided in code and offers no lock.
  const pinnedDeps = { ...deps, getNews: async () => [{ slug: "kontakt", Title: "Kontakta oss" }] };
  const pinned = (body) => handleAdmin(new Request("https://www.ninetone.com/api/admin", { method: "POST", body: JSON.stringify({ token, item: "news:kontakt", ...body }) }), env, pinnedDeps);
  const [pinnedTitle] = (await (await pinned({ action: "review" })).json()).strings;
  assert.deepEqual([pinnedTitle.en.text, pinnedTitle.en.origin, pinnedTitle.en.lockable], ["Get in touch", "override", false]);
  assert.equal((await pinned({ action: "lock", string: "title", lang: "en", text: "Contact us" })).status, 409);
  // --- end of audit rows ---

  assert.equal(kv.store.has(LOCKS_KEY), false);

  // The faithful version is accepted.
  assert.equal((await lock({ string: "body", text: "Agnes sat on the jury when the contest was decided.\n\n[Read more at Sveriges Radio](https://www.sverigesradio.se/artikel/finalen)" })).status, 200);
});

test("admin review: homepage copy is shown as written on the Swedish site, even a short headline the detector cannot place", async () => {
  const short = { ...deps, getHomepageSection: async () => ({ category: "Ninetone Group", title: "", blocks: [{ recordId: "60", subject: "Merchandise, minnen.", message: "Kläder och saker.", ytLinks: [] }] }) };
  const env = fakeEnv(fakeKv());
  const post = (body) => handleAdmin(new Request("https://www.ninetone.com/api/admin", { method: "POST", body: JSON.stringify(body) }), env, short);
  const { token } = await (await post({ action: "login", password: PASSWORD })).json();
  const { strings } = await (await post({ action: "review", token, item: "homepage" })).json();
  const heading = strings.find((s) => s.id === "merch.heading");
  assert.deepEqual([heading.sv.origin, heading.sv.lockable], ["same-language", false]);
  assert.deepEqual([heading.en.origin, heading.en.lockable], ["miss", true]);
  assert.equal((await post({ action: "lock", token, item: "homepage", string: "merch.heading", lang: "sv", text: "x" })).status, 409);
});

test("locks: translate() reads them from memory only — an unprimed isolate serves the cache, a primed one serves the lock", async () => {
  const key = await translationKey("Boka artist", "en", "fast");
  const hash = key.split(":").pop();
  const kv = fakeKv({ [key]: "Book artist", [LOCKS_KEY]: JSON.stringify({ [`en:${hash}`]: { text: "Book an artist", source: "Boka artist", at: "" } }) });
  let lockReads = 0;
  const counting = { ...kv, get: async (k, o) => ((lockReads += k === LOCKS_KEY ? 1 : 0), kv.get(k, o)) };

  assert.equal(peekLock(counting, "en", hash), null);
  assert.equal((await translate({ text: "Boka artist", target: "en", tier: "fast", kv: counting })).text, "Book artist");
  assert.equal(lockReads, 0);

  await primeLocks(counting);
  await primeLocks(counting); // fresh copy: no second read
  assert.equal(lockReads, 1);
  assert.equal((await translate({ text: "Boka artist", target: "en", tier: "fast", kv: counting })).text, "Book an artist");
  assert.equal(lockReads, 1);
});

test("locks: a corrupt or failing lock read leaves rendering untouched", async () => {
  const corrupt = fakeKv({ [LOCKS_KEY]: "not json" });
  assert.deepEqual(await readLocks(corrupt), {});
  const failing = { get: async () => { throw new Error("kv down"); }, put: async () => {} };
  await assert.doesNotReject(() => primeLocks(failing));
  assert.equal(peekLock(failing, "en", "abc"), null);
});

test("admin health: counts both languages and lists what is waiting or damaged", async () => {
  const collapsed = "Agnes sat on the jury. Read more at Sveriges Radio";
  const kv = fakeKv({ [await translationKey(BODY, "en", "fast")]: collapsed });
  const env = fakeEnv(kv);
  const { report } = await (await call(env, { action: "health", token: await signedIn(env) })).json();
  assert.equal(report.items, 2);
  assert.equal(report.damaged, 1);
  assert.deepEqual(report.problems[0], { item: "news:agnes", itemLabel: "Agnes i juryn", path: "/news/agnes", string: "Article text", lang: "en", issue: "damaged" });
  // Swedish prose on the Swedish site is the source, never "waiting".
  assert.equal(report.byLang.sv["same-language"] >= 3, true);
  assert.equal(report.problems.some((p) => p.lang === "en" && p.issue === "waiting" && p.string === "Excerpt"), true);
});

test("admin flush: bumps the cache version, like Publish", async () => {
  const kv = fakeKv();
  const env = fakeEnv(kv);
  assert.equal((await call(env, { action: "flush", token: await signedIn(env) })).status, 200);
  assert.equal(kv.store.get("cache-version"), NOW.toString(36));
});

// ---------------------------------------------------------------------------
// Added by the /ship test coverage audit, 2026-10-09 (pass 1). Three tests,
// each under its own value card.
// ---------------------------------------------------------------------------

// Value: protects=locking or unlocking one wording never erases another lock, including one a different isolate stored after this isolate loaded the map;
//   fails_when=writeLock() writes without first reading the stored map fresh, or stores only the entry it was handed;
//   why_new=the tests above hold one lock at a time and write it from the isolate that reads it, so replacing the whole map would still pass;
//   seam=none
test("admin lock: a second lock, and one another isolate stored meanwhile, survive a lock and an unlock", async () => {
  const TITLE = "Agnes i juryn";
  const EXCERPT = "Agnes satt i juryn när tävlingen avgjordes.";
  const EXCERPT_EN = "Agnes sat on the jury when the contest was decided.";
  const kv = fakeKv();
  const env = fakeEnv(kv);
  const token = await signedIn(env);
  const act = (action, extra) => call(env, { action, token, item: "news:agnes", lang: "en", ...extra });
  const stored = () => JSON.parse(kv.store.get(LOCKS_KEY));
  const served = async (text, kind) => (await translate({ text, target: "en", tier: "fast", kind, kv })).text;

  assert.equal((await act("lock", { string: "title", text: "Agnes joins the jury" })).status, 200);
  // Another isolate locks a line of its own: it lands in KV, not in this isolate's seconds-old copy.
  const elsewhere = { text: "Kept from elsewhere", source: "En annan text", at: "2026-10-09T00:00:00.000Z" };
  kv.store.set(LOCKS_KEY, JSON.stringify({ ...stored(), "en:stored-elsewhere": elsewhere }));

  assert.equal((await act("lock", { string: "excerpt", text: EXCERPT_EN })).status, 200);
  assert.deepEqual(stored()["en:stored-elsewhere"], elsewhere);
  assert.equal(Object.keys(stored()).length, 3);
  assert.equal(await served(TITLE, "title"), "Agnes joins the jury");
  assert.equal(await served(EXCERPT, "plain"), EXCERPT_EN);

  // Removing one lock removes that one only.
  assert.equal((await act("unlock", { string: "title" })).status, 200);
  assert.equal(await served(TITLE, "title"), TITLE);
  assert.equal(await served(EXCERPT, "plain"), EXCERPT_EN);
  assert.deepEqual(stored()["en:stored-elsewhere"], elsewhere);
  assert.equal(Object.keys(stored()).length, 2);
});

// Value: protects=an isolate re-reads the lock map once its copy is over a minute old, and a lock read that hangs or throws is abandoned with the last map kept;
//   fails_when=the freshness window stops expiring, the read loses its timeout, or a slow or failed read empties the map every render relies on;
//   why_new=the tests above never move the clock and only fail a read on an isolate that holds no map yet;
//   seam=none
test("locks: a copy over a minute old is re-read, and a read that hangs or throws keeps the last map without holding the render", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const mapWith = (text) => JSON.stringify({ "en:abc": { text, source: "Källa", at: "" } });
  const kv = fakeKv({ [LOCKS_KEY]: mapWith("First wording") });
  let mode = "ok";
  let reads = 0;
  const binding = {
    ...kv,
    get: (key, opts) => {
      reads += 1;
      if (mode === "hang") return new Promise(() => {});
      if (mode === "throw") return Promise.reject(new Error("kv down"));
      return kv.get(key, opts);
    },
  };

  await primeLocks(binding);
  assert.deepEqual([reads, peekLock(binding, "en", "abc")], [1, "First wording"]);

  // Another isolate changes the wording. Inside the minute this one serves its copy and reads nothing.
  kv.store.set(LOCKS_KEY, mapWith("Second wording"));
  t.mock.timers.tick(50_000);
  await primeLocks(binding);
  assert.deepEqual([reads, peekLock(binding, "en", "abc")], [1, "First wording"]);

  // Past the minute the next render reads again and the change arrives.
  t.mock.timers.tick(20_000);
  await primeLocks(binding);
  assert.deepEqual([reads, peekLock(binding, "en", "abc")], [2, "Second wording"]);

  // A read that never answers: priming waits for its own short timer, not for KV, and the wording stays.
  mode = "hang";
  t.mock.timers.tick(70_000);
  let settled = false;
  const primed = primeLocks(binding).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "still inside the read timeout");
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, "a hung lock read must be abandoned within seconds");
  await primed;
  assert.deepEqual([reads, peekLock(binding, "en", "abc")], [3, "Second wording"]);

  // A read that throws: same outcome.
  mode = "throw";
  t.mock.timers.tick(70_000);
  await primeLocks(binding);
  assert.deepEqual([reads, peekLock(binding, "en", "abc")], [4, "Second wording"]);
});

// Value: protects=handleAdmin fails closed: a broken rate limiter refuses login, a malformed or oversized body is refused, and a failed content read answers 502 with no detail;
//   fails_when=a limiter error lets a login through, the body guard or its 64 KB cap is removed, or a content error reaches the editor as a raw message;
//   why_new=the tests above only cover a limiter that answers no, well-formed JSON bodies and a FileMaker that always responds;
//   seam=none
test("admin: fails closed when the login limiter, the request body or the content read lets it down", async (t) => {
  const kv = fakeKv();
  const env = fakeEnv(kv);
  const raw = (body, using = deps) => handleAdmin(new Request("https://www.ninetone.com/api/admin", { method: "POST", body }), env, using);

  // The limiter itself is down: no login, even with the right password.
  const limiterDown = { ...env, PUBLISH_RATE_LIMITER: { limit: async () => { throw new Error("limiter down"); } } };
  const refused = await call(limiterDown, { action: "login", password: PASSWORD });
  assert.equal(refused.status, 503);
  assert.equal("token" in (await refused.json()), false);

  // Bodies that are not a JSON object, and one over the 64 KB cap.
  for (const body of ["{", "null", "[]", '"login"', "7"]) assert.equal((await raw(body)).status, 400, body);
  assert.equal((await raw(JSON.stringify({ action: "login", password: "x".repeat(64_001) }))).status, 413);

  // The same call answers when the content can be read, and 502 without the cause when it cannot.
  const token = await signedIn(env);
  const listed = await (await raw(JSON.stringify({ action: "items", token }))).json();
  assert.deepEqual(listed.items, [
    { id: "homepage", label: "Homepage", path: "/" },
    { id: "news:agnes", label: "Agnes i juryn", path: "/news/agnes" },
  ]);
  t.mock.method(console, "error", () => {});
  const contentDown = { ...deps, getNews: async () => { throw new Error("FileMaker 500 at fm.internal.example, token abc123"); } };
  const down = await raw(JSON.stringify({ action: "items", token }), contentDown);
  assert.equal(down.status, 502);
  const answer = await down.json();
  assert.equal(answer.ok, false);
  assert.equal(JSON.stringify(answer).includes("fm.internal.example"), false);
  // Nothing was written by any of it; the one key is the session signing key from the sign-in above.
  assert.deepEqual([...kv.store.keys()], ["admin-session-key:v1"]);
});

// ---------------------------------------------------------------------------
// The two defects the /ship coverage audit reproduced (2026-10-09). Both tests
// failed before the fixes in translation-locks.ts and admin-api.ts.
// ---------------------------------------------------------------------------

// Value: protects=saving a lock never erases other locks when the lock list cannot be read or is unreadable;
//   fails_when=writeLock() stores a map built from a failed read as if it were the stored one;
//   why_new=no other test fails the lock-list read during a save;
//   seam=none
test("admin lock: when the lock list cannot be read, nothing is saved and the other locks survive", async () => {
  const stored = JSON.stringify({ "en:abc": { text: "Kept", source: "x", at: "" } });
  const kv = fakeKv({ [LOCKS_KEY]: stored });
  const token = await signedIn(fakeEnv(kv));
  const save = (env, as = token) => call(env, { action: "lock", token: as, item: "news:agnes", string: "title", lang: "en", text: "Agnes joins the jury" });

  const failing = { ...kv, get: async (key, opts) => { if (key === LOCKS_KEY) throw new Error("kv down"); return kv.get(key, opts); } };
  assert.equal((await save(fakeEnv(failing))).status, 503);
  assert.equal(kv.store.get(LOCKS_KEY), stored);
  assert.equal((await call(fakeEnv(failing), { action: "unlock", token, item: "news:agnes", string: "title", lang: "en" })).status, 503);
  assert.equal(kv.store.get(LOCKS_KEY), stored);

  // A stored value that is not a lock map is left for a person to look at, not overwritten.
  const corrupt = fakeKv({ [LOCKS_KEY]: "not json" });
  assert.equal((await save(fakeEnv(corrupt), await signedIn(fakeEnv(corrupt)))).status, 503);
  assert.equal(corrupt.store.get(LOCKS_KEY), "not json");

  // With a readable list the same save goes through and keeps the other lock.
  assert.equal((await save(fakeEnv(kv))).status, 200);
  assert.equal("en:abc" in JSON.parse(kv.store.get(LOCKS_KEY)), true);
});

// Value: protects=a locked article text cannot gain a link of any kind, not only an http one;
//   fails_when=the lock check compares http(s) targets only, so mailto:, tel: and site-relative links slip in;
//   why_new=every other refusal row changes or adds an https link;
//   seam=none
test("admin lock: an article text cannot gain a mailto, tel or site-relative link", async () => {
  const kv = fakeKv();
  const env = fakeEnv(kv);
  const token = await signedIn(env);
  const kept = "[Read more at Sveriges Radio](https://www.sverigesradio.se/artikel/finalen)";
  for (const added of ["[write to us](mailto:someone@example.com)", "[call](tel:+4670000000)", "[sign in](/admin/publish)"]) {
    const res = await call(env, { action: "lock", token, item: "news:agnes", string: "body", lang: "en", text: `Agnes sat on the jury, ${added}.\n\n${kept}` });
    assert.equal(res.status, 422, added);
  }
  assert.equal(kv.store.has(LOCKS_KEY), false);
});

// ---------------------------------------------------------------------------
// Found by the pre-landing security review (2026-10-09), before first deploy.
// ---------------------------------------------------------------------------

// Value: protects=knowing or guessing the password is not enough to mint a session, so a token can never be used to test password guesses around the login rate limit;
//   fails_when=sessions are signed with the password, or with anything an outsider can compute;
//   why_new=the token tests only forged a signature at random, never one derived from the real password;
//   seam=none
test("admin: a session forged from the password itself is refused, with the rate limiter never consulted", async () => {
  const { createHmac } = await import("node:crypto");
  const kv = fakeKv();
  let limiterCalls = 0;
  const env = { ...fakeEnv(kv), PUBLISH_RATE_LIMITER: { limit: async () => (limiterCalls++, { success: false }) } };
  const expires = NOW + 60 * 60 * 1000;
  const forgedWith = (guess) => `${expires}.${createHmac("sha256", guess).update(`ninetone-admin:${expires}`).digest("hex")}`;

  // Before anyone has signed in, and after: the right password forges nothing.
  assert.equal((await call(env, { action: "flush", token: forgedWith(PASSWORD) })).status, 401);
  const real = await signedIn(fakeEnv(kv));
  assert.equal((await call(env, { action: "flush", token: forgedWith(PASSWORD) })).status, 401);
  assert.equal((await call(env, { action: "flush", token: forgedWith("a wrong guess") })).status, 401);
  assert.equal(kv.store.has("cache-version"), false);
  assert.equal(limiterCalls, 0);

  assert.equal((await call(env, { action: "flush", token: real })).status, 200);
});

// Value: protects=after a failed lock read the isolate tries again within seconds, and a new cache version makes it re-read at once;
//   fails_when=a failed read is stamped as a good one, or the copy ignores the site's cache version;
//   why_new=the staleness test only moves the clock past a full minute and never changes the version;
//   seam=none
test("locks: a failed read is retried within seconds, and a site refresh re-reads the map straight away", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const hash = "f".repeat(64);
  const kv = fakeKv();
  let reads = 0;
  let down = true;
  const counting = { ...kv, get: async (key, opts) => { if (key === LOCKS_KEY) { reads++; if (down) throw new Error("kv down"); } return kv.get(key, opts); } };

  await primeLocks(counting, "v1");
  assert.equal(reads, 1);
  t.mock.timers.tick(2_000);
  await primeLocks(counting, "v1"); // still inside the retry delay
  assert.equal(reads, 1);
  down = false;
  kv.store.set(LOCKS_KEY, JSON.stringify({ [`en:${hash}`]: { text: "Locked line", source: "x", at: "" } }));
  t.mock.timers.tick(4_000);
  await primeLocks(counting, "v1"); // retried after ~5 s, not a full minute
  assert.equal(reads, 2);
  assert.equal(peekLock(counting, "en", hash), "Locked line");

  // Same version, copy still fresh: no read. New version (the site was refreshed): read now.
  kv.store.set(LOCKS_KEY, JSON.stringify({ [`en:${hash}`]: { text: "Changed line", source: "x", at: "" } }));
  await primeLocks(counting, "v1");
  assert.equal(reads, 2);
  await primeLocks(counting, "v2");
  assert.equal(reads, 3);
  assert.equal(peekLock(counting, "en", hash), "Changed line");
});
