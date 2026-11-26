-- Rollback for 0002_introductions.sql. Drops ONLY objects created by that migration.
BEGIN;
DROP TABLE IF EXISTS notification_outbox;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS introduction_idempotency;
DROP TABLE IF EXISTS introduction_requests;
DROP FUNCTION IF EXISTS wcim_audit_immutable();
DROP FUNCTION IF EXISTS wcim_intro_guard();
COMMIT;
