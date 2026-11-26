# Threat model and security review (Slice 4)

Method: code review of every new file + adversarial tests on real PostgreSQL/HTTP (`relationships.integration`, `routes.integration`, browser e2e). The frontend is never the security boundary: every rule below is enforced by the API and, for the trust rule, again by the database.

| Area | Control | Evidence |
|---|---|---|
| **IDOR** | No relationship/invitation/block function accepts another user's id. Every query is scoped by the session user (participant check in SQL); non-participants get the same 404 as a nonexistent id. Block/report subjects are handles the caller legitimately holds, never user ids | HTTP IDOR test compares real vs fake id responses byte-for-byte; `foreign confirm/revoke/decline/permission` tests |
| **Token leakage** | 256-bit random token, only SHA-256 stored (immutable column), shown once, replay returns `token:null`; never in a query string; stripped from the address bar; fragments are not sent to servers; CSP `referrer: no-referrer` | tests assert raw token absent from invitations, audit, idempotency rows and every list response |
| **Enumeration** | One generic `INVITATION_UNAVAILABLE` for every unusable link; blocked/blocker/own/inactive look identical; malformed tokens never reach SQL; nonexistent connection ids = 404; introduction with dead token = same 422 as "no path" | tests |
| **Brute force** | tokens have 2^256 space; additionally failed lookups lock user (10) and IP (40) per 15 min, with `Retry-After`; locked callers cannot use even valid tokens | HTTP rate-limit test incl. account rotation from one IP |
| **Rate-limit bypass** | per user + per IP + DB quotas (50 active links, 30/day, reports/day, block cap 500) that hold across instances | quota tests. Limit: the in-process limiter is per instance (see limitations) |
| **Consent bypass** | consent and flag change atomically; engine, SQL view and triggers all require both sides; a path is re-validated under locks at create **and** accept | privacy tests; RACE tests |
| **Unauthorized confirmation** | confirm only by the participant whose confirmation is pending; foreign confirmation rows are rejected by DB trigger; a self-confirm cannot complete a relationship; leaked link cannot self-connect (inviter confirms each acceptor) | tests incl. raw SQL attempts |
| **Race conditions** | lock protocol (database-setup.md); block trigger takes the pair lock; path locking in `IntroductionService`; unique live pair index | 10 concurrency tests: concurrent accept (single/bounded/same-user/multi-link), confirm vs revoke, revoke/block/consent changes in flight during create and accept, stress |
| **SQL injection** | parameterised everywhere; the only interpolated fragments are fixed literals/column names or a clamped integer (`SET LOCAL lock_timeout`) | grep review; hostile-string tests |
| **XSS** | all dynamic strings go through `esc()`; avatar only `https:` and rendered with `referrerpolicy=no-referrer`; server validates avatar (no IP literal/localhost/credentials); CSP meta (`script-src 'self'`, no inline script/style) | e2e: `<img onerror>` name and `<b>` note render as text, `window.__xss` stays undefined |
| **Sessions** | unchanged scrypt + hashed bearer tokens; account delete re-checks password; 401 clears the client session | |
| **Private data leakage** | no foreign ids/emails/hashes/ended reasons in responses; errors are codes only | HTTP leak test |
| **Block bypass** | block ends relationships, removes edges (SQL + engine + trigger), makes links unavailable both ways, and is exclusive-locked against in-flight introductions | block tests, race tests |

## Findings
- **Fixed during review:** TxAbort rolled back a lazy expiry write (now returns a failure so it commits); frontend `call()` sent `Content-Type: json` with no body (Fastify 400 – logout never worked server-side; fixed and the API tolerates empty JSON bodies); async re-render wiped typed form input and tab switches showed stale data (draft preservation + refetch per tab).
- **Pre-existing, not changed (documented):** `POST /auth/register` returns EMAIL_TAKEN (account enumeration); authenticated search/introduction responses expose connector/target user ids; legacy `GET /v1/search?targetId=` still accepts a raw id (needs a UUID the caller already holds).
- **Open:** see known limitations.
