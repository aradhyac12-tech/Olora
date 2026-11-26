-- Constraint tests for 0003_auth. Run via database/run-db-tests.sh. One transaction, rolled back.
BEGIN;
CREATE FUNCTION pg_temp.expect_error(stmt text, state text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = state THEN RAISE NOTICE 'PASS: %', label; RETURN; END IF;
    RAISE EXCEPTION 'FAIL: % — expected SQLSTATE % but got % (%)', label, state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL: % — statement succeeded but should have failed', label;
END $$;
CREATE FUNCTION pg_temp.expect_ok(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FAIL: % — unexpected error % (%)', label, SQLSTATE, SQLERRM;
  END;
  RAISE NOTICE 'PASS: %', label;
END $$;
CREATE FUNCTION pg_temp.expect_true(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; RAISE NOTICE 'PASS: %', label; END $$;

INSERT INTO users (id, email, display_name) VALUES ('00000000-0000-4000-8000-0000000000a1','a@example.test','A'), ('00000000-0000-4000-8000-0000000000a2','b@example.test','B');
\set H 'scrypt$16384$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
SELECT pg_temp.expect_ok($$INSERT INTO user_credentials (user_id,password_hash) VALUES ('00000000-0000-4000-8000-0000000000a1','scrypt$16384$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g')$$, 'credential row accepted');
SELECT pg_temp.expect_error($$INSERT INTO user_credentials (user_id,password_hash) VALUES ('00000000-0000-4000-8000-0000000000a1','scrypt$16384$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g')$$, '23505', 'one credential row per user');
SELECT pg_temp.expect_error($$INSERT INTO user_credentials (user_id,password_hash) VALUES ('00000000-0000-4000-8000-0000000000a2','hunter2-plaintext-password-should-never-be-stored-here')$$, '23514', 'plaintext-looking password rejected (must be scrypt$ hash)');
SELECT pg_temp.expect_error($$INSERT INTO user_credentials (user_id,password_hash) VALUES ('00000000-0000-4000-8000-0000000000a2','scrypt$short')$$, '23514', 'too-short hash rejected');
SELECT pg_temp.expect_error($$INSERT INTO user_credentials (user_id,password_hash) VALUES ('00000000-0000-4000-8000-0000000000ff','scrypt$16384$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g')$$, '23503', 'credential needs an existing user');

SELECT pg_temp.expect_ok($$INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES ('00000000-0000-4000-8000-0000000000a1', repeat('a',64), now() + interval '1 day')$$, 'session row accepted');
SELECT pg_temp.expect_error($$INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES ('00000000-0000-4000-8000-0000000000a2', repeat('a',64), now() + interval '1 day')$$, '23505', 'token hash is unique');
SELECT pg_temp.expect_error($$INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES ('00000000-0000-4000-8000-0000000000a2', 'not-a-sha256-hex', now() + interval '1 day')$$, '23514', 'raw/odd token rejected: only 64-hex hashes');
SELECT pg_temp.expect_error($$INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES ('00000000-0000-4000-8000-0000000000a2', repeat('b',64), now() - interval '1 day')$$, '23514', 'expiry must be after creation');
SELECT pg_temp.expect_error($$INSERT INTO auth_sessions (user_id,token_hash,expires_at,revoked_at) VALUES ('00000000-0000-4000-8000-0000000000a2', repeat('c',64), now() + interval '1 day', now() - interval '1 day')$$, '23514', 'revocation cannot precede creation');
SELECT pg_temp.expect_error($$INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES ('00000000-0000-4000-8000-0000000000ff', repeat('d',64), now() + interval '1 day')$$, '23503', 'session needs an existing user');

DELETE FROM users WHERE id = '00000000-0000-4000-8000-0000000000a1';
SELECT pg_temp.expect_true((SELECT count(*) = 0 FROM auth_sessions WHERE user_id = '00000000-0000-4000-8000-0000000000a1'), 'user deletion cascades to sessions');
SELECT pg_temp.expect_true((SELECT count(*) = 0 FROM user_credentials WHERE user_id = '00000000-0000-4000-8000-0000000000a1'), 'user deletion cascades to credentials');
ROLLBACK;
