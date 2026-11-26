// Relationship lifecycle after an invitation was accepted: list / get / confirm / decline / revoke / permission.
// Lock protocol for every mutation: the relationship row FOR UPDATE first, then the confirmation rows. Introduction creation/acceptance holds the
// same relationship row FOR SHARE (locks.ts), so a revoke/confirm/permission change and an introduction can never interleave inconsistently.
import type { PgQueryable } from '../graph/pgStore.ts';
import { noopLogger, errFields, type Logger } from '../introductions/logger.ts';
import type { ConnectionStatus, ConnectionView } from '../contracts/index.ts';
import { audit, asStr, fail, isUuid, ok, sqlState, TRUSTED_TYPES, TxAbort, withTx, type Out, type SocialPool } from './db.ts';
import { CONNECTION_SELECT, loadConnection, toConnectionView } from './connectionView.ts';

type Row = Record<string, unknown>;
const RELOAD_ORDER = `ORDER BY r.created_at DESC, r.id LIMIT 200`;

export class ConnectionService {
  private readonly pool: SocialPool;
  private readonly log: Logger;
  constructor(pool: SocialPool, opts: { logger?: Logger } = {}) { this.pool = pool; this.log = opts.logger ?? noopLogger; }

  private async guard<T>(event: string, fn: () => Promise<Out<T>>): Promise<Out<T>> {
    try { return await fn(); } catch (e) { this.log.error(`${event}.error`, errFields(e)); return fail('INTERNAL'); }
  }

  async list(userId: string, status: ConnectionStatus | 'all' = 'all'): Promise<Out<ConnectionView[]>> {
    if (!isUuid(userId)) return fail('INVALID_INPUT');
    return this.guard('connection.list', async () => {
      const { rows } = await this.pool.query(`${CONNECTION_SELECT} ${RELOAD_ORDER}`, [userId, [...TRUSTED_TYPES]]);
      const all = rows.map(toConnectionView);
      return ok(status === 'all' ? all : all.filter((c) => c.status === status));
    });
  }

  async get(userId: string, id: string): Promise<Out<ConnectionView>> {
    if (!isUuid(userId) || !isUuid(id)) return fail('NOT_FOUND');
    return this.guard('connection.get', async () => { const v = await loadConnection(this.pool, userId, id); return v ? ok(v) : fail('NOT_FOUND'); });
  }

  /**
   * Lock + load the participant's view of a relationship. NOT_FOUND for unknown ids AND for non-participants (no relationship enumeration).
   * Overdue pending relationships are ended here, durably, before the caller decides.
   */
  private async lockOwn(c: PgQueryable, userId: string, id: string): Promise<{ row: Row; other: string; mine: Row }> {
    const rel = await c.query(
      `SELECT id, source_user_id, target_user_id, verification_status, revoked_at, confirm_by, expires_at FROM relationships
        WHERE id=$1::uuid AND direction='mutual' AND relationship_type = ANY($3::text[]) AND (source_user_id=$2::uuid OR target_user_id=$2::uuid) FOR UPDATE`, [id, userId, [...TRUSTED_TYPES]]);
    if (!rel.rows[0]) throw new TxAbort(fail('NOT_FOUND'));
    const row = rel.rows[0];
    const conf = await c.query(`SELECT confirming_user_id, confirmation_status, allows_traversal FROM relationship_confirmations WHERE relationship_id=$1 ORDER BY confirming_user_id FOR UPDATE`, [id]);
    const mine = conf.rows.find((r) => asStr(r.confirming_user_id) === userId);
    if (!mine) throw new TxAbort(fail('NOT_FOUND'));
    return { row, other: asStr(row.source_user_id) === userId ? asStr(row.target_user_id) : asStr(row.source_user_id), mine };
  }

  private async endRelationship(c: PgQueryable, userId: string, id: string, reason: 'declined' | 'revoked' | 'withdrawn' | 'expired', myConfirmationStatus: string): Promise<void> {
    if (myConfirmationStatus !== 'revoked') {
      await c.query(`UPDATE relationship_confirmations SET confirmation_status='revoked', revoked_at=now() WHERE relationship_id=$1 AND confirming_user_id=$2`, [id, userId]);
    }
    await c.query(`UPDATE relationships SET revoked_at=now(), ended_reason=$2, ended_by=$3, permission_status = CASE WHEN permission_status='granted' THEN 'denied' ELSE permission_status END WHERE id=$1 AND revoked_at IS NULL`, [id, reason, userId]);
  }

  /** The pending participant confirms. When both confirmations are active the relationship becomes confirmed (trusted iff both allow introductions). */
  async confirm(userId: string, id: string): Promise<Out<ConnectionView>> {
    if (!isUuid(userId) || !isUuid(id)) return fail('NOT_FOUND');
    return this.guard('connection.confirm', () => withTx<Out<ConnectionView>>(this.pool, async (c) => {
      const { row, other, mine } = await this.lockOwn(c, userId, id);
      if (row.revoked_at !== null) return fail('INVALID_STATE');
      const myStatus = asStr(mine.confirmation_status);
      if (myStatus === 'confirmed') { const v = await loadConnection(c, userId, id); return v ? ok(v) : fail('NOT_FOUND'); } // idempotent retry
      if (myStatus !== 'pending') return fail('INVALID_STATE');
      const od = await c.query(`SELECT (confirm_by IS NOT NULL AND confirm_by <= now()) AS overdue FROM relationships WHERE id=$1`, [id]);
      if (od.rows[0]!.overdue === true) {
        await this.endRelationship(c, userId, id, 'expired', myStatus);
        await audit(c, { type: 'connection_expired', actorId: userId, subjectUserId: other, relationshipId: id });
        return fail('EXPIRED'); // commit: the lazy expiry is persisted
      }
      const blocked = await c.query('SELECT wcim_users_blocked($1::uuid,$2::uuid) AS b', [userId, other]);
      if (blocked.rows[0]!.b === true) return fail('INVALID_STATE'); // a block already ended the relationship; same answer as any ended one
      await c.query(`UPDATE relationship_confirmations SET confirmation_status='confirmed', confirmed_at=now() WHERE relationship_id=$1 AND confirming_user_id=$2`, [id, userId]);
      const both = await c.query(`SELECT count(*)::int AS n, bool_and(allows_traversal) AS allow FROM relationship_confirmations WHERE relationship_id=$1 AND confirmation_status='confirmed' AND revoked_at IS NULL`, [id]);
      if (Number(both.rows[0]!.n) === 2) {
        await c.query(`UPDATE relationships SET verification_status='confirmed', confirmed_at=now(), permission_status=$2 WHERE id=$1`, [id, both.rows[0]!.allow === true ? 'granted' : 'denied']);
      }
      await audit(c, { type: 'connection_confirmed', actorId: userId, subjectUserId: other, relationshipId: id, metadata: { complete: Number(both.rows[0]!.n) === 2 } });
      const v = await loadConnection(c, userId, id);
      return v ? ok(v) : fail('NOT_FOUND');
    }));
  }

  /** The participant whose confirmation is pending refuses. Ends the relationship (reason 'declined', never shown to the other side). */
  async decline(userId: string, id: string): Promise<Out<ConnectionView>> {
    if (!isUuid(userId) || !isUuid(id)) return fail('NOT_FOUND');
    return this.guard('connection.decline', () => withTx<Out<ConnectionView>>(this.pool, async (c) => {
      const { row, other, mine } = await this.lockOwn(c, userId, id);
      const myStatus = asStr(mine.confirmation_status);
      if (row.revoked_at !== null) { const v = await loadConnection(c, userId, id); return v ? ok(v) : fail('NOT_FOUND'); } // already ended: idempotent
      if (myStatus !== 'pending') return fail('INVALID_STATE'); // you already confirmed: use revoke
      await this.endRelationship(c, userId, id, 'declined', myStatus);
      await audit(c, { type: 'connection_declined', actorId: userId, subjectUserId: other, relationshipId: id });
      const v = await loadConnection(c, userId, id);
      return v ? ok(v) : fail('NOT_FOUND');
    }));
  }

  /** Either participant ends a pending (withdraw) or confirmed (revoke) relationship. Terminal. Idempotent. */
  async revoke(userId: string, id: string): Promise<Out<ConnectionView>> {
    if (!isUuid(userId) || !isUuid(id)) return fail('NOT_FOUND');
    return this.guard('connection.revoke', () => withTx<Out<ConnectionView>>(this.pool, async (c) => {
      const { row, other, mine } = await this.lockOwn(c, userId, id);
      if (row.revoked_at === null) {
        const confirmed = asStr(row.verification_status) === 'confirmed';
        await this.endRelationship(c, userId, id, confirmed ? 'revoked' : 'withdrawn', asStr(mine.confirmation_status));
        await audit(c, { type: confirmed ? 'connection_revoked' : 'connection_withdrawn', actorId: userId, subjectUserId: other, relationshipId: id });
      }
      const v = await loadConnection(c, userId, id);
      return v ? ok(v) : fail('NOT_FOUND');
    }));
  }

  /** Withhold (or restore) this relationship for introduction paths without ending it. Only your own flag can change. */
  async setPermission(userId: string, id: string, allowIntroductions: boolean): Promise<Out<ConnectionView>> {
    if (!isUuid(userId) || !isUuid(id)) return fail('NOT_FOUND');
    return this.guard('connection.permission', () => withTx<Out<ConnectionView>>(this.pool, async (c) => {
      const { row, other, mine } = await this.lockOwn(c, userId, id);
      if (row.revoked_at !== null || asStr(mine.confirmation_status) === 'revoked') return fail('INVALID_STATE');
      if (mine.allows_traversal !== allowIntroductions) {
        await c.query(`UPDATE relationship_confirmations SET allows_traversal=$3 WHERE relationship_id=$1 AND confirming_user_id=$2`, [id, userId, allowIntroductions]);
        if (asStr(row.verification_status) === 'confirmed') {
          const f = await c.query(`SELECT bool_and(allows_traversal) AS allow FROM relationship_confirmations WHERE relationship_id=$1`, [id]);
          await c.query(`UPDATE relationships SET permission_status=$2 WHERE id=$1`, [id, f.rows[0]!.allow === true ? 'granted' : 'denied']);
        }
        await audit(c, { type: 'connection_permission_changed', actorId: userId, subjectUserId: other, relationshipId: id, metadata: { allowIntroductions } });
      }
      const v = await loadConnection(c, userId, id);
      return v ? ok(v) : fail('NOT_FOUND');
    }));
  }

  /** Housekeeping: durably end pending relationships past their confirmation deadline. Safe to run any time, from any instance. */
  async expireOverduePending(limit = 500): Promise<number> {
    try {
      const { rows } = await this.pool.query(
        `UPDATE relationships SET revoked_at=now(), ended_reason='expired' WHERE id IN (
           SELECT id FROM relationships WHERE revoked_at IS NULL AND verification_status <> 'confirmed' AND confirm_by IS NOT NULL AND confirm_by <= now() ORDER BY confirm_by LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id`, [limit]);
      return rows.length;
    } catch (e) { if (sqlState(e) !== '') this.log.error('connection.expire.error', errFields(e)); return 0; }
  }
}
