// Pure introduction state machine: no I/O, no clock, fully unit-testable.
export type IntroStatus = 'pending_connector' | 'pending_target' | 'accepted' | 'declined' | 'cancelled' | 'expired';
export type IntroAction = 'connector_accept' | 'connector_decline' | 'target_accept' | 'target_decline' | 'requester_cancel' | 'expire';

export const OPEN_STATUSES: readonly IntroStatus[] = ['pending_connector', 'pending_target'];
export const isOpen = (s: IntroStatus) => OPEN_STATUSES.includes(s);

export interface IntroParties {
  requesterId: string; connectorId: string; targetId: string;
  status: IntroStatus; expiresAt: Date; connectorAcceptedAt: Date | null;
}

export interface Notice { recipientId: string; event: string; }
export type Decision =
  | { ok: true; to: IntroStatus; notices: Notice[] }
  | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE' | 'EXPIRED' };

/** Who may see the request at all. The target learns of it only after the connector accepted. */
export function canSee(r: IntroParties, userId: string | null): boolean {
  if (userId === null) return false;
  if (userId === r.requesterId || userId === r.connectorId) return true;
  return userId === r.targetId && r.connectorAcceptedAt !== null;
}

const ROLE: Record<Exclude<IntroAction, 'expire'>, 'requester' | 'connector' | 'target'> = {
  connector_accept: 'connector', connector_decline: 'connector',
  target_accept: 'target', target_decline: 'target', requester_cancel: 'requester',
};
const FROM: Record<IntroAction, IntroStatus[]> = {
  connector_accept: ['pending_connector'], connector_decline: ['pending_connector'],
  target_accept: ['pending_target'], target_decline: ['pending_target'],
  requester_cancel: ['pending_connector', 'pending_target'], expire: ['pending_connector', 'pending_target'],
};
const TO: Record<IntroAction, IntroStatus> = {
  connector_accept: 'pending_target', connector_decline: 'declined', target_accept: 'accepted',
  target_decline: 'declined', requester_cancel: 'cancelled', expire: 'expired',
};

/**
 * Decide what `action` by `actorId` (null = system) does to `r` at `now`.
 * Order matters for privacy: invisible => NOT_FOUND (never reveals existence), wrong role => FORBIDDEN,
 * wrong state => INVALID_STATE, due => EXPIRED (caller must persist the expiry).
 */
export function decide(r: IntroParties, action: IntroAction, actorId: string | null, now: Date): Decision {
  if (action === 'expire') {
    if (actorId !== null) return { ok: false, code: 'FORBIDDEN' };
    if (!FROM.expire.includes(r.status) || now < r.expiresAt) return { ok: false, code: 'INVALID_STATE' };
    return { ok: true, to: 'expired', notices: [{ recipientId: r.requesterId, event: 'introduction_expired' }] };
  }
  if (!canSee(r, actorId)) return { ok: false, code: 'NOT_FOUND' };
  const need = ROLE[action];
  const id = need === 'requester' ? r.requesterId : need === 'connector' ? r.connectorId : r.targetId;
  if (actorId !== id) return { ok: false, code: 'FORBIDDEN' };
  if (!FROM[action].includes(r.status)) return { ok: false, code: 'INVALID_STATE' };
  if (now >= r.expiresAt) return { ok: false, code: 'EXPIRED' };
  const notices: Notice[] = [];
  switch (action) {
    case 'connector_accept': notices.push({ recipientId: r.targetId, event: 'introduction_consent_needed' }); break;
    case 'connector_decline': case 'target_decline': notices.push({ recipientId: r.requesterId, event: 'introduction_declined' }); break;
    case 'target_accept':
      notices.push({ recipientId: r.requesterId, event: 'introduction_accepted' }, { recipientId: r.connectorId, event: 'introduction_accepted' }); break;
    case 'requester_cancel':
      notices.push({ recipientId: r.status === 'pending_connector' ? r.connectorId : r.targetId, event: 'introduction_cancelled' }); break;
  }
  return { ok: true, to: TO[action], notices };
}
export const targetStatus = (a: IntroAction): IntroStatus => TO[a];
