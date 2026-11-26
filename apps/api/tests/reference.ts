// Independent reference implementation: brute-force DFS over ALL simple paths, written without
// importing any engine/eligibility code (only types), to cross-check the production engine.
import type { GraphEdge, GraphUser } from '../src/graph/types.ts';

const STRENGTH: Record<string, number> = { verified_identity_link: 4, shared_community: 3, user_asserted: 2, imported_record: 1 };
const CONFIRMED = ['acquaintance', 'colleague', 'classmate', 'family', 'community_member'];

export interface RefBlock { a: string; b: string } // direction irrelevant: either direction blocks
export interface RefPath { userIds: string[]; edgeIds: string[] }

function eligible(e: GraphEdge, now: number, imported: boolean): boolean {
  if (e.sourceUserId === e.targetUserId) return false;
  if (e.revokedAt) return false;
  if (e.expiresAt && e.expiresAt.getTime() <= now) return false;
  if (e.permissionStatus !== 'granted' || e.verificationStatus !== 'confirmed' || !e.confirmedAt) return false;
  if (e.type === 'imported') return imported;
  if (!CONFIRMED.includes(e.type)) return false;
  const ok = (uid: string) => e.confirmations.some((c) => c.userId === uid && c.status === 'confirmed' && !c.revokedAt && c.confirmedAt);
  return ok(e.sourceUserId) && ok(e.targetUserId);
}
const strength = (e: GraphEdge) => e.evidence.reduce((m, x) => Math.max(m, STRENGTH[x.type] ?? 0), 0);
const lastEv = (e: GraphEdge) => e.evidence.reduce((m, x) => Math.max(m, x.createdAt.getTime()), -Infinity);
const conf = (e: GraphEdge) => (e.confirmedAt ? e.confirmedAt.getTime() : -Infinity);

function cmpKey(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function referenceSearch(
  users: GraphUser[], edges: GraphEdge[], blocks: RefBlock[], src: string, tgt: string,
  o: { maxHops: number; maxPaths: number; includeImported: boolean; now: Date },
): { total: number; top: RefPath[] } | 'unavailable' | 'source_unavailable' {
  const U = new Map(users.map((u) => [u.id, u]));
  const s = U.get(src);
  if (!s || s.status !== 'active') return 'source_unavailable';
  const t = U.get(tgt);
  const blocked = (x: string, y: string) => blocks.some((b) => (b.a === x && b.b === y) || (b.a === y && b.b === x));
  if (src === tgt || !t || t.status !== 'active' || !t.discoverable || blocked(src, tgt)) return 'unavailable';
  const now = o.now.getTime();
  const live = edges.filter((e) => eligible(e, now, o.includeImported));

  const bestEdge = (from: string, to: string): GraphEdge | null => {
    const c = live.filter((e) => (e.sourceUserId === from && e.targetUserId === to) || (e.direction === 'mutual' && e.sourceUserId === to && e.targetUserId === from));
    c.sort((p, q) => cmpKey([-strength(p), -lastEv(p), -conf(p), p.id], [-strength(q), -lastEv(q), -conf(q), q.id]));
    return c[0] ?? null;
  };

  const all: Array<{ p: RefPath; key: (number | string)[] }> = [];
  const walk = (path: string[], edgeList: GraphEdge[]) => {
    const last = path[path.length - 1]!;
    if (last === tgt) {
      const stale = Math.max(...edgeList.map((e) => (lastEv(e) === -Infinity ? Infinity : now - lastEv(e))));
      const key = [edgeList.length, -Math.min(...edgeList.map(strength)), stale, -Math.min(...edgeList.map(conf)), ...edgeList.map((e) => e.id), ...path];
      all.push({ p: { userIds: [...path], edgeIds: edgeList.map((e) => e.id) }, key });
      return;
    }
    if (edgeList.length >= o.maxHops) return;
    for (const n of U.keys()) {
      if (path.includes(n)) continue;
      const nu = U.get(n)!;
      if (n !== tgt && !(nu.status === 'active' && nu.acceptsIntroductions)) continue;
      if (path.some((x) => blocked(x, n))) continue;
      const e = bestEdge(last, n);
      if (!e) continue;
      walk([...path, n], [...edgeList, e]);
    }
  };
  walk([src], []);
  all.sort((a, b) => cmpKey(a.key, b.key));
  return { total: all.length, top: all.slice(0, o.maxPaths).map((x) => x.p) };
}
