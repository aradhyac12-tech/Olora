import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseVerifier } from '../src/auth/supabase.ts';

const user = { id: 'u-1', email: 'a@example.com', email_confirmed_at: '2026-11-25T00:00:00Z', app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { full_name: 'Ada' } };
const mk = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('verifier maps a Google user and sends only the public key + the user token', async () => {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const f = (async (url: string, init: { headers: Record<string, string> }) => { seen = { url, headers: init.headers }; return new Response(JSON.stringify(user)); }) as unknown as typeof fetch;
  const id = await supabaseVerifier({ url: 'https://abc.supabase.co/', anonKey: 'anon-key-123456789012345', fetchImpl: f })('tok-tok-tok-tok-tok-tok');
  assert.deepEqual(id, { subject: 'u-1', email: 'a@example.com', emailVerified: true, displayName: 'Ada', viaGoogle: true });
  assert.equal(seen!.url, 'https://abc.supabase.co/auth/v1/user');
  assert.equal(seen!.headers.Authorization, 'Bearer tok-tok-tok-tok-tok-tok');
});
test('verifier: 401 => null, 5xx => throws, non-google / unverified flagged', async () => {
  const v = (f: typeof fetch) => supabaseVerifier({ url: 'https://abc.supabase.co', anonKey: 'k'.repeat(20), fetchImpl: f })('t'.repeat(30));
  assert.equal(await v(mk(401, {})), null);
  await assert.rejects(v(mk(500, {})));
  assert.equal((await v(mk(200, { ...user, app_metadata: { provider: 'email', providers: ['email'] } })))!.viaGoogle, false);
  assert.equal((await v(mk(200, { ...user, email_confirmed_at: null })))!.emailVerified, false);
  assert.equal(await v(mk(200, { foo: 1 })), null);
});
