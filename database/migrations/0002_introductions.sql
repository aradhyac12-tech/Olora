-- 0002_introductions.sql — introduction requests, idempotency, append-only audit, transactional outbox.
-- Depends on 0001_graph_core (users, wcim_set_updated_at).
BEGIN;

CREATE TABLE introduction_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'pending_connector'
                        CHECK (status IN ('pending_connector','pending_target','accepted','declined','cancelled','expired')),
  message               text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 1000),
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  connector_accepted_at timestamptz,
  decided_at            timestamptz,
  CONSTRAINT intro_distinct_parties CHECK (requester_id <> connector_id AND requester_id <> target_id AND connector_id <> target_id),
  CONSTRAINT intro_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT intro_updated_after_created CHECK (updated_at >= created_at),
  CONSTRAINT intro_terminal_has_decided_at CHECK ((status IN ('accepted','declined','cancelled','expired')) = (decided_at IS NOT NULL)),
  -- the target only ever becomes involved after the connector accepted
  CONSTRAINT intro_target_stage CHECK (
    (status = 'pending_connector' AND connector_accepted_at IS NULL)
    OR (status IN ('pending_target','accepted') AND connector_accepted_at IS NOT NULL)
    OR status IN ('declined','cancelled','expired'))
);
-- at most one OPEN request per (requester, connector, target)
CREATE UNIQUE INDEX intro_open_triple_uq ON introduction_requests (requester_id, connector_id, target_id)
  WHERE status IN ('pending_connector','pending_target');
CREATE INDEX intro_connector_pending_idx ON introduction_requests (connector_id) WHERE status = 'pending_connector';
CREATE INDEX intro_target_pending_idx    ON introduction_requests (target_id)    WHERE status = 'pending_target';
CREATE INDEX intro_requester_idx         ON introduction_requests (requester_id, created_at DESC);
CREATE INDEX intro_due_idx               ON introduction_requests (expires_at)   WHERE status IN ('pending_connector','pending_target');
CREATE TRIGGER introduction_requests_updated_at BEFORE UPDATE ON introduction_requests FOR EACH ROW EXECUTE FUNCTION wcim_set_updated_at();

-- Defense in depth: even a buggy service cannot make an illegal transition or touch a terminal row.
CREATE FUNCTION wcim_intro_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requester_id <> OLD.requester_id OR NEW.connector_id <> OLD.connector_id OR NEW.target_id <> OLD.target_id
     OR NEW.created_at <> OLD.created_at OR NEW.message <> OLD.message OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'introduction parties, message and expiry are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('accepted','declined','cancelled','expired') THEN
    RAISE EXCEPTION 'introduction request is terminal (%)', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    RAISE EXCEPTION 'introduction update must change status' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = 'pending_connector' AND NEW.status IN ('pending_target','declined','cancelled','expired'))
       OR (OLD.status = 'pending_target'    AND NEW.status IN ('accepted','declined','cancelled','expired'))) THEN
    RAISE EXCEPTION 'illegal introduction transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER introduction_requests_guard BEFORE UPDATE ON introduction_requests FOR EACH ROW EXECUTE FUNCTION wcim_intro_guard();

CREATE TABLE introduction_idempotency (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash    text NOT NULL,
  request_id      uuid NOT NULL REFERENCES introduction_requests(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE TABLE audit_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id      uuid NOT NULL REFERENCES introduction_requests(id) ON DELETE CASCADE,
  actor_id        uuid REFERENCES users(id) ON DELETE CASCADE,   -- NULL = system (expiry)
  action          text NOT NULL CHECK (action IN ('create','connector_accept','connector_decline','target_accept','target_decline','requester_cancel','expire')),
  from_status     text,
  to_status       text NOT NULL,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_system_only_expire CHECK ((actor_id IS NULL) = (action = 'expire'))
);
CREATE UNIQUE INDEX audit_idem_uq ON audit_events (request_id, actor_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX audit_request_idx ON audit_events (request_id, id);

CREATE FUNCTION wcim_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION wcim_audit_immutable();

CREATE TABLE notification_outbox (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type        text NOT NULL CHECK (event_type ~ '^[a-z_]{3,60}$'),
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id        uuid NOT NULL REFERENCES introduction_requests(id) ON DELETE CASCADE,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  available_at      timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- one notification per (request, recipient, event): replays/races can never double-notify
  CONSTRAINT outbox_once UNIQUE (request_id, recipient_user_id, event_type)
);
CREATE INDEX outbox_pending_idx ON notification_outbox (available_at, id) WHERE processed_at IS NULL;

COMMIT;
