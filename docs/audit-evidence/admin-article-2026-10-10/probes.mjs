// Read-only audit reproductions. All KV and model responses are local fakes.
// Run: node --experimental-strip-types docs/audit-evidence/admin-article-2026-10-10/probes.mjs
import assert from 'node:assert/strict';
import { handleAdmin } from '../../../src/lib/admin-api.ts';
import { issueAdminToken, verifyAdminToken } from '../../../src/lib/admin-auth.ts';
import { newsItems, healthOf, shownFor } from '../../../src/lib/admin-content.ts';
import { callWithGuard, breaksMarkdownStructure, translationKey, translate, detectLanguage } from '../../../src/lib/translate.ts';
import { LOCKS_KEY, writeLock } from '../../../src/lib/translation-locks.ts';
import { describeHomepageBlocks, parseHomepageCopy } from '../../../src/lib/homepage-copy.ts';

const findings = [];
function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { store, get: async key => store.get(key) ?? null, put: async (key, value) => { store.set(key, value); } };
}
const entry = text => ({ text, source: 'Audit source', at: '2026-10-10T00:00:00.000Z' });

// Even serial saves by the same editor lose a lock when the KV read remains stale.
{
  const kv = fakeKv();
  kv.get = async () => null; // the location still caches the pre-save missing value
  await writeLock(kv, 'en', 'first', entry('First correction'));
  await writeLock(kv, 'en', 'second', entry('Second correction'));
  const keys = Object.keys(JSON.parse(kv.store.get(LOCKS_KEY)));
  assert.deepEqual(keys, ['en:second']);
  findings.push({ id: 'F01', probe: 'Sequential saves with stale KV read', survivingLocks: keys });
}

// Automatic output guard accepts mutations that the editor lock guard rejects.
{
  const savedFetch = globalThis.fetch;
  try {
    const pairs = [
      ['relative link', '[Läs mer](/news/original)', '[Read more](/news/changed)'],
      ['email link', '[Kontakta oss](mailto:hello@example.test)', '[Contact us](mailto:other@example.test)'],
      ['telephone link', '[Ring oss](tel:+46123456789)', '[Call us](tel:+46987654321)'],
      ['link replaced with image', '[Läs mer](https://example.test/original)', '![Read more](https://example.test/original)'],
      ['clickable link removed', '[Läs mer](https://example.test/original)', '```\nRead more https://example.test/original\n```'],
      ['heading removed', '## Nyheter\n\nVi spelar i Stockholm.', 'News\n\nWe play in Stockholm.'],
      ['hard line break removed', 'Vi spelar i Stockholm.\nBiljetterna finns här.', 'We play in Stockholm. Tickets are here.'],
    ];
    for (const [name, source, output] of pairs) {
      globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: output }], stop_reason: 'end_turn' }), { status: 200 });
      assert.equal(breaksMarkdownStructure(source, output), false, name);
      assert.equal(await callWithGuard('local-audit-only', source, 'en', 'fast', 'markdown', []), output);
      findings.push({ id: 'F02', probe: name, guardAccepted: true });
    }
  } finally { globalThis.fetch = savedFetch; }
}

// A structurally damaged historical translation is served and enters the bundle ledger.
{
  const source = 'Vi har en ny artist och vi spelar i Stockholm.\n\nDet är ett nytt samarbete med vår publik.';
  const output = 'We have a new artist and we play in Stockholm. It is a new collaboration with our audience.';
  const kv = fakeKv({ [await translationKey(source, 'en', 'fast')]: output });
  const ledger = new Map();
  const result = await translate({ text: source, target: 'en', tier: 'fast', kind: 'markdown', kv, ledger });
  const shown = await shownFor({ id: 'body', label: 'Body', source, kind: 'markdown', tier: 'fast' }, 'en', kv);
  assert.equal(result.origin, 'cached');
  assert.equal(shown.structureBroken, true);
  assert.equal(ledger.size, 1);
  findings.push({ id: 'F03', probe: 'Damaged cached translation', origin: result.origin, structureBroken: shown.structureBroken, bundleLedgerEntries: ledger.size });
}

// Source-language lock restriction depends on a detector that declines on short prose.
{
  const kv = fakeKv();
  const env = { CACHE_STATE: kv, PUBLISH_PASSWORD: 'local-audit-password', PUBLISH_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const deps = { getNews: async () => [{ slug: 'audit', Title: 'Ny singel' }], getHomepageSection: async () => null };
  const { token } = await issueAdminToken(kv, env.PUBLISH_PASSWORD);
  const response = await handleAdmin(new Request('https://audit.example.test/api/admin', { method: 'POST', body: JSON.stringify({ action: 'lock', token, item: 'news:audit', string: 'title', lang: 'sv', text: 'En annan rubrik' }) }), env, deps);
  assert.equal(detectLanguage('Ny singel'), null);
  assert.equal(response.status, 200);
  const result = await translate({ text: 'Ny singel', target: 'sv', tier: 'fast', kind: 'title', kv });
  assert.equal(result.origin, 'locked');
  findings.push({ id: 'F09', probe: 'Short Swedish source can be locked in Swedish', status: response.status, returned: result.text });
}

// A mapped block with an empty message is reported filled, but supplies empty body/tagline.
{
  const section = { category: 'Ninetone Group', title: '', blocks: [{ recordId: '3', subject: 'Audit headline', message: '', ytLinks: [] }] };
  const status = describeHomepageBlocks(section);
  const copy = parseHomepageCopy(section);
  const strings = newsItems([{ slug: 'audit', Title: 'Audit headline', shortMessage: '', Message: '' }]);
  const health = await healthOf(strings, null);
  assert.equal(status.blocks[0].fills, 'Hero (top of the page)');
  assert.equal(status.unfilled.includes('Hero (top of the page)'), false);
  assert.equal(copy.hero.body, '');
  assert.equal(copy.hero.tagline, '');
  assert.equal(strings[0].strings.length, 1);
  findings.push({ id: 'F10', probe: 'Empty content omitted from health', hero: copy.hero, status: status.blocks[0], newsStringsChecked: health.strings });
}

// Initial key creation races: one successful login issues a token the final key rejects.
{
  const kv = fakeKv();
  const [first, second] = await Promise.all([issueAdminToken(kv, 'local-audit-password'), issueAdminToken(kv, 'local-audit-password')]);
  const valid = await Promise.all([verifyAdminToken(first.token, kv, 'local-audit-password'), verifyAdminToken(second.token, kv, 'local-audit-password')]);
  assert.equal(valid.filter(Boolean).length, 1);
  findings.push({ id: 'F14', probe: 'Concurrent first login key creation', validSessions: valid.filter(Boolean).length, issuedSessions: 2 });
}

// Signing-key storage failures escape the controlled JSON error handler.
{
  const brokenKv = { get: async () => { throw new Error('local KV unavailable'); }, put: async () => {} };
  const env = { CACHE_STATE: brokenKv, PUBLISH_PASSWORD: 'local-audit-password', PUBLISH_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  await assert.rejects(handleAdmin(new Request('https://audit.example.test/api/admin', { method: 'POST', body: JSON.stringify({ action: 'login', password: env.PUBLISH_PASSWORD }) }), env, { getNews: async () => [], getHomepageSection: async () => null }), /local KV unavailable/);
  findings.push({ id: 'F11', probe: 'Signing-key outage escapes handleAdmin', controlledResponse: false });
}

// FM source can change after review: the stale editor text is locked against the unseen new source.
{
  const kv = fakeKv();
  const password = 'local-audit-password';
  const env = { CACHE_STATE: kv, PUBLISH_PASSWORD: password, PUBLISH_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  let currentTitle = 'Ny singel';
  const deps = { getNews: async () => [{ slug: 'audit', Title: currentTitle }], getHomepageSection: async () => null };
  const { token } = await issueAdminToken(kv, password);
  const call = action => handleAdmin(new Request('https://audit.example.test/api/admin', { method: 'POST', body: JSON.stringify({ token, item: 'news:audit', ...action }) }), env, deps);
  const review = await (await call({ action: 'review' })).json();
  currentTitle = 'Ny turné';
  const response = await call({ action: 'lock', string: 'title', lang: 'en', text: 'New single' });
  const served = await translate({ text: currentTitle, target: 'en', tier: 'fast', kind: 'title', kv });
  assert.equal(response.status, 200);
  assert.equal(served.text, 'New single');
  findings.push({ id: 'F12', probe: 'Source changed between review and save', reviewedSource: review.strings[0].source, currentSource: currentTitle, lockedTextForCurrentSource: served.text, status: response.status });
}

console.log(JSON.stringify({ productionWrites: 0, paidModelCalls: 0, findings }, null, 2));
