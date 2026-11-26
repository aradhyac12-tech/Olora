# Relationship API (Slice 4)

All routes are under `/v1`, need `Authorization: Bearer <session token>`, accept/return JSON, and return errors as `{"error":{"code":"…"}}` (plus `fields:[…]` names for validation errors; submitted values are never echoed). Bodies are parsed with Zod (`apps/api/src/contracts/index.ts`); unknown keys are rejected. Mutations that create things need an `Idempotency-Key` header (8–128 chars `[A-Za-z0-9._:-]`).

Route table: `apps/api/src/social/routes.ts` (framework-agnostic). `server/app.ts` registers it on Fastify.

| Method + path | Purpose | Notes |
|---|---|---|
| `POST /invitations` | create a link | body `{purpose:"connect", relationshipType, note?, maxUses?(1-25), expiresInDays?(1-90)}` or `{purpose:"introduce"}` (find-me link; owner must be discoverable). 201 `{invitation, token}` — **token shown once**; idempotent replay → 200 with `token:null`. Quotas: 50 active, 30/day, 20/hour rate |
| `GET /invitations/sent` | my links | no tokens, ever |
| `POST /invitations/:id/revoke` | owner revokes | non-owner → 404 |
| `POST /invitations/preview` | `{token}` → sender name/avatar, type, note, expiry, `existing` | |
| `POST /invitations/accept` / `decline` | `{token}` | accept creates a **pending** relationship: acceptor confirmed, inviter must confirm. Replay safe |
| `GET /connections?status=` | mine (`all|pending|confirmed|ended`) | other person's id/email never returned |
| `GET /connections/:id` | one of mine | non-participant → 404 |
| `POST /connections/:id/confirm` | the pending participant confirms | both confirmed ⇒ relationship `confirmed` |
| `POST /connections/:id/decline` | pending participant refuses | |
| `POST /connections/:id/revoke` | either side withdraws/ends (terminal, idempotent) | |
| `PUT /connections/:id/permission` | `{allowIntroductions}` | only your own flag; pauses/restores traversal without ending |
| `GET /blocks`, `POST /blocks`, `DELETE /blocks/:id` | `{subject}` where subject is `{connectionId}` \| `{invitationToken}` \| `{introductionId, party}` — **never a raw user id** | idempotent; unblock does not restore anything |
| `POST /reports` | `{subject, reason, details?, alsoBlock?}` + Idempotency-Key | one open report per (reporter, reported, kind) |
| `GET /profile`, `PATCH /profile` | own display name / https avatar | |
| `PUT /privacy` | `{discoverable?, acceptsIntroductions?}` — separate consents, atomic with the consent record | defaults false |
| `POST /identities`, `DELETE /identities/:id` | self-declared handles, always `unverified`, max 10 | |
| `POST /search/by-link` | `{token}` of a find-me link → `{target:{displayName,avatarUrl}, status, routes…}` | the target's id never reaches the client |
| `POST /introductions` | `{connectorId, message, targetId \| targetToken}` | a dead/blocked token answers like "no eligible path" (422) |
| `GET /account/export`, `POST /account/delete` | own data JSON; delete needs `{confirm:"delete my account", password?}` | |
| legacy | `GET /search?targetId=`, introductions list/get/transitions, auth | unchanged |

## Status codes
400 INVALID_INPUT · 401 UNAUTHENTICATED · 403 FORBIDDEN / PROFILE_PRIVATE / INVALID_CREDENTIALS · 404 NOT_FOUND / INVITATION_UNAVAILABLE · 409 INVALID_STATE / ALREADY_CONNECTED · 410 EXPIRED · 422 NOT_ELIGIBLE / IDEMPOTENCY_CONFLICT · 429 RATE_LIMITED / QUOTA_EXCEEDED (with `Retry-After`) · 500 INTERNAL (no detail).
An invitation that is unknown, malformed, expired, revoked, used up, your own, from a blocker/blocked user or from an inactive account is always the **same** 404 `INVITATION_UNAVAILABLE`.

## Rate limits (in-process; `social/rateLimit.ts`)
mutations 60/min/user · token calls 20/min/user and 60/min/IP · failed token lookups lock a user at 10 and an IP at 40 per 15 min · invitation creation 20/hour · block/report/identity 20/min · export 5/hour · failed delete-password 5 per 15 min.
