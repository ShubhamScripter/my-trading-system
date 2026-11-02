/** Database access for moderation: reports and reasons, bans, retracts, broadcasts, the moderation log and the change signal. */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../db/client';
import type { ChatReport, ReportReason, UserBan } from './chat.types';
import { ChatUtility } from './chat.utility';
import {
  splitCursor,
  type BanListRow,
  type Db,
  type LogRow,
  type ModerationActionInput,
  type ModerationLogEntry,
  type ReportListRow,
  type ReportRow,
} from './persistence/chat-moderation.types';

export type { ModerationActionInput, ModerationLogEntry, ReportRow };

@Injectable()
export class ChatModerationDbOperation {
  private readonly logger = new Logger('ChatModerationDbOperation');

  constructor(private readonly prisma: PrismaService) { }

  // Reports
  async getReports(opts: {
    status?: string;
    reportedUserId?: string;
    before?: string;
    /** `<created_at text>_<id>` of the last row of the page before. */
    cursor?: string;
    limit: number;
  }): Promise<ChatReport[]> {
    const [at, id] = splitCursor(opts.cursor);
    const rows = await this.prisma.$queryRaw<ReportListRow[]>`
      SELECT
        r.id,
        r.message_id               AS "messageId",
        r.dm_message_id            AS "dmMessageId",
        chat.dm_message_is_archived(r.dm_message_created_at) AS "dmMessageArchived",
        dm.conversation_id         AS "conversationId",
        r.reported_user_id         AS "reportedUserId",
        r.reporter_id              AS "reporterId",
        r.reason,
        r.details,
        r.status::text             AS status,
        r.action,
        r.resolved_by              AS "resolvedBy",
        r.resolved_at              AS "resolvedAt",
        r.created_at               AS "createdAt",
        to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt",
        COALESCE(m.content, dm.content) AS "messageContent",
        m.room_id                  AS "roomId",
        rm.name                    AS "roomName",
        u1.username                AS "reporterUsername",
        u2.username                AS "reportedUsername"
      FROM chat.chat_message_reports r
      LEFT JOIN chat.room_messages m
             ON m.id = r.message_id AND m.created_at = r.message_created_at
      LEFT JOIN chat.rooms rm ON rm.id = m.room_id
      LEFT JOIN LATERAL chat.dm_message_for_report(r.dm_message_id, r.dm_message_created_at) dm
             ON r.dm_message_id IS NOT NULL
      LEFT JOIN identity.users u1 ON u1.id = r.reporter_id
      LEFT JOIN identity.users u2 ON u2.id = r.reported_user_id
      WHERE
        (${opts.status === 'ALL' || !opts.status} OR r.status::text = ${opts.status ?? 'ALL'})
        AND (${!opts.reportedUserId} OR r.reported_user_id = ${opts.reportedUserId ?? null}::uuid)
        AND (${!opts.before} OR r.created_at < ${opts.before ?? null}::timestamptz)
        AND (${!at} OR (r.created_at, r.id) < (${at}::timestamptz, ${id}::uuid))
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${opts.limit}
    `;

    return rows.map((row) => ({
      id: row.id,
      cursor: `${row.cursorAt}_${row.id}`,
      messageId: row.messageId ?? null,
      dmMessageId: row.dmMessageId ?? null,
      dmMessageArchived: row.dmMessageArchived,
      conversationId: row.conversationId ?? null,
      messageContent: row.messageContent ?? null,
      roomId: row.roomId ?? null,
      roomName: row.roomName ?? null,
      reporterId: row.reporterId,
      reporterUsername: row.reporterUsername ?? 'User',
      reportedUserId: row.reportedUserId,
      reportedUsername: row.reportedUsername ?? (row.reportedUserId ? 'User' : null),
      reason: row.reason,
      details: row.details ?? null,
      status: row.status as ChatReport['status'],
      action: row.action ?? null,
      resolvedBy: row.resolvedBy ?? null,
      resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
  }

  async getReportById(reportId: string): Promise<ReportRow | null> {
    const rows = await this.prisma.$queryRaw<ReportRow[]>`
      SELECT id, message_id, dm_message_id, reporter_id, reported_user_id, reason, details, status::text AS status,
             chat.dm_message_is_archived(dm_message_created_at) AS dm_archived
      FROM chat.chat_message_reports WHERE id = ${reportId}::uuid
    `;
    return rows[0] ?? null;
  }

  /**
   * Marks a PENDING report resolved: DISMISSED for a dismissal, ACTIONED for anything else. Returns
   * whether a pending report was there to resolve. The ban, warning or retract itself is done by the service.
   */
  // Claims report and executes moderation work atomically within a transaction.
  async actOnReport<T>(
    reportId: string,
    action: string,
    adminId: string,
    work: (tx: Db) => Promise<T>,
  ): Promise<{ claimed: false } | { claimed: true; value: T }> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.resolveReport(reportId, action, adminId, tx))) return { claimed: false as const };
      return { claimed: true as const, value: await work(tx) };
    });
  }

  /** A warning the user sees in their warnings and the staff warning count (issued by an admin). */
  async createWarning(
    data: { userId: string; roomId: string | null; internalReason: string; userReason?: string | null; adminId: string },
    db: Db = this.prisma,
  ): Promise<void> {
    await db.$executeRaw`
      INSERT INTO chat.chat_warnings (id, user_id, room_id, internal_reason, user_reason, issued_by_admin_id)
      VALUES (${ChatUtility.generateUuid()}::uuid, ${data.userId}::uuid, ${data.roomId}::uuid, ${data.internalReason},
              ${data.userReason ?? null}, ${data.adminId}::uuid)
    `;
  }

  async resolveReport(reportId: string, action: string, adminId: string, db: Db = this.prisma): Promise<boolean> {
    const status = action === 'DISMISS' ? 'DISMISSED' : 'ACTIONED';
    const changed = await db.$executeRaw`
      UPDATE chat.chat_message_reports
      SET
        status      = ${status}::chat."ReportStatus",
        action      = ${action},
        resolved_by = ${adminId}::uuid,
        resolved_at = now()
      WHERE id = ${reportId}::uuid AND status = 'PENDING'::chat."ReportStatus"
    `;
    return changed > 0;
  }

  // Report reasons
  getReportReasons(type: 'MESSAGE' | 'USER' | null = null): Promise<ReportReason[]> {
    return this.prisma.$queryRaw<ReportReason[]>`
      SELECT code, label, report_type AS "reportType", is_active AS "isActive", sort_order AS "sortOrder"
      FROM chat.report_reasons
      WHERE (${type}::text IS NULL OR report_type = ${type})
      ORDER BY sort_order ASC, code ASC
    `;
  }

  async upsertReportReason(data: {
    code: string;
    label: string;
    reportType: 'MESSAGE' | 'USER';
    isActive: boolean;
    sortOrder: number;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.report_reasons (code, label, report_type, is_active, sort_order)
      VALUES (${data.code}, ${data.label}, ${data.reportType}, ${data.isActive}, ${data.sortOrder})
      ON CONFLICT (code, report_type) DO UPDATE SET
        label      = EXCLUDED.label,
        is_active  = EXCLUDED.is_active,
        sort_order = EXCLUDED.sort_order
    `;
  }

  // Bans
  async getBans(opts: {
    before?: string;
    /** `<banned_at text>_<id>` of the last row of the page before. */
    cursor?: string;
    limit: number;
    userId?: string;
    activeOnly: boolean;
  }): Promise<UserBan[]> {
    const [at, id] = splitCursor(opts.cursor);
    const rows = await this.prisma.$queryRaw<BanListRow[]>`
      SELECT
        b.id,
        b.user_id       AS "userId",
        b.room_id       AS "roomId",
        b.moderator_id  AS "moderatorId",
        b.admin_id      AS "adminId",
        b.internal_reason AS "internalReason",
        b.user_reason   AS "userReason",
        b.banned_at     AS "bannedAt",
        to_char(b.banned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt",
        b.expires_at    AS "expiresAt",
        (b.is_active AND (b.expires_at IS NULL OR b.expires_at > now())) AS "isActive",
        b.lifted_by     AS "liftedBy",
        b.lifted_at     AS "liftedAt",
        CASE WHEN u.deleted_at IS NULL THEN u.username ELSE 'Deleted user' END AS username,
        r.name          AS "roomName"
      FROM chat.user_bans b
      LEFT JOIN identity.users u ON u.id = b.user_id
      LEFT JOIN chat.rooms r ON r.id = b.room_id
      WHERE
        (${!opts.before} OR b.banned_at < ${opts.before ?? null}::timestamptz)
        AND (${!at} OR (b.banned_at, b.id) < (${at}::timestamptz, ${id}::uuid))
        AND (${!opts.userId} OR u.id::text = ${opts.userId ?? ''} OR (u.deleted_at IS NULL AND u.username_lower = ${opts.userId?.toLowerCase() ?? ''}))
        AND (${!opts.activeOnly} OR (b.is_active = true AND (b.expires_at IS NULL OR b.expires_at > now())))
      ORDER BY b.banned_at DESC, b.id DESC
      LIMIT ${opts.limit}
    `;

    return rows.map((row) => ({
      id: row.id,
      cursor: `${row.cursorAt}_${row.id}`,
      userId: row.userId,
      username: row.username ?? 'Banned User',
      roomId: row.roomId ?? null,
      roomName: row.roomName ?? null,
      moderatorId: row.moderatorId ?? null,
      adminId: row.adminId ?? null,
      internalReason: row.internalReason,
      userReason: row.userReason ?? null,
      bannedAt: new Date(row.bannedAt).toISOString(),
      // No end means a permanent ban.
      expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
      isActive: row.isActive,
      liftedBy: row.liftedBy ?? null,
      liftedAt: row.liftedAt ? new Date(row.liftedAt).toISOString() : null,
    }));
  }

  // Creates ban with database timestamp calculation.
  async createBan(data: {
    id: string;
    userId: string;
    roomId?: string | null;
    adminId: string;
    // Internal audit reason for staff.
    internalReason: string;
    // Optional reason visible to the user.
    userReason?: string | null;
    // Ban length in seconds, or null for permanent.
    seconds: number | null;
  }, db: Db = this.prisma): Promise<{ expiresAt: Date | null }> {
    const rows = await db.$queryRaw<{ expires_at: Date | null }[]>`
      INSERT INTO chat.user_bans (id, user_id, room_id, admin_id, internal_reason, user_reason, banned_at, expires_at, is_active)
      VALUES (
        ${data.id}::uuid,
        ${data.userId}::uuid,
        ${data.roomId ?? null}::uuid,
        ${data.adminId}::uuid,
        ${data.internalReason},
        ${data.userReason ?? null},
        now(),
        CASE WHEN ${data.seconds}::int IS NULL THEN NULL ELSE now() + make_interval(secs => ${data.seconds}::int) END,
        true
      )
      RETURNING expires_at
    `;
    return { expiresAt: rows[0]?.expires_at ?? null };
  }

  /** Lifts a ban on the database clock; returns the banned user and room, or null when nothing was lifted. */
  async liftBan(
    banId: string,
    adminId: string,
  ): Promise<{ userId: string; roomId: string | null } | null> {
    const rows = await this.prisma.$queryRaw<{ user_id: string; room_id: string | null }[]>`
      UPDATE chat.user_bans
      SET is_active = false, lifted_by = ${adminId}::uuid, lifted_at = now()
      WHERE id = ${banId}::uuid AND is_active = true
      RETURNING user_id, room_id
    `;
    return rows[0] ? { userId: rows[0].user_id, roomId: rows[0].room_id } : null;
  }

  /** The longest ban allowed by the chat settings (hours); 30 days when none is set. */
  async maxBanHours(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ value: unknown }[]>`
      SELECT document->'global'->'limits'->'maxBanHours' AS value FROM chat.settings WHERE id = 1
    `;
    const value = Number(rows[0]?.value);
    return Number.isInteger(value) && value > 0 ? value : 24 * 30;
  }

  // Retract and broadcast
  /** Retracts a message; the admin id goes in retracted_by_admin_id. Null when it was missing or already retracted. */
  async retractMessage(
    messageId: string,
    adminId: string,
    db: Db = this.prisma,
  ): Promise<{ roomId: string; userId: string; createdAt: Date; retractedAt: Date } | null> {
    const rows = await db.$queryRaw<
      { room_id: string; user_id: string; created_at: Date; retracted_at: Date }[]
    >`
      UPDATE chat.room_messages
      SET retracted_at = now(), retracted_by_admin_id = ${adminId}::uuid
      WHERE id = ${messageId}::uuid AND retracted_at IS NULL
      RETURNING room_id, user_id, created_at, retracted_at
    `;
    const row = rows[0];
    return row
      ? {
        roomId: row.room_id,
        userId: row.user_id,
        createdAt: row.created_at,
        retractedAt: row.retracted_at,
      }
      : null;
  }

  // Creates a system alert broadcast across all specified rooms atomically.
  async createBroadcast(data: {
    broadcastId: string;
    roomIds: readonly string[];
    userId: string;
    content: string;
    metadata: Record<string, unknown>;
    audit: ModerationActionInput;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO chat.room_messages (id, room_id, user_id, content, type, metadata, created_at)
        SELECT gen_random_uuid(), t.room_id, ${data.userId}::uuid, ${data.content}, 'ADMIN_ALERT'::chat."MessageType",
               ${JSON.stringify({ ...data.metadata, broadcastId: data.broadcastId })}::jsonb, now()
        FROM unnest(${[...data.roomIds]}::uuid[]) AS t(room_id)
      `;
      await this.recordModerationAction(
        { ...data.audit, newValue: { ...(data.audit.newValue as object), broadcastId: data.broadcastId } },
        tx,
      );
    });
  }

  async createBroadcastMessage(data: {
    id: string;
    roomId: string;
    userId: string;
    content: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.room_messages (id, room_id, user_id, content, type, metadata, created_at)
      VALUES (
        ${data.id}::uuid,
        ${data.roomId}::uuid,
        ${data.userId}::uuid,
        ${data.content},
        'ADMIN_ALERT'::chat."MessageType",
        ${data.metadata}::jsonb,
        now()
      )
    `;
  }

  // Moderation log
  /** Appends one admin action to the append-only moderation log. */
  async recordModerationAction(data: ModerationActionInput, db: Db = this.prisma): Promise<void> {
    await db.$executeRaw`
      INSERT INTO chat.moderation_actions (
        id, actor_type, actor_id, action,
        target_user_id, target_room_id, target_message_id, target_message_created_at,
        old_value, new_value, note, created_at
      ) VALUES (
        ${ChatUtility.generateUuid()}::uuid,
        'ADMIN',
        ${data.actorId}::uuid,
        ${data.action},
        ${data.targetUserId ?? null}::uuid,
        ${data.targetRoomId ?? null}::uuid,
        ${data.targetMessageId ?? null}::uuid,
        ${data.targetMessageCreatedAt ?? null},
        ${data.oldValue !== undefined ? JSON.stringify(data.oldValue) : null}::jsonb,
        ${data.newValue !== undefined ? JSON.stringify(data.newValue) : null}::jsonb,
        ${data.note ?? null},
        now()
      )
    `;
  }

  /** Every recorded chat action (admin, staff and auto-moderation), newest first, cursor-paged. */
  async getModerationActions(opts: {
    before?: string;
    limit: number;
    actorType?: string;
  }): Promise<{ actions: ModerationLogEntry[]; nextCursor: string | null }> {
    const rows = await this.prisma.$queryRaw<LogRow[]>`
      SELECT
        ma.id,
        ma.actor_type                AS "actorType",
        ma.actor_id                  AS "actorId",
        actor.username               AS "actorUsername",
        ma.action,
        ma.target_user_id            AS "targetUserId",
        target.username              AS "targetUsername",
        ma.target_room_id            AS "targetRoomId",
        r.name                       AS "targetRoomName",
        ma.target_message_id         AS "targetMessageId",
        ma.new_value                 AS "newValue",
        ma.note,
        ma.created_at                AS "createdAt",
        to_char(ma.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
      FROM chat.moderation_actions ma
      LEFT JOIN identity.users actor ON actor.id = ma.actor_id
      LEFT JOIN identity.users target ON target.id = ma.target_user_id
      LEFT JOIN chat.rooms r ON r.id = ma.target_room_id
      WHERE (${!opts.before} OR ma.created_at < ${opts.before ?? null}::timestamptz)
        AND (${!opts.actorType} OR ma.actor_type = ${opts.actorType ?? ''})
      ORDER BY ma.created_at DESC, ma.id DESC
      LIMIT ${opts.limit + 1}
    `;
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const actorFallback = (type: string): string =>
      type === 'SYSTEM' ? 'Auto-moderation' : type === 'ADMIN' ? 'Admin' : 'Staff';
    return {
      actions: page.map((row) => ({
        id: row.id,
        actorType: row.actorType,
        actorId: row.actorId ?? null,
        // Admin accounts live outside identity.users, so they show as "Admin".
        actorName: row.actorUsername ?? actorFallback(row.actorType),
        action: row.action,
        targetUserId: row.targetUserId ?? null,
        targetUsername: row.targetUsername ?? null,
        targetRoomId: row.targetRoomId ?? null,
        targetRoomName: row.targetRoomName ?? null,
        targetMessageId: row.targetMessageId ?? null,
        newValue: row.newValue ?? null,
        note: row.note ?? null,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.cursorAt ?? null) : null,
    };
  }

  // Users and the change signal
  /** A user id, username or login code as the id of a live account, or null. */
  async resolveUserId(identifier: string): Promise<string | null> {
    if (ChatUtility.isValidUuid(identifier)) {
      // Even when given a UUID, confirm the account is live.
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM identity.users WHERE id = ${identifier}::uuid AND deleted_at IS NULL LIMIT 1
      `;
      return rows[0]?.id ?? null;
    }
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM identity.users
      WHERE (username_lower = ${identifier.toLowerCase()} OR public_code_key = ${identifier.toUpperCase()})
        AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  /**
   * Tells the chat server something changed. It listens on 'chat_events' and applies the change to
   * open sockets within about 5 seconds. A failed signal is logged; the chat server's 30-second backstop
   * still picks up room and settings changes.
   */
  /**
   * Removes a reported DM or group message from members' view (Module 8). Kept for admins: nothing is deleted.
   * Returns its conversation, or null when it was already hidden.
   */
  async hideDmMessage(
    messageId: string,
    adminId: string,
    db: Db = this.prisma,
  ): Promise<{ conversationId: string; senderId: string } | null> {
    const rows = await db.$queryRaw<{ conversation_id: string; sender_id: string }[]>`
      UPDATE chat.dm_messages SET hidden_at = now(), hidden_by = ${adminId}::uuid
      WHERE id = ${messageId}::uuid AND hidden_at IS NULL
      RETURNING conversation_id, sender_id
    `;
    return rows[0] ? { conversationId: rows[0].conversation_id, senderId: rows[0].sender_id } : null;
  }

  async notify(payload: { kind: string;[key: string]: unknown }): Promise<void> {
    try {
      await this.prisma.$executeRaw`SELECT pg_notify('chat_events', ${JSON.stringify(payload)})`;
    } catch (err) {
      this.logger.error({ err, payload }, 'pg_notify failed');
    }
  }
}
