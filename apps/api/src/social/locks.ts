// Lock protocol for everything that creates or relies on a trusted path. ORDER IS PART OF THE CONTRACT (it prevents deadlocks):
//   1. per-pair advisory locks, in sorted pair order   (blocks take the EXCLUSIVE lock in a DB trigger; path users take it SHARED)
//   2. users rows, in id order                          (profile/privacy updates take the row lock implicitly via UPDATE)
//   3. relationship rows, in id order                   (revoke/confirm/permission take FOR UPDATE; path users take FOR SHARE)
// With the locks held, statements run in READ COMMITTED and therefore see every change that committed before the lock was granted.
import type { PgQueryable } from '../graph/pgStore.ts';

export const sortedPairs = (ids: string[]): Array<[string, string]> => {
  const u = [...new Set(ids)].sort();
  const out: Array<[string, string]> = [];
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) out.push([u[i]!, u[j]!]);
  return out;
};

export async function lockPairsShared(c: PgQueryable, ids: string[]): Promise<void> {
  for (const [a, b] of sortedPairs(ids)) await c.query('SELECT pg_advisory_xact_lock_shared(wcim_pair_lock_key($1::uuid, $2::uuid))', [a, b]);
}
export async function lockPairExclusive(c: PgQueryable, a: string, b: string): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(wcim_pair_lock_key($1::uuid, $2::uuid))', [a, b]);
}
export async function lockUsersShared(c: PgQueryable, ids: string[]): Promise<void> {
  await c.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [[...new Set(ids)].sort()]);
}
/** Every relationship row (any state) between each given pair, FOR SHARE, in id order. A concurrent revoke/confirm/permission change waits for us. */
export async function lockRelationshipsShared(c: PgQueryable, pairs: Array<[string, string]>): Promise<void> {
  if (pairs.length === 0) return;
  const lo = pairs.map(([a, b]) => (a < b ? a : b)), hi = pairs.map(([a, b]) => (a < b ? b : a));
  await c.query(
    `SELECT r.id FROM relationships r
       JOIN unnest($1::uuid[], $2::uuid[]) AS p(lo, hi) ON LEAST(r.source_user_id, r.target_user_id) = p.lo AND GREATEST(r.source_user_id, r.target_user_id) = p.hi
      ORDER BY r.id FOR SHARE OF r`, [lo, hi]);
}

/** Lock everything an introduction path requester -> connector -> target depends on (protocol above). */
export async function lockIntroductionPath(c: PgQueryable, requesterId: string, connectorId: string, targetId: string): Promise<void> {
  await lockPairsShared(c, [requesterId, connectorId, targetId]);
  await lockUsersShared(c, [requesterId, connectorId, targetId]);
  await lockRelationshipsShared(c, [[requesterId, connectorId], [connectorId, targetId]]);
}
