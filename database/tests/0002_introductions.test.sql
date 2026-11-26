-- Constraint tests for 0002_introductions. Run via database/run-db-tests.sh (psql -v ON_ERROR_STOP=1).
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

INSERT INTO users (id, email, display_name) VALUES
 ('00000000-0000-4000-8000-0000000000aa','a@example.test','A'),
 ('00000000-0000-4000-8000-0000000000bb','b@example.test','B'),
 ('00000000-0000-4000-8000-0000000000cc','c@example.test','C'),
 ('00000000-0000-4000-8000-0000000000dd','d@example.test','D');

CREATE TEMP TABLE r (name text PRIMARY KEY, id uuid);
CREATE FUNCTION pg_temp.u(x text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000000000' || x)::uuid $$;
CREATE FUNCTION pg_temp.ins(name text, req text, con text, tgt text, st text DEFAULT 'pending_connector') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO introduction_requests (requester_id, connector_id, target_id, status, message, expires_at, connector_accepted_at, decided_at)
  VALUES (pg_temp.u(req), pg_temp.u(con), pg_temp.u(tgt), st, 'hello', now() + interval '7 days',
          CASE WHEN st IN ('pending_target','accepted') THEN now() END,
          CASE WHEN st IN ('accepted','declined','cancelled','expired') THEN now() END);
  INSERT INTO r SELECT name, id FROM introduction_requests WHERE requester_id = pg_temp.u(req) AND connector_id = pg_temp.u(con) AND target_id = pg_temp.u(tgt) AND status = st ORDER BY created_at DESC, id LIMIT 1;
END $$;

-- shape
SELECT pg_temp.expect_ok($$SELECT pg_temp.ins('r1','aa','bb','cc')$$, 'valid request inserts');
SELECT pg_temp.expect_true((SELECT status = 'pending_connector' AND version = 1 AND connector_accepted_at IS NULL FROM introduction_requests), 'defaults: pending_connector, version 1');
SELECT pg_temp.expect_error($$SELECT pg_temp.ins('x','aa','aa','cc')$$, '23514', 'requester = connector rejected');
SELECT pg_temp.expect_error($$SELECT pg_temp.ins('x','aa','bb','aa')$$, '23514', 'requester = target rejected');
SELECT pg_temp.expect_error($$SELECT pg_temp.ins('x','aa','bb','bb')$$, '23514', 'connector = target rejected');
SELECT pg_temp.expect_error($$SELECT pg_temp.ins('x','aa','bb','cc')$$, '23505', 'duplicate OPEN triple rejected');
SELECT pg_temp.expect_ok($$SELECT pg_temp.ins('r2','aa','bb','dd')$$, 'same requester/connector, other target allowed');
SELECT pg_temp.expect_error($$INSERT INTO introduction_requests (requester_id,connector_id,target_id,message,expires_at) VALUES (pg_temp.u('cc'),pg_temp.u('bb'),pg_temp.u('dd'),'   ', now()+interval '1 day')$$, '23514', 'blank message rejected');
SELECT pg_temp.expect_error($$INSERT INTO introduction_requests (requester_id,connector_id,target_id,message,expires_at) VALUES (pg_temp.u('cc'),pg_temp.u('bb'),pg_temp.u('dd'),'x', now() - interval '1 day')$$, '23514', 'expiry before creation rejected');
SELECT pg_temp.expect_error($$INSERT INTO introduction_requests (requester_id,connector_id,target_id,status,message,expires_at) VALUES (pg_temp.u('cc'),pg_temp.u('bb'),pg_temp.u('dd'),'bogus','x', now()+interval '1 day')$$, '23514', 'invalid status rejected');
SELECT pg_temp.expect_error($$INSERT INTO introduction_requests (requester_id,connector_id,target_id,status,message,expires_at) VALUES (pg_temp.u('cc'),pg_temp.u('bb'),pg_temp.u('dd'),'pending_target','x', now()+interval '1 day')$$, '23514', 'pending_target without connector_accepted_at rejected');
SELECT pg_temp.expect_error($$INSERT INTO introduction_requests (requester_id,connector_id,target_id,status,message,expires_at,connector_accepted_at) VALUES (pg_temp.u('cc'),pg_temp.u('bb'),pg_temp.u('dd'),'pending_connector','x', now()+interval '1 day', now())$$, '23514', 'pending_connector with connector_accepted_at rejected');
SELECT pg_temp.expect_error($$INSERT INTO introduction_requests (requester_id,connector_id,target_id,status,message,expires_at) VALUES (pg_temp.u('cc'),pg_temp.u('bb'),pg_temp.u('dd'),'declined','x', now()+interval '1 day')$$, '23514', 'terminal status without decided_at rejected');

-- legal transitions, version bump, terminal lock
SELECT pg_temp.expect_ok($$UPDATE introduction_requests SET status='pending_target', connector_accepted_at=now() WHERE id=(SELECT id FROM r WHERE name='r1')$$, 'pending_connector -> pending_target');
SELECT pg_temp.expect_true((SELECT version = 2 FROM introduction_requests WHERE id=(SELECT id FROM r WHERE name='r1')), 'version incremented by guard');
SELECT pg_temp.expect_ok($$UPDATE introduction_requests SET status='accepted', decided_at=now() WHERE id=(SELECT id FROM r WHERE name='r1')$$, 'pending_target -> accepted');
SELECT pg_temp.expect_error($$UPDATE introduction_requests SET status='cancelled', decided_at=now() WHERE id=(SELECT id FROM r WHERE name='r1')$$, '23514', 'terminal row cannot change');
SELECT pg_temp.expect_ok($$SELECT pg_temp.ins('r1b','aa','bb','cc')$$, 'new request allowed after previous one is terminal');

-- illegal transitions / immutability
SELECT pg_temp.expect_error($$UPDATE introduction_requests SET status='accepted', decided_at=now(), connector_accepted_at=now() WHERE id=(SELECT id FROM r WHERE name='r2')$$, '23514', 'pending_connector -> accepted illegal');
SELECT pg_temp.expect_error($$UPDATE introduction_requests SET message='changed' WHERE id=(SELECT id FROM r WHERE name='r2')$$, '23514', 'message immutable');
SELECT pg_temp.expect_error($$UPDATE introduction_requests SET target_id=pg_temp.u('cc') WHERE id=(SELECT id FROM r WHERE name='r2')$$, '23514', 'parties immutable');
SELECT pg_temp.expect_error($$UPDATE introduction_requests SET updated_at=updated_at WHERE id=(SELECT id FROM r WHERE name='r2')$$, '23514', 'no-op (same status) update rejected');
SELECT pg_temp.expect_ok($$UPDATE introduction_requests SET status='expired', decided_at=now() WHERE id=(SELECT id FROM r WHERE name='r2')$$, 'pending_connector -> expired');

-- idempotency
SELECT pg_temp.expect_ok($$INSERT INTO introduction_idempotency (user_id,idempotency_key,request_hash,request_id) VALUES (pg_temp.u('aa'),'key-12345678','h',(SELECT id FROM r WHERE name='r1'))$$, 'idempotency row inserts');
SELECT pg_temp.expect_error($$INSERT INTO introduction_idempotency (user_id,idempotency_key,request_hash,request_id) VALUES (pg_temp.u('aa'),'key-12345678','h',(SELECT id FROM r WHERE name='r1b'))$$, '23505', 'duplicate (user,key) rejected');
SELECT pg_temp.expect_ok($$INSERT INTO introduction_idempotency (user_id,idempotency_key,request_hash,request_id) VALUES (pg_temp.u('bb'),'key-12345678','h',(SELECT id FROM r WHERE name='r1'))$$, 'same key for another user allowed');
SELECT pg_temp.expect_error($$INSERT INTO introduction_idempotency (user_id,idempotency_key,request_hash,request_id) VALUES (pg_temp.u('aa'),'short','h',(SELECT id FROM r WHERE name='r1'))$$, '23514', 'short idempotency key rejected');

-- audit
SELECT pg_temp.expect_ok($$INSERT INTO audit_events (request_id,actor_id,action,from_status,to_status,idempotency_key) VALUES ((SELECT id FROM r WHERE name='r1'),pg_temp.u('bb'),'connector_accept','pending_connector','pending_target','k-connector-1')$$, 'audit row inserts');
SELECT pg_temp.expect_error($$INSERT INTO audit_events (request_id,actor_id,action,from_status,to_status,idempotency_key) VALUES ((SELECT id FROM r WHERE name='r1'),pg_temp.u('bb'),'connector_accept','pending_connector','pending_target','k-connector-1')$$, '23505', 'duplicate audit idempotency (request,actor,key) rejected');
SELECT pg_temp.expect_ok($$INSERT INTO audit_events (request_id,actor_id,action,from_status,to_status,idempotency_key) VALUES ((SELECT id FROM r WHERE name='r1'),pg_temp.u('cc'),'target_accept','pending_target','accepted','k-connector-1')$$, 'same key by another actor allowed');
SELECT pg_temp.expect_error($$INSERT INTO audit_events (request_id,actor_id,action,to_status) VALUES ((SELECT id FROM r WHERE name='r1'),NULL,'create','pending_connector')$$, '23514', 'NULL actor only for system expire');
SELECT pg_temp.expect_ok($$INSERT INTO audit_events (request_id,actor_id,action,from_status,to_status) VALUES ((SELECT id FROM r WHERE name='r2'),NULL,'expire','pending_connector','expired')$$, 'system expire audit allowed');
SELECT pg_temp.expect_error($$UPDATE audit_events SET to_status='x'$$, '23514', 'audit is append-only (UPDATE rejected)');

-- outbox
SELECT pg_temp.expect_ok($$INSERT INTO notification_outbox (event_type,recipient_user_id,request_id,payload) VALUES ('introduction_requested',pg_temp.u('bb'),(SELECT id FROM r WHERE name='r1'),'{"k":1}')$$, 'outbox row inserts');
SELECT pg_temp.expect_error($$INSERT INTO notification_outbox (event_type,recipient_user_id,request_id) VALUES ('introduction_requested',pg_temp.u('bb'),(SELECT id FROM r WHERE name='r1'))$$, '23505', 'duplicate notification (request,recipient,event) rejected');
SELECT pg_temp.expect_error($$INSERT INTO notification_outbox (event_type,recipient_user_id,request_id) VALUES ('Bad Type',pg_temp.u('cc'),(SELECT id FROM r WHERE name='r1'))$$, '23514', 'malformed event_type rejected');
SELECT pg_temp.expect_error($$INSERT INTO notification_outbox (event_type,recipient_user_id,request_id,payload) VALUES ('some_event',pg_temp.u('cc'),(SELECT id FROM r WHERE name='r1'),'[1]')$$, '23514', 'non-object payload rejected');
SELECT pg_temp.expect_error($$INSERT INTO notification_outbox (event_type,recipient_user_id,request_id,attempts) VALUES ('some_event',pg_temp.u('cc'),(SELECT id FROM r WHERE name='r1'),-1)$$, '23514', 'negative attempts rejected');

-- cascade
DELETE FROM users WHERE id = pg_temp.u('bb');
SELECT pg_temp.expect_true((SELECT count(*) = 0 FROM introduction_requests WHERE connector_id = pg_temp.u('bb')), 'user deletion cascades to requests');
SELECT pg_temp.expect_true((SELECT count(*) = 0 FROM audit_events WHERE request_id IN (SELECT id FROM r)), 'user deletion cascades to audit (via request)');
SELECT pg_temp.expect_true((SELECT count(*) = 0 FROM notification_outbox WHERE request_id IN (SELECT id FROM r)), 'user deletion cascades to outbox');
SELECT pg_temp.expect_true((SELECT count(*) = 0 FROM introduction_idempotency WHERE request_id IN (SELECT id FROM r)), 'user deletion cascades to idempotency');

ROLLBACK;
