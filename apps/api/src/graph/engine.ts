import type {
  GraphEdge, GraphStore, GraphUser, RankedPath, SearchOptions, SearchResult, SearchStats, StopReason, UserId,
} from './types.ts';
import { DEFAULT_SEARCH_OPTIONS, GraphEngineError, SEARCH_LIMITS } from './types.ts';
import { edgeStrength, isConnectorEligible, isEdgeEligible, isTargetVisible, isUserActive, lastEvidenceMs } from './eligibility.ts';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const numCmp = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);

export function resolveOptions(input: Partial<SearchOptions> = {}): SearchOptions {
  const o: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, now: new Date(), ...input } as SearchOptions;
  const intIn = (name: string, v: unknown, max: number) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
      throw new GraphEngineError('INVALID_OPTIONS', `${name} must be an integer between 1 and ${max}`);
    }
  };
  intIn('maxHops', o.maxHops, SEARCH_LIMITS.maxHops);
  intIn('maxPaths', o.maxPaths, SEARCH_LIMITS.maxPaths);
  intIn('maxWork', o.maxWork, SEARCH_LIMITS.maxWork);
  intIn('maxEdgesPerNode', o.maxEdgesPerNode, SEARCH_LIMITS.maxEdgesPerNode);
  if (typeof o.includeImported !== 'boolean') throw new GraphEngineError('INVALID_OPTIONS', 'includeImported must be boolean');
  if (!(o.now instanceof Date) || Number.isNaN(o.now.getTime())) throw new GraphEngineError('INVALID_OPTIONS', 'now must be a valid Date');
  return o;
}

/** Parallel edges between the same two users: best edge wins, deterministically. */
function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return (
    numCmp(edgeStrength(b.evidence), edgeStrength(a.evidence)) ||
    numCmp(lastEvidenceMs(b.evidence), lastEvidenceMs(a.evidence)) ||
    numCmp(b.confirmedAt?.getTime() ?? -Infinity, a.confirmedAt?.getTime() ?? -Infinity) ||
    cmp(a.id, b.id)
  );
}

export function rankPath(userIds: UserId[], edges: GraphEdge[], now: Date): RankedPath {
  let weakest = Infinity;
  let stale = 0;
  let oldestConf = Infinity;
  for (const e of edges) {
    weakest = Math.min(weakest, edgeStrength(e.evidence));
    const last = lastEvidenceMs(e.evidence);
    stale = Math.max(stale, last === -Infinity ? Infinity : now.getTime() - last);
    oldestConf = Math.min(oldestConf, e.confirmedAt?.getTime() ?? -Infinity);
  }
  return {
    userIds, edgeIds: edges.map((e) => e.id), hops: edges.length,
    weakestStrength: weakest, stalenessMs: stale, oldestConfirmationMs: oldestConf,
  };
}

export function comparePaths(a: RankedPath, b: RankedPath): number {
  let c =
    numCmp(a.hops, b.hops) ||
    numCmp(b.weakestStrength, a.weakestStrength) ||
    numCmp(a.stalenessMs, b.stalenessMs) ||
    numCmp(b.oldestConfirmationMs, a.oldestConfirmationMs);
  if (c) return c;
  for (let i = 0; i < a.edgeIds.length; i++) {
    c = cmp(a.edgeIds[i]!, b.edgeIds[i]!);
    if (c) return c;
  }
  for (let i = 0; i < a.userIds.length; i++) {
    c = cmp(a.userIds[i]!, b.userIds[i]!);
    if (c) return c;
  }
  return 0;
}

interface Adj { neighbors: Array<[UserId, GraphEdge]>; blocked: Set<UserId> }
interface PartialPath { users: UserId[]; edges: GraphEdge[] }

function emptyResult(stopReason: StopReason, maxHops: number): SearchResult {
  return {
    scope: 'contributed_graph', stopReason, complete: stopReason === 'exhausted', shortestWithinScope: false,
    maxHops, paths: [],
    stats: { edgesLoaded: 0, nodesExpanded: 0, extensionsConsidered: 0, work: 0, cyclesRejected: 0, pathsFound: 0, dataTruncated: false },
  };
}

/**
 * Bounded BFS over partial paths. Never throws private data; store failures fail closed.
 * target_unavailable deliberately does not reveal whether the target is missing, hidden, inactive or blocked.
 */
export async function findIntroductionPaths(
  store: GraphStore, sourceId: UserId, targetId: UserId, input: Partial<SearchOptions> = {},
): Promise<SearchResult> {
  const o = resolveOptions(input);
  try {
    return await run(store, sourceId, targetId, o);
  } catch (err) {
    if (err instanceof GraphEngineError) throw err;
    throw new GraphEngineError('STORE_FAILURE', 'graph data could not be read'); // no internal details leaked
  }
}

async function run(store: GraphStore, sourceId: UserId, targetId: UserId, o: SearchOptions): Promise<SearchResult> {
  const first = await store.getUsers([sourceId, targetId]);
  const source = first.get(sourceId);
  if (!source || !isUserActive(source)) throw new GraphEngineError('SOURCE_UNAVAILABLE', 'source user is not available');
  if (sourceId === targetId) return emptyResult('target_unavailable', o.maxHops);
  const target = first.get(targetId);
  const sourceBlocks = await store.getBlockedCounterparties(sourceId);
  if (!target || !isTargetVisible(target) || sourceBlocks.has(targetId)) return emptyResult('target_unavailable', o.maxHops);
  const targetBlocks = await store.getBlockedCounterparties(targetId);

  const stats: SearchStats = {
    edgesLoaded: 0, nodesExpanded: 0, extensionsConsidered: 0, work: 0, cyclesRejected: 0, pathsFound: 0, dataTruncated: false,
  };
  const adjCache = new Map<UserId, Adj>();
  const blockCache = new Map<UserId, Set<UserId>>([[sourceId, sourceBlocks], [targetId, targetBlocks]]);

  /** Returns null when the work budget is exhausted while loading. */
  async function loadNode(u: UserId): Promise<Adj | null> {
    const cached = adjCache.get(u);
    if (cached) return cached;
    const page = await store.getEdgesFrom(u, { now: o.now, includeImported: o.includeImported, limit: o.maxEdgesPerNode });
    stats.nodesExpanded++;
    stats.edgesLoaded += page.edges.length;
    stats.work += page.edges.length;
    if (page.truncated) stats.dataTruncated = true;
    const blocked = blockCache.get(u) ?? (await store.getBlockedCounterparties(u));
    blockCache.set(u, blocked);
    if (stats.work > o.maxWork) return null;

    const best = new Map<UserId, GraphEdge>();
    const candidates: Array<[UserId, GraphEdge]> = [];
    for (const e of page.edges) {
      let n: UserId;
      if (e.sourceUserId === u) n = e.targetUserId;
      else if (e.targetUserId === u && e.direction === 'mutual') n = e.sourceUserId;
      else continue; // never traverse a directed edge backwards
      if (n === u || !isEdgeEligible(e, o) || blocked.has(n)) continue;
      candidates.push([n, e]);
    }
    const ids = [...new Set(candidates.map(([n]) => n))].filter((n) => n !== targetId);
    const users: Map<UserId, GraphUser> = ids.length ? await store.getUsers(ids) : new Map();
    for (const [n, e] of candidates) {
      if (n === targetId) { /* validated above */ }
      else {
        const nu = users.get(n);
        if (!nu || !isConnectorEligible(nu) || sourceBlocks.has(n) || targetBlocks.has(n)) continue;
      }
      const cur = best.get(n);
      if (!cur || compareEdges(e, cur) < 0) best.set(n, e);
    }
    const adj: Adj = { neighbors: [...best.entries()].sort((a, b) => cmp(a[0], b[0])), blocked };
    adjCache.set(u, adj);
    return adj;
  }

  let level: PartialPath[] = [{ users: [sourceId], edges: [] }];
  const found: PartialPath[] = [];
  let stop: StopReason | null = null;
  let shortestOk: boolean | null = null;

  outer: for (let hop = 1; hop <= o.maxHops; hop++) {
    const next: PartialPath[] = [];
    for (const p of level) {
      const u = p.users[p.users.length - 1]!;
      const adj = await loadNode(u);
      if (!adj) { stop = 'work_limit'; break outer; }
      for (const [n, edge] of adj.neighbors) {
        if (stats.work >= o.maxWork) { stop = 'work_limit'; break outer; }
        stats.work++;
        stats.extensionsConsidered++;
        if (p.users.includes(n)) { stats.cyclesRejected++; continue; }
        if (p.users.some((x) => blockCache.get(x)?.has(n))) continue;
        const np: PartialPath = { users: [...p.users, n], edges: [...p.edges, edge] };
        if (n === targetId) found.push(np);
        else if (hop < o.maxHops) next.push(np);
      }
    }
    if (found.length > 0 && shortestOk === null) shortestOk = !stats.dataTruncated;
    if (found.length >= o.maxPaths) {
      const moreExist = found.length > o.maxPaths || (hop < o.maxHops && next.length > 0);
      if (moreExist) { stop = 'path_limit'; break; }
    }
    level = next;
    if (level.length === 0) break;
  }

  if (stop === null) stop = stats.dataTruncated ? 'data_limit' : 'exhausted';
  const ranked = found.map((p) => rankPath(p.users, p.edges, o.now)).sort(comparePaths);
  stats.pathsFound = found.length;
  return {
    scope: 'contributed_graph', stopReason: stop, complete: stop === 'exhausted',
    shortestWithinScope: ranked.length > 0 && shortestOk === true,
    maxHops: o.maxHops, paths: ranked.slice(0, o.maxPaths), stats,
  };
}
