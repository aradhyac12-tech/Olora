// PgGraphStore vs InMemoryGraphStore on identical graphs, against REAL PostgreSQL.
// Requires: migrated schema (npm run db:up; apply 0001_graph_core.sql) and DATABASE_URL, and the `pg` package.
// Without DATABASE_URL every test is reported SKIPPED (never passed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findIntroductionPaths } from '../../src/graph/engine.ts';
import { InMemoryGraphStore } from '../../src/graph/memoryStore.ts';
import { PgGraphStore } from '../../src/graph/pgStore.ts';
import type { PgQueryable } from '../../src/graph/pgStore.ts';
import type { GraphEdge, GraphUser, SearchOptions } from '../../src/graph/types.ts';
import { NOW, ago, ahead, edge, user } from '../helpers.ts';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set — PostgreSQL integration NOT RUN';

const uid = (s: string) => `00000000-0000-4000-8000-${[...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padStart(12, '0').slice(-12)}`;
const [A, B, C, D, T] = ['A', 'B', 'C', 'D', 'T'].map(uid) as [string, string, string, string, string];
const E = (n: string) => uid(`e${n}`);

let db: (PgQueryable & { end(): Promise<void> }) | null = null;
async function connect() {
  if (db) return db;
  const modName: string = 'pg';
  const pg = await import(modName);
  const pool = new pg.default.Pool({ connectionString: URL });
  db = pool;
  return pool as PgQueryable & { end(): Promise<void> };
}

/** Load a graph into Postgres through legal DB transitions and return the edges exactly as stored. */
async function seed(c: PgQueryable, users: GraphUser[], edges: GraphEdge[], blocks: Array<[string, string]>): Promise<GraphEdge[]> {
  await c.query('TRUNCATE blocks, consents, relationship_confirmations, relationship_evidence, relationships, external_profiles, users CASCADE');
  for (const u of users) {
    await c.query('INSERT INTO users (id,email,display_name,account_status,discoverable,accepts_introductions) VALUES ($1,$2,$3,$4,$5,$6)',
      [u.id, `${u.id}@example.test`, 'U', u.status, u.discoverable, u.acceptsIntroductions]);
  }
  const stored: GraphEdge[] = [];
  for (const e of edges) {
    const conf = e.confirmations.filter((x) => x.userId === e.sourceUserId || x.userId === e.targetUserId);
    const imported = e.type === 'imported';
    const confirmedOk = e.verificationStatus === 'confirmed' && (imported || conf.filter((x) => x.status === 'confirmed' && !x.revokedAt).length === 2);
    await c.query(
      `INSERT INTO relationships (id,source_user_id,target_user_id,relationship_type,direction,verification_status,permission_status,created_at,confirmed_at,expires_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.id, e.sourceUserId, e.targetUserId, e.type, e.direction, imported && confirmedOk ? 'confirmed' : 'unverified', e.permissionStatus,
        e.createdAt, imported && confirmedOk ? e.confirmedAt : null, e.expiresAt, e.revokedAt]);
    for (const x of conf) {
      await c.query('INSERT INTO relationship_confirmations (relationship_id,confirming_user_id,confirmation_status,confirmed_at,revoked_at) VALUES ($1,$2,$3,$4,$5)',
        [e.id, x.userId, x.status, x.confirmedAt, x.revokedAt]);
    }
    if (!imported && confirmedOk) await c.query(`UPDATE relationships SET verification_status='confirmed', confirmed_at=$2 WHERE id=$1`, [e.id, e.confirmedAt]);
    for (const ev of e.evidence) {
      await c.query('INSERT INTO relationship_evidence (relationship_id,evidence_type,submitted_by,created_at) VALUES ($1,$2,$3,$4)', [e.id, ev.type, e.sourceUserId, ev.createdAt]);
    }
    stored.push({ ...e, confirmations: conf, verificationStatus: confirmedOk ? 'confirmed' : 'unverified', confirmedAt: confirmedOk ? e.confirmedAt : null });
  }
  for (const [x, y] of blocks) await c.query('INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2)', [x, y]);
  // Since migration 0006 a block ENDS live relationships between the pair (DB trigger). Mirror that in the expected edges.
  const ended = new Date(NOW.getTime());
  return stored.map((e) => (blocks.some(([x, y]) => (e.sourceUserId === x && e.targetUserId === y) || (e.sourceUserId === y && e.targetUserId === x)) && e.revokedAt === null ? { ...e, revokedAt: ended } : e));
}

async function agree(name: string, users: GraphUser[], edges: GraphEdge[], blocks: Array<[string, string]>, opts: Partial<SearchOptions> = {}, queries: Array<[string, string]> = [[A, T]]) {
  const c = await connect();
  const stored = await seed(c, users, edges, blocks);
  const mem = new InMemoryGraphStore({ users, edges: stored, blocks: blocks.map(([blockerUserId, blockedUserId]) => ({ blockerUserId, blockedUserId })) });
  const pg = new PgGraphStore(c);
  for (const [s, t] of queries) {
    const o = { now: NOW, maxPaths: 10, ...opts };
    assert.deepEqual(await findIntroductionPaths(pg, s, t, o), await findIntroductionPaths(mem, s, t, o), `${name}: ${s}->${t}`);
  }
  return { c, mem, pg };
}
const us = (...ids: string[]) => ids.map((i) => user(i));

test('pg == memory: chain and diamond', { skip }, async () => {
  const { pg } = await agree('chain', us(A, B, C, T), [edge(E('1'), A, B), edge(E('2'), B, C), edge(E('3'), C, T)], [], { maxHops: 4 });
  assert.equal((await findIntroductionPaths(pg, A, T, { now: NOW })).paths.length, 1);
  await agree('diamond+limit', us(A, B, C, T), [edge(E('1'), A, B), edge(E('2'), A, C), edge(E('3'), B, T), edge(E('4'), C, T)], [], { maxPaths: 1 });
});

test('pg == memory: ineligible edges (expired, revoked, unverified, one-sided, follow, permission, single confirmation)', { skip }, async () => {
  const bad = [
    edge(E('1'), A, B, { expiresAt: ahead(0.0001) }), // future expiry still valid
    edge(E('2'), B, T, { revokedAt: ago(1) }),
    edge(E('3'), A, C, { type: 'one_sided' }),
    edge(E('4'), C, T, { type: 'social_follow' }),
    edge(E('5'), A, D, { permissionStatus: 'pending' }),
    edge(E('6'), D, T, { confirmations: [{ userId: D, status: 'confirmed', confirmedAt: ago(5), revokedAt: null }] }),
  ];
  await agree('ineligible', us(A, B, C, D, T), bad, []);
});

test('pg == memory: directed, imported opt-in, blocks, consent', { skip }, async () => {
  const imp = edge(E('2'), B, T, { type: 'imported', confirmations: [], evidence: [{ type: 'imported_record', createdAt: ago(3) }] });
  await agree('directed', us(A, T), [edge(E('1'), A, T, { direction: 'directed' })], [], {}, [[A, T], [T, A]]);
  await agree('imported off', us(A, B, T), [edge(E('1'), A, B), imp], [], { includeImported: false });
  await agree('imported on', us(A, B, T), [edge(E('1'), A, B), imp], [], { includeImported: true });
  await agree('block', us(A, B, C, T), [edge(E('1'), A, B), edge(E('2'), B, T), edge(E('3'), A, C), edge(E('4'), C, T)], [[B, A]]);
  await agree('no consent', [user(A), user(B, { acceptsIntroductions: false }), user(T)], [edge(E('1'), A, B), edge(E('2'), B, T)], []);
});

test('pg == memory: truncation signalling and deterministic order', { skip }, async () => {
  const edges = [edge(E('1'), A, B), edge(E('2'), A, C), edge(E('3'), C, T)];
  await agree('truncation', us(A, B, C, T), edges, [], { maxEdgesPerNode: 1 });
  await agree('order', us(A, B, C, T), [...edges].reverse(), [], {});
});

test('changes to consent, blocks, revocation, confirmation and status affect subsequent searches', { skip }, async () => {
  const { c, pg } = await agree('base', us(A, B, T), [edge(E('1'), A, B), edge(E('2'), B, T)], []);
  const n = async () => (await findIntroductionPaths(pg, A, T, { now: NOW })).paths.length;
  assert.equal(await n(), 1);
  await c.query('UPDATE users SET accepts_introductions=false WHERE id=$1', [B]);
  assert.equal(await n(), 0, 'consent revoked');
  await c.query('UPDATE users SET accepts_introductions=true WHERE id=$1', [B]);
  assert.equal(await n(), 1);
  await c.query('INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2)', [T, B]);
  assert.equal(await n(), 0, 'block');
  await c.query('DELETE FROM blocks');
  assert.equal(await n(), 0, 'unblocking does NOT restore a relationship the block ended (0006): the users must re-confirm');
  await seed(c, us(A, B, T), [edge(E('1'), A, B), edge(E('2'), B, T)], []);
  assert.equal(await n(), 1);
  await c.query(`UPDATE relationship_confirmations SET confirmation_status='revoked', revoked_at=$3 WHERE relationship_id=$1 AND confirming_user_id=$2`, [E('1'), A, NOW]);
  assert.equal(await n(), 0, 'confirmation revoked');
  // a revoked confirmation is terminal (0006): re-confirming means a NEW confirmation row, never flipping the old one back
  await assert.rejects(c.query(`UPDATE relationship_confirmations SET confirmation_status='confirmed', revoked_at=NULL WHERE relationship_id=$1 AND confirming_user_id=$2`, [E('1'), A]), /terminal/);
  await c.query(`DELETE FROM relationship_confirmations WHERE relationship_id=$1 AND confirming_user_id=$2`, [E('1'), A]);
  await c.query(`INSERT INTO relationship_confirmations (relationship_id,confirming_user_id,confirmation_status,confirmed_at) VALUES ($1,$2,'confirmed',$3)`, [E('1'), A, NOW]);
  assert.equal(await n(), 1);
  await c.query('UPDATE relationships SET revoked_at=$2 WHERE id=$1', [E('2'), NOW]);
  assert.equal(await n(), 0, 'relationship revoked');
  await c.query(`UPDATE users SET account_status='deactivated' WHERE id=$1`, [T]);
  assert.equal((await findIntroductionPaths(pg, A, T, { now: NOW })).stopReason, 'target_unavailable', 'deactivated target');
});

test('pg store fails closed and does not leak details', { skip }, async () => {
  const bad: PgQueryable = { query: async () => { throw new Error('password authentication failed for user "secret"'); } };
  await assert.rejects(findIntroductionPaths(new PgGraphStore(bad), A, T, { now: NOW }), (e: unknown) => e instanceof Error && e.name === 'GraphEngineError' && !/secret/.test(e.message));
});

test('close pool', { skip }, async () => { if (db) await db.end(); });
