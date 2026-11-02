/** Database operations for admin restrictions, staff requests, bot logs, and DM/group oversight. */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { ChatUtility } from '../chat.utility';

import {
  iso,
  queryConversationExists,
  queryConversationMessages,
  queryConversationsOf,
  queryGroups,
  queryMemberIds,
} from './chat-dm-admin.dboperation';

@Injectable()
export class ChatModulesDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Restrictions (Module 4)
  async restrictions(opts: {
    activeOnly: boolean;
    userId: string | null;
    limit: number;
    before: string | null;
  }) {
    const live = opts.activeOnly
      ? Prisma.sql`AND r.lifted_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())`
      : Prisma.empty;
    const user = opts.userId
      ? Prisma.sql`AND r.target_type = 'USER' AND r.target_value = ${opts.userId}`
      : Prisma.empty;
    const before = opts.before
      ? Prisma.sql`AND r.created_at < ${opts.before}::timestamptz`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        target_type: string;
        target_value: string;
        target_username: string | null;
        kind: string;
        commands: string[];
        room_id: string | null;
        room_name: string | null;
        internal_reason: string;
        user_reason: string | null;
        created_by: string | null;
        created_by_username: string | null;
        created_by_admin: string | null;
        created_by_role: string | null;
        created_at: Date;
        expires_at: Date | null;
        lifted_at: Date | null;
        live: boolean;
      }[]
    >`
      SELECT r.id, r.target_type, r.target_value,
             CASE WHEN r.target_type = 'USER' THEN tu.username END AS target_username,
             r.kind, r.commands, r.room_id, rm.name AS room_name, r.internal_reason, r.user_reason, r.created_by, cu.username AS created_by_username,
             r.created_by_admin, r.created_by_role, r.created_at, r.expires_at, r.lifted_at,
             (r.lifted_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())) AS live
      FROM chat.user_restrictions r
      LEFT JOIN identity.users tu ON r.target_type = 'USER' AND tu.id::text = r.target_value
      LEFT JOIN identity.users cu ON cu.id = r.created_by
      LEFT JOIN chat.rooms rm ON rm.id = r.room_id
      WHERE true ${live} ${user} ${before}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${opts.limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetValue: r.target_value,
      targetUsername: r.target_username,
      kind: r.kind,
      commands: r.commands ?? [],
      roomId: r.room_id,
      roomName: r.room_name,
      internalReason: r.internal_reason,
      userReason: r.user_reason,
      createdBy: r.created_by_admin ? 'ADMIN_PANEL' : (r.created_by_username ?? r.created_by),
      createdByRole: r.created_by_admin ? 'ADMIN' : r.created_by_role,
      createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
      liftedAt: iso(r.lifted_at),
      isActive: r.live,
    }));
  }

  async createRestriction(data: {
    targetType: string;
    targetValue: string;
    kind: string;
    commands: string[];
    roomId: string | null;
    internalReason: string;
    userReason?: string | null;
    adminId: string;
    hours: number | null;
  }): Promise<{ id: string; expiresAt: string | null }> {
    const id = ChatUtility.generateUuid();
    const rows = await this.prisma.$queryRaw<{ expires_at: Date | null }[]>`
      INSERT INTO chat.user_restrictions
        (id, target_type, target_value, kind, commands, room_id, internal_reason, user_reason, created_by_admin, created_by_role, expires_at)
      VALUES (${id}::uuid, ${data.targetType}, ${data.targetValue}, ${data.kind}, ${data.commands}::text[],
              ${data.roomId}::uuid, ${data.internalReason}, ${data.userReason ?? null}, ${data.adminId}::uuid, 'ADMIN_PANEL',
              CASE WHEN ${data.hours}::float8 IS NULL THEN NULL
                   ELSE now() + make_interval(secs => ${data.hours}::float8 * 3600) END)
      RETURNING expires_at
    `;
    return { id, expiresAt: iso(rows[0]?.expires_at) };
  }

  async liftRestriction(
    id: string,
    adminId: string,
  ): Promise<{ targetType: string; targetValue: string } | null> {
    const rows = await this.prisma.$queryRaw<{ target_type: string; target_value: string }[]>`
      UPDATE chat.user_restrictions SET lifted_at = now(), lifted_by_admin = ${adminId}::uuid
      WHERE id = ${id}::uuid AND lifted_at IS NULL
      RETURNING target_type, target_value
    `;
    return rows[0] ? { targetType: rows[0].target_type, targetValue: rows[0].target_value } : null;
  }

  // Staff requests (Module 4)
  async staffRequests(status: string, limit: number) {
    const filter = status === 'ALL' ? Prisma.empty : Prisma.sql`AND r.status = ${status}`;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        requester_id: string;
        requester_username: string | null;
        requester_role: string;
        permission: string;
        target_user_id: string | null;
        target_username: string | null;
        target_room_id: string | null;
        room_name: string | null;
        payload: Record<string, unknown>;
        note: string;
        status: string;
        resolved_by: string | null;
        resolved_by_admin: string | null;
        resolution_note: string | null;
        created_at: Date;
        resolved_at: Date | null;
      }[]
    >`
      SELECT r.id, r.requester_id, u1.username AS requester_username, r.requester_role, r.permission,
             r.target_user_id, u2.username AS target_username, r.target_room_id, rm.name AS room_name, r.payload,
             r.note, r.status, r.resolved_by, r.resolved_by_admin, r.resolution_note, r.created_at, r.resolved_at
      FROM chat.staff_requests r
      LEFT JOIN identity.users u1 ON u1.id = r.requester_id
      LEFT JOIN identity.users u2 ON u2.id = r.target_user_id
      LEFT JOIN chat.rooms rm ON rm.id = r.target_room_id
      WHERE true ${filter}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      requesterId: r.requester_id,
      requesterUsername: r.requester_username,
      requesterRole: r.requester_role,
      permission: r.permission,
      targetUserId: r.target_user_id,
      targetUsername: r.target_username,
      targetRoomId: r.target_room_id,
      targetRoomName: r.room_name,
      payload: r.payload ?? {},
      note: r.note,
      status: r.status,
      resolvedBy: r.resolved_by_admin ? 'ADMIN_PANEL' : r.resolved_by,
      resolutionNote: r.resolution_note,
      createdAt: iso(r.created_at),
      resolvedAt: iso(r.resolved_at),
    }));
  }

  async staffRequestById(id: string) {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        requester_id: string;
        permission: string;
        target_user_id: string | null;
        target_room_id: string | null;
        payload: Record<string, unknown>;
        status: string;
      }[]
    >`
      SELECT id, requester_id, permission, target_user_id, target_room_id, payload, status
      FROM chat.staff_requests WHERE id = ${id}::uuid
    `;
    return rows[0] ?? null;
  }

  /** PENDING → resolved by an admin; false when someone resolved it first. */
  async resolveStaffRequest(
    id: string,
    status: 'APPROVED' | 'REJECTED',
    adminId: string,
    note: string | null,
  ) {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.staff_requests
      SET status = ${status}, resolved_by_admin = ${adminId}::uuid, resolution_note = ${note}, resolved_at = now()
      WHERE id = ${id}::uuid AND status = 'PENDING'
    `;
    return changed > 0;
  }

  /**
   * "Remove / Add user from specific rooms": ADD lets the user in whatever the room's gates say, REMOVE shuts them out,
   * RESTORE clears both so the room's own rules apply again.
   */
  async setRoomAccess(
    roomId: string,
    userId: string,
    action: 'ADD' | 'REMOVE' | 'RESTORE',
    adminId: string | null = null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Soft-delete existing entries to preserve audit trail.
      await tx.$executeRaw`
        UPDATE chat.room_excluded_users SET removed_at = now(), removed_by = ${adminId}::uuid
        WHERE room_id = ${roomId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL
      `;
      await tx.$executeRaw`
        UPDATE chat.room_included_users SET removed_at = now(), removed_by = ${adminId}::uuid
        WHERE room_id = ${roomId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL
      `;
      if (action === 'REMOVE') {
        await tx.$executeRaw`
          INSERT INTO chat.room_excluded_users (id, room_id, user_id, created_by_admin) VALUES (${ChatUtility.generateUuid()}::uuid, ${roomId}::uuid, ${userId}::uuid, ${adminId}::uuid)
        `;
      }
      if (action === 'ADD') {
        await tx.$executeRaw`
          INSERT INTO chat.room_included_users (id, room_id, user_id, created_by_admin) VALUES (${ChatUtility.generateUuid()}::uuid, ${roomId}::uuid, ${userId}::uuid, ${adminId}::uuid)
        `;
      }
    });
  }

  /** A live ban's new end (counted from now, or none) and reason; null when it is not live. */
  async updateBan(
    id: string,
    data: { seconds: number | null; internalReason: string | null; userReason: string | null },
  ): Promise<{
    userId: string;
    roomId: string | null;
    expiresAt: string | null;
    /** The user reason now in force: the one just given, or the one the ban had. */
    userReason: string | null;
    old: { expiresAt: string | null; internalReason: string; userReason: string | null };
  } | null> {
    const rows = await this.prisma.$queryRaw<
      {
        user_id: string;
        room_id: string | null;
        expires_at: Date | null;
        old_expires_at: Date | null;
        old_internal_reason: string;
        old_user_reason: string | null;
        user_reason: string | null;
      }[]
    >`
      UPDATE chat.user_bans b
      SET expires_at = CASE WHEN ${data.seconds}::int IS NULL THEN NULL
                            ELSE now() + make_interval(secs => ${data.seconds}::int) END,
          internal_reason = COALESCE(${data.internalReason}, b.internal_reason),
          user_reason = COALESCE(${data.userReason}, b.user_reason)
      FROM chat.user_bans old
      WHERE b.id = ${id}::uuid AND old.id = b.id AND b.is_active AND (b.expires_at IS NULL OR b.expires_at > now())
      RETURNING b.user_id, b.room_id, b.expires_at, b.user_reason, old.expires_at AS old_expires_at,
                old.internal_reason AS old_internal_reason, old.user_reason AS old_user_reason
    `;
    const row = rows[0];
    return row
      ? {
          userId: row.user_id,
          roomId: row.room_id,
          expiresAt: iso(row.expires_at),
          userReason: row.user_reason,
          old: {
            expiresAt: iso(row.old_expires_at),
            internalReason: row.old_internal_reason,
            userReason: row.old_user_reason,
          },
        }
      : null;
  }

  /** A live restriction's new end (counted from now, or none) and reason; null when it is not live. */
  async updateRestriction(
    id: string,
    data: { hours: number | null; internalReason: string | null; userReason: string | null },
  ): Promise<{ targetType: string; targetValue: string; expiresAt: string | null } | null> {
    const rows = await this.prisma.$queryRaw<
      { target_type: string; target_value: string; expires_at: Date | null }[]
    >`
      UPDATE chat.user_restrictions
      SET expires_at = CASE WHEN ${data.hours}::float8 IS NULL THEN NULL
                            ELSE now() + make_interval(secs => ${data.hours}::float8 * 3600) END,
          internal_reason = COALESCE(${data.internalReason}, internal_reason),
          user_reason = COALESCE(${data.userReason}, user_reason)
      WHERE id = ${id}::uuid AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      RETURNING target_type, target_value, expires_at
    `;
    const row = rows[0];
    return row
      ? {
          targetType: row.target_type,
          targetValue: row.target_value,
          expiresAt: iso(row.expires_at),
        }
      : null;
  }

  /** "Check Bot Log": what automatic moderation did, to one user or to everyone, newest first. */
  async botLog(userId: string | null, limit: number, before: string | null) {
    const user = userId ? Prisma.sql`AND a.target_user_id = ${userId}::uuid` : Prisma.empty;
    const after = before ? Prisma.sql`AND a.created_at < ${before}::timestamptz` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        action: string;
        target_user_id: string | null;
        username: string | null;
        target_room_id: string | null;
        new_value: unknown;
        note: string | null;
        created_at: Date;
      }[]
    >`
      SELECT a.id, a.action, a.target_user_id, u.username, a.target_room_id, a.new_value, a.note, a.created_at
      FROM chat.moderation_actions a
      LEFT JOIN identity.users u ON u.id = a.target_user_id
      WHERE a.actor_type = 'SYSTEM' ${user} ${after}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      userId: r.target_user_id,
      username: r.username,
      roomId: r.target_room_id,
      detail: r.new_value,
      note: r.note,
      createdAt: iso(r.created_at),
    }));
  }

  /** Merges keys into a room's config (status, rules); false for an unknown room. */
  async patchRoomConfig(roomId: string, patch: Record<string, unknown>): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.rooms SET config = config || ${JSON.stringify(patch)}::jsonb
      WHERE id = ${roomId}::uuid AND deleted_at IS NULL
    `;
    return changed > 0;
  }

  /** Pins or unpins a public-room message for a staff request; null when the message does not exist. */
  async setPinned(messageId: string, pinned: boolean): Promise<{ roomId: string } | null> {
    const rows = pinned
      ? await this.prisma.$queryRaw<{ room_id: string }[]>`
          UPDATE chat.room_messages SET pinned_at = now(), pinned_by = NULL
          WHERE id = ${messageId}::uuid RETURNING room_id`
      : await this.prisma.$queryRaw<{ room_id: string }[]>`
          UPDATE chat.room_messages SET pinned_at = NULL, pinned_by = NULL
          WHERE id = ${messageId}::uuid RETURNING room_id`;
    return rows[0] ? { roomId: rows[0].room_id } : null;
  }

  // Direct messages and groups
  // Paginated user conversations by activity keyset cursor.
  async conversationsOf(userId: string, limit: number, cursor: string | null) {
    return queryConversationsOf(this.prisma, userId, limit, cursor);
  }

  async conversationExists(id: string): Promise<boolean> {
    return queryConversationExists(this.prisma, id);
  }

  /** Who is in a conversation (up to 50 ids), for the audit row of a read. */
  async memberIds(id: string): Promise<string[]> {
    return queryMemberIds(this.prisma, id);
  }

  /** Every message, retracted and hidden ones included and tagged as such; keyset over (created_at, id). */
  async conversationMessages(id: string, limit: number, cursor: string | null) {
    return queryConversationMessages(this.prisma, id, limit, cursor);
  }

  /** Groups, newest first, one page at a time; the member count is the group's own counter (no count over members). */
  async groups(search: string | null, limit: number, cursor: string | null) {
    return queryGroups(this.prisma, search, limit, cursor);
  }
}
