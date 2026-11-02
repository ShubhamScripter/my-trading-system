/**
 * Database access for the admin oversight of direct messages and groups (Modules 8 and 9).
 */
import { Prisma } from '@prisma/client';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import type { PrismaService } from '../../../../db/client';

export const iso = (value: Date | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

/** A cursor over (time, id), as text: the time keeps its microseconds, so no row is skipped or repeated at a page edge. */
export const encodeCursor = (time: string, id: string): string => Buffer.from(`${time}|${id}`).toString('base64url');

export function decodeCursor(cursor: string | null): { time: string; id: string } | null {
  if (!cursor) return null;
  const invalid = (): never => { throw new ProblemException({ type: ERR.VALIDATION_FAILED, detail: 'Invalid cursor' }); };
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalid();
  let decoded: string;
  try { decoded = Buffer.from(cursor, 'base64url').toString('utf8'); } catch { return invalid(); }
  const [time, id, ...extra] = decoded.split('|');
  if (!time || !id || extra.length || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || Number.isNaN(Date.parse(time))) return invalid();
  if (Buffer.from(decoded).toString('base64url') !== cursor) return invalid();
  return { time, id };
}

export const TEXT_TIME = (column: string): Prisma.Sql =>
  Prisma.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

// Fetches paginated user conversations by activity keyset cursor.
export async function queryConversationsOf(prisma: PrismaService, userId: string, limit: number, cursor: string | null) {
  const at = decodeCursor(cursor);
  const after = at
    ? Prisma.sql`AND (COALESCE(c.last_message_at, c.created_at), c.id) < (${at.time}::timestamptz, ${at.id}::uuid)`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<
    {
      id: string;
      kind: string;
      group_name: string | null;
      state: string;
      folder: string;
      members: string[];
      member_count: number | null;
      last_message_at: Date | null;
      sort_text: string;
    }[]
  >`
    SELECT c.id, c.kind, g.name AS group_name, me.state, me.folder,
           ARRAY(SELECT u.username FROM chat.dm_members m JOIN identity.users u ON u.id = m.user_id
                 WHERE m.conversation_id = c.id ORDER BY u.username LIMIT 50) AS members,
           g.member_count, c.last_message_at,
           ${TEXT_TIME('COALESCE(c.last_message_at, c.created_at)')} AS sort_text
    FROM chat.dm_members me
    JOIN chat.dm_conversations c ON c.id = me.conversation_id
    LEFT JOIN chat.dm_groups g ON g.conversation_id = c.id
    WHERE me.user_id = ${userId}::uuid ${after}
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page.at(-1) : undefined;
  return {
    items: page.map((r) => ({
      id: r.id,
      kind: r.kind,
      groupName: r.group_name,
      state: r.state,
      folder: r.folder,
      members: r.members,
      memberCount: r.member_count,
      lastMessageAt: iso(r.last_message_at),
    })),
    nextCursor: last ? encodeCursor(last.sort_text, last.id) : null,
  };
}

export async function queryConversationExists(prisma: PrismaService, id: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM chat.dm_conversations WHERE id = ${id}::uuid
  `;
  return (rows[0]?.n ?? 0) > 0;
}

/** Who is in a conversation (up to 50 ids), for the audit row of a read. */
export async function queryMemberIds(prisma: PrismaService, id: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM chat.dm_members WHERE conversation_id = ${id}::uuid ORDER BY joined_at, user_id LIMIT 50
  `;
  return rows.map((r) => r.user_id);
}

/** Every message, retracted and hidden ones included and tagged as such; keyset over (created_at, id). */
export async function queryConversationMessages(prisma: PrismaService, id: string, limit: number, cursor: string | null) {
  const at = decodeCursor(cursor);
  const after = at
    ? Prisma.sql`AND (m.created_at, m.id) < (${at.time}::timestamptz, ${at.id}::uuid)`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<
    {
      id: string;
      sender_id: string;
      sender: string | null;
      content: string;
      type: string;
      metadata: unknown;
      created_at: Date;
      created_text: string;
      retracted_at: Date | null;
      hidden_at: Date | null;
      pinned_at: Date | null;
    }[]
  >`
    SELECT m.id, m.sender_id, u.username AS sender, m.content, m.type, m.metadata, m.created_at,
           ${TEXT_TIME('m.created_at')} AS created_text, m.retracted_at, m.hidden_at, m.pinned_at
    FROM chat.dm_messages m LEFT JOIN identity.users u ON u.id = m.sender_id
    WHERE m.conversation_id = ${id}::uuid ${after}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page.at(-1) : undefined;
  return {
    items: page.map((m) => ({
      id: m.id,
      senderId: m.sender_id,
      sender: m.sender,
      content: m.content,
      type: m.type,
      metadata: m.metadata,
      createdAt: iso(m.created_at),
      retractedAt: iso(m.retracted_at),
      hiddenAt: iso(m.hidden_at),
      pinnedAt: iso(m.pinned_at),
    })),
    nextCursor: last ? encodeCursor(last.created_text, last.id) : null,
  };
}

/** Groups, newest first, one page at a time; the member count is the group's own counter (no count over members). */
export async function queryGroups(prisma: PrismaService, search: string | null, limit: number, cursor: string | null) {
  const like = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const filter = like ? Prisma.sql`AND g.name ILIKE ${like}` : Prisma.empty;
  const at = decodeCursor(cursor);
  const after = at
    ? Prisma.sql`AND (g.created_at, g.conversation_id) < (${at.time}::timestamptz, ${at.id}::uuid)`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<
    {
      id: string;
      name: string;
      visibility: string;
      is_channel: boolean;
      owner: string | null;
      creator: string | null;
      members: number;
      members_can_text: boolean;
      closed_at: Date | null;
      created_at: Date;
      created_text: string;
    }[]
  >`
    SELECT g.conversation_id AS id, g.name, g.visibility, g.is_channel, o.username AS owner, c.username AS creator,
           g.member_count AS members, g.members_can_text, g.closed_at, g.created_at,
           ${TEXT_TIME('g.created_at')} AS created_text
    FROM chat.dm_groups g
    LEFT JOIN identity.users o ON o.id = g.owner_id
    LEFT JOIN identity.users c ON c.id = g.creator_id
    WHERE true ${filter} ${after}
    ORDER BY g.created_at DESC, g.conversation_id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page.at(-1) : undefined;
  return {
    items: page.map((g) => ({
      id: g.id,
      name: g.name,
      visibility: g.visibility,
      isChannel: g.is_channel,
      owner: g.owner,
      creator: g.creator,
      members: g.members,
      membersCanText: g.members_can_text,
      isClosed: g.closed_at !== null,
      createdAt: iso(g.created_at),
    })),
    nextCursor: last ? encodeCursor(last.created_text, last.id) : null,
  };
}

