-- 0006_relationship_lifecycle.sql — Slice 4: relationship invitations, lifecycle guards, blocking safety, reports, audit.
-- Depends on 0001 (users, relationships, relationship_confirmations, blocks) and 0002 (wcim_audit_immutable).
-- Additive only: no existing column is dropped or retyped. Rollback: 0006_relationship_lifecycle.down.sql.
BEGIN;

-- ---------------------------------------------------------------------------------------------------------------------
-- users: avatars must be https URLs (NOT VALID = enforced for new/changed rows without rescanning legacy data).
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE users ADD CONSTRAINT users_avatar_https
  CHECK (avatar_url IS NULL OR (avatar_url ~ '^https://[^[:space:]]+$' AND length(avatar_url) <= 500)) NOT VALID;

-- ---------------------------------------------------------------------------------------------------------------------
-- Invitation links. The raw token exists only in the creator's browser; PostgreSQL stores SHA-256(token) only.
--   purpose 'connect'   : bounded-use link that starts a mutual relationship (max_uses 1..25, default 1 in the service)
--   purpose 'introduce' : "find a route to me" target link; resolves to its owner, never consumed
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE invitations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose           text NOT NULL CHECK (purpose IN ('connect','introduce')),
  token_hash        text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  relationship_type text,
  note              text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 200),
  max_uses          integer,
  use_count         integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  CONSTRAINT inv_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT inv_expiry_bounded CHECK (expires_at <= created_at + interval '90 days'),
  CONSTRAINT inv_revoked_after_creation CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT inv_purpose_shape CHECK (
    (purpose = 'connect' AND relationship_type IS NOT NULL AND relationship_type IN ('acquaintance','colleague','classmate','family','community_member') AND max_uses IS NOT NULL AND max_uses BETWEEN 1 AND 25)
    OR (purpose = 'introduce' AND relationship_type IS NULL AND max_uses IS NULL AND note IS NULL)),
  CONSTRAINT inv_use_bounds CHECK (use_count >= 0 AND (max_uses IS NULL OR use_count <= max_uses))
);
CREATE UNIQUE INDEX invitations_token_hash_uq ON invitations (token_hash);
CREATE INDEX invitations_owner_idx ON invitations (owner_id, created_at DESC);

CREATE FUNCTION wcim_invitation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id OR NEW.purpose <> OLD.purpose OR NEW.token_hash <> OLD.token_hash
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.relationship_type IS DISTINCT FROM OLD.relationship_type OR NEW.max_uses IS DISTINCT FROM OLD.max_uses
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'invitation owner, token, purpose, type, expiry and limits are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked invitation cannot be revived' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.use_count < OLD.use_count THEN
    RAISE EXCEPTION 'invitation use_count cannot decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitations_guard BEFORE UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION wcim_invitation_guard();

-- One response per (invitation, user): replaying an accept/decline can never consume a second use.
CREATE TABLE invitation_redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id   uuid NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outcome         text NOT NULL CHECK (outcome IN ('accepted','declined')),
  relationship_id uuid REFERENCES relationships(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redemption_once UNIQUE (invitation_id, user_id)
);
CREATE INDEX invitation_redemptions_user_idx ON invitation_redemptions (user_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- relationships: lifecycle metadata. States are DERIVED, never stored twice:
--   revoked_at IS NOT NULL                          -> ended (ended_reason says why; internal only, never shown to the other side)
--   verification_status = 'confirmed'               -> confirmed (graph-eligible only if wcim_trusted_relationships says so)
--   otherwise                                       -> pending (confirm_by is the deadline for the second confirmation)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE relationships
  ADD COLUMN ended_reason  text CHECK (ended_reason IN ('declined','revoked','blocked','withdrawn','expired')),
  ADD COLUMN ended_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN initiated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN confirm_by    timestamptz,
  ADD COLUMN invitation_id uuid REFERENCES invitations(id) ON DELETE SET NULL,
  ADD CONSTRAINT rel_reason_needs_end CHECK (ended_reason IS NULL OR revoked_at IS NOT NULL);

-- Each participant can independently withhold the relationship from introduction paths without ending it.
ALTER TABLE relationship_confirmations ADD COLUMN allows_traversal boolean NOT NULL DEFAULT true;

-- No duplicate LIVE relationship per pair for relationships created through the invitation lifecycle (invitation_id IS NOT NULL),
-- whatever their type. The 0001 index (per type) and its documented behaviour "same pair, different type allowed" stay unchanged for other rows.
CREATE UNIQUE INDEX relationships_live_pair_uq ON relationships (LEAST(source_user_id, target_user_id), GREATEST(source_user_id, target_user_id))
  WHERE revoked_at IS NULL AND direction = 'mutual' AND invitation_id IS NOT NULL;

CREATE FUNCTION wcim_users_blocked(a uuid, b uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM blocks k WHERE (k.blocker_user_id = a AND k.blocked_user_id = b) OR (k.blocker_user_id = b AND k.blocked_user_id = a))
$$;

CREATE FUNCTION wcim_relationship_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.ended_reason IS DISTINCT FROM OLD.ended_reason) THEN
    RAISE EXCEPTION 'a revoked relationship is terminal (cannot be revived or re-dated)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.verification_status = 'confirmed' AND OLD.verification_status <> 'confirmed' AND wcim_users_blocked(NEW.source_user_id, NEW.target_user_id) THEN
    RAISE EXCEPTION 'cannot confirm a relationship between blocked users' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL AND NEW.ended_reason IS NULL THEN NEW.ended_reason := 'revoked'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER relationships_lifecycle_guard BEFORE UPDATE ON relationships FOR EACH ROW EXECUTE FUNCTION wcim_relationship_lifecycle_guard();

CREATE FUNCTION wcim_confirmation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s uuid; t uuid; ended timestamptz;
BEGIN
  IF OLD.confirmation_status = 'revoked' AND NEW.confirmation_status <> 'revoked' THEN
    RAISE EXCEPTION 'a revoked confirmation is terminal' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.confirmation_status = 'confirmed' AND OLD.confirmation_status = 'pending' THEN
    SELECT source_user_id, target_user_id, revoked_at INTO s, t, ended FROM relationships WHERE id = NEW.relationship_id;
    IF ended IS NOT NULL THEN RAISE EXCEPTION 'cannot confirm a revoked relationship' USING ERRCODE = 'check_violation'; END IF;
    IF wcim_users_blocked(s, t) THEN RAISE EXCEPTION 'cannot confirm a relationship between blocked users' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER confirmations_guard BEFORE UPDATE ON relationship_confirmations FOR EACH ROW EXECUTE FUNCTION wcim_confirmation_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- Trusted-graph eligibility, stated ONCE in SQL (the 8 rules). The graph engine / PgGraphStore must agree with this view.
-- Default policy: imported relationships are NOT trusted (they need an explicit opt-in in the engine).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE VIEW wcim_trusted_relationships AS
SELECT r.*
FROM relationships r
WHERE r.source_user_id <> r.target_user_id                                                            -- 1 distinct participants
  AND r.relationship_type IN ('acquaintance','colleague','classmate','family','community_member')      -- 2 eligible type
  AND r.verification_status = 'confirmed' AND r.confirmed_at IS NOT NULL
  AND (SELECT count(DISTINCT c.confirming_user_id) FROM relationship_confirmations c                  -- 3+4 both confirmations, both active
        WHERE c.relationship_id = r.id AND c.confirmation_status = 'confirmed' AND c.revoked_at IS NULL
          AND c.confirmed_at IS NOT NULL AND c.confirming_user_id IN (r.source_user_id, r.target_user_id)) = 2
  AND r.permission_status = 'granted'                                                                  -- 5 permission
  AND (r.expires_at IS NULL OR r.expires_at > now())                                                   -- 6 not expired
  AND r.revoked_at IS NULL                                                                             -- 7 not revoked
  AND NOT wcim_users_blocked(r.source_user_id, r.target_user_id);                                      -- 8 no block, either direction

-- ---------------------------------------------------------------------------------------------------------------------
-- Blocks: serialised against introduction creation/acceptance by a per-pair advisory lock, and they END live relationships.
-- Lock order everywhere: pair advisory locks (sorted) -> users rows (id order) -> relationship rows (id order).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION wcim_pair_lock_key(a uuid, b uuid) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('pair:' || LEAST(a, b)::text || ':' || GREATEST(a, b)::text, 0)
$$;

CREATE FUNCTION wcim_blocks_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(wcim_pair_lock_key(NEW.blocker_user_id, NEW.blocked_user_id));
  RETURN NEW;
END $$;
CREATE TRIGGER blocks_lock BEFORE INSERT ON blocks FOR EACH ROW EXECUTE FUNCTION wcim_blocks_lock();

CREATE FUNCTION wcim_blocks_end_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE relationships SET revoked_at = now(), ended_reason = 'blocked', ended_by = NEW.blocker_user_id
   WHERE revoked_at IS NULL
     AND ((source_user_id = NEW.blocker_user_id AND target_user_id = NEW.blocked_user_id)
       OR (source_user_id = NEW.blocked_user_id AND target_user_id = NEW.blocker_user_id));
  RETURN NEW;
END $$;
CREATE TRIGGER blocks_end_relationships AFTER INSERT ON blocks FOR EACH ROW EXECUTE FUNCTION wcim_blocks_end_relationships();

-- ---------------------------------------------------------------------------------------------------------------------
-- Reports, relationship audit trail, generic idempotency for retryable creates.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitation_id    uuid REFERENCES invitations(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('user','invitation_abuse')),
  reason           text NOT NULL CHECK (reason IN ('spam','harassment','impersonation','unsafe','other')),
  details          text CHECK (details IS NULL OR length(details) <= 1000),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_not_self CHECK (reporter_id <> reported_user_id)
);
-- One OPEN report per (reporter, reported user, kind): repeated reporting cannot be used to flood the queue.
CREATE UNIQUE INDEX reports_open_once_uq ON reports (reporter_id, reported_user_id, kind) WHERE status = 'open';
CREATE INDEX reports_reporter_idx ON reports (reporter_id, created_at DESC);

CREATE TABLE relationship_audit_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type      text NOT NULL CHECK (event_type IN ('invitation_created','invitation_revoked','invitation_accepted','invitation_declined',
                    'connection_confirmed','connection_declined','connection_revoked','connection_withdrawn','connection_expired',
                    'connection_permission_changed','user_blocked','user_unblocked','report_filed','privacy_changed','profile_changed',
                    'identity_added','identity_removed')),
  actor_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  subject_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  relationship_id uuid REFERENCES relationships(id) ON DELETE CASCADE,
  invitation_id   uuid REFERENCES invitations(id) ON DELETE CASCADE,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),   -- ids/codes only, never message text
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relationship_audit_rel_idx ON relationship_audit_events (relationship_id, id);
CREATE INDEX relationship_audit_actor_idx ON relationship_audit_events (actor_id, id);
CREATE TRIGGER relationship_audit_no_update BEFORE UPDATE ON relationship_audit_events FOR EACH ROW EXECUTE FUNCTION wcim_audit_immutable();

CREATE TABLE mutation_idempotency (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (scope ~ '^[a-z_.]{3,40}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash    text NOT NULL,
  response        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, idempotency_key)
);

COMMIT;
