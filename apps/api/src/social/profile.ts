// Own profile, privacy settings and self-asserted external handles. Everything here is scoped to the authenticated user id:
// no function takes another user's id, so there is no IDOR surface. Defaults stay private (discoverable=false, acceptsIntroductions=false).
import { noopLogger, errFields, type Logger } from '../introductions/logger.ts';
import type { IdentityInput, PrivacyInput, ProfilePatch, ProfileView } from '../contracts/index.ts';
import { audit, asStr, fail, isUuid, ok, sqlState, withTx, type Out, type SocialPool } from './db.ts';

const MAX_IDENTITIES = 10;

export class ProfileService {
  private readonly pool: SocialPool;
  private readonly log: Logger;
  constructor(pool: SocialPool, opts: { logger?: Logger } = {}) { this.pool = pool; this.log = opts.logger ?? noopLogger; }

  private async guard<T>(event: string, fn: () => Promise<Out<T>>): Promise<Out<T>> {
    try { return await fn(); } catch (e) { this.log.error(`${event}.error`, errFields(e)); return fail('INTERNAL'); }
  }

  async get(userId: string): Promise<Out<ProfileView>> {
    if (!isUuid(userId)) return fail('NOT_FOUND');
    return this.guard('profile.get', async () => {
      const u = await this.pool.query(
        `SELECT u.display_name, u.email, u.avatar_url, u.discoverable, u.accepts_introductions,
                EXISTS (SELECT 1 FROM user_credentials WHERE user_id = u.id) AS has_password,
                EXISTS (SELECT 1 FROM oauth_identities WHERE user_id = u.id) AS has_google
           FROM users u WHERE u.id = $1 AND u.account_status = 'active'`, [userId]);
      const r = u.rows[0];
      if (!r) return fail('NOT_FOUND');
      const ids = await this.pool.query(`SELECT id, platform, username, verification_status FROM external_profiles WHERE user_id=$1 ORDER BY created_at, id`, [userId]);
      return ok({
        displayName: asStr(r.display_name), email: asStr(r.email), avatarUrl: r.avatar_url === null ? null : asStr(r.avatar_url),
        discoverable: r.discoverable === true, acceptsIntroductions: r.accepts_introductions === true,
        signIn: { password: r.has_password === true, google: r.has_google === true },
        identities: ids.rows.map((i) => ({ id: asStr(i.id), platform: asStr(i.platform), username: asStr(i.username), verification: asStr(i.verification_status) as 'unverified' | 'pending' | 'verified' })),
      });
    });
  }

  async update(userId: string, patch: ProfilePatch): Promise<Out<ProfileView>> {
    if (!isUuid(userId)) return fail('NOT_FOUND');
    return this.guard('profile.update', async () => {
      const changed: string[] = [];
      const res = await withTx<Out<null>>(this.pool, async (c) => {
        const sets: string[] = []; const vals: unknown[] = [userId];
        if (patch.displayName !== undefined) { vals.push(patch.displayName); sets.push(`display_name = $${vals.length}`); changed.push('displayName'); }
        if (patch.avatarUrl !== undefined) { vals.push(patch.avatarUrl); sets.push(`avatar_url = $${vals.length}`); changed.push('avatarUrl'); }
        if (sets.length === 0) return fail('INVALID_INPUT');
        const r = await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND account_status = 'active' RETURNING id`, vals); // column names are fixed literals above
        if (!r.rows[0]) return fail('NOT_FOUND');
        await audit(c, { type: 'profile_changed', actorId: userId, metadata: { fields: changed.join(',') } });
        return ok(null);
      });
      return res.ok ? this.get(userId) : fail(res.code);
    });
  }

  /** Discoverability and introduction acceptance are SEPARATE consents. The users flag (read by the graph) and the consents record change in ONE transaction. */
  async setPrivacy(userId: string, input: PrivacyInput): Promise<Out<ProfileView>> {
    if (!isUuid(userId)) return fail('NOT_FOUND');
    return this.guard('profile.privacy', async () => {
      const res = await withTx<Out<null>>(this.pool, async (c) => {
        const cur = await c.query(`SELECT discoverable, accepts_introductions FROM users WHERE id=$1 AND account_status='active' FOR UPDATE`, [userId]);
        if (!cur.rows[0]) return fail('NOT_FOUND');
        const next = { discoverable: input.discoverable ?? cur.rows[0].discoverable === true, accepts: input.acceptsIntroductions ?? cur.rows[0].accepts_introductions === true };
        const meta: Record<string, boolean> = {};
        if (next.discoverable !== (cur.rows[0].discoverable === true)) meta.discoverable = next.discoverable;
        if (next.accepts !== (cur.rows[0].accepts_introductions === true)) meta.acceptsIntroductions = next.accepts;
        if (Object.keys(meta).length === 0) return ok(null); // no-op retry
        await c.query(`UPDATE users SET discoverable=$2, accepts_introductions=$3 WHERE id=$1`, [userId, next.discoverable, next.accepts]);
        for (const [type, granted] of [['discoverability', next.discoverable], ['introduction_requests', next.accepts]] as const) {
          await c.query(
            `INSERT INTO consents (user_id, consent_type, granted, granted_at, revoked_at) VALUES ($1,$2,$3, CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN NULL ELSE now() END)
             ON CONFLICT (user_id, consent_type) DO UPDATE SET granted = EXCLUDED.granted,
               granted_at = CASE WHEN EXCLUDED.granted THEN now() ELSE consents.granted_at END,
               revoked_at = CASE WHEN EXCLUDED.granted THEN NULL ELSE now() END`, [userId, type, granted]);
        }
        await audit(c, { type: 'privacy_changed', actorId: userId, metadata: meta });
        return ok(null);
      });
      return res.ok ? this.get(userId) : fail(res.code);
    });
  }

  /** Self-asserted handles are ALWAYS unverified, visible only to their owner, and never used for discovery or trust. */
  async addIdentity(userId: string, input: IdentityInput): Promise<Out<ProfileView>> {
    if (!isUuid(userId)) return fail('NOT_FOUND');
    return this.guard('identity.add', async () => {
      const res = await withTx<Out<null>>(this.pool, async (c) => {
        await c.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [userId]); // serialises the per-user cap
        const n = await c.query(`SELECT count(*)::int AS n FROM external_profiles WHERE user_id=$1`, [userId]);
        const ins = await c.query(
          `INSERT INTO external_profiles (user_id, platform, username, normalized_username, verification_status) VALUES ($1,$2,$3, lower(btrim($3)), 'unverified')
           ON CONFLICT (user_id, platform, normalized_username) DO NOTHING RETURNING id`, [userId, input.platform, input.username]);
        if (ins.rows[0]) {
          if (Number(n.rows[0]!.n) >= MAX_IDENTITIES) return fail('QUOTA_EXCEEDED');
          await audit(c, { type: 'identity_added', actorId: userId, metadata: { platform: input.platform } });
        }
        return ok(null);
      });
      return res.ok ? this.get(userId) : fail(res.code);
    });
  }

  async removeIdentity(userId: string, identityId: string): Promise<Out<ProfileView>> {
    if (!isUuid(userId) || !isUuid(identityId)) return fail('NOT_FOUND');
    return this.guard('identity.remove', async () => {
      await withTx<null>(this.pool, async (c) => {
        const r = await c.query(`DELETE FROM external_profiles WHERE id=$1 AND user_id=$2 RETURNING platform`, [identityId, userId]);
        if (r.rows[0]) await audit(c, { type: 'identity_removed', actorId: userId, metadata: { platform: asStr(r.rows[0].platform) } });
        return null;
      });
      return this.get(userId); // idempotent: removing an unknown / foreign id changes nothing and reveals nothing
    });
  }
}
export { sqlState };
