-- Rollback for 0001_graph_core.sql. Drops ONLY objects created by that migration.
BEGIN;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS consents;
DROP TABLE IF EXISTS relationship_confirmations;
DROP TABLE IF EXISTS relationship_evidence;
DROP TABLE IF EXISTS relationships;
DROP TABLE IF EXISTS external_profiles;
DROP TABLE IF EXISTS users;
DROP FUNCTION IF EXISTS wcim_relationship_integrity();
DROP FUNCTION IF EXISTS wcim_confirmation_participant();
DROP FUNCTION IF EXISTS wcim_set_updated_at();
COMMIT;
