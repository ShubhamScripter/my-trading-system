import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import { TIME_TEXT, isUniqueViolation, type Db } from './chat.sql';
import type { Cursor } from '../chat.utility';
import type { ReportType } from '../chat.types';

// The records chat keeps about moderation and operations: bans, warnings, offences, the append-only moderation
// record, reports, uploads, and the maintenance tick's tables. Messages, rooms and users are in ChatDbOperation.
@Injectable()
export class ChatRecordsDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Runs `work` in one transaction, so a moderation write and its audit row land together or not at all.
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  // One audit row outside any transaction.
  recordActionNow(action: Parameters<ChatRecordsDbOperation['recordAction']>[1]): Promise<void> {
    return this.recordAction(this.prisma, action);
  }

  // A user's test-only stand-in facts (NEW-2), or null when the admin has not set any.
  testEntitlement(userId: string) {
    return this.prisma.testEntitlement.findUnique({ where: { userId } });
  }

  // The test-only follow lists (NEW-2) of the given users.
  async testFollows(userIds: readonly string[]): Promise<Map<string, string[]>> {
    const rows = await this.prisma.testEntitlement.findMany({
      where: { userId: { in: [...userIds] } },
      select: { userId: true, follows: true },
    });
    return new Map(rows.map((row) => [row.userId, row.follows]));
  }

  // Bans, warnings, offences, audit
  // The user's active bans, judged by the database clock.
  async activeBans(userId: string): Promise<{ roomId: string | null; expiresAt: Date | null }[]> {
    const rows = await this.prisma.$queryRaw<{ room_id: string | null; expires_at: Date | null }[]>`
      SELECT room_id, expires_at FROM chat.user_bans
      WHERE user_id = ${userId}::uuid AND is_active AND (expires_at IS NULL OR expires_at > now())
    `;
    return rows.map((row) => ({ roomId: row.room_id, expiresAt: row.expires_at }));
  }

  // A ban whose end is set by the database: now() + seconds, or NULL for permanent.
  async createBan(
    db: Db,
    data: {
      userId: string;
      roomId: string | null;
      // What staff or the rule wrote: required, never shown to the user.
      internalReason: string;
      // The optional reason the user sees.
      userReason?: string | null;
      seconds: number | null;
      moderatorId: string | null;
      // The issuer's chat role now, kept on the ban as its rank.
      moderatorRole?: string | null;
      // Staff bans: answer null instead of making a second ban while one is live for this user and room.
      refuseIfBanned?: boolean;
    },
  ): Promise<{ id: string; expiresAt: Date | null } | null> {
    const id = uuidv7();
    if (data.refuseIfBanned) {
      // One lock per user and room, held to the end of the transaction: parallel bans queue behind the first.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ban:${data.userId}:${data.roomId ?? ''}`}, 0))`;
      const live = await db.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM chat.user_bans
        WHERE user_id = ${data.userId}::uuid AND room_id IS NOT DISTINCT FROM ${data.roomId}::uuid
          AND is_active AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1
      `;
      if (live.length > 0) return null;
    }
    const rows = await db.$queryRaw<{ expires_at: Date | null }[]>`
      INSERT INTO chat.user_bans (id, user_id, room_id, moderator_id, internal_reason, user_reason, expires_at, is_active, moderator_role)
      VALUES (${id}::uuid, ${data.userId}::uuid, ${data.roomId}::uuid, ${data.moderatorId}::uuid, ${data.internalReason}, ${data.userReason ?? null},
              CASE WHEN ${data.seconds}::int IS NULL THEN NULL ELSE now() + make_interval(secs => ${data.seconds}::int) END,
              true, ${data.moderatorRole ?? null})
      RETURNING expires_at
    `;
    return { id, expiresAt: rows[0]?.expires_at ?? null };
  }

  async createWarning(
    db: Db,
    data: {
      userId: string;
      roomId: string | null;
      internalReason: string;
      userReason?: string | null;
      issuedBy: string | null;
    },
  ): Promise<string> {
    const id = uuidv7();
    await db.$executeRaw`
      INSERT INTO chat.chat_warnings (id, user_id, room_id, internal_reason, user_reason, issued_by)
      VALUES (${id}::uuid, ${data.userId}::uuid, ${data.roomId}::uuid, ${data.internalReason}, ${data.userReason ?? null}, ${data.issuedBy}::uuid)
    `;
    return id;
  }

  // A warning for a group: one rule row, evaluated when a user's warnings are read.
  async createGroupWarning(
    db: Db,
    data: {
      targetType: 'PREMIUM' | 'KYC' | 'LEVEL';
      targetValue: string;
      roomId: string | null;
      internalReason: string;
      userReason?: string | null;
      issuedBy: string;
      issuedByRole: string;
    },
  ): Promise<string> {
    const id = uuidv7();
    await db.$executeRaw`
      INSERT INTO chat.group_warnings (id, target_type, target_value, room_id, internal_reason, user_reason, issued_by, issued_by_role)
      VALUES (${id}::uuid, ${data.targetType}, ${data.targetValue}, ${data.roomId}::uuid, ${data.internalReason}, ${data.userReason ?? null},
              ${data.issuedBy}::uuid, ${data.issuedByRole})
    `;
    return id;
  }

  // Every group warning rule, newest first, read in pages by keyset (a rule names a group, so there are few).
  async groupWarnings(pageSize = 1000) {
    type Row = {
      id: string;
      target_type: 'PREMIUM' | 'KYC' | 'LEVEL';
      target_value: string;
      room_id: string | null;
      user_reason: string | null;
      created_at: Date;
      created_at_text: string;
    };
    const all: Row[] = [];
    let after: { at: string; id: string } | null = null;
    for (;;) {
      const rows: Row[] = await this.prisma.$queryRaw<Row[]>`
        SELECT id, target_type, target_value, room_id, user_reason, created_at, ${TIME_TEXT('created_at')} AS created_at_text
        FROM chat.group_warnings
        WHERE true ${after ? Prisma.sql`AND (created_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
        ORDER BY created_at DESC, id DESC
        LIMIT ${pageSize}
      `;
      all.push(...rows);
      const last = rows[rows.length - 1];
      if (!last || rows.length < pageSize) return all;
      after = { at: last.created_at_text, id: last.id };
    }
  }

  // The user's own warnings, explicit fields only — never who issued them.
  async warnings(userId: string, limit: number, cursor: Cursor | null) {
    const after = cursor
      ? Prisma.sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    return this.prisma.$queryRaw<
      {
        id: string;
        room_id: string | null;
        user_reason: string | null;
        created_at: Date;
        created_at_text: string;
      }[]
    >`
      SELECT id, room_id, user_reason, created_at, ${TIME_TEXT('created_at')} AS created_at_text
      FROM chat.chat_warnings
      WHERE user_id = ${userId}::uuid ${after}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
  }

  // One offence on the chat-wide auto-moderation ladder, in Postgres (one row per user, whatever the room): a lapsed
// row counts from 1 again; the returned count picks the tier.
  async recordOffence(userId: string, resetHours: (count: number) => number): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // A user's first offence has no row to lock yet, so parallel offences take a lock on the user instead.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`offence:${userId}`}, 0))`;
      const current = await tx.$queryRaw<{ count: number; live: boolean }[]>`
        SELECT count, expires_at > now() AS live FROM chat.moderation_offences
        WHERE user_id = ${userId}::uuid FOR UPDATE
      `;
      const next = current[0]?.live ? current[0].count + 1 : 1;
      const hours = resetHours(next);
      await tx.$executeRaw`
        INSERT INTO chat.moderation_offences (user_id, count, expires_at)
        VALUES (${userId}::uuid, ${next}, now() + make_interval(secs => ${hours * 3600}))
        ON CONFLICT (user_id) DO UPDATE SET count = EXCLUDED.count, expires_at = EXCLUDED.expires_at
      `;
      return next;
    });
  }

  // One append-only moderation record. Stores ids and field names, never message text.
  async recordAction(
    db: Db,
    action: {
      actorType: 'STAFF' | 'SYSTEM';
      actorId: string | null;
      action: string;
      targetUserId?: string | null;
      targetRoomId?: string | null;
      targetMessageId?: string | null;
      // Database text of the message time (microseconds).
      targetMessageCreatedAt?: string | null;
      oldValue?: unknown;
      newValue?: unknown;
      note?: string | null;
    },
  ): Promise<void> {
    await db.$executeRaw`
      INSERT INTO chat.moderation_actions (
        id, actor_type, actor_id, action, target_user_id, target_room_id, target_message_id,
        target_message_created_at, old_value, new_value, note
      ) VALUES (
        ${uuidv7()}::uuid, ${action.actorType}, ${action.actorId}::uuid, ${action.action},
        ${action.targetUserId ?? null}::uuid, ${action.targetRoomId ?? null}::uuid, ${action.targetMessageId ?? null}::uuid,
        ${action.targetMessageCreatedAt ?? null}::timestamptz,
        ${action.oldValue === undefined ? null : JSON.stringify(action.oldValue)}::jsonb,
        ${action.newValue === undefined ? null : JSON.stringify(action.newValue)}::jsonb,
        ${action.note ?? null}
      )
    `;
  }

  // Admin actions newer than a database time, for replay after the LISTEN connection comes back.
  async adminActionsSince(since: Date, limit = 500) {
    return this.prisma.$queryRaw<
      {
        id: string;
        action: string;
        target_user_id: string | null;
        target_room_id: string | null;
        target_message_id: string | null;
        new_value: Record<string, unknown> | null;
        note: string | null;
        created_at: Date;
      }[]
    >`
      SELECT id, action, target_user_id, target_room_id, target_message_id, new_value, note, created_at
      FROM chat.moderation_actions
      WHERE actor_type = 'ADMIN' AND created_at > ${since}::timestamptz
      ORDER BY created_at, id
      LIMIT ${limit}
    `;
  }

  async moderationActionById(id: string) {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        action: string;
        target_user_id: string | null;
        target_room_id: string | null;
        target_message_id: string | null;
        new_value: Record<string, unknown> | null;
        note: string | null;
        created_at: Date;
      }[]
    >`
      SELECT id, action, target_user_id, target_room_id, target_message_id, new_value, note, created_at
      FROM chat.moderation_actions WHERE id = ${id}::uuid
    `;
    return rows[0] ?? null;
  }

  // The append-only command log (Module 5): ids and amounts only, never message text. Fire and forget.
  async logCommand(entry: {
    userId: string;
    roomId: string | null;
    command: string;
    args: Record<string, unknown>;
    result: 'EXECUTED' | 'REFUSED';
    reason: string | null;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.chat_commands (id, user_id, room_id, command, args, result, reason)
      VALUES (${uuidv7()}::uuid, ${entry.userId}::uuid, ${entry.roomId}::uuid, ${entry.command},
              ${JSON.stringify(entry.args)}::jsonb, ${entry.result}, ${entry.reason})
    `;
  }

  // Reports
  async activeReportReasons(type: ReportType = 'MESSAGE'): Promise<{ code: string; label: string }[]> {
    return this.prisma.reportReason.findMany({
      where: { isActive: true, reportType: type },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { code: true, label: true },
    });
  }

  async isActiveReason(code: string, type: ReportType = 'MESSAGE'): Promise<boolean> {
    const row = await this.prisma.reportReason.findFirst({
      where: { code, isActive: true, reportType: type },
      select: { code: true },
    });
    return row !== null;
  }

  // Reports this reporter made in the last hour, on the database clock.
  async recentReportCount(reporterId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.chat_message_reports
      WHERE reporter_id = ${reporterId}::uuid AND created_at > now() - interval '1 hour'
    `;
    return rows[0]?.n ?? 0;
  }

  // Inserts a report; a duplicate (unique index) returns null.
  async insertReport(data: {
    messageId: string | null;
    // The message's created_at as database text (microseconds), never a JavaScript Date.
    messageCreatedAt: string | null;
    reporterId: string;
    reportedUserId: string | null;
    reason: string;
    reportType?: ReportType;
    details: string | null;
  }): Promise<{ id: string; createdAt: Date } | null> {
    const id = uuidv7();
    try {
      const rows = await this.prisma.$queryRaw<{ created_at: Date }[]>`
        INSERT INTO chat.chat_message_reports (id, message_id, message_created_at, reporter_id, reported_user_id, reason, report_type, details, status)
        VALUES (${id}::uuid, ${data.messageId}::uuid, ${data.messageCreatedAt}::timestamptz, ${data.reporterId}::uuid,
                ${data.reportedUserId}::uuid, ${data.reason}, ${data.reportType ?? 'MESSAGE'}, ${data.details}, 'PENDING')
        RETURNING created_at
      `;
      return { id, createdAt: rows[0]!.created_at };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  // A report about a DM or group message (Module 8); a duplicate returns null.
  async insertDmReport(data: {
    dmMessageId: string;
    reporterId: string;
    reportedUserId: string;
    reason: string;
    details: string | null;
  }): Promise<{ id: string; createdAt: Date } | null> {
    const id = uuidv7();
    try {
      const rows = await this.prisma.$queryRaw<{ created_at: Date }[]>`
        INSERT INTO chat.chat_message_reports (id, dm_message_id, dm_message_created_at, reporter_id, reported_user_id, reason, report_type, details, status)
        SELECT ${id}::uuid, m.id, m.created_at, ${data.reporterId}::uuid, ${data.reportedUserId}::uuid,
                ${data.reason}, 'MESSAGE', ${data.details}, 'PENDING'
        FROM chat.dm_message_for_report(${data.dmMessageId}::uuid, NULL::timestamptz) m
        RETURNING created_at
      `;
      return { id, createdAt: rows[0]!.created_at };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  // Uploads
  // Seconds until the user may upload again (0 = now), from their last upload and the database clock.
  async uploadWaitSeconds(uploaderId: string, cooldownSeconds: number): Promise<number> {
    if (cooldownSeconds <= 0) return 0;
    const rows = await this.prisma.$queryRaw<{ wait: number | null }[]>`
      SELECT ceil(extract(epoch FROM (max(created_at) + make_interval(secs => ${cooldownSeconds}) - now())))::int AS wait
      FROM chat.media_uploads
      WHERE uploader_id = ${uploaderId}::uuid AND created_at > now() - make_interval(secs => ${cooldownSeconds})
    `;
    return Math.max(0, rows[0]?.wait ?? 0);
  }

  async insertUpload(data: {
    id: string;
    uploaderId: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
  }) {
    await this.prisma.mediaUpload.create({ data });
  }

  async uploadById(id: string) {
    return this.prisma.mediaUpload.findUnique({
      where: { id },
      select: { id: true, mimeType: true, storageKey: true, deletedAt: true },
    });
  }

  async uploadsPendingRemoval(limit = 100) {
    return this.prisma.mediaUpload.findMany({
      where: { deletedAt: { not: null }, fileRemovedAt: null },
      select: { id: true, storageKey: true },
      take: limit,
    });
  }

  async markUploadFileRemoved(id: string): Promise<void> {
    await this.prisma
      .$executeRaw`UPDATE chat.media_uploads SET file_removed_at = now() WHERE id = ${id}::uuid`;
  }

  // Maintenance
  async ensurePartitions(monthsAhead: number): Promise<{ created: number; defaultRows: number }> {
    const created = await this.prisma.$queryRaw<
      { n: number }[]
    >`SELECT chat.ensure_message_partitions(${monthsAhead}::int) AS n`;
    const inDefault = await this.prisma.$queryRaw<
      { n: number }[]
    >`SELECT (SELECT count(*) FROM chat.room_messages_default) + (SELECT count(*) FROM chat.dm_messages_default) AS n`;
    return { created: created[0]?.n ?? 0, defaultRows: Number(inDefault[0]?.n ?? 0) };
  }

  // Deletes send-retry ids older than the retention, 1,000 at a time.
  async pruneClientIds(retentionHours: number): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM chat.client_message_ids
      WHERE ctid IN (
        SELECT ctid FROM chat.client_message_ids
        WHERE created_at < now() - make_interval(hours => ${retentionHours}::int)
        LIMIT 1000
      )
    `;
  }

  async writeRuntimeStats(stats: {
    onlineUsers: number;
    sockets: number;
    messagesLastMinute: number;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.runtime_stats (id, online_users, sockets, messages_last_minute, updated_at)
      VALUES (1, ${stats.onlineUsers}, ${stats.sockets}, ${stats.messagesLastMinute}, now())
      ON CONFLICT (id) DO UPDATE SET online_users = EXCLUDED.online_users, sockets = EXCLUDED.sockets,
        messages_last_minute = EXCLUDED.messages_last_minute, updated_at = now()
    `;
  }

  // Adds a minute's limit hits and blocks users over the threshold until a database time. Returns the users
// blocked right now.
  async recordLimitHits(
    hits: ReadonlyMap<string, { count: number; ip: string; block: boolean; reasons: ReadonlyMap<string, number> }>,
    blockMinutes: number,
  ): Promise<Map<string, Date>> {
    const entries = [...hits.entries()];
    if (entries.length > 0) {
      // The same flush also counts the hits per user, reason and hour: what the admin reads before unblocking.
      const rows = entries.flatMap(([id, v]) => [...v.reasons].map(([reason, n]) => ({ id, reason, n })));
      await this.prisma.$executeRaw`
        INSERT INTO chat.limit_hits_hourly (user_id, hour, reason, hits)
        SELECT h.user_id, date_trunc('hour', now()), h.reason, h.hits
        FROM unnest(${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.reason)}::text[], ${rows.map((r) => r.n)}::int[])
             AS h(user_id, reason, hits)
        ON CONFLICT (user_id, hour, reason) DO UPDATE SET hits = chat.limit_hits_hourly.hits + EXCLUDED.hits
      `;
      await this.prisma.$executeRaw`
        INSERT INTO chat.frequent_hitters (user_id, last_ip, hits, last_hit_at, blocked_until)
        SELECT h.user_id, h.ip, h.hits, now(),
               CASE WHEN h.block THEN now() + make_interval(mins => ${blockMinutes}::int) END
        FROM unnest(${entries.map(([id]) => id)}::uuid[], ${entries.map(([, v]) => v.ip)}::text[],
                    ${entries.map(([, v]) => v.count)}::int[], ${entries.map(([, v]) => v.block)}::boolean[]) AS h(user_id, ip, hits, block)
        ON CONFLICT (user_id) DO UPDATE SET
          last_ip = COALESCE(NULLIF(EXCLUDED.last_ip, ''), chat.frequent_hitters.last_ip),
          hits = chat.frequent_hitters.hits + EXCLUDED.hits,
          last_hit_at = now(),
          blocked_until = COALESCE(EXCLUDED.blocked_until, chat.frequent_hitters.blocked_until)
      `;
    }
    const blocked = await this.prisma.$queryRaw<{ user_id: string; blocked_until: Date }[]>`
      SELECT user_id, blocked_until FROM chat.frequent_hitters WHERE blocked_until > now()
    `;
    return new Map(blocked.map((row) => [row.user_id, row.blocked_until]));
  }
}
