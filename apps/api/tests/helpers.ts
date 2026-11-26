import type { Confirmation, Evidence, GraphEdge, GraphUser } from '../src/graph/types.ts';

export const NOW = new Date('2026-06-01T00:00:00.000Z');
export const DAY = 86_400_000;
export const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
export const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

export function user(id: string, o: Partial<GraphUser> = {}): GraphUser {
  return { id, status: 'active', discoverable: true, acceptsIntroductions: true, ...o };
}

export function bothConfirmed(a: string, b: string, at = ago(10)): Confirmation[] {
  return [a, b].map((userId) => ({ userId, status: 'confirmed' as const, confirmedAt: at, revokedAt: null }));
}

/** Default: confirmed, granted, mutual acquaintance with two live confirmations and user_asserted evidence. */
export function edge(id: string, a: string, b: string, o: Partial<GraphEdge> = {}): GraphEdge {
  const evidence: Evidence[] = [{ type: 'user_asserted', createdAt: ago(10) }];
  return {
    id, sourceUserId: a, targetUserId: b, type: 'acquaintance', direction: 'mutual',
    verificationStatus: 'confirmed', permissionStatus: 'granted',
    createdAt: ago(20), updatedAt: ago(10), confirmedAt: ago(10), expiresAt: null, revokedAt: null,
    confirmations: bothConfirmed(a, b), evidence, ...o,
  };
}

export function users(...ids: string[]): GraphUser[] { return ids.map((i) => user(i)); }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
