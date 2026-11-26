# Test report — Slice 4.5 (verification and hardening)

## 1. Environment
Linux sandbox, Node 22.23.5, PostgreSQL 16 (apt, local, port 55432), real fastify 5 / @fastify/rate-limit / pg / zod, Playwright 1.5x driving a Chromium obtained from the npm package `@sparticuz/chromium` (Playwright's own CDN is blocked here; executable passed via `E2E_CHROMIUM_PATH`, flags via `E2E_CHROMIUM_ARGS="--no-sandbox --disable-gpu"`). Do NOT add `--single-process` (it merged browser contexts in an early attempt).

## 2. Commands (clean `rm -rf node_modules && npm ci --include=dev` first)
`npm run typecheck`, `npm test`, `npm run test:db`, `npm run test:pgstore`, `npm run test:e2e`, `npm run build`.

## 3-7. Results
| Command | Result |
|---|---|
| npm ci | PASSED (77 packages) |
| typecheck | PASSED |
| npm test | PASSED 115/115, 0 skipped (114 + 1 new) |
| test:db | PASSED (0001-0004+0006 apply, constraints, rollback, re-apply) |
| test:pgstore | PASSED 89/89, 0 skipped (real PostgreSQL 16) |
| test:e2e | PASSED: relationships journey + new sessions suite, real browser |
| build | PASSED |
| GitHub Actions, Render, Supabase (PG17), Android device/emulator, load tests | NOT RUN |

## 8. Bugs discovered
1. **E2E did not test real auth (test-harness defect).** `e2eServer.ts` used a stub: any password logged in, token = user id, logout did nothing. The earlier "browser e2e passed" therefore proved nothing about sessions or Fastify. Found when a wrong-password login returned 200 against the harness; the production `AuthService` is correct (wrong password = 401, covered by PG tests).
2. **No defence-in-depth response headers.** API responses had no `X-Content-Type-Options`, `Referrer-Policy`, and only some routes had `Cache-Control: no-store` (invitation, connection and profile responses were cacheable by default heuristics).

## 9. Bugs fixed
1. `e2eServer.ts` now runs the real `buildApp` + `AuthService` + services on port+1 and reverse-proxies `/v1` from the static origin (the page CSP is `connect-src 'self' https:`, so plain-http cross-origin cannot be used in tests). Only change vs production: auth rate limit raised for the single test IP.
2. `server/app.ts` `onSend` hook: `nosniff` + `no-referrer` on all responses, `no-store` on every `/v1` response without its own policy. Regression test added in `server.test.ts`; mutation-checked (removing the header line fails it, 18/19; restored 19/19).
Added `tests/e2e/sessions.e2e.mjs` (run by `test:e2e`): reload keeps session; sign-out survives reload; wrong password rejected; unknown/revoked/expired links all show the same "Link unavailable"; withdraw of an outgoing request; API 401 returns to sign-in; network failure shows a retry panel and keeps the session; raw API calls without/with a bad token get 401. Expiry is simulated by disabling the immutability trigger in SQL because the UI cannot create short-lived links.

## 10. Remaining limitations (not fixed, not hidden)
- Phase 4 items without a dedicated test: acceptance-vs-expiry race (expiry is time-based; covered only by the "expired link unavailable" test), relationship-revocation-vs-search (search runs in one REPEATABLE READ snapshot by design; no race test written), multiple introduction requests on one path (covered only by the 20-parallel `target_accept` test).
- Android deep links NOT verified: the repository has no `android/` project (the APK builder generates it), so intent filters cannot be inspected. `olora://invite/<token>` and `olora://target/<token>` are handled in `web/app.js` (`handleDeepLink`) but `android-expected-schemes.txt` only declares the scheme `olora`.
- Token leakage review (code reading + tests, not a pen test): tokens travel in POST bodies and the URL fragment (never sent to the server or in Referrer; page also sets `<meta name=referrer content=no-referrer>`), the client strips the fragment after reading it, Fastify logs redact `Authorization` and only log request URLs (no token in any URL). Not verified: WebView history, Android system share-sheet logs.
- Rate limiter is in-process. Render free plan runs ONE instance, so no Redis was added (not justified). Move to a shared limiter before scaling out; fail closed.
- No security scan/pen test was run; no CSRF surface exists (bearer tokens in `Authorization`, no cookies).

## 11. Production deployment requirements
- `render.yaml` sets `DATABASE_SSL=no-verify` (encrypted but server not authenticated). Before production: set `DATABASE_SSL=verify` and provide Supabase's CA via `NODE_EXTRA_CA_CERTS`. NOT changed here because it needs a certificate file and a deploy to validate.
- Apply `0006_relationship_lifecycle.sql` then `database/supabase/0007_enable_rls_slice4.sql` on Supabase; migrations are applied manually (no runner in deploy).
- Use a non-superuser application role (tests run as superuser); grant only DML on app tables.
- Set `PUBLIC_APP_URL` for shareable links; `TRUST_PROXY=true` only behind Render's proxy.
- Confirm Supabase redirect URL `olora://auth/callback`. The Supabase publishable key in `render.yaml` is a public client key, not a secret.

## 12. Manual Android test procedure
1. Build the APK with the builder; install on a device/emulator. 2. Create a link in the app and send it to the device. 3. `adb shell am start -a android.intent.action.VIEW -d "olora://invite/<43-char-token>"` with: app closed, app in background, signed in, signed out, token used, token revoked. 4. Expect: sign-in prompt when signed out then the invitation preview; "Link unavailable" for used/revoked/expired/unknown. 5. Check `adb logcat` for the token (must not appear). If the intent does not open the app, the builder's manifest lacks the `olora` intent filter.

## Running E2E elsewhere
`npx playwright install chromium` then `DATABASE_URL=... npm run test:e2e`. With a system Chromium: `E2E_CHROMIUM_PATH=/usr/bin/chromium E2E_CHROMIUM_ARGS="--no-sandbox" npm run test:e2e`.
