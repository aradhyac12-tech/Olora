# Who Can Introduce Me

Warm-introduction discovery over a **contributed, consent-based** relationship graph. Not a social network.

**Status: Slice 0 + Slice 1 (graph core) + Slice 2 (introduction state machine/service, PostgreSQL-verified) rebuilt from the spec. The previous archive was NOT recovered.**
**Setup (Supabase, Google, Render, APK): see `SETUP.md`.** See `HANDOFF.md` for exactly what is and is not verified. PostgreSQL parts now verified on PostgreSQL 16 (see `HANDOFF.md`).

## Slice 4 — relationships, privacy, invitations (see `docs/`)
A user can create a private invitation link, another signed-in user accepts it, and the inviter independently confirms; only then is the relationship eligible for the trusted graph. Profile/privacy settings (private by default), connection management, blocks and reports are in the app. Docs: `relationships-api.md`, `privacy.md`, `threat-model.md`, `database-setup.md`, `env-vars.md`, `test-report-slice-4.md`, `known-limitations-and-next-milestone.md`. Run `npm run test:e2e` for the browser journey (needs Playwright + PostgreSQL).

## Layout (only what exists so far)
- `apps/api/src/graph/` — `types.ts`, `eligibility.ts`, `engine.ts` (bounded BFS), `memoryStore.ts`, `pgStore.ts`
- `apps/api/tests/` — unit tests (`node:test`), independent brute-force reference, `pg/` integration tests
- `apps/api/src/introductions/` — `stateMachine.ts` (pure), `service.ts` (transactional, idempotent, outbox)
- `database/` — `migrations/0001_graph_core`, `0002_introductions`, `0003_auth`, `0004_oauth_identities`, `0006_relationship_lifecycle` (+`.down`), SQL constraint tests, `run-db-tests.sh`
- `apps/api/src/server/` — Fastify app (`app.ts`), `config.ts`, `main.ts`
- `apps/api/src/auth/` — `password.ts` (scrypt), `service.ts` (register/login/sessions)
- `packages/contracts/` — placeholder (empty). `apps/web`, `packages/ui`, `packages/config` are **not created yet** (Slices 3–4+).

## Commands
Requires Node >= 22.18 (runs TypeScript natively; no build step in Slice 1).

    npm run typecheck        # tsc --noEmit (needs typescript + @types/node installed)
    npm test                 # unit tests, no database needed
    npm run db:up            # start PostgreSQL 16 (docker compose), port 55432
    npm run test:db          # apply 0001+0002, constraint tests, rollback, re-apply  (exit 3 = NOT RUN)
    npm run test:all         # typecheck + unit + test:db + test:pgstore (needs psql + running PostgreSQL)
    npm run test:pgstore     # resets schema to 0001 itself; PgGraphStore vs in-memory store (needs DATABASE_URL + `pg`)
    npm run db:down

The sandbox used to build this had no network, so `npm install` was not possible; `vitest`, `pg`, Fastify,
React etc. were **not** installed. Unit tests therefore use Node's built-in runner instead of Vitest.

## Run the API (Fastify)
    cp .env.example .env            # set DATABASE_URL (API_PORT, API_HOST, LOG_LEVEL optional)
    npm run db:up                   # PostgreSQL, then apply database/migrations/0001..0003 (*.sql, not *.down.sql) with psql
    export $(grep -v '^#' .env | xargs)
    npm run start                   # http://127.0.0.1:3000  (GET /healthz)
Accounts and sessions (migration 0003): passwords are stored as salted scrypt hashes, session tokens only as SHA-256 hashes, sessions expire after 30 days and can be revoked.
- `POST /v1/auth/register` `{email,password(10-128),displayName}` -> 201 `{userId}` (409 EMAIL_TAKEN). New accounts are private (not discoverable, no introductions accepted).
- `POST /v1/auth/login` `{email,password}` -> `{token,userId,expiresAt}` (401 INVALID_CREDENTIALS, identical for unknown email / wrong password / inactive account).
- Everything else under `/v1` needs `Authorization: Bearer <token>`: `POST /v1/auth/logout`, `POST /v1/auth/logout-all`, `GET /v1/me`,
  `GET /v1/introductions` (list, `?limit=`), `GET /v1/search?targetId=<uuid>` (connectors who can introduce you, first hop only), `POST /v1/introductions`, `POST /v1/introductions/:id/transitions` (`{"action":"connector_accept|connector_decline|target_accept|target_decline|requester_cancel"}`), `GET /v1/introductions/:id`.
- Writes to introductions need an `Idempotency-Key` header (8-128 chars). Errors are `{"error":{"code":"..."}}` only.
- Register/login are limited to 10 requests/minute per IP (in memory, single instance; behind a proxy set Fastify `trustProxy` first).

## CI
`.github/workflows/ci.yml` runs on push to `main`, pull requests, and manual dispatch: `npm ci`, typecheck, unit tests, `database/run-db-tests.sh`,
`npm run test:pgstore`, against a `postgres:16-alpine` service container. `ci/assert-no-skips.sh` fails the build if any test was SKIPPED,
failed, or if fewer tests ran than the stated minimum (114 unit / 85 PostgreSQL). **When you add tests, raise those minimums in the workflow.**
Logs are uploaded as an artifact on failure. Actions are pinned to major versions (not commit SHAs).
