// Accounts and sessions on PostgreSQL. Tokens are random 256-bit values shown to the client ONCE; only their SHA-256 is stored.
import { createHash, randomBytes } from 'node:crypto';
import type { PgPoolLike, PgQueryable } from '../graph/pgStore.ts';
import { classifyDbError, errFields, noopLogger } from '../introductions/logger.ts';
import type { Logger } from '../introductions/logger.ts';
import { hashPassword, verifyPassword } from './password.ts';

export type AuthErrorCode = 'INVALID_INPUT' | 'EMAIL_TAKEN' | 'INVALID_CREDENTIALS' | 'OAUTH_DISABLED' | 'INTERNAL';
export type AuthResult<T> = { ok: true; value: T } | { ok: false; code: AuthErrorCode; detail?: string };
export interface Session { token: string; userId: string; expiresAt: Date; }
/** Verified external identity. Must only come from asking the identity provider itself (never from decoding a token locally). */
export interface ExternalIdentity { subject: string; email: string; emailVerified: boolean; displayName: string; viaGoogle: boolean; }
export type IdentityVerifier = (accessToken: string) => Promise<ExternalIdentity | null>;
export interface AuthOptions { sessionTtlMs?: number; now?: () => Date; logger?: Logger; /** Supabase identity check; when absent OAuth login is disabled. */ oauthVerifier?: IdentityVerifier; }
export type AuthPool = PgPoolLike & PgQueryable;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const fail = <T>(code: AuthErrorCode): AuthResult<T> => ({ ok: false, code });
/** INTERNAL with a coarse, non-sensitive `stage:reason` (never a message, host, user or row value) so a client diagnostic can tell WHICH hop failed. */
function internal<T>(stage: 'register' | 'login' | 'verify' | 'db', e: unknown): AuthResult<T> {
  const o = (e ?? {}) as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  let reason: string = classifyDbError(e);
  if (stage === 'verify') {
    const msg = typeof o.message === 'string' ? o.message : '';
    const m = /^supabase_http_(\d{3})$/.exec(msg);
    reason = m ? `supabase_http_${m[1]}` : o.name === 'TimeoutError' || o.name === 'AbortError' ? 'supabase_timeout' : o.name === 'TypeError' ? 'supabase_unreachable' : 'other';
  } else if (reason === 'other' && typeof o.code === 'string' && /^[0-9A-Z]{5}$/.test(o.code)) reason = `sqlstate_${o.code}`;
  return { ok: false, code: 'INTERNAL', detail: `${stage}:${reason}` };
}
export const normalizeEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '');

export class AuthService {
  private readonly pool: AuthPool; private readonly ttl: number; private readonly clock: () => Date; private readonly log: Logger; private readonly oauth: IdentityVerifier | null;
  private dummy: Promise<string> | null = null; // verified against when the email is unknown, so unknown-user and wrong-password take the same time
  constructor(pool: AuthPool, o: AuthOptions = {}) { this.pool = pool; this.ttl = o.sessionTtlMs ?? 30 * 86_400_000; this.clock = o.now ?? (() => new Date()); this.log = o.logger ?? noopLogger; this.oauth = o.oauthVerifier ?? null; }

  async register(input: { email: string; password: string; displayName: string }): Promise<AuthResult<{ userId: string }>> {
    const email = normalizeEmail(input.email); const name = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    const pw = input.password;
    if (email.length > 254 || !EMAIL.test(email) || typeof pw !== 'string' || pw.length < 10 || pw.length > 128 || name.length < 1 || name.length > 100) return fail('INVALID_INPUT');
    try {
      const hash = await hashPassword(pw); // CPU work happens BEFORE taking a connection
      const c = await this.pool.connect(); let err: unknown;
      try {
        await c.query('BEGIN');
        const u = await c.query(`INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id`, [email, name]);
        const id = String(u.rows[0]!.id);
        await c.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)`, [id, hash]);
        await c.query('COMMIT');
        this.log.info('auth.registered', { userId: id });
        return { ok: true, value: { userId: id } };
      } catch (e) { err = e; try { await c.query('ROLLBACK'); } catch { /* discarded below */ } throw e; } finally { c.release(err); }
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return fail('EMAIL_TAKEN');
      this.log.error('auth.register.failed', errFields(e)); return internal('register', e);
    }
  }

  async login(emailIn: string, password: string): Promise<AuthResult<Session>> {
    const email = normalizeEmail(emailIn);
    if (!email || email.length > 254 || typeof password !== 'string' || password.length < 1 || password.length > 128) return fail('INVALID_CREDENTIALS');
    try {
      const { rows } = await this.pool.query(`SELECT u.id, u.account_status, c.password_hash FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.email = $1`, [email]);
      const row = rows[0];
      this.dummy ??= hashPassword('dummy-password-for-timing');
      const good = await verifyPassword(password, row ? String(row.password_hash) : await this.dummy);
      if (!row || !good || String(row.account_status) !== 'active') { this.log.info('auth.login.rejected', {}); return fail('INVALID_CREDENTIALS'); }
      const token = randomBytes(32).toString('base64url'); const now = this.clock(); const expiresAt = new Date(now.getTime() + this.ttl);
      await this.pool.query(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1,$2,now() + ($3::double precision * interval '1 millisecond'))`, [String(row.id), sha(token), this.ttl]);
      this.log.info('auth.login', { userId: String(row.id) });
      return { ok: true, value: { token, userId: String(row.id), expiresAt } };
    } catch (e) { this.log.error('auth.login.failed', errFields(e)); return internal('login', e); }
  }

  private async issue(userId: string): Promise<Session> {
    const token = randomBytes(32).toString('base64url'); const expiresAt = new Date(this.clock().getTime() + this.ttl);
    await this.pool.query(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1,$2,now() + ($3::double precision * interval '1 millisecond'))`, [userId, sha(token), this.ttl]);
    return { token, userId, expiresAt };
  }

  /**
   * Sign in with a Supabase (Google) access token. Rules:
   * - the token is verified by Supabase itself; the identity must be Google-backed with a verified email;
   * - a known (provider, subject) signs in to the linked user;
   * - an unknown identity creates a NEW user only if no local account uses that email. We never auto-link to an existing
   *   email/password account (it may have been pre-registered by someone else, since this app has no email verification): EMAIL_TAKEN.
   */
  async loginWithOAuth(accessToken: string): Promise<AuthResult<Session>> {
    if (!this.oauth) return fail('OAUTH_DISABLED');
    if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8192) return fail('INVALID_CREDENTIALS');
    let id: ExternalIdentity | null;
    try { id = await this.oauth(accessToken); } catch (e) { this.log.error('auth.oauth.verify_failed', errFields(e)); return internal('verify', e); }
    const email = id ? normalizeEmail(id.email) : '';
    if (!id || !id.viaGoogle || !id.emailVerified || !id.subject || id.subject.length > 128 || !EMAIL.test(email) || email.length > 254) { this.log.info('auth.oauth.rejected', {}); return fail('INVALID_CREDENTIALS'); }
    const name = (id.displayName ?? '').trim().slice(0, 100) || email.split('@')[0]!.slice(0, 100);
    try {
      const c = await this.pool.connect(); let err: unknown;
      try {
        await c.query('BEGIN');
        const known = await c.query(`SELECT u.id, u.account_status FROM oauth_identities o JOIN users u ON u.id = o.user_id WHERE o.provider = 'supabase' AND o.subject = $1`, [id.subject]);
        let userId: string;
        if (known.rows[0]) {
          if (String(known.rows[0].account_status) !== 'active') { await c.query('ROLLBACK'); this.log.info('auth.oauth.rejected', {}); return fail('INVALID_CREDENTIALS'); }
          userId = String(known.rows[0].id);
        } else {
          const u = await c.query(`INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id`, [email, name]); // 23505 when the email is already used
          userId = String(u.rows[0]!.id);
          await c.query(`INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('supabase', $1, $2)`, [id.subject, userId]);
        }
        await c.query('COMMIT');
        const session = await this.issue(userId);
        this.log.info('auth.oauth.login', { userId });
        return { ok: true, value: session };
      } catch (e) { err = e; try { await c.query('ROLLBACK'); } catch { /* discarded below */ } throw e; } finally { c.release(err); }
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return fail('EMAIL_TAKEN');
      this.log.error('auth.oauth.failed', errFields(e)); return internal('db', e);
    }
  }

  /** user id for a live session of an ACTIVE account, else null. Never throws (errors read as 'not authenticated'). */
  async authenticate(token: string): Promise<string | null> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    try {
      const { rows } = await this.pool.query(`SELECT s.user_id FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz AND u.account_status = 'active'`, [sha(token), this.clock()]);
      return rows[0] ? String(rows[0].user_id) : null;
    } catch (e) { this.log.error('auth.authenticate.failed', errFields(e)); return null; }
  }

  async logout(token: string): Promise<void> {
    try { await this.pool.query(`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha(token)]); }
    catch (e) { this.log.error('auth.logout.failed', errFields(e)); }
  }
  async logoutAll(userId: string): Promise<number> {
    try { return (await this.pool.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [userId])).rows.length; }
    catch (e) { this.log.error('auth.logoutAll.failed', errFields(e)); return 0; }
  }
}
