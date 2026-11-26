// Test-only node:http adapter that drives the SAME route table the Fastify app registers (fastify itself is not installable offline here).
// Auth is faked: `Authorization: Bearer <userId>`. Covers everything below the framework: routing, JSON, Zod, limits, services, SQL.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Route, SocialDeps } from '../../src/social/routes.ts';
import { socialRoutes } from '../../src/social/routes.ts';
import type { IntroService } from '../../src/server/app.ts';

const match = (pattern: string, path: string): Record<string, string> | null => {
  const a = pattern.split('/'), b = path.split('/'); if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) { if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!); else if (a[i] !== b[i]) return null; }
  return params;
};

export async function startHttp(deps: SocialDeps & { intro: IntroService }): Promise<{ url: string; close(): Promise<void> }> {
  const routes: Route[] = socialRoutes(deps);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const u = new URL(req.url ?? '/', 'http://x');
        const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
        const h = req.headers.authorization; const userId = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : '';
        if (!userId) return send(401, { error: { code: 'UNAUTHENTICATED' } });
        for (const r of routes) {
          if (r.method !== req.method) continue; const params = match(r.path, u.pathname); if (!params) continue;
          let body: unknown; const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim() !== '') { try { body = JSON.parse(raw); } catch { return send(400, { error: { code: 'INVALID_INPUT' } }); } }
          const query = Object.fromEntries(u.searchParams.entries());
          const ip = String(req.headers['x-test-ip'] ?? '203.0.113.7');
          const out = await r.handle({ userId, ip, params, query, body, idempotencyKey: String(req.headers['idempotency-key'] ?? '') });
          return send(out.status, out.body, out.headers);
        }
        return send(404, { error: { code: 'NOT_FOUND' } });
      })().catch(() => { res.writeHead(500); res.end('{"error":{"code":"INTERNAL"}}'); });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
