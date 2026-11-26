#!/usr/bin/env bash
# Verifies migrations 0001+0002+0003+0004+0006: apply, constraint tests, rollback in reverse order (without touching unrelated objects), re-apply.
# Exit codes: 0 = PASSED, 1 = FAILED, 3 = NOT RUN (no PostgreSQL reachable). NOT RUN is never a pass.
set -u
cd "$(dirname "$0")/.."
DB_URL="${DATABASE_URL:-postgres://wcim_test:wcim_test_password@localhost:55432/wcim_test}"
M=database/migrations; T=database/tests

if command -v psql >/dev/null 2>&1; then
  q() { psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
elif command -v docker >/dev/null 2>&1 && docker compose -f docker-compose.test.yml ps --status running 2>/dev/null | grep -q postgres; then
  q() { docker compose -f docker-compose.test.yml exec -T postgres psql -U wcim_test -d wcim_test -X -q -v ON_ERROR_STOP=1 "$@"; }
else
  echo "NOT RUN: no psql and no running docker postgres. Start one: npm run db:up"; exit 3
fi
if ! q -c 'select 1' >/dev/null 2>&1; then echo "NOT RUN: PostgreSQL not reachable at DATABASE_URL"; exit 3; fi

fail() { echo "FAILED: $1"; exit 1; }
count_objs() { q -At -c "select (select count(*) from information_schema.tables where table_schema='public' and table_name in ('users','external_profiles','relationships','relationship_evidence','relationship_confirmations','consents','blocks','introduction_requests','introduction_idempotency','audit_events','notification_outbox','user_credentials','auth_sessions','oauth_identities','invitations','invitation_redemptions','reports','relationship_audit_events','mutation_idempotency','wcim_trusted_relationships')) + (select count(*) from pg_proc where proname like 'wcim\_%')"; }

q -c 'drop table if exists unrelated_sentinel; create table unrelated_sentinel(id int primary key);' || fail "sentinel setup"
q -c 'insert into unrelated_sentinel values (1);' || fail "sentinel insert"
[ "$(count_objs)" = "0" ] || fail "database not clean before test (drop wcim objects first)"

up_all()   { q -f $M/0001_graph_core.sql && q -f $M/0002_introductions.sql && q -f $M/0003_auth.sql && q -f $M/0004_oauth_identities.sql && q -f $M/0006_relationship_lifecycle.sql; }
down_all() { q -f $M/0006_relationship_lifecycle.down.sql && q -f $M/0004_oauth_identities.down.sql && q -f $M/0003_auth.down.sql && q -f $M/0002_introductions.down.sql && q -f $M/0001_graph_core.down.sql; }

echo "== apply up (0001-0004, 0006)";  up_all || fail "apply up"
[ "$(count_objs)" = "32" ]       || fail "expected 20 tables/views + 12 functions after up, got $(count_objs)"
for t in 0001_graph_core 0002_introductions 0003_auth 0004_oauth_identities 0006_relationship_lifecycle; do
  echo "== constraint tests $t"; q -f $T/$t.test.sql 2>&1 | tee /tmp/wcim_dbtest_$t.log | grep -E 'PASS|FAIL' ; [ "${PIPESTATUS[0]}" = "0" ] || fail "constraint tests $t"
done
echo "== rollback (0006, 0004, 0003, 0002, 0001)"; down_all || fail "apply down"
[ "$(count_objs)" = "0" ]        || fail "rollback left wcim objects behind"
[ "$(q -At -c 'select count(*) from unrelated_sentinel')" = "1" ] || fail "rollback damaged unrelated objects"
echo "== fresh re-apply";         up_all || fail "re-apply up"
[ "$(count_objs)" = "32" ]       || fail "re-apply incomplete"
down_all || fail "final down"
q -c 'drop table unrelated_sentinel;' || fail "sentinel cleanup"
echo "PASSED: migrations 0001+0002+0003+0004+0006 apply, constraint tests, rollback, re-apply"
