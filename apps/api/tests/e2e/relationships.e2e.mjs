// Browser e2e (Playwright/Chromium): two real browser contexts run the whole milestone through the real UI, route table and PostgreSQL.
// Usage: node relationships.e2e.mjs <webDir> <baseUrl> <shotsDir>
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [, , , base, shots] = process.argv; mkdirSync(shots, { recursive: true });
// E2E_CHROMIUM_PATH: use a system/other Chromium when `npx playwright install` is blocked. E2E_CHROMIUM_ARGS: space-separated extra flags (e.g. --no-sandbox in containers).
const browser = await chromium.launch({ ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}), args: (process.env.E2E_CHROMIUM_ARGS ?? '').split(' ').filter(Boolean) });
const errors = [];
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { errors.push(`${name}: ${e.message}`); if (process.env.E2E_DEBUG) console.log(name, 'PAGEERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  page.on('response', async (r) => { if (r.url().includes('/v1/') && process.env.E2E_DEBUG) console.log(name, r.status(), r.url(), await r.text().catch(() => '')); });
  page.on('requestfailed', (r) => { if (process.env.E2E_DEBUG) console.log(name, 'REQFAIL', r.url(), r.failure()?.errorText); });
  page.on('dialog', (d) => void d.accept(d.type() === 'prompt' ? 'spam' : undefined));
  return { ctx, page, name };
}
const shot = (p, n) => p.page.screenshot({ path: `${shots}/${p.name}-${n}.png` });
async function register(p, display, email) {
  await p.page.goto(base);
  await p.page.click('#swap'); await p.page.fill('#dn', display); await p.page.fill('#em', email); await p.page.fill('#pw', 'correct horse battery'); await p.page.click('#authForm button[type=submit]');
  await p.page.waitForSelector('.tabs', { timeout: 15000 }).catch(async (e) => { console.log('REGISTER STUCK:', (await p.page.innerText('body')).slice(0, 400), p.page.url()); throw e; });
}
const tab = (p, label) => p.page.click(`button.tab:has-text("${label}")`);

const ann = await person('ann'), bob = await person('bob');
await register(ann, '<img src=x onerror="window.__xss=1">Ann', 'ann@example.test');
// profile: hostile display name must render as text; privacy defaults are off
await tab(ann, 'Profile'); await ann.page.waitForSelector('#profForm');
assert.equal(await ann.page.locator('input[data-k=discoverable]').isChecked(), false); assert.equal(await ann.page.locator('input[data-k=acceptsIntroductions]').isChecked(), false);
assert.equal(await ann.page.evaluate(() => window.__xss), undefined, 'XSS must not execute');
await shot(ann, '1-profile');
// invitation
await tab(ann, 'Invitations'); await ann.page.selectOption('#rt', 'colleague'); await ann.page.fill('#nt', 'We work on the same team <b>hi</b>'); await ann.page.click('#inviteForm button[type=submit]');
await ann.page.waitForSelector('code.tok'); const link = (await ann.page.textContent('code.tok')).trim(); assert.match(link, /#\/i\/[A-Za-z0-9_-]{43}$/);
await shot(ann, '2-link');
// Bob opens the link signed out, registers, sees the preview
await bob.page.goto(link);
await bob.page.waitForSelector('.notice'); assert.ok(!bob.page.url().includes('#/i/'), 'token removed from the address bar');
await bob.page.click('#swap'); await bob.page.fill('#dn', 'Bob'); await bob.page.fill('#em', 'bob@example.test'); await bob.page.fill('#pw', 'correct horse battery'); await bob.page.click('#authForm button[type=submit]');
await bob.page.waitForSelector('text=invited you to connect'); assert.ok((await bob.page.textContent('.msg')).includes('<b>hi</b>'), 'note shown as text');
assert.equal(await bob.page.locator('.msg b').count(), 0); await shot(bob, '1-landing');
await bob.page.click('button:has-text("Accept")'); await bob.page.waitForSelector('text=Request sent');
// Ann sees a pending request that needs HER answer; confirms independently
await tab(ann, 'Connections'); await ann.page.waitForSelector('text=Needs your answer'); await shot(ann, '3-pending');
await ann.page.click('button[data-do=confirm]'); await ann.page.waitForSelector('.pill.ok:has-text("Connected")');
await tab(bob, 'Connections'); await bob.page.waitForSelector('.pill.ok:has-text("Connected")');
// permission toggle (Bob) pauses introductions, restoring works
await bob.page.locator('input[data-do=perm]').uncheck(); await bob.page.waitForSelector('text=Not used for introduction routes right now.');
await bob.page.locator('input[data-do=perm]').check(); await bob.page.waitForSelector('text=Active for introduction routes.'); await shot(bob, '2-connected');
// used single-use link is unavailable for a third person
const cara = await person('cara'); await register(cara, 'Cara', 'cara@example.test'); await tab(cara, 'Invitations');
await cara.page.fill('#pl', link); await cara.page.click('#pasteForm button'); await cara.page.waitForSelector('text=Link unavailable'); await shot(cara, '1-unavailable');
// find-me link + search by link
await tab(ann, 'Profile'); await ann.page.locator('input[data-k=discoverable]').check(); await ann.page.waitForSelector('text=Saved').catch(() => {});
await tab(ann, 'Invitations'); await ann.page.click('button:has-text("Create find-me link")'); await ann.page.waitForSelector('code.tok:has-text("#/t/")'); const tlink = (await ann.page.textContent('code.tok')).trim(); assert.match(tlink, /#\/t\//);
await tab(cara, 'Find'); await cara.page.fill('#lk', tlink); await cara.page.click('#searchForm button[type=submit]'); await cara.page.waitForSelector('.who strong'); 
assert.ok((await cara.page.textContent('#searchForm')).includes('No introduction route'), 'no confirmed path yet: honest empty state'); await shot(cara, '2-search');
// Bob blocks Ann; Ann's view shows the connection ended and nothing mentions a block
await bob.page.click('button[data-do=blockConn]'); await bob.page.waitForSelector('text=Blocked').catch(() => {});
await tab(ann, 'Connections'); await ann.page.click('button.chip:has-text("Ended")'); await ann.page.waitForSelector('.pill:has-text("Ended")');
assert.ok(!(await ann.page.content()).toLowerCase().includes('blocked'), 'blocked user is not told');
await shot(ann, '4-ended');
// responsive: no horizontal scroll on any tab
for (const t of ['Find', 'Connections', 'Invitations', 'Profile']) { await tab(ann, t); await ann.page.waitForTimeout(300); const w = await ann.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); assert.ok(w[0] <= w[1], `${t} overflows ${w}`); }
assert.deepEqual(errors, [], 'no page errors / console errors');
await browser.close(); console.log('E2E PASSED');
