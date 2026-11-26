# Test report — Slice 3 (Session 13)
| Check | Result |
|---|---|
| `node --test` all files except server.test.ts | 82 pass, 0 fail, 0 skipped (4 new: search.service) |
| Mutation: search names non-first-hop users | CAUGHT (1 test failed), reverted |
| list SQL on PostgreSQL 16 (psql, migrations 0001-0004) | requester 1, connector 1, target 0 -> 1 after connector accept, stranger 0 |
| `node --check web/app.js`, `npm run build` | ok |
| Headless Chromium + mocked API, light/dark | 0 page errors, flow works |
| server.test.ts (incl. 2 new), typecheck, pg integration tests | NOT RUN (fastify/typescript/pg not installed, no network) |
