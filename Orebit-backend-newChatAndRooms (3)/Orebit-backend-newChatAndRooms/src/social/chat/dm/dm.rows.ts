// The rows of personal chat as the dboperations read them (Modules 8–9): a message with its metadata, a member, and the
// SQL that selects them. Pure types, mappers and SQL fragments; nothing here touches the database.
import { Prisma } from '@prisma/client';
import { TIME_TEXT } from '../persistence/chat.sql';
import type { MediaType } from '../chat.types';
import type { DmFolder, GroupRole, MemberState } from './dm.rules';

export type DmMessageType = 'TEXT' | 'MEDIA' | 'GIFT' | 'CARD' | 'SYSTEM';

export interface DmMetadata {
  media?: { type: MediaType; url: string; caption?: string; thumbnailUrl?: string };
  // "forwarded texts will have a quote or notice of Forwarded".
  forwarded?: { fromUsername: string | null };
  // Links in the text, for "shared links" in the conversation info.
  links?: string[];
  gift?: {
    giftId: string;
    recipientId?: string;
    recipientUsername: string;
    currency: string;
    amount: string;
  };
  // A gift card sent in the chat: what it is, never its code.
  card?: { title: string; amount: string; currency: string; receiverUsername: string };
  // SYSTEM rows: what happened (a group created, a member added…).
  event?: {
    kind: string;
    actorId?: string;
    targetId?: string;
    actorUsername?: string;
    targetUsername?: string;
    value?: string;
    // A membership notice: how many joined and left in its window.
    joined?: number;
    left?: number;
  };
}

export interface DmMessageRow {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly senderUsername: string | null;
  readonly content: string;
  readonly type: DmMessageType;
  readonly metadata: DmMetadata;
  readonly clientMessageId: string | null;
  readonly createdAt: Date;
  readonly createdAtText: string;
  readonly retractedAt: Date | null;
  readonly hiddenAt: Date | null;
  readonly pinnedAt: Date | null;
}

export interface DmMessageSql {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_username: string | null;
  content: string;
  type: DmMessageType;
  metadata: DmMetadata | null;
  client_message_id: string | null;
  created_at: Date;
  created_at_text: string;
  retracted_at: Date | null;
  hidden_at: Date | null;
  pinned_at: Date | null;
}

export const DM_MESSAGE_SELECT = Prisma.sql`
  SELECT m.id, m.conversation_id, m.sender_id, u.username AS sender_username, m.content, m.type, m.metadata,
         m.client_message_id, m.created_at, ${TIME_TEXT('m.created_at')} AS created_at_text, m.retracted_at,
         m.hidden_at, m.pinned_at
  FROM chat.dm_messages m
  LEFT JOIN identity.users u ON u.id = m.sender_id AND u.deleted_at IS NULL
`;

export const DM_MESSAGE_REPORT_SELECT = (id: string) => Prisma.sql`
  SELECT m.id, m.conversation_id, m.sender_id, u.username AS sender_username, m.content, m.type, m.metadata,
         m.client_message_id, m.created_at, ${TIME_TEXT('m.created_at')} AS created_at_text, m.retracted_at,
         m.hidden_at, m.pinned_at
  FROM chat.dm_message_for_report(${id}::uuid, NULL::timestamptz) m
  LEFT JOIN identity.users u ON u.id = m.sender_id AND u.deleted_at IS NULL
`;

export const toDmMessage = (row: DmMessageSql): DmMessageRow => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  senderUsername: row.sender_username ?? (row.type === 'SYSTEM' ? null : 'Deleted user'),
  content: row.content,
  type: row.type,
  metadata: row.metadata ?? {},
  clientMessageId: row.client_message_id,
  createdAt: row.created_at,
  createdAtText: row.created_at_text,
  retractedAt: row.retracted_at,
  hiddenAt: row.hidden_at,
  pinnedAt: row.pinned_at,
});

export interface MemberRow {
  readonly conversationId: string;
  readonly kind: 'DIRECT' | 'GROUP';
  readonly userId: string;
  readonly username: string | null;
  readonly role: GroupRole;
  readonly state: MemberState;
  readonly folder: DmFolder;
  readonly folderChosen: boolean;
  readonly pinnedAt: Date | null;
  readonly nickname: string | null;
  readonly notifications: 'DEFAULT' | 'ON' | 'OFF';
  readonly lastReadMessageId: string | null;
  readonly lastReadAt: Date | null;
  readonly timeoutUntil: Date | null;
  readonly joinedAt: Date;
}

export interface MemberSql {
  conversation_id: string;
  kind: 'DIRECT' | 'GROUP';
  user_id: string;
  username: string | null;
  role: GroupRole;
  state: MemberState;
  folder: DmFolder;
  folder_chosen: boolean;
  pinned_at: Date | null;
  nickname: string | null;
  notifications: 'DEFAULT' | 'ON' | 'OFF';
  last_read_message_id: string | null;
  last_read_at: Date | null;
  timeout_until: Date | null;
  joined_at: Date;
}

export const MEMBER_SELECT = Prisma.sql`
  SELECT dm.conversation_id, c.kind, dm.user_id, u.username, dm.role, dm.state, dm.folder, dm.folder_chosen,
         dm.pinned_at, dm.nickname, dm.notifications, dm.last_read_message_id, dm.last_read_at, dm.timeout_until,
         dm.joined_at
  FROM chat.dm_members dm
  JOIN chat.dm_conversations c ON c.id = dm.conversation_id
  LEFT JOIN identity.users u ON u.id = dm.user_id AND u.deleted_at IS NULL
`;

export const toMember = (row: MemberSql): MemberRow => ({
  conversationId: row.conversation_id,
  kind: row.kind,
  userId: row.user_id,
  username: row.username,
  role: row.role,
  state: row.state,
  folder: row.folder,
  folderChosen: row.folder_chosen,
  pinnedAt: row.pinned_at,
  nickname: row.nickname,
  notifications: row.notifications,
  lastReadMessageId: row.last_read_message_id,
  lastReadAt: row.last_read_at,
  timeoutUntil: row.timeout_until,
  joinedAt: row.joined_at,
});
