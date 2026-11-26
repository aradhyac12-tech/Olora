// Fastify app factory. No globals, no listening: tests call `app.inject()`, main.ts calls `listen()`.
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { AuthErrorCode, AuthResult, Session } from '../auth/service.ts';
import type { ErrorCode, IntroListItem, IntroRecord, Result } from '../introductions/service.ts';
import type { SearchOutcome } from '../search/service.ts';
import type { IntroAction } from '../introductions/stateMachine.ts';
import type { DbProbe } from './dbHealth.ts';
import { STATUS } from './status.ts';
import type { ApiCode } from './status.ts';
import { socialRoutes } from '../social/routes.ts';
import type { SocialDeps } from '../social/routes.ts';

/** What the HTTP layer needs from the introduction service (so tests can pass a fake). */
export interface IntroService {
  create(requesterId: string, input: { connectorId: string; targetId: string; message: string }, idempotencyKey: string): Promise<Result<IntroRecord>>;
  transition(actorId: string, requestId: string, action: IntroAction, idempotencyKey: string): Promise<Result<IntroRecord>>;
  get(actorId: string, requestId: string): Promise<Result<IntroRecord>>;
  list(actorId: string, limit?: number): Promise<Result<IntroListItem[]>>;
}
/** Route search for the HTTP layer (so tests can pass a fake). */
export interface SearchPort { search(actorId: string, targetId: string): Promise<SearchOutcome> }
/** What the HTTP layer needs from the auth service (so tests can pass a fake). */
export interface AuthPort {
  register(input: { email: string; password: string; displayName: string }): Promise<AuthResult<{ userId: string }>>;
  login(email: string, password: string): Promise<AuthResult<Session>>;
  loginWithOAuth(accessToken: string): Promise<AuthResult<Session>>;
  authenticate(token: string): Promise<string | null>;
  logout(token: string): Promise<void>;
  logoutAll(userId: string): Promise<number>;
}
export interface AppOptions {
  service: IntroService; auth: AuthPort; search?: SearchPort;
  /** Relationship API (invitations, connections, blocks, profile, privacy). Absent = those routes are not registered. */
  social?: SocialDeps; logger?: FastifyServerOptions['logger'];
  /** Per-IP limit on register/login (default 10 per minute). Behind a proxy, configure Fastify `trustProxy` first or every client shares one bucket. */
  /** Per-IP limit on GET /v1/search (default 30 per minute). */
  searchRateLimit?: { max: number; timeWindow: number | string };
  authRateLimit?: { max: number; timeWindow: number | string };
  /** Exact origins allowed to call the API from a browser/Capacitor client. Empty/undefined = no CORS headers at all. Never '*'. */
  corsOrigins?: string[];
  /** Set true ONLY behind a trusted reverse proxy (Render, etc.) so rate limits see the real client IP (X-Forwarded-For). Never true when directly exposed: clients could spoof their IP. */
  trustProxy?: boolean;
  /** Database readiness check behind GET /readyz. Absent = the route is not registered. */
  ready?: () => Promise<DbProbe>;
}

const ACTIONS = ['connector_accept', 'connector_decline', 'target_accept', 'target_decline', 'requester_cancel'] as const;
const err = (code: ApiCode, detail?: string) => ({ error: detail ? { code, detail } : { code } });
declare module 'fastify' { interface FastifyRequest { userId: string | null; token: string | null } }
const PUBLIC = new Set(['/v1/auth/register', '/v1/auth/login', '/v1/auth/oauth/supabase']);

export function buildApp(o: AppOptions): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false, trustProxy: o.trustProxy ?? false, bodyLimit: 8 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const limit = o.authRateLimit ?? { max: 10, timeWindow: '1 minute' };
  const searchLimit = o.searchRateLimit ?? { max: 30, timeWindow: '1 minute' };
  void app.register(rateLimit, { global: false, errorResponseBuilder: () => ({ statusCode: 429, rateLimited: true }) });

  // Tolerate an empty body under application/json (action endpoints like POST .../confirm carry none); malformed JSON is still a 400.
  try { app.removeContentTypeParser('application/json'); } catch { /* default parser already absent */ }
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try { done(null, JSON.parse(text)); } catch { const e = new Error('bad json') as Error & { statusCode: number }; e.statusCode = 400; done(e, undefined); }
  });
  app.decorateRequest('userId', null); app.decorateRequest('token', null);
  // Defence-in-depth headers on every response: authenticated JSON and invitation tokens must never be cached or sniffed.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/v1/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });
  // CORS: exact-match allow-list, bearer tokens only (no cookies, so no credentials mode). Runs before auth so preflights need no token.
  const origins = new Set(o.corsOrigins ?? []);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !origins.has(origin)) return;
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      return reply.code(204).header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        .header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key')
        .header('Access-Control-Expose-Headers', 'Idempotent-Replayed').header('Access-Control-Max-Age', '600').send();
    }
  });
  // Everything under /v1 needs a live session, except register/login. /healthz stays open.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/v1/') || PUBLIC.has(path)) return;
    const h = req.headers.authorization;
    const token = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : '';
    const uid = token ? await o.auth.authenticate(token) : null;
    if (uid === null) return reply.code(401).send(err('UNAUTHENTICATED'));
    req.userId = uid; req.token = token;
  });

  // Uniform, non-leaking errors: validation => 400, unknown route => 404, anything else => 500 with no internals.
  app.setErrorHandler((e, req, reply) => {
    if ((e as { rateLimited?: boolean }).rateLimited) return reply.code(429).send(err('RATE_LIMITED'));
    const validation = (e as { validation?: unknown }).validation !== undefined;
    const status = (e as { statusCode?: number }).statusCode;
    if (validation || (status !== undefined && status >= 400 && status < 500)) return reply.code(validation ? 400 : status!).send(err('INVALID_INPUT'));
    req.log.error({ errName: (e as Error).name }, 'unhandled');
    return reply.code(500).send(err('INTERNAL'));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(err('NOT_FOUND')));

  const idemKey = (req: FastifyRequest): string => (typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : '');
  const send = (reply: import('fastify').FastifyReply, r: Result<IntroRecord>, okStatus = 200) =>
    r.ok ? reply.code(r.replayed ? 200 : okStatus).header('Idempotent-Replayed', String(r.replayed)).send({ introduction: r.value })
         : reply.code(STATUS[r.code]).send(err(r.code));

  // Routes live in a child plugin so they are defined AFTER @fastify/rate-limit has loaded (its per-route config is read by an onRoute hook).
  app.register(async (r) => {
    r.get('/healthz', async () => ({ status: 'ok' })); // liveness only: deliberately never touches the database
    if (o.ready) {
      const ready = o.ready;
      // Readiness: can the API actually use its database? Public, rate-limited, and answers with a coarse reason only (no host, user, message or table names).
      r.get('/readyz', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
        const p = await ready().catch((): DbProbe => ({ ok: false, reason: 'other', code: null }));
        return p.ok ? reply.header('Cache-Control', 'no-store').send({ status: 'ok' }) : reply.code(503).header('Cache-Control', 'no-store').send({ status: 'unavailable', reason: p.reason });
      });
    }

    const strict = (props: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
    r.post('/v1/auth/register', { config: { rateLimit: limit },
      schema: { body: strict({ email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 128 }, displayName: { type: 'string', maxLength: 100 } }) } },
    async (req, reply) => {
      const r = await o.auth.register(req.body as { email: string; password: string; displayName: string });
      return r.ok ? reply.code(201).send({ userId: r.value.userId }) : reply.code(STATUS[r.code]).send(err(r.code, r.detail));
    });
    r.post('/v1/auth/login', { config: { rateLimit: limit },
      schema: { body: strict({ email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 128 } }) } },
    async (req, reply) => {
      const b = req.body as { email: string; password: string };
      const r = await o.auth.login(b.email, b.password);
      return r.ok ? reply.header('Cache-Control', 'no-store').send({ token: r.value.token, userId: r.value.userId, expiresAt: r.value.expiresAt }) : reply.code(STATUS[r.code]).send(err(r.code, r.detail));
    });
    r.post('/v1/auth/oauth/supabase', { config: { rateLimit: limit }, schema: { body: strict({ accessToken: { type: 'string', maxLength: 4096 } }) } },
    async (req, reply) => {
      const r = await o.auth.loginWithOAuth((req.body as { accessToken: string }).accessToken);
      return r.ok ? reply.header('Cache-Control', 'no-store').send({ token: r.value.token, userId: r.value.userId, expiresAt: r.value.expiresAt }) : reply.code(STATUS[r.code]).send(err(r.code, r.detail));
    });
    r.post('/v1/auth/logout', async (req, reply) => { await o.auth.logout(req.token!); return reply.code(204).send(); });
    r.post('/v1/auth/logout-all', async (req) => ({ revoked: await o.auth.logoutAll(req.userId!) }));
    r.get('/v1/me', async (req) => ({ userId: req.userId }));

    if (!o.social) r.post('/v1/introductions', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['connectorId', 'targetId', 'message'],
        properties: { connectorId: { type: 'string', maxLength: 64 }, targetId: { type: 'string', maxLength: 64 }, message: { type: 'string', maxLength: 1000 } } } },
    }, async (req, reply) => send(reply, await o.service.create(req.userId!, req.body as { connectorId: string; targetId: string; message: string }, idemKey(req)), 201));

    r.post('/v1/introductions/:id/transitions', {
      schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } } },
        body: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: [...ACTIONS] } } } },
    }, async (req, reply) => send(reply, await o.service.transition(req.userId!, (req.params as { id: string }).id, (req.body as { action: IntroAction }).action, idemKey(req))));

    r.get('/v1/introductions', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^[0-9]{1,3}$' } } } } }, // string: this app disables type coercion

      async (req, reply) => {
        const lim = (req.query as { limit?: string }).limit;
        const res = await o.service.list(req.userId!, lim === undefined ? undefined : Number(lim)); // service rejects 0 and >100 as INVALID_INPUT
        return res.ok ? reply.header('Cache-Control', 'no-store').send({ introductions: res.value }) : reply.code(STATUS[res.code]).send(err(res.code));
      });

    if (o.social) {
      const social = o.social;
      for (const route of socialRoutes({ ...social, intro: social.intro ?? o.service, search: social.search ?? o.search })) {
        r.route({ method: route.method, url: route.path, handler: async (req, reply) => {
          const q: Record<string, string> = {};
          for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) if (typeof v === 'string') q[k] = v;
          const out = await route.handle({ userId: req.userId!, ip: req.ip, params: (req.params ?? {}) as Record<string, string>, query: q, body: req.body, idempotencyKey: idemKey(req) });
          for (const [k, v] of Object.entries(out.headers ?? {})) reply.header(k, v);
          return reply.code(out.status).send(out.body === undefined ? undefined : out.body);
        } });
      }
    }

    if (o.search) {
      const search = o.search;
      // Lookup by id only (no directory/name search). Empty results never say WHY (missing, hidden, blocked, or simply no path).
      r.get('/v1/search', { config: { rateLimit: searchLimit },
        schema: { querystring: { type: 'object', additionalProperties: false, required: ['targetId'], properties: { targetId: { type: 'string', maxLength: 64 } } } } },
      async (req, reply) => {
        const res = await search.search(req.userId!, (req.query as { targetId: string }).targetId);
        return res.ok ? reply.header('Cache-Control', 'no-store').send(res.value) : reply.code(STATUS[res.code]).send(err(res.code));
      });
    }

    r.get('/v1/introductions/:id', { schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } } } } },
      async (req, reply) => send(reply, await o.service.get(req.userId!, (req.params as { id: string }).id)));
  });

  return app;
}
