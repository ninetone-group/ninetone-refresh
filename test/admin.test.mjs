import assert from "node:assert/strict";
import test from "node:test";

import { handleAdmin } from "../src/lib/admin-api.ts";
import { issueAdminToken, verifyAdminToken } from "../src/lib/admin-auth.ts";
import { translate, translationKey } from "../src/lib/translate.ts";
import { LOCK_PREFIX, RECENT_KEY, lockKey, peekLock, primeLocks, readLocks, writeLock } from "../src/lib/translation-locks.ts";

const PASSWORD = "correct horse battery staple";
const NOW = 1_800_000_000_000;

// A KV stand-in with the three calls the lock store uses beyond get/put. A
// bulk `get([...])` is deliberately unsupported (it answers null), which is
// how the code under test learns to fall back to one read per key.
function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

const lockKeys = (kv) => [...kv.store.keys()].filter((key) => key.startsWith(LOCK_PREFIX));
const lockValue = (text, at = "") => JSON.stringify({ text, source: "Källa", at });

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

// What an editor's browser sends: the lock or unlock, together with what the
// review it was composed against said (`sourceHash`, `lockedAt`).
async function mutate(env, token, action, { item = "news:agnes", string, lang = "en", text }, using = deps) {
  const post = (body) => handleAdmin(new Request("https://www.ninetone.com/api/admin", { method: "POST", body: JSON.stringify({ token, item, ...body }) }), env, using);
  const reviewed = await (await post({ action: "review" })).json();
  const seen = reviewed.strings?.find((s) => s.id === string);
  return post({ action, string, lang, text, sourceHash: seen?.sourceHash, lockedAt: seen?.[lang]?.lockedAt ?? null });
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

  assert.equal((await mutate(env, token, "lock", { string: "title", text: "Agnes joins the jury" })).status, 200);
  const served = await translate({ text: "Agnes i juryn", target: "en", tier: "fast", kind: "title", kv });
  assert.deepEqual([served.text, served.origin], ["Agnes joins the jury", "locked"]);
  const after = await (await call(env, { action: "review", token, item: "news:agnes" })).json();
  const locked = after.strings.find((s) => s.id === "title").en;
  assert.deepEqual([locked.locked, locked.text, locked.origin, locked.lockedAt], [true, "Agnes joins the jury", "locked", new Date(NOW).toISOString()]);

  assert.equal((await mutate(env, token, "unlock", { string: "title" })).status, 200);
  assert.equal((await translate({ text: "Agnes i juryn", target: "en", tier: "fast", kind: "title", kv })).text, "Agnes on the jury (machine)");
  assert.deepEqual(lockKeys(kv), []);
});

test("admin lock: refuses a wording that drops a paragraph, changes a link, is empty, or targets the source language", async () => {
  const kv = fakeKv();
  const env = fakeEnv(kv);
  const token = await signedIn(env);
  const lock = (extra) => mutate(env, token, "lock", extra);

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
  assert.equal((await mutate(env, token, "lock", { item: "news:kontakt", string: "title", text: "Contact us" }, pinnedDeps)).status, 409);
  // --- end of audit rows ---

  assert.deepEqual(lockKeys(kv), []);

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
  // Sent with the right source hash, so the refusal is the language rule and not a stale page.
  const refused = await post({ action: "lock", token, item: "homepage", string: "merch.heading", lang: "sv", text: "x", sourceHash: heading.sourceHash, lockedAt: null });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /already written in that language/);
});

test("locks: translate() reads them from memory only — an unprimed isolate serves the cache, a primed one serves the lock", async () => {
  const key = await translationKey("Boka artist", "en", "fast");
  const hash = key.split(":").pop();
  const kv = fakeKv({ [key]: "Book artist", [lockKey("en", hash)]: lockValue("Book an artist") });
  let lists = 0;
  const counting = { ...kv, list: async (opts) => (lists++, kv.list(opts)) };

  assert.equal(peekLock(counting, "en", hash), null);
  assert.equal((await translate({ text: "Boka artist", target: "en", tier: "fast", kv: counting })).text, "Book artist");
  assert.equal(lists, 0);

  await primeLocks(counting);
  await primeLocks(counting); // fresh copy: no second listing
  assert.equal(lists, 1);
  assert.equal((await translate({ text: "Boka artist", target: "en", tier: "fast", kv: counting })).text, "Book an artist");
  assert.equal(lists, 1);
  // A lock is for one language only.
  assert.equal(peekLock(counting, "sv", hash), null);
});

test("locks: one unreadable entry is skipped without losing the others, and a failing read leaves rendering untouched", async () => {
  const kv = fakeKv({ [lockKey("en", "bad")]: "not json", [lockKey("en", "empty")]: JSON.stringify({ text: "" }), [lockKey("en", "good")]: lockValue("Kept") });
  assert.deepEqual(Object.keys(await readLocks(kv)), ["en:good"]);
  const failing = { get: async () => { throw new Error("kv down"); }, put: async () => {}, list: async () => { throw new Error("kv down"); } };
  await assert.doesNotReject(() => primeLocks(failing));
  assert.equal(peekLock(failing, "en", "abc"), null);
  // A stand-in with no list() at all (most of this suite's KV doubles) simply has no locks.
  const bare = { get: async () => "7", put: async () => {} };
  await assert.doesNotReject(() => primeLocks(bare));
  assert.equal(peekLock(bare, "en", "abc"), null);
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

// Value: protects=locking or unlocking one wording never touches another lock, including one a different isolate stored after this isolate loaded the map;
//   fails_when=a save writes anything but its own key, or rebuilds stored state from what this isolate last read;
//   why_new=the tests above hold one lock at a time and write it from the isolate that reads it;
//   seam=none
test("admin lock: a second lock, and one another isolate stored meanwhile, survive a lock and an unlock", async () => {
  const TITLE = "Agnes i juryn";
  const EXCERPT = "Agnes satt i juryn när tävlingen avgjordes.";
  const EXCERPT_EN = "Agnes sat on the jury when the contest was decided.";
  const kv = fakeKv();
  const env = fakeEnv(kv);
  const token = await signedIn(env);
  const served = async (text, kind) => (await translate({ text, target: "en", tier: "fast", kind, kv })).text;

  assert.equal((await mutate(env, token, "lock", { string: "title", text: "Agnes joins the jury" })).status, 200);
  // Another isolate locks a line of its own: it lands in KV, not in this isolate's seconds-old copy.
  const elsewhere = lockValue("Kept from elsewhere", "2026-10-09T00:00:00.000Z");
  kv.store.set(lockKey("en", "stored-elsewhere"), elsewhere);

  assert.equal((await mutate(env, token, "lock", { string: "excerpt", text: EXCERPT_EN })).status, 200);
  assert.equal(kv.store.get(lockKey("en", "stored-elsewhere")), elsewhere);
  assert.equal(lockKeys(kv).length, 3);
  assert.equal(await served(TITLE, "title"), "Agnes joins the jury");
  assert.equal(await served(EXCERPT, "plain"), EXCERPT_EN);

  // Removing one lock removes that one only.
  assert.equal((await mutate(env, token, "unlock", { string: "title" })).status, 200);
  assert.equal(await served(TITLE, "title"), TITLE);
  assert.equal(await served(EXCERPT, "plain"), EXCERPT_EN);
  assert.equal(kv.store.get(lockKey("en", "stored-elsewhere")), elsewhere);
  assert.equal(lockKeys(kv).length, 2);
});

// Value: protects=an isolate re-reads the lock map once its copy is over a minute old, and a lock read that hangs or throws is abandoned with the last map kept;
//   fails_when=the freshness window stops expiring, the read loses its timeout, or a slow or failed read empties the map every render relies on;
//   why_new=the tests above never move the clock and only fail a read on an isolate that holds no map yet;
//   seam=none
test("locks: a copy over a minute old is re-read, and a read that hangs or throws keeps the last map without holding the render", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const kv = fakeKv({ [lockKey("en", "abc")]: lockValue("First wording") });
  let mode = "ok";
  let reads = 0;
  const binding = {
    ...kv,
    list: (opts) => {
      reads += 1;
      if (mode === "hang") return new Promise(() => {});
      if (mode === "throw") return Promise.reject(new Error("kv down"));
      return kv.list(opts);
    },
  };

  await primeLocks(binding);
  assert.deepEqual([reads, peekLock(binding, "en", "abc")], [1, "First wording"]);

  // Another isolate changes the wording. Inside the minute this one serves its copy and reads nothing.
  kv.store.set(lockKey("en", "abc"), lockValue("Second wording"));
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

// Value: protects=a save writes its own key and nothing else, does not depend on listing the locks, and is refused whole when its own key cannot be read or written;
//   fails_when=a save reads and rewrites other locks, needs the listing to succeed, or reports success for a write KV refused;
//   why_new=no other test fails a lock read or write during a save;
//   seam=none
test("admin lock: a save touches only its own key, and when that key cannot be read or written nothing changes", async () => {
  const other = lockValue("Kept");
  const kv = fakeKv({ [lockKey("en", "abc")]: other });
  const token = await signedIn(fakeEnv(kv));
  // The editor opened the page while everything worked; the failure comes at the moment of saving.
  const seen = (await (await call(fakeEnv(kv), { action: "review", token, item: "news:agnes" })).json()).strings.find((s) => s.id === "title");
  const save = (binding) =>
    call(fakeEnv(binding), { action: "lock", token, item: "news:agnes", string: "title", lang: "en", text: "Agnes joins the jury", sourceHash: seen.sourceHash, lockedAt: seen.en.lockedAt });
  const untouched = () => assert.deepEqual([lockKeys(kv), kv.store.get(lockKey("en", "abc"))], [[lockKey("en", "abc")], other]);

  // The lock's own key cannot be read (needed to see whether someone else changed it): refused.
  const unreadable = { ...kv, get: async (key, opts) => { if (String(key).startsWith(LOCK_PREFIX)) throw new Error("kv down"); return kv.get(key, opts); } };
  assert.equal((await save(unreadable)).status, 503);
  untouched();
  // KV refuses the write (it allows one write a second to a key): refused, and said so.
  const unwritable = { ...kv, put: async (key, value) => { if (String(key).startsWith(LOCK_PREFIX)) throw new Error("429 Too Many Requests"); return kv.put(key, value); } };
  const refused = await save(unwritable);
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /Nothing was changed/);
  untouched();

  // The listing is down, but a save never needed it: it goes through and the other lock is exactly as it was.
  const unlistable = { ...kv, list: async () => { throw new Error("kv down"); } };
  assert.equal((await save(unlistable)).status, 200);
  assert.equal(kv.store.get(lockKey("en", "abc")), other);
  assert.equal(lockKeys(kv).length, 2);
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
    const res = await mutate(env, token, "lock", { string: "body", text: `Agnes sat on the jury, ${added}.\n\n${kept}` });
    assert.equal(res.status, 422, added);
  }
  assert.deepEqual(lockKeys(kv), []);
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
  const counting = { ...kv, list: async (opts) => { reads++; if (down) throw new Error("kv down"); return kv.list(opts); } };

  await primeLocks(counting, "v1");
  assert.equal(reads, 1);
  t.mock.timers.tick(2_000);
  await primeLocks(counting, "v1"); // still inside the retry delay
  assert.equal(reads, 1);
  down = false;
  kv.store.set(lockKey("en", hash), lockValue("Locked line"));
  t.mock.timers.tick(4_000);
  await primeLocks(counting, "v1"); // retried after ~5 s, not a full minute
  assert.equal(reads, 2);
  assert.equal(peekLock(counting, "en", hash), "Locked line");

  // Same version, copy still fresh: no read. New version (the site was refreshed): read now.
  kv.store.set(lockKey("en", hash), lockValue("Changed line"));
  await primeLocks(counting, "v1");
  assert.equal(reads, 2);
  await primeLocks(counting, "v2");
  assert.equal(reads, 3);
  assert.equal(peekLock(counting, "en", hash), "Changed line");
});

// ---------------------------------------------------------------------------
// Codex audit 2026-10-10: F01 (one key per lock, covered above), F12, F11, F14.
// ---------------------------------------------------------------------------

test("admin lock: a wording composed against an older FileMaker text is refused, for lock and unlock alike (F12)", async () => {
  const kv = fakeKv();
  const env = fakeEnv(kv);
  const token = await signedIn(env);
  const news = (Title) => ({ ...deps, getNews: async () => [{ slug: "single", Title, Message: "Text." }] });
  const post = (body, using) => handleAdmin(new Request("https://www.ninetone.com/api/admin", { method: "POST", body: JSON.stringify({ token, item: "news:single", ...body }) }), env, using);

  // The editor opens the page while the headline is "Ny singel"...
  const [seen] = (await (await post({ action: "review" }, news("Ny singel"))).json()).strings;
  assert.match(seen.sourceHash, /^[0-9a-f]{64}$/);
  // ...FileMaker changes to "Ny turné", and only then the editor presses Lock.
  const stale = await post({ action: "lock", string: "title", lang: "en", text: "New single", sourceHash: seen.sourceHash, lockedAt: null }, news("Ny turné"));
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /FileMaker text changed/);
  assert.deepEqual(lockKeys(kv), []);
  // A request that says nothing about what it was composed against is refused the same way.
  assert.equal((await post({ action: "lock", string: "title", lang: "en", text: "New single" }, news("Ny turné"))).status, 409);

  // Against the text as it is now, the same wording saves; a stale unlock then cannot remove it.
  assert.equal((await mutate(env, token, "lock", { item: "news:single", string: "title", text: "New tour" }, news("Ny turné"))).status, 200);
  assert.equal((await post({ action: "unlock", string: "title", lang: "en", sourceHash: seen.sourceHash, lockedAt: null }, news("Ny turné"))).status, 409);
  assert.equal(lockKeys(kv).length, 1);
});

test("admin lock: a second editor who opened the page before the first one saved is told, and nothing is overwritten (F12)", async () => {
  const kv = fakeKv();
  const env = fakeEnv(kv);
  const token = await signedIn(env);
  const post = (body) => call(env, { token, item: "news:agnes", ...body });
  const reviewTitle = async () => (await (await post({ action: "review" })).json()).strings.find((s) => s.id === "title");

  const first = await reviewTitle();
  const second = await reviewTitle(); // both opened the page with no lock in place
  const save = (seen, text) => post({ action: "lock", string: "title", lang: "en", text, sourceHash: seen.sourceHash, lockedAt: seen.en.lockedAt });

  assert.equal((await save(first, "Agnes joins the jury")).status, 200);
  const late = await save(second, "Agnes on the panel");
  assert.equal(late.status, 409);
  assert.match((await late.json()).error, /changed by someone else/);
  assert.equal(JSON.parse(kv.store.get(lockKeys(kv)[0])).text, "Agnes joins the jury");

  // After reloading, the second editor sees the first one's wording and can replace it knowingly.
  const reloaded = await reviewTitle();
  assert.equal(reloaded.en.text, "Agnes joins the jury");
  assert.equal((await save(reloaded, "Agnes on the panel")).status, 200);
  assert.equal(JSON.parse(kv.store.get(lockKeys(kv)[0])).text, "Agnes on the panel");
});

test("admin: when the session key cannot be read, sign-in and every action answer 503, never 401 or a crash (F11)", async (t) => {
  t.mock.method(console, "error", () => {});
  const kv = fakeKv();
  const token = await signedIn(fakeEnv(kv));
  const down = { ...kv, get: async (key, opts) => { if (key === "admin-session-key:v1") throw new Error("kv down"); return kv.get(key, opts); } };

  const login = await call(fakeEnv(down), { action: "login", password: PASSWORD });
  assert.equal(login.status, 503);
  assert.equal("token" in (await login.json()), false);
  const action = await call(fakeEnv(down), { action: "flush", token });
  assert.equal(action.status, 503);
  assert.match((await action.json()).error, /temporarily unavailable/);
  assert.equal(kv.store.has("cache-version"), false);
  // A wrong password is still a 401 before any storage is touched.
  assert.equal((await call(fakeEnv(down), { action: "login", password: "wrong" })).status, 401);
});

test("admin tokens: a first sign-in signs with the key that ended up stored, so a simultaneous first sign-in does not strand it (F14)", async () => {
  // Another first login writes its key a moment after ours: what is stored is theirs.
  const kv = fakeKv();
  const racing = { ...kv, put: async (key, value) => kv.put(key, key === "admin-session-key:v1" ? "key-written-by-the-other-login" : value) };
  const { token } = await issueAdminToken(racing, PASSWORD, NOW);
  assert.equal(kv.store.get("admin-session-key:v1"), "key-written-by-the-other-login");
  assert.equal(await verifyAdminToken(token, kv, PASSWORD, NOW), true);
});

// ---------------------------------------------------------------------------
// Read side, from the review of the per-key rewrite (2026-10-10): a KV listing
// can lag a write by up to a minute, so the listing alone must never decide
// what is locked.
// ---------------------------------------------------------------------------

// A binding whose listing is frozen at the moment it was created: reads and
// writes by key are immediate, the listing never learns of them.
function laggingList(kv) {
  const frozen = [...kv.store.keys()];
  return { ...kv, list: async ({ prefix }) => ({ keys: frozen.filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
}

test("locks: a lock just saved survives a refresh whose listing does not show it yet, in the saving isolate and in another one", async () => {
  const kv = fakeKv({ [lockKey("en", "old")]: lockValue("Listed all along") });
  const saving = laggingList(kv);
  await primeLocks(saving);
  await writeLock(saving, "en", "new", { text: "Hand wording", source: "Källa", at: "t1" });
  assert.equal(peekLock(saving, "en", "new"), "Hand wording");
  // The editor's page reloads: a fresh read whose listing still lacks the new key.
  await readLocks(saving, { fresh: true });
  assert.equal(peekLock(saving, "en", "new"), "Hand wording");
  assert.equal(peekLock(saving, "en", "old"), "Listed all along");

  // Another isolate at the same location, right after "show changes now": it has no copy and the same lagging listing.
  const other = laggingList(kv);
  delete other.store; // a distinct binding object: its own isolate copy
  other.list = saving.list;
  await primeLocks(other, "new-version");
  assert.equal(peekLock(other, "en", "new"), "Hand wording", "found through the recently-changed note, read by key");
  assert.deepEqual(JSON.parse(kv.store.get(RECENT_KEY)), ["en:new"]);
});

test("locks: a removed lock is gone at once even while the listing still names it, and the hint note is only a hint", async () => {
  const kv = fakeKv({ [lockKey("en", "gone")]: lockValue("About to be removed"), [lockKey("en", "kept")]: lockValue("Kept") });
  const binding = laggingList(kv); // will keep listing "gone" after it is deleted
  await primeLocks(binding);
  await writeLock(binding, "en", "gone", null);
  await readLocks(binding, { fresh: true });
  assert.equal(peekLock(binding, "en", "gone"), null);
  assert.equal(peekLock(binding, "en", "kept"), "Kept");

  // A note that cannot be read or written never blocks a save or a load.
  const noNote = { ...kv, get: async (key, opts) => { if (key === RECENT_KEY) throw new Error("kv down"); return kv.get(key, opts); } };
  await assert.doesNotReject(() => writeLock(noNote, "en", "x", { text: "Saved anyway", source: "", at: "t" }));
  assert.equal(JSON.parse(kv.store.get(lockKey("en", "x"))).text, "Saved anyway");
  kv.store.set(RECENT_KEY, "not json");
  assert.equal((await readLocks(fakeKvFrom(kv), { fresh: true }))["en:x"].text, "Saved anyway");
});

// A second binding object over the same stored data (its own isolate copy).
function fakeKvFrom(kv) {
  return { get: kv.get, put: kv.put, delete: kv.delete, list: kv.list };
}

test("locks: the bulk read used on the real binding returns every lock, across list pages and bulk chunks, reading each key once", async () => {
  const total = 150;
  const data = new Map(Array.from({ length: total }, (_, i) => [lockKey("en", `h${i}`), lockValue(`Wording ${i}`)]));
  const bulkSizes = [];
  const kv = {
    // The real KV binding: an array of keys answers with a Map; a single key with its value.
    get: async (key) => {
      if (Array.isArray(key)) {
        bulkSizes.push(key.length);
        assert.equal(new Set(key).size, key.length, "no key twice in one bulk read");
        return new Map(key.map((k) => [k, data.get(k) ?? null]));
      }
      return data.get(key) ?? null;
    },
    put: async () => {},
    list: async ({ prefix, cursor }) => {
      const names = [...data.keys()].filter((k) => k.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + 100);
      return { keys: page.map((name) => ({ name })), list_complete: start + 100 >= names.length, cursor: String(start + 100) };
    },
  };
  const locks = await readLocks(kv, { fresh: true });
  assert.equal(Object.keys(locks).length, total);
  assert.equal(locks["en:h149"].text, "Wording 149");
  assert.deepEqual(bulkSizes, [100, 50]);
});
