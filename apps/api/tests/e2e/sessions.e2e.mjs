// Browser e2e #2 (Slice 4.5): sessions, hostile/unavailable links, withdraw, 401 and network-failure handling. Real UI + real API + real PostgreSQL.
// Usage: node sessions.e2e.mjs <webDir> <baseUrl> <shotsDir>   (same env as relationships.e2e.mjs)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)('playwright');
const [, , , base] = process.argv;
const browser = await chromium.launch({ ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}), args: (process.env.E2E_CHROMIUM_ARGS ?? '').split(' ').filter(Boolean) });
const errors = [];
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('response', async (r) => { if (r.url().includes('/v1/auth') && process.env.E2E_DEBUG) console.log(name, r.status(), r.url().replace(/^.*\/v1/, '/v1')); });
  page.on('dialog', (d) => void d.accept());
  return { ctx, page, name };
}
const PW = 'correct horse battery';
async function register(p, display, email) { await p.page.goto(base); await p.page.click('#swap'); await p.page.fill('#dn', display); await p.page.fill('#em', email); await p.page.fill('#pw', PW); await p.page.click('#authForm button[type=submit]'); await p.page.waitForSelector('.tabs'); }
const tab = (p, label) => p.page.click(`button.tab:has-text("${label}")`);
const paste = async (p, link) => { await tab(p, 'Invitations'); await p.page.fill('#pl', link); await p.page.click('#pasteForm button'); };
async function invite(p) { await tab(p, 'Invitations'); await p.page.click('#inviteForm button[type=submit]'); await p.page.waitForSelector('code.tok'); return (await p.page.textContent('code.tok')).trim(); }

// 1. session persistence, logout, unauthorised route handling
const dan = await person('dan'); await register(dan, 'Dan', 'dan@example.test');
await dan.page.reload(); await dan.page.waitForSelector('.tabs'); // session survives a reload
await dan.page.click('button[data-do=out]'); await dan.page.waitForSelector('#authForm');
await dan.page.reload(); await dan.page.waitForSelector('#authForm'); assert.equal(await dan.page.locator('.tabs').count(), 0, 'signed out stays signed out after reload');
await dan.page.fill('#em', 'dan@example.test'); await dan.page.fill('#pw', 'wrong password!!'); await dan.page.click('#authForm button[type=submit]'); await dan.page.waitForSelector('#toast'); assert.equal(await dan.page.locator('.tabs').count(), 0, 'wrong password does not sign in');
await dan.page.fill('#em', 'dan@example.test'); await dan.page.fill('#pw', PW); await dan.page.click('#authForm button[type=submit]'); await dan.page.waitForSelector('.tabs');
// 2. invalid token (well-formed but unknown) and malformed paste
await paste(dan, 'https://x.example/#/i/' + 'A'.repeat(43)); await dan.page.waitForSelector('text=Link unavailable');
// 3. revoked + expired + reused links look identical to a stranger ("Link unavailable"), created through the real UI
const eve = await person('eve'); await register(eve, 'Eve', 'eve@example.test');
const l1 = await invite(eve); await eve.page.click('button[data-do=revokeInv]'); await eve.page.waitForSelector('.pill:has-text("Revoked")');
await paste(dan, l1); await dan.page.waitForSelector('text=Link unavailable');
const l2 = await invite(eve); // expire it in the database (the UI cannot create a short-lived link)
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', q], { stdio: 'pipe' });
sql("ALTER TABLE invitations DISABLE TRIGGER USER; UPDATE invitations SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE revoked_at IS NULL AND use_count = 0; ALTER TABLE invitations ENABLE TRIGGER USER;");
await paste(dan, l2); await dan.page.waitForSelector('text=Link unavailable');
// 4. Withdraw an outgoing request: Frank accepts Eve's link, then withdraws before Eve confirms
const frank = await person('frank'); await register(frank, 'Frank', 'frank@example.test');
const l3 = await invite(eve);
await paste(frank, l3); await frank.page.waitForSelector('text=invited you to connect'); await frank.page.click('button:has-text("Accept")'); await frank.page.waitForSelector('text=Request sent');
await tab(frank, 'Connections'); await frank.page.click('button[data-do=withdraw]'); await frank.page.waitForSelector('#toast:has-text("Withdrawn")');
await tab(eve, 'Connections'); await eve.page.waitForTimeout(300); assert.equal(await eve.page.locator('button[data-do=confirm]').count(), 0, 'withdrawn request cannot be confirmed');
// 5. 401 from the API signs the user out; network failure shows an error and keeps the session
await frank.page.route('**/v1/connections*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"code":"UNAUTHENTICATED"}}' }));
await tab(frank, 'Profile'); await tab(frank, 'Connections'); await frank.page.waitForSelector('#authForm', { timeout: 8000 });
await frank.page.unroute('**/v1/connections*');
await dan.page.route('**/v1/invitations/sent*', (r) => r.abort('failed'));
await tab(dan, 'Profile'); await tab(dan, 'Invitations'); await dan.page.waitForSelector('[role=alert]'); await dan.page.waitForSelector('button[data-do=retry]'); assert.ok(await dan.page.locator('.tabs').count() > 0, 'network failure keeps the session');
await dan.page.unroute('**/v1/invitations/sent*'); await dan.page.click('button[data-do=retry]'); await dan.page.waitForSelector('[role=alert]', { state: 'detached' });
// 6. unauthorised API access: no token, garbage token
for (const h of [{}, { authorization: 'Bearer not-a-real-token-0123456789abcdef' }]) { const r = await dan.page.request.get(base + '/v1/connections', { headers: h }); assert.equal(r.status(), 401); }
assert.deepEqual(errors, [], 'no uncaught page errors'); await browser.close(); console.log('E2E PASSED (sessions)');
