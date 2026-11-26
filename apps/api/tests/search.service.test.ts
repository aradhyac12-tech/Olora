import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchService } from '../src/search/service.ts';
import type { SearchDeps } from '../src/search/service.ts';
import { InMemoryGraphStore } from '../src/graph/memoryStore.ts';
import { NOW, edge, user } from './helpers.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, T, D, X] = [id(1), id(2), id(3), id(4), id(5), id(6)];
const NAMES = new Map([[A, 'Ann'], [B, 'Bo'], [C, 'Cy'], [T, 'Target'], [D, 'Di'], [X, 'Xe']]);
function svc(store: InMemoryGraphStore, over: Partial<SearchDeps> = {}) {
  const asked: string[][] = [];
  const deps: SearchDeps = { snapshot: (fn) => fn(store), names: async (ids) => { asked.push(ids); return new Map(ids.map((i) => [i, NAMES.get(i)!])); }, now: () => NOW, ...over };
  return { s: new SearchService(deps), asked };
}
const graph = () => new InMemoryGraphStore({
  users: [user(A), user(B), user(C), user(T), user(D), user(X, { discoverable: false })],
  edges: [edge('e1', A, B), edge('e2', B, T), edge('e3', A, C), edge('e4', C, D), edge('e5', D, T)],
});

test('search: 2-hop route is requestable; 3-hop route is informational; only first-hop users are named', async () => {
  const { s, asked } = svc(graph());
  const r = await s.search(A, T);
  assert.ok(r.ok && r.value.status === 'found');
  assert.deepEqual(r.value.routes.map((x) => [x.connector.id, x.connector.displayName, x.hops, x.canRequest]), [[B, 'Bo', 2, true], [C, 'Cy', 3, false]]);
  assert.deepEqual(asked.flat().sort(), [B, C].sort(), 'names are looked up for first hops only (D is never named)');
  assert.ok(!JSON.stringify(r).includes(D));
  assert.equal(r.value.scope, 'contributed_graph');
});

test('search: unavailable target, self, and no-path are indistinguishable (none_found, no names looked up)', async () => {
  const { s, asked } = svc(graph());
  const none = { ok: true, value: { status: 'none_found', routes: [] } };
  assert.deepEqual(await s.search(A, X), none, 'not discoverable');
  assert.deepEqual(await s.search(A, id(99)), none, 'does not exist');
  assert.deepEqual(await s.search(A, A), none, 'self');
  const g = graph(); g.blocks.push({ blockerUserId: B, blockedUserId: T }); g.edges = g.edges.filter((e) => e.id !== 'e3');
  assert.deepEqual(await svc(g).s.search(A, T), none, 'blocked / no path');
  assert.equal(asked.length, 0);
});

test('search: input validation and generic failure (nothing leaked)', async () => {
  const { s } = svc(graph());
  for (const bad of ['', 'not-a-uuid', "'; drop table users;--", 'A'.repeat(200)]) assert.deepEqual(await s.search(A, bad), { ok: false, code: 'INVALID_INPUT' });
  assert.deepEqual(await s.search('nope', T), { ok: false, code: 'INVALID_INPUT' });
  const g = graph(); g.failWith = new Error('secret row values');
  const r = await svc(g).s.search(A, T);
  assert.deepEqual(r, { ok: false, code: 'INTERNAL' }); assert.ok(!JSON.stringify(r).includes('secret'));
  assert.deepEqual(await svc(graph(), { snapshot: async () => { throw new Error('db down'); } }).s.search(A, T), { ok: false, code: 'INTERNAL' });
  assert.deepEqual(await svc(graph(), { names: async () => { throw new Error('x'); } }).s.search(A, T), { ok: false, code: 'INTERNAL' });
  const inactive = graph(); inactive.users.set(A, user(A, { status: 'suspended' }));
  assert.deepEqual(await svc(inactive).s.search(A, T), { ok: false, code: 'INTERNAL' }, 'inactive caller is a server-side fault, not a hint');
});

test('search: a connector who does not accept introductions is never offered', async () => {
  const g = graph(); g.users.set(B, user(B, { acceptsIntroductions: false }));
  const r = await svc(g).s.search(A, T);
  assert.ok(r.ok && r.value.status === 'found' && r.value.routes.every((x) => x.connector.id !== B));
});
