-- Supabase only (already applied to the olora project as migration 0005_enable_rls_deny_data_api).
-- The API connects to Postgres directly as the table owner (bypasses RLS). RLS on + NO policies = the public anon key cannot read or write any of these tables via the Data API.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE introduction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE introduction_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_identities ENABLE ROW LEVEL SECURITY;
