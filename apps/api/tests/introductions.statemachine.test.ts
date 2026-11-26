import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSee, decide, isOpen } from '../src/introductions/stateMachine.ts';
import type { IntroAction, IntroParties, IntroStatus } from '../src/introductions/stateMachine.ts';

const [R, C, T, X] = ['r', 'c', 't', 'x'];
const NOW = new Date('2026-06-01T00:00:00Z');
const FUTURE = new Date(NOW.getTime() + 86_400_000);
const PAST = new Date(NOW.getTime() - 1000);
const mk = (status: IntroStatus, o: Partial<IntroParties> = {}): IntroParties => ({
  requesterId: R, connectorId: C, targetId: T, status, expiresAt: FUTURE,
  connectorAcceptedAt: status === 'pending_connector' ? null : NOW, ...o,
});
const ACTIONS: IntroAction[] = ['connector_accept', 'connector_decline', 'target_accept', 'target_decline', 'requester_cancel'];
const STATUSES: IntroStatus[] = ['pending_connector', 'pending_target', 'accepted', 'declined', 'cancelled', 'expired'];
const ACTOR_FOR: Record<string, string> = { connector_accept: C, connector_decline: C, target_accept: T, target_decline: T, requester_cancel: R };
const LEGAL: Record<string, [IntroStatus, IntroStatus]> = {
  connector_accept: ['pending_connector', 'pending_target'], connector_decline: ['pending_connector', 'declined'],
  target_accept: ['pending_target', 'accepted'], target_decline: ['pending_target', 'declined'],
};

test('every (status, action) pair: legal ones succeed for the right actor, all others fail closed', () => {
  for (const st of STATUSES) for (const a of ACTIONS) {
    const r = decide(mk(st), a, ACTOR_FOR[a]!, NOW);
    const legal = a === 'requester_cancel' ? isOpen(st) : LEGAL[a]![0] === st;
    if (legal) {
      assert.ok(r.ok, `${st}/${a}`);
      if (r.ok) assert.equal(r.to, a === 'requester_cancel' ? 'cancelled' : LEGAL[a]![1]);
    } else {
      const targetBlind = st === 'pending_connector' && ACTOR_FOR[a] === T; // target cannot see the request yet
      assert.deepEqual(r, { ok: false, code: targetBlind ? 'NOT_FOUND' : 'INVALID_STATE' }, `${st}/${a}`);
    }
  }
});

test('terminal states accept nothing', () => {
  for (const st of ['accepted', 'declined', 'cancelled', 'expired'] as const) for (const a of ACTIONS) assert.equal(decide(mk(st), a, ACTOR_FOR[a]!, NOW).ok, false);
});

test('strangers get NOT_FOUND for every action and status (existence is never revealed)', () => {
  for (const st of STATUSES) for (const a of ACTIONS) assert.deepEqual(decide(mk(st), a, X, NOW), { ok: false, code: 'NOT_FOUND' });
  for (const a of ACTIONS) assert.deepEqual(decide(mk('pending_target'), a, null, NOW), { ok: false, code: 'NOT_FOUND' });
});

test('target is invisible until the connector accepts', () => {
  assert.equal(canSee(mk('pending_connector'), T), false);
  for (const a of ACTIONS) assert.deepEqual(decide(mk('pending_connector'), a, T, NOW), { ok: false, code: 'NOT_FOUND' });
  assert.equal(canSee(mk('pending_target'), T), true);
  assert.equal(canSee(mk('declined', { connectorAcceptedAt: null }), T), false, 'declined by connector: target never learns');
});

test('participants acting outside their role get FORBIDDEN', () => {
  assert.deepEqual(decide(mk('pending_connector'), 'connector_accept', R, NOW), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(decide(mk('pending_target'), 'target_accept', C, NOW), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(decide(mk('pending_target'), 'requester_cancel', C, NOW), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(decide(mk('pending_connector'), 'connector_accept', T, NOW), { ok: false, code: 'NOT_FOUND' });
});

test('expiry: boundary is inclusive, actions on due requests report EXPIRED, only the system may expire', () => {
  assert.deepEqual(decide(mk('pending_connector', { expiresAt: NOW }), 'connector_accept', C, NOW), { ok: false, code: 'EXPIRED' });
  assert.deepEqual(decide(mk('pending_target', { expiresAt: PAST }), 'target_accept', T, NOW), { ok: false, code: 'EXPIRED' });
  assert.equal(decide(mk('pending_connector', { expiresAt: new Date(NOW.getTime() + 1) }), 'connector_accept', C, NOW).ok, true);
  assert.deepEqual(decide(mk('pending_connector'), 'expire', null, NOW), { ok: false, code: 'INVALID_STATE' }, 'not due yet');
  assert.equal(decide(mk('pending_connector', { expiresAt: NOW }), 'expire', null, NOW).ok, true);
  assert.deepEqual(decide(mk('pending_connector', { expiresAt: PAST }), 'expire', C, NOW), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(decide(mk('accepted', { expiresAt: PAST }), 'expire', null, NOW), { ok: false, code: 'INVALID_STATE' });
});

test('notifications go to the right people and never to the target before consent is sought', () => {
  const n = (st: IntroStatus, a: IntroAction) => { const r = decide(mk(st), a, a === 'expire' ? null : ACTOR_FOR[a]!, NOW); assert.ok(r.ok); return r.ok ? r.notices : []; };
  assert.deepEqual(n('pending_connector', 'connector_accept'), [{ recipientId: T, event: 'introduction_consent_needed' }]);
  assert.deepEqual(n('pending_connector', 'connector_decline'), [{ recipientId: R, event: 'introduction_declined' }]);
  assert.deepEqual(n('pending_target', 'target_decline'), [{ recipientId: R, event: 'introduction_declined' }]);
  assert.deepEqual(n('pending_target', 'target_accept').map((x) => x.recipientId).sort(), [C, R]);
  assert.deepEqual(n('pending_connector', 'requester_cancel'), [{ recipientId: C, event: 'introduction_cancelled' }], 'target not told: they never knew');
  assert.deepEqual(n('pending_target', 'requester_cancel'), [{ recipientId: T, event: 'introduction_cancelled' }]);
});
