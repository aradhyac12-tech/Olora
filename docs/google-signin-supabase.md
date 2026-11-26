# Google sign-in via Supabase (shared DuoSpace project)

Flow: app -> Supabase `/auth/v1/authorize?provider=google` (PKCE) -> Google -> Supabase -> redirect back with `?code=` ->
app exchanges code at `/auth/v1/token?grant_type=pkce` -> app sends the Supabase access token to `POST /v1/auth/oauth/supabase` ->
API asks Supabase `GET /auth/v1/user` (Supabase validates the token) -> API issues its OWN session (same table/format as password login).
This app's data stays in its own PostgreSQL; Supabase is used for identity only. No service_role key is used anywhere.

## Manual steps (NOT done by me; Supabase dashboard of project `Duospace`)
1. Authentication -> Providers -> Google: must be enabled (DuoSpace may already have it). Nothing to change if so.
2. Authentication -> URL Configuration -> Redirect URLs: ADD (do not replace existing entries):
   - `olora://auth/callback`  (Android app; the scheme must match the scheme the APK builder puts in the manifest)
   - your web origin if you use the browser build
   DuoSpace's own entries stay untouched.
3. API server env: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable key), `CORS_ORIGINS`.

## Collision review (shared project)
- Shared by design: `auth.users` (one Google account = one Supabase user across both apps), the Google OAuth client, the redirect allow-list.
- FOUND (read-only query on production): trigger `on_auth_user_created` runs `public.handle_new_user()`, which inserts a row into DuoSpace's `public.profiles`
  for EVERY new auth user. So the first time someone signs in with Google through THIS app, a DuoSpace `profiles` row is created for them.
  Not changed (production untouched). Options: accept it, or change `handle_new_user` in a DuoSpace migration (OAuth sign-ups cannot carry an app tag, so it cannot tell the apps apart without extra design), or use a separate Supabase project.
- Not shared: this app's tables (own PostgreSQL), sessions (own `auth_sessions`), deep-link scheme (`olora` vs DuoSpace's).
- Signing out here does not sign the user out of DuoSpace: the Supabase session is never stored by this app (only the one-time code exchange is used).
- Account linking: an unknown Google identity creates a new local user ONLY if no local account has that email; otherwise `EMAIL_TAKEN` (409). We never auto-link to an
  existing email/password account (this app has no email verification, so a pre-registered account could be an attacker's).
