import type {
  AccountStatus, Confirmation, ConfirmationStatus, Direction, EdgePage, EdgeQueryOptions, Evidence, EvidenceType,
  GraphEdge, GraphStore, GraphUser, PermissionStatus, RelationshipType, UserId, VerificationStatus,
} from './types.ts';
import { CONFIRMED_RELATIONSHIP_TYPES } from './types.ts';

/** Minimal surface of pg.Pool / pg.Client so the store has no hard dependency on `pg`. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const EDGES_SQL = `
SELECT r.id, r.source_user_id, r.target_user_id, r.relationship_type, r.direction, r.verification_status,
       r.permission_status, r.created_at, r.updated_at, r.confirmed_at, r.expires_at, r.revoked_at
FROM relationships r
WHERE (r.source_user_id = $1 OR (r.target_user_id = $1 AND r.direction = 'mutual'))
  AND r.source_user_id <> r.target_user_id
  AND r.revoked_at IS NULL
  AND (r.expires_at IS NULL OR r.expires_at > $2)
  AND r.permission_status = 'granted'
  AND r.verification_status = 'confirmed'
  AND r.confirmed_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_user_id = r.source_user_id AND b.blocked_user_id = r.target_user_id) OR (b.blocker_user_id = r.target_user_id AND b.blocked_user_id = r.source_user_id)) -- defense in depth: a block in either direction
  AND (
    (r.relationship_type = ANY($3::text[]) AND (
       SELECT count(DISTINCT c.confirming_user_id) FROM relationship_confirmations c
       WHERE c.relationship_id = r.id AND c.confirmation_status = 'confirmed'
         AND c.revoked_at IS NULL AND c.confirmed_at IS NOT NULL
         AND c.confirming_user_id IN (r.source_user_id, r.target_user_id)) = 2)
    OR ($4::boolean AND r.relationship_type = 'imported')
  )
ORDER BY r.id ASC
LIMIT $5`;

const str = (v: unknown) => String(v);
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(str(v)));

export class PgGraphStore implements GraphStore {
  private readonly db: PgQueryable;
  constructor(db: PgQueryable) { this.db = db; }

  async getUsers(ids: UserId[]): Promise<Map<UserId, GraphUser>> {
    const out = new Map<UserId, GraphUser>();
    if (ids.length === 0) return out;
    const { rows } = await this.db.query(
      `SELECT id, account_status, discoverable, accepts_introductions FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    for (const r of rows) {
      out.set(str(r.id), {
        id: str(r.id), status: str(r.account_status) as AccountStatus,
        discoverable: r.discoverable === true, acceptsIntroductions: r.accepts_introductions === true,
      });
    }
    return out;
  }

  async getEdgesFrom(userId: UserId, o: EdgeQueryOptions): Promise<EdgePage> {
    const { rows } = await this.db.query(EDGES_SQL, [
      userId, o.now.toISOString(), [...CONFIRMED_RELATIONSHIP_TYPES], o.includeImported, o.limit + 1,
    ]);
    const truncated = rows.length > o.limit;
    const kept = rows.slice(0, o.limit);
    if (kept.length === 0) return { edges: [], truncated };
    const ids = kept.map((r) => str(r.id));
    const [conf, evid] = await Promise.all([
      this.db.query(
        `SELECT relationship_id, confirming_user_id, confirmation_status, confirmed_at, revoked_at
         FROM relationship_confirmations WHERE relationship_id = ANY($1::uuid[])`, [ids]),
      this.db.query(
        `SELECT relationship_id, evidence_type, created_at FROM relationship_evidence WHERE relationship_id = ANY($1::uuid[])`, [ids]),
    ]);
    const confBy = new Map<string, Confirmation[]>();
    for (const c of conf.rows) {
      const k = str(c.relationship_id);
      (confBy.get(k) ?? confBy.set(k, []).get(k)!).push({
        userId: str(c.confirming_user_id), status: str(c.confirmation_status) as ConfirmationStatus,
        confirmedAt: date(c.confirmed_at), revokedAt: date(c.revoked_at),
      });
    }
    const evBy = new Map<string, Evidence[]>();
    for (const e of evid.rows) {
      const k = str(e.relationship_id);
      (evBy.get(k) ?? evBy.set(k, []).get(k)!).push({ type: str(e.evidence_type) as EvidenceType, createdAt: date(e.created_at)! });
    }
    const edges: GraphEdge[] = kept.map((r) => ({
      id: str(r.id), sourceUserId: str(r.source_user_id), targetUserId: str(r.target_user_id),
      type: str(r.relationship_type) as RelationshipType, direction: str(r.direction) as Direction,
      verificationStatus: str(r.verification_status) as VerificationStatus,
      permissionStatus: str(r.permission_status) as PermissionStatus,
      createdAt: date(r.created_at)!, updatedAt: date(r.updated_at)!, confirmedAt: date(r.confirmed_at),
      expiresAt: date(r.expires_at), revokedAt: date(r.revoked_at),
      confirmations: confBy.get(str(r.id)) ?? [], evidence: evBy.get(str(r.id)) ?? [],
    }));
    return { edges, truncated };
  }

  async getBlockedCounterparties(userId: UserId): Promise<Set<UserId>> {
    const { rows } = await this.db.query(
      `SELECT blocked_user_id AS other FROM blocks WHERE blocker_user_id = $1
       UNION SELECT blocker_user_id AS other FROM blocks WHERE blocked_user_id = $1`, [userId]);
    return new Set(rows.map((r) => str(r.other)));
  }
}

/** Pool/client surface needed for snapshot reads (matches pg.Pool / pg.PoolClient). */
export interface PgPoolLike { connect(): Promise<PgQueryable & { release(err?: unknown): void }>; }

/**
 * Run `fn` with a PgGraphStore bound to ONE REPEATABLE READ, READ ONLY transaction, so edges, confirmations and
 * evidence for a search all come from the same snapshot (no torn reads under concurrent writes).
 * The transaction is always ended and the client released, including on error.
 */
export async function withGraphSnapshot<T>(pool: PgPoolLike, fn: (store: PgGraphStore) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failed: unknown;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return await fn(new PgGraphStore(client));
  } catch (e) {
    failed = e;
    throw e;
  } finally {
    try { await client.query(failed ? 'ROLLBACK' : 'COMMIT'); } catch (e) { failed = failed ?? e; }
    client.release(failed);
  }
}
