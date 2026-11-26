import type { EdgePage, EdgeQueryOptions, GraphEdge, GraphStore, GraphUser, UserId } from './types.ts';
import { isEdgeEligible } from './eligibility.ts';

export interface BlockRecord { blockerUserId: UserId; blockedUserId: UserId }

/** In-memory store for unit tests. Mutable on purpose so tests can change consent/blocks between searches. */
export class InMemoryGraphStore implements GraphStore {
  users = new Map<UserId, GraphUser>();
  edges: GraphEdge[] = [];
  blocks: BlockRecord[] = [];
  failWith: Error | null = null;

  constructor(init: { users?: GraphUser[]; edges?: GraphEdge[]; blocks?: BlockRecord[] } = {}) {
    for (const u of init.users ?? []) this.users.set(u.id, u);
    this.edges = [...(init.edges ?? [])];
    this.blocks = [...(init.blocks ?? [])];
  }

  async getUsers(ids: UserId[]): Promise<Map<UserId, GraphUser>> {
    if (this.failWith) throw this.failWith;
    const out = new Map<UserId, GraphUser>();
    for (const id of ids) {
      const u = this.users.get(id);
      if (u) out.set(id, { ...u });
    }
    return out;
  }

  async getEdgesFrom(userId: UserId, o: EdgeQueryOptions): Promise<EdgePage> {
    if (this.failWith) throw this.failWith;
    const eligible = this.edges
      .filter((e) => e.sourceUserId === userId || (e.targetUserId === userId && e.direction === 'mutual'))
      .filter((e) => isEdgeEligible(e, o))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { edges: eligible.slice(0, o.limit), truncated: eligible.length > o.limit };
  }

  async getBlockedCounterparties(userId: UserId): Promise<Set<UserId>> {
    if (this.failWith) throw this.failWith;
    const s = new Set<UserId>();
    for (const b of this.blocks) {
      if (b.blockerUserId === userId) s.add(b.blockedUserId);
      if (b.blockedUserId === userId) s.add(b.blockerUserId);
    }
    return s;
  }
}
