// Introduction service against REAL PostgreSQL: state transitions, idempotency, concurrency, atomicity.
// Needs both migrations applied (npm run test:pgstore does that). Without DATABASE_URL every test is SKIPPED, never passed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { IntroductionService } from '../../src/introductions/service.ts';
import type { PgPool, IntroRecord, Result } from '../../src/introductions/service.ts';
import { A, B, seedWorld, tgt, uid } from './seedIntro.ts';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set — PostgreSQL introduction tests NOT RUN';
const T1 = tgt(1);
const msg = 'Could you introduce me?';
let n = 0;
const key = (p = 'k') => `${p}-${process.pid}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

let pool: (PgPool & { end(): Promise<void> }) | null = null;
async function db() {
  if (pool) return pool;
  const modName: string = 'pg';
  const pg = await import(modName);
  // Deliberately SMALL pool: concurrent callers outnumber connections, so any code that holds one connection while waiting for another would deadlock here.
  pool = new pg.default.Pool({ connectionString: URL, max: 4 }) as PgPool & { end(): Promise<void> };
  return pool;
}
const svc = async (o = {}) => new IntroductionService(await db(), o);
const later = (ms: number) => () => new Date(Date.now() + ms);
const count = async (sql: string, p: unknown[] = []) => Number(((await (await db()).query(sql, p)).rows[0] as { n: number }).n);
const oks = <T>(rs: Result<T>[]) => rs.filter((r) => r.ok);
const codes = <T>(rs: Result<T>[]) => rs.filter((r) => !r.ok).map((r) => (r as { code: string }).code);
async function makeOpenToTarget(s: IntroductionService): Promise<IntroRecord> {
  const c = await s.create(A, { connectorId: B, targetId: T1, message: msg }, key());
  assert.ok(c.ok, 'create');
  const a = await s.transition(B, c.value.id, 'connector_accept', key());
  assert.ok(a.ok, 'connector_accept');
  return a.value;
}

test('happy path: create -> connector accepts -> target accepts; audit and outbox are exact', { skip }, async () => {
  await seedWorld(await db(), 1); const s = await svc();
  const c = await s.create(A, { connectorId: B, targetId: T1, message: msg }, key());
  assert.ok(c.ok && c.value.status === 'pending_connector' && c.value.version === 1);
  const a = await s.transition(B, c.value.id, 'connector_accept', key());
  assert.ok(a.ok && a.value.status === 'pending_target' && a.value.version === 2);
  const t = await s.transition(T1, c.value.id, 'target_accept', key());
  assert.ok(t.ok && t.value.status === 'accepted' && t.value.decidedAt !== null && t.value.version === 3);
  const audit = (await (await db()).query(`SELECT action, actor_id, from_status, to_status FROM audit_events WHERE request_id=$1 ORDER BY id`, [c.value.id])).rows;
  assert.deepEqual(audit.map((r) => r.action), ['create', 'connector_accept', 'target_accept']);
  assert.deepEqual(audit.map((r) => r.to_status), ['pending_connector', 'pending_target', 'accepted']);
  const ob = (await (await db()).query(`SELECT event_type, recipient_user_id, payload FROM notification_outbox WHERE request_id=$1 ORDER BY id`, [c.value.id])).rows;
  assert.deepEqual(ob.map((r) => `${r.event_type}:${r.recipient_user_id}`).sort(), [
    `introduction_accepted:${A}`, `introduction_accepted:${B}`, `introduction_consent_needed:${T1}`, `introduction_requested:${B}`].sort());
  for (const r of ob) assert.deepEqual(Object.keys(r.payload as object), ['requestId'], 'outbox payload carries ids only, no message/PII');
});

test('eligibility: no path, blocked pair, or self-request => NOT_ELIGIBLE / INVALID_INPUT (reasons not revealed)', { skip }, async () => {
  await seedWorld(await db(), 2); const s = await svc(); const p = await db();
  assert.deepEqual(codes([await s.create(A, { connectorId: tgt(2), targetId: T1, message: msg }, key())]), ['NOT_ELIGIBLE'], 'connector has no edge from requester');
  await p.query('INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2)', [T1, A]);
  assert.deepEqual(codes([await s.create(A, { connectorId: B, targetId: T1, message: msg }, key())]), ['NOT_ELIGIBLE'], 'target blocked requester');
  assert.ok((await s.create(A, { connectorId: B, targetId: tgt(2), message: msg }, key())).ok, 'unblocked target still works');
  assert.deepEqual(codes([await s.create(A, { connectorId: A, targetId: T1, message: msg }, key())]), ['INVALID_INPUT']);
  assert.deepEqual(codes([await s.create(A, { connectorId: B, targetId: T1, message: '   ' }, key())]), ['INVALID_INPUT']);
  assert.deepEqual(codes([await s.create(A, { connectorId: B, targetId: T1, message: msg }, 'short')]), ['INVALID_INPUT']);
});

test('create idempotency: replay returns the same request; same key with a different payload conflicts', { skip }, async () => {
  await seedWorld(await db(), 2); const s = await svc(); const k = key();
  const first = await s.create(A, { connectorId: B, targetId: T1, message: msg }, k);
  const again = await s.create(A, { connectorId: B, targetId: T1, message: msg }, k);
  assert.ok(first.ok && again.ok && again.replayed && !first.replayed && again.value.id === first.value.id);
  assert.deepEqual(codes([await s.create(A, { connectorId: B, targetId: tgt(2), message: msg }, k)]), ['IDEMPOTENCY_CONFLICT']);
  assert.equal(await count('SELECT count(*)::int AS n FROM introduction_requests'), 1);
});

test('concurrent create with the SAME key: exactly one request, exactly one non-replayed result', { skip }, async () => {
  await seedWorld(await db(), 1); const s = await svc(); const k = key();
  const rs = await Promise.all(Array.from({ length: 12 }, () => s.create(A, { connectorId: B, targetId: T1, message: msg }, k)));
  assert.equal(oks(rs).length, 12, JSON.stringify(codes(rs)));
  assert.equal(rs.filter((r) => r.ok && !r.replayed).length, 1);
  assert.equal(new Set(rs.map((r) => (r.ok ? r.value.id : ''))).size, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM introduction_requests'), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM notification_outbox`), 1);
});

test('concurrent create of the same open triple with DIFFERENT keys: one wins, the rest are DUPLICATE_OPEN', { skip }, async () => {
  await seedWorld(await db(), 1); const s = await svc();
  const rs = await Promise.all(Array.from({ length: 10 }, () => s.create(A, { connectorId: B, targetId: T1, message: msg }, key())));
  assert.equal(oks(rs).length, 1); assert.deepEqual(new Set(codes(rs)), new Set(['DUPLICATE_OPEN']));
  assert.equal(await count('SELECT count(*)::int AS n FROM introduction_requests'), 1);
});

test('open-request cap is exact under concurrency (3 allowed of 10 parallel creates)', { skip }, async () => {
  await seedWorld(await db(), 10); const s = await svc({ maxOpenPerRequester: 3 });
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => s.create(A, { connectorId: B, targetId: tgt(i + 1), message: msg }, key())));
  assert.equal(oks(rs).length, 3); assert.deepEqual(new Set(codes(rs)), new Set(['TOO_MANY_OPEN']));
  assert.equal(await count(`SELECT count(*)::int AS n FROM introduction_requests WHERE status='pending_connector'`), 3);
});

test('racing target_accept vs target_decline: exactly one wins; final state and audit agree', { skip }, async () => {
  for (let round = 0; round < 10; round++) {
    await seedWorld(await db(), 1); const s = await svc(); const r = await makeOpenToTarget(s);
    const [x, y] = await Promise.all([s.transition(T1, r.id, 'target_accept', key()), s.transition(T1, r.id, 'target_decline', key())]);
    assert.equal(oks([x, y]).length, 1, `round ${round}`); assert.deepEqual(codes([x, y]), ['INVALID_STATE']);
    const row = (await (await db()).query('SELECT status FROM introduction_requests WHERE id=$1', [r.id])).rows[0] as { status: string };
    const winner = x.ok ? 'accepted' : 'declined'; assert.equal(row.status, winner);
    assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE request_id=$1 AND action IN ('target_accept','target_decline')`, [r.id]), 1);
  }
});

test('20 parallel target_accept with distinct keys: one transition, 19 INVALID_STATE, no duplicate side effects', { skip }, async () => {
  await seedWorld(await db(), 1); const s = await svc(); const r = await makeOpenToTarget(s);
  const rs = await Promise.all(Array.from({ length: 20 }, () => s.transition(T1, r.id, 'target_accept', key())));
  assert.equal(oks(rs).length, 1); assert.deepEqual(codes(rs).filter((c) => c !== 'INVALID_STATE'), []);
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE request_id=$1 AND action='target_accept'`, [r.id]), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM notification_outbox WHERE request_id=$1 AND event_type='introduction_accepted'`, [r.id]), 2);
});

test('transition idempotency: same key replays; same key with another action conflicts', { skip }, async () => {
  await seedWorld(await db(), 1); const s = await svc(); const r = await makeOpenToTarget(s); const k = key();
  const rs = await Promise.all(Array.from({ length: 10 }, () => s.transition(T1, r.id, 'target_accept', k)));
  assert.equal(oks(rs).length, 10, JSON.stringify(codes(rs))); assert.equal(rs.filter((x) => x.ok && !x.replayed).length, 1);
  assert.deepEqual(codes([await s.transition(T1, r.id, 'target_decline', k)]), ['IDEMPOTENCY_CONFLICT']);
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE request_id=$1 AND action='target_accept'`, [r.id]), 1);
});

test('visibility and roles: strangers and the not-yet-consulted target get NOT_FOUND; wrong role is FORBIDDEN', { skip }, async () => {
  await seedWorld(await db(), 1); const s = await svc(); const stranger = uid(999);
  await (await db()).query(`INSERT INTO users (id,email,display_name) VALUES ($1,'s@example.test','S')`, [stranger]);
  const c = await s.create(A, { connectorId: B, targetId: T1, message: msg }, key()); assert.ok(c.ok); const id = c.value.id;
  assert.deepEqual(codes([await s.get(stranger, id), await s.get(T1, id)]), ['NOT_FOUND', 'NOT_FOUND']);
  assert.deepEqual(codes([await s.transition(T1, id, 'target_accept', key()), await s.transition(stranger, id, 'connector_accept', key()), await s.transition(uid(12345), 'not-a-uuid', 'connector_accept', key())]), ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
  assert.deepEqual(codes([await s.transition(A, id, 'connector_accept', key())]), ['FORBIDDEN']);
  assert.ok((await s.get(A, id)).ok && (await s.get(B, id)).ok);
  await s.transition(B, id, 'connector_accept', key());
  assert.ok((await s.get(T1, id)).ok, 'target sees it once the connector accepted');
});

test('declined by connector: target is never notified and never learns of it', { skip }, async () => {
  await seedWorld(await db(), 1); const s = await svc();
  const c = await s.create(A, { connectorId: B, targetId: T1, message: msg }, key()); assert.ok(c.ok);
  assert.ok((await s.transition(B, c.value.id, 'connector_decline', key())).ok);
  assert.equal(await count(`SELECT count(*)::int AS n FROM notification_outbox WHERE recipient_user_id=$1`, [T1]), 0);
  assert.deepEqual(codes([await s.get(T1, c.value.id)]), ['NOT_FOUND']);
});

test('lazy expiry: acting on a due request reports EXPIRED AND persists the expiry (audit + outbox)', { skip }, async () => {
  await seedWorld(await db(), 1); const s = await svc({ ttlMs: 50 });
  const c = await s.create(A, { connectorId: B, targetId: T1, message: msg }, key()); assert.ok(c.ok);
  const late = await svc({ now: later(3_600_000) });
  assert.deepEqual(codes([await late.transition(B, c.value.id, 'connector_accept', key())]), ['EXPIRED']);
  const row = (await (await db()).query('SELECT status, decided_at FROM introduction_requests WHERE id=$1', [c.value.id])).rows[0] as { status: string; decided_at: unknown };
  assert.equal(row.status, 'expired'); assert.ok(row.decided_at);
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE request_id=$1 AND action='expire' AND actor_id IS NULL`, [c.value.id]), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM notification_outbox WHERE request_id=$1 AND event_type='introduction_expired' AND recipient_user_id=$2`, [c.value.id, A]), 1);
  assert.deepEqual(codes([await late.transition(B, c.value.id, 'connector_accept', key())]), ['INVALID_STATE'], 'now terminal');
});

test('expireDue from two concurrent workers: every due request expires exactly once, no double notifications', { skip }, async () => {
  await seedWorld(await db(), 12); const s = await svc({ ttlMs: 50, maxOpenPerRequester: 50 });
  for (let i = 1; i <= 12; i++) assert.ok((await s.create(A, { connectorId: B, targetId: tgt(i), message: msg }, key())).ok);
  const w1 = await svc({ now: later(3_600_000) }), w2 = await svc({ now: later(3_600_000) });
  let total = 0;
  for (let round = 0; round < 6; round++) { const [x, y] = await Promise.all([w1.expireDue(3), w2.expireDue(3)]); total += x + y; if (x + y === 0) break; }
  assert.equal(total, 12);
  assert.equal(await count(`SELECT count(*)::int AS n FROM introduction_requests WHERE status='expired'`), 12);
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action='expire'`), 12);
  assert.equal(await count(`SELECT count(*)::int AS n FROM notification_outbox WHERE event_type='introduction_expired'`), 12);
});

test('atomicity: an outbox failure rolls back the whole transition and the whole create', { skip }, async () => {
  await seedWorld(await db(), 1); const real = await db();
  const faulty: PgPool = {
    query: (t, p) => real.query(t, p),
    connect: async () => { const c = await real.connect(); return { query: (t: string, p?: unknown[]) => (/INSERT INTO notification_outbox/.test(t) ? Promise.reject(new Error('injected outbox failure')) : c.query(t, p)), release: (e?: unknown) => c.release(e) }; },
  };
  const bad = new IntroductionService(faulty);
  assert.deepEqual(codes([await bad.create(A, { connectorId: B, targetId: T1, message: msg }, key())]), ['INTERNAL']);
  assert.equal(await count('SELECT count(*)::int AS n FROM introduction_requests'), 0, 'create left no request');
  assert.equal(await count('SELECT count(*)::int AS n FROM introduction_idempotency'), 0, 'create left no idempotency row');
  assert.equal(await count('SELECT count(*)::int AS n FROM audit_events'), 0, 'create left no audit row');
  const good = await svc(); const c = await good.create(A, { connectorId: B, targetId: T1, message: msg }, key()); assert.ok(c.ok);
  assert.deepEqual(codes([await bad.transition(B, c.value.id, 'connector_accept', key())]), ['INTERNAL']);
  const row = (await real.query('SELECT status, version FROM introduction_requests WHERE id=$1', [c.value.id])).rows[0] as { status: string; version: number };
  assert.deepEqual([row.status, row.version], ['pending_connector', 1], 'transition fully rolled back');
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE request_id=$1`, [c.value.id]), 1, 'only the original create audit remains');
});

test('no connection or transaction leaks after all of the above', { skip }, async () => {
  assert.equal(await count(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`), 0);
});

after(async () => { if (pool) await pool.end(); });
