/** Database access for chat messages, rooms, user lookups, and account preferences. */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../db/client';
import { uuidv7 } from '../../utils/public.utils';
import { ROOM_TYPES, type StaffRole } from './chat.contract';
import {
  MESSAGE_SELECT,
  ROOM_SELECT,
  TIME_TEXT,
  isUniqueViolation,
  toMessageRow,
  toRoomRecord,
  type Db,
  type MessageSqlRow,
  type RoomConfigProblem,
  type RoomSqlRow,
} from './persistence/chat.sql';
import type {
  ChatUserContext,
  MessageMetadata,
  MessageRow,
  MessageType,
  RoomRecord,
} from './chat.types';

export type { RoomConfigProblem } from './persistence/chat.sql';

export interface InsertMessage {
  roomId: string;
  userId: string;
  content: string;
  type: MessageType;
  skinId: string | null;
  metadata: MessageMetadata;
  /** Users to add to the tag feed, already filtered to those who may view the room. */
  taggedUserIds: readonly string[];
  clientMessageId?: string;
}

/** Whether a stored room type is one chat knows (ROOM_TYPES); others are skipped. */
function isKnownRoomType(type: string): boolean {
  return (ROOM_TYPES as readonly string[]).includes(type);
}

/** Reads and writes chat messages, rooms, users and preferences. Services never query Prisma directly. */
@Injectable()
export class ChatDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Clock
  async dbNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]!.now;
  }

  // Rooms
  /** Every room that is not deleted, for the room cache. */
  async loadRooms(onProblem?: (problem: RoomConfigProblem) => void): Promise<RoomRecord[]> {
    const rows = await this.prisma.$queryRaw<RoomSqlRow[]>`
      ${ROOM_SELECT}
      WHERE r.deleted_at IS NULL
      ORDER BY r.created_at, r.id
    `;
    // A room of a type chat no longer has (an old VIP room) is treated as not existing, never as open.
    return rows
      .filter((row) => isKnownRoomType(row.type))
      .map((row) => toRoomRecord(row, onProblem));
  }

  /** Reads a single room by ID or slug with its access rules and DB timestamp. */
  async readRoom(
    ref: { kind: 'id' | 'slug'; value: string },
    onProblem?: (problem: RoomConfigProblem) => void,
  ): Promise<{ room: RoomRecord; dbNow: Date } | null> {
    const where =
      ref.kind === 'id' ? Prisma.sql`r.id = ${ref.value}::uuid` : Prisma.sql`r.slug = ${ref.value}`;
    const rows = await this.prisma.$queryRaw<(RoomSqlRow & { db_now: Date })[]>`
      SELECT q.*, now() AS db_now FROM (${ROOM_SELECT} WHERE ${where} AND r.deleted_at IS NULL) q
    `;
    const row = rows[0];
    if (!row || !isKnownRoomType(row.type)) return null;
    return { room: toRoomRecord(row, onProblem), dbNow: row.db_now };
  }

  /** The room the user last opened, or null. A deleted room clears it by foreign key. */
  async lastOpenedRoom(userId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ last_opened_room_id: string | null }[]>`
      SELECT last_opened_room_id FROM chat.user_chat_preferences WHERE user_id = ${userId}::uuid
    `;
    return rows[0]?.last_opened_room_id ?? null;
  }

  /** Saves the last opened room; no write at all when it did not change. */
  async rememberLastRoom(userId: string, roomId: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.user_chat_preferences (id, user_id, last_opened_room_id)
      VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${roomId}::uuid)
      ON CONFLICT (user_id) DO UPDATE SET last_opened_room_id = EXCLUDED.last_opened_room_id
      WHERE chat.user_chat_preferences.last_opened_room_id IS DISTINCT FROM EXCLUDED.last_opened_room_id
    `;
  }

  /** The country the user declared at registration (ISO-2, upper case), or null. */
  async registrationCountry(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { countryDeclared: true },
    });
    const code = user?.countryDeclared?.trim().toUpperCase() ?? '';
    return /^[A-Z]{2}$/.test(code) ? code : null;
  }

  async excludedRoomIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.roomExcludedUser.findMany({
      where: { userId, removedAt: null },
      select: { roomId: true },
    });
    return rows.map((row) => row.roomId);
  }

  /** Rooms staff or an admin added this user to (Module 4). */
  async includedRoomIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.roomIncludedUser.findMany({
      where: { userId, removedAt: null },
      select: { roomId: true },
    });
    return rows.map((row) => row.roomId);
  }

  // Users
  /** A live account (ACTIVE, not deleted) with its chat staff role, or null. */
  async findChatUser(userId: string): Promise<ChatUserContext | null> {
    const rows = await this.prisma.$queryRaw<
      { id: string; username: string; public_code: string; role: StaffRole | null }[]
    >`
      SELECT u.id, u.username, u.public_code, sr.role::text AS role
      FROM identity.users u
      LEFT JOIN chat.staff_roles sr ON sr.user_id = u.id AND sr.removed_at IS NULL
      WHERE u.id = ${userId}::uuid AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
    `;
    const row = rows[0];
    return row
      ? { id: row.id, username: row.username, publicCode: row.public_code, staffRole: row.role }
      : null;
  }

  /** A handle (id, username or login code) among live accounts only; null when nothing matches. */
  async resolveUserId(handle: string): Promise<string | null> {
    const value = handle.trim();
    if (/^[0-9a-f-]{36}$/i.test(value)) {
      const user = await this.prisma.user.findFirst({
        where: { id: value.toLowerCase(), deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      return user?.id ?? null;
    }
    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        OR: [{ usernameLower: value.toLowerCase() }, { publicCodeKey: value.toUpperCase() }],
      },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /** Public user lookups accept usernames only; UUIDs and login codes are private identifiers. */
  async resolvePublicUsername(username: string): Promise<string | null> {
    const value = username.trim().replace(/^@/, '');
    if (!value || /^[0-9a-f-]{36}$/i.test(value)) return null;
    const user = await this.prisma.user.findFirst({
      where: { deletedAt: null, status: 'ACTIVE', usernameLower: value.toLowerCase() },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /** Resolves user handle or UUID to internal user ID without leaking public codes. */
  async resolveUserHandle(handle: string): Promise<string | null> {
    const value = handle.trim().replace(/^@/, '');
    if (/^[0-9a-f-]{36}$/i.test(value)) return this.resolveUserId(value);
    const user = await this.prisma.user.findFirst({
      where: { deletedAt: null, status: 'ACTIVE', usernameLower: value.toLowerCase() },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /** Live accounts for the given lower-case usernames, one query. */
  async usersByUsernames(
    usernames: readonly string[],
  ): Promise<{ id: string; username: string }[]> {
    if (usernames.length === 0) return [];
    return this.prisma.user.findMany({
      where: { usernameLower: { in: [...usernames] }, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, username: true },
    });
  }

  /** Usernames of live accounts by id, one query. */
  async usersByIds(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] }, deletedAt: null },
      select: { id: true, username: true },
    });
    return new Map(rows.map((row) => [row.id, row.username]));
  }

  async profileFields(userId: string) {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, username: true, publicCode: true, avatarUrl: true, registeredAt: true },
    });
  }

  /** Verifies session family liveness and account status against the PostgreSQL clock. */
  async sessionLive(familyId: string, userId: string): Promise<{ live: boolean; dbNow: Date }> {
    const rows = await this.prisma.$queryRaw<{ live: boolean; db_now: Date }[]>`
      SELECT EXISTS (
        SELECT 1 FROM identity.sessions s
        JOIN identity.users u ON u.id = s.user_id
        WHERE s.family_id = ${familyId}::uuid AND s.user_id = ${userId}::uuid
          AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
      ) AS live, now() AS db_now
    `;
    return { live: rows[0]?.live === true, dbNow: rows[0]!.db_now };
  }

  /** The session families (of the given ones) that are definitely NOT live any more — one statement. */
  async deadFamilies(familyIds: readonly string[]): Promise<Set<string>> {
    if (familyIds.length === 0) return new Set();
    const rows = await this.prisma.$queryRaw<{ family_id: string }[]>`
      SELECT f.family_id
      FROM unnest(${[...familyIds]}::uuid[]) AS f(family_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM identity.sessions s
        JOIN identity.users u ON u.id = s.user_id
        WHERE s.family_id = f.family_id AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
      )
    `;
    return new Set(rows.map((row) => row.family_id));
  }

  // Messages
  async findClientMessage(
    userId: string,
    clientMessageId: string,
  ): Promise<{ messageId: string } | null> {
    const row = await this.prisma.clientMessageId.findUnique({
      where: { userId_clientMessageId: { userId, clientMessageId } },
      select: { messageId: true },
    });
    return row ? { messageId: row.messageId } : null;
  }

  /** Inserts a chat message, tags, and clientMessageId deduplication in one transaction. */
  async insertMessage(
    data: InsertMessage,
  ): Promise<{ row: MessageRow; duplicateOf: string | null }> {
    const id = uuidv7();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const inserted = await tx.$queryRaw<{ created_at: Date; created_at_text: string }[]>`
          INSERT INTO chat.room_messages (id, room_id, user_id, content, type, cosmetic_id, metadata)
          VALUES (${id}::uuid, ${data.roomId}::uuid, ${data.userId}::uuid, ${data.content},
                  ${data.type}::chat."MessageType", ${data.skinId}::uuid, ${JSON.stringify(data.metadata)}::jsonb)
          RETURNING created_at, ${TIME_TEXT('created_at')} AS created_at_text
        `;
        // Linked rows use the database text of the time: a JavaScript Date keeps only milliseconds.
        const createdAt = inserted[0]!.created_at_text;

        if (data.taggedUserIds.length > 0) {
          await tx.$executeRaw`
            INSERT INTO chat.message_mentions (mentioned_user_id, created_at, message_id, room_id)
            SELECT uid, ${createdAt}::timestamptz, ${id}::uuid, ${data.roomId}::uuid
            FROM unnest(${[...data.taggedUserIds]}::uuid[]) AS uid
            ON CONFLICT DO NOTHING
          `;
        }
        if (data.clientMessageId) {
          await tx.$executeRaw`
            INSERT INTO chat.client_message_ids (user_id, client_message_id, message_id, message_created_at)
            VALUES (${data.userId}::uuid, ${data.clientMessageId}::uuid, ${id}::uuid, ${createdAt}::timestamptz)
          `;
        }

        const row = await this.messageById(id, tx);
        return { row: row!, duplicateOf: null };
      }, { maxWait: 500, timeout: 5_000 });
    } catch (err: unknown) {
      if (data.clientMessageId && isUniqueViolation(err)) {
        const first = await this.findClientMessage(data.userId, data.clientMessageId);
        if (first) {
          const row = await this.messageById(first.messageId);
          if (row) return { row, duplicateOf: first.messageId };
        }
      }
      throw err;
    }
  }

  async messageById(id: string, db: Db = this.prisma): Promise<MessageRow | null> {
    const rows = await db.$queryRaw<
      MessageSqlRow[]
    >`${MESSAGE_SELECT} WHERE m.id = ${id}::uuid LIMIT 1`;
    return rows[0] ? toMessageRow(rows[0]) : null;
  }

  async messagesByIds(ids: readonly string[]): Promise<MessageRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.$queryRaw<MessageSqlRow[]>`
      ${MESSAGE_SELECT} WHERE m.id = ANY(${[...ids]}::uuid[]) ORDER BY m.created_at, m.id
    `;
    return rows.map(toMessageRow);
  }

  /** Alert rows of one admin broadcast, from recent partitions only. */
  async broadcastMessages(broadcastId: string): Promise<MessageRow[]> {
    const rows = await this.prisma.$queryRaw<MessageSqlRow[]>`
      ${MESSAGE_SELECT}
      WHERE m.created_at > now() - interval '1 day' AND m.type = 'ADMIN_ALERT'
        AND m.metadata->>'broadcastId' = ${broadcastId}
      ORDER BY m.created_at, m.id
    `;
    return rows.map(toMessageRow);
  }

  /** Marks a message retracted on the DB clock; returns null if already retracted. */
  async retract(
    messageId: string,
    actorUserId: string,
  ): Promise<{ roomId: string; retractedAt: Date; createdAt: string } | null> {
    const rows = await this.prisma.$queryRaw<
      { room_id: string; retracted_at: Date; created_at_text: string }[]
    >`
      UPDATE chat.room_messages
      SET retracted_at = now(), retracted_by = ${actorUserId}::uuid
      WHERE id = ${messageId}::uuid AND retracted_at IS NULL
      RETURNING room_id, retracted_at, ${TIME_TEXT('created_at')} AS created_at_text
    `;
    const row = rows[0];
    return row
      ? { roomId: row.room_id, retractedAt: row.retracted_at, createdAt: row.created_at_text }
      : null;
  }

  /** Pin and unpin, stamped with the database clock. */
  async setPinned(
    messageId: string,
    staffUserId: string | null,
    pinned: boolean,
  ): Promise<{ roomId: string; createdAt: string } | null> {
    const rows = pinned
      ? await this.prisma.$queryRaw<{ room_id: string; created_at_text: string }[]>`
          UPDATE chat.room_messages SET pinned_at = now(), pinned_by = ${staffUserId}::uuid
          WHERE id = ${messageId}::uuid RETURNING room_id, ${TIME_TEXT('created_at')} AS created_at_text
        `
      : await this.prisma.$queryRaw<{ room_id: string; created_at_text: string }[]>`
          UPDATE chat.room_messages SET pinned_at = NULL, pinned_by = NULL
          WHERE id = ${messageId}::uuid RETURNING room_id, ${TIME_TEXT('created_at')} AS created_at_text
        `;
    const row = rows[0];
    return row ? { roomId: row.room_id, createdAt: row.created_at_text } : null;
  }

  // Preferences, skins
  /** Read only: a user without a row gets the defaults and no row is written. */
  async preferences(
    userId: string,
  ): Promise<{ hideIdentity: boolean; activeSkinId: string | null; lastSeenAt: Date | null }> {
    const row = await this.prisma.userChatPreference.findUnique({
      where: { userId },
      select: { hideIdentity: true, activeSkinId: true, lastSeenAt: true },
    });
    return row ?? { hideIdentity: false, activeSkinId: null, lastSeenAt: null };
  }

  async savePreferences(
    userId: string,
    data: { hideIdentity?: boolean; activeSkinId?: string | null },
  ) {
    return this.prisma.userChatPreference.upsert({
      where: { userId },
      update: data,
      create: {
        id: uuidv7(),
        userId,
        hideIdentity: data.hideIdentity ?? false,
        activeSkinId: data.activeSkinId ?? null,
      },
      select: { hideIdentity: true, activeSkinId: true },
    });
  }

  /** "Last online" on the database clock. */
  async touchLastSeen(userId: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.user_chat_preferences (id, user_id, last_seen_at)
      VALUES (${uuidv7()}::uuid, ${userId}::uuid, now())
      ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now()
    `;
  }

  async skins(): Promise<
    {
      id: string;
      name: string;
      styleConfig: unknown;
      cost: Prisma.Decimal;
      isPremium: boolean;
      isActive: boolean;
    }[]
  > {
    return this.prisma.chatSkin.findMany({
      where: { isActive: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        styleConfig: true,
        cost: true,
        isPremium: true,
        isActive: true,
      },
    });
  }

  async skinById(id: string) {
    return this.prisma.chatSkin.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        styleConfig: true,
        cost: true,
        isPremium: true,
        isActive: true,
      },
    });
  }
}
