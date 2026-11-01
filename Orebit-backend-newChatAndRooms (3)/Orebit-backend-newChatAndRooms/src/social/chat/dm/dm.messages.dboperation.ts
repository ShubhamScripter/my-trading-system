// Database access for the messages of personal chat (Modules 8–9): sending (de-duplicated by client id), history,
// retract, hide, pin, read position, search, shared items, the group membership notice, and the archive of old months.
// The table is partitioned by month: a lookup by id alone probes each partition's key, so lists always go by
// conversation and keyset over (created_at, id) on the database's microsecond text. Messages are never deleted.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import { TIME_TEXT } from '../persistence/chat.sql';
import type { Cursor } from '../chat.utility';
import { DmDbOperation } from './dm.dboperation';
import { dmMemberCache } from './dm.member-cache';
import {
  DM_MESSAGE_SELECT,
  toDmMessage,
  type DmMessageRow,
  type DmMessageSql,
  type DmMessageType,
  type DmMetadata,
} from './dm.rows';
import type { DmFolder, MemberState } from './dm.rules';

@Injectable()
export class DmMessagesDbOperation {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: DmDbOperation,
  ) {}

  // How many messages `senderId` wrote in this conversation since the other side last wrote (all of them when the
// other side never did): the count a stranger or a merchant-app customer is capped on.
  async messagesSinceReply(conversationId: string, senderId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.dm_messages m
      WHERE m.conversation_id = ${conversationId}::uuid AND m.sender_id = ${senderId}::uuid AND m.type <> 'SYSTEM'
        AND m.created_at > COALESCE(
          (SELECT max(o.created_at) FROM chat.dm_messages o
           WHERE o.conversation_id = ${conversationId}::uuid AND o.sender_id <> ${senderId}::uuid AND o.type <> 'SYSTEM'),
          '-infinity'::timestamptz)
    `;
    return rows[0]?.n ?? 0;
  }

  // Records a join or a leave as a notice line. When the newest message of the group is a notice of the last
// `windowSeconds`, its counts grow instead of a new line being added: twenty people joining is one line.
// One lock per group keeps two parallel joins from making two lines. `updated` says which happened.
  async addMembershipNotice(
    conversationId: string,
    actorId: string,
    kind: 'joined' | 'left',
    windowSeconds: number,
  ): Promise<{ row: DmMessageRow; updated: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dm_notice:${conversationId}`}, 0))`;
      const latest = await tx.$queryRaw<{ id: string; metadata: DmMetadata; fresh: boolean }[]>`
        SELECT id, metadata,
               (type = 'SYSTEM' AND metadata #>> '{event,kind}' = 'membership'
                AND created_at > now() - make_interval(secs => ${windowSeconds}::int)) AS fresh
        FROM chat.dm_messages WHERE conversation_id = ${conversationId}::uuid
        ORDER BY created_at DESC, id DESC LIMIT 1
      `;
      const last = latest[0];
      if (last?.fresh) {
        const event = last.metadata.event ?? { kind: 'membership' };
        const next: DmMetadata = {
          ...last.metadata,
          event: {
            ...event,
            kind: 'membership',
            joined: (event.joined ?? 0) + (kind === 'joined' ? 1 : 0),
            left: (event.left ?? 0) + (kind === 'left' ? 1 : 0),
          },
        };
        await tx.$executeRaw`
          UPDATE chat.dm_messages SET metadata = ${JSON.stringify(next)}::jsonb
          WHERE id = ${last.id}::uuid
        `;
        return { id: last.id, updated: true };
      }
      const id = uuidv7();
      const metadata: DmMetadata = {
        event: { kind: 'membership', actorId, joined: kind === 'joined' ? 1 : 0, left: kind === 'left' ? 1 : 0 },
      };
      await tx.$executeRaw`
        INSERT INTO chat.dm_messages (id, conversation_id, sender_id, content, type, metadata)
        VALUES (${id}::uuid, ${conversationId}::uuid, ${actorId}::uuid, '', 'SYSTEM', ${JSON.stringify(metadata)}::jsonb)
      `;
      return { id, updated: false };
    });
    return { row: (await this.messageById(result.id))!, updated: result.updated };
  }

  // Messages
  // One insert, the conversation's activity time (not for SYSTEM lines such as 'X joined': they are not activity,
// ), idempotent by the sender's client id within the conversation.
// `memberUpdate` is written in the same transaction: a reply that accepts a message request or reopens a declined
// chat either stores the message AND changes the state, or neither.
  async insertMessage(data: {
    conversationId: string;
    senderId: string;
    content: string;
    type: DmMessageType;
    metadata: DmMetadata;
    clientMessageId?: string;
    memberUpdate?: { userId: string; state: MemberState; folder: DmFolder };
  }): Promise<{ row: DmMessageRow; duplicate: boolean }> {
    const id = uuidv7();
    // The dedupe row and the message are one transaction. The primary key of dm_message_dedupe (conversation, sender,
    // client id) decides a retry race: the second request waits for the first to commit, then reads its message id.
    const duplicateOf = await this.prisma.$transaction(async (tx) => {
      if (data.clientMessageId) {
        const claimed = await tx.$executeRaw`
          INSERT INTO chat.dm_message_dedupe (conversation_id, sender_id, client_message_id, message_id)
          VALUES (${data.conversationId}::uuid, ${data.senderId}::uuid, ${data.clientMessageId}::uuid, ${id}::uuid)
          ON CONFLICT DO NOTHING
        `;
        if (claimed === 0) {
          const rows = await tx.$queryRaw<{ message_id: string }[]>`
            SELECT message_id FROM chat.dm_message_dedupe
            WHERE conversation_id = ${data.conversationId}::uuid AND sender_id = ${data.senderId}::uuid
              AND client_message_id = ${data.clientMessageId}::uuid
          `;
          if (rows[0]) return rows[0].message_id;
        }
      }
      await tx.$executeRaw`
        INSERT INTO chat.dm_messages (id, conversation_id, sender_id, content, type, metadata, client_message_id)
        VALUES (${id}::uuid, ${data.conversationId}::uuid, ${data.senderId}::uuid, ${data.content}, ${data.type},
                ${JSON.stringify(data.metadata)}::jsonb, ${data.clientMessageId ?? null}::uuid)
      `;
      if (data.type !== 'SYSTEM') {
        await tx.$executeRaw`
          UPDATE chat.dm_conversations SET last_message_at = now() WHERE id = ${data.conversationId}::uuid
        `;
      }
      if (data.memberUpdate) {
        await this.members.updateMember(
          data.conversationId,
          data.memberUpdate.userId,
          { state: data.memberUpdate.state, folder: data.memberUpdate.folder },
          tx,
        );
      }
      return null;
    });
    if (duplicateOf) {
      const existing = await this.messageById(duplicateOf);
      if (existing) return { row: existing, duplicate: true };
    }
    // The member row changed inside the transaction: drop the copy again now that it is committed.
    if (data.memberUpdate) dmMemberCache.invalidate(data.conversationId);
    return { row: (await this.messageById(id))!, duplicate: false };
  }

  // Deletes send-retry ids older than the retention, 1,000 at a time (the messages themselves are never touched).
  async pruneClientIds(retentionHours: number): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM chat.dm_message_dedupe
      WHERE ctid IN (
        SELECT ctid FROM chat.dm_message_dedupe
        WHERE created_at < now() - make_interval(hours => ${retentionHours}::int)
        LIMIT 1000
      )
    `;
  }

  // Detaches whole months older than `keepMonths` into chat_archive (nothing is deleted); how many moved.
  async archiveOldMonths(keepMonths: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT chat.archive_old_dm_partitions(${keepMonths}::int) AS n
    `;
    this.archiveCut = undefined;
    return rows[0]?.n ?? 0;
  }

  private archiveCut: { at: number; value: string | null } | undefined;

  // Where the live DM messages start: null when nothing was archived. Older messages are in chat_archive, so a history
// page that reaches this time tells the client "older messages are archived". Kept a minute (a steady-clock timer).
  async archivedBefore(): Promise<string | null> {
    if (this.archiveCut && performance.now() - this.archiveCut.at < 60_000) return this.archiveCut.value;
    const rows = await this.prisma.$queryRaw<{ cut: string | null }[]>`
      SELECT ${TIME_TEXT('dm_messages_archived_before')} AS cut FROM chat.archive_state LIMIT 1
    `;
    const value = rows[0]?.cut ?? null;
    this.archiveCut = { at: performance.now(), value };
    return value;
  }

  async messageById(id: string): Promise<DmMessageRow | null> {
    const rows = await this.prisma.$queryRaw<
      DmMessageSql[]
    >`${DM_MESSAGE_SELECT} WHERE m.id = ${id}::uuid`;
    return rows[0] ? toDmMessage(rows[0]) : null;
  }

  // Newest first, `limit + 1` rows; `since` limits it to messages after the member joined.
  async history(
    conversationId: string,
    limit: number,
    cursor: Cursor | null,
    since: Date | null,
  ): Promise<DmMessageRow[]> {
    const after = cursor
      ? Prisma.sql`AND (m.created_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const from = since ? Prisma.sql`AND m.created_at >= ${since}::timestamptz` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<DmMessageSql[]>`
      ${DM_MESSAGE_SELECT} WHERE m.conversation_id = ${conversationId}::uuid ${after} ${from}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1}
    `;
    return rows.map(toDmMessage);
  }

  async retract(id: string, by: string): Promise<DmMessageRow | null> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.dm_messages SET retracted_at = now(), retracted_by = ${by}::uuid
      WHERE id = ${id}::uuid AND retracted_at IS NULL
    `;
    return changed > 0 ? this.messageById(id) : null;
  }

  // A group admin's "Delete Messages (only deleted on user end)": hidden from members, kept for admins.
  async hide(id: string, by: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.dm_messages SET hidden_at = now(), hidden_by = ${by}::uuid WHERE id = ${id}::uuid AND hidden_at IS NULL
    `;
    return changed > 0;
  }

  async setPinned(id: string, by: string | null): Promise<boolean> {
    const changed = by
      ? await this.prisma.$executeRaw`
          UPDATE chat.dm_messages SET pinned_at = now(), pinned_by = ${by}::uuid WHERE id = ${id}::uuid AND pinned_at IS NULL`
      : await this.prisma.$executeRaw`
          UPDATE chat.dm_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ${id}::uuid AND pinned_at IS NOT NULL`;
    return changed > 0;
  }

  async pinnedMessages(conversationId: string): Promise<DmMessageRow[]> {
    const rows = await this.prisma.$queryRaw<DmMessageSql[]>`
      ${DM_MESSAGE_SELECT} WHERE m.conversation_id = ${conversationId}::uuid AND m.pinned_at IS NOT NULL
        AND m.hidden_at IS NULL AND m.retracted_at IS NULL
      ORDER BY m.pinned_at DESC LIMIT 100
    `;
    return rows.map(toDmMessage);
  }

  // Moves the read position forward only.
  async markRead(conversationId: string, userId: string, messageId: string): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<{ last_read_at: Date }[]>`
      UPDATE chat.dm_members me SET last_read_message_id = m.id, last_read_at = m.created_at, updated_at = now()
      FROM chat.dm_messages m
      WHERE me.conversation_id = ${conversationId}::uuid AND me.user_id = ${userId}::uuid
        AND m.id = ${messageId}::uuid AND m.conversation_id = me.conversation_id
        AND (me.last_read_at IS NULL OR m.created_at > me.last_read_at)
      RETURNING me.last_read_at
    `;
    return rows[0]?.last_read_at ?? null;
  }

  // "Users can also search DMs for specific texts": the user's conversations, or one of them.
  async search(
    userId: string,
    text: string,
    conversationId: string | null,
    limit: number,
    cursor: Cursor | null,
  ): Promise<DmMessageRow[]> {
    const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const one = conversationId
      ? Prisma.sql`AND m.conversation_id = ${conversationId}::uuid`
      : Prisma.empty;
    const after = cursor
      ? Prisma.sql`AND (m.created_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<DmMessageSql[]>`
      ${DM_MESSAGE_SELECT}
      JOIN chat.dm_members me ON me.conversation_id = m.conversation_id AND me.user_id = ${userId}::uuid
      WHERE me.state IN ('ACTIVE', 'REQUEST') AND m.created_at >= me.joined_at
        AND m.retracted_at IS NULL AND m.hidden_at IS NULL AND m.type IN ('TEXT', 'MEDIA')
        AND m.content ILIKE ${pattern} ${one} ${after}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1}
    `;
    return rows.map(toDmMessage);
  }

  // "Info where they can see all the shared links and media (photos and videos)".
  async shared(
    conversationId: string,
    kind: 'media' | 'links',
    limit: number,
    cursor: Cursor | null,
    since: Date | null,
  ): Promise<DmMessageRow[]> {
    const what =
      kind === 'media'
        ? Prisma.sql`m.metadata ? 'media'`
        : Prisma.sql`jsonb_array_length(COALESCE(m.metadata->'links', '[]'::jsonb)) > 0`;
    const after = cursor
      ? Prisma.sql`AND (m.created_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const from = since ? Prisma.sql`AND m.created_at >= ${since}::timestamptz` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<DmMessageSql[]>`
      ${DM_MESSAGE_SELECT}
      WHERE m.conversation_id = ${conversationId}::uuid AND ${what}
        AND m.retracted_at IS NULL AND m.hidden_at IS NULL ${after} ${from}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1}
    `;
    return rows.map(toDmMessage);
  }
}
