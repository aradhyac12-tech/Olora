// Blocking and reporting. Subjects are never raw user ids: a caller can only name someone they legitimately hold a handle for
// (their own connection, an invitation token, or an introduction they may see).
// A block (a) is serialised against introduction creation by the pair advisory lock taken in a DB trigger, (b) ends live relationships (DB trigger),
// and (c) is invisible to the blocked user: every later failure they can observe is the same generic one used for expired/unknown things.
import { createHash } from 'node:crypto';
import type { PgQueryable } from '../graph/pgStore.ts';
import { noopLogger, errFields, type Logger } from '../introductions/logger.ts';
import type { BlockView, ReportInput, Subject } from '../contracts/index.ts';
import { canSee } from '../introductions/stateMachine.ts';
import type { IntroParties, IntroStatus } from '../introductions/stateMachine.ts';
import { audit, asDate, asStr, fail, isUuid, ok, TRUSTED_TYPES, withTx, type Out, type SocialPool } from './db.ts';
import { hashToken, looksLikeToken } from './tokens.ts';

const MAX_BLOCKS = 500;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
type Row = Record<string, unknown>;

export class SafetyService {
  private readonly pool: SocialPool;
  private readonly log: Logger;
  private readonly maxReportsPerDay: number;
  constructor(pool: SocialPool, opts: { logger?: Logger; maxReportsPerDay?: number } = {}) {
    this.pool = pool; this.log = opts.logger ?? noopLogger; this.maxReportsPerDay = opts.maxReportsPerDay ?? 20;
  }

  private async guard<T>(event: string, fn: () => Promise<Out<T>>): Promise<Out<T>> {
    try { return await fn(); } catch (e) { this.log.error(`${event}.error`, errFields(e)); return fail('INTERNAL'); }
  }

  /** Subject -> the OTHER user's id (internal) + the invitation involved, if any. null => NOT_FOUND. */
  private async resolve(c: PgQueryable, actorId: string, s: Subject): Promise<{ userId: string; invitationId: string | null } | null> {
    if ('connectionId' in s) {
      const r = await c.query(
        `SELECT CASE WHEN source_user_id=$1::uuid THEN target_user_id ELSE source_user_id END AS other FROM relationships
          WHERE id=$2::uuid AND (source_user_id=$1::uuid OR target_user_id=$1::uuid) AND relationship_type = ANY($3::text[])`, [actorId, s.connectionId, [...TRUSTED_TYPES]]);
      return r.rows[0] ? { userId: asStr(r.rows[0].other), invitationId: null } : null;
    }
    if ('invitationToken' in s) {
      if (!looksLikeToken(s.invitationToken)) return null;
      const r = await c.query(`SELECT id, owner_id FROM invitations WHERE token_hash=$1`, [hashToken(s.invitationToken)]);
      return r.rows[0] ? { userId: asStr(r.rows[0].owner_id), invitationId: asStr(r.rows[0].id) } : null;
    }
    const r = await c.query(`SELECT requester_id, connector_id, target_id, status, expires_at, connector_accepted_at FROM introduction_requests WHERE id=$1::uuid`, [s.introductionId]);
    if (!r.rows[0]) return null;
    const p: IntroParties = { requesterId: asStr(r.rows[0].requester_id), connectorId: asStr(r.rows[0].connector_id), targetId: asStr(r.rows[0].target_id),
      status: asStr(r.rows[0].status) as IntroStatus, expiresAt: asDate(r.rows[0].expires_at)!, connectorAcceptedAt: asDate(r.rows[0].connector_accepted_at) };
    if (!canSee(p, actorId)) return null;
    const other = s.party === 'requester' ? p.requesterId : s.party === 'connector' ? p.connectorId : p.targetId;
    return other === actorId ? null : { userId: other, invitationId: null };
  }

  async list(userId: string): Promise<Out<BlockView[]>> {
    if (!isUuid(userId)) return fail('INVALID_INPUT');
    return this.guard('block.list', async () => {
      const { rows } = await this.pool.query(`SELECT b.id, b.created_at, u.display_name, u.avatar_url FROM blocks b JOIN users u ON u.id=b.blocked_user_id WHERE b.blocker_user_id=$1 ORDER BY b.created_at DESC, b.id LIMIT 500`, [userId]);
      return ok(rows.map((r) => ({ id: asStr(r.id), displayName: asStr(r.display_name), avatarUrl: r.avatar_url === null ? null : asStr(r.avatar_url), createdAt: asDate(r.created_at)!.toISOString() })));
    });
  }

  /** Idempotent: blocking someone already blocked returns the same block. */
  async block(userId: string, subject: Subject): Promise<Out<BlockView>> {
    if (!isUuid(userId)) return fail('INVALID_INPUT');
    return this.guard('block.create', () => withTx<Out<BlockView>>(this.pool, async (c) => this.blockOn(c, userId, subject)));
  }

  private async blockOn(c: PgQueryable, userId: string, subject: Subject): Promise<Out<BlockView>> {
    const who = await this.resolve(c, userId, subject);
    if (!who || who.userId === userId) return fail('NOT_FOUND');
    const cap = await c.query(`SELECT count(*)::int AS n FROM blocks WHERE blocker_user_id=$1`, [userId]);
    const ins = await c.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2) ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING RETURNING id`, [userId, who.userId]);
    if (ins.rows[0]) {
      if (Number(cap.rows[0]!.n) >= MAX_BLOCKS) return fail('QUOTA_EXCEEDED');
      await audit(c, { type: 'user_blocked', actorId: userId, subjectUserId: who.userId });
    }
    const { rows } = await c.query(`SELECT b.id, b.created_at, u.display_name, u.avatar_url FROM blocks b JOIN users u ON u.id=b.blocked_user_id WHERE b.blocker_user_id=$1 AND b.blocked_user_id=$2`, [userId, who.userId]);
    const r = rows[0]!;
    return ok({ id: asStr(r.id), displayName: asStr(r.display_name), avatarUrl: r.avatar_url === null ? null : asStr(r.avatar_url), createdAt: asDate(r.created_at)!.toISOString() });
  }

  /** Idempotent and owner-scoped: an unknown or foreign block id is a silent no-op. Unblocking does NOT restore relationships the block ended. */
  async unblock(userId: string, blockId: string): Promise<Out<{ removed: boolean }>> {
    if (!isUuid(userId) || !isUuid(blockId)) return ok({ removed: false });
    return this.guard('block.remove', () => withTx<Out<{ removed: boolean }>>(this.pool, async (c) => {
      const r = await c.query(`DELETE FROM blocks WHERE id=$1 AND blocker_user_id=$2 RETURNING blocked_user_id`, [blockId, userId]);
      if (r.rows[0]) await audit(c, { type: 'user_unblocked', actorId: userId, subjectUserId: asStr(r.rows[0].blocked_user_id) });
      return ok({ removed: !!r.rows[0] });
    }));
  }

  /** The reported user is never told. One OPEN report per (reporter, reported, kind); a repeat returns the existing report. */
  async report(userId: string, input: ReportInput, idempotencyKey: string): Promise<Out<{ id: string; blocked: boolean }>> {
    if (!isUuid(userId) || !KEY_RE.test(idempotencyKey)) return fail('INVALID_INPUT');
    const reqHash = createHash('sha256').update(JSON.stringify([input.subject, input.reason, input.details ?? null, input.alsoBlock ?? false])).digest('hex');
    return this.guard('report.create', () => withTx<Out<{ id: string; blocked: boolean }>>(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`report:${userId}`]);
      const prev = await c.query(`SELECT request_hash, response FROM mutation_idempotency WHERE user_id=$1 AND scope='report.create' AND idempotency_key=$2`, [userId, idempotencyKey]);
      if (prev.rows[0]) return asStr(prev.rows[0].request_hash) === reqHash ? ok(prev.rows[0].response as { id: string; blocked: boolean }) : fail('IDEMPOTENCY_CONFLICT');
      const recent = await c.query(`SELECT count(*)::int AS n FROM reports WHERE reporter_id=$1 AND created_at > now() - interval '24 hours'`, [userId]);
      if (Number(recent.rows[0]!.n) >= this.maxReportsPerDay) return fail('QUOTA_EXCEEDED');
      const who = await this.resolve(c, userId, input.subject);
      if (!who || who.userId === userId) return fail('NOT_FOUND');
      const kind = 'invitationToken' in input.subject ? 'invitation_abuse' : 'user';
      const ins = await c.query(
        `INSERT INTO reports (reporter_id, reported_user_id, invitation_id, kind, reason, details) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (reporter_id, reported_user_id, kind) WHERE status = 'open' DO NOTHING RETURNING id`, [userId, who.userId, who.invitationId, kind, input.reason, input.details ?? null]);
      let id: string;
      if (ins.rows[0]) {
        id = asStr(ins.rows[0].id);
        await audit(c, { type: 'report_filed', actorId: userId, subjectUserId: who.userId, invitationId: who.invitationId, metadata: { kind, reason: input.reason } });
      } else {
        const ex = await c.query(`SELECT id FROM reports WHERE reporter_id=$1 AND reported_user_id=$2 AND kind=$3 AND status='open'`, [userId, who.userId, kind]);
        id = asStr(ex.rows[0]!.id);
      }
      let blocked = false;
      if (input.alsoBlock) { const b = await this.blockOn(c, userId, input.subject); blocked = b.ok; }
      const out = { id, blocked };
      await c.query(`INSERT INTO mutation_idempotency (user_id, scope, idempotency_key, request_hash, response) VALUES ($1,'report.create',$2,$3,$4::jsonb)`, [userId, idempotencyKey, reqHash, JSON.stringify(out)]);
      return ok(out);
    }));
  }
}
export type { Row };
