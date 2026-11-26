-- Constraint tests for 0001_graph_core. Run via database/run-db-tests.sh (psql -v ON_ERROR_STOP=1).
-- Everything runs inside one transaction that is rolled back. UNVERIFIED until executed on real PostgreSQL.
BEGIN;

CREATE FUNCTION pg_temp.expect_error(stmt text, state text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = state THEN RAISE NOTICE 'PASS: %', label; RETURN; END IF;
    RAISE EXCEPTION 'FAIL: % — expected SQLSTATE % but got % (%)', label, state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL: % — statement succeeded but should have failed', label;
END $$;

CREATE FUNCTION pg_temp.expect_ok(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL: % — unexpected error % (%)', label, SQLSTATE, SQLERRM;
  END;
  RAISE NOTICE 'PASS: %', label;
END $$;

CREATE FUNCTION pg_temp.expect_true(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;

-- fixtures: users a,b,c,d. created_at is set in the past so expiry/ordering checks are meaningful.
INSERT INTO users (id, email, display_name) VALUES
 ('00000000-0000-4000-8000-00000000000a','a@example.test','A'),
 ('00000000-0000-4000-8000-00000000000b','b@example.test','B'),
 ('00000000-0000-4000-8000-00000000000c','c@example.test','C'),
 ('00000000-0000-4000-8000-00000000000d','d@example.test','D');

SELECT pg_temp.expect_true((SELECT NOT discoverable AND NOT accepts_introductions FROM users WHERE email='a@example.test'), 'user defaults: discoverable=false, accepts_introductions=false');
SELECT pg_temp.expect_error($$INSERT INTO users (email, display_name) VALUES ('a@example.test','dup')$$, '23505', 'duplicate email rejected');
SELECT pg_temp.expect_error($$INSERT INTO users (email, display_name) VALUES ('Upper@example.test','x')$$, '23514', 'non-normalized email rejected');
SELECT pg_temp.expect_error($$INSERT INTO users (email, display_name, account_status) VALUES ('s@example.test','x','banana')$$, '23514', 'invalid account status rejected');

-- relationships
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000a','acquaintance')$$, '23514', 'self edge rejected');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-0000000000ff','acquaintance')$$, '23503', 'unknown user FK rejected');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type, direction) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b','acquaintance','sideways')$$, '23514', 'invalid direction rejected');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b','bestie')$$, '23514', 'invalid relationship type rejected');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type, created_at, expires_at) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b','acquaintance', now(), now() - interval '1 day')$$, '23514', 'expiry before creation rejected');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type, verification_status) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b','acquaintance','confirmed')$$, '23514', 'confirmed without confirmed_at rejected');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type, verification_status, confirmed_at) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b','acquaintance','confirmed', now())$$, '23514', 'pre-confirmed non-imported relationship rejected');
SELECT pg_temp.expect_ok($$INSERT INTO relationships (id, source_user_id, target_user_id, relationship_type, verification_status, confirmed_at, permission_status) VALUES ('00000000-0000-4000-8000-0000000000e9','00000000-0000-4000-8000-00000000000c','00000000-0000-4000-8000-00000000000d','imported','confirmed', now(), 'granted')$$, 'imported relationship may be inserted verified');

INSERT INTO relationships (id, source_user_id, target_user_id, relationship_type) VALUES
 ('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b','acquaintance');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b','acquaintance')$$, '23505', 'duplicate live mutual edge rejected');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type) VALUES ('00000000-0000-4000-8000-00000000000b','00000000-0000-4000-8000-00000000000a','acquaintance')$$, '23505', 'reversed duplicate live mutual edge rejected');
SELECT pg_temp.expect_ok($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b','colleague')$$, 'same pair, different type allowed');
UPDATE relationships SET revoked_at = now() WHERE id = '00000000-0000-4000-8000-0000000000e1';
SELECT pg_temp.expect_ok($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type) VALUES ('00000000-0000-4000-8000-00000000000b','00000000-0000-4000-8000-00000000000a','acquaintance')$$, 'edge may be re-created after revocation');
INSERT INTO relationships (source_user_id, target_user_id, relationship_type, direction) VALUES
 ('00000000-0000-4000-8000-00000000000c','00000000-0000-4000-8000-00000000000a','family','directed');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type, direction) VALUES ('00000000-0000-4000-8000-00000000000c','00000000-0000-4000-8000-00000000000a','family','directed')$$, '23505', 'duplicate live directed edge rejected');
SELECT pg_temp.expect_ok($$INSERT INTO relationships (source_user_id, target_user_id, relationship_type, direction) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000c','family','directed')$$, 'opposite directed edge is distinct');

-- confirmations: use a fresh pair c<->b
INSERT INTO relationships (id, source_user_id, target_user_id, relationship_type) VALUES
 ('00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-00000000000c','00000000-0000-4000-8000-00000000000b','acquaintance');
SELECT pg_temp.expect_error($$INSERT INTO relationship_confirmations (relationship_id, confirming_user_id, confirmation_status, confirmed_at) VALUES ('00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-00000000000d','confirmed', now())$$, '23514', 'confirmation by non-participant rejected');
SELECT pg_temp.expect_error($$INSERT INTO relationship_confirmations (relationship_id, confirming_user_id, confirmation_status) VALUES ('00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-00000000000c','confirmed')$$, '23514', 'confirmed status without timestamp rejected');
INSERT INTO relationship_confirmations (relationship_id, confirming_user_id, confirmation_status, confirmed_at) VALUES
 ('00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-00000000000c','confirmed', now());
SELECT pg_temp.expect_error($$INSERT INTO relationship_confirmations (relationship_id, confirming_user_id) VALUES ('00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-00000000000c')$$, '23505', 'duplicate confirmation by same user rejected');
SELECT pg_temp.expect_error($$UPDATE relationships SET verification_status='confirmed', confirmed_at=now() WHERE id='00000000-0000-4000-8000-0000000000e2'$$, '23514', 'cannot mark confirmed with only one confirmation');
INSERT INTO relationship_confirmations (relationship_id, confirming_user_id, confirmation_status, confirmed_at) VALUES
 ('00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-00000000000b','confirmed', now());
SELECT pg_temp.expect_ok($$UPDATE relationships SET verification_status='confirmed', confirmed_at=now(), permission_status='granted' WHERE id='00000000-0000-4000-8000-0000000000e2'$$, 'can mark confirmed once both participants confirmed');
SELECT pg_temp.expect_error($$UPDATE relationships SET target_user_id='00000000-0000-4000-8000-00000000000d' WHERE id='00000000-0000-4000-8000-0000000000e2'$$, '23514', 'participants are immutable');

-- evidence + cascade
INSERT INTO relationship_evidence (relationship_id, evidence_type, submitted_by) VALUES ('00000000-0000-4000-8000-0000000000e2','user_asserted','00000000-0000-4000-8000-00000000000c');
SELECT pg_temp.expect_error($$INSERT INTO relationship_evidence (relationship_id, evidence_type, submitted_by) VALUES ('00000000-0000-4000-8000-0000000000e2','vibes','00000000-0000-4000-8000-00000000000c')$$, '23514', 'invalid evidence type rejected');

-- consents
SELECT pg_temp.expect_ok($$INSERT INTO consents (user_id, consent_type) VALUES ('00000000-0000-4000-8000-00000000000a','discoverability')$$, 'consent row inserts');
SELECT pg_temp.expect_true((SELECT granted = false FROM consents WHERE consent_type='discoverability'), 'consent default granted=false');
SELECT pg_temp.expect_error($$INSERT INTO consents (user_id, consent_type) VALUES ('00000000-0000-4000-8000-00000000000a','discoverability')$$, '23505', 'duplicate consent per type rejected');
SELECT pg_temp.expect_error($$INSERT INTO consents (user_id, consent_type, granted) VALUES ('00000000-0000-4000-8000-00000000000b','discoverability', true)$$, '23514', 'granted consent requires granted_at');

-- blocks
SELECT pg_temp.expect_error($$INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000a')$$, '23514', 'self block rejected');
INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b');
SELECT pg_temp.expect_error($$INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ('00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b')$$, '23505', 'duplicate block rejected');
SELECT pg_temp.expect_ok($$INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ('00000000-0000-4000-8000-00000000000b','00000000-0000-4000-8000-00000000000a')$$, 'reverse block is a distinct row');

-- external profiles
SELECT pg_temp.expect_error($$INSERT INTO external_profiles (user_id, platform, username, normalized_username) VALUES ('00000000-0000-4000-8000-00000000000a','instagram','Alice','Alice')$$, '23514', 'normalized_username must be lower(btrim(username))');
INSERT INTO external_profiles (user_id, platform, username, normalized_username, verification_status) VALUES ('00000000-0000-4000-8000-00000000000a','instagram','Alice','alice','verified');
SELECT pg_temp.expect_error($$INSERT INTO external_profiles (user_id, platform, username, normalized_username, verification_status) VALUES ('00000000-0000-4000-8000-00000000000b','instagram','alice','alice','verified')$$, '23505', 'second user cannot hold a verified claim on the same username');
SELECT pg_temp.expect_ok($$INSERT INTO external_profiles (user_id, platform, username, normalized_username) VALUES ('00000000-0000-4000-8000-00000000000b','instagram','alice','alice')$$, 'unverified claims by other users are allowed');
SELECT pg_temp.expect_error($$INSERT INTO external_profiles (user_id, platform, username, normalized_username) VALUES ('00000000-0000-4000-8000-00000000000a','instagram','alice','alice')$$, '23505', 'same user cannot duplicate a claim');

-- cascade: deleting a user removes its relationships/confirmations/evidence
DELETE FROM users WHERE id='00000000-0000-4000-8000-00000000000c';
SELECT pg_temp.expect_true((SELECT count(*) = 0 FROM relationship_confirmations WHERE relationship_id='00000000-0000-4000-8000-0000000000e2'), 'user deletion cascades to confirmations');
SELECT pg_temp.expect_true((SELECT count(*) = 0 FROM relationships WHERE id='00000000-0000-4000-8000-0000000000e2'), 'user deletion cascades to relationships');

ROLLBACK;
