-- Rollback of 0006_relationship_lifecycle.sql. Removes only objects created by 0006; 0001-0004 objects stay intact.
-- DATA LOSS: invitations, redemptions, reports, relationship audit events, idempotency rows and the new relationship
-- lifecycle columns are dropped. Back up first on a live database.
BEGIN;
DROP TABLE IF EXISTS mutation_idempotency;
DROP TABLE IF EXISTS relationship_audit_events;
DROP TABLE IF EXISTS reports;
DROP TRIGGER IF EXISTS blocks_end_relationships ON blocks;
DROP TRIGGER IF EXISTS blocks_lock ON blocks;
DROP FUNCTION IF EXISTS wcim_blocks_end_relationships();
DROP FUNCTION IF EXISTS wcim_blocks_lock();
DROP VIEW IF EXISTS wcim_trusted_relationships;
DROP TRIGGER IF EXISTS confirmations_guard ON relationship_confirmations;
DROP TRIGGER IF EXISTS relationships_lifecycle_guard ON relationships;
DROP FUNCTION IF EXISTS wcim_confirmation_guard();
DROP FUNCTION IF EXISTS wcim_relationship_lifecycle_guard();
DROP INDEX IF EXISTS relationships_live_pair_uq;
ALTER TABLE relationship_confirmations DROP COLUMN IF EXISTS allows_traversal;
ALTER TABLE relationships DROP CONSTRAINT IF EXISTS rel_reason_needs_end;
ALTER TABLE relationships DROP COLUMN IF EXISTS invitation_id, DROP COLUMN IF EXISTS confirm_by, DROP COLUMN IF EXISTS initiated_by,
  DROP COLUMN IF EXISTS ended_by, DROP COLUMN IF EXISTS ended_reason;
DROP FUNCTION IF EXISTS wcim_pair_lock_key(uuid, uuid);
DROP FUNCTION IF EXISTS wcim_users_blocked(uuid, uuid);
DROP TABLE IF EXISTS invitation_redemptions;
DROP TRIGGER IF EXISTS invitations_guard ON invitations;
DROP FUNCTION IF EXISTS wcim_invitation_guard();
DROP TABLE IF EXISTS invitations;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_avatar_https;
COMMIT;
