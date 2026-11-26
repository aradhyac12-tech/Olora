// One place that turns a relationship row into the ConnectionView a PARTICIPANT may see.
// Never exposes: the other user's id or email, ended_reason (so a block is indistinguishable from the other side revoking), or the other side's permission choice.
import type { PgQueryable } from '../graph/pgStore.ts';
import type { ConnectionView, RelationshipTypeName } from '../contracts/index.ts';
import { asDate, asStr, TRUSTED_TYPES } from './db.ts';

export const CONNECTION_SELECT = `
SELECT r.id, r.relationship_type, r.verification_status, r.created_at, r.confirmed_at, r.expires_at, r.revoked_at, r.confirm_by,
       (r.ended_by IS NOT NULL AND r.ended_by = $1::uuid) AS ended_by_me,
       (r.expires_at IS NOT NULL AND r.expires_at <= now()) AS rel_expired,
       (r.confirm_by IS NOT NULL AND r.confirm_by <= now()) AS confirm_overdue,
       o.display_name AS other_name, o.avatar_url AS other_avatar, i.note AS note,
       mc.confirmation_status AS my_status, mc.allows_traversal AS my_allows,
       EXISTS (SELECT 1 FROM wcim_trusted_relationships t WHERE t.id = r.id) AS trusted
  FROM relationships r
  JOIN relationship_confirmations mc ON mc.relationship_id = r.id AND mc.confirming_user_id = $1::uuid
  JOIN users o ON o.id = CASE WHEN r.source_user_id = $1::uuid THEN r.target_user_id ELSE r.source_user_id END
  LEFT JOIN invitations i ON i.id = r.invitation_id
 WHERE (r.source_user_id = $1::uuid OR r.target_user_id = $1::uuid) AND r.direction = 'mutual' AND r.relationship_type = ANY($2::text[])`;

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => { const d = asDate(v); return d ? d.toISOString() : null; };

export function toConnectionView(r: Row): ConnectionView {
  const base = {
    id: asStr(r.id), relationshipType: asStr(r.relationship_type) as RelationshipTypeName,
    other: { displayName: asStr(r.other_name), avatarUrl: r.other_avatar === null ? null : asStr(r.other_avatar) },
    note: r.note === null || r.note === undefined ? null : asStr(r.note),
    createdAt: iso(r.created_at)!, confirmedAt: iso(r.confirmed_at), expiresAt: iso(r.expires_at),
    yourPermission: r.my_allows === true ? 'granted' as const : 'withheld' as const,
    introductionsActive: r.trusted === true, endedByMe: false, confirmBy: null as string | null,
  };
  const ended = (at: unknown, byMe = false): ConnectionView => ({ ...base, status: 'ended', awaiting: null, endedAt: iso(at), endedByMe: byMe, introductionsActive: false });
  if (r.revoked_at !== null && r.revoked_at !== undefined) return ended(r.revoked_at, r.ended_by_me === true);
  if (asStr(r.my_status) === 'revoked') return ended(r.created_at);
  if (asStr(r.verification_status) === 'confirmed') return r.rel_expired === true ? ended(r.expires_at) : { ...base, status: 'confirmed', awaiting: null, endedAt: null };
  if (r.confirm_overdue === true) return ended(r.confirm_by);
  return { ...base, status: 'pending', awaiting: asStr(r.my_status) === 'pending' ? 'you' : 'them', endedAt: null, confirmBy: iso(r.confirm_by) };
}

export async function loadConnection(c: PgQueryable, userId: string, relationshipId: string): Promise<ConnectionView | null> {
  const { rows } = await c.query(`${CONNECTION_SELECT} AND r.id = $3::uuid`, [userId, [...TRUSTED_TYPES], relationshipId]);
  return rows[0] ? toConnectionView(rows[0]) : null;
}
