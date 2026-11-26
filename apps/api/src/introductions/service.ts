// Transactional introduction service on PostgreSQL. Every state change = one transaction:
//   row lock (FOR UPDATE) -> pure decision -> UPDATE + audit + outbox, all-or-nothing.
import { createHash } from 'node:crypto';
import { findIntroductionPaths } from '../graph/engine.ts';
import { PgGraphStore } from '../graph/pgStore.ts';
import { withTx } from '../social/db.ts';
import { lockIntroductionPath } from '../social/locks.ts';
import type { PgQueryable, PgPoolLike } from '../graph/pgStore.ts';
import { canSee, decide, isOpen } from './stateMachine.ts';
import type { IntroAction, IntroParties, IntroStatus, Notice } from './stateMachine.ts';
import { errFields, noopLogger } from './logger.ts';
import type { Logger } from './logger.ts';

export type ErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE' | 'EXPIRED' | 'INVALID_INPUT' | 'NOT_ELIGIBLE'
  | 'DUPLICATE_OPEN' | 'TOO_MANY_OPEN' | 'IDEMPOTENCY_CONFLICT' | 'INTERNAL';
export type Result<T> = { ok: true; value: T; replayed: boolean } | { ok: false; code: ErrorCode };

export interface IntroRecord {
  id: string; requesterId: string; connectorId: string; targetId: string; status: IntroStatus;
  message: string; version: number; createdAt: Date; expiresAt: Date; decidedAt: Date | null;
}
/** A request as shown in a list: the record plus display names of the three parties (only for requests the actor may see). */
export interface IntroListItem extends IntroRecord { requesterName: string; connectorName: string; targetName: string }
export type PgPool = PgPoolLike & PgQueryable;
export interface ServiceOptions {
  ttlMs?: number; maxOpenPerRequester?: number; now?: () => Date; logger?: Logger;
  /** Re-verify the requester->connector->target path when the connector or target ACCEPTS (default true). */
  recheckOnAccept?: boolean;
  /** TEST SEAM ONLY: awaited right after the path locks are taken, so concurrency tests can hold a transaction open at the critical point. */
  afterPathLocked?: (stage: 'create' | 'accept') => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const COLS = `id, requester_id, connector_id, target_id, status, message, version, created_at, expires_at, connector_accepted_at, decided_at`;
const ACTIONS: readonly IntroAction[] = ['connector_accept', 'connector_decline', 'target_accept', 'target_decline', 'requester_cancel'];

type Row = Record<string, unknown>;
const s = (v: unknown) => String(v);
const d = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(s(v)));
const parties = (r: Row): IntroParties => ({
  requesterId: s(r.requester_id), connectorId: s(r.connector_id), targetId: s(r.target_id),
  status: s(r.status) as IntroStatus, expiresAt: d(r.expires_at)!, connectorAcceptedAt: d(r.connector_accepted_at),
});
const record = (r: Row): IntroRecord => ({
  id: s(r.id), requesterId: s(r.requester_id), connectorId: s(r.connector_id), targetId: s(r.target_id),
  status: s(r.status) as IntroStatus, message: s(r.message), version: Number(r.version),
  createdAt: d(r.created_at)!, expiresAt: d(r.expires_at)!, decidedAt: d(r.decided_at),
});
const fail = <T>(code: ErrorCode): Result<T> => ({ ok: false, code });

export class IntroductionService {
  private readonly pool: PgPool;
  private readonly ttlMs: number;
  private readonly maxOpen: number;
  private readonly clock: () => Date;
  private readonly log: Logger;
  private readonly recheck: boolean;
  private readonly afterPathLocked?: (stage: 'create' | 'accept') => Promise<void>;
  constructor(pool: PgPool, o: ServiceOptions = {}) {
    this.pool = pool; this.ttlMs = o.ttlMs ?? 7 * 86_400_000; this.maxOpen = o.maxOpenPerRequester ?? 20; this.clock = o.now ?? (() => new Date());
    this.log = o.logger ?? noopLogger; this.recheck = o.recheckOnAccept ?? true; this.afterPathLocked = o.afterPathLocked;
  }

  /** One transaction with lock_timeout and retry on deadlock/serialization failure (the body is re-runnable). */
  private tx<T>(fn: (c: PgQueryable) => Promise<T>): Promise<T> { return withTx(this.pool, fn); }

  async create(requesterId: string, input: { connectorId: string; targetId: string; message: string }, idempotencyKey: string): Promise<Result<IntroRecord>> {
    const { connectorId, targetId } = input;
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (![requesterId, connectorId, targetId].every((x) => typeof x === 'string' && UUID.test(x)) || !KEY.test(idempotencyKey ?? '')
        || message.length < 1 || message.length > 1000 || new Set([requesterId, connectorId, targetId]).size !== 3) return fail('INVALID_INPUT');
    const hash = createHash('sha256').update(JSON.stringify([connectorId, targetId, message])).digest('hex');
    try {
      const early = await this.replay(this.pool, requesterId, idempotencyKey, hash);
      if (early) return early;
      return await this.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`intro-create:${requesterId}`]); // serialises this requester's creates
        const again = await this.replay(c, requesterId, idempotencyKey, hash);
        if (again) return again;
        // Eligibility is decided INSIDE the transaction, after the path's pair/user/relationship locks are held: a concurrent revoke, block or
        // consent change either committed before we got the locks (and we see it) or waits until we commit. Nothing is delivered on a stale path.
        await lockIntroductionPath(c, requesterId, connectorId, targetId);
        if (this.afterPathLocked) await this.afterPathLocked('create');
        if (!(await this.eligibleOn(c, requesterId, connectorId, targetId, this.clock()))) { this.log.info('intro.create.rejected', { code: 'NOT_ELIGIBLE', requesterId }); return fail<IntroRecord>('NOT_ELIGIBLE'); }
        const open = await c.query(`SELECT count(*)::int AS n FROM introduction_requests WHERE requester_id=$1 AND status IN ('pending_connector','pending_target')`, [requesterId]);
        if (Number(open.rows[0]!.n) >= this.maxOpen) { this.log.warn('intro.create.rejected', { code: 'TOO_MANY_OPEN', requesterId }); return fail<IntroRecord>('TOO_MANY_OPEN'); }
        const dup = await c.query(`SELECT 1 FROM introduction_requests WHERE requester_id=$1 AND connector_id=$2 AND target_id=$3 AND status IN ('pending_connector','pending_target')`, [requesterId, connectorId, targetId]);
        if (dup.rows.length > 0) return fail<IntroRecord>('DUPLICATE_OPEN');
        // created_at / expires_at come from the DATABASE clock: an app-side timestamp could precede the transaction's now() and violate updated_at >= created_at.
        const ins = await c.query(`INSERT INTO introduction_requests (requester_id, connector_id, target_id, message, expires_at)
          VALUES ($1,$2,$3,$4, now() + ($5::double precision * interval '1 millisecond')) RETURNING ${COLS}`, [requesterId, connectorId, targetId, message, this.ttlMs]);
        const row = ins.rows[0]!;
        await c.query(`INSERT INTO introduction_idempotency (user_id, idempotency_key, request_hash, request_id) VALUES ($1,$2,$3,$4)`, [requesterId, idempotencyKey, hash, row.id]);
        await c.query(`INSERT INTO audit_events (request_id, actor_id, action, from_status, to_status, idempotency_key) VALUES ($1,$2,'create',NULL,'pending_connector',$3)`, [row.id, requesterId, idempotencyKey]);
        await this.notify(c, s(row.id), [{ recipientId: connectorId, event: 'introduction_requested' }]);
        this.log.info('intro.created', { requestId: s(row.id), requesterId });
        return { ok: true as const, value: record(row), replayed: false };
      });
    } catch (e) { this.log.error('intro.create.failed', { requesterId, ...errFields(e) }); return fail('INTERNAL'); }
  }

  private async replay(c: PgQueryable, userId: string, key: string, hash: string): Promise<Result<IntroRecord> | null> {
    const { rows } = await c.query(`SELECT i.request_hash, ${COLS.split(', ').map((x) => `r.${x}`).join(', ')}
      FROM introduction_idempotency i JOIN introduction_requests r ON r.id = i.request_id WHERE i.user_id=$1 AND i.idempotency_key=$2`, [userId, key]);
    if (rows.length === 0) return null;
    return s(rows[0]!.request_hash) === hash ? { ok: true, value: record(rows[0]!), replayed: true } : fail('IDEMPOTENCY_CONFLICT');
  }

  /** Requester -> connector -> target must be an eligible 2-hop path, evaluated on the caller's transaction (locks must already be held). Store errors propagate (they abort the tx and surface as INTERNAL) rather than being read as 'no path'. */
  private async eligibleOn(c: PgQueryable, requesterId: string, connectorId: string, targetId: string, now: Date): Promise<boolean> {
    const res = await findIntroductionPaths(new PgGraphStore(c), requesterId, targetId, { maxHops: 2, maxPaths: 50, now });
    return res.paths.some((p) => p.userIds.length === 3 && p.userIds[1] === connectorId);
  }

  async transition(actorId: string, requestId: string, action: IntroAction, idempotencyKey: string): Promise<Result<IntroRecord>> {
    if (!UUID.test(requestId ?? '') || !UUID.test(actorId ?? '')) return fail('NOT_FOUND');
    if (!ACTIONS.includes(action) || !KEY.test(idempotencyKey ?? '')) return fail('INVALID_INPUT');
    try {
      return await this.tx(async (c) => {
        const { rows } = await c.query(`SELECT ${COLS} FROM introduction_requests WHERE id=$1 FOR UPDATE`, [requestId]);
        if (rows.length === 0) return fail<IntroRecord>('NOT_FOUND');
        const row = rows[0]!; const p = parties(row);
        if (!canSee(p, actorId)) return fail<IntroRecord>('NOT_FOUND');
        const prior = await c.query(`SELECT action FROM audit_events WHERE request_id=$1 AND actor_id=$2 AND idempotency_key=$3`, [requestId, actorId, idempotencyKey]);
        if (prior.rows.length > 0) return s(prior.rows[0]!.action) === action ? { ok: true as const, value: record(row), replayed: true } : fail<IntroRecord>('IDEMPOTENCY_CONFLICT');
        const now = this.clock();
        const dec = decide(p, action, actorId, now);
        if (!dec.ok) {
          if (dec.code === 'EXPIRED') await this.apply(c, row, 'expire', null, null, 'expired', now, [{ recipientId: p.requesterId, event: 'introduction_expired' }]); // persist the lazy expiry, then report
          return fail<IntroRecord>(dec.code);
        }
        // Accepting extends trust, so the graph must still justify it NOW. Runs on THIS connection (we already hold the row lock) —
        // taking a second pooled connection here could deadlock a small pool. Declines/cancels never need the graph. No state change on failure.
        const accepting = action === 'connector_accept' || action === 'target_accept';
        if (this.recheck && accepting) { await lockIntroductionPath(c, p.requesterId, p.connectorId, p.targetId); if (this.afterPathLocked) await this.afterPathLocked('accept'); }
        if (this.recheck && accepting
            && !(await this.eligibleOn(c, p.requesterId, p.connectorId, p.targetId, now))) {
          this.log.warn('intro.accept.rejected', { code: 'NOT_ELIGIBLE', requestId, actorId, action });
          return fail<IntroRecord>('NOT_ELIGIBLE');
        }
        const out = await this.apply(c, row, action, actorId, idempotencyKey, dec.to, now, dec.notices);
        this.log.info('intro.transitioned', { requestId, actorId, action, to: dec.to });
        return { ok: true as const, value: out, replayed: false };
      });
    } catch (e) { this.log.error('intro.transition.failed', { requestId, actorId, action, ...errFields(e) }); return fail('INTERNAL'); }
  }

  private async apply(c: PgQueryable, row: Row, action: IntroAction, actorId: string | null, key: string | null, to: IntroStatus, now: Date, notices: Notice[]): Promise<IntroRecord> {
    const terminal = !isOpen(to);
    const upd = await c.query(`UPDATE introduction_requests SET status=$2, decided_at=$3, connector_accepted_at = CASE WHEN $2 = 'pending_target' THEN $4::timestamptz ELSE connector_accepted_at END
      WHERE id=$1 RETURNING ${COLS}`, [row.id, to, terminal ? now : null, now]);
    await c.query(`INSERT INTO audit_events (request_id, actor_id, action, from_status, to_status, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)`, [row.id, actorId, action, row.status, to, key]);
    await this.notify(c, s(row.id), notices);
    return record(upd.rows[0]!);
  }

  private async notify(c: PgQueryable, requestId: string, notices: Notice[]): Promise<void> {
    for (const n of notices) { // payload carries ids only — never message text or profile data
      await c.query(`INSERT INTO notification_outbox (event_type, recipient_user_id, request_id, payload) VALUES ($1,$2,$3,$4::jsonb)
        ON CONFLICT ON CONSTRAINT outbox_once DO NOTHING`, [n.event, n.recipientId, requestId, JSON.stringify({ requestId })]);
    }
  }

  /** Expire due requests. Safe to run from several workers at once (SKIP LOCKED). Returns how many THIS call expired. */
  async expireDue(limit = 100): Promise<number> {
    try {
      return await this.tx(async (c) => {
        const now = this.clock();
        const { rows } = await c.query(`SELECT ${COLS} FROM introduction_requests WHERE status IN ('pending_connector','pending_target') AND expires_at <= $1
          ORDER BY expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit]);
        for (const row of rows) await this.apply(c, row, 'expire', null, null, 'expired', now, [{ recipientId: s(row.requester_id), event: 'introduction_expired' }]);
        if (rows.length > 0) this.log.info('intro.expired', { count: rows.length });
        return rows.length;
      });
    } catch (e) { this.log.error('intro.expireDue.failed', errFields(e)); return 0; }
  }

  /**
   * Retention: delete TERMINAL requests decided more than `olderThanMs` ago, together with their audit/idempotency/outbox rows (FK cascade).
   * Requests that still have an undelivered notification are kept. Minimum 24h so client retries with an old idempotency key cannot re-create
   * a request that was just purged. Safe to run concurrently (SKIP LOCKED). Returns how many requests THIS call deleted.
   */
  async purgeClosed(olderThanMs: number, limit = 500): Promise<number> {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 86_400_000 || !Number.isInteger(limit) || limit < 1 || limit > 10_000) return 0;
    try {
      return await this.tx(async (c) => {
        const del = await c.query(`DELETE FROM introduction_requests WHERE id IN (
            SELECT r.id FROM introduction_requests r
            WHERE r.status IN ('accepted','declined','cancelled','expired') AND r.decided_at <= $1::timestamptz - ($2::double precision * interval '1 millisecond')
              AND NOT EXISTS (SELECT 1 FROM notification_outbox o WHERE o.request_id = r.id AND o.processed_at IS NULL)
            ORDER BY r.decided_at, r.id LIMIT $3 FOR UPDATE OF r SKIP LOCKED) RETURNING id`, [this.clock(), olderThanMs, limit]);
        if (del.rows.length > 0) this.log.info('intro.purged', { count: del.rows.length });
        return del.rows.length;
      });
    } catch (e) { this.log.error('intro.purge.failed', errFields(e)); return 0; }
  }

  async get(actorId: string, requestId: string): Promise<Result<IntroRecord>> {
    if (!UUID.test(requestId ?? '') || !UUID.test(actorId ?? '')) return fail('NOT_FOUND');
    try {
      const { rows } = await this.pool.query(`SELECT ${COLS} FROM introduction_requests WHERE id=$1`, [requestId]);
      if (rows.length === 0 || !canSee(parties(rows[0]!), actorId)) return fail('NOT_FOUND');
      return { ok: true, value: record(rows[0]!), replayed: false };
    } catch { return fail('INTERNAL'); }
  }

  /**
   * Requests the actor may see, newest first. Same visibility rule as `canSee`: requester and connector always; the target only after the
   * connector accepted. Display names are joined from `users` (names of parties on a request the actor is already allowed to see).
   */
  async list(actorId: string, limit = 50): Promise<Result<IntroListItem[]>> {
    if (!UUID.test(actorId ?? '') || !Number.isInteger(limit) || limit < 1 || limit > 100) return fail('INVALID_INPUT');
    try {
      const { rows } = await this.pool.query(`SELECT ${COLS.split(', ').map((x) => `r.${x}`).join(', ')},
          rq.display_name AS requester_name, cn.display_name AS connector_name, tg.display_name AS target_name
        FROM introduction_requests r
        JOIN users rq ON rq.id = r.requester_id JOIN users cn ON cn.id = r.connector_id JOIN users tg ON tg.id = r.target_id
        WHERE r.requester_id = $1 OR r.connector_id = $1 OR (r.target_id = $1 AND r.connector_accepted_at IS NOT NULL)
        ORDER BY r.created_at DESC, r.id DESC LIMIT $2`, [actorId, limit]);
      return { ok: true, replayed: false, value: rows.map((r) => ({ ...record(r), requesterName: s(r.requester_name), connectorName: s(r.connector_name), targetName: s(r.target_name) })) };
    } catch (e) { this.log.error('intro.list.failed', { actorId, ...errFields(e) }); return fail('INTERNAL'); }
  }
}
