// Account controls: export own data, delete own account. Both scoped to the authenticated user only.
import { noopLogger, errFields, type Logger } from '../introductions/logger.ts';
import { verifyPassword } from '../auth/password.ts';
import { asStr, fail, isUuid, ok, withTx, type Out, type SocialPool } from './db.ts';

export class AccountService {
  private readonly pool: SocialPool;
  private readonly log: Logger;
  constructor(pool: SocialPool, opts: { logger?: Logger } = {}) { this.pool = pool; this.log = opts.logger ?? noopLogger; }

  /** Everything Olora stores about the caller, as JSON. Other people appear only by display name; never by id or email. */
  async export(userId: string): Promise<Out<Record<string, unknown>>> {
    if (!isUuid(userId)) return fail('NOT_FOUND');
    try {
      const q = (sql: string) => this.pool.query(sql, [userId]).then((r) => r.rows);
      const [profile, identities, connections, invitations, blocks, reports, intros, consents] = await Promise.all([
        q(`SELECT email, display_name, avatar_url, discoverable, accepts_introductions, created_at FROM users WHERE id=$1`),
        q(`SELECT platform, username, verification_status, created_at FROM external_profiles WHERE user_id=$1 ORDER BY created_at`),
        q(`SELECT r.relationship_type, r.verification_status, r.created_at, r.confirmed_at, r.revoked_at, o.display_name AS other
             FROM relationships r JOIN users o ON o.id = CASE WHEN r.source_user_id=$1 THEN r.target_user_id ELSE r.source_user_id END
            WHERE r.source_user_id=$1 OR r.target_user_id=$1 ORDER BY r.created_at`),
        q(`SELECT purpose, relationship_type, note, max_uses, use_count, created_at, expires_at, revoked_at FROM invitations WHERE owner_id=$1 ORDER BY created_at`),
        q(`SELECT u.display_name AS blocked, b.created_at FROM blocks b JOIN users u ON u.id=b.blocked_user_id WHERE b.blocker_user_id=$1 ORDER BY b.created_at`),
        q(`SELECT kind, reason, status, created_at FROM reports WHERE reporter_id=$1 ORDER BY created_at`),
        q(`SELECT status, message, created_at FROM introduction_requests WHERE requester_id=$1 ORDER BY created_at`),
        q(`SELECT consent_type, granted, granted_at, revoked_at FROM consents WHERE user_id=$1 ORDER BY consent_type`),
      ]);
      return ok({ exportedAt: new Date().toISOString(), profile: profile[0] ?? null, consents, externalIdentities: identities, connections, invitationsCreated: invitations, blocked: blocks, reportsFiled: reports, introductionsRequested: intros });
    } catch (e) { this.log.error('account.export.error', errFields(e)); return fail('INTERNAL'); }
  }

  /** Hard delete. Every owned row (sessions, relationships, invitations, blocks, consents, audit rows) goes with the user via ON DELETE CASCADE. */
  async deleteAccount(userId: string, password: string | undefined): Promise<Out<{ deleted: true }>> {
    if (!isUuid(userId)) return fail('NOT_FOUND');
    try {
      return await withTx<Out<{ deleted: true }>>(this.pool, async (c) => {
        const u = await c.query(`SELECT u.id, (SELECT password_hash FROM user_credentials WHERE user_id = u.id) AS hash FROM users u WHERE u.id=$1 FOR UPDATE`, [userId]);
        if (!u.rows[0]) return fail('NOT_FOUND');
        if (u.rows[0].hash !== null) { // password accounts must re-prove the password; OAuth-only accounts rely on the live session
          if (!password || !(await verifyPassword(password, asStr(u.rows[0].hash)))) return fail('INVALID_CREDENTIALS');
        }
        await c.query('DELETE FROM users WHERE id=$1', [userId]);
        return ok({ deleted: true as const });
      });
    } catch (e) { this.log.error('account.delete.error', errFields(e)); return fail('INTERNAL'); }
  }
}
