# Privacy model (Slice 4)

- **Private by default.** New accounts: `discoverable=false`, `accepts_introductions=false`. Nothing about them is searchable or linkable until they choose.
- **Two separate consents.** "Let people find me" (discoverable) and "Let people ask me for introductions" (accepts_introductions) are independent. A route needs the target discoverable *and* the connector accepting introductions. Each change updates the `users` flag and the `consents` row in one transaction and writes an audit event.
- **Per-connection permission.** Either participant can pause introductions through one connection (`allows_traversal=false`) without ending it.
- **Mutual, revocable relationships.** A relationship is trusted only when both participants confirmed independently (see Trusted rule). Either side can end it at any time; ending is terminal.
- **Blocks are silent.** The blocked person is never told. Their view of an ended connection looks like any other ended connection (`ended_reason` is internal, never serialised), their links to the blocker read "unavailable", and blocks do not appear in any list they can read. Blocks end live relationships and remove both people from each other's routes immediately (DB trigger + engine + SQL filter).
- **No identifiers leak.** Other users' ids and emails never appear in relationship/invitation/block responses. Search by link reveals only display name + avatar of the link owner and the first-hop connector's name.
- **Names are self-asserted.** The UI says "Name from their own profile · not verified".
- **External handles** (Instagram etc.) are self-declared, visible only to their owner, never used for discovery or trust, and never scraped. There is no OAuth claim to those services.
- **Data rights.** `GET /account/export` returns everything stored about the caller (others only by display name); `POST /account/delete` hard-deletes the account and cascaded rows.
- **Logs.** Tokens are only in POST bodies/URL fragments, never in URLs sent to the server; the API logger redacts `Authorization`; errors carry codes, not data.

## Trusted-relationship rule (all 8, enforced in code and DB)
1. distinct participants; 2. eligible type (acquaintance, colleague, classmate, family, community_member); 3. both confirmations `confirmed` independently; 4. both confirmations not revoked; 5. permission granted (both `allows_traversal`); 6. not expired; 7. not revoked; 8. no block in either direction.
Backend: `PgGraphStore` EDGES_SQL + engine. Database: `wcim_trusted_relationships` view, `wcim_relationship_lifecycle_guard`, `wcim_confirmation_guard`, block triggers.
