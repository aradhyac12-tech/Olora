// Invitation links: create / list / revoke (owner) and preview / accept / decline (any other signed-in user holding the token).
// Accepting does NOT make a trusted connection: it creates a PENDING relationship (acceptor confirmed, inviter pending).
// The inviter must then confirm (ConnectionService.confirm) after seeing who accepted — a leaked link cannot self-connect a stranger.
import { createHash } from 'node:crypto';
import type { PgQueryable } from '../graph/pgStore.ts';
import { noopLogger, errFields, type Logger } from '../introductions/logger.ts';
import type { ConnectionView, CreateInvitationInput, InvitationCreated, InvitationPreview, InvitationView, PersonView, RelationshipTypeName } from '../contracts/index.ts';
import { audit, asDate, asStr, fail, isUuid, ok, sqlState, TRUSTED_TYPES, TxAbort, withTx, type Out, type SocialPool } from './db.ts';
import { hashToken, looksLikeToken, newToken } from './tokens.ts';
import { loadConnection } from './connectionView.ts';

export interface InvitationOptions { logger?: Logger; confirmWindowDays?: number; maxActive?: number; maxPerDay?: number; defaultExpiryDays?: number }
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
type Row = Record<string, unknown>;

const PAIR_SQL = `((source_user_id = $1::uuid AND target_user_id = $2::uuid) OR (source_user_id = $2::uuid AND target_user_id = $1::uuid))`;

function toView(r: Row): InvitationView {
  const revoked = r.revoked_at !== null && r.revoked_at !== undefined;
  const max = r.max_uses === null ? null : Number(r.max_uses), used = Number(r.use_count);
  const status = revoked ? 'revoked' : r.expired === true ? 'expired' : max !== null && used >= max ? 'used' : 'active';
  return {
    id: asStr(r.id), purpose: asStr(r.purpose) as 'connect' | 'introduce', relationshipType: r.relationship_type === null ? null : asStr(r.relationship_type) as RelationshipTypeName,
    note: r.note === null ? null : asStr(r.note), maxUses: max, useCount: used, status, createdAt: asDate(r.created_at)!.toISOString(), expiresAt: asDate(r.expires_at)!.toISOString(),
  };
}

export class InvitationService {
  private readonly pool: SocialPool;
  private readonly log: Logger;
  private readonly o: Required<Omit<InvitationOptions, 'logger'>>;
  constructor(pool: SocialPool, opts: InvitationOptions = {}) {
    this.pool = pool; this.log = opts.logger ?? noopLogger;
    this.o = { confirmWindowDays: opts.confirmWindowDays ?? 7, maxActive: opts.maxActive ?? 50, maxPerDay: opts.maxPerDay ?? 30, defaultExpiryDays: opts.defaultExpiryDays ?? 14 };
  }

  private async guard<T>(event: string, fn: () => Promise<Out<T>>): Promise<Out<T>> {
    try { return await fn(); } catch (e) {
      if (sqlState(e) === '23505') return fail('ALREADY_CONNECTED');
      this.log.error(`${event}.error`, errFields(e)); return fail('INTERNAL');
    }
  }

  async create(ownerId: string, input: CreateInvitationInput, idempotencyKey: string): Promise<Out<InvitationCreated>> {
    if (!isUuid(ownerId) || !KEY_RE.test(idempotencyKey)) return fail('INVALID_INPUT');
    const reqHash = createHash('sha256').update(JSON.stringify([input.purpose, input.relationshipType ?? null, input.note ?? null, input.maxUses ?? null, input.expiresInDays ?? null])).digest('hex');
    return this.guard('invitation.create', () => withTx<Out<InvitationCreated>>(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`inv-create:${ownerId}`]); // serialises this owner's creates: quota + replay races
      const prev = await c.query(`SELECT request_hash, response FROM mutation_idempotency WHERE user_id=$1 AND scope='invitation.create' AND idempotency_key=$2`, [ownerId, idempotencyKey]);
      if (prev.rows[0]) return asStr(prev.rows[0].request_hash) === reqHash ? ok({ invitation: prev.rows[0].response as InvitationView, token: null, replayed: true }) : fail('IDEMPOTENCY_CONFLICT');
      const u = await c.query(`SELECT account_status, discoverable FROM users WHERE id=$1 FOR SHARE`, [ownerId]);
      if (!u.rows[0] || asStr(u.rows[0].account_status) !== 'active') return fail('NOT_FOUND');
      if (input.purpose === 'introduce' && u.rows[0].discoverable !== true) return fail('PROFILE_PRIVATE');
      const q = await c.query(
        `SELECT count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now() AND (max_uses IS NULL OR use_count < max_uses))::int AS active,
                count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS recent FROM invitations WHERE owner_id=$1`, [ownerId]);
      if (Number(q.rows[0]!.active) >= this.o.maxActive || Number(q.rows[0]!.recent) >= this.o.maxPerDay) return fail('QUOTA_EXCEEDED');
      const token = newToken();
      const days = input.expiresInDays ?? this.o.defaultExpiryDays;
      const connect = input.purpose === 'connect';
      const ins = await c.query(
        `INSERT INTO invitations (owner_id, purpose, token_hash, relationship_type, note, max_uses, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7::int))
         RETURNING *, (expires_at <= now()) AS expired`,
        [ownerId, input.purpose, hashToken(token), connect ? input.relationshipType : null, connect ? input.note ?? null : null, connect ? input.maxUses ?? 1 : null, days]);
      const view = toView(ins.rows[0]!);
      await c.query(`INSERT INTO mutation_idempotency (user_id, scope, idempotency_key, request_hash, response) VALUES ($1,'invitation.create',$2,$3,$4::jsonb)`, [ownerId, idempotencyKey, reqHash, JSON.stringify(view)]);
      await audit(c, { type: 'invitation_created', actorId: ownerId, invitationId: view.id, metadata: { purpose: view.purpose, maxUses: view.maxUses } });
      return ok({ invitation: view, token, replayed: false });
    }));
  }

  async listSent(ownerId: string): Promise<Out<InvitationView[]>> {
    if (!isUuid(ownerId)) return fail('INVALID_INPUT');
    return this.guard('invitation.list', async () => {
      const { rows } = await this.pool.query(`SELECT *, (expires_at <= now()) AS expired FROM invitations WHERE owner_id=$1 ORDER BY created_at DESC, id LIMIT 100`, [ownerId]);
      return ok(rows.map(toView));
    });
  }

  /** Owner only. A non-owner (or unknown id) gets NOT_FOUND. Revoking twice is fine. */
  async revoke(ownerId: string, invitationId: string): Promise<Out<InvitationView>> {
    if (!isUuid(ownerId) || !isUuid(invitationId)) return fail('NOT_FOUND');
    return this.guard('invitation.revoke', () => withTx<Out<InvitationView>>(this.pool, async (c) => {
      const cur = await c.query(`SELECT id, revoked_at FROM invitations WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [invitationId, ownerId]);
      if (!cur.rows[0]) return fail('NOT_FOUND');
      if (cur.rows[0].revoked_at === null) {
        await c.query(`UPDATE invitations SET revoked_at = now() WHERE id=$1`, [invitationId]);
        await audit(c, { type: 'invitation_revoked', actorId: ownerId, invitationId });
      }
      const { rows } = await c.query(`SELECT *, (expires_at <= now()) AS expired FROM invitations WHERE id=$1`, [invitationId]);
      return ok(toView(rows[0]!));
    }));
  }

  /** Token -> row (hash lookup only). Returns null when the token is malformed or unknown. */
  private async find(c: PgQueryable, token: string, lock: boolean): Promise<Row | null> {
    if (!looksLikeToken(token)) return null;
    const { rows } = await c.query(
      `SELECT i.*, (i.expires_at <= now()) AS expired, u.display_name AS owner_name, u.avatar_url AS owner_avatar, u.account_status AS owner_status, u.discoverable AS owner_discoverable
         FROM invitations i JOIN users u ON u.id = i.owner_id WHERE i.token_hash = $1 ${lock ? 'FOR UPDATE OF i' : ''}`, [hashToken(token)]);
    return rows[0] ?? null;
  }

  /** The single availability rule. Anything false => INVITATION_UNAVAILABLE, whatever the reason (no state can be probed). */
  private async available(c: PgQueryable, inv: Row, viewerId: string): Promise<boolean> {
    if (inv.revoked_at !== null || inv.expired === true || asStr(inv.owner_status) !== 'active' || asStr(inv.owner_id) === viewerId) return false;
    if (asStr(inv.purpose) === 'connect' && Number(inv.use_count) >= Number(inv.max_uses)) return false;
    if (asStr(inv.purpose) === 'introduce' && inv.owner_discoverable !== true) return false;
    const b = await c.query('SELECT wcim_users_blocked($1::uuid, $2::uuid) AS b', [asStr(inv.owner_id), viewerId]);
    return b.rows[0]!.b !== true;
  }

  async preview(viewerId: string, token: string): Promise<Out<InvitationPreview>> {
    if (!isUuid(viewerId)) return fail('INVALID_INPUT');
    return this.guard('invitation.preview', async () => {
      const inv = await this.find(this.pool, token, false);
      if (!inv || !(await this.available(this.pool, inv, viewerId))) return fail('INVITATION_UNAVAILABLE');
      const rel = await this.pool.query(
        `SELECT verification_status FROM relationships WHERE revoked_at IS NULL AND direction='mutual' AND relationship_type = ANY($3::text[]) AND ${PAIR_SQL}
           AND NOT (verification_status <> 'confirmed' AND confirm_by IS NOT NULL AND confirm_by <= now()) LIMIT 1`, [viewerId, asStr(inv.owner_id), [...TRUSTED_TYPES]]);
      const existing = !rel.rows[0] ? 'none' : asStr(rel.rows[0].verification_status) === 'confirmed' ? 'confirmed' : 'pending';
      return ok({
        purpose: asStr(inv.purpose) as 'connect' | 'introduce', from: { displayName: asStr(inv.owner_name), avatarUrl: inv.owner_avatar === null ? null : asStr(inv.owner_avatar) },
        relationshipType: inv.relationship_type === null ? null : asStr(inv.relationship_type) as RelationshipTypeName,
        note: inv.note === null ? null : asStr(inv.note), expiresAt: asDate(inv.expires_at)!.toISOString(), existing,
      });
    });
  }

  /** For target links: resolves to the owner id INTERNALLY (never returned to the client) plus what the viewer may see. */
  async resolveTarget(viewerId: string, token: string): Promise<Out<{ targetId: string; target: PersonView }>> {
    if (!isUuid(viewerId)) return fail('INVALID_INPUT');
    return this.guard('invitation.resolve', async () => {
      const inv = await this.find(this.pool, token, false);
      if (!inv || asStr(inv.purpose) !== 'introduce' || !(await this.available(this.pool, inv, viewerId))) return fail('INVITATION_UNAVAILABLE');
      return ok({ targetId: asStr(inv.owner_id), target: { displayName: asStr(inv.owner_name), avatarUrl: inv.owner_avatar === null ? null : asStr(inv.owner_avatar) } });
    });
  }

  /** Records the viewer's response under the invitation row lock. Shared by accept/decline. */
  private async respond(viewerId: string, token: string, outcome: 'accepted' | 'declined'): Promise<Out<{ connection: ConnectionView | null; replayed: boolean }>> {
    if (!isUuid(viewerId) || !looksLikeToken(token)) return fail('INVITATION_UNAVAILABLE');
    return this.guard(`invitation.${outcome}`, () => withTx<Out<{ connection: ConnectionView | null; replayed: boolean }>>(this.pool, async (c) => {
      const pre = await c.query('SELECT owner_id FROM invitations WHERE token_hash = $1', [hashToken(token)]);
      if (!pre.rows[0]) return fail('INVITATION_UNAVAILABLE');
      const ownerId = asStr(pre.rows[0].owner_id);
      if (ownerId === viewerId) return fail('INVITATION_UNAVAILABLE');
      // Lock protocol: pair advisory (SHARED: a concurrent block takes it exclusively), then the invitation row.
      await c.query('SELECT pg_advisory_xact_lock_shared(wcim_pair_lock_key($1::uuid, $2::uuid))', [ownerId, viewerId]);
      const inv = await this.find(c, token, true);
      if (!inv) return fail('INVITATION_UNAVAILABLE');
      const prev = await c.query('SELECT outcome, relationship_id FROM invitation_redemptions WHERE invitation_id=$1 AND user_id=$2', [asStr(inv.id), viewerId]);
      if (prev.rows[0]) { // replay of the same response is idempotent and never consumes a second use
        if (asStr(prev.rows[0].outcome) !== outcome) return fail('INVITATION_UNAVAILABLE');
        const conn = prev.rows[0].relationship_id ? await loadConnection(c, viewerId, asStr(prev.rows[0].relationship_id)) : null;
        return ok({ connection: conn, replayed: true });
      }
      if (asStr(inv.purpose) !== 'connect' || !(await this.available(c, inv, viewerId))) return fail('INVITATION_UNAVAILABLE');

      let relId: string | null = null;
      if (outcome === 'accepted') {
        // End stale rows first (overdue pending, expired trust) so they cannot occupy the "one live relationship per pair" slot.
        await c.query(
          `UPDATE relationships SET revoked_at = now(), ended_reason = 'expired'
            WHERE revoked_at IS NULL AND direction='mutual' AND ${PAIR_SQL}
              AND ((verification_status <> 'confirmed' AND confirm_by IS NOT NULL AND confirm_by <= now()) OR (expires_at IS NOT NULL AND expires_at <= now()))`, [ownerId, viewerId]);
        const live = await c.query(`SELECT id FROM relationships WHERE revoked_at IS NULL AND direction='mutual' AND relationship_type = ANY($3::text[]) AND ${PAIR_SQL} LIMIT 1`, [ownerId, viewerId, [...TRUSTED_TYPES]]);
        if (live.rows[0]) throw new TxAbort(fail<{ connection: ConnectionView | null; replayed: boolean }>('ALREADY_CONNECTED'));
        const rel = await c.query(
          `INSERT INTO relationships (source_user_id, target_user_id, relationship_type, direction, verification_status, permission_status, initiated_by, confirm_by, invitation_id)
           VALUES ($1,$2,$3,'mutual','unverified','pending',$1, now() + make_interval(days => $4::int), $5) RETURNING id`,
          [ownerId, viewerId, asStr(inv.relationship_type), this.o.confirmWindowDays, asStr(inv.id)]);
        relId = asStr(rel.rows[0]!.id);
        await c.query(`INSERT INTO relationship_confirmations (relationship_id, confirming_user_id, confirmation_status, confirmed_at) VALUES ($1,$2,'confirmed', now()), ($1,$3,'pending', NULL)`, [relId, viewerId, ownerId]);
      }
      await c.query('INSERT INTO invitation_redemptions (invitation_id, user_id, outcome, relationship_id) VALUES ($1,$2,$3,$4)', [asStr(inv.id), viewerId, outcome, relId]);
      await c.query('UPDATE invitations SET use_count = use_count + 1 WHERE id = $1', [asStr(inv.id)]);
      await audit(c, { type: outcome === 'accepted' ? 'invitation_accepted' : 'invitation_declined', actorId: viewerId, subjectUserId: ownerId, relationshipId: relId, invitationId: asStr(inv.id) });
      return ok({ connection: relId ? await loadConnection(c, viewerId, relId) : null, replayed: false });
    }));
  }

  accept(viewerId: string, token: string) { return this.respond(viewerId, token, 'accepted'); }
  decline(viewerId: string, token: string) { return this.respond(viewerId, token, 'declined'); }
}
