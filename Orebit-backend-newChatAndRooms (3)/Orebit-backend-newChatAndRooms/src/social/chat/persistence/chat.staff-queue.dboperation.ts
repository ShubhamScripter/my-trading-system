/**
 * Database access for what staff read in the app (Module 4): the reported-message queue (public and DM messages) and
 * the history reads limited by the role's day window — a user's messages, a user's tags and a room's history, with
 * retracted messages included.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import type { Cursor } from '../chat.utility';
import type { MessageRow } from '../chat.types';
import { MESSAGE_SELECT, TIME_TEXT, toMessageRow, type Db, type MessageSqlRow } from './chat.sql';

@Injectable()
export class ChatStaffQueueDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Reports
  async reports(opts: { status: string; limit: number; before: Cursor | null }) {
    const status =
      opts.status === 'ALL'
        ? Prisma.empty
        : Prisma.sql`AND r.status = ${opts.status}::chat."ReportStatus"`;
    const before = opts.before
      ? Prisma.sql`AND (r.created_at, r.id) < (${opts.before.createdAt}::timestamptz, ${opts.before.id}::uuid)`
      : Prisma.empty;
    return this.prisma.$queryRaw<
      {
        id: string;
        message_id: string | null;
        dm_message_id: string | null;
        room_id: string | null;
        message_content: string | null;
        message_retracted: boolean | null;
        reporter_id: string;
        reporter_username: string | null;
        reported_user_id: string;
        reported_username: string | null;
        reason: string;
        details: string | null;
        status: string;
        action: string | null;
        created_at: Date;
        created_at_text: string;
      }[]
    >`
      SELECT r.id, r.message_id, r.dm_message_id, m.room_id, COALESCE(m.content, dm.content) AS message_content,
             COALESCE(m.retracted_at, dm.retracted_at) IS NOT NULL AS message_retracted,
             r.reporter_id, u1.username AS reporter_username, r.reported_user_id, u2.username AS reported_username,
             r.reason, r.details, r.status::text AS status, r.action, r.created_at,
             ${TIME_TEXT('r.created_at')} AS created_at_text
      FROM chat.chat_message_reports r
      LEFT JOIN chat.room_messages m ON m.id = r.message_id AND m.created_at = r.message_created_at
      LEFT JOIN chat.dm_messages dm ON dm.id = r.dm_message_id AND dm.created_at = r.dm_message_created_at
      LEFT JOIN identity.users u1 ON u1.id = r.reporter_id
      LEFT JOIN identity.users u2 ON u2.id = r.reported_user_id
      WHERE true ${status} ${before}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${opts.limit + 1}
    `;
  }

  async reportById(id: string) {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        message_id: string | null;
        dm_message_id: string | null;
        room_id: string | null;
        reported_user_id: string;
        status: string;
      }[]
    >`
      SELECT r.id, r.message_id, r.dm_message_id, m.room_id, r.reported_user_id, r.status::text AS status
      FROM chat.chat_message_reports r
      LEFT JOIN chat.room_messages m ON m.id = r.message_id AND m.created_at = r.message_created_at
      WHERE r.id = ${id}::uuid
    `;
    return rows[0] ?? null;
  }

  async resolveReport(
    id: string,
    action: string,
    staffId: string,
    db: Db = this.prisma,
  ): Promise<boolean> {
    const status = action === 'DISMISS' ? 'DISMISSED' : 'ACTIONED';
    const changed = await db.$executeRaw`
      UPDATE chat.chat_message_reports
      SET status = ${status}::chat."ReportStatus", action = ${action}, resolved_by = ${staffId}::uuid,
          resolved_at = now()
      WHERE id = ${id}::uuid AND status = 'PENDING'::chat."ReportStatus"
    `;
    return changed > 0;
  }

  /** Gives a claimed report back (the action did not happen: it failed, or REPORT mode only made a request). */
  async reopenReport(id: string, staffId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.chat_message_reports
      SET status = 'PENDING'::chat."ReportStatus", action = NULL, resolved_by = NULL, resolved_at = NULL
      WHERE id = ${id}::uuid AND resolved_by = ${staffId}::uuid AND status <> 'PENDING'::chat."ReportStatus"
    `;
  }

  // A user's history (staff)
  /** "Sort and See all recent messages of a single user", within the role's day window, newest first. */
  async userMessages(
    userId: string,
    days: number,
    limit: number,
    cursor: Cursor | null,
  ): Promise<MessageRow[]> {
    const after = cursor
      ? Prisma.sql`AND (m.created_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<MessageSqlRow[]>`
      ${MESSAGE_SELECT}
      WHERE m.user_id = ${userId}::uuid AND m.created_at > now() - make_interval(days => ${days}::int) ${after}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit + 1}
    `;
    return rows.map(toMessageRow);
  }

  /** "See all tags of a user", within the role's day window. */
  async userTags(
    userId: string,
    days: number,
    limit: number,
    cursor: Cursor | null,
  ): Promise<MessageRow[]> {
    const after = cursor
      ? Prisma.sql`AND (mm.created_at, mm.message_id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<MessageSqlRow[]>`
      ${MESSAGE_SELECT}
      JOIN chat.message_mentions mm ON mm.message_id = m.id AND mm.created_at = m.created_at
      WHERE mm.mentioned_user_id = ${userId}::uuid
        AND mm.created_at > now() - make_interval(days => ${days}::int) ${after}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit + 1}
    `;
    return rows.map(toMessageRow);
  }

  /** "See Previous Chat (chat history)" for staff: a room's messages within the day window, retracted included. */
  async roomMessages(
    roomId: string,
    days: number,
    limit: number,
    cursor: Cursor | null,
  ): Promise<MessageRow[]> {
    const after = cursor
      ? Prisma.sql`AND (m.created_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<MessageSqlRow[]>`
      ${MESSAGE_SELECT}
      WHERE m.room_id = ${roomId}::uuid AND m.created_at > now() - make_interval(days => ${days}::int) ${after}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit + 1}
    `;
    return rows.map(toMessageRow);
  }

  // User stats and the bot log
  /** "See User Stats": the chat facts chat keeps about one user, all in one statement. */
  async userStats(userId: string) {
    const rows = await this.prisma.$queryRaw<
      {
        messages: number;
        messages_30d: number;
        warnings: number;
        bans: number;
        active_bans: number;
        reports_against: number;
        reports_made: number;
        restrictions: number;
        gifts_sent: number;
        gifts_received: number;
        gifts_sent_usd: Prisma.Decimal | null;
        ads: number;
        ads_usd: Prisma.Decimal | null;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM chat.room_messages WHERE user_id = ${userId}::uuid) AS messages,
        (SELECT count(*)::int FROM chat.room_messages
          WHERE user_id = ${userId}::uuid AND created_at > now() - interval '30 days') AS messages_30d,
        (SELECT count(*)::int FROM chat.chat_warnings WHERE user_id = ${userId}::uuid) AS warnings,
        (SELECT count(*)::int FROM chat.user_bans WHERE user_id = ${userId}::uuid) AS bans,
        (SELECT count(*)::int FROM chat.user_bans WHERE user_id = ${userId}::uuid AND is_active
          AND (expires_at IS NULL OR expires_at > now())) AS active_bans,
        (SELECT count(*)::int FROM chat.chat_message_reports WHERE reported_user_id = ${userId}::uuid) AS reports_against,
        (SELECT count(*)::int FROM chat.chat_message_reports WHERE reporter_id = ${userId}::uuid) AS reports_made,
        (SELECT count(*)::int FROM chat.user_restrictions WHERE target_type = 'USER' AND target_value = ${userId}
          AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS restrictions,
        (SELECT count(*)::int FROM chat.gift_transfers WHERE sender_id = ${userId}::uuid AND status = 'COMPLETED') AS gifts_sent,
        (SELECT count(*)::int FROM chat.gift_transfers WHERE recipient_id = ${userId}::uuid AND status = 'COMPLETED') AS gifts_received,
        (SELECT sum(usd_value) FROM chat.gift_transfers WHERE sender_id = ${userId}::uuid AND status = 'COMPLETED') AS gifts_sent_usd,
        (SELECT count(*)::int FROM chat.chat_ads WHERE creator_id = ${userId}::uuid) AS ads,
        (SELECT sum(price_usd) FROM chat.chat_ads WHERE creator_id = ${userId}::uuid) AS ads_usd
    `;
    return rows[0]!;
  }

  /** "Check Bot Log": what auto-moderation and the system did to a user (or everyone), newest first. */
  async botLog(userId: string | null, days: number, limit: number, cursor: Cursor | null) {
    const user = userId ? Prisma.sql`AND target_user_id = ${userId}::uuid` : Prisma.empty;
    const after = cursor
      ? Prisma.sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    return this.prisma.$queryRaw<
      {
        id: string;
        action: string;
        target_user_id: string | null;
        target_room_id: string | null;
        new_value: unknown;
        note: string | null;
        created_at: Date;
        created_at_text: string;
      }[]
    >`
      SELECT id, action, target_user_id, target_room_id, new_value, note, created_at,
             ${TIME_TEXT('created_at')} AS created_at_text
      FROM chat.moderation_actions
      WHERE actor_type = 'SYSTEM' AND created_at > now() - make_interval(days => ${days}::int) ${user} ${after}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
  }
}
