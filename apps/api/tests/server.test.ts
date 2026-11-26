import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server/app.ts';
import type { AuthPort, IntroService, SearchPort } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';

const U = '00000000-0000-4000-8000-000000000001', NOW = new Date('2026-11-25T12:00:00Z'), GOOD = 'good-token-0123456789abcdef';
const rec = { id: 'r', requesterId: U, connectorId: 'c', targetId: 't', status: 'pending_connector' as const, message: 'm', version: 1, createdAt: NOW, expiresAt: NOW, decidedAt: null };
function fake(over: Partial<IntroService> = {}, authOver: Partial<AuthPort> = {}, opts: { authRateLimit?: { max: number; timeWindow: number }; searchRateLimit?: { max: number; timeWindow: number }; search?: SearchPort; corsOrigins?: string[] } = {}) {
  const calls: unknown[][] = [];
  const service: IntroService = {
    create: async (...a) => { calls.push(['create', ...a]); return { ok: true, value: rec, replayed: false }; },
    transition: async (...a) => { calls.push(['transition', ...a]); return { ok: true, value: rec, replayed: false }; },
    get: async (...a) => { calls.push(['get', ...a]); return { ok: true, value: rec, replayed: false }; },
    list: async (...a) => { calls.push(['list', ...a]); return { ok: true, value: [{ ...rec, requesterName: 'R', connectorName: 'C', targetName: 'T' }], replayed: false }; }, ...over };
  const auth: AuthPort = {
    register: async (i) => { calls.push(['register', i]); return { ok: true, value: { userId: U } }; },
    login: async (e, p) => { calls.push(['login', e, p]); return p === 'right-password' ? { ok: true, value: { token: GOOD, userId: U, expiresAt: NOW } } : { ok: false, code: 'INVALID_CREDENTIALS' }; },
    loginWithOAuth: async (t) => { calls.push(['oauth', t]); return t === 'good-supabase-token-0123456789' ? { ok: true, value: { token: GOOD, userId: U, expiresAt: NOW } } : { ok: false, code: 'INVALID_CREDENTIALS' }; },
    authenticate: async (t) => (t === GOOD ? U : null),
    logout: async (t) => { calls.push(['logout', t]); }, logoutAll: async (u) => { calls.push(['logoutAll', u]); return 2; }, ...authOver };
  return { app: buildApp({ service, auth, ...opts }), calls };
}
const auth = { authorization: `Bearer ${GOOD}` };
const body = { connectorId: 'c', targetId: 't', message: 'hello' };

test('passwords: round-trip, wrong password, unique salts, scrypt$ format, no plaintext in the hash', async () => {
  const h = await hashPassword('correct horse battery'); const h2 = await hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$16384$8$1$') && !h.includes('correct') && h !== h2);
  assert.ok(await verifyPassword('correct horse battery', h)); assert.ok(!(await verifyPassword('correct horse batterz', h)));
  assert.ok(await verifyPassword('cafe\u0301 password', await hashPassword('caf\u00e9 password')), 'NFKC-normalised so equivalent Unicode forms match');
});

test('passwords: malformed or hostile stored hashes are rejected without doing unbounded work', async () => {
  for (const bad of ['', 'plaintext', 'scrypt$1$2', 'scrypt$99999999999$8$1$c2FsdA==$aGFzaA==', 'scrypt$16384$999$1$c2FsdA==$aGFzaA==', 'bcrypt$16384$8$1$c2FsdA==$aGFzaGhhc2hoYXNoaGFzaA==', 'scrypt$16384$8$1$c2FsdA==$AA=='])
    assert.equal(await verifyPassword('x', bad), false, bad);
});

test('config: fails fast on missing/invalid values', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://x' }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x', API_PORT: '99999' }), /API_PORT/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x', TRUST_PROXY: 'yes' }), /TRUST_PROXY/);
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://x', TRUST_PROXY: 'true' }).trustProxy, true);
  assert.deepEqual(loadConfig({ DATABASE_URL: 'postgres://x' }), { databaseUrl: 'postgres://x', databaseSsl: 'auto', port: 3000, host: '127.0.0.1', logLevel: 'info', corsOrigins: [], trustProxy: false, supabase: null });
});

test('healthz and the auth endpoints are open; everything else under /v1 needs a live session (401, no service call)', async () => {
  const { app, calls } = fake();
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic abc' }, { authorization: 'Bearer ' }]) {
    for (const url of ['/v1/introductions/abc', '/v1/me', '/v1/introductions/abc?x=1']) {
      const r = await app.inject({ method: 'GET', url, headers }); assert.equal(r.statusCode, 401, url); assert.deepEqual(r.json(), { error: { code: 'UNAUTHENTICATED' } });
    }
  }
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout' })).statusCode, 401);
  assert.equal(calls.length, 0);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json(), { userId: U });
});

test('login: success returns token/userId with no-store; wrong password is a uniform 401; registration validates strictly', async () => {
  const { app, calls } = fake();
  const ok = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@example.test', password: 'right-password' } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.headers['cache-control'], 'no-store'); assert.equal(ok.json().token, GOOD);
  const no = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@example.test', password: 'wrong' } });
  assert.equal(no.statusCode, 401); assert.deepEqual(no.json(), { error: { code: 'INVALID_CREDENTIALS' } });
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'a@example.test', password: 'long-enough-pw', displayName: 'A' } });
  assert.equal(reg.statusCode, 201); assert.deepEqual(reg.json(), { userId: U });
  const n = calls.length;
  for (const p of [{ email: 'a@example.test', password: 'x'.repeat(129), displayName: 'A' }, { email: 'a@example.test', password: 'long-enough-pw' }, { email: 'a@example.test', password: 'long-enough-pw', displayName: 'A', isAdmin: true }])
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/register', payload: p })).statusCode, 400);
  assert.equal(calls.length, n, 'invalid registrations never reach the service');
  const taken = fake({}, { register: async () => ({ ok: false, code: 'EMAIL_TAKEN' }) });
  assert.equal((await taken.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'a@example.test', password: 'long-enough-pw', displayName: 'A' } })).statusCode, 409);
});

test('logout revokes THIS token; logout-all revokes every session of the authenticated user', async () => {
  const { app, calls } = fake();
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: auth })).statusCode, 204);
  assert.deepEqual((await app.inject({ method: 'POST', url: '/v1/auth/logout-all', headers: auth })).json(), { revoked: 2 });
  assert.deepEqual(calls, [['logout', GOOD], ['logoutAll', U]]);
});

test('rate limit: login/register are limited per IP (429 RATE_LIMITED) while normal endpoints are not', async () => {
  const { app } = fake({}, {}, { authRateLimit: { max: 3, timeWindow: 60_000 } });
  const login = () => app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@example.test', password: 'wrong' } });
  assert.deepEqual([(await login()).statusCode, (await login()).statusCode, (await login()).statusCode], [401, 401, 401]);
  const blocked = await login(); assert.equal(blocked.statusCode, 429); assert.deepEqual(blocked.json(), { error: { code: 'RATE_LIMITED' } });
  for (let i = 0; i < 8; i++) assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: auth })).statusCode, 200);
});

test('create: passes the AUTHENTICATED user (never one from the body) and the Idempotency-Key; 201, replay => 200', async () => {
  const { app, calls } = fake();
  const r = await app.inject({ method: 'POST', url: '/v1/introductions', headers: { ...auth, 'idempotency-key': 'key-12345678' }, payload: { ...body } });
  assert.equal(r.statusCode, 201); assert.equal(r.headers['idempotent-replayed'], 'false');
  assert.deepEqual(calls[0], ['create', U, body, 'key-12345678']);
  const { app: a2 } = fake({ create: async () => ({ ok: true, value: rec, replayed: true }) });
  const r2 = await a2.inject({ method: 'POST', url: '/v1/introductions', headers: auth, payload: body });
  assert.equal(r2.statusCode, 200); assert.equal(r2.headers['idempotent-replayed'], 'true');
});

test('validation: extra/missing/wrong-typed fields, bad action and bad JSON => 400, oversize body => 413 (all code-only, service untouched)', async () => {
  const { app, calls } = fake();
  const post = (url: string, payload: unknown, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers: { ...auth, ...extra }, payload: payload as string });
  for (const p of [{ ...body, requesterId: 'evil' }, { connectorId: 'c' }, { ...body, message: 5 }, { ...body, message: 'x'.repeat(1001) }]) {
    const r = await post('/v1/introductions', p); assert.equal(r.statusCode, 400, JSON.stringify(p)); assert.deepEqual(r.json(), { error: { code: 'INVALID_INPUT' } });
  }
  assert.equal((await post('/v1/introductions/abc/transitions', { action: 'expire' })).statusCode, 400, 'system-only action is not exposed');
  assert.equal((await post('/v1/introductions/abc/transitions', { action: 'target_accept', extra: 1 })).statusCode, 400);
  assert.equal((await post('/v1/introductions', '{bad json', { 'content-type': 'application/json' })).statusCode, 400);
  const big = await post('/v1/introductions', JSON.stringify({ ...body, message: 'x'.repeat(9000) }), { 'content-type': 'application/json' });
  assert.equal(big.statusCode, 413); assert.deepEqual(big.json(), { error: { code: 'INVALID_INPUT' } });
  assert.equal(calls.length, 0);
});

test('service error codes map to stable HTTP statuses with a code-only body', async () => {
  const want: Record<string, number> = { NOT_FOUND: 404, FORBIDDEN: 403, INVALID_STATE: 409, DUPLICATE_OPEN: 409, EXPIRED: 410, NOT_ELIGIBLE: 422, IDEMPOTENCY_CONFLICT: 422, TOO_MANY_OPEN: 429, INTERNAL: 500, INVALID_INPUT: 400 };
  for (const [code, status] of Object.entries(want)) {
    const { app } = fake({ get: async () => ({ ok: false, code: code as never }) });
    const r = await app.inject({ method: 'GET', url: '/v1/introductions/abc', headers: auth });
    assert.equal(r.statusCode, status, code); assert.deepEqual(r.json(), { error: { code } });
  }
});

test('an unexpected throw becomes a generic 500 (no message/stack leaked); unknown routes are 404', async () => {
  const { app } = fake({ get: async () => { throw new Error('secret internals: password=hunter2'); } });
  const r = await app.inject({ method: 'GET', url: '/v1/introductions/abc', headers: auth });
  assert.equal(r.statusCode, 500); assert.ok(!r.body.includes('hunter2')); assert.deepEqual(r.json(), { error: { code: 'INTERNAL' } });
  assert.equal((await app.inject({ method: 'GET', url: '/nope' })).statusCode, 404);
});

test('CORS: allow-listed origin gets headers; preflight needs no token', async () => {
  const { app } = fake({}, {}, { corsOrigins: ['https://localhost'] });
  const pre = await app.inject({ method: 'OPTIONS', url: '/v1/introductions', headers: { origin: 'https://localhost', 'access-control-request-method': 'POST' } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'https://localhost');
  assert.match(String(pre.headers['access-control-allow-headers']), /Idempotency-Key/);
  const res = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://localhost' } });
  assert.equal(res.headers['access-control-allow-origin'], 'https://localhost');
});

test('CORS: unknown origin, or no allow-list, gets no CORS headers', async () => {
  const a = fake({}, {}, { corsOrigins: ['https://localhost'] }).app;
  const r1 = await a.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' } });
  assert.equal(r1.headers['access-control-allow-origin'], undefined);
  const b = fake().app;
  const r2 = await b.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://localhost' } });
  assert.equal(r2.headers['access-control-allow-origin'], undefined);
});

test('config: CORS_ORIGINS parsed, wildcard refused', () => {
  const base = { DATABASE_URL: 'postgres://u:p@h/db' };
  assert.deepEqual(loadConfig({ ...base, CORS_ORIGINS: 'https://localhost, http://localhost' }).corsOrigins, ['https://localhost', 'http://localhost']);
  assert.throws(() => loadConfig({ ...base, CORS_ORIGINS: '*' }), /exact origins/);
});

test('oauth route: public, strict body, maps result codes', async () => {
  const { app, calls } = fake();
  const ok = await app.inject({ method: 'POST', url: '/v1/auth/oauth/supabase', payload: { accessToken: 'good-supabase-token-0123456789' } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.json().token, GOOD); assert.equal(ok.headers['cache-control'], 'no-store');
  const bad = await app.inject({ method: 'POST', url: '/v1/auth/oauth/supabase', payload: { accessToken: 'nope-nope-nope-nope-nope' } });
  assert.equal(bad.statusCode, 401);
  const extra = await app.inject({ method: 'POST', url: '/v1/auth/oauth/supabase', payload: { accessToken: 'x'.repeat(30), admin: true } });
  assert.equal(extra.statusCode, 400);
  assert.equal(calls.filter((c) => c[0] === 'oauth').length, 2);
});

test('config: Supabase settings validated together', () => {
  const base = { DATABASE_URL: 'postgres://u:p@h/db' };
  assert.equal(loadConfig(base).supabase, null);
  assert.deepEqual(loadConfig({ ...base, SUPABASE_URL: 'https://abc123.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_' + 'x'.repeat(20) }).supabase?.url, 'https://abc123.supabase.co');
  assert.throws(() => loadConfig({ ...base, SUPABASE_URL: 'https://evil.example.com', SUPABASE_ANON_KEY: 'k'.repeat(30) }), /SUPABASE_URL/);
  assert.throws(() => loadConfig({ ...base, SUPABASE_URL: 'https://abc123.supabase.co' }), /SUPABASE_URL/);
});

test('list: needs a session, passes the AUTHENTICATED user, limit is optional and validated; response is no-store', async () => {
  const { app, calls } = fake();
  assert.equal((await app.inject('/v1/introductions')).statusCode, 401);
  const r = await app.inject({ method: 'GET', url: '/v1/introductions', headers: auth });
  assert.equal(r.statusCode, 200); assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.json().introductions[0].targetName, 'T');
  assert.deepEqual(calls.at(-1), ['list', U, undefined]);
  await app.inject({ method: 'GET', url: '/v1/introductions?limit=7', headers: auth }); assert.deepEqual(calls.at(-1), ['list', U, 7]);
  for (const q of ['limit=abc', 'limit=-1', 'limit=1000', 'x=1']) assert.equal((await app.inject({ method: 'GET', url: `/v1/introductions?${q}`, headers: auth })).statusCode, 400, q);
  const bad = fake({ list: async () => ({ ok: false, code: 'INVALID_INPUT' }) });
  assert.equal((await bad.app.inject({ method: 'GET', url: '/v1/introductions?limit=0', headers: auth })).statusCode, 400);
});

test('search: needs a session, strict query, passes the AUTHENTICATED user, no-store, rate limited; route absent without a search port', async () => {
  const out = { ok: true as const, value: { status: 'none_found' as const, routes: [] as [] } };
  const seen: unknown[][] = [];
  const search: SearchPort = { search: async (...a) => { seen.push(a); return out; } };
  const { app } = fake({}, {}, { search, searchRateLimit: { max: 4, timeWindow: 60_000 } }); // the two 400s below count toward the budget too (rate limit runs before validation): 2x400 + 2x200 allowed, 5th limited
  assert.equal((await app.inject('/v1/search?targetId=x')).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/search', headers: auth })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/search?targetId=x&extra=1', headers: auth })).statusCode, 400);
  const r = await app.inject({ method: 'GET', url: '/v1/search?targetId=abc', headers: auth });
  assert.equal(r.statusCode, 200); assert.equal(r.headers['cache-control'], 'no-store'); assert.deepEqual(r.json(), out.value); assert.deepEqual(seen[0], [U, 'abc']);
  await app.inject({ method: 'GET', url: '/v1/search?targetId=abc', headers: auth });
  const limited = await app.inject({ method: 'GET', url: '/v1/search?targetId=abc', headers: auth });
  assert.equal(limited.statusCode, 429); assert.deepEqual(limited.json(), { error: { code: 'RATE_LIMITED' } });
  const none = fake();
  assert.equal((await none.app.inject({ method: 'GET', url: '/v1/search?targetId=abc', headers: auth })).statusCode, 404);
  const bad = fake({}, {}, { search: { search: async () => ({ ok: false, code: 'INVALID_INPUT' }) } });
  assert.equal((await bad.app.inject({ method: 'GET', url: '/v1/search?targetId=abc', headers: auth })).statusCode, 400);
});

test('security headers: nosniff + no-referrer everywhere, no-store on /v1 (authenticated and 401 responses)', async () => {
  const { app } = fake();
  const ok = await app.inject({ method: 'GET', url: '/v1/me', headers: auth });
  const denied = await app.inject({ method: 'GET', url: '/v1/me' });
  for (const r of [ok, denied]) {
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.equal((await app.inject('/healthz')).headers['x-content-type-options'], 'nosniff');
});
