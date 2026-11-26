// Shared database plumbing for the relationship/social services: transaction helper with retry, result types, audit helper.
import type { PgPoolLike, PgQueryable } from '../graph/pgStore.ts';

export type SocialPool = PgPoolLike & PgQueryable;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * Error codes of the relationship API. Deliberately coarse:
 *  - INVITATION_UNAVAILABLE covers unknown / expired / revoked / used-up / own / blocked links, so none of those states can be probed.
 *  - NOT_FOUND covers "does not exist" AND "you are not a participant".
 */
export type SocialCode =
  | 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE' | 'EXPIRED' | 'INVITATION_UNAVAILABLE' | 'ALREADY_CONNECTED'
  | 'PROFILE_PRIVATE' | 'QUOTA_EXCEEDED' | 'IDEMPOTENCY_CONFLICT' | 'RATE_LIMITED' | 'FORBIDDEN' | 'INVALID_CREDENTIALS' | 'INTERNAL';
export type Out<T> = { ok: true; value: T } | { ok: false; code: SocialCode };
export const ok = <T>(value: T): Out<T> => ({ ok: true, value });
export const fail = <T = never>(code: SocialCode): Out<T> => ({ ok: false, code });

/** Thrown inside a transaction body to roll everything back and return `result` to the caller (a logical, non-exceptional failure). */
export class TxAbort<T> extends Error {
  readonly result: T;
  constructor(result: T) { super('tx_abort'); this.name = 'TxAbort'; this.result = result; }
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sqlState = (e: unknown): string => { const c = (e as { code?: unknown } | null)?.code; return typeof c === 'string' ? c : ''; };

export interface TxOptions { retries?: number; lockTimeoutMs?: number }

/**
 * Run `fn` in ONE transaction (READ COMMITTED; correctness comes from explicit locks, see locks.ts).
 *  - SET LOCAL lock_timeout: a stuck lock becomes an error, never an indefinitely hung request.
 *  - Deadlocks (40P01) and serialization failures (40001) are retried with back-off; `fn` must therefore be safe to re-run.
 *  - TxAbort rolls back and returns its result. Any other error rolls back and is re-thrown.
 *  - A connection is only discarded when ROLLBACK itself fails (the connection is then in an unknown state).
 */
export async function withTx<T>(pool: PgPoolLike, fn: (c: PgQueryable) => Promise<T>, o: TxOptions = {}): Promise<T> {
  const retries = o.retries ?? 3;
  const lockMs = Math.max(100, Math.min(60_000, Math.trunc(o.lockTimeoutMs ?? 8000)));
  for (let attempt = 0; ; attempt++) {
    const c = await pool.connect();
    let broken: unknown;
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = ${lockMs}`); // integer literal built from a clamped number, never from input
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (re) { broken = re; }
      if (e instanceof TxAbort) return e.result as T;
      if (!RETRYABLE.has(sqlState(e)) || attempt >= retries) throw e;
    } finally {
      c.release(broken);
    }
    await sleep(15 * 2 ** attempt + Math.floor(Math.random() * 15));
  }
}

export interface AuditInput {
  type: string; actorId: string | null; subjectUserId?: string | null; relationshipId?: string | null; invitationId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}
/** Append one row to relationship_audit_events inside the caller's transaction. Metadata: ids/codes only. */
export async function audit(c: PgQueryable, a: AuditInput): Promise<void> {
  await c.query(
    `INSERT INTO relationship_audit_events (event_type, actor_id, subject_user_id, relationship_id, invitation_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [a.type, a.actorId, a.subjectUserId ?? null, a.relationshipId ?? null, a.invitationId ?? null, JSON.stringify(a.metadata ?? {})]);
}

export const asStr = (v: unknown): string => String(v);
export const asDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
export const TRUSTED_TYPES = ['acquaintance', 'colleague', 'classmate', 'family', 'community_member'] as const;
