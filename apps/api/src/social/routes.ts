// Relationship API as a framework-agnostic route table: each handler gets an already-authenticated request and returns {status, body}.
// server/app.ts registers it on Fastify; tests can drive the very same handlers through any HTTP adapter.
// Order of defence for every handler: authenticated user (done by the caller) -> rate limit -> Zod parse -> service (ownership + transactions).
import type { z } from 'zod';
import {
  BlockBody, ByLinkSearchBody, ConnectionsQuery, CreateInvitationBody, DeleteAccountBody, IdentityBody, IdParams, IntroCreateBody, PermissionBody,
  PrivacyBody, ProfilePatchBody, ReportBody, TokenBody, idemKeySchema,
} from '../contracts/index.ts';
import type { InvitationService } from './invitations.ts';
import type { ConnectionService } from './connections.ts';
import type { ProfileService } from './profile.ts';
import type { SafetyService } from './safety.ts';
import type { AccountService } from './account.ts';
import { DEFAULT_LIMITS, RateLimiter, type Limits } from './rateLimit.ts';
import { STATUS, type ApiCode } from '../server/status.ts';
import type { IntroService, SearchPort } from '../server/app.ts';
import type { Out } from './db.ts';

export interface RouteRequest { userId: string; ip: string; params: Record<string, string>; query: Record<string, string>; body: unknown; idempotencyKey: string }
export interface RouteResponse { status: number; body?: unknown; headers?: Record<string, string> }
export interface Route { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; handle(r: RouteRequest): Promise<RouteResponse> }

export interface SocialDeps {
  invitations: InvitationService; connections: ConnectionService; profile: ProfileService; safety: SafetyService; account: AccountService;
  intro?: IntroService; search?: SearchPort; limiter?: RateLimiter; limits?: Partial<Limits>;
}

const MIN = 60_000, QUARTER = 15 * MIN, HOUR = 60 * MIN;
const NO_STORE = { 'Cache-Control': 'no-store' };
const errBody = (code: ApiCode, extra: Record<string, unknown> = {}) => ({ error: { code, ...extra } });
const fail = (code: ApiCode, extra?: Record<string, unknown>, headers?: Record<string, string>): RouteResponse => ({ status: STATUS[code], body: errBody(code, extra), headers });

/** Parse with Zod. Only field NAMES are echoed on failure, never the submitted values (they may be tokens or personal data). */
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): { ok: true; data: z.infer<S> } | { ok: false; res: RouteResponse } {
  const r = schema.safeParse(value ?? {});
  if (r.success) return { ok: true, data: r.data };
  const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))].slice(0, 8);
  return { ok: false, res: fail('INVALID_INPUT', { fields }) };
}
const fromOut = <T>(o: Out<T>, okStatus: number, wrap: (v: T) => unknown, headers: Record<string, string> = NO_STORE): RouteResponse =>
  o.ok ? { status: okStatus, body: wrap(o.value), headers } : fail(o.code);

export function socialRoutes(d: SocialDeps & { intro: IntroService }): Route[] {
  const lim: Limits = { ...DEFAULT_LIMITS, ...d.limits };
  const rl = d.limiter ?? new RateLimiter();
  const limited = (retryAfterMs: number): RouteResponse => fail('RATE_LIMITED', undefined, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
  const hit = (key: string, max: number, windowMs: number): RouteResponse | null => { const r = rl.hit(key, max, windowMs); return r.ok ? null : limited(r.retryAfterMs); };

  const mutate = (r: RouteRequest) => hit(`mut:${r.userId}`, lim.mutateUser, MIN);
  const safety = (r: RouteRequest) => hit(`safe:${r.userId}`, lim.safetyUser, MIN) ?? hit(`safeip:${r.ip}`, lim.tokenIp, MIN);
  /** Token-bearing calls: per user + per IP, plus a lockout once a caller (user OR ip) piles up failed lookups (token guessing). */
  const tokenGate = (r: RouteRequest): RouteResponse | null => {
    if (rl.blocked(`tfu:${r.userId}`, lim.tokenFailUser) || rl.blocked(`tfi:${r.ip}`, lim.tokenFailIp)) return limited(QUARTER);
    return hit(`tok:${r.userId}`, lim.tokenUser, MIN) ?? hit(`tokip:${r.ip}`, lim.tokenIp, MIN);
  };
  const tokenFailed = (r: RouteRequest) => { rl.hit(`tfu:${r.userId}`, lim.tokenFailUser, QUARTER); rl.hit(`tfi:${r.ip}`, lim.tokenFailIp, QUARTER); };
  const idem = (r: RouteRequest): { ok: true; key: string } | { ok: false; res: RouteResponse } =>
    idemKeySchema.safeParse(r.idempotencyKey).success ? { ok: true, key: r.idempotencyKey } : { ok: false, res: fail('INVALID_INPUT', { fields: ['Idempotency-Key'] }) };
  const withId = <T>(r: RouteRequest, fn: (id: string) => Promise<Out<T>>, wrap: (v: T) => unknown) => {
    const p = parse(IdParams, r.params); if (!p.ok) return Promise.resolve(fail('NOT_FOUND')); // a malformed id is just "not found"
    return fn(p.data.id).then((o) => fromOut(o, 200, wrap));
  };
  /** Token routes: record a failed lookup against the caller so guessing is throttled. */
  const tokenResult = <T>(r: RouteRequest, o: Out<T>, okStatus: number, wrap: (v: T) => unknown): RouteResponse => {
    if (!o.ok && (o.code === 'INVITATION_UNAVAILABLE' || o.code === 'NOT_FOUND')) tokenFailed(r);
    return fromOut(o, okStatus, wrap);
  };

  const routes: Route[] = [
    // ---------------------------------------------------------------- invitations
    { method: 'POST', path: '/v1/invitations', async handle(r) {
      const g = hit(`inv:${r.userId}`, lim.createInvite, HOUR) ?? mutate(r); if (g) return g;
      const k = idem(r); if (!k.ok) return k.res;
      const p = parse(CreateInvitationBody, r.body); if (!p.ok) return p.res;
      const o = await d.invitations.create(r.userId, p.data, k.key);
      return o.ok ? { status: o.value.replayed ? 200 : 201, body: o.value, headers: { ...NO_STORE, 'Idempotent-Replayed': String(o.value.replayed) } } : fail(o.code);
    } },
    { method: 'GET', path: '/v1/invitations/sent', async handle(r) { return fromOut(await d.invitations.listSent(r.userId), 200, (invitations) => ({ invitations })); } },
    { method: 'POST', path: '/v1/invitations/:id/revoke', async handle(r) { const g = mutate(r); if (g) return g; return withId(r, (id) => d.invitations.revoke(r.userId, id), (invitation) => ({ invitation })); } },
    { method: 'POST', path: '/v1/invitations/preview', async handle(r) {
      const g = tokenGate(r); if (g) return g; const p = parse(TokenBody, r.body); if (!p.ok) return p.res;
      return tokenResult(r, await d.invitations.preview(r.userId, p.data.token), 200, (invitation) => ({ invitation }));
    } },
    { method: 'POST', path: '/v1/invitations/accept', async handle(r) {
      const g = tokenGate(r) ?? mutate(r); if (g) return g; const p = parse(TokenBody, r.body); if (!p.ok) return p.res;
      const o = await d.invitations.accept(r.userId, p.data.token);
      return tokenResult(r, o, o.ok && !o.value.replayed ? 201 : 200, (v) => v);
    } },
    { method: 'POST', path: '/v1/invitations/decline', async handle(r) {
      const g = tokenGate(r) ?? mutate(r); if (g) return g; const p = parse(TokenBody, r.body); if (!p.ok) return p.res;
      return tokenResult(r, await d.invitations.decline(r.userId, p.data.token), 200, (v) => v);
    } },

    // ---------------------------------------------------------------- connections
    { method: 'GET', path: '/v1/connections', async handle(r) {
      const p = parse(ConnectionsQuery, r.query); if (!p.ok) return p.res;
      return fromOut(await d.connections.list(r.userId, p.data.status), 200, (connections) => ({ connections }));
    } },
    { method: 'GET', path: '/v1/connections/:id', async handle(r) { return withId(r, (id) => d.connections.get(r.userId, id), (connection) => ({ connection })); } },
    { method: 'POST', path: '/v1/connections/:id/confirm', async handle(r) { const g = mutate(r); if (g) return g; return withId(r, (id) => d.connections.confirm(r.userId, id), (connection) => ({ connection })); } },
    { method: 'POST', path: '/v1/connections/:id/decline', async handle(r) { const g = mutate(r); if (g) return g; return withId(r, (id) => d.connections.decline(r.userId, id), (connection) => ({ connection })); } },
    { method: 'POST', path: '/v1/connections/:id/revoke', async handle(r) { const g = mutate(r); if (g) return g; return withId(r, (id) => d.connections.revoke(r.userId, id), (connection) => ({ connection })); } },
    { method: 'PUT', path: '/v1/connections/:id/permission', async handle(r) {
      const g = mutate(r); if (g) return g; const b = parse(PermissionBody, r.body); if (!b.ok) return b.res;
      return withId(r, (id) => d.connections.setPermission(r.userId, id, b.data.allowIntroductions), (connection) => ({ connection }));
    } },

    // ---------------------------------------------------------------- blocks & reports
    { method: 'GET', path: '/v1/blocks', async handle(r) { return fromOut(await d.safety.list(r.userId), 200, (blocks) => ({ blocks })); } },
    { method: 'POST', path: '/v1/blocks', async handle(r) {
      const g = safety(r); if (g) return g; const p = parse(BlockBody, r.body); if (!p.ok) return p.res;
      return fromOut(await d.safety.block(r.userId, p.data.subject), 201, (block) => ({ block }));
    } },
    { method: 'DELETE', path: '/v1/blocks/:id', async handle(r) {
      const g = safety(r); if (g) return g;
      const p = parse(IdParams, r.params); if (!p.ok) return { status: 200, body: { removed: false }, headers: NO_STORE }; // unknown id: same silent no-op
      return fromOut(await d.safety.unblock(r.userId, p.data.id), 200, (v) => v);
    } },
    { method: 'POST', path: '/v1/reports', async handle(r) {
      const g = safety(r); if (g) return g; const k = idem(r); if (!k.ok) return k.res;
      const p = parse(ReportBody, r.body); if (!p.ok) return p.res;
      if ('invitationToken' in p.data.subject) { const t = tokenGate(r); if (t) return t; }
      const o = await d.safety.report(r.userId, p.data, k.key);
      if (!o.ok && o.code === 'NOT_FOUND') tokenFailed(r);
      return fromOut(o, 201, (report) => ({ report }));
    } },

    // ---------------------------------------------------------------- profile, privacy, identities, account
    { method: 'GET', path: '/v1/profile', async handle(r) { return fromOut(await d.profile.get(r.userId), 200, (profile) => ({ profile })); } },
    { method: 'PATCH', path: '/v1/profile', async handle(r) {
      const g = mutate(r); if (g) return g; const p = parse(ProfilePatchBody, r.body); if (!p.ok) return p.res;
      return fromOut(await d.profile.update(r.userId, p.data), 200, (profile) => ({ profile }));
    } },
    { method: 'PUT', path: '/v1/privacy', async handle(r) {
      const g = mutate(r); if (g) return g; const p = parse(PrivacyBody, r.body); if (!p.ok) return p.res;
      return fromOut(await d.profile.setPrivacy(r.userId, p.data), 200, (profile) => ({ profile }));
    } },
    { method: 'POST', path: '/v1/identities', async handle(r) {
      const g = safety(r); if (g) return g; const p = parse(IdentityBody, r.body); if (!p.ok) return p.res;
      return fromOut(await d.profile.addIdentity(r.userId, p.data), 201, (profile) => ({ profile }));
    } },
    { method: 'DELETE', path: '/v1/identities/:id', async handle(r) {
      const g = safety(r); if (g) return g; const p = parse(IdParams, r.params); if (!p.ok) return fail('NOT_FOUND');
      return fromOut(await d.profile.removeIdentity(r.userId, p.data.id), 200, (profile) => ({ profile }));
    } },
    { method: 'GET', path: '/v1/account/export', async handle(r) {
      const g = hit(`export:${r.userId}`, 5, HOUR); if (g) return g;
      return fromOut(await d.account.export(r.userId), 200, (v) => v, { ...NO_STORE, 'Content-Disposition': 'attachment; filename="olora-export.json"' });
    } },
    { method: 'POST', path: '/v1/account/delete', async handle(r) {
      if (rl.blocked(`pwf:${r.userId}`, 5)) return limited(QUARTER);
      const g = hit(`del:${r.userId}`, 10, HOUR); if (g) return g; const p = parse(DeleteAccountBody, r.body); if (!p.ok) return p.res;
      const o = await d.account.deleteAccount(r.userId, p.data.password);
      if (!o.ok && o.code === 'INVALID_CREDENTIALS') {
        rl.hit(`pwf:${r.userId}`, 5, QUARTER);
        // 403, not 401: the session is fine, only the re-entered password is wrong. The web client signs out on 401.
        return { status: 403, body: errBody('INVALID_CREDENTIALS'), headers: NO_STORE };
      }
      return fromOut(o, 200, (v) => v);
    } },
  ];

  if (d.search) {
    const search = d.search;
    routes.push({ method: 'POST', path: '/v1/search/by-link', async handle(r) {
      const g = tokenGate(r); if (g) return g; const p = parse(ByLinkSearchBody, r.body); if (!p.ok) return p.res;
      const t = await d.invitations.resolveTarget(r.userId, p.data.token);
      if (!t.ok) return tokenResult(r, t, 200, () => null);
      const res = await search.search(r.userId, t.value.targetId);
      return res.ok ? { status: 200, body: { target: t.value.target, ...res.value }, headers: NO_STORE } : fail(res.code);
    } });
  }

  // Introduction creation lives here (not in app.ts) so it can accept a target LINK as well as an id.
  routes.push({ method: 'POST', path: '/v1/introductions', async handle(r) {
    const g = mutate(r); if (g) return g;
    const p = parse(IntroCreateBody, r.body); if (!p.ok) return p.res;
    let targetId = p.data.targetId;
    if (p.data.targetToken !== undefined) {
      const t = tokenGate(r); if (t) return t;
      const res = await d.invitations.resolveTarget(r.userId, p.data.targetToken);
      if (!res.ok) { tokenFailed(r); return fail('NOT_ELIGIBLE'); } // a dead/blocked link looks exactly like "no eligible path"
      targetId = res.value.targetId;
    }
    const o = await d.intro.create(r.userId, { connectorId: p.data.connectorId, targetId: targetId!, message: p.data.message }, r.idempotencyKey);
    return o.ok ? { status: o.replayed ? 200 : 201, body: { introduction: o.value }, headers: { ...NO_STORE, 'Idempotent-Replayed': String(o.replayed) } } : fail(o.code);
  } });

  return routes;
}
