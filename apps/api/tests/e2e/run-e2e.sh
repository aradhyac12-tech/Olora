#!/usr/bin/env bash
# Browser e2e for the relationship milestone. Needs: PostgreSQL (DATABASE_URL), psql, Playwright + Chromium (npm i -D playwright && npx playwright install chromium).
# Exit 3 = NOT RUN (never a pass). Screenshots land in $E2E_SHOTS (default ./e2e-shots).
set -u
cd "$(dirname "$0")/../../../.."
export DATABASE_URL="${DATABASE_URL:-postgres://wcim_test:wcim_test_password@localhost:55432/wcim_test}"
command -v psql >/dev/null 2>&1 || { echo "NOT RUN: psql not found"; exit 3; }
psql "$DATABASE_URL" -X -q -c 'select 1' >/dev/null 2>&1 || { echo "NOT RUN: PostgreSQL not reachable"; exit 3; }
node -e "require('playwright')" 2>/dev/null || { echo "NOT RUN: playwright not installed"; exit 3; }
M=database/migrations; PORT="${E2E_PORT:-4173}"; TMP="$(mktemp -d)"; SHOTS="${E2E_SHOTS:-./e2e-shots}"
down() { for m in 0006_relationship_lifecycle 0004_oauth_identities 0003_auth 0002_introductions 0001_graph_core; do psql "$DATABASE_URL" -X -q -f $M/$m.down.sql >/dev/null 2>&1; done; }
trap 'kill $SRV 2>/dev/null; down; rm -rf "$TMP"' EXIT
down
for m in 0001_graph_core 0002_introductions 0003_auth 0004_oauth_identities 0006_relationship_lifecycle; do psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f $M/$m.sql || { echo "FAILED: migration $m"; exit 1; }; done
cp -r web "$TMP/web"
echo "window.APP_CONFIG={\"apiBase\":\"http://127.0.0.1:$PORT\",\"supabaseUrl\":\"\",\"supabaseAnonKey\":\"\",\"appScheme\":\"olora\",\"publicUrl\":\"http://127.0.0.1:$PORT/\"};" > "$TMP/web/config.js"
node apps/api/tests/e2e/e2eServer.ts "$TMP/web" "$PORT" & SRV=$!
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.3; done
node apps/api/tests/e2e/relationships.e2e.mjs x "http://127.0.0.1:$PORT" "$SHOTS" || exit $?
node apps/api/tests/e2e/sessions.e2e.mjs x "http://127.0.0.1:$PORT" "$SHOTS"
