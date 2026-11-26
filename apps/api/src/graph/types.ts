export type UserId = string;
export type EdgeId = string;

export type AccountStatus = 'active' | 'suspended' | 'deactivated' | 'deleted';

export interface GraphUser {
  id: UserId;
  status: AccountStatus;
  /** Target must be discoverable to be found. Default false. */
  discoverable: boolean;
  /** Connector must accept introductions to be used as an intermediate. Default false. */
  acceptsIntroductions: boolean;
}

/** Types that require two independent confirmations to count as trusted. */
export const CONFIRMED_RELATIONSHIP_TYPES = [
  'acquaintance',
  'colleague',
  'classmate',
  'family',
  'community_member',
] as const;
export type ConfirmedRelationshipType = (typeof CONFIRMED_RELATIONSHIP_TYPES)[number];
/** Types that never count as trusted unless explicitly enabled (imported) or never at all. */
export type RelationshipType = ConfirmedRelationshipType | 'one_sided' | 'imported' | 'social_follow';

export type Direction = 'mutual' | 'directed'; // directed: source -> target only
export type VerificationStatus = 'unverified' | 'confirmed';
export type PermissionStatus = 'pending' | 'granted' | 'denied';

export type EvidenceType =
  | 'verified_identity_link'
  | 'shared_community'
  | 'user_asserted'
  | 'imported_record';

export interface Evidence {
  type: EvidenceType;
  createdAt: Date;
}

export type ConfirmationStatus = 'pending' | 'confirmed' | 'revoked';
export interface Confirmation {
  userId: UserId;
  status: ConfirmationStatus;
  confirmedAt: Date | null;
  revokedAt: Date | null;
}

/** Evidence is kept separate from status fields (verificationStatus / permissionStatus). */
export interface GraphEdge {
  id: EdgeId;
  sourceUserId: UserId;
  targetUserId: UserId;
  type: RelationshipType;
  direction: Direction;
  verificationStatus: VerificationStatus;
  permissionStatus: PermissionStatus;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  confirmations: Confirmation[];
  evidence: Evidence[];
}

export interface EligibilityPolicy {
  now: Date;
  includeImported: boolean;
}

export interface EdgeQueryOptions extends EligibilityPolicy {
  limit: number;
}

export interface EdgePage {
  edges: GraphEdge[];
  /** True when more eligible rows existed than `limit`. */
  truncated: boolean;
}

/**
 * Storage contract. Implementations MUST:
 *  - return edges ordered by edge id ascending, THEN truncate to `limit` (determinism);
 *  - return only edges traversable outward from userId (source = userId, or target = userId and mutual)
 *    that are policy-eligible (same rule as isEdgeEligible) — the engine re-verifies anyway;
 *  - return block counterparties in BOTH directions;
 *  - fail closed (throw) on error; never return partial data silently.
 */
export interface GraphStore {
  getUsers(ids: UserId[]): Promise<Map<UserId, GraphUser>>;
  getEdgesFrom(userId: UserId, options: EdgeQueryOptions): Promise<EdgePage>;
  getBlockedCounterparties(userId: UserId): Promise<Set<UserId>>;
}

export interface SearchOptions {
  maxHops: number;
  maxPaths: number;
  /** Work units: edges loaded + path extensions considered. */
  maxWork: number;
  /** Max eligible edges loaded per expanded user. */
  maxEdgesPerNode: number;
  includeImported: boolean;
  now: Date;
}

export const SEARCH_LIMITS = { maxHops: 6, maxPaths: 50, maxWork: 1_000_000, maxEdgesPerNode: 10_000 } as const;
export const DEFAULT_SEARCH_OPTIONS = { maxHops: 4, maxPaths: 5, maxWork: 5_000, maxEdgesPerNode: 500, includeImported: false } as const;

export type StopReason = 'exhausted' | 'path_limit' | 'work_limit' | 'data_limit' | 'target_unavailable';

export interface RankedPath {
  userIds: UserId[];
  edgeIds: EdgeId[];
  hops: number;
  /** Weakest-link evidence strength along the path (0-4). */
  weakestStrength: number;
  /** Max evidence age over edges in ms; Infinity when an edge has no evidence. */
  stalenessMs: number;
  /** Oldest confirmation time among edges (epoch ms); -Infinity when unknown. */
  oldestConfirmationMs: number;
}

export interface SearchStats {
  edgesLoaded: number;
  nodesExpanded: number;
  extensionsConsidered: number;
  work: number;
  cyclesRejected: number;
  pathsFound: number;
  dataTruncated: boolean;
}

export interface SearchResult {
  scope: 'contributed_graph';
  stopReason: StopReason;
  /** True only when the permitted search space (within maxHops) was exhausted. */
  complete: boolean;
  /**
   * True only when paths were found, the search ended without work limit or data truncation, so the
   * returned minimum hop count is the shortest within the contributed graph. Never a global claim.
   */
  shortestWithinScope: boolean;
  maxHops: number;
  paths: RankedPath[];
  stats: SearchStats;
}

export class GraphEngineError extends Error {
  readonly code: 'INVALID_OPTIONS' | 'SOURCE_UNAVAILABLE' | 'STORE_FAILURE';
  constructor(code: GraphEngineError['code'], message: string) {
    super(message);
    this.name = 'GraphEngineError';
    this.code = code;
  }
}
