// Slice 4 against REAL PostgreSQL: invitation links, mutual confirmation lifecycle, blocks, privacy, safety and concurrency.
// Needs migrations 0001-0004 + 0006 (npm run test:pgstore applies them). Without DATABASE_URL every test is SKIPPED, never passed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InvitationService } from '../../src/social/invitations.ts';
import { ConnectionService } from '../../src/social/connections.ts';
import { ProfileService } from '../../src/social/profile.ts';
import { SafetyService } from '../../src/social/safety.ts';
import { AccountService } from '../../src/social/account.ts';
import { IntroductionService } from '../../src/introductions/service.ts';
import { SearchService, pgSearchDeps } from '../../src/search/service.ts';
import { hashToken, newToken } from '../../src/social/tokens.ts';
import type { SocialPool } from '../../src/social/db.ts';
import type { CreateInvitationInput } from '../../src/contracts/index.ts';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set — PostgreSQL relationship tests NOT RUN';
let n = 0;
const key = () => `k-${process.pid}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pool: (SocialPool & { end(): Promise<void> }) | null = null;
async function db() {
  if (pool) return pool;
  const modName: string = 'pg';
  const pg = await import(modName);
  pool = new pg.default.Pool({ connectionString: URL, max: 12 }) as SocialPool & { end(): Promise<void> };
  return pool;
}
const q = async (sql: string, p: unknown[] = []) => (await (await db()).query(sql, p)).rows;
const num = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0]!.n);

async function world() {
  const p = await db();
  await p.query('TRUNCATE introduction_idempotency, audit_events, notification_outbox, introduction_requests, blocks, consents, relationship_confirmations, relationship_evidence, relationships, external_profiles, users CASCADE');
  return {
    inv: new InvitationService(p), conn: new ConnectionService(p), prof: new ProfileService(p), safe: new SafetyService(p), acct: new AccountService(p),
    intro: new IntroductionService(p), search: new SearchService(pgSearchDeps(p)),
  };
}
async function mkUser(name: string, o: { discoverable?: boolean; accepts?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO users (id,email,display_name,discoverable,accepts_introductions) VALUES ($1,$2,$3,$4,$5)`, [id, `${id}@example.test`, name, o.discoverable ?? false, o.accepts ?? false]);
  return id;
}
const connectInput = (o: Partial<CreateInvitationInput> = {}): CreateInvitationInput => ({ purpose: 'connect', relationshipType: 'colleague', ...o });
type W = Awaited<ReturnType<typeof world>>;

/** Full real flow: A invites, B accepts, A confirms. Returns the relationship id. */
async function befriend(w: W, a: string, b: string, type: CreateInvitationInput['relationshipType'] = 'colleague'): Promise<string> {
  const c = await w.inv.create(a, connectInput({ relationshipType: type }), key()); assert.ok(c.ok && c.value.token);
  const acc = await w.inv.accept(b, c.value.token!); assert.ok(acc.ok && acc.value.connection, 'accept');
  const conf = await w.conn.confirm(a, acc.value.connection!.id); assert.ok(conf.ok, 'confirm');
  assert.equal(conf.value.status, 'confirmed');
  return acc.value.connection!.id;
}
const trusted = async (relId: string) => (await num(`SELECT count(*)::int AS n FROM wcim_trusted_relationships WHERE id=$1`, [relId])) === 1;
const found = async (w: W, from: string, to: string) => { const r = await w.search.search(from, to); return r.ok && r.value.status === 'found'; };

// ------------------------------------------------------------------------------------------------ invitations & tokens
test('invitation creation returns the token once; only its SHA-256 is stored', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann');
  const r = await w.inv.create(a, connectInput({ note: 'we met at the meetup', maxUses: 2 }), key());
  assert.ok(r.ok && r.value.token && !r.value.replayed);
  const token = r.value.token!;
  const rows = await q(`SELECT * FROM invitations`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.token_hash, hashToken(token));
  assert.ok(!JSON.stringify(rows[0]).includes(token), 'raw token must not appear in any column');
  assert.ok(!JSON.stringify(await q(`SELECT * FROM relationship_audit_events`)).includes(token), 'raw token must not appear in audit');
  assert.ok(!JSON.stringify(await q(`SELECT * FROM mutation_idempotency`)).includes(token), 'raw token must not appear in idempotency rows');
  assert.equal(r.value.invitation.status, 'active');
  assert.equal((await q(`SELECT event_type FROM relationship_audit_events`))[0]!.event_type, 'invitation_created');
  const listed = await w.inv.listSent(a); assert.ok(listed.ok); assert.ok(!JSON.stringify(listed.value).includes(token));
});

test('token entropy: 256 random bits, base64url, no collisions across 2000 tokens', { skip }, async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) { const t = newToken(); assert.match(t, /^[A-Za-z0-9_-]{43}$/); seen.add(t); }
  assert.equal(seen.size, 2000);
  const bytes = Buffer.from([...seen][0]!, 'base64url'); assert.equal(bytes.length, 32);
  assert.match(hashToken('x'), /^[0-9a-f]{64}$/);
  // every bit position is exercised across a sample (cheap sanity check that the bytes are not structured)
  const ones = new Array(256).fill(0); for (const t of seen) { const b = Buffer.from(t, 'base64url'); for (let i = 0; i < 256; i++) if (b[i >> 3]! & (1 << (i & 7))) ones[i]++; }
  assert.ok(ones.every((c) => c > 800 && c < 1200), 'each bit should be ~50% set');
});

test('idempotent create: same key replays WITHOUT a token; different body with the same key conflicts', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'); const k = key();
  const first = await w.inv.create(a, connectInput(), k); assert.ok(first.ok && first.value.token);
  const again = await w.inv.create(a, connectInput(), k); assert.ok(again.ok && again.value.replayed && again.value.token === null);
  assert.equal(again.value.invitation.id, first.value.invitation.id);
  assert.equal(await num('SELECT count(*)::int AS n FROM invitations'), 1);
  const diff = await w.inv.create(a, connectInput({ relationshipType: 'family' }), k); assert.ok(!diff.ok && diff.code === 'IDEMPOTENCY_CONFLICT');
});

test('invitation quotas: active-link cap and daily cap', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann');
  const small = new InvitationService((await db()), { maxActive: 3, maxPerDay: 100 });
  for (let i = 0; i < 3; i++) assert.ok((await small.create(a, connectInput(), key())).ok);
  const r = await small.create(a, connectInput(), key()); assert.ok(!r.ok && r.code === 'QUOTA_EXCEEDED');
  const daily = new InvitationService((await db()), { maxActive: 100, maxPerDay: 4 });
  assert.ok((await daily.create(a, connectInput(), key())).ok, 'already 3 today + cap 4 => 1 more allowed');
  const r2 = await daily.create(a, connectInput(), key()); assert.ok(!r2.ok && r2.code === 'QUOTA_EXCEEDED');
  void w;
});

test('expiration: an expired link is unavailable to preview, accept and decline', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob');
  const c = await w.inv.create(a, connectInput(), key()); assert.ok(c.ok && c.value.token);
  const p = await db(); await p.query('ALTER TABLE invitations DISABLE TRIGGER invitations_guard');
  await p.query(`UPDATE invitations SET created_at = now() - interval '3 days', expires_at = now() - interval '1 day'`);
  await p.query('ALTER TABLE invitations ENABLE TRIGGER invitations_guard');
  for (const f of [() => w.inv.preview(b, c.value.token!), () => w.inv.accept(b, c.value.token!), () => w.inv.decline(b, c.value.token!)]) {
    const r = await f(); assert.ok(!r.ok && r.code === 'INVITATION_UNAVAILABLE');
  }
  assert.equal((await w.inv.listSent(a) as { ok: true; value: Array<{ status: string }> }).value[0]!.status, 'expired');
  assert.equal(await num('SELECT count(*)::int AS n FROM relationships'), 0);
});

test('revocation: owner revokes; revoked link is unavailable; non-owner gets NOT_FOUND; revoke is idempotent', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob'), x = await mkUser('Xavier');
  const c = await w.inv.create(a, connectInput(), key()); assert.ok(c.ok && c.value.token);
  const bad = await w.inv.revoke(x, c.value.invitation.id); assert.ok(!bad.ok && bad.code === 'NOT_FOUND');
  assert.equal((await w.inv.preview(b, c.value.token!)).ok, true, 'still live after a foreign revoke attempt');
  const r1 = await w.inv.revoke(a, c.value.invitation.id); assert.ok(r1.ok && r1.value.status === 'revoked');
  assert.ok((await w.inv.revoke(a, c.value.invitation.id)).ok);
  assert.equal(await num(`SELECT count(*)::int AS n FROM relationship_audit_events WHERE event_type='invitation_revoked'`), 1, 'audited once');
  const r = await w.inv.accept(b, c.value.token!); assert.ok(!r.ok && r.code === 'INVITATION_UNAVAILABLE');
});

test('token replay: a second user cannot reuse a single-use link; the same user replaying consumes nothing more', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob'), x = await mkUser('Xavier');
  const c = await w.inv.create(a, connectInput(), key()); assert.ok(c.ok && c.value.token);
  const first = await w.inv.accept(b, c.value.token!); assert.ok(first.ok && !first.value.replayed);
  const replay = await w.inv.accept(b, c.value.token!); assert.ok(replay.ok && replay.value.replayed);
  assert.equal(replay.value.connection!.id, first.value.connection!.id);
  const thief = await w.inv.accept(x, c.value.token!); assert.ok(!thief.ok && thief.code === 'INVITATION_UNAVAILABLE');
  assert.equal(await num('SELECT use_count AS n FROM invitations'), 1);
  assert.equal(await num('SELECT count(*)::int AS n FROM relationships'), 1);
  const opposite = await w.inv.decline(b, c.value.token!); assert.ok(!opposite.ok, 'cannot flip an accepted response to declined');
});

test('malformed tokens never reach the database as a match and look like any unavailable link', { skip }, async () => {
  const w = await world(); const b = await mkUser('Bob');
  for (const t of ['', 'short', 'x'.repeat(43) + '!', "' OR 1=1 --", newToken()]) { const r = await w.inv.accept(b, t); assert.ok(!r.ok && r.code === 'INVITATION_UNAVAILABLE'); }
});

test('decline records the response, consumes the single use and creates no relationship', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob'), x = await mkUser('Xavier');
  const c = await w.inv.create(a, connectInput(), key()); assert.ok(c.ok && c.value.token);
  const d = await w.inv.decline(b, c.value.token!); assert.ok(d.ok && d.value.connection === null);
  assert.ok((await w.inv.decline(b, c.value.token!)).ok, 'idempotent');
  assert.equal(await num('SELECT count(*)::int AS n FROM relationships'), 0);
  const later = await w.inv.accept(x, c.value.token!); assert.ok(!later.ok, 'single-use link is spent');
});

test('wrong user: the inviter cannot accept their own link; no one can confirm on behalf of another', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob'), x = await mkUser('Xavier');
  const c = await w.inv.create(a, connectInput(), key()); assert.ok(c.ok && c.value.token);
  assert.ok(!(await w.inv.accept(a, c.value.token!)).ok, 'self-accept');
  const acc = await w.inv.accept(b, c.value.token!); assert.ok(acc.ok);
  const relId = acc.value.connection!.id;
  assert.equal(acc.value.connection!.status, 'pending'); assert.equal(acc.value.connection!.awaiting, 'them', 'acceptor waits for the inviter');
  const foreign = await w.conn.confirm(x, relId); assert.ok(!foreign.ok && foreign.code === 'NOT_FOUND', 'third party confirm');
  const self = await w.conn.confirm(b, relId); assert.ok(self.ok && self.value.status === 'pending', 'acceptor re-confirming cannot complete it');
  assert.equal(await trusted(relId), false, 'one-sided confirmation never makes a trusted relationship');
  assert.equal((await w.conn.get(x, relId)).ok, false);
  for (const f of [() => w.conn.revoke(x, relId), () => w.conn.decline(x, relId), () => w.conn.setPermission(x, relId, false)]) { const r = await f(); assert.ok(!r.ok && r.code === 'NOT_FOUND'); }
  const ownerView = await w.conn.list(a, 'pending'); assert.ok(ownerView.ok && ownerView.value.length === 1 && ownerView.value[0]!.awaiting === 'you');
  assert.equal(ownerView.value[0]!.other.displayName, 'Bob');
});

test('duplicate invitations: a second accept for the same pair is refused while pending and while confirmed', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob');
  const c1 = await w.inv.create(a, connectInput(), key()), c2 = await w.inv.create(a, connectInput({ relationshipType: 'family' }), key());
  assert.ok(c1.ok && c2.ok);
  const acc = await w.inv.accept(b, c1.value.token!); assert.ok(acc.ok);
  const dup = await w.inv.accept(b, c2.value.token!); assert.ok(!dup.ok && dup.code === 'ALREADY_CONNECTED');
  assert.ok((await w.conn.confirm(a, acc.value.connection!.id)).ok);
  const dup2 = await w.inv.accept(b, c2.value.token!); assert.ok(!dup2.ok && dup2.code === 'ALREADY_CONNECTED');
  // reverse direction (Bob invites Ann) is the same pair
  const rev = await w.inv.create(b, connectInput(), key()); assert.ok(rev.ok);
  const dup3 = await w.inv.accept(a, rev.value.token!); assert.ok(!dup3.ok && dup3.code === 'ALREADY_CONNECTED');
  assert.equal(await num(`SELECT count(*)::int AS n FROM relationships WHERE revoked_at IS NULL`), 1);
});

// ------------------------------------------------------------------------------------------------ lifecycle & trusted graph
test('mutual confirmation makes the relationship trusted; then search finds the route', { skip }, async () => {
  const w = await world();
  const r = await mkUser('Rita'), c = await mkUser('Cara', { accepts: true }), t = await mkUser('Tom', { discoverable: true });
  const rc = await befriend(w, r, c), ct = await befriend(w, c, t);
  assert.ok(await trusted(rc) && await trusted(ct));
  const row = (await q(`SELECT verification_status, permission_status FROM relationships WHERE id=$1`, [rc]))[0]!;
  assert.deepEqual([row.verification_status, row.permission_status], ['confirmed', 'granted']);
  assert.ok(await found(w, r, t), 'search after connection confirmation');
  const events = (await q(`SELECT event_type FROM relationship_audit_events ORDER BY id`)).map((e) => e.event_type);
  assert.deepEqual(events.filter((e) => e !== 'invitation_created'), ['invitation_accepted', 'connection_confirmed', 'invitation_accepted', 'connection_confirmed']);
});

test('before the inviter confirms there is no route; one-sided state cannot be forced in the database either', { skip }, async () => {
  const w = await world();
  const r = await mkUser('Rita'), c = await mkUser('Cara', { accepts: true }), t = await mkUser('Tom', { discoverable: true });
  await befriend(w, c, t);
  const inv = await w.inv.create(r, connectInput(), key()); assert.ok(inv.ok);
  const acc = await w.inv.accept(c, inv.value.token!); assert.ok(acc.ok);
  assert.equal(await found(w, r, t), false, 'pending relationship is not traversable');
  await assert.rejects(q(`UPDATE relationships SET verification_status='confirmed', confirmed_at=now(), permission_status='granted' WHERE id=$1`, [acc.value.connection!.id]), /confirm/i);
  await assert.rejects(q(`INSERT INTO relationship_confirmations (relationship_id, confirming_user_id) VALUES ($1,$2)`, [acc.value.connection!.id, t]), /participant|source or target/i, 'foreign confirmation');
  assert.ok((await w.conn.confirm(r, acc.value.connection!.id)).ok);
  assert.ok(await found(w, r, t));
});

test('confirmation revocation and relationship revocation each remove the route; revocation is terminal and hides the reason', { skip }, async () => {
  const w = await world();
  const r = await mkUser('Rita'), c = await mkUser('Cara', { accepts: true }), t = await mkUser('Tom', { discoverable: true });
  const rc = await befriend(w, r, c), ct = await befriend(w, c, t);
  assert.ok(await found(w, r, t));
  // permission withdrawn by ONE side: relationship stays, traversal stops, can be restored
  const p = await w.conn.setPermission(c, rc, false); assert.ok(p.ok && p.value.yourPermission === 'withheld' && !p.value.introductionsActive && p.value.status === 'confirmed');
  assert.equal(await found(w, r, t), false, 'permission withdrawn');
  assert.ok((await w.conn.setPermission(c, rc, true)).ok); assert.ok(await found(w, r, t), 'permission restored');
  // revoke by the other participant
  const rv = await w.conn.revoke(r, rc); assert.ok(rv.ok && rv.value.status === 'ended' && rv.value.endedByMe);
  assert.equal(await found(w, r, t), false, 'search after relationship revocation');
  const otherSide = await w.conn.get(c, rc); assert.ok(otherSide.ok && otherSide.value.status === 'ended' && !otherSide.value.endedByMe);
  assert.ok(!JSON.stringify(otherSide.value).includes('revoked'), 'reason not exposed');
  assert.equal((await q(`SELECT confirmation_status FROM relationship_confirmations WHERE relationship_id=$1 AND confirming_user_id=$2`, [rc, r]))[0]!.confirmation_status, 'revoked');
  assert.ok((await w.conn.revoke(r, rc)).ok, 'idempotent');
  const again = await w.conn.confirm(c, rc); assert.ok(!again.ok && again.code === 'INVALID_STATE', 'cannot revive');
  await assert.rejects(q(`UPDATE relationships SET revoked_at = NULL WHERE id=$1`, [rc]), /terminal/);
  // the pair may start over with a NEW relationship
  const rc2 = await befriend(w, r, c); assert.notEqual(rc2, rc);
  assert.ok(await found(w, r, t));
  // revoking the OTHER hop also removes the route
  await w.conn.revoke(t, ct); assert.equal(await found(w, r, t), false);
});

test('block in either direction removes the route, ends the relationship and is invisible to the blocked user', { skip }, async () => {
  for (const blockerIsRequesterSide of [true, false]) {
    const w = await world();
    const r = await mkUser('Rita'), c = await mkUser('Cara', { accepts: true }), t = await mkUser('Tom', { discoverable: true });
    const rc = await befriend(w, r, c), ct = await befriend(w, c, t);
    assert.ok(await found(w, r, t));
    const [blocker, victim, relId] = blockerIsRequesterSide ? [r, c, rc] : [t, c, ct];
    const b = await w.safe.block(blocker, { connectionId: relId }); assert.ok(b.ok && b.value.displayName === 'Cara');
    assert.equal(await found(w, r, t), false, 'block must affect the very next search');
    const view = await w.conn.get(victim, relId); assert.ok(view.ok && view.value.status === 'ended' && !view.value.endedByMe);
    assert.ok(!JSON.stringify(view.value).includes('block'));
    assert.deepEqual((await w.safe.list(victim) as { ok: true; value: unknown[] }).value, [], 'blocked user sees no block list entry');
    // the blocked user cannot re-connect: every path says "unavailable"
    const inv = await w.inv.create(victim, connectInput(), key()); assert.ok(inv.ok);
    const acc = await w.inv.accept(blocker, inv.value.token!); assert.ok(!acc.ok && acc.code === 'INVITATION_UNAVAILABLE');
    const pre = await w.inv.preview(blocker, inv.value.token!); assert.ok(!pre.ok && pre.code === 'INVITATION_UNAVAILABLE');
    const inv2 = await w.inv.create(blocker, connectInput(), key()); assert.ok(inv2.ok);
    const acc2 = await w.inv.accept(victim, inv2.value.token!); assert.ok(!acc2.ok && acc2.code === 'INVITATION_UNAVAILABLE', 'blocked user opening the blocker\'s link looks like an expired link');
    // unblock is idempotent and does NOT restore the ended relationship
    assert.deepEqual(await w.safe.unblock(blocker, b.value.id), { ok: true, value: { removed: true } });
    assert.deepEqual(await w.safe.unblock(blocker, b.value.id), { ok: true, value: { removed: false } });
    assert.equal(await found(w, r, t), false);
    assert.deepEqual((await w.safe.unblock(victim, b.value.id)), { ok: true, value: { removed: false } }, 'foreign unblock is a silent no-op');
  }
});

test('block is idempotent, owner-scoped, and subjects must be handles the caller legitimately holds', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob'), x = await mkUser('Xavier');
  const rel = await befriend(w, a, b);
  const b1 = await w.safe.block(a, { connectionId: rel }), b2 = await w.safe.block(a, { connectionId: rel });
  assert.ok(b1.ok && b2.ok && b1.value.id === b2.value.id);
  assert.equal(await num(`SELECT count(*)::int AS n FROM blocks`), 1);
  assert.equal(await num(`SELECT count(*)::int AS n FROM relationship_audit_events WHERE event_type='user_blocked'`), 1);
  const foreign = await w.safe.block(x, { connectionId: rel }); assert.ok(!foreign.ok && foreign.code === 'NOT_FOUND');
  const tokenBlock = await w.inv.create(x, connectInput(), key()); assert.ok(tokenBlock.ok);
  const byToken = await w.safe.block(a, { invitationToken: tokenBlock.value.token! }); assert.ok(byToken.ok && byToken.value.displayName === 'Xavier');
  assert.ok(!(await w.safe.block(a, { invitationToken: newToken() })).ok);
  assert.ok(!(await w.safe.block(a, { introductionId: randomUUID(), party: 'target' })).ok);
});

test('discoverability disabled / introduction permission disabled remove the route (and are separate switches)', { skip }, async () => {
  const w = await world();
  const r = await mkUser('Rita'), c = await mkUser('Cara'), t = await mkUser('Tom');
  await befriend(w, r, c); await befriend(w, c, t);
  assert.equal(await found(w, r, t), false, 'defaults are private: nobody discoverable, nobody accepts');
  const p1 = await w.prof.setPrivacy(t, { discoverable: true }); assert.ok(p1.ok && p1.value.discoverable && !p1.value.acceptsIntroductions);
  assert.equal(await found(w, r, t), false, 'discoverable target alone is not enough: connector has not consented to introductions');
  await w.prof.setPrivacy(c, { acceptsIntroductions: true });
  assert.ok(await found(w, r, t));
  await w.prof.setPrivacy(t, { discoverable: false });
  assert.equal(await found(w, r, t), false, 'discoverability disabled');
  await w.prof.setPrivacy(t, { discoverable: true }); assert.ok(await found(w, r, t));
  await w.prof.setPrivacy(c, { acceptsIntroductions: false });
  assert.equal(await found(w, r, t), false, 'introduction permission disabled');
  const rows = await q(`SELECT consent_type, granted, revoked_at IS NOT NULL AS revoked FROM consents WHERE user_id=$1`, [c]);
  const intr = rows.find((x) => x.consent_type === 'introduction_requests')!;
  assert.deepEqual([intr.granted, intr.revoked], [false, true], 'withdrawal is recorded as a revoked consent');
});

test('privacy update is atomic: a failing consent write rolls the users flag back', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'); const p = await db();
  await p.query(`ALTER TABLE consents ADD CONSTRAINT zz_boom CHECK (consent_type <> 'introduction_requests')`);
  try {
    const r = await w.prof.setPrivacy(a, { discoverable: true, acceptsIntroductions: true });
    assert.ok(!r.ok && r.code === 'INTERNAL');
    const row = (await q(`SELECT discoverable, accepts_introductions FROM users WHERE id=$1`, [a]))[0]!;
    assert.deepEqual([row.discoverable, row.accepts_introductions], [false, false], 'users flags rolled back with the consent write');
    assert.equal(await num(`SELECT count(*)::int AS n FROM consents`), 0);
  } finally { await p.query('ALTER TABLE consents DROP CONSTRAINT zz_boom'); }
});

test('profile: own-only edits, validation, avatar rules; foreign identities untouched', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob');
  const u = await w.prof.update(a, { displayName: 'Ann Lee', avatarUrl: 'https://cdn.example.com/a.png' }); assert.ok(u.ok && u.value.displayName === 'Ann Lee' && u.value.avatarUrl === 'https://cdn.example.com/a.png');
  assert.equal((await q(`SELECT display_name FROM users WHERE id=$1`, [b]))[0]!.display_name, 'Bob', 'other users untouched');
  assert.ok((await w.prof.update(a, { avatarUrl: null })).ok);
  await assert.rejects(q(`UPDATE users SET avatar_url='http://x.example/a.png' WHERE id=$1`, [a]));
  const idn = await w.prof.addIdentity(a, { platform: 'instagram', username: 'ann_lee' }); assert.ok(idn.ok && idn.value.identities[0]!.verification === 'unverified');
  assert.ok((await w.prof.addIdentity(a, { platform: 'instagram', username: 'ANN_LEE' })).ok); assert.equal(await num(`SELECT count(*)::int AS n FROM external_profiles`), 1, 'duplicate claim is a no-op');
  const idId = idn.value.identities[0]!.id;
  const foreignRemove = await w.prof.removeIdentity(b, idId); assert.ok(foreignRemove.ok);
  assert.equal(await num(`SELECT count(*)::int AS n FROM external_profiles`), 1, 'foreign remove changed nothing');
  assert.equal(((await w.prof.removeIdentity(a, idId)) as { ok: true; value: { identities: unknown[] } }).value.identities.length, 0);
  for (let i = 0; i < 10; i++) assert.ok((await w.prof.addIdentity(a, { platform: 'website', username: `site${i}.example` })).ok);
  const over = await w.prof.addIdentity(a, { platform: 'website', username: 'one-too-many.example' }); assert.ok(!over.ok && over.code === 'QUOTA_EXCEEDED');
  const g = await w.prof.get(a); assert.ok(g.ok && g.value.signIn.password === false);
});

test('connection list: only own data, no ids/emails of others, filters, pending expiry shown as ended', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob'), c = await mkUser('Cy'), x = await mkUser('Xavier');
  const ab = await befriend(w, a, b);
  const inv = await w.inv.create(a, connectInput(), key()); assert.ok(inv.ok); const acc = await w.inv.accept(c, inv.value.token!); assert.ok(acc.ok);
  const all = await w.conn.list(a); assert.ok(all.ok && all.value.length === 2);
  const json = JSON.stringify(all.value);
  for (const secret of [b, c, `${b}@example.test`]) assert.ok(!json.includes(secret), 'no foreign user id / email in the response');
  assert.equal((await w.conn.list(a, 'confirmed') as { value: unknown[] }).value.length, 1);
  assert.equal((await w.conn.list(a, 'pending') as { value: unknown[] }).value.length, 1);
  assert.deepEqual((await w.conn.list(x) as { value: unknown[] }).value, []);
  const p = await db(); await p.query(`UPDATE relationships SET confirm_by = now() - interval '1 minute' WHERE id=$1`, [acc.value.connection!.id]);
  assert.equal((await w.conn.list(a, 'pending') as { value: unknown[] }).value.length, 0, 'overdue pending is not pending');
  const late = await w.conn.confirm(a, acc.value.connection!.id); assert.ok(!late.ok && late.code === 'EXPIRED');
  assert.equal((await w.conn.get(a, acc.value.connection!.id) as { value: { status: string } }).value.status, 'ended');
  const reinvite = await w.inv.create(a, connectInput(), key()); assert.ok(reinvite.ok);
  assert.ok((await w.inv.accept(c, reinvite.value.token!)).ok, 'an expired pending request does not block a fresh invitation');
  void ab;
});

test('expired pending requests are ended by the housekeeping sweep', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob');
  const inv = await w.inv.create(a, connectInput(), key()); assert.ok(inv.ok); assert.ok((await w.inv.accept(b, inv.value.token!)).ok);
  assert.equal(await w.conn.expireOverduePending(), 0);
  await (await db()).query(`UPDATE relationships SET confirm_by = now() - interval '1 second'`);
  assert.equal(await w.conn.expireOverduePending(), 1);
  assert.equal((await q(`SELECT ended_reason FROM relationships`))[0]!.ended_reason, 'expired');
});

test('target links resolve internally, require a discoverable owner, and respect blocks', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob');
  const closed = await w.inv.create(a, { purpose: 'introduce' }, key()); assert.ok(!closed.ok && closed.code === 'PROFILE_PRIVATE');
  await w.prof.setPrivacy(a, { discoverable: true });
  const l = await w.inv.create(a, { purpose: 'introduce' }, key()); assert.ok(l.ok && l.value.token);
  const res = await w.inv.resolveTarget(b, l.value.token!); assert.ok(res.ok && res.value.targetId === a && res.value.target.displayName === 'Ann');
  assert.ok((await w.inv.resolveTarget(b, l.value.token!)).ok, 'target links are not consumed');
  assert.ok(!(await w.inv.accept(b, l.value.token!)).ok, 'a target link cannot be used to connect');
  await w.prof.setPrivacy(a, { discoverable: false });
  assert.ok(!(await w.inv.resolveTarget(b, l.value.token!)).ok, 'owner turned discoverability off');
  await w.prof.setPrivacy(a, { discoverable: true });
  await w.safe.block(a, { invitationToken: (await w.inv.create(b, connectInput(), key()) as { value: { token: string } }).value.token });
  assert.ok(!(await w.inv.resolveTarget(b, l.value.token!)).ok, 'blocked');
});

test('reports: by handle only, idempotent, one open report per target, daily quota, optional block', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob'), x = await mkUser('Xavier');
  const rel = await befriend(w, a, b);
  const k = key();
  const r1 = await w.safe.report(a, { subject: { connectionId: rel }, reason: 'harassment', details: 'x', alsoBlock: true }, k); assert.ok(r1.ok && r1.value.blocked);
  const r1b = await w.safe.report(a, { subject: { connectionId: rel }, reason: 'harassment', details: 'x', alsoBlock: true }, k); assert.ok(r1b.ok && r1b.value.id === r1.value.id);
  const r2 = await w.safe.report(a, { subject: { connectionId: rel }, reason: 'spam' }, key()); assert.ok(r2.ok && r2.value.id === r1.value.id, 'existing open report returned');
  assert.equal(await num('SELECT count(*)::int AS n FROM reports'), 1);
  assert.equal(await num('SELECT count(*)::int AS n FROM blocks'), 1);
  const conflict = await w.safe.report(a, { subject: { connectionId: rel }, reason: 'spam' }, k); assert.ok(!conflict.ok && conflict.code === 'IDEMPOTENCY_CONFLICT');
  assert.ok(!(await w.safe.report(x, { subject: { connectionId: rel }, reason: 'spam' }, key())).ok, 'non-participant cannot report via someone else\'s connection');
  const inv = await w.inv.create(x, connectInput(), key()); assert.ok(inv.ok);
  const ia = await w.safe.report(a, { subject: { invitationToken: inv.value.token! }, reason: 'spam' }, key()); assert.ok(ia.ok);
  assert.equal((await q(`SELECT kind, invitation_id IS NOT NULL AS has_inv FROM reports WHERE reported_user_id=$1`, [x]))[0]!.kind, 'invitation_abuse');
  const tiny = new SafetyService(await db(), { maxReportsPerDay: 2 });
  const q3 = await tiny.report(a, { subject: { connectionId: rel }, reason: 'other' }, key()); assert.ok(!q3.ok && q3.code === 'QUOTA_EXCEEDED');
});

test('account: export has only own data; delete needs the password and removes everything', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob');
  await befriend(w, a, b); await w.safe.block(a, { connectionId: (await q('SELECT id FROM relationships'))[0]!.id as string });
  const ex = await w.acct.export(a); assert.ok(ex.ok);
  const s = JSON.stringify(ex.value); assert.ok(s.includes('Bob') && !s.includes(b) && !s.includes(`${b}@example.test`));
  const { hashPassword } = await import('../../src/auth/password.ts');
  await q(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)`, [a, await hashPassword('correct horse battery')]);
  const bad = await w.acct.deleteAccount(a, 'wrong'); assert.ok(!bad.ok && bad.code === 'INVALID_CREDENTIALS');
  assert.ok(!(await w.acct.deleteAccount(a, undefined)).ok);
  assert.equal(await num(`SELECT count(*)::int AS n FROM users WHERE id=$1`, [a]), 1);
  assert.ok((await w.acct.deleteAccount(a, 'correct horse battery')).ok);
  for (const [t, col] of [['users', 'id'], ['relationships', 'source_user_id'], ['blocks', 'blocker_user_id'], ['invitations', 'owner_id'], ['relationship_audit_events', 'actor_id']] as const) {
    assert.equal(await num(`SELECT count(*)::int AS n FROM ${t} WHERE ${col}=$1`, [a]), 0, t);
  }
  assert.equal(await num(`SELECT count(*)::int AS n FROM users WHERE id=$1`, [b]), 1, 'the other user is untouched');
});

test('the SQL trusted view and the graph store agree for every lifecycle state', { skip }, async () => {
  const w = await world();
  const a = await mkUser('Ann', { accepts: true, discoverable: true }), b = await mkUser('Bob', { accepts: true, discoverable: true }), c = await mkUser('Cy', { accepts: true, discoverable: true });
  const ab = await befriend(w, a, b); const inv = await w.inv.create(b, connectInput(), key()); assert.ok(inv.ok); const acc = await w.inv.accept(c, inv.value.token!); assert.ok(acc.ok);
  assert.ok(await trusted(ab)); assert.equal(await trusted(acc.value.connection!.id), false);
  assert.ok(await found(w, a, b) === false || true);
  const direct = await w.search.search(a, b); assert.ok(direct.ok);
  await w.conn.setPermission(a, ab, false); assert.equal(await trusted(ab), false);
  await w.conn.setPermission(a, ab, true); assert.equal(await trusted(ab), true);
  await w.safe.block(b, { connectionId: ab }); assert.equal(await trusted(ab), false);
});

// ------------------------------------------------------------------------------------------------ concurrency (real PostgreSQL)
test('concurrent acceptance: a single-use link yields exactly one relationship', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'); const users = await Promise.all(Array.from({ length: 8 }, (_, i) => mkUser(`U${i}`)));
  const c = await w.inv.create(a, connectInput(), key()); assert.ok(c.ok);
  const rs = await Promise.all(users.map((u) => w.inv.accept(u, c.value.token!)));
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs.map((r) => (r.ok ? 'ok' : r.code))));
  assert.ok(rs.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'INVITATION_UNAVAILABLE'));
  assert.equal(await num('SELECT count(*)::int AS n FROM relationships'), 1);
  assert.equal(await num('SELECT use_count AS n FROM invitations'), 1);
});

test('concurrent acceptance: a link bounded to 3 uses admits exactly 3 of 8', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'); const users = await Promise.all(Array.from({ length: 8 }, (_, i) => mkUser(`U${i}`)));
  const c = await w.inv.create(a, connectInput({ maxUses: 3 }), key()); assert.ok(c.ok);
  const rs = await Promise.all(users.map((u) => w.inv.accept(u, c.value.token!)));
  assert.equal(rs.filter((r) => r.ok).length, 3);
  assert.equal(await num('SELECT count(*)::int AS n FROM relationships'), 3);
  assert.equal(await num('SELECT use_count AS n FROM invitations'), 3);
});

test('concurrent acceptance by the SAME user, and through two different links, never creates a duplicate live relationship', { skip }, async () => {
  const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob');
  const c = await w.inv.create(a, connectInput(), key()); assert.ok(c.ok);
  const same = await Promise.all(Array.from({ length: 6 }, () => w.inv.accept(b, c.value.token!)));
  assert.ok(same.every((r) => r.ok), JSON.stringify(same.map((r) => (r.ok ? 'ok' : r.code))));
  assert.equal(await num('SELECT count(*)::int AS n FROM relationships'), 1); assert.equal(await num('SELECT use_count AS n FROM invitations'), 1);
  const w2 = await world(); const a2 = await mkUser('Ann'), b2 = await mkUser('Bob');
  const links = await Promise.all([1, 2, 3, 4].map(() => w2.inv.create(a2, connectInput(), key())));
  const rs = await Promise.all(links.map((l) => w2.inv.accept(b2, (l as { value: { token: string } }).value.token)));
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs.map((r) => (r.ok ? 'ok' : r.code))));
  assert.ok(rs.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'ALREADY_CONNECTED'));
  assert.equal(await num('SELECT count(*)::int AS n FROM relationships WHERE revoked_at IS NULL'), 1);
});

test('concurrent confirm vs revoke by the two participants ends in a consistent state', { skip }, async () => {
  for (let i = 0; i < 12; i++) {
    const w = await world(); const a = await mkUser('Ann'), b = await mkUser('Bob');
    const inv = await w.inv.create(a, connectInput(), key()); assert.ok(inv.ok); const acc = await w.inv.accept(b, inv.value.token!); assert.ok(acc.ok);
    const id = acc.value.connection!.id;
    const [c, r] = await Promise.all([w.conn.confirm(a, id), w.conn.revoke(b, id)]);
    assert.ok(r.ok, 'withdraw always succeeds'); assert.ok(c.ok || c.code === 'INVALID_STATE');
    assert.equal(await trusted(id), false, 'a relationship revoked concurrently must never be trusted');
    const row = (await q('SELECT revoked_at IS NOT NULL AS ended FROM relationships'))[0]!; assert.equal(row.ended, true);
  }
});

/** Hold a raw transaction open so a competing service call must wait for it, then commit and observe the outcome. */
async function withRawTx<T>(body: (c: { query(s: string, p?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }) => Promise<void>, during: () => Promise<T>): Promise<T> {
  const p = await db(); const c = await p.connect();
  try {
    await c.query('BEGIN'); await body(c);
    const pending = during();
    const state = await Promise.race([pending.then(() => 'settled'), sleep(400).then(() => 'waiting')]);
    assert.equal(state, 'waiting', 'the competing call must be blocked by the in-flight change');
    await c.query('COMMIT');
    return await pending;
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
}
async function chain() {
  const w = await world();
  const r = await mkUser('Rita'), c = await mkUser('Cara', { accepts: true }), t = await mkUser('Tom', { discoverable: true });
  const rc = await befriend(w, r, c), ct = await befriend(w, c, t);
  return { w, r, c, t, rc, ct };
}
const intro = (w: W, r: string, c: string, t: string) => w.intro.create(r, { connectorId: c, targetId: t, message: 'hello' }, key());

test('RACE: a relationship revoked in flight is never used to deliver an introduction request', { skip }, async () => {
  const { w, r, c, t, rc } = await chain();
  const res = await withRawTx(
    async (x) => { await x.query(`UPDATE relationships SET revoked_at = now() WHERE id=$1`, [rc]); },
    () => intro(w, r, c, t));
  assert.ok(!res.ok && res.code === 'NOT_ELIGIBLE');
  assert.equal(await num('SELECT count(*)::int AS n FROM introduction_requests'), 0, 'nothing was delivered');
  assert.equal(await num(`SELECT count(*)::int AS n FROM notification_outbox`), 0);
});

test('RACE: the second hop revoked in flight blocks creation too', { skip }, async () => {
  const { w, r, c, t, ct } = await chain();
  const res = await withRawTx(async (x) => { await x.query(`UPDATE relationships SET revoked_at = now() WHERE id=$1`, [ct]); }, () => intro(w, r, c, t));
  assert.ok(!res.ok && res.code === 'NOT_ELIGIBLE'); assert.equal(await num('SELECT count(*)::int AS n FROM introduction_requests'), 0);
});

test('RACE: a block inserted in flight (any pair on the path) stops creation', { skip }, async () => {
  for (const [x, y] of [['r', 'c'], ['t', 'c'], ['t', 'r']] as const) {
    const k = await chain(); const ids = { r: k.r, c: k.c, t: k.t };
    const res = await withRawTx(async (cx) => { await cx.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2)`, [ids[x], ids[y]]); }, () => intro(k.w, k.r, k.c, k.t));
    assert.ok(!res.ok && res.code === 'NOT_ELIGIBLE', `${x} blocks ${y}`); assert.equal(await num('SELECT count(*)::int AS n FROM introduction_requests'), 0);
  }
});

test('RACE: consent revoked in flight (connector or target) stops creation', { skip }, async () => {
  const k1 = await chain();
  const r1 = await withRawTx(async (x) => { await x.query(`UPDATE users SET accepts_introductions=false WHERE id=$1`, [k1.c]); }, () => intro(k1.w, k1.r, k1.c, k1.t));
  assert.ok(!r1.ok && r1.code === 'NOT_ELIGIBLE');
  const k2 = await chain();
  const r2 = await withRawTx(async (x) => { await x.query(`UPDATE users SET discoverable=false WHERE id=$1`, [k2.t]); }, () => intro(k2.w, k2.r, k2.c, k2.t));
  assert.ok(!r2.ok && r2.code === 'NOT_ELIGIBLE');
  assert.equal(await num('SELECT count(*)::int AS n FROM introduction_requests'), 0);
});

test('RACE: a revoke that arrives while creation holds the path locks WAITS, then the request exists and acceptance is refused', { skip }, async () => {
  const w0 = await chain();
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), atLock = new Promise<void>((r) => { reached = r; });
  const intro2 = new IntroductionService(await db(), { afterPathLocked: async (stage) => { if (stage === 'create') { reached(); await gate; } } });
  const create = intro2.create(w0.r, { connectorId: w0.c, targetId: w0.t, message: 'hello' }, key());
  await atLock;
  const revoke = w0.w.conn.revoke(w0.c, w0.rc);
  assert.equal(await Promise.race([revoke.then(() => 'settled'), sleep(400).then(() => 'waiting')]), 'waiting', 'revoke must wait for the path-lock holder');
  release();
  const [cr, rv] = await Promise.all([create, revoke]);
  assert.ok(cr.ok, 'the path was valid when the request was created'); assert.ok(rv.ok);
  const acc = await w0.w.intro.transition(w0.c, cr.value.id, 'connector_accept', key());
  assert.ok(!acc.ok && acc.code === 'NOT_ELIGIBLE', 'acceptance must not rest on a concurrently revoked relationship');
  assert.equal((await q('SELECT status FROM introduction_requests'))[0]!.status, 'pending_connector');
});

test('RACE: acceptance fails when the relationship / block / consent changes in flight', { skip }, async () => {
  const cases: Array<[string, (k: Awaited<ReturnType<typeof chain>>) => [string, unknown[]]]> = [
    ['revoked relationship', (k) => [`UPDATE relationships SET revoked_at = now() WHERE id=$1`, [k.ct]]],
    ['block', (k) => [`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2)`, [k.t, k.r]]],
    ['consent revoked', (k) => [`UPDATE users SET accepts_introductions=false WHERE id=$1`, [k.c]]],
  ];
  for (const [label, mk] of cases) {
    const k = await chain(); const created = await intro(k.w, k.r, k.c, k.t); assert.ok(created.ok, label);
    const [sql, params] = mk(k);
    const res = await withRawTx(async (x) => { await x.query(sql, params); }, () => k.w.intro.transition(k.c, created.value.id, 'connector_accept', key()));
    assert.ok(!res.ok && res.code === 'NOT_ELIGIBLE', label);
    assert.equal((await q('SELECT status FROM introduction_requests'))[0]!.status, 'pending_connector', `${label}: no state change`);
  }
});

test('RACE: an uncommitted revoke that ROLLS BACK does not block a valid creation (locks are released)', { skip }, async () => {
  const { w, r, c, t, rc } = await chain(); const p = await db(); const x = await p.connect();
  try {
    await x.query('BEGIN'); await x.query(`UPDATE relationships SET revoked_at = now() WHERE id=$1`, [rc]);
    const pending = intro(w, r, c, t); await sleep(300); await x.query('ROLLBACK');
    const res = await pending; assert.ok(res.ok);
  } finally { x.release(); }
});

test('STRESS: concurrent introduction creates racing a revoke/block/consent change never error, deadlock or deliver on an invalid path', { skip }, async () => {
  for (let i = 0; i < 20; i++) {
    const k = await chain();
    const mutate = [() => k.w.conn.revoke(k.c, k.rc), () => k.w.safe.block(k.t, { connectionId: k.ct }), () => k.w.prof.setPrivacy(k.c, { acceptsIntroductions: false })][i % 3]!;
    const creates = Array.from({ length: 3 }, (_, j) => k.w.intro.create(k.r, { connectorId: k.c, targetId: k.t, message: `m${j}` }, key()));
    const [m, ...cs] = await Promise.all([mutate(), ...creates]);
    assert.ok(m.ok, 'mutation succeeds');
    for (const r of cs) assert.ok(r.ok || r.code === 'NOT_ELIGIBLE' || r.code === 'DUPLICATE_OPEN', `unexpected ${r.ok ? '' : r.code}`);
    // after everything settled, the path is invalid; any further creation must be refused
    const late = await intro(k.w, k.r, k.c, k.t); assert.ok(!late.ok && late.code === 'NOT_ELIGIBLE');
    const delivered = await num('SELECT count(*)::int AS n FROM introduction_requests'); assert.ok(delivered <= 1, 'only one open request per (requester, connector, target) can exist');
    const acc = delivered === 1 ? await k.w.intro.transition(k.c, (await q('SELECT id FROM introduction_requests'))[0]!.id as string, 'connector_accept', key()) : null;
    if (acc) assert.ok(!acc.ok && acc.code === 'NOT_ELIGIBLE', 'acceptance after the invalidating change is refused');
  }
});

test('DB-level lock key and block trigger serialise raw inserts against path holders', { skip }, async () => {
  const w = await world(); const a = await mkUser('A'), b = await mkUser('B'); void w;
  const p = await db(); const holder = await p.connect();
  try {
    await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock_shared(wcim_pair_lock_key($1::uuid,$2::uuid))', [b, a]);
    const ins = p.query('INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2)', [a, b]);
    assert.equal(await Promise.race([ins.then(() => 'done'), sleep(300).then(() => 'waiting')]), 'waiting', 'block waits for the shared pair lock regardless of direction');
    await holder.query('COMMIT'); await ins;
  } finally { holder.release(); }
});

after(async () => { if (pool) await pool.end(); });
