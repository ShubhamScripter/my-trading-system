import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../../db/client';

/** A stored report row (chat.chat_message_reports), as the services read it. */
export interface ReportRow {
  id: string;
  message_id: string | null;
  dm_message_id: string | null;
  reporter_id: string;
  reported_user_id: string;
  reason: string;
  details: string | null;
  status: string;
}

/** One entry of the moderation log as the admin panel shows it. */
export interface ModerationLogEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  actorName: string;
  action: string;
  targetUserId: string | null;
  targetUsername: string | null;
  targetRoomId: string | null;
  targetRoomName: string | null;
  targetMessageId: string | null;
  newValue: unknown;
  note: string | null;
  createdAt: string;
}

/** The time text and the id of a list cursor; both null for the first page. */
export function splitCursor(cursor: string | undefined): [string | null, string | null] {
  if (!cursor) return [null, null];
  const cut = cursor.lastIndexOf('_');
  return [cursor.slice(0, cut), cursor.slice(cut + 1)];
}

export interface ReportListRow {
  id: string;
  cursorAt: string;
  messageId: string | null;
  dmMessageId: string | null;
  conversationId: string | null;
  reportedUserId: string;
  reporterId: string;
  reason: string;
  details: string | null;
  status: string;
  action: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  messageContent: string | null;
  roomId: string | null;
  roomName: string | null;
  reporterUsername: string | null;
  reportedUsername: string | null;
}

export interface BanListRow {
  id: string;
  cursorAt: string;
  userId: string;
  roomId: string | null;
  moderatorId: string | null;
  adminId: string | null;
  internalReason: string;
  userReason: string | null;
  bannedAt: Date;
  expiresAt: Date | null;
  isActive: boolean;
  liftedBy: string | null;
  liftedAt: Date | null;
  username: string | null;
  roomName: string | null;
}

export interface LogRow {
  id: string;
  actorType: string;
  actorId: string | null;
  actorUsername: string | null;
  action: string;
  targetUserId: string | null;
  targetUsername: string | null;
  targetRoomId: string | null;
  targetRoomName: string | null;
  targetMessageId: string | null;
  newValue: unknown;
  note: string | null;
  createdAt: Date;
  cursorAt: string;
}

/** One row for the append-only moderation log. */
export interface ModerationActionInput {
  actorId: string;
  action: string;
  targetUserId?: string | null;
  targetRoomId?: string | null;
  targetMessageId?: string | null;
  targetMessageCreatedAt?: Date | null;
  oldValue?: unknown;
  newValue?: unknown;
  note?: string | null;
}

/** The pool, or the transaction a caller is running in. */
export type Db = PrismaService | Prisma.TransactionClient;

