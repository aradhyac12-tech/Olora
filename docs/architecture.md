# Architecture (Slice 1)

Modular monolith; PostgreSQL is the source of truth; no graph DB. The engine is storage-agnostic:

    findIntroductionPaths(store: GraphStore, source, target, options) -> SearchResult

## Engine semantics
- Bounded BFS over partial paths, level by level (hops ascending). Neighbours visited in id order.
- Work budget = edges loaded + path extensions considered. Limits: hops<=6, paths<=50, work<=1e6, edges/node<=10000.
- `scope` is always `contributed_graph`. `stopReason`: `exhausted | path_limit | work_limit | data_limit | target_unavailable`.
  `complete === (stopReason === 'exhausted')`, meaning the space within `maxHops` was exhausted.
- `path_limit` is conservative: reported whenever more paths exist or deeper levels remain unexplored after maxPaths is reached.
- `shortestWithinScope` is true only if paths exist, the shortest level was fully processed, and no data was truncated before then.
- `target_unavailable` is returned identically for missing / inactive / non-discoverable / blocked targets and for source==target.
  A missing or inactive *source* throws `SOURCE_UNAVAILABLE` (caller is authenticated, so this is a server-side fault).
- Store failures are wrapped in a generic `STORE_FAILURE` (no internals leaked); the engine fails closed.

## Eligibility (default policy) — `eligibility.ts`
Counts only: not revoked, not expired (`expiresAt <= now` is expired), permission `granted`, verification `confirmed`,
`confirmedAt` set, type in {acquaintance, colleague, classmate, family, community_member} AND live confirmations from
BOTH actual participants. `one_sided` and `social_follow` never count. `imported` counts only with `includeImported`
(still needs verified + granted; no dual confirmation — a documented design decision, revisit with the import adapter).
`directed` edges are traversed source->target only.

## Users on a path
Source must be active. Every intermediate user must be active and `acceptsIntroductions`. The target must be active and
`discoverable` (it need not accept introductions). No two users on a path may have a block in either direction.

## Parallel edges / ranking
Between two users the best eligible edge is chosen per hop (strength desc, latest evidence desc, confirmedAt desc, id asc).
Paths rank by: hops asc, weakest-link evidence strength desc, max evidence age asc, oldest confirmation desc, edge ids, user ids.
Evidence strength: verified_identity_link 4, shared_community 3, user_asserted 2, imported_record 1. No evidence = 0 / infinitely stale.
Ranking does not depend on input/row order. Edge ids are compared as strings; for PostgreSQL uuids (lowercase hex) this equals `ORDER BY id`.

## Store contract
See `GraphStore` in `types.ts`. Stores prefilter for efficiency and bounded reads; the engine re-verifies everything.

# Slice 2 — introduction system

Files: `database/migrations/0002_introductions(.down).sql`, `apps/api/src/introductions/{stateMachine,service}.ts`.

## Flow
requester -> connector -> target. `create` requires an eligible 2-hop graph path requester->connector->target (engine, maxHops 2, run in a
REPEATABLE READ snapshot; fails closed, reason never revealed). States:
`pending_connector -> pending_target -> accepted`; any open state -> `cancelled` (requester) / `expired` (system, or lazily when acted on);
`declined` by connector (from pending_connector) or target (from pending_target). Terminal states are final.

## Privacy rules (enforced in `decide`, tested)
- Non-participants always get NOT_FOUND (existence never revealed). The target cannot see the request until the connector accepted
  (`connector_accepted_at`), and is never notified if the connector declines or the requester cancels before that.
- Wrong role = FORBIDDEN; wrong state = INVALID_STATE; due request = EXPIRED (and the expiry is persisted in the same transaction).
- Outbox payloads carry ids only (no message text, no profile data).

## Transaction discipline
Every state change is ONE transaction: `SELECT .. FOR UPDATE` -> pure `decide` -> `UPDATE` + `audit_events` + `notification_outbox`.
Create additionally takes `pg_advisory_xact_lock(hash(requester))`, which makes the open-request cap and duplicate check exact.
`created_at`/`expires_at` use the DB clock. No code path holds one pooled connection while waiting for another (tests use a pool of 4
against 10-20 concurrent callers to prove it).
Idempotency: create = `(user, key)` row with a request hash (same key + different payload => IDEMPOTENCY_CONFLICT); transitions = unique
`(request, actor, key)` in audit. Replays return the current record with `replayed: true`.
Defense in depth in SQL: guard trigger rejects illegal/terminal transitions and party/message/expiry edits; audit is append-only (UPDATE
blocked); `outbox_once` unique constraint prevents double notification; partial unique index allows one open request per triple.

## Workers
`expireDue(limit)` uses `FOR UPDATE SKIP LOCKED`; safe to run from several workers. Nothing schedules it yet. The outbox has no consumer yet.

## Slice 2 addenda (Session 5)
- **Re-check on accept**: `connector_accept`/`target_accept` call the engine (maxHops 2) via `PgGraphStore` on the SAME connection after the `FOR UPDATE` lock. Not eligible => `NOT_ELIGIBLE`, nothing written. Option `recheckOnAccept` (default true).
- **Logging**: injected `Logger` port (`introductions/logger.ts`); ids/codes/counts only; errors as class + SQLSTATE.
- **Retention**: `purgeClosed(olderThanMs>=24h, limit)`; terminal + old + no undelivered outbox; cascades; SKIP LOCKED.

# Slice 3 — search and list (Session 13)
`GET /v1/search?targetId=` -> `SearchService` (engine, maxHops 3, REPEATABLE READ snapshot). Reveals only first-hop connectors; "unavailable target" and "no path" are the same response; id-only lookup (no enumeration); 30/min/IP.
`GET /v1/introductions` -> `IntroductionService.list`, visibility identical to `canSee` (target sees a request only after the connector accepted).


# Slice 4 — relationship foundation
- `apps/api/src/social/`: `invitations.ts`, `connections.ts`, `profile.ts`, `safety.ts`, `account.ts` (services, transactional, `Out<T>` results), `routes.ts` (framework-agnostic route table registered by `server/app.ts`), `db.ts` (withTx: lock_timeout + retry on 40001/40P01, audit), `locks.ts` (lock protocol), `tokens.ts`, `rateLimit.ts`, `connectionView.ts`. Contracts (Zod + view types): `src/contracts/index.ts`. Status codes: `server/status.ts`.
- Lifecycle states are derived from existing columns: `revoked_at` set → ended; `verification_status='confirmed'` → confirmed; else pending until `confirm_by`. Per-participant `allows_traversal` pauses a relationship without ending it.
- Flow: A creates a link → B accepts (relationship created, B confirmed, A pending) → A confirms → both confirmations active ⇒ `wcim_trusted_relationships` / `PgGraphStore` include the edge. Graph engine unchanged; `PgGraphStore` additionally filters blocked pairs in SQL.
- `IntroductionService` now locks the path (pair advisory locks → users → relationship rows) inside the creating/accepting transaction and re-checks eligibility there (`afterPathLocked` is a test seam).
- Frontend: same vanilla JS app, new tabs (Find, Connections, Invitations, Profile/Privacy), `#/i/<token>` and `#/t/<token>` landing, event delegation, draft preservation, per-tab refetch.
- API reference: `relationships-api.md`; privacy: `privacy.md`; threats: `threat-model.md`; DB: `database-setup.md`; env: `env-vars.md`; results: `test-report-slice-4.md`.

## Slice 4.5 notes
All API responses carry `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; `/v1/*` defaults to `Cache-Control: no-store`. The browser e2e harness (`apps/api/tests/e2e/e2eServer.ts`) runs the production `buildApp` with real auth. See `docs/test-report-slice-4-5.md` for deep-link, TLS and deployment requirements.
