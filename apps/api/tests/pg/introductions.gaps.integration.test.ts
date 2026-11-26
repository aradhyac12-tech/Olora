// Slice 2 gap closure on REAL PostgreSQL: graph re-check on accept, structured logging, retention.
// Needs both migrations applied (npm run test:pgstore does that). Without DATABASE_URL every test is SKIPPED, never passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntroductionService } from '../../src/introductions/service.ts';
import type { PgPool, Result } from '../../src/introductions/service.ts';
import { jsonLogger } from '../../src/introductions/logger.ts';
import { A, B, seedWorld, tgt, uid } from './seedIntro.ts';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set — PostgreSQL introduction gap tests NOT RUN';
const T1 = tgt(1);
const msg = 'SECRET-MESSAGE-BODY please introduce me';
let n = 0;
const key = () => `gk-${process.pid}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
let pool: (PgPool & { end(): Promise<void> }) | null = null;
async function db() {
  if (pool) return pool;
  const modName: string = 'pg'; const pg = await import(modName);
  pool = new pg.default.Pool({ connectionString: URL, max: 4 }) as PgPool & { end(): Promise<void> };
  return pool;
}
const codes = <T>(rs: Result<T>[]) => rs.filter((r) => !r.ok).map((r) => (r as { code: string }).code);
const count = async (sql: string, p: unknown[] = []) => Number(((await (await db()).query(sql, p)).rows[0] as { n: number }).n);
const status = async (id: string) => String(((await (await db()).query('SELECT status FROM introduction_requests WHERE id=$1', [id])).rows[0] as { status: string }).status);
const revoke = async (edgeId: string) => { await (await db()).query('UPDATE relationships SET revoked_at = now() WHERE id=$1', [edgeId]); };
const E_AB = uid(1000), E_BT1 = uid(1001);

async function created(s: IntroductionService) { const c = await s.create(A, { connectorId: B, targetId: T1, message: msg }, key()); assert.ok(c.ok, 'create'); return c.value; }

test('re-check: connector_accept is refused (NOT_ELIGIBLE, no state/audit/outbox change) once requester<->connector is revoked', { skip }, async () => {
  await seedWorld(await db(), 1); const s = new IntroductionService(await db()); const r = await created(s);
  await revoke(E_AB);
  assert.deepEqual(codes([await s.transition(B, r.id, 'connector_accept', key())]), ['NOT_ELIGIBLE']);
  assert.equal(await status(r.id), 'pending_connector');
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE request_id=$1 AND action='connector_accept'`, [r.id]), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM notification_outbox WHERE request_id=$1 AND event_type='introduction_consent_needed'`, [r.id]), 0, 'target must never be notified');
});

test('re-check: target_accept is refused once connector<->target is revoked; the target can still decline and the requester can still cancel', { skip }, async () => {
  await seedWorld(await db(), 1); const s = new IntroductionService(await db()); const r = await created(s);
  assert.ok((await s.transition(B, r.id, 'connector_accept', key())).ok);
  await revoke(E_BT1);
  assert.deepEqual(codes([await s.transition(T1, r.id, 'target_accept', key())]), ['NOT_ELIGIBLE']);
  assert.equal(await status(r.id), 'pending_target');
  const d = await s.transition(T1, r.id, 'target_decline', key()); assert.ok(d.ok && d.value.status === 'declined', 'decline never needs the graph');
  await seedWorld(await db(), 1); const r2 = await created(s);
  assert.ok((await s.transition(B, r2.id, 'connector_accept', key())).ok); await revoke(E_AB);
  const c = await s.transition(A, r2.id, 'requester_cancel', key()); assert.ok(c.ok && c.value.status === 'cancelled', 'cancel never needs the graph');
});

test('re-check: a block created after the connector accepted stops target_accept', { skip }, async () => {
  await seedWorld(await db(), 1); const s = new IntroductionService(await db()); const r = await created(s);
  assert.ok((await s.transition(B, r.id, 'connector_accept', key())).ok);
  await (await db()).query('INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2)', [T1, A]);
  assert.deepEqual(codes([await s.transition(T1, r.id, 'target_accept', key())]), ['NOT_ELIGIBLE']);
  assert.equal(await status(r.id), 'pending_target');
});

test('re-check: a replayed (idempotent) accept returns the stored result even if the graph changed afterwards', { skip }, async () => {
  await seedWorld(await db(), 1); const s = new IntroductionService(await db()); const r = await created(s); const k = key();
  const first = await s.transition(B, r.id, 'connector_accept', k); assert.ok(first.ok && !first.replayed);
  await revoke(E_AB);
  const again = await s.transition(B, r.id, 'connector_accept', k); assert.ok(again.ok && again.replayed, 'replay must not re-evaluate the graph');
});

test('re-check is switchable: recheckOnAccept=false restores the old behaviour', { skip }, async () => {
  await seedWorld(await db(), 1); const s = new IntroductionService(await db(), { recheckOnAccept: false }); const r = await created(s);
  await revoke(E_AB);
  assert.ok((await s.transition(B, r.id, 'connector_accept', key())).ok);
});

test('re-check does not hold a second pooled connection: 12 parallel accepts on a pool of 4 finish', { skip, timeout: 20000 }, async () => {
  await seedWorld(await db(), 12); const s = new IntroductionService(await db());
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => s.create(A, { connectorId: B, targetId: tgt(i + 1), message: msg }, key())));
  assert.ok(rs.every((r) => r.ok));
  const outs = await Promise.all(rs.map((r) => s.transition(B, (r as { value: { id: string } }).value.id, 'connector_accept', key())));
  assert.ok(outs.every((o) => o.ok), JSON.stringify(codes(outs)));
});

test('logging: events carry ids/codes only — message text never appears; failures log class + SQLSTATE, not the driver message', { skip }, async () => {
  await seedWorld(await db(), 1); const lines: string[] = []; const log = jsonLogger((l) => lines.push(l));
  const s = new IntroductionService(await db(), { logger: log }); const r = await created(s);
  await s.transition(B, r.id, 'connector_accept', key()); await revoke(E_BT1); await s.transition(T1, r.id, 'target_accept', key());
  const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(events.map((e) => e.event), ['intro.created', 'intro.transitioned', 'intro.accept.rejected']);
  assert.equal(events[2]!.code, 'NOT_ELIGIBLE');
  assert.ok(!lines.join('\n').includes('SECRET-MESSAGE-BODY'));
  // a failing driver: its message carries a "row value" which must NOT be logged
  const bad: PgPool = { query: async () => { throw Object.assign(new Error('row value leak@example.test'), { code: '08006' }); }, connect: async () => { throw Object.assign(new Error('row value leak@example.test'), { code: '08006' }); } } as unknown as PgPool;
  const lines2: string[] = []; const s2 = new IntroductionService(bad, { logger: jsonLogger((l) => lines2.push(l)) });
  assert.deepEqual(codes([await s2.create(A, { connectorId: B, targetId: T1, message: msg }, key())]), ['INTERNAL']);
  assert.ok(lines2.length >= 1 && lines2.every((l) => !l.includes('leak@example.test')));
  assert.ok(lines2.some((l) => JSON.parse(l).errCode === '08006'));
});

test('retention: purgeClosed deletes only OLD, TERMINAL requests with no undelivered notifications; cascades audit/outbox/idempotency', { skip }, async () => {
  await seedWorld(await db(), 4); const p = await db(); const s = new IntroductionService(p);
  const mk = async (i: number) => { const c = await s.create(A, { connectorId: B, targetId: tgt(i), message: msg }, key()); assert.ok(c.ok); return c.value.id; };
  const oldDone = await mk(1), openOne = await mk(2), undelivered = await mk(3), recent = await mk(4);
  for (const id of [oldDone, undelivered, recent]) assert.ok((await s.transition(A, id, 'requester_cancel', key())).ok);
  await p.query(`UPDATE notification_outbox SET processed_at = now() WHERE request_id IN ($1,$2)`, [oldDone, recent]); // `undelivered` keeps processed_at NULL
  const future = new IntroductionService(p, { now: () => new Date(Date.now() + 2 * 86_400_000) });
  await p.query(`UPDATE notification_outbox SET processed_at = now() WHERE request_id=$1`, [recent]);
  assert.equal(await future.purgeClosed(86_400_000), 2, 'oldDone + recent are both terminal and >24h old at the simulated time; open + undelivered stay');
  assert.equal(await count('SELECT count(*)::int AS n FROM introduction_requests WHERE id = ANY($1::uuid[])', [[openOne, undelivered]]), 2);
  assert.equal(await count('SELECT count(*)::int AS n FROM introduction_requests WHERE id = ANY($1::uuid[])', [[oldDone, recent]]), 0);
  for (const t of ['audit_events', 'notification_outbox', 'introduction_idempotency']) assert.equal(await count(`SELECT count(*)::int AS n FROM ${t} WHERE request_id = ANY($1::uuid[])`, [[oldDone, recent]]), 0, `${t} cascaded`);
  assert.ok(await count('SELECT count(*)::int AS n FROM audit_events WHERE request_id=$1', [undelivered]) > 0, 'kept request keeps its audit trail');
  assert.equal(await s.purgeClosed(86_400_000), 0, 'real clock: nothing is 24h old yet');
});

test('retention: unsafe arguments delete nothing (window < 24h, NaN, bad limit)', { skip }, async () => {
  await seedWorld(await db(), 1); const p = await db(); const s = new IntroductionService(p); const r = await created(s);
  await s.transition(A, r.id, 'requester_cancel', key()); await p.query('UPDATE notification_outbox SET processed_at=now()');
  const future = new IntroductionService(p, { now: () => new Date(Date.now() + 90 * 86_400_000) });
  for (const [ms, lim] of [[3_600_000, 10], [Number.NaN, 10], [-1, 10], [86_400_000, 0], [86_400_000, 1.5], [86_400_000, 1e9]] as const) assert.equal(await future.purgeClosed(ms, lim), 0, `ms=${ms} limit=${lim}`);
  assert.equal(await count('SELECT count(*)::int AS n FROM introduction_requests'), 1);
});

test('retention: two concurrent purge workers delete every eligible request exactly once', { skip }, async () => {
  await seedWorld(await db(), 8); const p = await db(); const s = new IntroductionService(p);
  for (let i = 1; i <= 8; i++) { const c = await s.create(A, { connectorId: B, targetId: tgt(i), message: msg }, key()); assert.ok(c.ok); await s.transition(A, c.value.id, 'requester_cancel', key()); }
  await p.query('UPDATE notification_outbox SET processed_at=now()');
  const future = new IntroductionService(p, { now: () => new Date(Date.now() + 2 * 86_400_000) });
  const got = await Promise.all([future.purgeClosed(86_400_000, 3), future.purgeClosed(86_400_000, 3), future.purgeClosed(86_400_000, 3), future.purgeClosed(86_400_000, 3)]);
  const total = got.reduce((a, b) => a + b, 0);
  const rest = await future.purgeClosed(86_400_000, 100);
  assert.equal(total + rest, 8); assert.equal(await count('SELECT count(*)::int AS n FROM introduction_requests'), 0);
});
