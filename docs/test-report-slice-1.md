# Test report — Slice 1 (graph core)

Environment (verification run): Node v22.23.5, `npm install` OK (typescript, @types/node, pg), PostgreSQL 16.15 (apt, native, port 55432 — not the docker image; docker-compose path itself still unexercised), network limited to package registries.
Earlier no-DB results are superseded by the rows below.

| Check | Command | Result |
|---|---|---|
| Type-check | `tsc -p tsconfig.json --typeRoots /opt/npm-tools/node_modules/@types` | **PASSED** (exit 0) |
| Unit tests | `node --test "apps/api/tests/*.test.ts"` | **PASSED** (exit 0): # tests 61 # pass 61 # fail 0 # cancelled 0 # skipped 0  |
| Random cross-check vs brute-force reference | included above (1000 seeds) | **PASSED** — # reference coverage: compared=654 withPaths=244 pathLimitHit=32 |
| PgGraphStore vs memory (real PostgreSQL) | `npm run test:pgstore` (script resets schema, runs pg tests, leaves DB clean) | **PASSED**: # tests 10 # pass 10 # fail 0 # skipped 0 (7 equivalence + 3 snapshot) |
| Migration apply / constraints / rollback / re-apply | `bash database/run-db-tests.sh` | **PASSED**: 36 PASS notices, rollback clean (sentinel intact), re-apply OK |
| Lint | — | NOT RUN (no linter configured/installed) |
| Build | — | N/A (Slice 1 runs TypeScript natively) |
| Playwright / API / security tests | — | NOT RUN (Slices 3+) |

Mutation sanity checks (temporary edits, then restored): allowing one confirmation -> 6 tests failed; ignoring non-adjacent blocks -> 1 failed;
ignoring connector consent -> 3 failed; traversing directed edges backwards -> initially 0 failed (store masked it), after adding
leaky-store tests -> 1 failed. Final restored suite is green.

Note: the previous "17 original tests / 51 passing" suite was lost and is NOT reproduced; this is a fresh suite. Test count (61) is not a claim of parity.

Harness fixed: `npm run test:all` = typecheck + unit + test:db + test:pgstore, run twice back-to-back green. `test:pgstore` now applies 0001 itself and leaves the DB clean (exit 3 = NOT RUN).

Snapshot consistency (new): `withGraphSnapshot(pool, fn)` runs a search in one REPEATABLE READ READ ONLY transaction. Test interleaves a committed confirmation revoke between the edge query and the confirmation query: without snapshot the read is torn (documented hazard, asserted); with snapshot it is consistent; post-snapshot reads see the revoke; client always released, no idle-in-transaction leak.
Mutation check: READ COMMITTED instead of REPEATABLE READ -> snapshot test fails (1 failed); restored -> green.

NOT yet wired: the API/engine entry point does not call withGraphSnapshot yet (Slice 3 server must). Still unverified: write-side concurrency (Slice 2), CI workflow, docker-compose path, lint.
