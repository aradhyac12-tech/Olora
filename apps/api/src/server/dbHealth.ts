// Database readiness probe. /healthz stays DB-free (so a hiccup never makes the host restart the API);
// this tells an operator whether the API can actually use its database, and why not.
import type { PgQueryable } from '../graph/pgStore.ts';
import { classifyDbError } from '../introductions/logger.ts';
import type { DbFailure } from '../introductions/logger.ts';

export type DbProbe = { ok: true } | { ok: false; reason: DbFailure; code: string | null };
export const REQUIRED_TABLES = ['users', 'user_credentials', 'auth_sessions', 'oauth_identities', 'relationships', 'introduction_requests'] as const;

export async function probeDb(db: PgQueryable): Promise<DbProbe> {
  try {
    const { rows } = await db.query(`SELECT t, to_regclass('public.' || t) IS NOT NULL AS present FROM unnest($1::text[]) AS t`, [[...REQUIRED_TABLES]]);
    if (rows.length !== REQUIRED_TABLES.length || rows.some((r) => r.present !== true)) return { ok: false, reason: 'schema', code: null };
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return { ok: false, reason: classifyDbError(e), code: typeof code === 'string' ? code : null };
  }
}

export const DB_HINTS: Record<DbFailure, string> = {
  unreachable: 'API cannot reach the database host. On Render use the Supabase SESSION POOLER string (host *.pooler.supabase.com), not db.<ref>.supabase.co (IPv6 only).',
  timeout: 'Database connection timed out. Check host/port in DATABASE_URL, and that the Supabase project is not paused.',
  tls: 'TLS mismatch with the database. Set DATABASE_SSL=no-verify (encrypted, certificate not verified) or DATABASE_SSL=verify with NODE_EXTRA_CA_CERTS pointing at the Supabase CA.',
  auth: 'Database rejected the login. Check the password (URL-encode special characters) and, for the pooler, that the user is postgres.<project-ref>.',
  database: 'Database name not found. Supabase uses /postgres at the end of DATABASE_URL.',
  schema: 'Connected, but tables are missing. Apply database/migrations/0001..0004 then database/supabase/0005 (SQL editor).',
  other: 'Unexpected database error; see errCode in this log line.',
};
