-- 0001_graph_core.sql — UNVERIFIED until run against real PostgreSQL (see database/README.md)
-- Requires PostgreSQL >= 13 (gen_random_uuid is built in). No extensions needed.
BEGIN;

CREATE FUNCTION wcim_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL,
  display_name          text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  avatar_url            text,
  account_status        text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended','deactivated','deleted')),
  discoverable          boolean NOT NULL DEFAULT false,
  accepts_introductions boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_format CHECK (email = lower(btrim(email)) AND position('@' in email) > 1),
  CONSTRAINT users_updated_after_created CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION wcim_set_updated_at();

CREATE TABLE external_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform            text NOT NULL CHECK (platform IN ('instagram','linkedin','x','github','website','other')),
  username            text NOT NULL CHECK (length(btrim(username)) BETWEEN 1 AND 100),
  normalized_username text NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','verified')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ext_norm_matches CHECK (normalized_username = lower(btrim(username))),
  CONSTRAINT ext_updated_after_created CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX external_profiles_user_claim_uq ON external_profiles (user_id, platform, normalized_username);
-- Only ONE user may hold a VERIFIED claim on a platform username (no unauthorized ownership).
CREATE UNIQUE INDEX external_profiles_verified_owner_uq ON external_profiles (platform, normalized_username) WHERE verification_status = 'verified';
CREATE INDEX external_profiles_lookup_idx ON external_profiles (platform, normalized_username);
CREATE TRIGGER external_profiles_updated_at BEFORE UPDATE ON external_profiles FOR EACH ROW EXECUTE FUNCTION wcim_set_updated_at();

CREATE TABLE relationships (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship_type   text NOT NULL CHECK (relationship_type IN ('acquaintance','colleague','classmate','family','community_member','one_sided','imported','social_follow')),
  direction           text NOT NULL DEFAULT 'mutual' CHECK (direction IN ('mutual','directed')),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','confirmed')),
  permission_status   text NOT NULL DEFAULT 'pending' CHECK (permission_status IN ('pending','granted','denied')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_at        timestamptz,
  expires_at          timestamptz,
  revoked_at          timestamptz,
  CONSTRAINT rel_no_self_edge CHECK (source_user_id <> target_user_id),
  CONSTRAINT rel_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT rel_confirmed_has_timestamp CHECK ((verification_status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CONSTRAINT rel_revoked_after_creation CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT rel_updated_after_created CHECK (updated_at >= created_at)
);
-- Duplicate LIVE edge prevention (live = not revoked). Mutual edges are unordered pairs.
CREATE UNIQUE INDEX relationships_live_mutual_uq ON relationships (LEAST(source_user_id, target_user_id), GREATEST(source_user_id, target_user_id), relationship_type)
  WHERE revoked_at IS NULL AND direction = 'mutual';
CREATE UNIQUE INDEX relationships_live_directed_uq ON relationships (source_user_id, target_user_id, relationship_type)
  WHERE revoked_at IS NULL AND direction = 'directed';
CREATE INDEX relationships_source_live_idx ON relationships (source_user_id, id) WHERE revoked_at IS NULL;
CREATE INDEX relationships_target_live_idx ON relationships (target_user_id, id) WHERE revoked_at IS NULL;
CREATE TRIGGER relationships_updated_at BEFORE UPDATE ON relationships FOR EACH ROW EXECUTE FUNCTION wcim_set_updated_at();

CREATE TABLE relationship_evidence (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id    uuid NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  evidence_type      text NOT NULL CHECK (evidence_type IN ('verified_identity_link','shared_community','user_asserted','imported_record')),
  evidence_reference text,
  submitted_by       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relationship_evidence_rel_idx ON relationship_evidence (relationship_id);

CREATE TABLE relationship_confirmations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id     uuid NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  confirming_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confirmation_status text NOT NULL DEFAULT 'pending' CHECK (confirmation_status IN ('pending','confirmed','revoked')),
  confirmed_at        timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conf_one_per_user UNIQUE (relationship_id, confirming_user_id),
  CONSTRAINT conf_status_timestamps CHECK (
    (confirmation_status = 'pending'   AND confirmed_at IS NULL     AND revoked_at IS NULL) OR
    (confirmation_status = 'confirmed' AND confirmed_at IS NOT NULL AND revoked_at IS NULL) OR
    (confirmation_status = 'revoked'   AND revoked_at IS NOT NULL)),
  CONSTRAINT conf_updated_after_created CHECK (updated_at >= created_at)
);
CREATE INDEX relationship_confirmations_user_idx ON relationship_confirmations (confirming_user_id);

-- A confirmation must belong to one of the two actual participants.
CREATE FUNCTION wcim_confirmation_participant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s uuid; t uuid;
BEGIN
  SELECT source_user_id, target_user_id INTO s, t FROM relationships WHERE id = NEW.relationship_id;
  IF NEW.confirming_user_id IS DISTINCT FROM s AND NEW.confirming_user_id IS DISTINCT FROM t THEN
    RAISE EXCEPTION 'confirming user is not a participant of this relationship' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER confirmations_participant BEFORE INSERT OR UPDATE OF relationship_id, confirming_user_id ON relationship_confirmations
  FOR EACH ROW EXECUTE FUNCTION wcim_confirmation_participant();
CREATE TRIGGER confirmations_updated_at BEFORE UPDATE ON relationship_confirmations FOR EACH ROW EXECUTE FUNCTION wcim_set_updated_at();

-- Relationship integrity: participants/type are immutable; a non-imported relationship may only be
-- marked 'confirmed' when BOTH participants hold a live confirmation (not a service-side flag).
CREATE FUNCTION wcim_relationship_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.source_user_id <> OLD.source_user_id OR NEW.target_user_id <> OLD.target_user_id
       OR NEW.relationship_type <> OLD.relationship_type OR NEW.direction <> OLD.direction) THEN
    RAISE EXCEPTION 'relationship participants, type and direction are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.verification_status = 'confirmed' AND NEW.relationship_type <> 'imported'
     AND (TG_OP = 'INSERT' OR OLD.verification_status <> 'confirmed') THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'cannot insert a pre-confirmed relationship without confirmations' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(DISTINCT c.confirming_user_id) INTO n FROM relationship_confirmations c
     WHERE c.relationship_id = NEW.id AND c.confirmation_status = 'confirmed' AND c.revoked_at IS NULL
       AND c.confirming_user_id IN (NEW.source_user_id, NEW.target_user_id);
    IF n <> 2 THEN
      RAISE EXCEPTION 'relationship needs confirmations from both participants' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER relationships_integrity BEFORE INSERT OR UPDATE ON relationships FOR EACH ROW EXECUTE FUNCTION wcim_relationship_integrity();

CREATE TABLE consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type text NOT NULL CHECK (consent_type IN ('discoverability','introduction_requests','data_import','profile_visibility')),
  granted      boolean NOT NULL DEFAULT false,
  granted_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consents_one_per_type UNIQUE (user_id, consent_type),
  CONSTRAINT consents_granted_has_timestamp CHECK (NOT granted OR granted_at IS NOT NULL),
  CONSTRAINT consents_updated_after_created CHECK (updated_at >= created_at)
);
CREATE TRIGGER consents_updated_at BEFORE UPDATE ON consents FOR EACH ROW EXECUTE FUNCTION wcim_set_updated_at();

CREATE TABLE blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blocks_no_self_block CHECK (blocker_user_id <> blocked_user_id),
  CONSTRAINT blocks_unique_pair UNIQUE (blocker_user_id, blocked_user_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_user_id);

COMMIT;
