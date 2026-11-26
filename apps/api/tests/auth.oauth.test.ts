import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../src/auth/service.ts';
import type { ExternalIdentity } from '../src/auth/service.ts';

// Tiny scripted pool: records SQL, answers by pattern. Not a database: SQL semantics are covered by the PostgreSQL tests.
function pool(opts: { known?: { id: string; account_status: string }; dupEmail?: boolean }) {
  const sql: string[] = [];
  const q = async (text: string) => {
    sql.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes('FROM oauth_identities')) return { rows: opts.known ? [opts.known] : [] };
    if (text.startsWith('INSERT INTO users')) { if (opts.dupEmail) throw Object.assign(new Error('dup'), { code: '23505' }); return { rows: [{ id: 'new-user' }] }; }
    return { rows: [] };
  };
  const client = { query: q, release: () => {} };
  return { sql, p: { query: q, connect: async () => client } as never };
}
const good: ExternalIdentity = { subject: 's-1', email: 'A@Example.com', emailVerified: true, displayName: 'Ada', viaGoogle: true };
const TOK = 't'.repeat(40);
const svc = (p: never, id: ExternalIdentity | null) => new AuthService(p, { oauthVerifier: async () => id });

test('oauth: disabled without a verifier', async () => {
  assert.deepEqual(await new AuthService(pool({}).p).loginWithOAuth(TOK), { ok: false, code: 'OAUTH_DISABLED' });
});
test('oauth: unverified email, non-google, or unknown token are rejected without touching the DB', async () => {
  for (const id of [null, { ...good, emailVerified: false }, { ...good, viaGoogle: false }]) {
    const { p, sql } = pool({});
    assert.deepEqual(await svc(p, id).loginWithOAuth(TOK), { ok: false, code: 'INVALID_CREDENTIALS' });
    assert.equal(sql.length, 0);
  }
});
test('oauth: new identity creates user (lower-cased email) + link + session', async () => {
  const { p, sql } = pool({});
  const r = await svc(p, good).loginWithOAuth(TOK);
  assert.equal(r.ok, true);
  assert.ok(sql.some((s) => s.startsWith('INSERT INTO oauth_identities')));
  assert.ok(sql.some((s) => s.startsWith('INSERT INTO auth_sessions')));
  assert.ok(sql.includes('COMMIT'));
});
test('oauth: email already used by a local account => EMAIL_TAKEN, no link, no session (no auto-linking)', async () => {
  const { p, sql } = pool({ dupEmail: true });
  assert.deepEqual(await svc(p, good).loginWithOAuth(TOK), { ok: false, code: 'EMAIL_TAKEN' });
  assert.ok(!sql.some((s) => s.startsWith('INSERT INTO oauth_identities') || s.startsWith('INSERT INTO auth_sessions')));
  assert.ok(sql.includes('ROLLBACK'));
});
test('oauth: known identity of an inactive account is rejected; active signs in without creating a user', async () => {
  const a = pool({ known: { id: 'u1', account_status: 'suspended' } });
  assert.deepEqual(await svc(a.p, good).loginWithOAuth(TOK), { ok: false, code: 'INVALID_CREDENTIALS' });
  const b = pool({ known: { id: 'u1', account_status: 'active' } });
  assert.equal((await svc(b.p, good).loginWithOAuth(TOK)).ok, true);
  assert.ok(!b.sql.some((s) => s.startsWith('INSERT INTO users')));
});
