import type { Confirmation, EligibilityPolicy, GraphEdge, GraphUser, Evidence, EvidenceType } from './types.ts';
import { CONFIRMED_RELATIONSHIP_TYPES } from './types.ts';

const CONFIRMED_TYPES = new Set<string>(CONFIRMED_RELATIONSHIP_TYPES);

export const EVIDENCE_STRENGTH: Record<EvidenceType, number> = {
  verified_identity_link: 4,
  shared_community: 3,
  user_asserted: 2,
  imported_record: 1,
};

function activeConfirmers(confirmations: Confirmation[]): Set<string> {
  const s = new Set<string>();
  for (const c of confirmations) {
    if (c.status === 'confirmed' && c.revokedAt === null && c.confirmedAt !== null) s.add(c.userId);
  }
  return s;
}

/** Both actual participants must hold a live confirmation. Extra/foreign confirmers never count. */
export function hasBothParticipantConfirmations(edge: GraphEdge): boolean {
  const who = activeConfirmers(edge.confirmations);
  return who.has(edge.sourceUserId) && who.has(edge.targetUserId);
}

/**
 * Default trusted-path eligibility. Pure; used by the engine AND by in-memory store prefiltering.
 * Imported edges (policy opt-in) need verification+permission but not dual confirmation.
 */
export function isEdgeEligible(edge: GraphEdge, policy: EligibilityPolicy): boolean {
  if (edge.sourceUserId === edge.targetUserId) return false;
  if (edge.revokedAt !== null) return false;
  if (edge.expiresAt !== null && edge.expiresAt.getTime() <= policy.now.getTime()) return false;
  if (edge.permissionStatus !== 'granted') return false;
  if (edge.verificationStatus !== 'confirmed') return false;
  if (edge.confirmedAt === null) return false;
  if (edge.type === 'social_follow' || edge.type === 'one_sided') return false;
  if (edge.type === 'imported') return policy.includeImported;
  if (!CONFIRMED_TYPES.has(edge.type)) return false;
  return hasBothParticipantConfirmations(edge);
}

export function edgeStrength(evidence: Evidence[]): number {
  let m = 0;
  for (const e of evidence) m = Math.max(m, EVIDENCE_STRENGTH[e.type] ?? 0);
  return m;
}

export function lastEvidenceMs(evidence: Evidence[]): number {
  let m = -Infinity;
  for (const e of evidence) m = Math.max(m, e.createdAt.getTime());
  return m;
}

export function isUserActive(u: GraphUser): boolean {
  return u.status === 'active';
}
export function isConnectorEligible(u: GraphUser): boolean {
  return u.status === 'active' && u.acceptsIntroductions === true;
}
export function isTargetVisible(u: GraphUser): boolean {
  return u.status === 'active' && u.discoverable === true;
}
