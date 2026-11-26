# olora — setup guide (Supabase, Google sign-in, API server, Android app)

What you end up with: Supabase project **Olora** (database + Google sign-in) -> API on Render (free) -> Android app (Capacitor APK) that talks to the API.
Nothing in this guide has been run end to end yet; section 6 is how to check each step.

## 0. Values you will need
| Name | Value |
|---|---|
| Supabase project ref | `reazimolvvcatpirqqsk` (region ap-northeast-1) |
| Supabase URL | `https://reazimolvvcatpirqqsk.supabase.co` |
| Supabase publishable key (public) | `sb_publishable_gKW4JAYDrlUc-h7_nh4WOA_Xuuphptw` |
| Google redirect URI (for Google Cloud) | `https://reazimolvvcatpirqqsk.supabase.co/auth/v1/callback` |
| App deep link (for Supabase) | `olora://auth/callback` |
| App name / URL scheme | `olora` / `olora` |
Never put the `service_role` key or the database password in the app, the repo or `render.yaml`.

## 1. Supabase (project "Olora")
Already done for you: migrations 0001-0004 are applied and migration 0005 turned on row-level security (no policies) on all 14 tables, so the public key cannot read or write them. If you ever recreate the project, run `database/migrations/0001..0004_*.sql` (not `*.down.sql`) in order, then `database/supabase/0005_enable_rls.sql`, in the SQL editor.

Dashboard steps (Authentication menu):
1. **Providers -> Google**: switch on, paste the Client ID and Client Secret from section 2, Save.
2. **URL Configuration**:
   - **Redirect URLs** -> add `olora://auth/callback` (exactly). If this is missing, Google sign-in ends on the Site URL instead of the app.
   - **Site URL** -> your API address once you have it (section 3), e.g. `https://olora-api.onrender.com`. Do not leave another app's site here.
3. Leave "Confirm email" settings alone: email+password accounts use olora's own API, not Supabase Auth.

## 2. Google Cloud Console (Google sign-in)
1. https://console.cloud.google.com -> create or pick a project named **olora**.
2. **APIs & Services -> OAuth consent screen** (Google Auth platform -> Branding): App name **olora**, your support email, upload the logo (`web/icon-512.png`), developer email. Scopes: `openid`, `email`, `profile` only.
3. **Audience**: while status is *Testing* only listed test users can sign in. Add your Google accounts as test users, or click **Publish app** (basic scopes need no Google review).
4. **Clients -> Create client -> Web application**, name `olora`.
   - Authorized JavaScript origins: leave empty.
   - Authorized redirect URIs: `https://reazimolvvcatpirqqsk.supabase.co/auth/v1/callback`
5. Copy the Client ID and Client Secret into Supabase (section 1, step 1).
The Google screen shows the name and logo from step 2; that is why a separate project matters.

## 3. API server on Render (free)
1. Push this folder to a GitHub repo.
2. Render -> **New -> Blueprint** -> pick the repo. It reads `render.yaml`.
3. When asked, set **DATABASE_URL** to the Supabase **Session pooler** string: Supabase -> **Connect** -> *Session pooler*. It looks like `postgresql://postgres.reazimolvvcatpirqqsk:<PASSWORD>@<pooler-host>:5432/postgres`. Replace `<PASSWORD>` with your database password (URL-encode special characters; reset it under Project Settings -> Database if forgotten). Use the pooler, not the direct `db.<ref>.supabase.co` host (direct needs IPv6, which Render lacks).
4. Deploy. Check `https://<service>.onrender.com/healthz` -> `{"status":"ok"}` (liveness only; does NOT test the database), then **`/readyz`** -> `{"status":"ok"}`. If `/readyz` returns 503 the JSON `reason` says why (see section 7). Render Logs show one `db.probe.ok` / `db.probe.failed` line at boot with a hint.
5. Put that URL in Supabase **Site URL** (section 1).
Free plan: sleeps after ~15 min idle, first request then takes about a minute. Paid plan removes this.
Env already set by `render.yaml`: NODE_VERSION 22, API_HOST 0.0.0.0, API_PORT 10000, TRUST_PROXY true, CORS_ORIGINS `https://localhost`, SUPABASE_URL, SUPABASE_ANON_KEY. If SUPABASE_URL/KEY are missing the server answers Google sign-in with 503 OAUTH_DISABLED.

## 4. Android app (APK builder)
In the builder set:
- **App name**: `olora` (the launcher name comes from here, not from the repo)
- **URL scheme / deep link**: `olora` (the repo has `android-expected-schemes.txt` = `olora`)
- **Icon**: if the APK shows a default icon upload `assets/icon-only.png`
- **Server address**: there is no server setting inside the app anymore. It is baked in at build time and defaults to `https://olora-api.onrender.com` (the service name in `render.yaml`). If Render gives your service a different URL, set the builder env `API_BASE_URL=<that https URL>` (https origin, no path, no trailing slash) and rebuild. `SUPABASE_URL` / `SUPABASE_ANON_KEY` default to the olora project.
- Build command `npm run build`, web output `dist` (already how the repo is set up).
Rebuild and reinstall after every change to these fields. They are baked in at build time.
CORS: `render.yaml` already allows the WebView origins `https://localhost`, `http://localhost` and `capacitor://localhost`. If the app still cannot reach the server, test `<url>/healthz` in the phone browser: ok => origin/CORS problem, otherwise the server is down or asleep (check Render Logs).

## 5. Environment variable reference (API)
`DATABASE_URL` (required) · `DATABASE_SSL` (`auto` default | `disable` | `no-verify` | `verify`; render.yaml sets `no-verify`) · `API_PORT` (3000) · `API_HOST` (127.0.0.1; 0.0.0.0 on a host) · `LOG_LEVEL` (info) · `CORS_ORIGINS` (exact origins, never `*`) · `TRUST_PROXY` (true only behind a proxy) · `SUPABASE_URL` + `SUPABASE_ANON_KEY` (together, enables Google sign-in). Local run: `cp .env.example .env`, `npm ci`, `npm start`.

## 6. Check it step by step
1. `curl https://<service>/healthz` -> ok.
2. Register in the app with email+password, sign out, sign in. (Proves API + database.)
3. Deep link: phone connected, `adb shell am start -a android.intent.action.VIEW -d "olora://auth/callback"`. The app should open. If nothing opens, the APK manifest does not register `olora` (fix the builder's scheme field, rebuild).
4. Google sign-in: tap Continue with Google -> Google screen says **olora** -> account -> returns to the app, signed in.

## 7. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Every email/Google sign-in shows "Server error." but `/healthz` is ok | The API cannot use its database. Open `<service>/readyz`: `reason` = `tls` -> set `DATABASE_SSL=no-verify`; `auth` -> wrong DB password (URL-encode special characters) or pooler user not `postgres.<project-ref>`; `unreachable` -> you used the direct `db.<ref>.supabase.co` host, use the Session pooler; `timeout` -> wrong host/port or project paused; `schema` -> run migrations 0001-0005; `database` -> URL must end in `/postgres`. Same info in Render Logs (`db.probe.failed`, `errCode`, `hint`). |
| Ends on a website instead of the app | `olora://auth/callback` missing from Supabase Redirect URLs, or Site URL points elsewhere |
| Google screen shows another app's name | Wrong Supabase project baked in, or Google consent screen name not set |
| Google `redirect_uri_mismatch` | Redirect URI in Google Cloud differs from `https://reazimolvvcatpirqqsk.supabase.co/auth/v1/callback` |
| Google "access blocked / app not verified" | Consent screen still in Testing: add yourself as test user or publish |
| API returns 503 OAUTH_DISABLED | SUPABASE_URL / SUPABASE_ANON_KEY not set on the server |
| "Cannot reach the server" in the app | Render URL differs from the baked-in one (set `API_BASE_URL`, rebuild), service asleep (wait a minute), service crashed (Render Logs), or CORS origin missing |
| 429 RATE_LIMITED on login | 10/min/IP limit; behind a proxy make sure TRUST_PROXY=true |
| Build fails "npm ci can only install packages when package.json and package-lock.json are in sync" | `package-lock.json` lacks the @capacitor packages. `render.yaml` now uses `npm install --include=dev`. Permanent fix: run `npm install` on your computer, commit the updated `package-lock.json`, then `npm ci` works (and CI too) |
| Deploy crashes "Cannot find package pg" | Build command must include dev dependencies (`--include=dev`) |
| Old launcher name in the APK | Builder App name field is not `olora`; rebuild |
| Deep link does nothing | Builder scheme is not `olora` (check with the adb command above) |
