// Full HTTP flow with REAL login (Fastify inject -> AuthService + IntroductionService -> REAL PostgreSQL). Without DATABASE_URL every test is SKIPPED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/server/app.ts';
import { AuthService } from '../../src/auth/service.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { IntroductionService } from '../../src/introductions/service.ts';
import type { PgPool } from '../../src/introductions/service.ts';
import { A, B, seedWorld, tgt } from './seedIntro.ts';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set — PostgreSQL HTTP tests NOT RUN';
const T1 = tgt(1), PW = 'a-long-test-password';
let n = 0; const key = () => `http-${process.pid}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
let pool: (PgPool & { end(): Promise<void> }) | null = null;
async function db() { if (pool) return pool; const m: string = 'pg'; const pg = await import(m); pool = new pg.default.Pool({ connectionString: URL, max: 4 }) as PgPool & { end(): Promise<void> }; return pool; }

test('HTTP end to end with real login: register, login, create -> connector accepts -> target accepts; logout kills the token', { skip }, async () => {
  const p = await db(); await seedWorld(p, 1);
  const hash = await hashPassword(PW); // seeded users get credentials so they can log in over HTTP
  for (const u of [A, B, T1]) await p.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)', [u, hash]);
  const app = buildApp({ service: new IntroductionService(p), auth: new AuthService(p), authRateLimit: { max: 1000, timeWindow: 60_000 } });
  const login = async (u: string) => { const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: `${u}@example.test`, password: PW } }); assert.equal(r.statusCode, 200, r.body); return { authorization: `Bearer ${r.json().token}` }; };
  const [ta, tb, tt] = [await login(A), await login(B), await login(T1)];
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: `${A}@example.test`, password: 'wrong-password-1' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: ta })).json().userId, A);

  const k = key(); const mk = () => app.inject({ method: 'POST', url: '/v1/introductions', headers: { ...ta, 'idempotency-key': k }, payload: { connectorId: B, targetId: T1, message: 'Please introduce me' } });
  const c = await mk(); assert.equal(c.statusCode, 201, c.body); const id = c.json().introduction.id as string;
  const again = await mk(); assert.equal(again.statusCode, 200); assert.equal(again.headers['idempotent-replayed'], 'true'); assert.equal(again.json().introduction.id, id);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/introductions/${id}`, headers: tt })).statusCode, 404, 'target cannot see it before the connector accepts');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/introductions/${id}` })).statusCode, 401);
  const tr = (h: object, action: string) => app.inject({ method: 'POST', url: `/v1/introductions/${id}/transitions`, headers: { ...h, 'idempotency-key': key() }, payload: { action } });
  assert.equal((await tr(ta, 'connector_accept')).statusCode, 403);
  const ca = await tr(tb, 'connector_accept'); assert.equal(ca.statusCode, 200); assert.equal(ca.json().introduction.status, 'pending_target');
  const ta2 = await tr(tt, 'target_accept'); assert.equal(ta2.statusCode, 200); assert.equal(ta2.json().introduction.status, 'accepted');
  assert.equal((await tr(tt, 'target_decline')).statusCode, 409);
  const bad = await app.inject({ method: 'POST', url: '/v1/introductions', headers: { ...ta, 'idempotency-key': key() }, payload: { connectorId: T1, targetId: B, message: 'no path' } });
  assert.equal(bad.statusCode, 422); assert.deepEqual(bad.json(), { error: { code: 'NOT_ELIGIBLE' } });

  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: ta })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: ta })).statusCode, 401, 'a logged-out token stops working immediately');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: tb })).statusCode, 200, 'other users unaffected');
});

test('HTTP: register then login with a brand-new account; duplicate email is 409', { skip }, async () => {
  const p = await db(); await seedWorld(p, 1);
  const app = buildApp({ service: new IntroductionService(p), auth: new AuthService(p), authRateLimit: { max: 1000, timeWindow: 60_000 } });
  const payload = { email: 'New.Person@Example.test', password: 'brand-new-password', displayName: 'New Person' };
  const r = await app.inject({ method: 'POST', url: '/v1/auth/register', payload }); assert.equal(r.statusCode, 201, r.body);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/register', payload })).statusCode, 409);
  const l = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'new.person@example.test', password: payload.password } });
  assert.equal(l.statusCode, 200); assert.equal(l.json().userId, r.json().userId);
  assert.ok(!l.body.includes('password') && !r.body.includes('password'));
});
