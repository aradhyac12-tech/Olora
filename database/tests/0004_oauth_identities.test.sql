-- Assertions for 0004. Runs inside a transaction that is rolled back.
BEGIN;
INSERT INTO users (id, email, display_name) VALUES ('00000000-0000-4000-8000-0000000000a1', 'oauth-a@example.com', 'A');
INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('supabase', 'sub-1', '00000000-0000-4000-8000-0000000000a1');
DO $$ BEGIN
  BEGIN INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('supabase', 'sub-1', '00000000-0000-4000-8000-0000000000a1'); RAISE EXCEPTION 'duplicate identity accepted';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: duplicate (provider, subject) rejected'; END;
  BEGIN INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('Bad Provider', 'x', '00000000-0000-4000-8000-0000000000a1'); RAISE EXCEPTION 'bad provider accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: malformed provider rejected'; END;
  BEGIN INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('supabase', 'sub-2', '00000000-0000-4000-8000-0000000000ff'); RAISE EXCEPTION 'orphan identity accepted';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: identity needs an existing user'; END;
END $$;
DELETE FROM users WHERE id = '00000000-0000-4000-8000-0000000000a1';
DO $$ BEGIN IF EXISTS (SELECT 1 FROM oauth_identities WHERE subject = 'sub-1') THEN RAISE EXCEPTION 'identity not cascaded'; END IF; RAISE NOTICE 'PASS: user deletion cascades to identities'; END $$;
ROLLBACK;
