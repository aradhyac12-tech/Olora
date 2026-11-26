// Snapshot-consistency test for PgGraphStore against REAL PostgreSQL.
// A concurrent writer commits between the edge query and the confirmation query of one getEdgesFrom call.
//  - without a snapshot the read is TORN (edge listed as confirmed, but its confirmation shows revoked)
//  - withGraphSnapshot (REPEATABLE READ) returns one consistent view
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgGraphStore, withGraphSnapshot } from '../../src/graph/pgStore.ts';
import type { PgQueryable } from '../../src/graph/pgStore.ts';
import { NOW } from '../helpers.ts';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set — PostgreSQL snapshot test NOT RUN';
const X = '00000000-0000-4000-8000-0000000000a1';
const Y = '00000000-0000-4000-8000-0000000000a2';
const R = '00000000-0000-4000-8000-0000000000b1';
const OPTS = { now: NOW, limit: 100, includeImported: false } as const;

async function pool() {
  const modName: string = 'pg';
  const pg = await import(modName);
  return new pg.default.Pool({ connectionString: URL, max: 4 });
}

async function seed(p: { query: PgQueryable['query'] }) {
  await p.query('TRUNCATE blocks, consents, relationship_confirmations, relationship_evidence, relationships, external_profiles, users CASCADE');
  for (const id of [X, Y]) await p.query(`INSERT INTO users (id,email,display_name,account_status,discoverable,accepts_introductions) VALUES ($1,$2,'U','active',true,true)`, [id, `${id}@example.test`]);
  await p.query(`INSERT INTO relationships (id,source_user_id,target_user_id,relationship_type,direction,verification_status,permission_status,created_at)
                 VALUES ($1,$2,$3,'acquaintance','mutual','unverified','granted',$4)`, [R, X, Y, new Date(NOW.getTime() - 86400000 * 20)]);
  for (const u of [X, Y]) await p.query(`INSERT INTO relationship_confirmations (relationship_id,confirming_user_id,confirmation_status,confirmed_at) VALUES ($1,$2,'confirmed',$3)`, [R, u, new Date(NOW.getTime() - 86400000 * 10)]);
  await p.query(`UPDATE relationships SET verification_status='confirmed', confirmed_at=$2 WHERE id=$1`, [R, new Date(NOW.getTime() - 86400000 * 10)]);
}

/** Wrap a queryable: after the FIRST query (the edge query) runs, fire `hook` once and wait for it, then continue. */
function interleave(inner: PgQueryable, hook: () => Promise<void>): PgQueryable {
  let fired = false;
  return {
    async query(text, params) {
      const res = await inner.query(text, params);
      if (!fired) { fired = true; await hook(); }
      return res;
    },
  };
}

test('without a snapshot a concurrent revoke produces a torn read (documents the hazard)', { skip }, async () => {
  const p = await pool();
  try {
    await seed(p);
    const store = new PgGraphStore(interleave(p, async () => {
      await p.query(`UPDATE relationship_confirmations SET confirmation_status='revoked', revoked_at=$2 WHERE relationship_id=$1 AND confirming_user_id=$3`, [R, NOW, X]);
    }));
    const { edges } = await store.getEdgesFrom(X, OPTS);
    assert.equal(edges.length, 1, 'edge query ran before the write');
    assert.ok(edges[0]!.confirmations.some((c) => c.status === 'revoked'), 'confirmations query ran after the write => torn');
  } finally { await p.end(); }
});

test('withGraphSnapshot gives one consistent view despite a concurrent revoke', { skip }, async () => {
  const p = await pool();
  try {
    await seed(p);
    const view = await withGraphSnapshot(p, async (s0) => {
      // rebind the store to an interleaving wrapper over the SAME snapshot client
      const client = (s0 as unknown as { db: PgQueryable }).db;
      const store = new PgGraphStore(interleave(client, async () => {
        await p.query(`UPDATE relationship_confirmations SET confirmation_status='revoked', revoked_at=$2 WHERE relationship_id=$1 AND confirming_user_id=$3`, [R, NOW, X]);
      }));
      return store.getEdgesFrom(X, OPTS);
    });
    assert.equal(view.edges.length, 1);
    assert.ok(view.edges[0]!.confirmations.every((c) => c.status === 'confirmed' && !c.revokedAt), 'snapshot hides the concurrent write');
    // a fresh read after the snapshot ended sees the revoke (edge is simply no longer eligible)
    const after = await new PgGraphStore(p).getEdgesFrom(X, OPTS);
    assert.equal(after.edges.length, 0, 'post-snapshot read sees committed revoke and fails closed');
  } finally { await p.end(); }
});

test('withGraphSnapshot always ends the transaction and releases the client, even on error', { skip }, async () => {
  const p = await pool();
  try {
    await seed(p);
    await assert.rejects(withGraphSnapshot(p, async () => { throw new Error('boom'); }), /boom/);
    for (let i = 0; i < 6; i++) await withGraphSnapshot(p, async (s) => { await s.getUsers([X]); }); // would hang if clients leaked (max 4)
    const { rows } = await p.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`);
    assert.equal((rows[0] as { n: number }).n, 0, 'no idle-in-transaction sessions left');
  } finally { await p.end(); }
});
