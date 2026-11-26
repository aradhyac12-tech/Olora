-- 0003_auth.sql — password credentials and revocable server-side sessions. Depends on 0001_graph_core (users).
-- Passwords are stored ONLY as a salted scrypt hash string. Session tokens are stored ONLY as a SHA-256 hex hash (a DB leak must not yield usable tokens).
BEGIN;

CREATE TABLE user_credentials (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%' AND length(password_hash) BETWEEN 40 AND 400),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cred_updated_after_created CHECK (updated_at >= created_at)
);
CREATE TRIGGER user_credentials_updated_at BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION wcim_set_updated_at();

CREATE TABLE auth_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  CONSTRAINT session_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT session_revoked_after_creation CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE UNIQUE INDEX auth_sessions_token_uq ON auth_sessions (token_hash);
CREATE INDEX auth_sessions_user_live_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

COMMIT;
