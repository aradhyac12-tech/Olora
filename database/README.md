# Database

PostgreSQL >= 13, no extensions. Numbered migrations with `.down.sql` rollbacks.

    npm run db:up && npm run test:db      # apply, constraint tests, rollback, re-apply
    # exit 0 = PASSED, 1 = FAILED, 3 = NOT RUN (never a pass)

**Status:** migrations 0001 + 0002 verified on PostgreSQL 16.15 (native install): apply, 86 constraint assertions, rollback in reverse
order (unrelated objects untouched), re-apply. `0002` constraint tests live in `tests/0002_introductions.test.sql`.
Never verified: the `postgres:16-alpine` docker image (`npm run db:up`) and GitHub Actions' service container.

Design notes
- Confirmation integrity is enforced in the DB: unique (relationship, user), participant trigger, and a trigger refusing to mark a
  non-imported relationship `confirmed` unless both participants hold a live confirmation.
- "Live" duplicate prevention = not revoked. Expired-but-unrevoked edges still occupy the slot (index predicates cannot use now()).
- `users.discoverable/accepts_introductions` are the effective flags used by search. The `consents` table is the consent record;
  keeping them in sync is a Slice 2 service responsibility (not yet enforced by the DB).
- Later migrations will need least-privilege roles; none are defined yet.
