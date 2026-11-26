-- Constraint/trigger tests for 0006. One transaction, rolled back. Any FAIL aborts the run (ON_ERROR_STOP).
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
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FAIL: % — unexpected error % (%)', label, SQLSTATE, SQLERRM; END;
  RAISE NOTICE 'PASS: %', label;
END $$;
CREATE FUNCTION pg_temp.expect_true(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS TRUE THEN RAISE NOTICE 'PASS: %', label; ELSE RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;

INSERT INTO users (id, email, display_name) VALUES
 ('00000000-0000-4000-8000-0000000006a1','a6@example.test','A'),('00000000-0000-4000-8000-0000000006b2','b6@example.test','B'),('00000000-0000-4000-8000-0000000006c3','c6@example.test','C');

-- avatars
SELECT pg_temp.expect_error($$UPDATE users SET avatar_url='http://insecure.example/a.png' WHERE email='a6@example.test'$$,'23514','avatar must be https');
SELECT pg_temp.expect_error($$UPDATE users SET avatar_url='javascript:alert(1)' WHERE email='a6@example.test'$$,'23514','javascript: avatar rejected');
SELECT pg_temp.expect_ok($$UPDATE users SET avatar_url='https://cdn.example/a.png' WHERE email='a6@example.test'$$,'https avatar accepted');

-- invitations
SELECT pg_temp.expect_ok($$INSERT INTO invitations (id,owner_id,purpose,token_hash,relationship_type,max_uses,expires_at) VALUES ('00000000-0000-4000-8000-000000006101','00000000-0000-4000-8000-0000000006a1','connect',repeat('a',64),'colleague',1,now()+interval '7 days')$$,'valid connect invitation');
SELECT pg_temp.expect_error($$INSERT INTO invitations (owner_id,purpose,token_hash,relationship_type,max_uses,expires_at) VALUES ('00000000-0000-4000-8000-0000000006a1','connect',repeat('a',64),'colleague',1,now()+interval '7 days')$$,'23505','token hash is unique');
SELECT pg_temp.expect_error($$INSERT INTO invitations (owner_id,purpose,token_hash,relationship_type,max_uses,expires_at) VALUES ('00000000-0000-4000-8000-0000000006a1','connect','RAW-TOKEN','colleague',1,now()+interval '7 days')$$,'23514','only 64-hex hashes are stored (a raw token is rejected)');
SELECT pg_temp.expect_error($$INSERT INTO invitations (owner_id,purpose,token_hash,relationship_type,max_uses,expires_at) VALUES ('00000000-0000-4000-8000-0000000006a1','connect',repeat('b',64),'one_sided',1,now()+interval '7 days')$$,'23514','connect invitation needs a trusted relationship type');
SELECT pg_temp.expect_error($$INSERT INTO invitations (owner_id,purpose,token_hash,relationship_type,max_uses,expires_at) VALUES ('00000000-0000-4000-8000-0000000006a1','connect',repeat('c',64),'colleague',NULL,now()+interval '7 days')$$,'23514','connect invitation must be use-bounded');
SELECT pg_temp.expect_error($$INSERT INTO invitations (owner_id,purpose,token_hash,relationship_type,max_uses,expires_at) VALUES ('00000000-0000-4000-8000-0000000006a1','connect',repeat('d',64),'colleague',26,now()+interval '7 days')$$,'23514','max_uses capped at 25');
SELECT pg_temp.expect_error($$INSERT INTO invitations (owner_id,purpose,token_hash,relationship_type,max_uses,expires_at) VALUES ('00000000-0000-4000-8000-0000000006a1','connect',repeat('e',64),'colleague',1,now()+interval '91 days')$$,'23514','expiry capped at 90 days');
SELECT pg_temp.expect_error($$INSERT INTO invitations (owner_id,purpose,token_hash,relationship_type,max_uses,expires_at) VALUES ('00000000-0000-4000-8000-0000000006a1','connect',repeat('f',64),'colleague',1,now()-interval '1 day')$$,'23514','expiry must be in the future');
SELECT pg_temp.expect_error($$INSERT INTO invitations (owner_id,purpose,token_hash,relationship_type,max_uses,expires_at) VALUES ('00000000-0000-4000-8000-0000000006a1','introduce',repeat('1',64),'colleague',NULL,now()+interval '7 days')$$,'23514','introduce link carries no relationship type');
SELECT pg_temp.expect_error($$UPDATE invitations SET use_count = 2 WHERE id='00000000-0000-4000-8000-000000006101'$$,'23514','use_count cannot exceed max_uses');
SELECT pg_temp.expect_ok($$UPDATE invitations SET use_count = 1 WHERE id='00000000-0000-4000-8000-000000006101'$$,'use_count may increase');
SELECT pg_temp.expect_error($$UPDATE invitations SET use_count = 0 WHERE id='00000000-0000-4000-8000-000000006101'$$,'23514','use_count cannot decrease');
SELECT pg_temp.expect_error($$UPDATE invitations SET owner_id='00000000-0000-4000-8000-0000000006b2' WHERE id='00000000-0000-4000-8000-000000006101'$$,'23514','invitation owner is immutable');
SELECT pg_temp.expect_error($$UPDATE invitations SET token_hash=repeat('9',64) WHERE id='00000000-0000-4000-8000-000000006101'$$,'23514','token hash is immutable');
SELECT pg_temp.expect_ok($$UPDATE invitations SET revoked_at = now() WHERE id='00000000-0000-4000-8000-000000006101'$$,'invitation can be revoked');
SELECT pg_temp.expect_error($$UPDATE invitations SET revoked_at = NULL WHERE id='00000000-0000-4000-8000-000000006101'$$,'23514','revoked invitation cannot be revived');

-- redemptions: one response per (invitation, user)
SELECT pg_temp.expect_ok($$INSERT INTO invitation_redemptions (invitation_id,user_id,outcome) VALUES ('00000000-0000-4000-8000-000000006101','00000000-0000-4000-8000-0000000006b2','declined')$$,'redemption recorded');
SELECT pg_temp.expect_error($$INSERT INTO invitation_redemptions (invitation_id,user_id,outcome) VALUES ('00000000-0000-4000-8000-000000006101','00000000-0000-4000-8000-0000000006b2','accepted')$$,'23505','a user cannot respond to the same invitation twice (token replay)');

-- relationships: duplicate LIVE relationship per pair, any type, either direction
INSERT INTO relationships (id,source_user_id,target_user_id,relationship_type,created_at,invitation_id) VALUES ('00000000-0000-4000-8000-000000006201','00000000-0000-4000-8000-0000000006a1','00000000-0000-4000-8000-0000000006b2','colleague', now()-interval '1 hour','00000000-0000-4000-8000-000000006101');
SELECT pg_temp.expect_error($$INSERT INTO relationships (source_user_id,target_user_id,relationship_type,invitation_id) VALUES ('00000000-0000-4000-8000-0000000006b2','00000000-0000-4000-8000-0000000006a1','family','00000000-0000-4000-8000-000000006101')$$,'23505','no second live invitation-born relationship for the same pair (reverse direction, other type)');
SELECT pg_temp.expect_error($$UPDATE relationships SET verification_status='confirmed', confirmed_at=now() WHERE id='00000000-0000-4000-8000-000000006201'$$,'23514','confirming needs both participants');
INSERT INTO relationship_confirmations (relationship_id,confirming_user_id) VALUES ('00000000-0000-4000-8000-000000006201','00000000-0000-4000-8000-0000000006a1'),('00000000-0000-4000-8000-000000006201','00000000-0000-4000-8000-0000000006b2');
SELECT pg_temp.expect_error($$INSERT INTO relationship_confirmations (relationship_id,confirming_user_id) VALUES ('00000000-0000-4000-8000-000000006201','00000000-0000-4000-8000-0000000006c3')$$,'23514','foreign confirmation rejected (not a participant)');
UPDATE relationship_confirmations SET confirmation_status='confirmed', confirmed_at=now() WHERE relationship_id='00000000-0000-4000-8000-000000006201' AND confirming_user_id='00000000-0000-4000-8000-0000000006a1';
SELECT pg_temp.expect_error($$UPDATE relationships SET verification_status='confirmed', confirmed_at=now() WHERE id='00000000-0000-4000-8000-000000006201'$$,'23514','one-sided confirmation cannot confirm the relationship');
SELECT pg_temp.expect_true(NOT EXISTS (SELECT 1 FROM wcim_trusted_relationships WHERE id='00000000-0000-4000-8000-000000006201'),'one-sided relationship is not trusted');
UPDATE relationship_confirmations SET confirmation_status='confirmed', confirmed_at=now() WHERE relationship_id='00000000-0000-4000-8000-000000006201' AND confirming_user_id='00000000-0000-4000-8000-0000000006b2';
UPDATE relationships SET verification_status='confirmed', confirmed_at=now() WHERE id='00000000-0000-4000-8000-000000006201';
SELECT pg_temp.expect_true(NOT EXISTS (SELECT 1 FROM wcim_trusted_relationships WHERE id='00000000-0000-4000-8000-000000006201'),'confirmed but permission still pending: not trusted');
UPDATE relationships SET permission_status='granted' WHERE id='00000000-0000-4000-8000-000000006201';
SELECT pg_temp.expect_true(EXISTS (SELECT 1 FROM wcim_trusted_relationships WHERE id='00000000-0000-4000-8000-000000006201'),'both confirmed + granted + live: trusted');

-- confirmation revocation removes trust, and is terminal
UPDATE relationship_confirmations SET confirmation_status='revoked', revoked_at=now(), confirmed_at=confirmed_at WHERE relationship_id='00000000-0000-4000-8000-000000006201' AND confirming_user_id='00000000-0000-4000-8000-0000000006b2';
SELECT pg_temp.expect_true(NOT EXISTS (SELECT 1 FROM wcim_trusted_relationships WHERE id='00000000-0000-4000-8000-000000006201'),'revoked confirmation: not trusted');
SELECT pg_temp.expect_error($$UPDATE relationship_confirmations SET confirmation_status='confirmed', revoked_at=NULL WHERE relationship_id='00000000-0000-4000-8000-000000006201' AND confirming_user_id='00000000-0000-4000-8000-0000000006b2'$$,'23514','revoked confirmation cannot be revived');

-- relationship revocation is terminal; reason defaults
UPDATE relationships SET revoked_at = now() WHERE id='00000000-0000-4000-8000-000000006201';
SELECT pg_temp.expect_true((SELECT ended_reason FROM relationships WHERE id='00000000-0000-4000-8000-000000006201')='revoked','raw revocation gets ended_reason=revoked');
SELECT pg_temp.expect_error($$UPDATE relationships SET revoked_at = NULL WHERE id='00000000-0000-4000-8000-000000006201'$$,'23514','revoked relationship cannot be revived');
SELECT pg_temp.expect_ok($$INSERT INTO relationships (id,source_user_id,target_user_id,relationship_type,created_at,invitation_id) VALUES ('00000000-0000-4000-8000-000000006202','00000000-0000-4000-8000-0000000006a1','00000000-0000-4000-8000-0000000006b2','family', now()-interval '1 hour','00000000-0000-4000-8000-000000006101')$$,'a NEW relationship may follow a revoked one');

-- expiry
SELECT pg_temp.expect_ok($$INSERT INTO relationships (id,source_user_id,target_user_id,relationship_type,created_at,expires_at) VALUES ('00000000-0000-4000-8000-000000006203','00000000-0000-4000-8000-0000000006a1','00000000-0000-4000-8000-0000000006c3','colleague', now()-interval '3 days', now()-interval '1 day')$$,'expired relationship row can exist');
INSERT INTO relationship_confirmations (relationship_id,confirming_user_id,confirmation_status,confirmed_at) VALUES ('00000000-0000-4000-8000-000000006203','00000000-0000-4000-8000-0000000006a1','confirmed',now()-interval '2 days'),('00000000-0000-4000-8000-000000006203','00000000-0000-4000-8000-0000000006c3','confirmed',now()-interval '2 days');
UPDATE relationships SET verification_status='confirmed', confirmed_at=now()-interval '2 days', permission_status='granted' WHERE id='00000000-0000-4000-8000-000000006203';
SELECT pg_temp.expect_true(NOT EXISTS (SELECT 1 FROM wcim_trusted_relationships WHERE id='00000000-0000-4000-8000-000000006203'),'expired relationship is not trusted');

-- blocks: end live relationships (both directions), forbid confirming between blocked users, trusted view excludes
INSERT INTO relationships (id,source_user_id,target_user_id,relationship_type,created_at) VALUES ('00000000-0000-4000-8000-000000006204','00000000-0000-4000-8000-0000000006b2','00000000-0000-4000-8000-0000000006c3','classmate', now()-interval '1 hour');
INSERT INTO relationship_confirmations (relationship_id,confirming_user_id,confirmation_status,confirmed_at) VALUES ('00000000-0000-4000-8000-000000006204','00000000-0000-4000-8000-0000000006b2','confirmed',now()),('00000000-0000-4000-8000-000000006204','00000000-0000-4000-8000-0000000006c3','confirmed',now());
UPDATE relationships SET verification_status='confirmed', confirmed_at=now(), permission_status='granted' WHERE id='00000000-0000-4000-8000-000000006204';
SELECT pg_temp.expect_true(EXISTS (SELECT 1 FROM wcim_trusted_relationships WHERE id='00000000-0000-4000-8000-000000006204'),'precondition: B-C trusted');
INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ('00000000-0000-4000-8000-0000000006c3','00000000-0000-4000-8000-0000000006b2');   -- the TARGET side blocks the source side
SELECT pg_temp.expect_true(NOT EXISTS (SELECT 1 FROM wcim_trusted_relationships WHERE id='00000000-0000-4000-8000-000000006204'),'block (reverse direction) removes trust');
SELECT pg_temp.expect_true((SELECT ended_reason FROM relationships WHERE id='00000000-0000-4000-8000-000000006204')='blocked' AND (SELECT revoked_at FROM relationships WHERE id='00000000-0000-4000-8000-000000006204') IS NOT NULL,'block ends the relationship (reason blocked)');
SELECT pg_temp.expect_true(wcim_users_blocked('00000000-0000-4000-8000-0000000006b2','00000000-0000-4000-8000-0000000006c3') AND wcim_users_blocked('00000000-0000-4000-8000-0000000006c3','00000000-0000-4000-8000-0000000006b2'),'wcim_users_blocked is symmetric');
INSERT INTO relationships (id,source_user_id,target_user_id,relationship_type,created_at) VALUES ('00000000-0000-4000-8000-000000006205','00000000-0000-4000-8000-0000000006b2','00000000-0000-4000-8000-0000000006c3','acquaintance', now()-interval '1 hour');
INSERT INTO relationship_confirmations (relationship_id,confirming_user_id) VALUES ('00000000-0000-4000-8000-000000006205','00000000-0000-4000-8000-0000000006b2'),('00000000-0000-4000-8000-000000006205','00000000-0000-4000-8000-0000000006c3');
SELECT pg_temp.expect_error($$UPDATE relationship_confirmations SET confirmation_status='confirmed', confirmed_at=now() WHERE relationship_id='00000000-0000-4000-8000-000000006205' AND confirming_user_id='00000000-0000-4000-8000-0000000006b2'$$,'23514','cannot confirm while a block exists');

-- reports
SELECT pg_temp.expect_ok($$INSERT INTO reports (reporter_id,reported_user_id,kind,reason) VALUES ('00000000-0000-4000-8000-0000000006a1','00000000-0000-4000-8000-0000000006b2','user','spam')$$,'report filed');
SELECT pg_temp.expect_error($$INSERT INTO reports (reporter_id,reported_user_id,kind,reason) VALUES ('00000000-0000-4000-8000-0000000006a1','00000000-0000-4000-8000-0000000006b2','user','harassment')$$,'23505','one open report per reporter/target/kind');
SELECT pg_temp.expect_error($$INSERT INTO reports (reporter_id,reported_user_id,kind,reason) VALUES ('00000000-0000-4000-8000-0000000006a1','00000000-0000-4000-8000-0000000006a1','user','spam')$$,'23514','cannot report yourself');

-- audit is append-only; idempotency scope shape
INSERT INTO relationship_audit_events (event_type, actor_id) VALUES ('user_blocked','00000000-0000-4000-8000-0000000006c3');
SELECT pg_temp.expect_error($$UPDATE relationship_audit_events SET event_type='user_unblocked'$$,'23514','relationship audit events are append-only');
SELECT pg_temp.expect_error($$INSERT INTO relationship_audit_events (event_type) VALUES ('made_up')$$,'23514','unknown audit event type rejected');
SELECT pg_temp.expect_error($$INSERT INTO mutation_idempotency (user_id,scope,idempotency_key,request_hash,response) VALUES ('00000000-0000-4000-8000-0000000006a1','BAD SCOPE','key-12345678','h','{}')$$,'23514','idempotency scope shape enforced');

-- pair lock key is symmetric and stable
SELECT pg_temp.expect_true(wcim_pair_lock_key('00000000-0000-4000-8000-0000000006a1','00000000-0000-4000-8000-0000000006b2') = wcim_pair_lock_key('00000000-0000-4000-8000-0000000006b2','00000000-0000-4000-8000-0000000006a1'),'pair lock key is order-independent');

ROLLBACK;
