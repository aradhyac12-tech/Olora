// AuthService against REAL PostgreSQL (needs migrations 0001-0003; npm run test:pgstore applies them). Without DATABASE_URL every test is SKIPPED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AuthService } from '../../src/auth/service.ts';
import type { AuthPool } from '../../src/auth/service.ts';
import { jsonLogger } from '../../src/introductions/logger.ts';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set — PostgreSQL auth tests NOT RUN';
const PW = 'correct horse battery staple';
let pool: (AuthPool & { end(): Promise<void> }) | null = null;
async function db() { if (pool) return pool; const m: string = 'pg'; const pg = await import(m); pool = new pg.default.Pool({ connectionString: URL, max: 4 }) as AuthPool & { end(): Promise<void> }; return pool; }
const reset = async () => { await (await db()).query('TRUNCATE users CASCADE'); };
const count = async (sql: string, p: unknown[] = []) => Number(((await (await db()).query(sql, p)).rows[0] as { n: number }).n);
const reg = (s: AuthService, email = 'Alice@Example.test', pw = PW) => s.register({ email, password: pw, displayName: 'Alice' });

test('register + login + authenticate: session works; email is case-insensitive; token and password are never stored raw', { skip }, async () => {
  await reset(); const s = new AuthService(await db());
  const r = await reg(s); assert.ok(r.ok);
  const l = await s.login('  ALICE@example.test ', PW); assert.ok(l.ok, JSON.stringify(l));
  assert.equal(await s.authenticate(l.value.token), r.value.userId);
  const rows = (await (await db()).query('SELECT token_hash FROM auth_sessions')).rows as { token_hash: string }[];
  assert.deepEqual(rows.map((x) => x.token_hash), [createHash('sha256').update(l.value.token).digest('hex')]);
  const dump = JSON.stringify((await (await db()).query('SELECT * FROM auth_sessions, user_credentials, users')).rows);
  assert.ok(!dump.includes(l.value.token) && !dump.includes(PW), 'neither the raw token nor the password appears anywhere in the database');
  assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE email='alice@example.test' AND discoverable=false AND accepts_introductions=false`), 1, 'new accounts are private by default');
});

test('login failures are indistinguishable (unknown email / wrong password / inactive account) and create no session', { skip }, async () => {
  await reset(); const s = new AuthService(await db()); const r = await reg(s); assert.ok(r.ok);
  const codes = [await s.login('nobody@example.test', PW), await s.login('alice@example.test', 'wrong password!'), await s.login('', ''), await s.login('alice@example.test', 'x'.repeat(500))];
  assert.deepEqual(codes.map((c) => (c.ok ? 'ok' : c.code)), Array(4).fill('INVALID_CREDENTIALS'));
  for (const st of ['suspended', 'deactivated', 'deleted']) {
    await (await db()).query('UPDATE users SET account_status=$1 WHERE id=$2', [st, r.value.userId]);
    const x = await s.login('alice@example.test', PW); assert.ok(!x.ok && x.code === 'INVALID_CREDENTIALS', st);
  }
  assert.equal(await count('SELECT count(*)::int AS n FROM auth_sessions'), 0);
});

test('sessions: expire, can be revoked singly or all at once, and die with the account status', { skip }, async () => {
  await reset(); const d = await db(); let t = Date.now();
  const s = new AuthService(d, { sessionTtlMs: 60_000, now: () => new Date(t) }); const r = await reg(s); assert.ok(r.ok);
  const a = await s.login('alice@example.test', PW), b = await s.login('alice@example.test', PW); assert.ok(a.ok && b.ok && a.value.token !== b.value.token);
  assert.equal(await s.authenticate(a.value.token), r.value.userId);
  t += 61_000; assert.equal(await s.authenticate(a.value.token), null, 'expired');
  t -= 61_000;
  await s.logout(a.value.token); assert.equal(await s.authenticate(a.value.token), null, 'revoked'); assert.equal(await s.authenticate(b.value.token), r.value.userId, 'other session unaffected');
  const c = await s.login('alice@example.test', PW); assert.ok(c.ok);
  assert.equal(await s.logoutAll(r.value.userId), 2, 'b and c were still live'); assert.equal(await s.authenticate(b.value.token), null); assert.equal(await s.authenticate(c.value.token), null);
  const e = await s.login('alice@example.test', PW); assert.ok(e.ok);
  await d.query(`UPDATE users SET account_status='suspended' WHERE id=$1`, [r.value.userId]);
  assert.equal(await s.authenticate(e.value.token), null, 'a suspended account loses access immediately');
  assert.equal(await s.authenticate('x'), null); assert.equal(await s.authenticate('z'.repeat(300)), null); assert.equal(await s.authenticate(`${'a'.repeat(43)}`), null);
});

test('register: duplicate email (any case) => EMAIL_TAKEN; invalid input rejected; 8 concurrent registrations of one email create exactly one user', { skip }, async () => {
  await reset(); const s = new AuthService(await db());
  assert.ok((await reg(s)).ok);
  const dup = await reg(s, 'ALICE@example.test'); assert.ok(!dup.ok && dup.code === 'EMAIL_TAKEN');
  for (const bad of [{ email: 'not-an-email', password: PW, displayName: 'A' }, { email: 'b@example.test', password: 'short', displayName: 'A' }, { email: 'b@example.test', password: PW, displayName: '   ' }, { email: 'b@example.test', password: 'x'.repeat(129), displayName: 'A' }])
    assert.deepEqual(await s.register(bad), { ok: false, code: 'INVALID_INPUT' });
  await reset();
  const rs = await Promise.all(Array.from({ length: 8 }, () => reg(s, 'race@example.test')));
  assert.equal(rs.filter((x) => x.ok).length, 1, JSON.stringify(rs.filter((x) => !x.ok))); assert.deepEqual(new Set(rs.filter((x) => !x.ok).map((x) => (x as { code: string }).code)), new Set(['EMAIL_TAKEN']));
  assert.equal(await count('SELECT count(*)::int AS n FROM users'), 1); assert.equal(await count('SELECT count(*)::int AS n FROM user_credentials'), 1);
});

test('a failed registration leaves no half-created user (credentials failure rolls back the user row)', { skip }, async () => {
  await reset(); const real = await db();
  const sabotaged = { connect: async () => { const c = await real.connect(); return { query: (sql: string, p?: unknown[]) => (/INSERT INTO user_credentials/.test(sql) ? Promise.reject(Object.assign(new Error('boom'), { code: 'XX000' })) : c.query(sql, p)), release: (e?: unknown) => c.release(e) }; }, query: real.query.bind(real) } as unknown as AuthPool;
  const lines: string[] = []; const s = new AuthService(sabotaged, { logger: jsonLogger((l) => lines.push(l)) });
  assert.deepEqual(await reg(s), { ok: false, code: 'INTERNAL', detail: 'register:sqlstate_XX000' }); // the service reports a coarse stage:reason (no message/host/row values)
  assert.equal(await count('SELECT count(*)::int AS n FROM users'), 0);
  assert.ok(lines.some((l) => JSON.parse(l).errCode === 'XX000') && lines.every((l) => !l.includes(PW) && !l.includes('alice@')), 'logs carry codes only — no password, no email');
});

test('no connection leaks: 30 parallel logins on a pool of 4 complete', { skip }, async () => {
  await reset(); const s = new AuthService(await db()); assert.ok((await reg(s)).ok);
  const rs = await Promise.all(Array.from({ length: 30 }, () => s.login('alice@example.test', PW)));
  assert.ok(rs.every((r) => r.ok)); assert.equal(await count('SELECT count(*)::int AS n FROM auth_sessions'), 30);
});
