-- Rollback for 0003_auth.sql. Drops ONLY objects created by that migration.
BEGIN;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS user_credentials;
COMMIT;
