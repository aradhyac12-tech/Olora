import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findIntroductionPaths, resolveOptions } from '../src/graph/engine.ts';
import { InMemoryGraphStore } from '../src/graph/memoryStore.ts';
import { GraphEngineError } from '../src/graph/types.ts';
import { isEdgeEligible } from '../src/graph/eligibility.ts';
import { NOW, ago, ahead, edge, user, users, bothConfirmed, shuffled, mulberry32 } from './helpers.ts';

const search = (s: InMemoryGraphStore, a: string, b: string, o = {}) => findIntroductionPaths(s, a, b, { now: NOW, ...o });
const ids = (r: Awaited<ReturnType<typeof search>>) => r.paths.map((p) => p.userIds.join('>'));

test('direct connection', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B'), edges: [edge('e1', 'A', 'B')] });
  const r = await search(s, 'A', 'B');
  assert.deepEqual(ids(r), ['A>B']);
  assert.equal(r.scope, 'contributed_graph');
  assert.equal(r.complete, true);
  assert.equal(r.stopReason, 'exhausted');
  assert.equal(r.shortestWithinScope, true);
});

test('multi-hop connection A>B>C>D', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'C', 'D'), edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'C'), edge('e3', 'C', 'D')] });
  const r = await search(s, 'A', 'D');
  assert.deepEqual(ids(r), ['A>B>C>D']);
  assert.equal(r.paths[0]!.hops, 3);
  assert.deepEqual(r.paths[0]!.edgeIds, ['e1', 'e2', 'e3']);
});

test('disconnected users: exhausted, complete, no paths, no shortest claim', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'C'), edges: [edge('e1', 'A', 'B')] });
  const r = await search(s, 'A', 'C');
  assert.equal(r.paths.length, 0);
  assert.equal(r.stopReason, 'exhausted');
  assert.equal(r.shortestWithinScope, false);
});

test('same source and target is unavailable', async () => {
  const s = new InMemoryGraphStore({ users: users('A') });
  const r = await search(s, 'A', 'A');
  assert.equal(r.stopReason, 'target_unavailable');
  assert.equal(r.complete, false);
  assert.equal(r.paths.length, 0);
});

test('hop limit excludes longer paths and is reported', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'C', 'D'), edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'C'), edge('e3', 'C', 'D')] });
  const r = await search(s, 'A', 'D', { maxHops: 2 });
  assert.equal(r.paths.length, 0);
  assert.equal(r.maxHops, 2);
  assert.equal(r.stopReason, 'exhausted');
  assert.equal((await search(s, 'A', 'D', { maxHops: 3 })).paths.length, 1);
});

test('path limit stops search and is not complete', async () => {
  const s = new InMemoryGraphStore({
    users: users('A', 'B', 'C', 'D', 'T'),
    edges: [edge('e1', 'A', 'B'), edge('e2', 'A', 'C'), edge('e3', 'A', 'D'), edge('e4', 'B', 'T'), edge('e5', 'C', 'T'), edge('e6', 'D', 'T')],
  });
  const r = await search(s, 'A', 'T', { maxPaths: 2 });
  assert.equal(r.paths.length, 2);
  assert.equal(r.stopReason, 'path_limit');
  assert.equal(r.complete, false);
  assert.equal(r.stats.pathsFound, 3);
});

test('exactly maxPaths available and nothing deeper is exhausted', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'C', 'T'), edges: [edge('e1', 'A', 'B'), edge('e2', 'A', 'C'), edge('e3', 'B', 'T'), edge('e4', 'C', 'T')] });
  const r = await search(s, 'A', 'T', { maxPaths: 2 });
  assert.equal(r.paths.length, 2);
  assert.equal(r.stopReason, 'exhausted');
  assert.equal(r.complete, true);
});

test('work limit reports work_limit, incomplete', async () => {
  const edges = [];
  const us = ['A', 'T'];
  for (let i = 0; i < 20; i++) { us.push(`M${i}`); edges.push(edge(`a${i}`, 'A', `M${i}`)); edges.push(edge(`b${i}`, `M${i}`, 'T')); }
  const s = new InMemoryGraphStore({ users: users(...us), edges });
  const r = await search(s, 'A', 'T', { maxWork: 10, maxPaths: 50 });
  assert.equal(r.stopReason, 'work_limit');
  assert.equal(r.complete, false);
  assert.ok(r.stats.work <= 10 + 100); // load of one node may exceed by its own size, never loops on
  const full = await search(s, 'A', 'T', { maxPaths: 50 });
  assert.equal(full.paths.length, 20);
  assert.equal(full.stopReason, 'exhausted');
});

test('cycles never repeat users in a path', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'C', 'T'), edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'C'), edge('e3', 'C', 'A'), edge('e4', 'C', 'T')] });
  const r = await search(s, 'A', 'T', { maxHops: 6, maxPaths: 50 });
  for (const p of r.paths) assert.equal(new Set(p.userIds).size, p.userIds.length);
  assert.deepEqual(ids(r), ['A>C>T', 'A>B>C>T']);
  assert.ok(r.stats.cyclesRejected > 0);
});

test('parallel edges: strongest evidence edge is used', async () => {
  const weak = edge('e1', 'A', 'B', { evidence: [{ type: 'user_asserted', createdAt: ago(1) }] });
  const strong = edge('e2', 'A', 'B', { type: 'colleague', evidence: [{ type: 'verified_identity_link', createdAt: ago(100) }] });
  const s = new InMemoryGraphStore({ users: users('A', 'B'), edges: [weak, strong] });
  const r = await search(s, 'A', 'B');
  assert.equal(r.paths.length, 1);
  assert.deepEqual(r.paths[0]!.edgeIds, ['e2']);
});

test('parallel edges: falls back to the eligible one', async () => {
  const bad = edge('e1', 'A', 'B', { revokedAt: ago(1) });
  const good = edge('e2', 'A', 'B', { type: 'family' });
  const s = new InMemoryGraphStore({ users: users('A', 'B'), edges: [bad, good] });
  assert.deepEqual((await search(s, 'A', 'B')).paths[0]!.edgeIds, ['e2']);
});

test('directed edge traverses forward only', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B'), edges: [edge('e1', 'A', 'B', { direction: 'directed' })] });
  assert.equal((await search(s, 'A', 'B')).paths.length, 1);
  assert.equal((await search(s, 'B', 'A')).paths.length, 0);
});

test('directed edge is never silently converted to mutual', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'C'), edges: [edge('e1', 'B', 'A', { direction: 'directed' }), edge('e2', 'B', 'C')] });
  assert.equal((await search(s, 'A', 'C')).paths.length, 0);
  assert.equal((await search(s, 'B', 'C')).paths.length, 1);
});

test('mutual edge traverses both ways', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B'), edges: [edge('e1', 'A', 'B')] });
  assert.equal((await search(s, 'B', 'A')).paths.length, 1);
});

const ineligible: Array<[string, Parameters<typeof edge>[3]]> = [
  ['expired', { expiresAt: ago(1) }],
  ['expiring exactly now', { expiresAt: NOW }],
  ['revoked', { revokedAt: ago(1) }],
  ['unverified', { verificationStatus: 'unverified' }],
  ['one_sided', { type: 'one_sided' }],
  ['social_follow', { type: 'social_follow' }],
  ['permission pending', { permissionStatus: 'pending' }],
  ['permission denied', { permissionStatus: 'denied' }],
  ['missing confirmedAt', { confirmedAt: null }],
  ['only one confirmation', { confirmations: bothConfirmed('A', 'B').slice(0, 1) }],
  ['confirmation from third party', { confirmations: [...bothConfirmed('A', 'B').slice(0, 1), ...bothConfirmed('X', 'Y').slice(0, 1)] }],
  ['duplicate confirmations by same user', { confirmations: [...bothConfirmed('A', 'B').slice(0, 1), ...bothConfirmed('A', 'B').slice(0, 1)] }],
  ['revoked confirmation', { confirmations: [{ userId: 'A', status: 'confirmed', confirmedAt: ago(5), revokedAt: null }, { userId: 'B', status: 'confirmed', confirmedAt: ago(5), revokedAt: ago(1) }] }],
  ['pending confirmation', { confirmations: [{ userId: 'A', status: 'confirmed', confirmedAt: ago(5), revokedAt: null }, { userId: 'B', status: 'pending', confirmedAt: null, revokedAt: null }] }],
  ['no confirmations', { confirmations: [] }],
];
for (const [name, over] of ineligible) {
  test(`ineligible edge excluded: ${name}`, async () => {
    const s = new InMemoryGraphStore({ users: users('A', 'B'), edges: [edge('e1', 'A', 'B', over)] });
    const r = await search(s, 'A', 'B');
    assert.equal(r.paths.length, 0);
    assert.equal(isEdgeEligible(s.edges[0]!, { now: NOW, includeImported: true }), false);
  });
}

test('future expiry is still eligible', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B'), edges: [edge('e1', 'A', 'B', { expiresAt: ahead(1) })] });
  assert.equal((await search(s, 'A', 'B')).paths.length, 1);
});

test('imported relationships require explicit opt-in', async () => {
  const imp = edge('e1', 'A', 'B', { type: 'imported', confirmations: [], evidence: [{ type: 'imported_record', createdAt: ago(2) }] });
  const s = new InMemoryGraphStore({ users: users('A', 'B'), edges: [imp] });
  assert.equal((await search(s, 'A', 'B')).paths.length, 0);
  assert.equal((await search(s, 'A', 'B', { includeImported: true })).paths.length, 1);
});

test('imported edge still needs verification and permission even when enabled', async () => {
  const imp = edge('e1', 'A', 'B', { type: 'imported', verificationStatus: 'unverified', confirmations: [] });
  const s = new InMemoryGraphStore({ users: users('A', 'B'), edges: [imp] });
  assert.equal((await search(s, 'A', 'B', { includeImported: true })).paths.length, 0);
});

test('connector without introduction consent is not used', async () => {
  const s = new InMemoryGraphStore({
    users: [user('A'), user('B', { acceptsIntroductions: false }), user('T')],
    edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'T')],
  });
  assert.equal((await search(s, 'A', 'T')).paths.length, 0);
});

test('suspended connector is not used', async () => {
  const s = new InMemoryGraphStore({ users: [user('A'), user('B', { status: 'suspended' }), user('T')], edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'T')] });
  assert.equal((await search(s, 'A', 'T')).paths.length, 0);
});

test('target need not accept introductions but must be discoverable', async () => {
  const ok = new InMemoryGraphStore({ users: [user('A'), user('T', { acceptsIntroductions: false })], edges: [edge('e1', 'A', 'T')] });
  assert.equal((await search(ok, 'A', 'T')).paths.length, 1);
  const hidden = new InMemoryGraphStore({ users: [user('A'), user('T', { discoverable: false })], edges: [edge('e1', 'A', 'T')] });
  assert.equal((await search(hidden, 'A', 'T')).stopReason, 'target_unavailable');
});

test('missing, hidden, inactive and blocked targets are indistinguishable', async () => {
  const mk = (us: ReturnType<typeof user>[], blocks: { blockerUserId: string; blockedUserId: string }[] = []) =>
    new InMemoryGraphStore({ users: us, edges: [edge('e1', 'A', 'T')], blocks });
  const results = await Promise.all([
    search(mk([user('A')]), 'A', 'T'),
    search(mk([user('A'), user('T', { discoverable: false })]), 'A', 'T'),
    search(mk([user('A'), user('T', { status: 'deactivated' })]), 'A', 'T'),
    search(mk([user('A'), user('T')], [{ blockerUserId: 'T', blockedUserId: 'A' }]), 'A', 'T'),
    search(mk([user('A'), user('T')], [{ blockerUserId: 'A', blockedUserId: 'T' }]), 'A', 'T'),
  ]);
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.equal(results[0]!.stopReason, 'target_unavailable');
});

test('blocked connector is excluded and alternative path used', async () => {
  const s = new InMemoryGraphStore({
    users: users('A', 'B', 'C', 'T'),
    edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'T'), edge('e3', 'A', 'C'), edge('e4', 'C', 'T')],
    blocks: [{ blockerUserId: 'B', blockedUserId: 'A' }],
  });
  assert.deepEqual(ids(await search(s, 'A', 'T')), ['A>C>T']);
});

test('block in either direction between adjacent users is respected', async () => {
  for (const [x, y] of [['A', 'B'], ['B', 'A']] as const) {
    const s = new InMemoryGraphStore({ users: users('A', 'B', 'T'), edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'T')], blocks: [{ blockerUserId: x, blockedUserId: y }] });
    assert.equal((await search(s, 'A', 'T')).paths.length, 0, `${x} blocks ${y}`);
  }
});

test('non-adjacent connectors that block each other invalidate the path', async () => {
  for (const [x, y] of [['B', 'C'], ['C', 'B']] as const) {
    const s = new InMemoryGraphStore({
      users: users('A', 'B', 'X', 'C', 'T'),
      edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'X'), edge('e3', 'X', 'C'), edge('e4', 'C', 'T')],
      blocks: [{ blockerUserId: x, blockedUserId: y }],
    });
    assert.equal((await search(s, 'A', 'T', { maxHops: 5 })).paths.length, 0, `${x} blocks ${y}`);
  }
});

test('connector blocked with the target is excluded', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'T'), edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'T')], blocks: [{ blockerUserId: 'T', blockedUserId: 'B' }] });
  assert.equal((await search(s, 'A', 'T')).paths.length, 0);
});

test('inactive or missing source throws SOURCE_UNAVAILABLE', async () => {
  const s = new InMemoryGraphStore({ users: [user('A', { status: 'suspended' }), user('T')] });
  await assert.rejects(search(s, 'A', 'T'), (e: unknown) => e instanceof GraphEngineError && e.code === 'SOURCE_UNAVAILABLE');
  await assert.rejects(search(s, 'ghost', 'T'), (e: unknown) => e instanceof GraphEngineError && e.code === 'SOURCE_UNAVAILABLE');
});

test('edges to unknown users are ignored (fail closed)', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'T'), edges: [edge('e1', 'A', 'ghost'), edge('e2', 'ghost', 'T')] });
  assert.equal((await search(s, 'A', 'T')).paths.length, 0);
});

test('self edges are ignored', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'T'), edges: [edge('e1', 'A', 'A'), edge('e2', 'A', 'T')] });
  assert.deepEqual(ids(await search(s, 'A', 'T')), ['A>T']);
});

// ---- ranking ----
const twoRoutes = (b: object, c: object, ob: object = {}, oc: object = {}) =>
  new InMemoryGraphStore({
    users: users('A', 'B', 'C', 'T'),
    edges: [edge('e1', 'A', 'B', ob), edge('e2', 'B', 'T', ob), edge('e3', 'A', 'C', oc), edge('e4', 'C', 'T', oc)],
  });

test('ranking 1: fewer hops first', async () => {
  const s = new InMemoryGraphStore({
    users: users('A', 'B', 'T'),
    edges: [edge('a', 'A', 'B', { evidence: [{ type: 'verified_identity_link', createdAt: ago(1) }] }), edge('b', 'B', 'T', { evidence: [{ type: 'verified_identity_link', createdAt: ago(1) }] }),
      edge('z', 'A', 'T', { evidence: [{ type: 'user_asserted', createdAt: ago(900) }] })],
  });
  assert.deepEqual(ids(await search(s, 'A', 'T')), ['A>T', 'A>B>T']);
});

test('ranking 2: stronger evidence first (weakest link)', async () => {
  const strong = { evidence: [{ type: 'verified_identity_link' as const, createdAt: ago(50) }] };
  const weak = { evidence: [{ type: 'user_asserted' as const, createdAt: ago(1) }] };
  // route via B is weak with smaller ids; route via C strong
  const s = twoRoutes({}, {}, weak, strong);
  assert.deepEqual(ids(await search(s, 'A', 'T')), ['A>C>T', 'A>B>T']);
});

test('ranking 3: less stale evidence first', async () => {
  const old = { evidence: [{ type: 'user_asserted' as const, createdAt: ago(300) }] };
  const fresh = { evidence: [{ type: 'user_asserted' as const, createdAt: ago(2) }] };
  assert.deepEqual(ids(await search(twoRoutes({}, {}, old, fresh), 'A', 'T')), ['A>C>T', 'A>B>T']);
});

test('ranking 4: more recent confirmation first', async () => {
  const ev = [{ type: 'user_asserted' as const, createdAt: ago(5) }];
  const older = { evidence: ev, confirmedAt: ago(200) };
  const newer = { evidence: ev, confirmedAt: ago(3) };
  assert.deepEqual(ids(await search(twoRoutes({}, {}, older, newer), 'A', 'T')), ['A>C>T', 'A>B>T']);
});

test('ranking 5: stable edge id is the final tie-breaker', async () => {
  assert.deepEqual(ids(await search(twoRoutes({}, {}), 'A', 'T')), ['A>B>T', 'A>C>T']);
});

test('results are identical regardless of input ordering', async () => {
  const base = twoRoutes({}, {});
  const baseline = await search(base, 'A', 'T', { maxPaths: 10 });
  const rnd = mulberry32(7);
  for (let i = 0; i < 25; i++) {
    const s = new InMemoryGraphStore({ users: shuffled([...base.users.values()], rnd), edges: shuffled(base.edges, rnd) });
    assert.deepEqual(await search(s, 'A', 'T', { maxPaths: 10 }), baseline);
  }
});

// ---- options and failure semantics ----
test('invalid options are rejected', () => {
  const bad: Array<Record<string, unknown>> = [
    { maxHops: 0 }, { maxHops: 7 }, { maxHops: 1.5 }, { maxHops: NaN }, { maxPaths: 0 }, { maxPaths: 51 },
    { maxWork: 0 }, { maxWork: -1 }, { maxEdgesPerNode: 0 }, { includeImported: 'yes' }, { now: new Date('nope') },
  ];
  for (const b of bad) assert.throws(() => resolveOptions(b as never), (e: unknown) => e instanceof GraphEngineError && e.code === 'INVALID_OPTIONS', JSON.stringify(b));
  assert.doesNotThrow(() => resolveOptions({}));
});

test('data truncation reports data_limit and never claims shortest/complete', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'C', 'T'), edges: [edge('e1', 'A', 'B'), edge('e2', 'A', 'C'), edge('e3', 'C', 'T')] });
  const r = await search(s, 'A', 'T', { maxEdgesPerNode: 1 });
  assert.equal(r.stats.dataTruncated, true);
  assert.equal(r.stopReason, 'data_limit');
  assert.equal(r.complete, false);
  assert.equal(r.shortestWithinScope, false);
});

test('truncation order is deterministic by edge id', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'C'), edges: [edge('z', 'A', 'C'), edge('a', 'A', 'B')] });
  const page = await s.getEdgesFrom('A', { now: NOW, includeImported: false, limit: 1 });
  assert.deepEqual(page.edges.map((e) => e.id), ['a']);
  assert.equal(page.truncated, true);
});

test('store failure fails closed with a generic error', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'T'), edges: [edge('e1', 'A', 'T')] });
  s.failWith = new Error('relation "secret_table" does not exist at user 123');
  await assert.rejects(search(s, 'A', 'T'), (e: unknown) => e instanceof GraphEngineError && e.code === 'STORE_FAILURE' && !/secret|123/.test(e.message));
});

test('consent revocation affects the next search', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'T'), edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'T')] });
  assert.equal((await search(s, 'A', 'T')).paths.length, 1);
  s.users.get('B')!.acceptsIntroductions = false;
  assert.equal((await search(s, 'A', 'T')).paths.length, 0);
  s.users.get('T')!.discoverable = false;
  assert.equal((await search(s, 'A', 'T')).stopReason, 'target_unavailable');
});

test('new block and relationship revocation affect the next search', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'T'), edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'T')] });
  s.blocks.push({ blockerUserId: 'B', blockedUserId: 'T' });
  assert.equal((await search(s, 'A', 'T')).paths.length, 0);
  s.blocks.length = 0;
  assert.equal((await search(s, 'A', 'T')).paths.length, 1);
  s.edges[0]!.revokedAt = NOW;
  assert.equal((await search(s, 'A', 'T')).paths.length, 0);
});

test('stats are reported', async () => {
  const s = new InMemoryGraphStore({ users: users('A', 'B', 'T'), edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'T')] });
  const r = await search(s, 'A', 'T');
  assert.equal(r.stats.pathsFound, 1);
  assert.ok(r.stats.nodesExpanded >= 2 && r.stats.edgesLoaded >= 2 && r.stats.work >= r.stats.edgesLoaded);
});

// ---- defense in depth: the engine must not trust the store's prefiltering ----
class LeakyStore extends InMemoryGraphStore {
  override async getEdgesFrom(userId: string, o: { limit: number }) {
    const all = this.edges.filter((e) => e.sourceUserId === userId || e.targetUserId === userId).sort((a, b) => (a.id < b.id ? -1 : 1));
    return { edges: all.slice(0, o.limit), truncated: all.length > o.limit };
  }
}

test('engine re-enforces direction even if a store returns backwards directed edges', async () => {
  const s = new LeakyStore({ users: users('A', 'B'), edges: [edge('e1', 'B', 'A', { direction: 'directed' })] });
  assert.equal((await search(s, 'A', 'B')).paths.length, 0);
  assert.equal((await search(s, 'B', 'A')).paths.length, 1);
});

test('engine re-enforces eligibility even if a store returns ineligible edges', async () => {
  for (const [name, over] of ineligible) {
    const s = new LeakyStore({ users: users('A', 'B'), edges: [edge('e1', 'A', 'B', over)] });
    assert.equal((await search(s, 'A', 'B')).paths.length, 0, name);
  }
  const imp = new LeakyStore({ users: users('A', 'B'), edges: [edge('e1', 'A', 'B', { type: 'imported', confirmations: [] })] });
  assert.equal((await search(imp, 'A', 'B')).paths.length, 0);
});

test('engine re-enforces blocks even if a store returns blocked neighbours', async () => {
  const s = new LeakyStore({ users: users('A', 'B', 'T'), edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'T')], blocks: [{ blockerUserId: 'A', blockedUserId: 'B' }] });
  assert.equal((await search(s, 'A', 'T')).paths.length, 0);
});
