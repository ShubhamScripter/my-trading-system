/**
 * Database access for rooms, their access rules, room history and the dashboard numbers.
 *
 * Every write that changes a room's config keeps it in the shared contract's shape: optional keys are left out,
 * never stored as null, so the chat server reads every room cleanly.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../db/client';
import { DEFAULT_ROOM_ACCESS, defaultIneligibleMode } from './chat.constants';
import {
  parseContentControls,
  toAdminRoom,
  withoutNulls,
  type AdminHistoryMessage,
  type HistoryRow,
  type NewRoom,
  type RoomListRow,
  type RoomRow,
  type RoomUpdate,
} from './persistence/chat-room.mapper';
import type {
  AdminRoom,
  IneligibleMode,
  PlatformStats,
  RoomAccess,
  RoomStatus,
} from './chat.types';
import { ChatUtility } from './chat.utility';

export type { AdminHistoryMessage, NewRoom, RoomUpdate };

type Tx = Prisma.TransactionClient;

/** The author of system alerts and admin broadcasts (not a user row). */
const SYSTEM_AUTHOR_ID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class ChatRoomDbOperation {
  constructor(private readonly prisma: PrismaService) { }

  // Dashboard
  /**
   * Messages stored: the planner's estimate across the monthly partitions (cheap at any size); an exact
   * count only while the table is small enough that the estimate is not maintained yet.
   */
  private async messageCount(): Promise<number> {
    const estimate = await this.prisma.$queryRaw<{ n: number | null }[]>`
      SELECT COALESCE(SUM(GREATEST(c.reltuples, 0)), 0)::float8 AS n
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'chat.room_messages'::regclass
    `;
    const n = Number(estimate[0]?.n ?? 0);
    if (n >= 100_000) return Math.round(n);
    const exact = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM chat.room_messages
    `;
    return Number(exact[0]?.n ?? 0);
  }

  /**
   * The dashboard numbers. Online users come from the runtime_stats row the chat server writes every
   * minute, so no request scans Redis or counts every message.
   */
  async getPlatformStats(): Promise<PlatformStats> {
    const count = async (query: Promise<{ count: bigint }[]>): Promise<number> =>
      Number((await query)[0]?.count ?? 0);
    const [
      runtime,
      totalRooms,
      activeRooms,
      pendingReports,
      activeBans,
      totalSkins,
      totalMessages,
    ] = await Promise.all([
      this.prisma.$queryRaw<{ online_users: number; messages_last_minute: number }[]>`
          SELECT online_users, messages_last_minute FROM chat.runtime_stats WHERE id = 1
        `,
      count(this.prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM chat.rooms`),
      count(this.prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count FROM chat.rooms WHERE deleted_at IS NULL
        `),
      count(this.prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count FROM chat.chat_message_reports WHERE status = 'PENDING'
        `),
      // A ban is active while is_active is true and it has not expired on the database clock.
      count(this.prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count FROM chat.user_bans
          WHERE is_active = true AND (expires_at IS NULL OR expires_at > now())
        `),
      count(this.prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count FROM chat.message_cosmetics
        `),
      this.messageCount(),
    ]);

    return {
      totalRooms,
      activeRooms,
      totalOnlineUsers: runtime[0]?.online_users ?? 0,
      totalMessages,
      pendingReports,
      activeBans,
      totalSkins,
      messagesLastMinute: runtime[0]?.messages_last_minute ?? 0,
    };
  }

  // Rooms
  async getRooms(): Promise<AdminRoom[]> {
    const rows = await this.prisma.$queryRaw<RoomListRow[]>`
      SELECT
        r.id,
        r.slug,
        r.name,
        r.description,
        r.type::text                    AS type,
        r.config,
        r.created_at                    AS "createdAt",
        r.deleted_at                    AS "deletedAt",
        ar.allowed_countries            AS "allowedCountries",
        ar.region_id                    AS "regionId",
        ar.require_premium              AS "requirePremium",
        ar.allowed_plan_ids             AS "allowedPlanIds",
        ar.require_vip                  AS "requireVip",
        ar.min_kyc_level                AS "minKycLevel",
        ar.min_level                    AS "minLevel",
        ar.min_wager_usd                AS "minWagerUsd",
        ar.ineligible_mode::text        AS "ineligibleMode",
        ar.visibility_groups            AS "visibilityGroups",
        ar.visibility_min_level         AS "visibilityMinLevel",
      FROM chat.rooms r
      LEFT JOIN chat.room_access_rules ar ON ar.room_id = r.id
      ORDER BY r.created_at ASC
    `;
    return rows.map(toAdminRoom);
  }

  // Fast lookup of active, non-deleted room IDs for broadcast without scanning room messages.
  async getActiveRoomIds(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM chat.rooms
      WHERE deleted_at IS NULL AND (config->>'status' IS NULL OR config->>'status' <> 'DISABLED')
      ORDER BY created_at ASC
    `;
    return rows.map((r) => r.id);
  }

  async getRoomById(id: string): Promise<RoomRow | null> {
    const rows = await this.prisma.$queryRaw<RoomRow[]>`
      SELECT r.id, r.slug, r.name, r.description, r.type::text AS type, r.config, r.created_at, r.deleted_at
      FROM chat.rooms r
      WHERE r.id = ${id}::uuid
    `;
    return rows[0] ?? null;
  }

  async getRoomBySlug(slug: string): Promise<RoomRow | null> {
    const rows = await this.prisma.$queryRaw<RoomRow[]>`
      SELECT id, slug, name, description, type::text AS type, config, created_at, deleted_at
      FROM chat.rooms WHERE slug = ${slug}
    `;
    return rows[0] ?? null;
  }

  /**
   * Creates a room and its access rule in one transaction. No row lock is needed: nobody else can
   * be writing a row that does not exist yet.
   */
  async createRoom(data: NewRoom): Promise<void> {
    const ineligibleMode: IneligibleMode =
      data.access.ineligibleMode ?? defaultIneligibleMode(data.type);

    // Absent keys, never nulls: the user backend validates the config against the shared contract.
    // DISABLED is a status only; deleting a room is a separate action.
    const config = withoutNulls({
      status: data.status,
      statusNote: data.statusNote,
      statusUntil: data.statusUntil,
      language: data.language,
      rules: data.rules,
      contentControls: data.contentControls,
      linksPolicy: data.linksPolicy, // absent = links off
      bannedWords: data.bannedWords,
      casino: data.casino,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO chat.rooms (id, slug, name, description, type, config, created_at, deleted_at)
        VALUES (
          ${data.id}::uuid,
          ${data.slug},
          ${data.name},
          ${data.description ?? null},
          ${data.type}::chat."RoomType",
          ${config}::jsonb,
          now(),
          NULL
        )
      `;
      await this.upsertAccessRule(tx, data.id, {
        ...DEFAULT_ROOM_ACCESS,
        ...data.access,
        ineligibleMode,
      });
    });
  }

  /**
   * Updates a room. The row is locked (`FOR UPDATE`) before its config is read, so two saves at the
   * same time cannot overwrite each other.
   */
  async updateRoom(data: RoomUpdate): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ config: Record<string, unknown> | null }[]>`
        SELECT r.config FROM chat.rooms r WHERE r.id = ${data.roomId}::uuid FOR UPDATE OF r
      `;
      if (!rows[0]) return; // The caller already checked that the room exists.
      const current = rows[0].config ?? {};

      const nextStatus = data.status ?? (current.status as RoomStatus | undefined) ?? 'ACTIVE';
      const pick = (next: unknown, previous: unknown): unknown =>
        next !== undefined ? next : previous;
      // Absent keys, never nulls (a null clears the value), so the stored config passes the shared contract.
      const nextConfig = withoutNulls({
        ...current,
        status: nextStatus,
        statusNote: pick(data.statusNote, current.statusNote),
        statusUntil: pick(data.statusUntil, current.statusUntil),
        language: pick(data.language, current.language),
        rules: pick(data.rules, current.rules ?? []),
        contentControls: {
          ...parseContentControls(current),
          ...(data.contentControls ?? {}),
        },
        controlsMaintenance: pick(data.controlsMaintenance, current.controlsMaintenance ?? []),
        linksPolicy: pick(data.linksPolicy, current.linksPolicy),
        bannedWords: pick(data.bannedWords, current.bannedWords ?? []),
        casino: pick(data.casino, current.casino),
      });

      // The status never touches deleted_at: DISABLED hides the room, delete is its own action.
      await tx.$executeRaw`
        UPDATE chat.rooms
        SET
          name        = COALESCE(${data.name ?? null}, name),
          slug        = COALESCE(${data.slug ?? null}, slug),
          description = CASE WHEN ${data.description !== undefined} THEN ${data.description ?? null} ELSE description END,
          type        = COALESCE(${data.type ?? null}::chat."RoomType", type),
          config      = ${nextConfig}::jsonb
        WHERE id = ${data.roomId}::uuid
      `;
      if (data.access) await this.upsertAccessRule(tx, data.roomId, data.access);
    });
  }

  async dbNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]?.now ?? new Date();
  }

  /**
   * Chat SETTINGS "ON / OFF / MAINTENANCE (Can be scheduled): Room … Chat Room Controls": a room change for later. The
   * chat server applies it on the database clock (chat.settings_changes, target ROOM, a RoomPatch).
   */
  async scheduleRoomChange(data: {
    id: string;
    roomId: string;
    actorId: string;
    patch: unknown;
    effectiveAt: Date;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.settings_changes (id, target, room_id, actor_id, patch, effective_at, status, created_at)
      VALUES (${data.id}::uuid, 'ROOM', ${data.roomId}::uuid, ${data.actorId}::uuid,
              ${JSON.stringify(data.patch)}::jsonb, ${data.effectiveAt}, 'SCHEDULED', now())
    `;
  }

  /** Soft-deletes a room. Messages are kept: chat never deletes them. */
  async softDeleteRoom(roomId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.rooms SET deleted_at = now() WHERE id = ${roomId}::uuid AND deleted_at IS NULL
    `;
  }

  async getRoomRules(
    roomId: string,
  ): Promise<{ roomId: string; roomName: string; rules: string[] }> {
    const room = await this.getRoomById(roomId);
    if (!room) return { roomId, roomName: '', rules: [] };
    const config = room.config ?? {};
    return {
      roomId: room.id,
      roomName: room.name,
      rules: Array.isArray(config.rules) ? (config.rules as string[]) : [],
    };
  }

  async updateRoomRules(roomId: string, rules: string[]): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.rooms SET config = config || ${JSON.stringify({ rules })}::jsonb WHERE id = ${roomId}::uuid
    `;
  }

  /** A room's stored config (for the per-room moderation settings), or null when the room does not exist. */
  async getRoomConfig(roomId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.prisma.$queryRaw<{ config: Record<string, unknown> | null }[]>`
      SELECT config FROM chat.rooms WHERE id = ${roomId}::uuid
    `;
    return rows[0] ? (rows[0].config ?? {}) : null;
  }

  /**
   * Changes a room's config under a row lock. `change` receives the current config and the database
   * time, and returns the config to store. Returns false when the room does not exist.
   */
  async changeRoomConfig(
    roomId: string,
    change: (config: Record<string, unknown>, dbNow: Date) => Record<string, unknown>,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ config: Record<string, unknown> | null; db_now: Date }[]>`
        SELECT config, now() AS db_now FROM chat.rooms WHERE id = ${roomId}::uuid FOR UPDATE
      `;
      if (!rows[0]) return false;
      const next = change({ ...(rows[0].config ?? {}) }, new Date(rows[0].db_now));
      await tx.$executeRaw`UPDATE chat.rooms SET config = ${next}::jsonb WHERE id = ${roomId}::uuid`;
      return true;
    });
  }

  // Paginated message history search by keyset cursor on (created_at, id).
  async searchMessages(opts: {
    roomId?: string;
    userId?: string;
    from?: string;
    to?: string;
    type?: string;
    sort: 'asc' | 'desc';
    /** `<created_at text>_<id>` of the last row of the page before. */
    cursor?: string;
    limit: number;
  }): Promise<{ messages: AdminHistoryMessage[]; nextCursor: string | null }> {
    const room = opts.roomId ? Prisma.sql`AND m.room_id = ${opts.roomId}::uuid` : Prisma.empty;
    const user = opts.userId ? Prisma.sql`AND m.user_id = ${opts.userId}::uuid` : Prisma.empty;
    const from = opts.from ? Prisma.sql`AND m.created_at >= ${opts.from}::timestamptz` : Prisma.empty;
    const to = opts.to ? Prisma.sql`AND m.created_at < ${opts.to}::timestamptz` : Prisma.empty;
    const type = opts.type ? Prisma.sql`AND m.type = ${opts.type}::chat."MessageType"` : Prisma.empty;
    const [at, id] = opts.cursor ? [opts.cursor.slice(0, opts.cursor.lastIndexOf('_')), opts.cursor.slice(opts.cursor.lastIndexOf('_') + 1)] : [null, null];
    const after = at
      ? opts.sort === 'desc'
        ? Prisma.sql`AND (m.created_at, m.id) < (${at}::timestamptz, ${id}::uuid)`
        : Prisma.sql`AND (m.created_at, m.id) > (${at}::timestamptz, ${id}::uuid)`
      : Prisma.empty;
    const order = opts.sort === 'desc' ? Prisma.sql`ORDER BY m.created_at DESC, m.id DESC` : Prisma.sql`ORDER BY m.created_at ASC, m.id ASC`;
    const rows = await this.prisma.$queryRaw<HistoryRow[]>`
      SELECT
        m.id,
        m.room_id       AS "roomId",
        r.name          AS "roomName",
        m.user_id       AS "userId",
        u.username,
        m.content,
        m.type::text    AS type,
        m.metadata,
        m.retracted_at  AS "retractedAt",
        m.created_at    AS "createdAt",
        to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
      FROM chat.room_messages m
      LEFT JOIN identity.users u ON u.id = m.user_id
      LEFT JOIN chat.rooms r ON r.id = m.room_id
      WHERE true ${room} ${user} ${from} ${to} ${type} ${after}
      ${order}
      LIMIT ${opts.limit + 1}
    `;

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = page[page.length - 1];
    return {
      messages: page.map((row) => ({
        id: row.id,
        roomId: row.roomId,
        roomName: row.roomName ?? '',
        userId: row.userId,
        // System alerts and broadcasts are written by the system author, which is not a user row.
        username: row.username ?? (row.userId === SYSTEM_AUTHOR_ID ? 'OREBiT' : 'Deleted user'),
        content: row.content,
        type: row.type ?? 'TEXT',
        metadata: row.metadata ?? {},
        retractedAt: row.retractedAt ? new Date(row.retractedAt).toISOString() : null,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
      nextCursor: hasMore && last ? `${last.cursorAt}_${last.id}` : null,
    };
  }

  // Access rules
  /**
   * Writes the given access fields, creating the room's one rule if it has none. Fields that are absent keep
   * their stored value. The VIP flag is always written false: the VIP system is removed.
   */
  private async upsertAccessRule(
    tx: Tx,
    roomId: string,
    access: Partial<RoomAccess>,
  ): Promise<void> {
    const a = { ...DEFAULT_ROOM_ACCESS, ...access };
    const given = (value: unknown): boolean => value !== undefined;
    await tx.$executeRaw`
      INSERT INTO chat.room_access_rules (
        id, room_id, allowed_countries, region_id, require_premium, allowed_plan_ids, require_vip,
        min_kyc_level, min_level, min_wager_usd, ineligible_mode, visibility_groups, visibility_min_level
      ) VALUES (
        ${ChatUtility.generateUuid()}::uuid,
        ${roomId}::uuid,
        ${a.allowedCountries}::char(2)[],
        ${a.regionId}::uuid,
        ${a.requirePremium},
        ${a.allowedPlanIds}::text[],
        false,
        ${a.minKycLevel},
        ${a.minLevel},
        ${a.minWagerUsd}::numeric,
        ${a.ineligibleMode}::chat."IneligibleMode",
        ${a.visibility.groups}::text[],
        ${a.visibility.minLevel}
      )
      ON CONFLICT (room_id) DO UPDATE SET
        allowed_countries    = CASE WHEN ${given(access.allowedCountries)} THEN EXCLUDED.allowed_countries ELSE chat.room_access_rules.allowed_countries END,
        region_id            = CASE WHEN ${given(access.regionId)} THEN EXCLUDED.region_id ELSE chat.room_access_rules.region_id END,
        require_premium      = CASE WHEN ${given(access.requirePremium)} THEN EXCLUDED.require_premium ELSE chat.room_access_rules.require_premium END,
        allowed_plan_ids     = CASE WHEN ${given(access.allowedPlanIds)} THEN EXCLUDED.allowed_plan_ids ELSE chat.room_access_rules.allowed_plan_ids END,
        require_vip          = false,
        min_kyc_level        = CASE WHEN ${given(access.minKycLevel)} THEN EXCLUDED.min_kyc_level ELSE chat.room_access_rules.min_kyc_level END,
        min_level            = CASE WHEN ${given(access.minLevel)} THEN EXCLUDED.min_level ELSE chat.room_access_rules.min_level END,
        min_wager_usd        = CASE WHEN ${given(access.minWagerUsd)} THEN EXCLUDED.min_wager_usd ELSE chat.room_access_rules.min_wager_usd END,
        ineligible_mode      = CASE WHEN ${given(access.ineligibleMode)} THEN EXCLUDED.ineligible_mode ELSE chat.room_access_rules.ineligible_mode END,
        visibility_groups    = CASE WHEN ${given(access.visibility)} THEN EXCLUDED.visibility_groups ELSE chat.room_access_rules.visibility_groups END,
        visibility_min_level = CASE WHEN ${given(access.visibility)} THEN EXCLUDED.visibility_min_level ELSE chat.room_access_rules.visibility_min_level END
    `;
  }
}
