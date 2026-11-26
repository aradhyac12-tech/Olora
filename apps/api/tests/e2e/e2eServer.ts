// TEST-ONLY harness for browser e2e. Runs the REAL Fastify app (`buildApp`: real AuthService with scrypt + hashed sessions, real services, real
// PostgreSQL) on port+1, and a static file server for `web/` on `port` that reverse-proxies /v1 to it (one origin, as the page CSP `connect-src 'self' https:` requires for plain-http test origins).
// Only difference from production: the per-IP auth rate limit is raised (every e2e user registers from 127.0.0.1). Never deploy.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { buildApp } from '../../src/server/app.ts';
import { AuthService } from '../../src/auth/service.ts';
import { InvitationService } from '../../src/social/invitations.ts';
import { ConnectionService } from '../../src/social/connections.ts';
import { ProfileService } from '../../src/social/profile.ts';
import { SafetyService } from '../../src/social/safety.ts';
import { AccountService } from '../../src/social/account.ts';
import { IntroductionService } from '../../src/introductions/service.ts';
import { SearchService, pgSearchDeps } from '../../src/search/service.ts';

const webDir = process.argv[2]!, port = Number(process.argv[3] ?? 4173), apiPort = port + 1;
const pgName: string = 'pg'; const pg = await import(pgName);
const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const service = new IntroductionService(pool);
const search = new SearchService(pgSearchDeps(pool));
const social = { invitations: new InvitationService(pool), connections: new ConnectionService(pool), profile: new ProfileService(pool), safety: new SafetyService(pool), account: new AccountService(pool), intro: service, search };
const app = buildApp({ service, auth: new AuthService(pool), search, social, corsOrigins: [`http://127.0.0.1:${port}`], authRateLimit: { max: 1000, timeWindow: 60_000 } });
await app.listen({ port: apiPort, host: '127.0.0.1' });

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }
  if (u.pathname.startsWith('/v1/')) {
    const up = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up); return;
  }
  const p = u.pathname === '/' ? '/index.html' : normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''); const f = join(webDir, p);
  if (!f.startsWith(webDir) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream', 'referrer-policy': 'no-referrer' }); res.end(readFileSync(f));
}).listen(port, '127.0.0.1', () => console.log('e2e server ready'));
