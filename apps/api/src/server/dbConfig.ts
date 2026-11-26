// Pool settings for node-postgres. Pure (no I/O) so it is unit-tested.
//
// Why this exists: `pg` >= 8.16 treats `sslmode=require` in the URL as FULL certificate verification, and URL settings
// override the `ssl` option. Supabase's pooler certificate is signed by Supabase's own CA (not in Node's trust store),
// so `?sslmode=require` fails with SELF_SIGNED_CERT_IN_CHAIN; a server that enforces TLS rejects a plain connection.
// Every such failure surfaced to the app as the same opaque "Server error.". DATABASE_SSL makes the choice explicit.
export const DB_SSL_MODES = ['auto', 'disable', 'no-verify', 'verify'] as const;
export type DbSslMode = (typeof DB_SSL_MODES)[number];

/** Remove TLS-related query parameters from a connection string WITHOUT re-encoding the rest (passwords may contain escapes). */
export function stripSslParams(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const kept = url.slice(q + 1).split('&').filter((kv) => kv && !/^(sslmode|ssl|sslcert|sslkey|sslrootcert|sslnegotiation|uselibpqcompat)(=|$)/i.test(kv));
  return url.slice(0, q) + (kept.length ? '?' + kept.join('&') : '');
}

export interface PoolOptions {
  connectionString: string; max: number; connectionTimeoutMillis: number; idleTimeoutMillis: number; keepAlive: boolean;
  ssl?: false | { rejectUnauthorized: boolean };
}

/**
 * auto      : follow the URL (pg defaults; sslmode in the URL still applies).
 * disable   : no TLS.
 * no-verify : TLS, certificate NOT verified (encrypted but unauthenticated; the usual Supabase-pooler setting).
 * verify    : TLS with full verification against Node's trust store (add Supabase's CA via NODE_EXTRA_CA_CERTS).
 */
export function poolOptions(databaseUrl: string, mode: DbSslMode = 'auto'): PoolOptions {
  const base = { max: 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, keepAlive: true }; // no timeout = a dead host hangs every request forever
  if (mode === 'auto') return { connectionString: databaseUrl, ...base };
  const ssl = mode === 'disable' ? false : { rejectUnauthorized: mode === 'verify' } as const;
  return { connectionString: stripSslParams(databaseUrl), ...base, ssl };
}

/** Non-secret hints about a connection string (never returns the string, user or password). */
export function urlWarnings(databaseUrl: string): string[] {
  const out: string[] = [];
  let host = '';
  try { host = new URL(databaseUrl).hostname; } catch { return ['DATABASE_URL could not be parsed as a URL. URL-encode special characters in the password (@ : / # ? % etc.).']; }
  if (/^db\.[a-z0-9]+\.supabase\.co$/i.test(host)) out.push('DATABASE_URL uses the Supabase DIRECT host (IPv6 only). Render has no IPv6: use the Session pooler string (host *.pooler.supabase.com, user postgres.<project-ref>).');
  return out;
}
