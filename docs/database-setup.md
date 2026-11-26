# Database setup

Migrations (apply in order with `psql -v ON_ERROR_STOP=1 -f`): `0001_graph_core`, `0002_introductions`, `0003_auth`, `0004_oauth_identities`, **`0006_relationship_lifecycle`** (Slice 4; 0005 is Supabase-only RLS). Each has a `.down.sql`; rollback runs in reverse (0006 first) and is tested, including re-apply.

0006 adds: `invitations`, `invitation_redemptions`, `reports`, `relationship_audit_events` (append-only), `mutation_idempotency`; columns on `relationships` (ended_reason, ended_by, initiated_by, confirm_by, invitation_id) and `relationship_confirmations.allows_traversal`; the `wcim_trusted_relationships` view; guard triggers; block triggers (advisory pair lock + end live relationships); `users_avatar_https` check (NOT VALID, so existing rows are not rejected).

Supabase: after the migrations run `database/supabase/0007_enable_rls_slice4.sql` (RLS on, no policies, for the 5 new tables; same pattern as 0005). The API connects as the table owner and bypasses RLS.

Local/CI: `npm run db:up`, `npm run test:db` (apply, constraint tests, rollback, re-apply), `npm run test:pgstore` (resets schema, applies 0001-0004+0006, runs all PostgreSQL integration tests), `npm run test:e2e` (browser).

Locking contract (never reorder): 1) pair advisory locks `wcim_pair_lock_key(a,b)` in sorted order (blocks: exclusive via trigger; path users: shared), 2) `users` rows FOR SHARE in id order, 3) relationship rows FOR SHARE in id order (revoke/confirm/permission: FOR UPDATE). READ COMMITTED + explicit locks; `SET LOCAL lock_timeout`; retry on 40001/40P01.
