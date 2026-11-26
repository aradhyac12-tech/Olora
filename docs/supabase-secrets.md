# Adding an API key to Supabase and its Edge Functions

Edge Function secrets are server-side environment variables. Never put a secret in `web/` or any `VITE_`/client config: it ships inside the APK.

## Dashboard
1. Supabase dashboard -> project -> Edge Functions -> Secrets (or Project Settings -> Edge Functions).
2. Add new secret: name (e.g. `RESEND_API_KEY`), value, Save. Names cannot start with `SUPABASE_` (reserved).
3. Redeploy is NOT needed for a new secret to be read by already-deployed functions, but a function that is running may need a fresh invocation.

## CLI
    supabase login
    supabase link --project-ref <project-ref>
    supabase secrets set RESEND_API_KEY=xxxx            # one or more NAME=value pairs
    supabase secrets set --env-file ./supabase/.env     # many at once (keep this file out of git)
    supabase secrets list                               # shows names + digests, never values

## Reading it in a function
    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) return new Response('Server not configured', { status: 500 });

Already present in every function without setting: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`.

## Local testing
Put the same names in `supabase/functions/.env` (gitignored) and run `supabase functions serve`.

## Rules
- Secret/service_role keys: Edge Functions or this app's API server env only. The publishable (anon) key is the only key allowed in the app.
- Do not log key values; do not return them in responses.
- Rotate by setting the same name again with the new value.
