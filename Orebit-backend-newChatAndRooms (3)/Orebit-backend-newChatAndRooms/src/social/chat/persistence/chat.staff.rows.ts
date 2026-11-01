// Row types and mappers for staff tools and restrictions (Module 4). Extracted from chat.staff.dboperation.ts to keep
// every file under 500 lines (Rule C.2).
import type { RestrictionKind, RestrictionTarget, StaffRole } from '../chat.contract';

// A chat-wide or room restriction from chat.user_restrictions.
export interface RestrictionRecord {
  readonly id: string;
  readonly targetType: RestrictionTarget;
  readonly targetValue: string;
  readonly kind: RestrictionKind;
  readonly commands: readonly string[];
  readonly roomId: string | null;
  // Written by staff or an admin; never shown to the user.
  readonly internalReason: string;
  // The optional reason the user sees.
  readonly userReason: string | null;
  readonly createdBy: string | null;
  readonly createdByAdmin: string | null;
  readonly createdByRole: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

export interface RestrictionSqlRow {
  id: string;
  target_type: RestrictionTarget;
  target_value: string;
  kind: RestrictionKind;
  commands: string[];
  room_id: string | null;
  internal_reason: string;
  user_reason: string | null;
  created_by: string | null;
  created_by_admin: string | null;
  created_by_role: string | null;
  created_at: Date;
  expires_at: Date | null;
}

export const toRestriction = (row: RestrictionSqlRow): RestrictionRecord => ({
  id: row.id,
  targetType: row.target_type,
  targetValue: row.target_value,
  kind: row.kind,
  commands: row.commands ?? [],
  roomId: row.room_id,
  internalReason: row.internal_reason,
  userReason: row.user_reason,
  createdBy: row.created_by,
  createdByAdmin: row.created_by_admin,
  createdByRole: row.created_by_role,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

export interface StaffRequestRecord {
  readonly id: string;
  readonly requesterId: string;
  readonly requesterUsername: string | null;
  readonly requesterRole: StaffRole;
  readonly permission: string;
  readonly targetUserId: string | null;
  readonly targetUsername: string | null;
  readonly targetRoomId: string | null;
  readonly payload: Record<string, unknown>;
  readonly note: string;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED';
  readonly resolutionNote: string | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface BanRecord {
  readonly id: string;
  readonly userId: string;
  readonly roomId: string | null;
  readonly internalReason: string;
  readonly userReason: string | null;
  readonly moderatorId: string | null;
  readonly adminId: string | null;
  // The issuing staff member's current chat role; null for admins and auto-moderation.
  readonly moderatorRole: StaffRole | null;
  readonly bannedAt: Date;
  readonly expiresAt: Date | null;
  readonly isActive: boolean;
}
