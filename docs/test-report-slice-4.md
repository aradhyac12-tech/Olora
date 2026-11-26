# Test report — Slice 4 (exact results from the build environment)

Environment: Linux, Node 22.23.5, PostgreSQL 16 (local, port 55432), Chromium via Playwright. **No network**: `fastify`, `@fastify/rate-limit`, `pg` (real) and `zod` types were not installable; see limitations.

## Baseline (before changes, Phase 1)
PostgreSQL integration suite: 42 tests, 41 pass, 1 fail (`server.integration.test.ts` — `fastify` not installed). Existing auth test #5 had a stale assertion (service returns a `detail`); corrected in this slice. DB SQL harness: passed.

## After Slice 4
| Suite | Result |
|---|---|
| `node --test "apps/api/tests/*.test.ts"` (unit, no DB) | 90 tests: **88 pass, 2 fail, 0 skipped**. The 2 failures are whole files that cannot load: `db.diagnostics.test.ts`, `server.test.ts` → `ERR_MODULE_NOT_FOUND: fastify`. **Not run, not passed.** New `social.unit.test.ts`: 6/6 pass |
| `npm run test:db` (SQL harness) | **PASSED** — migrations 0001-0004+0006 apply, constraint tests (0001: 38, 0002: 42, 0003: 13, 0004: 4, **0006: 47** PASS checks, 0 FAIL), rollback in reverse order, fresh re-apply |
| `npm run test:pgstore` (real PostgreSQL) | 87 tests: **86 pass, 1 fail, 0 skipped**. The 1 failure is `server.integration.test.ts` (`fastify` missing) — **not run**. New: `relationships.integration` 38 tests, `routes.integration` 7 tests; existing introduction/pgstore/auth suites pass against the modified `IntroductionService` |
| Browser e2e (`npm run test:e2e`) | **PASSED** (4 consecutive passing runs after fixing test-side races; the earlier failures were test selector bugs plus two real UI bugs, listed in threat-model.md). 3 browser contexts, real UI + route table + PostgreSQL |

## Phase 9 coverage (all on real PostgreSQL)
invitation creation · token entropy/hash-only storage · expiration · revocation (incl. foreign revoke) · replay · wrong-user acceptance · duplicate invitations (incl. reverse direction) · mutual confirmation · one-sided rejection · foreign confirmation rejection (service **and** raw SQL) · confirmation revocation · relationship revocation (terminal, reason hidden) · block both directions · discoverability off · introduction permission off · unauthorized profile/privacy edits (no foreign-id parameter exists; foreign identity removal is a no-op) · search after connect / after revoke · concurrent accept (single-use, bounded 3-of-8, same user, four links same pair) · concurrent confirm vs revoke ×12 · revoke vs introduction create (in-flight uncommitted change blocks creation; revoke arriving mid-create waits, then acceptance is refused) · block vs create (3 pair positions) · consent revoke vs create · stress ×20 (creates racing revoke/block/consent changes: no errors, no deadlocks, nothing deliverable on an invalid path) · rollback releases locks · privacy update atomicity (forced consent-write failure rolls back the flag).

## Browser e2e journey
Ann (hostile display name) registers → privacy defaults off → creates invitation → Bob opens the link signed-out (token removed from the address bar) → registers → preview → accepts → Ann sees "Needs your answer" → confirms → both see Connected → Bob pauses/resumes introductions → a third user sees "Link unavailable" for the used link → Ann turns on discoverability, creates a find-me link → Cara searches by link (honest "no route yet") → Bob blocks Ann → Ann sees only "Ended", no mention of blocking → no horizontal overflow on any tab at 390 px → 0 page/console errors; `<img onerror>` / `<b>` rendered as text.

## Not verified
Fastify registration (`server/app.ts`) and anything importing it; real `pg` driver (tests used a minimal wire-protocol client); GitHub Actions; Render/Supabase deploy; APK/device; Supabase PG17; load testing; multi-instance behaviour. CI thresholds were raised to 114 unit / 85 PostgreSQL tests, plus an e2e step — **unrun on Actions**.


## Follow-up run (network available)
Environment: Node 22.23.5, PostgreSQL 16.15 (apt, local), real fastify 5 / @fastify/rate-limit / pg / zod.
| Check | Result |
|---|---|
| `npm install` then clean-copy `npm ci` | OK (77 packages) |
| `npm run typecheck` | clean |
| `npm test` | first run 111/114 (3 FAILED: login 403!=401, login rate limit, oauth); after fix **114/114, 0 skipped** |
| `npm run test:db` | PASSED |
| `npm run test:pgstore` | **88/88, 0 skipped** |
| `npm run test:e2e` | NOT RUN (Chromium cannot be downloaded here) |
| GitHub Actions / Render / Supabase / device | NOT RUN |

Defect: `STATUS.INVALID_CREDENTIALS` was 403 (Slice 4) vs documented 401. Fixed in `server/status.ts`; `/v1/account/delete` keeps 403 for a wrong password (client signs out on 401). No mutation check recorded for this fix; no HTTP-level test for the delete-account 403 yet.

Addendum: HTTP test for delete-account 403 added; mutation (403->401) caught (88/89), restored 89/89. Unit 114/114, test:db PASSED. e2e/Actions/Render/device still NOT RUN.

## Verification run before packaging (Node 22.23.5, PostgreSQL 16, real fastify/pg/zod)
| Check | Result |
|---|---|
| `npm ci --include=dev` | PASSED |
| `npm run typecheck` | PASSED |
| `npm test` | PASSED 114/114, 0 skipped |
| `npm run test:db` | PASSED (0001-0004+0006 apply, constraints, rollback, re-apply) |
| `npm run test:pgstore` | PASSED 89/89, 0 skipped |
| `npm run test:e2e` | NOT RUN (Playwright Chromium download fails in this sandbox) |
| GitHub Actions / Render / Supabase PG17 / device | NOT RUN |
