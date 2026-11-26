// Structured logging port. Deliberately narrow: fields are primitives only, and callers pass ids/codes/counts — NEVER message text,
// emails or profile data. Errors are reduced to `errName` + SQLSTATE `errCode` (driver messages can embed row values, so they are not logged).
export type LogFields = Record<string, string | number | boolean | null>;
export interface Logger { info(event: string, fields?: LogFields): void; warn(event: string, fields?: LogFields): void; error(event: string, fields?: LogFields): void; }

export const noopLogger: Logger = { info() {}, warn() {}, error() {} };

/** One JSON object per line. `write` defaults to stdout; inject your own sink in tests or to ship elsewhere. A throwing sink never breaks a request. */
export function jsonLogger(write: (line: string) => void = (l) => process.stdout.write(l + '\n'), now: () => Date = () => new Date()): Logger {
  const emit = (level: string) => (event: string, fields: LogFields = {}) => {
    try { write(JSON.stringify({ ts: now().toISOString(), level, event, ...fields })); } catch { /* logging must never fail the caller */ }
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** Coarse, non-sensitive category of a database/connection failure. Used for logs and /readyz so an operator can tell WHY every call returns INTERNAL. */
export type DbFailure = 'unreachable' | 'timeout' | 'tls' | 'auth' | 'database' | 'schema' | 'other';
const NET_CODES = new Set(['ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ECONNRESET', 'EPIPE']);
const TLS_CODES = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID']);

/** Classifies a thrown value. The message is READ to classify but is never returned or logged (drivers can embed row values in messages). */
export function classifyDbError(e: unknown): DbFailure {
  const o = (e ?? {}) as { code?: unknown; message?: unknown; errors?: unknown };
  if (Array.isArray(o.errors)) for (const inner of o.errors) { const r = classifyDbError(inner); if (r !== 'other') return r; } // AggregateError: Node tried several addresses
  const code = typeof o.code === 'string' ? o.code : '', msg = typeof o.message === 'string' ? o.message : '';
  if (TLS_CODES.has(code) || code.startsWith('ERR_SSL') || /does not support SSL|SSL (connection )?is required|no encryption/i.test(msg)) return 'tls'; // before 'auth': pg_hba "no encryption" rejections are SQLSTATE 28000
  if (NET_CODES.has(code)) return 'unreachable';
  if (code === 'ETIMEDOUT' || /timeout exceeded when trying to connect|connection timeout/i.test(msg)) return 'timeout';
  if (code === '28P01' || code === '28000' || /tenant or user not found|password authentication failed/i.test(msg)) return 'auth';
  if (code === '3D000') return 'database';
  if (code === '42P01') return 'schema';
  return 'other';
}

/** Safe summary of an unknown thrown value: class name, error code (SQLSTATE or Node system code) and, for connection problems, a coarse reason. Never the message. */
export function errFields(e: unknown): LogFields {
  const o = (e ?? {}) as { name?: unknown; code?: unknown };
  const f: LogFields = { errName: typeof o.name === 'string' ? o.name : 'unknown', errCode: typeof o.code === 'string' ? o.code : null };
  const reason = classifyDbError(e);
  if (reason !== 'other') f.dbReason = reason;
  return f;
}
