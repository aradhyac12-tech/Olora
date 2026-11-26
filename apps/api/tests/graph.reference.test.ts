import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findIntroductionPaths } from '../src/graph/engine.ts';
import { InMemoryGraphStore } from '../src/graph/memoryStore.ts';
import { GraphEngineError } from '../src/graph/types.ts';
import type { GraphEdge, GraphUser, EvidenceType, RelationshipType } from '../src/graph/types.ts';
import { NOW, ago, ahead, mulberry32, shuffled } from './helpers.ts';
import { referenceSearch } from './reference.ts';

const EVID: EvidenceType[] = ['verified_identity_link', 'shared_community', 'user_asserted', 'imported_record'];

function randomGraph(seed: number) {
  const rnd = mulberry32(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  const d = 0.02 + rnd() * 0.25; // per-seed defect rate: low d => dense, mostly-eligible graphs
  const n = 3 + Math.floor(rnd() * 6);
  const ids = Array.from({ length: n }, (_, i) => `u${i}`);
  const users: GraphUser[] = ids.map((id) => ({
    id, status: rnd() < d / 3 ? pick(['suspended', 'deactivated', 'deleted'] as const) : 'active',
    discoverable: rnd() >= d / 2, acceptsIntroductions: rnd() >= d,
  }));
  const edges: GraphEdge[] = [];
  const m = 4 + Math.floor(rnd() * 30);
  for (let i = 0; i < m; i++) {
    const a = rnd() < 0.02 ? 'ghost' : pick(ids), b = pick(ids);
    const conf = (u: string) => ({
      userId: u, status: rnd() < d ? pick(['pending', 'revoked'] as const) : ('confirmed' as const),
      confirmedAt: rnd() < d ? null : ago(Math.floor(rnd() * 400)), revokedAt: rnd() < d / 2 ? ago(1) : null,
    });
    const confs = [conf(a), conf(b)];
    if (rnd() < d) confs.splice(Math.floor(rnd() * 2), 1);
    if (rnd() < d) confs.push(conf(pick(ids)));
    edges.push({
      id: `e${String(i).padStart(3, '0')}`, sourceUserId: a, targetUserId: b,
      type: rnd() < d ? pick<RelationshipType>(['one_sided', 'social_follow', 'imported']) : pick<RelationshipType>(['acquaintance', 'acquaintance', 'colleague', 'family', 'classmate', 'community_member']),
      direction: rnd() < 0.8 ? 'mutual' : 'directed',
      verificationStatus: rnd() < d ? 'unverified' : 'confirmed',
      permissionStatus: rnd() < d ? pick(['pending', 'denied'] as const) : 'granted',
      createdAt: ago(500), updatedAt: ago(1), confirmedAt: rnd() < d / 2 ? null : ago(Math.floor(rnd() * 400)),
      expiresAt: rnd() < 0.2 ? (rnd() < d * 2 ? ago(5) : ahead(30)) : null, revokedAt: rnd() < d / 2 ? ago(2) : null,
      confirmations: confs,
      evidence: Array.from({ length: Math.floor(rnd() * 3) }, () => ({ type: pick(EVID), createdAt: ago(Math.floor(rnd() * 800)) })),
    });
  }
  const blocks = Array.from({ length: Math.floor(rnd() * 3 * d * 4) }, () => ({ blockerUserId: pick(ids), blockedUserId: pick(ids) })).filter((b) => b.blockerUserId !== b.blockedUserId);
  return { rnd, users, edges, blocks, ids };
}

test('engine agrees with brute-force reference on 1000 random graphs', async () => {
  let compared = 0, withPaths = 0, limited = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const g = randomGraph(seed);
    const src = g.ids[Math.floor(g.rnd() * g.ids.length)]!;
    const tgt = g.ids[Math.floor(g.rnd() * g.ids.length)]!;
    const opts = { maxHops: 1 + Math.floor(g.rnd() * 4), maxPaths: 1 + Math.floor(g.rnd() * 5), includeImported: g.rnd() < 0.5, now: NOW };
    const ref = referenceSearch(g.users, g.edges, g.blocks.map((b) => ({ a: b.blockerUserId, b: b.blockedUserId })), src, tgt, opts);
    const store = new InMemoryGraphStore({ users: shuffled(g.users, g.rnd), edges: shuffled(g.edges, g.rnd), blocks: g.blocks });
    const run = () => findIntroductionPaths(store, src, tgt, { ...opts, maxWork: 1_000_000, maxEdgesPerNode: 10_000 });
    const ctx = `seed=${seed}`;
    if (ref === 'source_unavailable') {
      await assert.rejects(run(), (e: unknown) => e instanceof GraphEngineError && e.code === 'SOURCE_UNAVAILABLE', ctx);
      continue;
    }
    const r = await run();
    if (ref === 'unavailable') { assert.equal(r.stopReason, 'target_unavailable', ctx); assert.equal(r.paths.length, 0, ctx); continue; }
    compared++;
    assert.deepEqual(r.paths.map((p) => ({ userIds: p.userIds, edgeIds: p.edgeIds })), ref.top, ctx);
    if (ref.top.length) withPaths++;
    if (ref.total > opts.maxPaths) { limited++; assert.equal(r.stopReason, 'path_limit', ctx); assert.equal(r.complete, false, ctx); }
    else if (r.stopReason === 'exhausted') assert.equal(r.paths.length, ref.total, ctx);
    assert.notEqual(r.stopReason, 'work_limit', ctx);
    assert.notEqual(r.stopReason, 'data_limit', ctx);
  }
  console.log(`reference coverage: compared=${compared} withPaths=${withPaths} pathLimitHit=${limited}`);
  assert.ok(compared >= 300, `only ${compared} comparable graphs`);
  assert.ok(withPaths >= 150, `only ${withPaths} graphs had paths — generator too sparse`);
  assert.ok(limited >= 20, `path_limit scenario only hit ${limited} times`);
});

test('random graphs: no returned path ever violates invariants', async () => {
  for (let seed = 1000; seed < 1300; seed++) {
    const g = randomGraph(seed);
    const src = g.ids[0]!, tgt = g.ids[g.ids.length - 1]!;
    const store = new InMemoryGraphStore({ users: g.users, edges: g.edges, blocks: g.blocks });
    let r;
    try { r = await findIntroductionPaths(store, src, tgt, { now: NOW, maxHops: 4, maxPaths: 20 }); } catch (e) { assert.ok(e instanceof GraphEngineError); continue; }
    const byId = new Map(g.edges.map((e) => [e.id, e]));
    for (const p of r.paths) {
      assert.equal(new Set(p.userIds).size, p.userIds.length);
      assert.equal(p.userIds[0], src); assert.equal(p.userIds.at(-1), tgt);
      p.edgeIds.forEach((id, i) => {
        const e = byId.get(id)!;
        assert.equal(e.revokedAt, null);
        assert.ok(['acquaintance', 'colleague', 'family', 'classmate', 'community_member'].includes(e.type));
        const [x, y] = [p.userIds[i]!, p.userIds[i + 1]!];
        assert.ok((e.sourceUserId === x && e.targetUserId === y) || (e.direction === 'mutual' && e.sourceUserId === y && e.targetUserId === x));
      });
    }
  }
});
