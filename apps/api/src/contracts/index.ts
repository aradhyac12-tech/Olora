// Typed request (Zod) and response (TypeScript) contracts for the relationship API. Every body/query/param is parsed here;
// nothing downstream sees unvalidated input. Unknown keys are rejected (.strict()).
import { z } from 'zod';

export const RELATIONSHIP_TYPES = ['acquaintance', 'colleague', 'classmate', 'family', 'community_member'] as const;
export type RelationshipTypeName = (typeof RELATIONSHIP_TYPES)[number];
export const PLATFORMS = ['instagram', 'linkedin', 'x', 'github', 'website', 'other'] as const;
export const REPORT_REASONS = ['spam', 'harassment', 'impersonation', 'unsafe', 'other'] as const;

// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const text = (min: number, max: number) => z.string().trim().min(min).max(max).regex(NO_CONTROL);
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const uuidSchema = z.string().uuid();

/** https only, no credentials, no IP literals / localhost / single-label hosts (avatars are loaded by OTHER users' browsers). */
export function isSafeAvatarUrl(v: string): boolean {
  if (v.length > 500 || /\s/.test(v)) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^\d+(\.\d+){3}$/.test(h) || h.startsWith('[')) return false;
  return true;
}
const avatarUrl = z.string().trim().refine(isSafeAvatarUrl, 'avatar must be a public https URL');

export const CreateInvitationBody = z.object({
  purpose: z.enum(['connect', 'introduce']).default('connect'),
  relationshipType: z.enum(RELATIONSHIP_TYPES).optional(),
  note: text(1, 200).optional(),
  maxUses: z.number().int().min(1).max(25).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
}).strict().superRefine((b, ctx) => {
  if (b.purpose === 'connect' && !b.relationshipType) ctx.addIssue({ code: 'custom', path: ['relationshipType'], message: 'required for a connect invitation' });
  if (b.purpose === 'introduce' && (b.relationshipType || b.note || b.maxUses)) ctx.addIssue({ code: 'custom', message: 'a target link carries no type, note or use limit' });
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationBody>;

export const TokenBody = z.object({ token: tokenSchema }).strict();
export const IdParams = z.object({ id: uuidSchema }).strict();
export const ConnectionsQuery = z.object({ status: z.enum(['confirmed', 'pending', 'ended', 'all']).default('all') }).strict();
export const PermissionBody = z.object({ allowIntroductions: z.boolean() }).strict();

export const ProfilePatchBody = z.object({
  displayName: text(1, 100).optional(),
  avatarUrl: z.union([avatarUrl, z.null()]).optional(),
}).strict().refine((b) => b.displayName !== undefined || b.avatarUrl !== undefined, 'nothing to update');
export type ProfilePatch = z.infer<typeof ProfilePatchBody>;

export const PrivacyBody = z.object({ discoverable: z.boolean().optional(), acceptsIntroductions: z.boolean().optional() })
  .strict().refine((b) => b.discoverable !== undefined || b.acceptsIntroductions !== undefined, 'nothing to update');
export type PrivacyInput = z.infer<typeof PrivacyBody>;

export const IdentityBody = z.object({ platform: z.enum(PLATFORMS), username: text(1, 100).transform((s) => s.replace(/^@/, '')) }).strict()
  .refine((b) => b.username.length >= 1 && /^[A-Za-z0-9._\-/:]+$/.test(b.username), 'invalid handle');
export type IdentityInput = z.infer<typeof IdentityBody>;

/** Who a block/report refers to. NEVER a raw user id: only things the caller legitimately holds. */
export const SubjectSchema = z.union([
  z.object({ connectionId: uuidSchema }).strict(),
  z.object({ invitationToken: tokenSchema }).strict(),
  z.object({ introductionId: uuidSchema, party: z.enum(['requester', 'connector', 'target']) }).strict(),
]);
export type Subject = z.infer<typeof SubjectSchema>;
export const BlockBody = z.object({ subject: SubjectSchema }).strict();
export const ReportBody = z.object({
  subject: SubjectSchema, reason: z.enum(REPORT_REASONS), details: text(1, 1000).optional(), alsoBlock: z.boolean().optional(),
}).strict();
export type ReportInput = z.infer<typeof ReportBody>;

export const DeleteAccountBody = z.object({ confirm: z.literal('delete my account'), password: z.string().min(1).max(128).optional() }).strict();
export const ByLinkSearchBody = TokenBody;
export const IntroCreateBody = z.object({
  connectorId: uuidSchema, message: text(1, 1000),
  targetId: uuidSchema.optional(), targetToken: tokenSchema.optional(),
}).strict().refine((b) => (b.targetId === undefined) !== (b.targetToken === undefined), 'exactly one of targetId / targetToken');

export const idemKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

// ---------------------------------------------------------------- response contracts
export type InvitationStatus = 'active' | 'used' | 'expired' | 'revoked';
export interface InvitationView {
  id: string; purpose: 'connect' | 'introduce'; relationshipType: RelationshipTypeName | null; note: string | null;
  maxUses: number | null; useCount: number; status: InvitationStatus; createdAt: string; expiresAt: string;
}
export interface InvitationCreated { invitation: InvitationView; /** shown exactly once; null on an idempotent replay */ token: string | null; replayed: boolean }
export interface PersonView { displayName: string; avatarUrl: string | null }
export interface InvitationPreview {
  purpose: 'connect' | 'introduce'; from: PersonView; relationshipType: RelationshipTypeName | null; note: string | null; expiresAt: string;
  /** relationship the viewer already has with the sender, if any (their own data) */ existing: 'none' | 'confirmed' | 'pending';
}
export type ConnectionStatus = 'confirmed' | 'pending' | 'ended';
export interface ConnectionView {
  id: string; status: ConnectionStatus; /** pending only: who must act next */ awaiting: 'you' | 'them' | null;
  relationshipType: RelationshipTypeName; other: PersonView; note: string | null;
  createdAt: string; confirmedAt: string | null; expiresAt: string | null; endedAt: string | null; endedByMe: boolean;
  /** pending only: deadline for the second confirmation */ confirmBy: string | null;
  yourPermission: 'granted' | 'withheld'; /** true only when this relationship currently counts for trusted paths */ introductionsActive: boolean;
}
export interface ProfileView {
  displayName: string; email: string; avatarUrl: string | null; discoverable: boolean; acceptsIntroductions: boolean;
  signIn: { password: boolean; google: boolean };
  identities: Array<{ id: string; platform: string; username: string; verification: 'unverified' | 'pending' | 'verified' }>;
}
export interface BlockView { id: string; displayName: string; avatarUrl: string | null; createdAt: string }
