# Known limitations (Slice 4)

> Update (follow-up session): items 1-3 below were resolved with network access - Fastify glue, real `pg`, and the regenerated lockfile now run green (unit 114/114, PG 88/88, db tests PASSED). One regression was found and fixed (login 403 -> 401). Items 4+ remain.

1. **Fastify glue not executed here.** The build sandbox had no network, so `fastify` and `@fastify/rate-limit` were not installed. `server/app.ts` registration, `server.test.ts`, `db.diagnostics.test.ts` and `server.integration.test.ts` could **not** run in this environment (they fail with `ERR_MODULE_NOT_FOUND`, not skipped). The same route table was exercised through a `node:http` adapter and the browser. CI (`npm ci`, real Fastify) must be the first full run; expect to fix typing details in `app.ts` if any.
2. **Lockfile.** `zod` and `playwright` were added to package.json; `package-lock.json` must be regenerated with `npm install` (it was already out of sync before this slice; CI uses `npm ci`). `render.yaml` uses `npm install` for that reason.
3. **PostgreSQL test client.** Real-PG tests ran through a minimal wire-protocol client (`tests/support/miniPg.ts`) plus a local, untracked `node_modules/pg` shim because `pg` could not be installed. CI uses real `pg`. The shim is not shipped.
4. **Rate limiter is per process.** Fine for one Render instance; with several, DB quotas remain the ceiling but per-minute limits multiply.
5. **Single-process housekeeping.** Expiry sweep is a 10-minute timer; reads already treat overdue pending relationships as ended.
6. **No email/push delivery** of invitations (links are shared by the user). The outbox exists from Slice 2 but has no sender.
7. **No identity verification.** Names and handles are self-declared (labelled so). No Instagram/OAuth linking, scraping or claims.
8. **Reports** are stored only; there is no moderation UI.
9. **Native app links.** Web links use `#/i/<token>`; Capacitor builds need `PUBLIC_APP_URL` or paste-a-code. `olora://invite/<token>` and `olora://target/<token>` are handled in app.js but the Android intent filter / `android-expected-schemes.txt` was not changed or tested.
10. **Not run:** real Render/Supabase, device/APK, Supabase PG17, GitHub Actions, load/soak testing, accessibility audit beyond keyboard/labels.
11. Hard-delete of an account removes audit rows that reference it (privacy over forensics).

# Next milestone (suggested)
1. Run CI, regenerate the lockfile, fix any Fastify typing issues.
2. Invitation delivery (email/share-sheet + deep-link intent filters) and push for pending confirmations.
3. Introduction UX: show the confirmed chain, connector-side consent copy, notifications from the outbox.
4. Moderation tooling for reports; shared (Redis/DB) rate limiter.
5. Optional verified external identities via real OAuth, only where the provider supports it.
