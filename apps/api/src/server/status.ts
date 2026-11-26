// HTTP status for every error code the API can return (introduction, auth, relationship). One table so routes cannot drift apart.
import type { ErrorCode } from '../introductions/service.ts';
import type { AuthErrorCode } from '../auth/service.ts';
import type { SocialCode } from '../social/db.ts';

export type ApiCode = ErrorCode | AuthErrorCode | SocialCode | 'UNAUTHENTICATED';
export const STATUS: Record<ApiCode, number> = {
  UNAUTHENTICATED: 401, INVALID_CREDENTIALS: 401, EMAIL_TAKEN: 409, OAUTH_DISABLED: 503, RATE_LIMITED: 429, INVALID_INPUT: 400, NOT_FOUND: 404, FORBIDDEN: 403, INVALID_STATE: 409, DUPLICATE_OPEN: 409,
  EXPIRED: 410, NOT_ELIGIBLE: 422, IDEMPOTENCY_CONFLICT: 422, TOO_MANY_OPEN: 429, INTERNAL: 500,
  // relationship API. A link that is unknown, expired, revoked, used up, blocked or your own is ONE answer: 404 INVITATION_UNAVAILABLE.
  INVITATION_UNAVAILABLE: 404, ALREADY_CONNECTED: 409, PROFILE_PRIVATE: 403, QUOTA_EXCEEDED: 429,
};
