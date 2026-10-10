// Local UI audit. All admin API requests are intercepted; no real credentials or writes.
// AUDIT_PLAYWRIGHT_MODULE may point to an installed Playwright index.mjs.
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const modulePath = process.env.AUDIT_PLAYWRIGHT_MODULE ?? resolve(homedir(), '.claude/skills/gstack/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(modulePath));
const outputDir = dirname(fileURLToPath(import.meta.url));
const base = process.env.AUDIT_BASE_URL ?? 'http://127.0.0.1:4328/ninetone-refresh';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => sessionStorage.setItem('ninetone-admin', 'local-audit-fake-token'));
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let raceMode = false;
let saves = 0;
const state = text => ({ text, origin: 'cached', locked: false, lockable: true, structureBroken: false });
const source = text => ({ text, origin: 'same-language', locked: false, lockable: false, structureBroken: false });
await page.route('**/api/admin', async route => {
  const body = route.request().postDataJSON();
  let data;
  if (body.action === 'items') data = { ok: true, items: [{ id: 'homepage', label: 'Homepage', path: '/' }, { id: 'news:a', label: 'Article A', path: '/news/a' }, { id: 'news:b', label: 'Article B', path: '/news/b' }] };
  else if (body.action === 'review') {
    if (raceMode) await sleep(body.item === 'news:a' ? 650 : 80);
    const label = body.item === 'news:a' ? 'Article A' : body.item === 'news:b' ? 'Article B' : 'Homepage';
    data = { ok: true, item: { id: body.item, label, path: '/' }, strings: [
      { id: 'title', label: 'Headline', kind: 'title', source: `${label}: Ny singel`, sv: source(`${label}: Ny singel`), en: state(`${label}: New single`) },
      { id: 'body', label: 'Article text', kind: 'markdown', source: 'Vi spelar i Stockholm.\n\nBiljetter finns här.', sv: source('Vi spelar i Stockholm.\n\nBiljetter finns här.'), en: state('We play in Stockholm.\n\nTickets are here.') },
    ] };
  } else if (body.action === 'lock') { saves++; data = { ok: true }; }
  else if (body.action === 'blocks') data = { ok: true, found: true, blocks: [{ recordId: '3', subject: 'Vi kopplar samman det människor behöver med det de bryr sig om', fills: 'Hero (top of the page)' }, { recordId: '777', subject: 'Ett nytt redaktionellt block', fills: null }], unfilled: ['Positioning band'] };
  else if (body.action === 'health') data = { ok: true, report: { strings: 241, items: 81, damaged: 0, byLang: { sv: { 'same-language': 240, cached: 1, locked: 0, override: 0, miss: 0 }, en: { 'same-language': 0, cached: 240, locked: 0, override: 0, miss: 1 } }, problems: [{ item: 'news:a', itemLabel: 'Ninetone presenterar ett nytt samarbete med artister och publik i Stockholm', path: '/news/a', string: 'Article text', lang: 'en', issue: 'waiting' }] } };
  else data = { ok: true };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
});
const metrics = () => page.evaluate(() => {
  const areas = [...document.querySelectorAll('textarea')].map(el => ({ id: el.id, ariaLabel: el.getAttribute('aria-label'), labelledBy: el.getAttribute('aria-labelledby'), labelCount: el.labels.length }));
  const targets = [...document.querySelectorAll('nav a, #strings button')].map(el => ({ text: el.textContent, width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) }));
  const text = document.querySelector('nav a:not([aria-current])');
  const colors = { text: getComputedStyle(text).color, background: getComputedStyle(document.body).backgroundColor };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, 1, 1);
  const background = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  ctx.fillStyle = colors.text;
  ctx.fillRect(0, 0, 1, 1);
  const foreground = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  const luminance = rgb => rgb.map(channel => channel / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (luminance(background) + 0.05) / (luminance(foreground) + 0.05);
  const selector = document.querySelector('#item');
  const selection = selector ? { width: Math.round(selector.getBoundingClientRect().width), visibleSelection: selector.selectedOptions[0]?.textContent } : null;
  return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, areas, targets, colors, compositedForeground: foreground, textContrast: Number(contrast.toFixed(2)), selection };
});
const results = { apiRequestsMocked: true, productionWrites: 0, paidModelCalls: 0 };
try {
  await page.goto(`${base}/admin/translations`);
  await page.locator('textarea').first().waitFor();
  results.desktop = await metrics();
  await page.screenshot({ path: resolve(outputDir, 'translations-desktop.png'), fullPage: true });

  await page.locator('textarea').nth(0).fill('An unsaved headline');
  await page.locator('textarea').nth(1).fill('An unsaved body correction');
  await page.getByRole('button', { name: 'Lock this wording' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('textarea').length === 2 && document.querySelectorAll('textarea')[1].value === 'We play in Stockholm.\n\nTickets are here.');
  results.unsavedDraft = { bodyAfterSavingHeadline: await page.locator('textarea').nth(1).inputValue(), draftLost: true, mockedSaves: saves };
  assert.equal(results.unsavedDraft.draftLost, true);

  raceMode = true;
  await page.locator('#item').selectOption('news:a');
  await sleep(30);
  await page.locator('#item').selectOption('news:b');
  await sleep(1000);
  results.responseRace = { selected: await page.locator('#item').inputValue(), displayedHeadlines: await page.locator('#strings section').locator('p').evaluateAll(nodes => nodes.filter((_, i) => i % 3 === 0).map(node => node.textContent)), renderedSections: await page.locator('#strings section').count() };
  assert.equal(results.responseRace.selected, 'news:b');
  assert.equal(results.responseRace.renderedSections, 4);
  await page.screenshot({ path: resolve(outputDir, 'translations-race.png'), fullPage: true });

  raceMode = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/admin/translations`);
  await page.locator('textarea').first().waitFor();
  results.mobileTranslations = await metrics();
  await page.screenshot({ path: resolve(outputDir, 'translations-mobile.png'), fullPage: true });
  await page.goto(`${base}/admin/homepage`);
  await page.locator('#blocks table').waitFor();
  results.mobileHomepage = await metrics();
  await page.screenshot({ path: resolve(outputDir, 'homepage-mobile.png'), fullPage: true });
  await page.goto(`${base}/admin/health`);
  await page.locator('#health table').waitFor();
  results.mobileHealth = await metrics();
  await page.screenshot({ path: resolve(outputDir, 'health-mobile.png'), fullPage: true });
  results.consoleErrors = errors;
  await writeFile(resolve(outputDir, 'browser-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally { await context.close(); await browser.close(); }
