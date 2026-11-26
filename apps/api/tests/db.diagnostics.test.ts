import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolOptions, stripSslParams, urlWarnings } from '../src/server/dbConfig.ts';
import { probeDb, REQUIRED_TABLES } from '../src/server/dbHealth.ts';
import { classifyDbError, errFields } from '../src/introductions/logger.ts';
import { loadConfig } from '../src/server/config.ts';
import { buildApp } from '../src/server/app.ts';
import type { AuthPort, IntroService } from '../src/server/app.ts';

test('stripSslParams removes only TLS params and never re-encodes the rest (password escapes survive)', () => {
  assert.equal(stripSslParams('postgres://u:p%40ss%23@h:5432/postgres?sslmode=require'), 'postgres://u:p%40ss%23@h:5432/postgres');
  assert.equal(stripSslParams('postgres://u:p@h/db?application_name=x&sslmode=require&sslrootcert=/a&connect_timeout=5'), 'postgres://u:p@h/db?application_name=x&connect_timeout=5');
  assert.equal(stripSslParams('postgres://u:p@h/db'), 'postgres://u:p@h/db');
  assert.equal(stripSslParams('postgres://u:p@h/db?SSLMODE=require'), 'postgres://u:p@h/db');
});

test('poolOptions: auto keeps the URL untouched; explicit modes override sslmode in the URL; timeouts always set', () => {
  const url = 'postgres://u:p@h:5432/postgres?sslmode=require';
  const auto = poolOptions(url); assert.equal(auto.connectionString, url); assert.equal(auto.ssl, undefined);
  assert.deepEqual(poolOptions(url, 'no-verify').ssl, { rejectUnauthorized: false });
  assert.deepEqual(poolOptions(url, 'verify').ssl, { rejectUnauthorized: true });
  assert.equal(poolOptions(url, 'disable').ssl, false);
  assert.equal(poolOptions(url, 'no-verify').connectionString, 'postgres://u:p@h:5432/postgres', 'sslmode removed, otherwise the URL would override the ssl option');
  for (const m of ['auto', 'no-verify', 'verify', 'disable'] as const) { const o = poolOptions(url, m); assert.ok(o.connectionTimeoutMillis > 0 && o.connectionTimeoutMillis <= 30_000 && o.keepAlive, m); }
});

test('urlWarnings: flags the IPv6-only Supabase direct host, never echoes credentials, tolerates unparsable URLs', () => {
  const w = urlWarnings('postgres://postgres:SECRETPW@db.abcdefghij.supabase.co:5432/postgres');
  assert.equal(w.length, 1); assert.ok(/pooler/i.test(w[0]!)); assert.ok(!w[0]!.includes('SECRETPW'));
  assert.deepEqual(urlWarnings('postgres://postgres.abc:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'), []);
  assert.equal(urlWarnings('postgres://u:bad#pw@@h/db').length >= 0, true);
});

test('config: DATABASE_SSL defaults to auto, accepts the 4 modes (blank = auto), rejects anything else', () => {
  const base = { DATABASE_URL: 'postgres://x' };
  assert.equal(loadConfig(base).databaseSsl, 'auto'); assert.equal(loadConfig({ ...base, DATABASE_SSL: '' }).databaseSsl, 'auto');
  for (const m of ['disable', 'no-verify', 'verify']) assert.equal(loadConfig({ ...base, DATABASE_SSL: m }).databaseSsl, m);
  assert.throws(() => loadConfig({ ...base, DATABASE_SSL: 'require' }), /DATABASE_SSL/);
});

test('classifyDbError: maps real failure shapes to a coarse reason (the cases that all looked like "Server error.")', () => {
  const e = (code: string | undefined, message = '') => Object.assign(new Error(message), code ? { code } : {});
  assert.equal(classifyDbError(e('SELF_SIGNED_CERT_IN_CHAIN')), 'tls');
  assert.equal(classifyDbError(e('DEPTH_ZERO_SELF_SIGNED_CERT')), 'tls');
  assert.equal(classifyDbError(e('28000', 'no pg_hba.conf entry for host "1.2.3.4", user "u", database "d", no encryption')), 'tls', 'checked before auth');
  assert.equal(classifyDbError(e('28P01', 'password authentication failed for user "x"')), 'auth');
  assert.equal(classifyDbError(e('XX000', 'Tenant or user not found')), 'auth');
  assert.equal(classifyDbError(e('ENETUNREACH')), 'unreachable'); assert.equal(classifyDbError(e('ECONNREFUSED')), 'unreachable'); assert.equal(classifyDbError(e('ENOTFOUND')), 'unreachable');
  assert.equal(classifyDbError(e(undefined, 'timeout exceeded when trying to connect')), 'timeout'); assert.equal(classifyDbError(e('ETIMEDOUT')), 'timeout');
  assert.equal(classifyDbError(e('3D000')), 'database'); assert.equal(classifyDbError(e('42P01')), 'schema');
  assert.equal(classifyDbError(e('23505')), 'other'); assert.equal(classifyDbError(undefined), 'other'); assert.equal(classifyDbError('boom'), 'other');
  const agg = Object.assign(new Error('x'), { errors: [e('ECONNREFUSED'), e('ENETUNREACH')] }); assert.equal(classifyDbError(agg), 'unreachable');
});

test('errFields adds dbReason for connection problems but still never includes the message', () => {
  const f = errFields(Object.assign(new Error('password authentication failed for user "alice" host 10.0.0.5'), { code: '28P01' }));
  assert.deepEqual(f, { errName: 'Error', errCode: '28P01', dbReason: 'auth' }); assert.ok(!JSON.stringify(f).includes('alice'));
  assert.deepEqual(errFields(Object.assign(new Error('dup'), { code: '23505' })), { errName: 'Error', errCode: '23505' });
});

test('probeDb: ok only when every required table exists; schema/connection problems are reported with a reason', async () => {
  const all = REQUIRED_TABLES.map((t) => ({ t, present: true }));
  assert.deepEqual(await probeDb({ query: async () => ({ rows: all }) }), { ok: true });
  assert.deepEqual(await probeDb({ query: async () => ({ rows: all.map((r, i) => (i === 2 ? { ...r, present: false } : r)) }) }), { ok: false, reason: 'schema', code: null });
  assert.deepEqual(await probeDb({ query: async () => ({ rows: [] }) }), { ok: false, reason: 'schema', code: null });
  assert.deepEqual(await probeDb({ query: async () => { throw Object.assign(new Error('x'), { code: 'ENETUNREACH' }); } }), { ok: false, reason: 'unreachable', code: 'ENETUNREACH' });
});

const noSvc = {} as IntroService, noAuth = {} as AuthPort;
test('/readyz: 200 when ready, 503 + coarse reason when not, public, no-store, leaks nothing; absent without a probe; /healthz never calls it', async () => {
  let calls = 0;
  const bad = buildApp({ service: noSvc, auth: noAuth, ready: async () => { calls++; return { ok: false, reason: 'tls', code: 'SELF_SIGNED_CERT_IN_CHAIN' }; } });
  const r = await bad.inject('/readyz'); assert.equal(r.statusCode, 503); assert.deepEqual(r.json(), { status: 'unavailable', reason: 'tls' }); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await bad.inject('/healthz')).statusCode, 200); assert.equal(calls, 1, 'healthz must not touch the database');
  const ok = buildApp({ service: noSvc, auth: noAuth, ready: async () => ({ ok: true }) });
  assert.deepEqual((await ok.inject('/readyz')).json(), { status: 'ok' });
  const boom = buildApp({ service: noSvc, auth: noAuth, ready: async () => { throw new Error('secret host 10.1.1.1'); } });
  const b = await boom.inject('/readyz'); assert.equal(b.statusCode, 503); assert.ok(!b.body.includes('10.1.1.1'));
  assert.equal((await buildApp({ service: noSvc, auth: noAuth }).inject('/readyz')).statusCode, 404);
});
