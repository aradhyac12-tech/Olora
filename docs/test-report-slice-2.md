# Test report — Slice 2 (introductions)

Environment: Node v22.23.5, PostgreSQL 16.15 (apt, native, port 55432), Linux x86_64. Not the docker image; CI not run.

| Check | Command | Result |
|---|---|---|
| Type-check | `npm run typecheck` | **PASSED** |
| Unit (incl. state-machine matrix) | `npm test` | **PASSED**: # tests 68 # pass 68 # fail 0 # skipped 0 (61 graph + 7 state machine) |
| Migrations 0001+0002 apply / constraint tests / rollback / re-apply | `npm run test:db` | **PASSED**: 0002 adds 43 SQL assertions (all PASS); rollback leaves unrelated sentinel intact |
| PG integration (graph store, snapshot, introductions) | `npm run test:pgstore` | **PASSED**: # tests 25 # pass 25 # fail 0 # skipped 0 (15 introduction tests) |
| Whole gate, run twice back-to-back | `npm run test:all` | **PASSED** both times |
| Lint / CI / docker-compose path / Playwright | — | NOT RUN |

## Mutation checks (temporary edits to `service.ts`, then restored; restored suite green)
| Mutation | Tests that failed |
|---|---|
| remove `FOR UPDATE` row lock in `transition` | 3 (racing accept/decline, 20 parallel accepts, same-key parallel) |
| remove per-requester advisory lock in `create` | 3 (same-key concurrent create, duplicate triple, open-request cap) |
| remove BEGIN/COMMIT (no transaction) | 7 (adds atomicity/rollback test) |
Not mutation-tested: `SKIP LOCKED` (without it workers serialise but stay correct under READ COMMITTED, so no test can distinguish it; it is a throughput property).

## Concurrency covered
Same-key create x12; same-triple create x10 (distinct keys); cap 3 of 10 parallel; accept-vs-decline race x10 rounds; 20 parallel accepts;
same-key transition x10; two concurrent expiry workers over 12 due requests; fault-injected outbox failure rolls back create and transition.

## CI verification (session 4)
| Check | Result |
|---|---|
| `actionlint` 1.7.7 on `.github/workflows/ci.yml` | **PASSED** (no findings); YAML parses |
| Every CI step run in order from a FRESH unzip of the deliverable (no node_modules, empty DB), `bash -eo pipefail`, `npm ci` | **PASSED**: typecheck, 68 unit, migrations, 25 PG; guard reports 0 skipped |
| GitHub Actions itself (runner, service container, cache, artifact upload) | **NOT RUN** — no way to execute it here |

Negative tests (CI must go RED), all confirmed red: skipped tests (synthetic and a REAL pg run without DATABASE_URL: 25 skipped), a failing test
(synthetic and a REAL broken assertion), tests silently deleted, missing summary, unreachable DB for `test:db` and `test:pgstore` (exit 3 propagates
through `| tee` thanks to pipefail), a REAL type error, a REAL broken migration constraint. All edits were reverted; suite green afterwards.
Known CI limits: minimum test counts are hard-coded in the workflow; third-party actions are not SHA-pinned; runner psql is assumed (falls back to apt install).


## Session 5 — gap closure (re-check on accept, structured logging, retention)
Environment: Node v22.23.5, PostgreSQL 16 (Ubuntu apt, port 55432), `npm ci` from lockfile. Docker/GitHub Actions NOT used.

| Check | Result |
|---|---|
| Baseline before changes | typecheck clean; unit 68/68; PostgreSQL 25/25; db migration tests PASSED; 0 skipped |
| After changes, `npm run test:all` run 1 and run 2 | typecheck clean; unit 71/71; PostgreSQL 35/35; db migration tests PASSED; 0 skipped (both runs) |

New tests: 3 unit (`introductions.logger.test.ts`), 10 PostgreSQL (`pg/introductions.gaps.integration.test.ts`).

Mutation checks (code broken, suite run, code restored; restored code re-verified green):
| Mutation | Result |
|---|---|
| `recheckOnAccept` default false | CAUGHT (4 failed: re-check x3, logging) |
| Logger records driver message instead of error class | CAUGHT (logging test) |
| `purgeClosed` ignores undelivered outbox rows | CAUGHT (retention test) |
| `purgeClosed` ignores terminal-status filter | NOT caught — equivalent mutant: DB constraint `intro_terminal_has_decided_at` already makes `decided_at` non-null only for terminal rows, so the filter is redundant. Kept as defense in depth. |
| Re-check takes a second pooled connection (`withGraphSnapshot(this.pool)`) | CAUGHT — suite deadlocks on a pool of 4; the test now has a 20 s timeout so it FAILS instead of hanging (confirmed). |

Not verified: concurrent revoke racing an in-flight accept check (the check reads with per-statement snapshots on the locked connection; a revoke committing
mid-check can still lose the race — inherent, target/connector consent remains the gate). GitHub Actions: NOT RUN.


## Session 6 — Fastify scaffold
`npm run test:all` x2: typecheck clean; unit 78/78 (+7: tokens, config, auth gate, create mapping, validation, error mapping, 500 leak); PostgreSQL 36/36 (+1 full HTTP flow); db migration tests PASSED; 0 skipped.
Manual process check (real `npm run start` + curl): healthz 200, no token 401, create 201, connector_accept 200 with status pending_target, placeholder SECRET refused at startup, SIGTERM logged "shutting down" and exited, no `authorization` in server log.
Mutation checks for the HTTP layer: NOT RUN this session. Concurrency is covered at service level only.


## Session 7 — real authentication
`npm run test:all` (see below for run count): typecheck clean; unit 82/82 (+4 net); PostgreSQL 43/43; db migration tests PASSED incl. 0003 (13 assertions); 0 skipped.
Mutation checks (all CAUGHT): authenticate ignores revocation (2 tests failed), ignores expiry, ignores account status; login accepts inactive accounts; login stores raw token (5 failed).
Found by a failing test: rate limiter inactive because routes were defined before the plugin loaded — fixed by registering routes in a child plugin.
Real process (curl): register 201, duplicate 409, bad login 401, login 200, /v1/me 200, logout 204, /v1/me 401 afterwards, 12 bad logins => 8x401 then 429, 0 occurrences of token/password in server log.
Not verified: timing equality of the unknown-email path (dummy-hash design only, not measured); behaviour behind a proxy; GitHub Actions NOT RUN.
