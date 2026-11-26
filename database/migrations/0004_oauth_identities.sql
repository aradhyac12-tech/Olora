-- 0004_oauth_identities.sql — links an external identity (Supabase Auth subject) to a local user. Depends on 0001 (users).
-- Only the opaque subject id is stored: no provider tokens. (provider, subject) is globally unique so one identity can never map to two users.
BEGIN;
CREATE TABLE oauth_identities (
  provider   text NOT NULL CHECK (provider ~ '^[a-z0-9_-]{1,32}$'),
  subject    text NOT NULL CHECK (length(subject) BETWEEN 1 AND 128),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX oauth_identities_user_idx ON oauth_identities (user_id);
COMMIT;
