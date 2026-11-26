-- Supabase only. Slice 4 tables: RLS on + NO policies = the public anon key cannot read or write them through the Data API.
-- The API connects to Postgres directly as the table owner (bypasses RLS). Apply AFTER 0006_relationship_lifecycle.sql.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_idempotency ENABLE ROW LEVEL SECURITY;
