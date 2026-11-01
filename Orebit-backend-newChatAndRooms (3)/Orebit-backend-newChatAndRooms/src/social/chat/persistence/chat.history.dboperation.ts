// Database access for reading message lists: room history, pinned messages and the tag feed.
// Pages use an exact keyset on the database's microsecond text, never a JavaScript Date, so rows that share a
// timestamp are neither skipped nor repeated. Split from chat.dboperation.ts to keep files short.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { MESSAGE_SELECT, TIME_TEXT, toMessageRow, type MessageSqlRow } from './chat.sql';
import type { MessageRow } from '../chat.types';
import type { Cursor } from '../chat.utility';

// Leaves out the user messages (TEXT, MEDIA, GIFT) of authors the reader muted or blocked; ads and alerts stay
// ("Ads won't be hidden even if the advertiser is blocked / muted").
function withoutHidden(hidden: readonly string[]): Prisma.Sql {
  return hidden.length === 0
    ? Prisma.empty
    : Prisma.sql`AND NOT (m.user_id = ANY(${[...hidden]}::uuid[]) AND m.type IN ('TEXT', 'MEDIA', 'GIFT'))`;
}

// An ad its advertiser hid from the viewer's country is not part of that viewer's history either: the live
// channel and every read apply the same rule. A viewer with no known country sees every ad.
function notHiddenIn(country: string | null): Prisma.Sql {
  return country === null
    ? Prisma.empty
    : Prisma.sql`AND NOT (m.type = 'AD' AND m.metadata->'ad'->'hiddenCountries' @> jsonb_build_array(${country}::text))`;
}

@Injectable()
export class ChatHistoryDbOperation {
  constructor(private readonly prisma: PrismaService) { }

  // One history page, newest first, by an exact keyset on (created_at, id) that never skips rows sharing a
  // timestamp, using the (room_id, created_at DESC, id DESC) index. Fetches `limit + 1`.
  // `onlyAlerts` serves promo-only viewers, who receive no user messages.
  async history(
    roomId: string,
    limit: number,
    cursor: Cursor | null,
    onlyAlerts: boolean,
    hidden: readonly string[] = [],
    country: string | null = null,
  ): Promise<MessageRow[]> {
    const after = cursor
      ? Prisma.sql`AND (m.created_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const alerts = onlyAlerts
      ? Prisma.sql`AND m.type IN ('SYSTEM_ALERT', 'ADMIN_ALERT', 'AD')`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<MessageSqlRow[]>`
      ${MESSAGE_SELECT}
      WHERE m.room_id = ${roomId}::uuid ${after} ${alerts} ${withoutHidden(hidden)} ${notHiddenIn(country)}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit + 1}
    `;
    return rows.map(toMessageRow);
  }

  // Messages after `afterId` for a reconnecting client: up to `limit + 1`, oldest first, strictly after
  // the anchor (created_at, id) key so catch-up never loops or skips in busy rooms (FR-008).
  async historyAfter(
    roomId: string,
    afterId: string,
    overlapMs: number,
    limit: number,
    onlyAlerts: boolean,
    hidden: readonly string[] = [],
    country: string | null = null,
  ): Promise<MessageRow[] | null> {
    const anchor = await this.prisma.$queryRaw<{ created_at: Date }[]>`
      SELECT created_at FROM chat.room_messages WHERE id = ${afterId}::uuid AND room_id = ${roomId}::uuid LIMIT 1
    `;
    if (!anchor[0]) return null;
    const alerts = onlyAlerts
      ? Prisma.sql`AND m.type IN ('SYSTEM_ALERT', 'ADMIN_ALERT', 'AD')`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<MessageSqlRow[]>`
      ${MESSAGE_SELECT}
      WHERE m.room_id = ${roomId}::uuid
        AND (m.created_at, m.id) > (${anchor[0].created_at}::timestamptz, ${afterId}::uuid)
        ${alerts} ${withoutHidden(hidden)} ${notHiddenIn(country)}
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT ${limit + 1}
    `;
    return rows.map(toMessageRow);
  }

  async pinned(
    roomId: string,
    limit: number,
    cursor: Cursor | null,
    onlyAlerts: boolean,
    country: string | null = null,
  ): Promise<(MessageRow & { pinnedAtText: string })[]> {
    const after = cursor
      ? Prisma.sql`AND (m.pinned_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const alerts = onlyAlerts
      ? Prisma.sql`AND m.type IN ('SYSTEM_ALERT', 'ADMIN_ALERT', 'AD')`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<(MessageSqlRow & { pinned_at_text: string })[]>`
      SELECT q.*, ${TIME_TEXT('q.pinned_at')} AS pinned_at_text
      FROM (
        ${MESSAGE_SELECT}
        WHERE m.room_id = ${roomId}::uuid AND m.pinned_at IS NOT NULL ${after} ${alerts} ${notHiddenIn(country)}
      ) q
      ORDER BY q.pinned_at DESC, q.id DESC
      LIMIT ${limit + 1}
    `;
    return rows.map((row) => ({ ...toMessageRow(row), pinnedAtText: row.pinned_at_text }));
  }

  // The tag feed of one user from the mentions table: a keyset over (created_at, message_id), never a scan
  // of the messages table. Returns the scanned mention keys too, so the next cursor comes from the last SCANNED row
  // even when rows are filtered out for access.
  async tagFeed(
    userId: string,
    limit: number,
    cursor: Cursor | null,
  ): Promise<{ rows: MessageRow[]; scanned: { createdAtText: string; messageId: string }[] }> {
    const after = cursor
      ? Prisma.sql`AND (mm.created_at, mm.message_id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const keys = await this.prisma.$queryRaw<
      { message_id: string; created_at: Date; created_at_text: string }[]
    >`
      SELECT mm.message_id, mm.created_at, ${TIME_TEXT('mm.created_at')} AS created_at_text
      FROM chat.message_mentions mm
      WHERE mm.mentioned_user_id = ${userId}::uuid ${after}
      ORDER BY mm.created_at DESC, mm.message_id DESC
      LIMIT ${limit + 1}
    `;
    if (keys.length === 0) return { rows: [], scanned: [] };
    const rows = await this.prisma.$queryRaw<MessageSqlRow[]>`
      ${MESSAGE_SELECT}
      JOIN unnest(${keys.map((k) => k.message_id)}::uuid[], ${keys.map((k) => k.created_at_text)}::timestamptz[])
        AS k(id, created_at) ON k.id = m.id AND k.created_at = m.created_at
      ORDER BY m.created_at DESC, m.id DESC
    `;
    return {
      rows: rows.map(toMessageRow),
      scanned: keys.map((k) => ({ createdAtText: k.created_at_text, messageId: k.message_id })),
    };
  }
}
