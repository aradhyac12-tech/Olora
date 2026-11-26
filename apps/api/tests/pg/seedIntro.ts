// Shared seeding for introduction integration tests (real PostgreSQL, legal DB transitions only).
import type { PgQueryable } from '../../src/graph/pgStore.ts';
export const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const A = uid(1), B = uid(2), tgt = (i: number) => uid(100 + i);
const PAST = new Date('2026-05-01T00:00:00Z'), CONF = new Date('2026-05-02T00:00:00Z');

export async function seedEdge(c: PgQueryable, id: string, a: string, b: string): Promise<void> {
  await c.query(`INSERT INTO relationships (id,source_user_id,target_user_id,relationship_type,direction,verification_status,permission_status,created_at) VALUES ($1,$2,$3,'acquaintance','mutual','unverified','granted',$4)`, [id, a, b, PAST]);
  for (const u of [a, b]) await c.query(`INSERT INTO relationship_confirmations (relationship_id,confirming_user_id,confirmation_status,confirmed_at) VALUES ($1,$2,'confirmed',$3)`, [id, u, CONF]);
  await c.query(`UPDATE relationships SET verification_status='confirmed', confirmed_at=$2 WHERE id=$1`, [id, CONF]);
}
/** A(requester) — B(connector) — T1..Tn (targets). Every user is active, discoverable and accepts introductions. */
export async function seedWorld(c: PgQueryable, nTargets: number): Promise<void> {
  await c.query('TRUNCATE introduction_idempotency, audit_events, notification_outbox, introduction_requests, blocks, consents, relationship_confirmations, relationship_evidence, relationships, external_profiles, users CASCADE');
  const ids = [A, B, ...Array.from({ length: nTargets }, (_, i) => tgt(i + 1))];
  for (const id of ids) await c.query(`INSERT INTO users (id,email,display_name,account_status,discoverable,accepts_introductions) VALUES ($1,$2,'U','active',true,true)`, [id, `${id}@example.test`]);
  await seedEdge(c, uid(1000), A, B);
  for (let i = 1; i <= nTargets; i++) await seedEdge(c, uid(1000 + i), B, tgt(i));
}
