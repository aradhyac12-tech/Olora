#!/usr/bin/env bash
# One command: reset schema to migration 0001, then run ALL PostgreSQL store tests. NOT RUN (exit 3) is never a pass.
set -u
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://wcim_test:wcim_test_password@localhost:55432/wcim_test}"
command -v psql >/dev/null 2>&1 || { echo "NOT RUN: psql not found"; exit 3; }
psql "$DATABASE_URL" -X -q -c 'select 1' >/dev/null 2>&1 || { echo "NOT RUN: PostgreSQL not reachable"; exit 3; }
M=database/migrations
down() { psql "$DATABASE_URL" -X -q -f $M/0006_relationship_lifecycle.down.sql >/dev/null 2>&1; psql "$DATABASE_URL" -X -q -f $M/0004_oauth_identities.down.sql >/dev/null 2>&1; psql "$DATABASE_URL" -X -q -f $M/0003_auth.down.sql >/dev/null 2>&1; psql "$DATABASE_URL" -X -q -f $M/0002_introductions.down.sql >/dev/null 2>&1; psql "$DATABASE_URL" -X -q -f $M/0001_graph_core.down.sql >/dev/null 2>&1; }
down
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f $M/0001_graph_core.sql && psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f $M/0002_introductions.sql && psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f $M/0003_auth.sql && psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f $M/0004_oauth_identities.sql && psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f $M/0006_relationship_lifecycle.sql || { echo "FAILED: migration apply"; exit 1; }
node --test "apps/api/tests/pg/*.test.ts"; rc=$?
# leave the DB clean so `npm run test:db` (which requires a clean DB) can run afterwards
down
exit $rc
