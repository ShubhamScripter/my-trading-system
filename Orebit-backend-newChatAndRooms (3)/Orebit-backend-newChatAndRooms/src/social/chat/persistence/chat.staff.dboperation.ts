// Database access for the Module 4 staff tools: chat-wide restrictions, staff requests (REPORT mode), penalties,
// and the room, role and rule changes staff may make from the app (the report queue and history reads are in
// chat.staff-queue.dboperation.ts). Every write that changes a user's standing is paired by the service with a moderation record in the same
// transaction.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import type { RestrictionKind, RestrictionTarget, StaffRole } from '../chat.contract';
import type { Cursor } from '../chat.utility';
import { TIME_TEXT, type Db } from './chat.sql';

import {
  type RestrictionRecord,
  type RestrictionSqlRow,
  type StaffRequestRecord,
  type BanRecord,
  toRestriction,
} from './chat.staff.rows';

export type { RestrictionRecord, StaffRequestRecord, BanRecord };

@Injectable()
export class ChatStaffDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  // Restrictions
  // Every restriction still in force on the database clock, for the in-memory cache.
  // EVERY live restriction, read in pages by keyset: the newest are never the ones left out. A page is small, so
// no single query is large; the whole list is what the service indexes by user.
  async activeRestrictions(pageSize = 5000): Promise<RestrictionRecord[]> {
    const all: RestrictionRecord[] = [];
    let after: { at: string; id: string } | null = null;
    for (;;) {
      const rows: (RestrictionSqlRow & { created_at_text: string })[] = await this.prisma.$queryRaw<
        (RestrictionSqlRow & { created_at_text: string })[]
      >`
        SELECT id, target_type, target_value, kind, commands, room_id, internal_reason, user_reason, created_by, created_by_admin,
               created_by_role, created_at, expires_at, ${TIME_TEXT('created_at')} AS created_at_text
        FROM chat.user_restrictions
        WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
          ${after ? Prisma.sql`AND (created_at, id) > (${after.at}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
        ORDER BY created_at, id
        LIMIT ${pageSize}
      `;
      all.push(...rows.map(toRestriction));
      const last = rows[rows.length - 1];
      if (!last || rows.length < pageSize) return all;
      after = { at: last.created_at_text, id: last.id };
    }
  }

  async restrictionById(
    id: string,
  ): Promise<(RestrictionRecord & { liftedAt: Date | null }) | null> {
    const rows = await this.prisma.$queryRaw<(RestrictionSqlRow & { lifted_at: Date | null })[]>`
      SELECT id, target_type, target_value, kind, commands, room_id, internal_reason, user_reason, created_by, created_by_admin,
             created_by_role, created_at, expires_at, lifted_at
      FROM chat.user_restrictions WHERE id = ${id}::uuid
    `;
    const row = rows[0];
    return row ? { ...toRestriction(row), liftedAt: row.lifted_at } : null;
  }

  // A restriction ending `hours` from the database clock, or never when null.
  async createRestriction(
    db: Db,
    data: {
      targetType: RestrictionTarget;
      targetValue: string;
      kind: RestrictionKind;
      commands: readonly string[];
      roomId: string | null;
      internalReason: string;
      userReason?: string | null;
      createdBy: string;
      createdByRole: StaffRole;
      hours: number | null;
    },
  ): Promise<{ id: string; expiresAt: Date | null }> {
    const id = uuidv7();
    const rows = await db.$queryRaw<{ expires_at: Date | null }[]>`
      INSERT INTO chat.user_restrictions
        (id, target_type, target_value, kind, commands, room_id, internal_reason, user_reason, created_by, created_by_role, expires_at)
      VALUES (${id}::uuid, ${data.targetType}, ${data.targetValue}, ${data.kind}, ${[...data.commands]}::text[],
              ${data.roomId}::uuid, ${data.internalReason}, ${data.userReason ?? null}, ${data.createdBy}::uuid, ${data.createdByRole},
              CASE WHEN ${data.hours}::float8 IS NULL THEN NULL
                   ELSE now() + make_interval(secs => ${data.hours}::float8 * 3600) END)
      RETURNING expires_at
    `;
    return { id, expiresAt: rows[0]?.expires_at ?? null };
  }

  async liftRestriction(db: Db, id: string, liftedBy: string): Promise<boolean> {
    const changed = await db.$executeRaw`
      UPDATE chat.user_restrictions SET lifted_at = now(), lifted_by = ${liftedBy}::uuid
      WHERE id = ${id}::uuid AND lifted_at IS NULL
    `;
    return changed > 0;
  }

  // Staff requests (REPORT mode)
  async createRequest(data: {
    requesterId: string;
    requesterRole: StaffRole;
    permission: string;
    targetUserId: string | null;
    targetRoomId: string | null;
    payload: Record<string, unknown>;
    note: string;
  }): Promise<{ id: string; createdAt: Date }> {
    const id = uuidv7();
    const rows = await this.prisma.$queryRaw<{ created_at: Date }[]>`
      INSERT INTO chat.staff_requests
        (id, requester_id, requester_role, permission, target_user_id, target_room_id, payload, note)
      VALUES (${id}::uuid, ${data.requesterId}::uuid, ${data.requesterRole}, ${data.permission},
              ${data.targetUserId}::uuid, ${data.targetRoomId}::uuid, ${JSON.stringify(data.payload)}::jsonb,
              ${data.note})
      RETURNING created_at
    `;
    return { id, createdAt: rows[0]!.created_at };
  }

  async requests(opts: {
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL';
    requesterId?: string;
    // Only requests from these roles and for these permissions (what the reader may resolve), applied before the limit.
    requesterRoles?: readonly string[];
    permissions?: readonly string[];
    limit: number;
    before: Cursor | null;
  }): Promise<(StaffRequestRecord & { createdAtText: string })[]> {
    const status = opts.status === 'ALL' ? Prisma.empty : Prisma.sql`AND r.status = ${opts.status}`;
    const mine = opts.requesterId
      ? Prisma.sql`AND r.requester_id = ${opts.requesterId}::uuid`
      : Prisma.empty;
    const before = opts.before
      ? Prisma.sql`AND (r.created_at, r.id) < (${opts.before.createdAt}::timestamptz, ${opts.before.id}::uuid)`
      : Prisma.empty;
    const roles = opts.requesterRoles
      ? Prisma.sql`AND r.requester_role = ANY(${[...opts.requesterRoles]}::text[])`
      : Prisma.empty;
    const permissions = opts.permissions
      ? Prisma.sql`AND r.permission = ANY(${[...opts.permissions]}::text[])`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        requester_id: string;
        requester_username: string | null;
        requester_role: StaffRole;
        permission: string;
        target_user_id: string | null;
        target_username: string | null;
        target_room_id: string | null;
        payload: Record<string, unknown>;
        note: string;
        status: 'PENDING' | 'APPROVED' | 'REJECTED';
        resolution_note: string | null;
        created_at: Date;
        created_at_text: string;
        resolved_at: Date | null;
      }[]
    >`
      SELECT r.id, r.requester_id, u1.username AS requester_username, r.requester_role, r.permission,
             r.target_user_id, u2.username AS target_username, r.target_room_id, r.payload, r.note, r.status,
             r.resolution_note, r.created_at, ${TIME_TEXT('r.created_at')} AS created_at_text, r.resolved_at
      FROM chat.staff_requests r
      LEFT JOIN identity.users u1 ON u1.id = r.requester_id
      LEFT JOIN identity.users u2 ON u2.id = r.target_user_id
      WHERE true ${status} ${mine} ${roles} ${permissions} ${before}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${opts.limit + 1}
    `;
    return rows.map((row) => ({
      id: row.id,
      requesterId: row.requester_id,
      requesterUsername: row.requester_username,
      requesterRole: row.requester_role,
      permission: row.permission,
      targetUserId: row.target_user_id,
      targetUsername: row.target_username,
      targetRoomId: row.target_room_id,
      payload: row.payload ?? {},
      note: row.note,
      status: row.status,
      resolutionNote: row.resolution_note,
      createdAt: row.created_at,
      createdAtText: row.created_at_text,
      resolvedAt: row.resolved_at,
    }));
  }

  async requestById(id: string): Promise<StaffRequestRecord | null> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        requester_id: string;
        requester_role: StaffRole;
        permission: string;
        target_user_id: string | null;
        target_room_id: string | null;
        payload: Record<string, unknown>;
        note: string;
        status: 'PENDING' | 'APPROVED' | 'REJECTED';
        resolution_note: string | null;
        created_at: Date;
        resolved_at: Date | null;
      }[]
    >`
      SELECT id, requester_id, requester_role, permission, target_user_id, target_room_id, payload, note, status,
             resolution_note, created_at, resolved_at
      FROM chat.staff_requests WHERE id = ${id}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      requesterId: row.requester_id,
      requesterUsername: null,
      requesterRole: row.requester_role,
      permission: row.permission,
      targetUserId: row.target_user_id,
      targetUsername: null,
      targetRoomId: row.target_room_id,
      payload: row.payload ?? {},
      note: row.note,
      status: row.status,
      resolutionNote: row.resolution_note,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  // Resolves a PENDING request only; false when someone resolved it first.
  async resolveRequest(
    id: string,
    status: 'APPROVED' | 'REJECTED',
    resolvedBy: string,
    note: string | null,
    db: Db = this.prisma,
  ): Promise<boolean> {
    const changed = await db.$executeRaw`
      UPDATE chat.staff_requests
      SET status = ${status}, resolved_by = ${resolvedBy}::uuid, resolution_note = ${note}, resolved_at = now()
      WHERE id = ${id}::uuid AND status = 'PENDING'
    `;
    return changed > 0;
  }

  // Puts a claimed request back when carrying it out failed.
  async reopenRequest(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.staff_requests SET status = 'PENDING', resolved_by = NULL, resolution_note = NULL, resolved_at = NULL
      WHERE id = ${id}::uuid
    `;
  }

  // Bans and penalties
  async banById(id: string): Promise<BanRecord | null> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        user_id: string;
        room_id: string | null;
        internal_reason: string;
        user_reason: string | null;
        moderator_id: string | null;
        admin_id: string | null;
        moderator_role: StaffRole | null;
        banned_at: Date;
        expires_at: Date | null;
        live: boolean;
      }[]
    >`
      SELECT b.id, b.user_id, b.room_id, b.internal_reason, b.user_reason, b.moderator_id, b.admin_id, COALESCE(b.moderator_role, sr.role::text) AS moderator_role,
             b.banned_at, b.expires_at, (b.is_active AND (b.expires_at IS NULL OR b.expires_at > now())) AS live
      FROM chat.user_bans b
      LEFT JOIN chat.staff_roles sr ON sr.user_id = b.moderator_id AND sr.removed_at IS NULL
      WHERE b.id = ${id}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      roomId: row.room_id,
      internalReason: row.internal_reason,
      userReason: row.user_reason,
      moderatorId: row.moderator_id,
      adminId: row.admin_id,
      moderatorRole: row.moderator_role,
      bannedAt: row.banned_at,
      expiresAt: row.expires_at,
      isActive: row.live,
    };
  }

  async liftBan(db: Db, id: string, liftedBy: string): Promise<{ userId: string } | null> {
    const rows = await db.$queryRaw<{ user_id: string }[]>`
      UPDATE chat.user_bans SET is_active = false, lifted_by = ${liftedBy}::uuid, lifted_at = now()
      WHERE id = ${id}::uuid AND is_active = true
      RETURNING user_id
    `;
    return rows[0] ? { userId: rows[0].user_id } : null;
  }

  // "See Penalised / Banned Users List [Chat banned / penalty only]": live bans, newest first.
  async activeBans(userId: string | null, limit: number, before: Date | null) {
    const user = userId ? Prisma.sql`AND b.user_id = ${userId}::uuid` : Prisma.empty;
    const cursor = before ? Prisma.sql`AND b.banned_at < ${before}::timestamptz` : Prisma.empty;
    return this.prisma.$queryRaw<
      {
        id: string;
        user_id: string;
        username: string | null;
        room_id: string | null;
        internal_reason: string;
        user_reason: string | null;
        moderator_id: string | null;
        admin_id: string | null;
        banned_at: Date;
        expires_at: Date | null;
      }[]
    >`
      SELECT b.id, b.user_id, u.username, b.room_id, b.internal_reason, b.user_reason, b.moderator_id, b.admin_id, b.banned_at, b.expires_at
      FROM chat.user_bans b
      JOIN identity.users u ON u.id = b.user_id AND u.deleted_at IS NULL
      WHERE b.is_active AND (b.expires_at IS NULL OR b.expires_at > now()) ${user} ${cursor}
      ORDER BY b.banned_at DESC, b.id DESC
      LIMIT ${limit}
    `;
  }

  async usernames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ id: string; username: string }[]>`
      SELECT id, username FROM identity.users WHERE id = ANY(${[...ids]}::uuid[])
    `;
    return new Map(rows.map((row) => [row.id, row.username]));
  }

  // Room access, room status and rules
  // "Remove / Add user from specific rooms": ADD lets the user in whatever the room's gates say, REMOVE shuts them out,
// RESTORE clears both so the room's own rules apply again.
  async setRoomAccess(
    db: Db,
    roomId: string,
    userId: string,
    action: 'ADD' | 'REMOVE' | 'RESTORE',
    by: string,
  ) {
    // What was there is marked removed, not erased: the history of who was let in or shut out stays.
    await db.$executeRaw`
      UPDATE chat.room_excluded_users SET removed_at = now(), removed_by = ${by}::uuid
      WHERE room_id = ${roomId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL
    `;
    await db.$executeRaw`
      UPDATE chat.room_included_users SET removed_at = now(), removed_by = ${by}::uuid
      WHERE room_id = ${roomId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL
    `;
    if (action === 'REMOVE') {
      await db.$executeRaw`
        INSERT INTO chat.room_excluded_users (room_id, user_id, created_by)
        VALUES (${roomId}::uuid, ${userId}::uuid, ${by}::uuid)
      `;
    }
    if (action === 'ADD') {
      await db.$executeRaw`
        INSERT INTO chat.room_included_users (room_id, user_id, created_by)
        VALUES (${roomId}::uuid, ${userId}::uuid, ${by}::uuid)
      `;
    }
  }

  // "Check Chat Banned / Penalised Users List: Edit": a live ban's end (from now, or none) and reason.
  async updateBan(db: Db, id: string, data: { seconds: number | null; internalReason: string | null; userReason: string | null },
  ) {
    const rows = await db.$queryRaw<{ expires_at: Date | null; user_id: string }[]>`
      UPDATE chat.user_bans
      SET expires_at = CASE WHEN ${data.seconds}::int IS NULL THEN NULL
                            ELSE now() + make_interval(secs => ${data.seconds}::int) END,
          internal_reason = COALESCE(${data.internalReason}, internal_reason),
          user_reason = COALESCE(${data.userReason}, user_reason)
      WHERE id = ${id}::uuid AND is_active AND (expires_at IS NULL OR expires_at > now())
      RETURNING expires_at, user_id
    `;
    return rows[0] ? { expiresAt: rows[0].expires_at, userId: rows[0].user_id } : null;
  }

  // A live restriction's end (from now, or none) and reason.
  async updateRestriction(
    db: Db,
    id: string,
    data: { hours: number | null; keepEnd: boolean; internalReason: string | null; userReason: string | null },
  ) {
    const rows = await db.$queryRaw<{ expires_at: Date | null }[]>`
      UPDATE chat.user_restrictions
      SET expires_at = CASE WHEN ${data.keepEnd} THEN expires_at
                            WHEN ${data.hours}::float8 IS NULL THEN NULL
                            ELSE now() + make_interval(secs => ${data.hours}::float8 * 3600) END,
          internal_reason = COALESCE(${data.internalReason}, internal_reason),
          user_reason = COALESCE(${data.userReason}, user_reason)
      WHERE id = ${id}::uuid AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      RETURNING expires_at
    `;
    return rows[0] ? { expiresAt: rows[0].expires_at } : null;
  }

  // Merges keys into a room's config document; returns the values replaced, or null for an unknown room.
  async patchRoomConfig(
    db: Db,
    roomId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const rows = await db.$queryRaw<{ config: Record<string, unknown> }[]>`
      SELECT config FROM chat.rooms WHERE id = ${roomId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    if (!rows[0]) return null;
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) before[key] = rows[0].config?.[key] ?? null;
    await db.$executeRaw`
      UPDATE chat.rooms SET config = config || ${JSON.stringify(patch)}::jsonb WHERE id = ${roomId}::uuid
    `;
    return before;
  }
}
