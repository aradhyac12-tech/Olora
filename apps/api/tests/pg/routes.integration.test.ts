// The relationship HTTP surface (route table -> services -> real PostgreSQL), through a node:http adapter. SKIPPED without DATABASE_URL.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InvitationService } from '../../src/social/invitations.ts';
import { ConnectionService } from '../../src/social/connections.ts';
import { ProfileService } from '../../src/social/profile.ts';
import { SafetyService } from '../../src/social/safety.ts';
import { AccountService } from '../../src/social/account.ts';
import { IntroductionService } from '../../src/introductions/service.ts';
import { SearchService, pgSearchDeps } from '../../src/search/service.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { RateLimiter } from '../../src/social/rateLimit.ts';
import { startHttp } from '../support/httpAdapter.ts';
import type { SocialPool } from '../../src/social/db.ts';

const URL_ = process.env.DATABASE_URL;
const skip = URL_ ? false : 'DATABASE_URL not set — HTTP relationship tests NOT RUN';
let pool: (SocialPool & { end(): Promise<void> }) | null = null;
const closers: Array<() => Promise<void>> = [];
async function db() { if (pool) return pool; const m: string = 'pg'; const pg = await import(m); pool = new pg.default.Pool({ connectionString: URL_, max: 8 }); return pool!; }
const q = async (s: string, p: unknown[] = []) => (await (await db()).query(s, p)).rows;
async function mkUser(name: string, o: { discoverable?: boolean; accepts?: boolean } = {}) {
  const id = randomUUID(); await q(`INSERT INTO users (id,email,display_name,discoverable,accepts_introductions) VALUES ($1,$2,$3,$4,$5)`, [id, `${id}@example.test`, name, o.discoverable ?? false, o.accepts ?? false]); return id;
}
let kn = 0; const idem = () => `route-test-${process.pid}-${++kn}-${Math.random().toString(36).slice(2, 8)}`;

async function boot(limits: Record<string, number> = {}) {
  const p = await db();
  await p.query('TRUNCATE introduction_idempotency, audit_events, notification_outbox, introduction_requests, blocks, consents, relationship_confirmations, relationship_evidence, relationships, external_profiles, users CASCADE');
  const h = await startHttp({ invitations: new InvitationService(p), connections: new ConnectionService(p), profile: new ProfileService(p), safety: new SafetyService(p), account: new AccountService(p),
    intro: new IntroductionService(p), search: new SearchService(pgSearchDeps(p)), limiter: new RateLimiter(), limits });
  closers.push(h.close);
  const call = async (as: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(h.url + path, { method, headers: { ...(as ? { authorization: `Bearer ${as}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null, text };
  };
  return { call, h };
}

test('HTTP: full journey invite -> accept -> confirm -> connections -> search by shared link -> introduction request', { skip }, async () => {
  const { call } = await boot();
  const rita = await mkUser('Rita'), cara = await mkUser('Cara', { accepts: true }), tom = await mkUser('Tom');
  // Tom publishes a target link (needs to be discoverable first: defaults are private)
  assert.equal((await call(tom, 'POST', '/v1/invitations', { purpose: 'introduce' }, { 'idempotency-key': idem() })).status, 403);
  assert.equal((await call(tom, 'PUT', '/v1/privacy', { discoverable: true })).status, 200);
  const link = await call(tom, 'POST', '/v1/invitations', { purpose: 'introduce' }, { 'idempotency-key': idem() });
  assert.equal(link.status, 201); const tomToken: string = link.json.token;
  // Cara <-> Tom, Rita <-> Cara via connect links
  for (const [a, b] of [[tom, cara], [cara, rita]] as const) {
    const inv = await call(a, 'POST', '/v1/invitations', { purpose: 'connect', relationshipType: 'colleague', note: 'work together' }, { 'idempotency-key': idem() });
    assert.equal(inv.status, 201); assert.match(inv.json.token, /^[A-Za-z0-9_-]{43}$/);
    const pv = await call(b, 'POST', '/v1/invitations/preview', { token: inv.json.token });
    assert.equal(pv.status, 200); assert.equal(pv.json.invitation.existing, 'none');
    const acc = await call(b, 'POST', '/v1/invitations/accept', { token: inv.json.token });
    assert.equal(acc.status, 201); assert.equal(acc.json.connection.status, 'pending');
    assert.equal((await call(b, 'POST', '/v1/invitations/accept', { token: inv.json.token })).status, 200, 'replay is a 200, not an error');
    const cid: string = acc.json.connection.id;
    const waiting = await call(a, 'GET', '/v1/connections?status=pending'); assert.equal(waiting.json.connections[0].awaiting, 'you');
    assert.equal((await call(a, 'POST', `/v1/connections/${cid}/confirm`)).status, 200, 'empty-body POST works');
    assert.equal((await call(b, 'GET', `/v1/connections/${cid}`)).json.connection.status, 'confirmed');
  }
  const found = await call(rita, 'POST', '/v1/search/by-link', { token: tomToken });
  assert.equal(found.status, 200); assert.equal(found.json.status, 'found'); assert.equal(found.json.target.displayName, 'Tom');
  assert.equal(found.json.routes[0].connector.displayName, 'Cara'); assert.equal(found.json.routes[0].canRequest, true);
  assert.ok(!found.text.includes(tom), 'target internal id never reaches the client');
  const connectorId = await q(`SELECT id FROM users WHERE display_name='Cara'`).then((r) => r[0]!.id as string);
  // introduction by LINK (no UUID typed anywhere)
  await call(cara, 'PUT', '/v1/privacy', { acceptsIntroductions: true });
  const intro = await call(rita, 'POST', '/v1/introductions', { connectorId, targetToken: tomToken, message: 'Hi Cara, could you introduce me?' }, { 'idempotency-key': idem() });
  assert.equal(intro.status, 201, intro.text);
  // either target selector but not both / neither
  assert.equal((await call(rita, 'POST', '/v1/introductions', { connectorId, message: 'x' }, { 'idempotency-key': idem() })).status, 400);
  assert.equal((await call(rita, 'POST', '/v1/introductions', { connectorId, targetId: tom, targetToken: tomToken, message: 'x' }, { 'idempotency-key': idem() })).status, 400);
  // a dead link is indistinguishable from "no eligible path"
  const dead = await call(rita, 'POST', '/v1/introductions', { connectorId, targetToken: 'A'.repeat(43), message: 'x' }, { 'idempotency-key': idem() });
  assert.equal(dead.status, 422);
});

test('HTTP: every route requires a session; unknown routes 404; malformed JSON 400', { skip }, async () => {
  const { call, h } = await boot(); const u = await mkUser('U');
  for (const [m, p] of [['GET', '/v1/connections'], ['POST', '/v1/invitations/accept'], ['GET', '/v1/profile'], ['PUT', '/v1/privacy'], ['POST', '/v1/blocks'], ['GET', '/v1/account/export']] as const) assert.equal((await call(null, m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  assert.equal((await call(u, 'GET', '/v1/nope')).status, 404);
  const bad = await fetch(h.url + '/v1/privacy', { method: 'PUT', headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: '{nope' }); assert.equal(bad.status, 400);
});

test('HTTP validation: unknown keys, wrong types, bad ids/tokens are 400/404 and never echo submitted values', { skip }, async () => {
  const { call } = await boot(); const u = await mkUser('U'); const secret = 'SuperSecretValue123';
  const cases: Array<[string, string, unknown, number]> = [
    ['PATCH', '/v1/profile', { displayName: secret, isAdmin: true }, 400], ['PATCH', '/v1/profile', {}, 400], ['PATCH', '/v1/profile', { avatarUrl: 'http://x.example/a.png' }, 400],
    ['PATCH', '/v1/profile', { avatarUrl: 'https://127.0.0.1/a.png' }, 400], ['PATCH', '/v1/profile', { avatarUrl: 'javascript:alert(1)' }, 400],
    ['PUT', '/v1/privacy', { discoverable: 'yes' }, 400], ['PUT', '/v1/privacy', {}, 400],
    ['POST', '/v1/invitations/preview', { token: secret }, 400], ['POST', '/v1/invitations/accept', { token: 'x', extra: 1 }, 400],
    ['POST', '/v1/blocks', { subject: { userId: randomUUID() } }, 400], ['POST', '/v1/identities', { platform: 'instagram', username: '<script>' }, 400],
    ['GET', '/v1/connections?status=bogus', undefined, 400], ['GET', '/v1/connections/not-a-uuid', undefined, 404], ['POST', '/v1/connections/not-a-uuid/revoke', undefined, 404],
  ];
  for (const [m, p, b, st] of cases) { const r = await call(u, m, p, b, { 'idempotency-key': idem() }); assert.equal(r.status, st, `${m} ${p} ${JSON.stringify(b)} -> ${r.text}`); assert.ok(!r.text.includes(secret), 'submitted value echoed'); }
  const noKey = await call(u, 'POST', '/v1/invitations', { purpose: 'connect', relationshipType: 'family' }); assert.equal(noKey.status, 400, 'idempotency key required');
  const badUrl = await call(u, 'POST', '/v1/invitations', { purpose: 'connect', relationshipType: 'spouse' }, { 'idempotency-key': idem() }); assert.equal(badUrl.status, 400);
});

test('HTTP IDOR: another user cannot read, confirm, revoke or re-permission my connection, or revoke my invitation; errors are identical to "not found"', { skip }, async () => {
  const { call } = await boot(); const a = await mkUser('Ann'), b = await mkUser('Bob'), x = await mkUser('Xavier');
  const inv = await call(a, 'POST', '/v1/invitations', { purpose: 'connect', relationshipType: 'friend'.length ? 'acquaintance' : 'acquaintance' }, { 'idempotency-key': idem() });
  const acc = await call(b, 'POST', '/v1/invitations/accept', { token: inv.json.token }); const cid: string = acc.json.connection.id;
  const missing = randomUUID();
  const probes: Array<[string, string, unknown?]> = [['GET', `/v1/connections/${cid}`], ['POST', `/v1/connections/${cid}/confirm`], ['POST', `/v1/connections/${cid}/revoke`], ['POST', `/v1/connections/${cid}/decline`], ['PUT', `/v1/connections/${cid}/permission`, { allowIntroductions: false }], ['POST', `/v1/invitations/${inv.json.invitation.id}/revoke`]];
  for (const [m, p, body] of probes) {
    const real = await call(x, m, p, body); const fake = await call(x, m, p.replace(cid, missing).replace(inv.json.invitation.id, missing), body);
    assert.equal(real.status, 404, `${m} ${p}`); assert.deepEqual(real.json, fake.json, 'indistinguishable from a nonexistent id');
  }
  assert.equal((await call(a, 'GET', `/v1/connections/${cid}`)).json.connection.status, 'pending', 'nothing changed');
  assert.deepEqual((await call(x, 'GET', '/v1/connections')).json.connections, []);
  assert.equal((await call(x, 'GET', '/v1/invitations/sent')).json.invitations.length, 0);
});

test('HTTP responses never contain other users\' ids/emails, token hashes, or internal reasons', { skip }, async () => {
  const { call } = await boot(); const a = await mkUser('Ann'), b = await mkUser('Bob');
  const inv = await call(a, 'POST', '/v1/invitations', { purpose: 'connect', relationshipType: 'colleague' }, { 'idempotency-key': idem() });
  const acc = await call(b, 'POST', '/v1/invitations/accept', { token: inv.json.token }); const cid = acc.json.connection.id;
  await call(a, 'POST', `/v1/connections/${cid}/confirm`); await call(b, 'POST', '/v1/blocks', { subject: { connectionId: cid } });
  const hash = (await q('SELECT token_hash FROM invitations'))[0]!.token_hash as string;
  const texts = [(await call(a, 'GET', '/v1/connections')).text, (await call(a, 'GET', `/v1/connections/${cid}`)).text, (await call(a, 'GET', '/v1/invitations/sent')).text, (await call(a, 'GET', '/v1/blocks')).text, (await call(a, 'GET', '/v1/profile')).text, (await call(b, 'GET', '/v1/connections')).text, (await call(b, 'GET', '/v1/blocks')).text];
  for (const t of texts) { for (const bad of [b, a, `${b}@example.test`, hash, 'blocked', 'ended_reason']) { if (t.includes(`"${bad}"`) || (bad === `${b}@example.test` && t.includes(bad)) || bad === hash && t.includes(bad)) { if (t === texts[4] && bad === a) continue; assert.fail(`leaked ${bad} in ${t}`); } } }
  const aView = JSON.parse(texts[1]!).connection; assert.equal(aView.status, 'ended'); assert.equal(aView.endedByMe, false);
  assert.equal(JSON.parse(texts[3]!).blocks.length, 0, 'the blocked party sees nothing');
});

test('HTTP rate limits: token guessing is throttled (failures lock the caller out), per-user mutation cap, Retry-After set', { skip }, async () => {
  const { call } = await boot({ tokenFailUser: 3, tokenFailIp: 100, tokenUser: 100, tokenIp: 1000, mutateUser: 5 });
  const u = await mkUser('Guesser'), v = await mkUser('Other'), z = await mkUser('Friend');
  const guess = () => call(u, 'POST', '/v1/invitations/preview', { token: Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43) });
  for (let i = 0; i < 3; i++) assert.equal((await guess()).status, 404);
  const locked = await guess(); assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('retry-after')) >= 1);
  const real = await call(v, 'POST', '/v1/invitations', { purpose: 'connect', relationshipType: 'family' }, { 'idempotency-key': idem() });
  assert.equal((await call(u, 'POST', '/v1/invitations/preview', { token: real.json.token })).status, 429, 'a locked-out caller cannot use even a valid token');
  assert.equal((await call(z, 'POST', '/v1/invitations/preview', { token: real.json.token })).status, 200, 'other users unaffected');
  const w = await mkUser('Spammer'); let last = 0;
  for (let i = 0; i < 8; i++) last = (await call(w, 'POST', `/v1/connections/${randomUUID()}/revoke`)).status;
  assert.equal(last, 429);
  const ip = await boot({ tokenFailIp: 2, tokenFailUser: 100 }); const p1 = await mkUser('P1'), p2 = await mkUser('P2');
  const g = (as: string) => ip.call(as, 'POST', '/v1/invitations/preview', { token: 'B'.repeat(43) }, { 'x-test-ip': '198.51.100.9' });
  await g(p1); await g(p2); assert.equal((await g(p1)).status, 429, 'IP-level lockout covers account rotation');
});

test('HTTP: blocks, reports, privacy, identities, export and delete behave and are idempotent', { skip }, async () => {
  const { call } = await boot(); const a = await mkUser('Ann'), b = await mkUser('Bob');
  const inv = await call(b, 'POST', '/v1/invitations', { purpose: 'connect', relationshipType: 'classmate' }, { 'idempotency-key': idem() });
  const blk = await call(a, 'POST', '/v1/blocks', { subject: { invitationToken: inv.json.token } }); assert.equal(blk.status, 201);
  assert.equal((await call(a, 'POST', '/v1/blocks', { subject: { invitationToken: inv.json.token } })).json.block.id, blk.json.block.id);
  assert.equal((await call(a, 'POST', '/v1/invitations/accept', { token: inv.json.token })).status, 404, 'cannot accept the link of someone I blocked');
  assert.equal((await call(a, 'DELETE', `/v1/blocks/${blk.json.block.id}`)).json.removed, true);
  assert.equal((await call(a, 'DELETE', `/v1/blocks/${blk.json.block.id}`)).json.removed, false);
  assert.equal((await call(b, 'DELETE', `/v1/blocks/${randomUUID()}`)).status, 200);
  const k = idem(); const rep = await call(a, 'POST', '/v1/reports', { subject: { invitationToken: inv.json.token }, reason: 'spam' }, { 'idempotency-key': k });
  assert.equal(rep.status, 201); assert.equal((await call(a, 'POST', '/v1/reports', { subject: { invitationToken: inv.json.token }, reason: 'spam' }, { 'idempotency-key': k })).json.report.id, rep.json.report.id);
  assert.equal((await call(a, 'POST', '/v1/reports', { subject: { invitationToken: inv.json.token }, reason: 'spam' })).status, 400, 'report requires an idempotency key');
  const idn = await call(a, 'POST', '/v1/identities', { platform: 'instagram', username: '@ann.lee' }); assert.equal(idn.json.profile.identities[0].username, 'ann.lee'); assert.equal(idn.json.profile.identities[0].verification, 'unverified');
  const pr = await call(a, 'GET', '/v1/profile'); assert.equal(pr.json.profile.discoverable, false); assert.equal(pr.json.profile.acceptsIntroductions, false);
  const ex = await call(a, 'GET', '/v1/account/export'); assert.equal(ex.status, 200); assert.match(ex.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal((await call(a, 'POST', '/v1/account/delete', { confirm: 'nope' })).status, 400);
  assert.equal((await call(a, 'POST', '/v1/account/delete', { confirm: 'delete my account' })).status, 200);
  assert.equal((await q(`SELECT count(*)::int AS n FROM users WHERE id=$1`, [a]))[0]!.n, 0);
});

test('HTTP: account delete with a password account — wrong/missing password is 403 INVALID_CREDENTIALS (NOT 401: the client signs out on 401), correct password deletes', { skip }, async () => {
  const { call } = await boot();
  const a = await mkUser('Pw User');
  await q(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)`, [a, await hashPassword('correct horse battery')]);
  const body = (password?: string) => ({ confirm: 'delete my account', ...(password === undefined ? {} : { password }) });
  for (const b of [body('wrong-password'), body()]) {
    const r = await call(a, 'POST', '/v1/account/delete', b);
    assert.equal(r.status, 403); assert.deepEqual(r.json, { error: { code: 'INVALID_CREDENTIALS' } });
  }
  assert.equal((await q(`SELECT count(*)::int AS n FROM users WHERE id=$1`, [a]))[0]!.n, 1, 'a failed attempt deletes nothing');
  const ok = await call(a, 'POST', '/v1/account/delete', body('correct horse battery'));
  assert.equal(ok.status, 200);
  assert.equal((await q(`SELECT count(*)::int AS n FROM users WHERE id=$1`, [a]))[0]!.n, 0);
});

after(async () => { for (const c of closers) await c(); if (pool) await pool.end(); });
