# Test report — Session 14 (sign-in "Server error.")
| Check | Result |
|---|---|
| `npm run typecheck` | PASSED (no errors) |
| `npm test` | 108 pass / 0 fail / 0 skipped (before: 99/100, search rate-limit test failing) |
| `npm run test:pgstore` (PG 16.x local) | 43/43 |
| `npm run test:db` | PASSED (apply, constraints, rollback, re-apply) |
| Real server vs TLS-enforcing PG: plain / sslmode=require / wrong pw / DATABASE_SSL=no-verify | reasons tls / tls / auth / OK (readyz 200, login token) |
| Idle-connection kill, with vs without `pool.on('error')` | alive / DEAD (mutation) |
| Mutations: stripSslParams no-op; auth checked before tls | both CAUGHT by tests |
| Render deploy, Supabase, Google round trip, APK, GitHub Actions | NOT RUN |
