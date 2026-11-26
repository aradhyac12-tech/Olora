// Pure unit tests (no database): tokens, rate limiter, contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, looksLikeToken, newToken } from '../src/social/tokens.ts';
import { RateLimiter } from '../src/social/rateLimit.ts';
import { CreateInvitationBody, IntroCreateBody, ProfilePatchBody, SubjectSchema, isSafeAvatarUrl, IdentityBody, BlockBody } from '../src/contracts/index.ts';

test('tokens: 32 random bytes, 43 chars base64url, hash is SHA-256 hex and differs per token', () => {
  const a = newToken(), b = newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a, b); assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.match(hashToken(a), /^[0-9a-f]{64}$/); assert.notEqual(hashToken(a), hashToken(b)); assert.notEqual(hashToken(a), a);
  assert.ok(looksLikeToken(a)); for (const bad of ['', 'abc', a + 'x', a.slice(1), `${a.slice(1)}=`, `${a.slice(0, 42)}+`]) assert.equal(looksLikeToken(bad), false);
});

test('rate limiter: window, blocking, reset, independent keys, pruning', () => {
  let t = 1000; const rl = new RateLimiter(() => t);
  for (let i = 0; i < 3; i++) assert.equal(rl.hit('k', 3, 1000).ok, true);
  const over = rl.hit('k', 3, 1000); assert.equal(over.ok, false); assert.ok(over.retryAfterMs > 0 && over.retryAfterMs <= 1000);
  assert.equal(rl.hit('other', 3, 1000).ok, true);
  assert.equal(rl.blocked('k', 3), true); assert.equal(rl.blocked('other', 3), false);
  t += 1001; assert.equal(rl.blocked('k', 3), false); assert.equal(rl.hit('k', 3, 1000).ok, true);
  assert.equal(rl.hit('zero', 0, 1000).ok, false);
});

test('avatar URLs: https public hosts only', () => {
  for (const ok of ['https://cdn.example.com/a.png', 'https://example.org/x?y=1']) assert.equal(isSafeAvatarUrl(ok), true, ok);
  for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://localhost/a', 'https://127.0.0.1/a', 'https://10.0.0.1/a', 'https://[::1]/a', 'https://user:pw@example.com/a', 'https://intranet/a', 'https://a.local/x', 'https://example.com/a b', 'https://x.internal/a', 'https://example.com/' + 'a'.repeat(500)]) assert.equal(isSafeAvatarUrl(bad), false, bad);
});

test('contracts: invitation bodies', () => {
  assert.ok(CreateInvitationBody.safeParse({ purpose: 'connect', relationshipType: 'colleague' }).success);
  assert.ok(CreateInvitationBody.safeParse({ relationshipType: 'family', maxUses: 25, expiresInDays: 90 }).success, 'purpose defaults to connect');
  assert.ok(CreateInvitationBody.safeParse({ purpose: 'introduce' }).success);
  for (const bad of [{ purpose: 'connect' }, { relationshipType: 'imported' }, { relationshipType: 'family', maxUses: 26 }, { relationshipType: 'family', maxUses: 0 }, { relationshipType: 'family', expiresInDays: 91 },
    { purpose: 'introduce', maxUses: 3 }, { purpose: 'introduce', relationshipType: 'family' }, { relationshipType: 'family', extra: 1 }, { relationshipType: 'family', note: 'a\u0000b' }, { relationshipType: 'family', note: 'x'.repeat(201) }]) assert.equal(CreateInvitationBody.safeParse(bad).success, false, JSON.stringify(bad));
});

test('contracts: subjects never accept a raw user id; introductions need exactly one target selector', () => {
  const id = '11111111-1111-4111-8111-111111111111', tok = 'A'.repeat(43);
  assert.ok(SubjectSchema.safeParse({ connectionId: id }).success); assert.ok(SubjectSchema.safeParse({ invitationToken: tok }).success);
  for (const bad of [{ userId: id }, { connectionId: id, invitationToken: tok }, { connectionId: 'x' }, {}, { introductionId: id }]) assert.equal(BlockBody.safeParse({ subject: bad }).success, false);
  assert.ok(IntroCreateBody.safeParse({ connectorId: id, targetId: id, message: 'hi' }).success); assert.ok(IntroCreateBody.safeParse({ connectorId: id, targetToken: tok, message: 'hi' }).success);
  assert.equal(IntroCreateBody.safeParse({ connectorId: id, message: 'hi' }).success, false); assert.equal(IntroCreateBody.safeParse({ connectorId: id, targetId: id, targetToken: tok, message: 'hi' }).success, false);
});

test('contracts: profile and identity bodies', () => {
  assert.equal(ProfilePatchBody.safeParse({}).success, false);
  assert.equal(ProfilePatchBody.safeParse({ displayName: '   ' }).success, false);
  assert.equal(ProfilePatchBody.parse({ displayName: '  Ann  ' }).displayName, 'Ann');
  assert.ok(ProfilePatchBody.safeParse({ avatarUrl: null }).success); assert.equal(ProfilePatchBody.safeParse({ displayName: 'A', role: 'admin' }).success, false);
  assert.equal(IdentityBody.parse({ platform: 'instagram', username: '@ann_lee' }).username, 'ann_lee');
  for (const bad of ['<img src=x>', 'a b', 'a;b', '']) assert.equal(IdentityBody.safeParse({ platform: 'instagram', username: bad }).success, false, bad);
  assert.equal(IdentityBody.safeParse({ platform: 'myspace', username: 'x' }).success, false);
});
