# Handoff — Slice 4.5 verification
- EXECUTED: clean npm ci, typecheck, unit 115/115, test:db PASSED, pgstore 89/89, browser e2e PASSED (2 suites, real Fastify auth, Chromium via npm @sparticuz/chromium), build. 0 skipped. NOT RUN: Actions, Render, Supabase, Android. Details: docs/test-report-slice-4-5.md.

# Handoff — Slice 4 follow-up: first full run with network (Fastify, real `pg`, PG16)

- EXECUTED (this session, Node 22.23.5, PostgreSQL 16.15 via apt, real `fastify`/`pg`): `npm install` regenerated `package-lock.json`; clean-copy `npm ci` OK; `npm run typecheck` clean; `npm test` **114/114, 0 skipped** (was 111/114); `npm run test:db` PASSED (0001-0004+0006 apply, constraint tests, rollback, re-apply); `npm run test:pgstore` **88/88, 0 skipped** (includes the formerly unrunnable `server.integration.test.ts`, `routes`, `relationships`).
- FOUND + FIXED: `server/status.ts` mapped `INVALID_CREDENTIALS` to **403** globally (Slice 4), contradicting the documented/tested **401** for login/register/oauth (3 failing tests in `server.test.ts`: login, login rate limit, oauth). Cause: the web client signs out on any 401, and account-delete with a wrong password must not do that. Fix: global map back to 401; `POST /v1/account/delete` now returns 403 for a wrong password in `social/routes.ts` (only place that needs it). Re-run: unit 114/114, pgstore 88/88 (delete-account wrong-password path is covered at service level; there is NO HTTP-level test asserting the 403 on `/v1/account/delete` yet).
- `render.yaml` buildCommand restored to `npm ci --include=dev` (lockfile now in sync). CI minimums: unit 114 (unchanged), PG 85 -> 88. GitHub Actions itself STILL NOT RUN.
- NOT RUN: browser e2e (`npm run test:e2e`; Playwright Chromium download is blocked in this sandbox), real Render/Supabase (PG17), APK/device, load tests. Mutation checks were not repeated for this fix.
- DONE (same session, later): added HTTP test `account delete with a password account` in `tests/pg/routes.integration.test.ts` (wrong/missing password => 403 INVALID_CREDENTIALS, nothing deleted; correct => 200). MUTATION-CHECKED: changing the route to 401 makes it fail (pgstore 88/89), restored => 89/89. CI PG minimum 88 -> 89. Current: typecheck clean, unit 114/114, pgstore 89/89, test:db PASSED.
- NEXT: push, confirm Actions green; then the suggested Slice 5 items in `docs/known-limitations-and-next-milestone.md`.

# Handoff — Slice 4: relationship management, identity discovery, connection onboarding

- DONE + tested (see `docs/test-report-slice-4.md`): migration `0006` (+down, SQL tests), invitation links (hash-only tokens), mutual confirmation lifecycle, trusted-relationship rule in code and DB, blocks/reports, profile/privacy/identities, account export/delete, introduction concurrency fixes (path locking), frontend tabs + `#/i/` `#/t/` links, browser e2e.
- NOT RUN here (no network): Fastify glue/`server.test.ts`/`db.diagnostics.test.ts`/`server.integration.test.ts`, real `pg`, CI, deploy. Regenerate `package-lock.json` (`zod`, `playwright` added), run CI first. Details: `docs/known-limitations-and-next-milestone.md`.
- Supabase: apply `database/migrations/0006_relationship_lifecycle.sql` then `database/supabase/0007_enable_rls_slice4.sql`. Web build: set `PUBLIC_APP_URL` for shareable links.

# Handoff — Session 14: "Server error." on every sign-in (from screen recording)

## Session 14 — what the video showed and what was done
- Video: Google sign-in opens a blank white supabase.co Custom Tab (just loading), returns to the app via `olora://` (so Supabase redirect URL IS configured), then "Server error." Email sign-in/sign-up also "Server error.". All of these end at the API returning `INTERNAL` (500).
- FOUND (executed): with the real server + migrations 0001-0004 on a clean PostgreSQL 16, register and login WORK. So app logic is fine; the failure is the deployed API <-> Supabase DB link. Reproduced the three environment failure classes against a TLS-enforcing local PG: plain connection (28000 no encryption), `?sslmode=require` (pg 8.23 verifies certs -> DEPTH_ZERO_SELF_SIGNED_CERT; Supabase would give SELF_SIGNED_CERT_IN_CHAIN), wrong password (28P01). ALL produce the identical `{"error":{"code":"INTERNAL"}}` seen in the video, and `/healthz` stayed ok because it never touches the DB.
- NOT DETERMINED: which of those the real Render service hits. I had no access to Render logs, DATABASE_URL, or Supabase (network allow-list). The first thing to do is open `<render-url>/readyz` and read `reason` (SETUP.md section 7).
- Changes: `server/dbConfig.ts` (`DATABASE_SSL` = auto|disable|no-verify|verify; strips URL sslmode when set, because URL params override the ssl option; connect timeout 10 s, keepAlive); `server/dbHealth.ts` + `GET /readyz` (503 + coarse reason, public, rate-limited, no-store); boot probe in `main.ts` logs one `db.probe.ok|failed` line with a hint, warns on the IPv6-only direct host; `classifyDbError` in `introductions/logger.ts` and `errFields` now adds `dbReason`; `pool.on('error')` (see below); `render.yaml` sets `DATABASE_SSL=no-verify`; SETUP.md updated; `.env.example`.
- Latent crash fixed: no `pool.on('error')` meant a pooler-dropped idle connection killed the whole API process. EXECUTED: killing idle backends -> process ALIVE with the handler, DEAD without it (mutation).
- Tests fixed: config exact-shape assertion (new `databaseSsl` key); search rate-limit test was wrong from the start (validation-rejected requests count toward the limit, so max 2 was exhausted before the first valid call) -> max 4.
- EXECUTED: typecheck clean; `npm test` 108/108, 0 skipped (was 99/100 with 1 failing before this session); `npm run test:pgstore` 43/43; `npm run test:db` PASSED (PG 16 local). Mutation checks (caught): stripSslParams no-op, auth-before-tls classification order. Fixed vs `DATABASE_SSL=no-verify` verified end to end with the real server: readyz 200 + login token.
- NOT RUN: real Render deploy, real Supabase, real Google round trip, APK/device, GitHub Actions. `DATABASE_SSL=no-verify` is encrypted but does not authenticate the server; for strict TLS use `verify` + `NODE_EXTRA_CA_CERTS` with Supabase's CA.
- CI unit minimum raised 82 -> 108 (unrun on Actions).
- Heads-up (not changed): PKCE verifier lives in `sessionStorage`; if Android kills the WebView while the Custom Tab is open, Google sign-in would end in "did not complete". Consider `localStorage`.


- `SETUP.md` added (full setup guide: Supabase, Google Cloud, Render, APK, troubleshooting). Project folder and zip renamed to `olora`.

- Removed the in-app "Connection settings" box (and the localStorage server override). Server address is build-time only: `scripts/build-web.mjs` default `https://olora-api.onrender.com`, override with `API_BASE_URL` (must be https origin, build fails otherwise). `render.yaml` CORS_ORIGINS now https://localhost,http://localhost,capacitor://localhost. EXECUTED: build, node --check, headless UI flow (0 errors), auth screen has no settings box. NOT RUN: APK, real server.

- Render build failed: `npm ci` rejected package-lock.json (no @capacitor/app, @capacitor/browser, @capacitor/core, tslib entries; the lockfile in this repo was never regenerated after Session 9). `render.yaml` now uses `npm install --include=dev --no-audit --no-fund`. TODO: run `npm install` with network, commit the lockfile, then restore `npm ci`. GitHub Actions CI uses `npm ci` and will fail until then. Could not regenerate offline.

## Session 13d — free hosting (Render) + trustProxy
- `render.yaml` (Blueprint, free plan, Singapore): build `npm ci --include=dev`, start `npm start`, health `/healthz`, env preset; only `DATABASE_URL` (Supabase Session pooler string) is entered in the dashboard. Free tier sleeps after ~15 min idle (slow first request); see https://render.com/docs/free.
- `TRUST_PROXY` env (default false) -> Fastify `trustProxy`; set true on Render so per-IP rate limits see real clients.
- EXECUTED: loadConfig run directly (default, TRUST_PROXY=yes rejected, =true accepted). NOT RUN: server.test.ts, Render deploy. The existing config test (line 46) was already stale (expected no corsOrigins/supabase keys) - fixed to the current shape, unverified.

## Session 13c — own Supabase project "Olora" (ref reazimolvvcatpirqqsk, ap-northeast-1)
- Google sign-in no longer uses DuoSpace's project. Build defaults (`scripts/build-web.mjs`, `.env.example`) now point at https://reazimolvvcatpirqqsk.supabase.co with its publishable key (public value).
- EXECUTED via Supabase tool: migrations 0001-0004 applied to that project, plus `0005_enable_rls_deny_data_api` (RLS on, no policies, all 14 tables; copy in `database/supabase/0005_enable_rls.sql`, NOT part of the local test harness). Verified: list_tables shows 14 tables, rls_enabled true, 0 rows. Constraint/trigger behaviour on Supabase's PG17 NOT tested (local tests ran on PG16).
- STILL MANUAL (dashboard): Authentication > Providers > Google (client ID/secret from a Google Cloud OAuth client named "olora", authorised redirect URI https://reazimolvvcatpirqqsk.supabase.co/auth/v1/callback); Authentication > URL Configuration: add `olora://auth/callback` to Redirect URLs and set Site URL to the API/app URL. NOT RUN: any real Google round trip. API host not deployed; its DATABASE_URL must be this project's Session pooler string and SUPABASE_URL/SUPABASE_ANON_KEY the values above.
- docs/google-signin-supabase.md still describes DuoSpace; treat it as historical.

## Session 13b — name
- Root `package.json` + `package-lock.json` `name` is now `olora` (APK builders usually take the launcher name from it; before it was `who-can-introduce-me`). NOT RUN: APK build. If the APK still shows the old name, set the builder's app-name field to `olora`; the repo cannot override it. Workspace names `@wcim/*` unchanged (internal).

## Session 13 — Slice 3: route search + introductions list + UI wiring
- `GET /v1/introductions?limit=` (default 50, max 100): requests the caller may see, newest first, with display names of the 3 parties. Same visibility as `canSee` (target only after connector accepted). `IntroductionService.list`.
- `GET /v1/search?targetId=<uuid>` (rate limit 30/min/IP, `searchRateLimit`): `src/search/service.ts`. Runs the engine (maxHops 3) in a REPEATABLE READ snapshot. Returns only FIRST-hop connectors (id + name, fewest hops, `canRequest` = 2 hops). Deeper users are never named. Missing/hidden/blocked/self/no-path all => `{status:'none_found',routes:[]}`. Lookup by id only (no directory/name search). Route is only registered when `search` is passed to `buildApp` (main.ts does).
- Web client: removed localStorage recent-IDs and the manual connector/target ID form. Now: Find a route (target ID) -> routes -> Ask -> message -> send; "Your introductions" list loads from the server; actions refresh it. Removed the card fade-in (it replayed on every re-render); auth screen keeps it.
- EXECUTED: 4 new search unit tests pass (+1 mutation caught: naming non-first-hop users); all 82 non-server unit tests pass (`node --test`, 0 skipped); list SQL (the exact query) run on real PostgreSQL 16 after applying 0001-0004: requester 1 row, connector 1, target 0 before connector accept and 1 after, stranger 0; `node --check`; web build; headless Chromium 390x844 with a MOCKED API, light + dark: search, none-found, compose, send (POST body checked), list refresh, 0 page errors; screenshots viewed.
- NOT RUN (no node_modules/network): `npm ci`, typecheck, `server.test.ts` incl. 2 NEW tests (list, search) and the fake `IntroService.list` addition, the PostgreSQL integration tests (need `pg`), `IntroductionService.list` through the Node service (SQL verified via psql only), real server + real device. No PG integration test exists yet for `list`. CI unit minimum left at 82: I could not count the real total (server tests unrunnable); raise it after the first green run (expect +6).
- Open: users can only be found by ID, so there is no way yet to learn a target's ID (needs a share link / invite flow, a product decision). No outbox worker, no scheduler for expireDue/purgeClosed, no notifications. Search results are not paginated (max 10 connectors).
- NEXT: run `npm ci && npm run test:all`, fix whatever the 2 new server tests show; then outbox worker + scheduler, then the relationships/contacts UI (nothing creates edges from the client yet, so search returns nothing for real users).

## Session 12 — UI redesign
- Rewrote `web/styles.css` + views in `web/app.js`: branded auth screen (logo, tagline, Google button first, email form, connection settings tucked in a collapsible), topbar, role-aware introduction card (status pill, only the actions that role may take in that status), toasts instead of inline errors, spinners, focus rings, dark mode, safe-area, reduced-motion. Logic (API calls, PKCE, deep links) unchanged.
- EXECUTED: headless Chromium (Playwright) at 390x844: auth screen and a mocked introduction card rendered with no page errors; screenshots viewed. NOT RUN: dark mode screenshot, real device, register view, error toasts against a real server.
- `docs/supabase-secrets.md`: how to add keys to Supabase Edge Function secrets. This repo has no Edge Functions yet.

## Session 11 — olora logo
- Logo (indigo #2f2e7d, white ring, coral dot #ff7a59) added: `web/logo.svg`, `web/favicon.svg`, `web/icon-192.png`/`icon-512.png` (rounded, web), shown in the app header on every screen.
- Android launcher sources: `assets/icon-only.png`, `assets/icon-foreground.png` (+ `icon-background.png` solid indigo, adaptive icon, mark inside the 66% safe zone), `resources/icon.png` (1024). Generated with PIL.
- UNKNOWN: whether the APK builder picks these up automatically (it did not say). If the APK still has the default icon, upload `assets/icon-only.png` in the builder's icon field.
- EXECUTED: icon generation (preview viewed), node --check, web build lists the new files in dist/. NOT RUN: APK build.

## Session 10 — name "olora" + deep link
- Visible app name in the web UI/title is now `olora`. The launcher name on the APK comes from the BUILDER's app-name field (env APP_NAME was `who-can-introduce-me`), not from this repo: set it to `olora` there. package.json `name` left unchanged (lockfile).
- Deep link scheme `olora://`: `olora://auth/callback` (Google sign-in return) and `olora://introduction/<id>` (opens that introduction; remembered until signed in; `?intro=<id>` on web). `android-expected-schemes.txt` (=`olora`) tells the builder which scheme its manifest check requires.
- Supabase redirect URL to add: `olora://auth/callback` (replaces the earlier `app.whocanintroduceme://...`). Default `APP_SCHEME` is now `olora`.
- EXECUTED: node --check, build script. NOT RUN: APK build, a real deep-link tap on a device. RISK: if the builder injects a different scheme than `olora`, its manifest check fails - then delete android-expected-schemes.txt or change both.

## Session 9 — Google sign-in via Supabase (DuoSpace project) + Capacitor plugins
- Capacitor plugins `@capacitor/app` + `@capacitor/browser` ^8 are in package.json/lockfile (user ran npm i; clears the builder's OAuth-readiness fatal checks - builder NOT re-run).
- Migration `0004_oauth_identities(.down)` + SQL assertions; harness scripts updated (14 tables, 19 objects, 0004 in up/down). NOT RUN (no PostgreSQL here).
- `auth/supabase.ts` (verifies token via Supabase `/auth/v1/user`), `AuthService.loginWithOAuth`, route `POST /v1/auth/oauth/supabase` (public, rate-limited, 503 OAUTH_DISABLED when unconfigured), config `SUPABASE_URL`/`SUPABASE_ANON_KEY`.
- Web client: "Continue with Google" button (PKCE, state check, Capacitor Browser + `appUrlOpen` deep link). Build bakes DuoSpace's public URL + publishable key by default (`APP_SCHEME` default `app.whocanintroduceme`).
- EXECUTED: 7 new unit tests (auth.supabase 2, auth.oauth 5) pass via `node --test`; `node --check` on client; build script run; PKCE challenge matches the RFC 7636 test vector.
- NOT RUN: npm ci, typecheck, the server.test.ts additions (2 new + 2 CORS from Session 8; need fastify), PostgreSQL tests, real Google round trip, APK build. Real Google sign-in has NEVER been exercised.
- Read `docs/google-signin-supabase.md`: manual dashboard steps (redirect URL) and the collision finding (DuoSpace `handle_new_user` creates a `profiles` row for every new auth user). Production was only read, never modified.
- Open: confirm the deep-link scheme the APK builder writes into AndroidManifest matches `APP_SCHEME` and the Supabase redirect entry; no sign-out of the Supabase session (by design); no email verification for password accounts.


## Session 8 — Web client + build script (fixes APK builder WEB_BUILD_FAILED)
- Cause of the failure: no `build` script and no `index.html` anywhere (API-only repo), so the APK builder found no web output (`DETECTED_FRAMEWORK: static-web`, `WEB_DIR: dist`).
- Added `web/` (index.html, app.js, styles.css; dependency-free, no npm install needed) and `scripts/build-web.mjs`; root `npm run build` copies `web/` -> `dist/` and writes `dist/config.js` from optional env `API_BASE_URL`.
  Client: server-address setting, register/login/logout, create introduction (Idempotency-Key per action), open by ID, the 5 transition actions. No list endpoint exists, so recent IDs are kept in localStorage.
- API: exact-origin CORS allow-list (`CORS_ORIGINS`, never `*`; default none) + preflight before auth; `.env.example` has `CORS_ORIGINS=https://localhost` (Capacitor Android default origin).
- EXECUTED: `node scripts/build-web.mjs` produced dist/{index.html,app.js,config.js,styles.css}; JS syntax checked with `node --check`.
- NOT RUN (no network/node_modules in this session): `npm ci`, typecheck, unit tests incl. the 3 NEW CORS/config tests in server.test.ts, PostgreSQL tests, the APK build itself. Run `npm run test:all` first next session; CI minimum unit count not raised for that reason.
- Known: the client is a minimal placeholder UI (no graph search endpoint exists yet); the APK's API address must be set in-app or via `API_BASE_URL` at build; Android cleartext HTTP is blocked, use HTTPS.


## Session 7 — Real authentication (done)
- Migration `0003_auth(.down)` + 13 SQL assertions: `user_credentials` (scrypt hash only, CHECK rejects non-hash), `auth_sessions` (SHA-256 token hash only, expiry/revoke checks, cascades).
- `src/auth/`: `password.ts` (node scrypt N=16384 r=8 p=1, NFKC, params in the hash, hostile stored params rejected), `service.ts` (`register`, `login`, `authenticate`, `logout`, `logoutAll`).
  Login failures are uniform (a dummy hash is verified for unknown emails to equalise timing); inactive accounts cannot log in and lose access immediately; sessions 30 days.
- HTTP: `POST /v1/auth/register|login|logout|logout-all`, `GET /v1/me`; `@fastify/rate-limit` 10/min/IP on register+login. The old stop-gap signed tokens, `SESSION_SECRET` and `npm run token` are REMOVED.
- Routes are defined inside a child plugin so they load AFTER the rate-limit plugin (found by a failing test: without it the limiter silently did nothing).
- Tests: 82 unit / 43 PostgreSQL, 0 skipped. Mutation-checked: revocation, expiry, account status (authenticate), account status (login), raw-token storage — all CAUGHT.
  Real process verified with curl (register, duplicate 409, bad login 401, login, /v1/me, logout then 401, 429 after 10 bad logins, no token/password in logs).
- NOT done / known: no email verification or password reset; no per-account lockout (only per-IP, in memory, single instance); register reveals whether an email exists (EMAIL_TAKEN) — enumeration
  risk until rate limits + verification exist; no CORS yet (needed for a browser/Capacitor client); no session listing UI; no password change; `last_used_at` not tracked; scrypt cost not tuned for production hardware.
- NEXT (client): `apps/web` (Vite + React) with login/register + introductions screens, CORS on the API, then Capacitor Android wrap so the APK builder has a `dist/index.html` + `npm run build`.

## Session 6 — Fastify API scaffold (done, Slice 3 started)
- `apps/api/src/server/`: `app.ts` (factory; /healthz, POST /v1/introductions, POST /v1/introductions/:id/transitions, GET /v1/introductions/:id), `config.ts`
  (fail-fast env validation), `auth.ts` (HMAC-signed bearer tokens — STOP-GAP, not real login), `main.ts` (pool, graceful SIGTERM/SIGINT), `mintToken.ts`.
  Fastify 5.12.8 (apps/api dependency). Acting user always comes from the token, never the body; JSON-schema validation (no extra fields); bodyLimit 8 KB;
  service codes mapped to HTTP statuses (see app.ts), body is code-only; unexpected errors => generic 500; `Authorization` redacted from logs.
- Tests: 78 unit / 36 PostgreSQL, 0 skipped, `npm run test:all` green TWICE. Real process verified by hand with curl (health, 401, create 201, connector_accept 200,
  placeholder secret refused, SIGTERM clean). CI minimums 78 / 36; Actions still NOT RUN.
- NOT done (updated in Session 7: auth + rate limiting on auth routes now exist): CORS, security headers (helmet), TLS/proxy settings (`trustProxy`), graph SEARCH endpoint
  (must use `withGraphSnapshot`), outbox worker, scheduler for `expireDue`/`purgeClosed`, OpenAPI docs, graceful draining of in-flight requests beyond Fastify's default.

## Session 5 — Slice 2 gap closure (done)
- **Graph re-check on accept**: `connector_accept` and `target_accept` now re-verify requester->connector->target INSIDE the row-locked transaction, on the same
  connection (no second pooled connection). Failure = `NOT_ELIGIBLE`, no state/audit/outbox change; declines and cancels never need the graph; idempotent replays
  return the stored result without re-evaluating. Switch: `recheckOnAccept: false`. A refused request stays open until it expires/is declined/cancelled (no new status, no migration).
  Store errors during the check abort the transaction => `INTERNAL` (not read as 'no path').
- **Structured logging**: `introductions/logger.ts` (`Logger`, `jsonLogger`, `noopLogger`, `errFields`), injected via `ServiceOptions.logger` (default no-op).
  Fields are ids/codes/counts only; errors log class name + SQLSTATE only (never driver messages — they can embed row values). Not wired to any server yet.
- **Retention**: `purgeClosed(olderThanMs, limit)` deletes terminal requests decided > olderThanMs ago (min 24h, else no-op), keeps any request with an undelivered
  outbox row, cascades audit/idempotency/outbox, SKIP LOCKED for concurrent workers. Nothing schedules it. Policy numbers (how long to keep) are NOT decided — caller chooses.
- Tests: 71 unit / 35 PostgreSQL, 0 skipped, `npm run test:all` green TWICE on PostgreSQL 16 (local apt install, not docker). Details + mutation results: `docs/test-report-slice-2.md`.
- CI minimums raised to 71 / 35. GitHub Actions itself STILL NOT RUN.

## Remaining Slice 2 gaps (still open)
- Eligibility at `create` is still checked before its transaction (snapshot then insert). Accept paths are now tight, create is not; target consent remains the real gate.
- No retention/anonymisation POLICY for audit rows of deleted users (FK cascade) beyond `purgeClosed`; no cooldown/abuse limit after terminal states; no scheduler for `expireDue`/`purgeClosed`.
- No HTTP layer, auth, rate limiting, outbox consumer.

## Completed (actually implemented and executed)
- Monorepo skeleton: root manifests, strict tsconfig, `.env.example`, `.gitignore`, `docker-compose.test.yml`, CI workflow (CI itself never run).
- Graph engine (`apps/api/src/graph`): types, eligibility policy, bounded BFS, deterministic ranking, honest completeness semantics,
  in-memory store, `PgGraphStore` (SQL written, not executed).
- Migration `0001_graph_core(.down).sql`, SQL constraint tests, `run-db-tests.sh` (written, NOT executed).
- Tests: see `docs/test-report-slice-1.md`.

## Tests (exact)
(Historical Slice 1 numbers: unit 61/61.) CURRENT after Session 5: type-check clean; unit 71/71; PostgreSQL integration 35/35; DB migration tests PASSED; 0 skipped.

## Session 4 — CI wiring (done)
`.github/workflows/ci.yml` rewritten (npm ci, least-privilege permissions, concurrency, timeout, DB wait, failure-log artifact) + `ci/assert-no-skips.sh`.
Verified locally by simulating every step from a fresh unzip and by 11 negative tests (see docs/test-report-slice-2.md). Actions itself NOT RUN.
FIRST THING next session on a machine with GitHub access: push, open the Actions run, and confirm it is green; fix whatever the real runner shows.

## Session 3 — Slice 2 (see docs/test-report-slice-2.md, docs/architecture.md)
Delivered: migration 0002 (+down, +43 SQL tests), pure state machine + 7 unit tests, `IntroductionService` (create/transition/expireDue/get),
15 PostgreSQL integration tests incl. concurrency + fault injection, harness now applies/tests/rolls back both migrations. All green twice; 3 mutations caught.
Known risks / deliberate gaps (NOT done):
- Eligibility is checked BEFORE the create transaction (snapshot, then insert): the path can change in between. Connector/target accept do NOT re-check the graph.
  The target's own consent is the real gate; revisit if introductions must die when an edge is revoked.
- Service maps every unexpected error to `INTERNAL` and does not log (no logger yet). Add structured logging before any server uses it.
- No HTTP layer, auth, rate limiting, outbox consumer, or scheduler for `expireDue`. `withGraphSnapshot` is used by create but the Slice 3 search endpoint must use it too.
- Outbox/audit rows are deleted with their request when a user is deleted (FK cascade) — no retention/anonymisation policy yet.
- Requester cannot re-request the same triple while one is open; after terminal they can immediately (no cooldown / abuse limit beyond the open cap).
- Contact details are never exchanged by this slice; `accepted` is only the consent outcome.

## Session 2 additions
- `npm run test:all` one-command gate; `test:pgstore` self-resets schema. `withGraphSnapshot` (REPEATABLE READ) + 3 snapshot tests, mutation-checked.
- Resolves the 'no snapshot' risk at store level; callers must use it (not wired yet).

## Gate status (verified earlier)
`npm run test:db` PASSED and `npm run test:pgstore` PASSED (7/7) on real PostgreSQL 16.15; typecheck clean; unit 61/61. Slice 1 acceptance gate is MET.
SQL written earlier was correct as-is — no fixes were required. See `docs/test-report-slice-1.md`.

## Not verified (historical list; PostgreSQL items below are now resolved except concurrency)
- ALL PostgreSQL behaviour: migration syntax, constraints, triggers, rollback, PgGraphStore SQL, store equivalence, concurrency.
  (Resolved: gate met.) Still open: concurrency, snapshot reads.
- `npm install`, Vitest, Fastify, React, Playwright: not installed (no network). No lint. No CI run.
- Previous archive/tests (17 tests, 51-test target): lost, not recovered.

## Known issues / risks / deviations
- Not created yet: apps/web, packages/ui, packages/config, docs/api.md, privacy.md, threat-model.md, deployment.md, e2e tests, Fastify server.
- Tests use `node:test` (not Vitest) because dependencies could not be installed; migrate later if desired.
- `path_limit` is conservative (may be reported when deeper unexplored levels exist).
- Imported edges (when opted in) skip dual confirmation — decision to revisit with the import adapter.
- Pg store reads edges, confirmations, evidence in separate queries (no snapshot); the engine re-verifies confirmations so stale reads fail closed
  for eligibility, but evidence ranking could momentarily differ under concurrent writes. Consider REPEATABLE READ in Slice 3.
- `users` flags vs `consents` rows can diverge until Slice 2 synchronises them. No least-privilege DB roles yet.
- Live-edge uniqueness ignores expiry (expired-but-unrevoked edges block re-creation until revoked).
- Competitor/Meta documentation research (Parts 2, 9) was not performed (no network).

## Next milestone
0. Slice 1 and Slice 2 core are DONE. CI wiring is DONE (unrun on real Actions). Slice 2 gaps (re-check on accept, logging, purge) DONE in Session 5. Next: Slice 3 remainder (real auth, search endpoint, outbox worker, rate limiting).
1. (done) On a machine with Docker/Node + network: `npm install`, `npm run db:up`, `npm run test:db`, `npm run test:pgstore`; fix whatever fails.
   Only then declare Slice 1 complete.
2. Then Slice 2 (introduction system): `0002` migration for introduction_requests / audit_events / notification_outbox, state machine,
   transactional transitions with row locks, idempotency, outbox, concurrency tests on real PostgreSQL.
