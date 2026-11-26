// Process entrypoint: config -> pool -> service -> app -> listen, with graceful shutdown. Run: npm run start
import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';
import { IntroductionService } from '../introductions/service.ts';
import type { PgPool } from '../introductions/service.ts';
import { AuthService } from '../auth/service.ts';
import { supabaseVerifier } from '../auth/supabase.ts';
import { SearchService, pgSearchDeps } from '../search/service.ts';
import { jsonLogger } from '../introductions/logger.ts';
import { poolOptions, urlWarnings } from './dbConfig.ts';
import { InvitationService } from '../social/invitations.ts';
import { ConnectionService } from '../social/connections.ts';
import { ProfileService } from '../social/profile.ts';
import { SafetyService } from '../social/safety.ts';
import { AccountService } from '../social/account.ts';
import { probeDb, DB_HINTS } from './dbHealth.ts';

const cfg = loadConfig();
const pgName: string = 'pg';
const pg = await import(pgName);
const pool = new pg.default.Pool(poolOptions(cfg.databaseUrl, cfg.databaseSsl)) as PgPool & { end(): Promise<void>; on(ev: 'error', fn: (e: Error) => void): unknown };
const logger = jsonLogger();
// An idle pooled connection can be closed by the pooler/network at any time. node-postgres emits 'error' on the pool for that;
// with no listener Node treats it as an uncaught exception and the whole API process dies.
pool.on('error', (e) => { const c = (e as { code?: unknown } | null)?.code; logger.warn('db.pool.idle_error', { errName: e?.name ?? 'unknown', errCode: typeof c === 'string' ? c : null }); });
for (const w of urlWarnings(cfg.databaseUrl)) logger.warn('db.config.warning', { hint: w });
// Probe once at boot so a bad DATABASE_URL shows up as ONE clear log line instead of silent "Server error." on every request. Does not stop the server.
const boot = await probeDb(pool);
if (boot.ok) logger.info('db.probe.ok'); else logger.error('db.probe.failed', { reason: boot.reason, errCode: boot.code, hint: DB_HINTS[boot.reason] });
const service = new IntroductionService(pool, { logger });
const auth = new AuthService(pool, { logger, oauthVerifier: cfg.supabase ? supabaseVerifier(cfg.supabase) : undefined });
const search = new SearchService(pgSearchDeps(pool));
const connections = new ConnectionService(pool, { logger });
const social = { invitations: new InvitationService(pool, { logger }), connections, profile: new ProfileService(pool, { logger }), safety: new SafetyService(pool, { logger }), account: new AccountService(pool, { logger }), intro: service, search };
// Housekeeping: durably end pending connections past their confirmation deadline (reads also treat them as ended, so this only tidies storage).
const sweep = setInterval(() => { void connections.expireOverduePending(); }, 10 * 60_000); sweep.unref();
const app = buildApp({ service, auth, search, social, corsOrigins: cfg.corsOrigins, trustProxy: cfg.trustProxy, ready: () => probeDb(pool), logger: { level: cfg.logLevel, redact: ['req.headers.authorization'] } });

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutting down');
  try { await app.close(); await pool.end(); process.exit(0); } catch { process.exit(1); }
};
process.on('SIGINT', () => void shutdown('SIGINT')); process.on('SIGTERM', () => void shutdown('SIGTERM'));
await app.listen({ port: cfg.port, host: cfg.host });
