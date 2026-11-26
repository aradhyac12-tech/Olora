// Environment -> validated config. Fails fast at startup with a message that never echoes secret values.
import { DB_SSL_MODES } from './dbConfig.ts';
import type { DbSslMode } from './dbConfig.ts';
export interface Config { databaseUrl: string; databaseSsl: DbSslMode; port: number; host: string; logLevel: string; corsOrigins: string[]; trustProxy: boolean; supabase: { url: string; anonKey: string } | null; }

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const problems: string[] = [];
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('DATABASE_URL must start with postgres:// or postgresql://');
  const port = Number(env.API_PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('API_PORT must be an integer 1-65535');
  if ((env.CORS_ORIGINS ?? '').split(',').some((x) => x.trim() === '*')) problems.push('CORS_ORIGINS must list exact origins, not *');
  const sbUrl = (env.SUPABASE_URL ?? '').trim(), sbKey = (env.SUPABASE_ANON_KEY ?? '').trim();
  if ((sbUrl || sbKey) && (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(sbUrl) || sbKey.length < 20)) problems.push('SUPABASE_URL must be https://<ref>.supabase.co and SUPABASE_ANON_KEY must be set together');
  const dbSsl = (env.DATABASE_SSL || 'auto').trim().toLowerCase();
  if (!(DB_SSL_MODES as readonly string[]).includes(dbSsl)) problems.push('DATABASE_SSL must be one of ' + DB_SSL_MODES.join(', '));
  const tp = (env.TRUST_PROXY ?? 'false').trim().toLowerCase();
  if (tp !== 'true' && tp !== 'false') problems.push('TRUST_PROXY must be true or false');
  if (problems.length) throw new Error('Invalid configuration:\n- ' + problems.join('\n- '));
  return { databaseUrl, databaseSsl: dbSsl as DbSslMode, port, host: env.API_HOST ?? '127.0.0.1', logLevel: env.LOG_LEVEL ?? 'info',
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    trustProxy: tp === 'true',
    supabase: sbUrl && sbKey ? { url: sbUrl, anonKey: sbKey } : null };
}
