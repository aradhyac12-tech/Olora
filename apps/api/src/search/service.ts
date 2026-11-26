// Search for introduction routes to a target. Privacy rules (enforced here, tested):
//  - Only the FIRST hop of a path is revealed (a person the requester already has a confirmed relationship with). Deeper users are never named.
//  - "Target does not exist / not discoverable / blocked / is you" and "no path found" are indistinguishable: both => status 'none_found', empty routes.
//  - The target is looked up by id only. There is no directory or name search, so this cannot be used to enumerate users.
import { findIntroductionPaths } from '../graph/engine.ts';
import type { GraphStore } from '../graph/types.ts';
import { withGraphSnapshot } from '../graph/pgStore.ts';
import type { PgPoolLike, PgQueryable } from '../graph/pgStore.ts';

export interface SearchRoute {
  connector: { id: string; displayName: string };
  /** Shortest path length found through this connector (edges). */
  hops: number;
  /** True only for hops === 2: the introduction service accepts requester -> connector -> target. Longer paths are informational. */
  canRequest: boolean;
}
export type SearchOutcome =
  | { ok: true; value: { status: 'found'; routes: SearchRoute[]; complete: boolean; shortestWithinScope: boolean; scope: 'contributed_graph' } | { status: 'none_found'; routes: [] } }
  | { ok: false; code: 'INVALID_INPUT' | 'INTERNAL' };

export interface SearchDeps {
  /** Run `fn` against ONE consistent snapshot of the graph (PostgreSQL: withGraphSnapshot). */
  snapshot<T>(fn: (store: GraphStore) => Promise<T>): Promise<T>;
  /** Display names for user ids (missing ids simply absent). */
  names(ids: string[]): Promise<Map<string, string>>;
  now?: () => Date;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HOPS = 3, MAX_PATHS = 50, MAX_ROUTES = 10;

export class SearchService {
  private readonly d: SearchDeps;
  constructor(d: SearchDeps) { this.d = d; }

  async search(actorId: string, targetId: string): Promise<SearchOutcome> {
    if (!UUID.test(actorId ?? '') || typeof targetId !== 'string' || !UUID.test(targetId)) return { ok: false, code: 'INVALID_INPUT' };
    try {
      const res = await this.d.snapshot((store) => findIntroductionPaths(store, actorId, targetId, { maxHops: MAX_HOPS, maxPaths: MAX_PATHS, now: (this.d.now ?? (() => new Date()))() }));
      // best (fewest hops) path per first-hop connector; engine order is already best-first, so the first seen wins
      const best = new Map<string, number>();
      for (const p of res.paths) { const c = p.userIds[1]; if (c !== undefined && !best.has(c)) best.set(c, p.hops); }
      if (best.size === 0) return { ok: true, value: { status: 'none_found', routes: [] } };
      const ids = [...best.keys()].slice(0, MAX_ROUTES);
      const names = await this.d.names(ids);
      const routes: SearchRoute[] = ids.map((id) => ({ connector: { id, displayName: names.get(id) ?? '' }, hops: best.get(id)!, canRequest: best.get(id) === 2 }));
      return { ok: true, value: { status: 'found', routes, complete: res.complete, shortestWithinScope: res.shortestWithinScope, scope: res.scope } };
    } catch {
      // A missing/inactive SOURCE (the caller) is a server-side fault; store failures too. Both generic, nothing leaked.
      return { ok: false, code: 'INTERNAL' };
    }
  }
}

/** PostgreSQL wiring: snapshot reads via withGraphSnapshot, names from `users`. */
export function pgSearchDeps(pool: PgPoolLike & PgQueryable): SearchDeps {
  return {
    snapshot: (fn) => withGraphSnapshot(pool, fn),
    names: async (ids) => {
      const { rows } = await pool.query(`SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [ids]);
      return new Map(rows.map((r) => [String(r.id), String(r.display_name)]));
    },
  };
}
