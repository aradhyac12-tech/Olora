// Verifies a Supabase Auth access token by asking Supabase (GET /auth/v1/user). Supabase only answers for tokens
// issued by THIS project, so no JWT parsing or key handling happens here. Only the public publishable (anon) key is used.
import type { ExternalIdentity, IdentityVerifier } from './service.ts';

export function supabaseVerifier(o: { url: string; anonKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): IdentityVerifier {
  const base = o.url.replace(/\/+$/, ''); const f = o.fetchImpl ?? fetch;
  return async (accessToken: string): Promise<ExternalIdentity | null> => {
    const res = await f(`${base}/auth/v1/user`, { headers: { apikey: o.anonKey, Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(o.timeoutMs ?? 5000) });
    if (res.status === 401 || res.status === 403) return null; // invalid/expired token
    if (!res.ok) throw new Error(`supabase_http_${res.status}`);
    const u = (await res.json()) as { id?: unknown; email?: unknown; email_confirmed_at?: unknown; app_metadata?: { provider?: unknown; providers?: unknown }; user_metadata?: { full_name?: unknown; name?: unknown } };
    if (typeof u.id !== 'string' || typeof u.email !== 'string') return null;
    const providers = Array.isArray(u.app_metadata?.providers) ? u.app_metadata!.providers as unknown[] : [];
    const name = typeof u.user_metadata?.full_name === 'string' ? u.user_metadata.full_name : typeof u.user_metadata?.name === 'string' ? u.user_metadata.name : '';
    return { subject: u.id, email: u.email, emailVerified: typeof u.email_confirmed_at === 'string' && u.email_confirmed_at.length > 0,
      displayName: name, viaGoogle: u.app_metadata?.provider === 'google' || providers.includes('google') };
  };
}
