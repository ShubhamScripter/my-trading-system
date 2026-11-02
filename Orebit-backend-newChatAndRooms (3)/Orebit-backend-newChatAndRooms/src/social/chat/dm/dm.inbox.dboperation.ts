// Database access for the personal-chat inbox (Modules 8–9): one folder's conversations with their last message,
// unread counts and the other member or the group, the unread badges, the privacy and notification preferences, and
// the groups two users share.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import { TIME_TEXT } from '../persistence/chat.sql';
import type { Cursor } from '../chat.utility';
import { toDmMessage, type DmMessageRow, type DmMessageSql } from './dm.dboperation';
import type { DmFolder, MemberState } from './dm.rules';

export interface ConversationListRow {
  readonly conversationId: string;
  readonly kind: 'DIRECT' | 'GROUP';
  readonly folder: DmFolder;
  readonly state: MemberState;
  readonly pinnedAt: Date | null;
  readonly nickname: string | null;
  readonly notifications: 'DEFAULT' | 'ON' | 'OFF';
  readonly sortAt: Date;
  readonly sortAtText: string;
  readonly unread: number;
  readonly otherUserId: string | null;
  readonly otherUsername: string | null;
  readonly otherLastReadMessageId: string | null;
  readonly groupName: string | null;
  readonly groupLogoUrl: string | null;
  readonly groupVisibility: string | null;
  readonly memberCount: number | null;
  // The merchant app of a chat with a site owner ("sorted separately by apps").
  readonly merchantAppId: string | null;
  readonly lastMessage: DmMessageRow | null;
}

// Preferences that personal chat reads (privacy and notifications), NULL = the admin default.
export interface StoredPrefs {
  lastSeenVisibility: string | null;
  commonGroupsVisibility: string | null;
  notifyPrimary: boolean | null;
  notifyGeneral: boolean | null;
  notifyGroups: boolean | null;
  quietMode: string | null;
  quietStart: string | null;
  quietEnd: string | null;
  lastSeenAt: Date | null;
  // The one switch for "typing..." and read receipts, both directions.
  typingReceiptsEnabled: boolean;
}

const NO_PREFS: StoredPrefs = {
  lastSeenVisibility: null,
  commonGroupsVisibility: null,
  notifyPrimary: null,
  notifyGeneral: null,
  notifyGroups: null,
  quietMode: null,
  quietStart: null,
  quietEnd: null,
  lastSeenAt: null,
  typingReceiptsEnabled: true,
};

// A message counts as unread for a member when somebody else wrote it, it is not a SYSTEM line ('X joined' is not a
// message), it is not hidden, it came after the member joined and after their read position. Own messages never count
// . Aliases: `me` = chat.dm_members, `c` = chat.dm_conversations.
const UNREAD_EXISTS = Prisma.sql`EXISTS (
  SELECT 1 FROM chat.dm_messages x
  WHERE (me.last_read_at IS NULL OR c.last_message_at > me.last_read_at)
    AND x.conversation_id = c.id AND x.sender_id <> me.user_id AND x.type <> 'SYSTEM' AND x.hidden_at IS NULL
    AND x.created_at >= me.joined_at AND (me.last_read_at IS NULL OR x.created_at > me.last_read_at))`;

@Injectable()
export class DmInboxDbOperation {
  private static readonly PREFS_CACHE_MS = 5 * 60_000;
  private readonly switches = new Map<string, { on: boolean; at: number }>();
  private readonly prefsCache = new Map<string, { value: StoredPrefs; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  // One folder of the inbox, newest activity first. REQUESTS lists pending message requests; CHANNELS the public
// groups among GROUPS ("Channels: All Public Groups"). Unread counts stop at 100. Pinned ones only with pinnedOnly.
  async conversations(
    userId: string,
    folder: DmFolder | 'REQUESTS' | 'CHANNELS',
    limit: number,
    cursor: Cursor | null,
    pinnedOnly = false,
    appId: string | null = null,
  ): Promise<ConversationListRow[]> {
    const where =
      folder === 'REQUESTS'
        ? Prisma.sql`me.state = 'REQUEST'`
        : folder === 'CHANNELS'
          ? Prisma.sql`me.state = 'ACTIVE' AND me.folder = 'GROUPS' AND g.visibility = 'PUBLIC'`
          : Prisma.sql`me.state = 'ACTIVE' AND me.folder = ${folder}`;
    const pinned = pinnedOnly
      ? Prisma.sql`AND me.pinned_at IS NOT NULL`
      : folder === 'REQUESTS'
        ? Prisma.empty
        : Prisma.sql`AND me.pinned_at IS NULL`;
    const after = cursor
      ? Prisma.sql`AND (COALESCE(c.last_message_at, c.created_at), c.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const appFilter = appId !== null ? Prisma.sql`AND c.merchant_app_id = ${appId}` : Prisma.empty;
    // Step 1 (cheap): only the ids of this page, sorted. The unread counts and the last messages below are worked out
    // for these rows alone, never for every conversation of the folder.
    const ids = (
      await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT c.id FROM chat.dm_members me
        JOIN chat.dm_conversations c ON c.id = me.conversation_id
        LEFT JOIN chat.dm_groups g ON g.conversation_id = c.id
        WHERE me.user_id = ${userId}::uuid AND ${where} ${pinned} ${after} ${appFilter}
        ORDER BY ${pinnedOnly ? Prisma.sql`me.pinned_at DESC,` : Prisma.empty} COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
        LIMIT ${limit + 1}
      `
    ).map((r) => r.id);
    if (ids.length === 0) return [];
    // Step 2: the details of those rows.
    const unsorted = await this.prisma.$queryRaw<
      (Omit<DmMessageSql, 'id' | 'conversation_id'> & {
        conversation_id: string;
        kind: 'DIRECT' | 'GROUP';
        folder: DmFolder;
        state: MemberState;
        pinned_at_me: Date | null;
        nickname: string | null;
        notifications: 'DEFAULT' | 'ON' | 'OFF';
        sort_at: Date;
        sort_at_text: string;
        unread: number;
        other_user_id: string | null;
        other_username: string | null;
        other_last_read: string | null;
        group_name: string | null;
        group_logo: string | null;
        group_visibility: string | null;
        member_count: number | null;
        merchant_app_id: string | null;
        last_id: string | null;
      })[]
    >`
      SELECT c.id AS conversation_id, c.kind, c.merchant_app_id, me.folder, me.state, me.pinned_at AS pinned_at_me, me.nickname,
             me.notifications,
             COALESCE(c.last_message_at, c.created_at) AS sort_at,
             ${TIME_TEXT('COALESCE(c.last_message_at, c.created_at)')} AS sort_at_text,
             (SELECT count(*)::int FROM (
                SELECT 1 FROM chat.dm_messages x
                WHERE (me.last_read_at IS NULL OR c.last_message_at > me.last_read_at)
                  AND x.conversation_id = c.id AND x.sender_id <> me.user_id AND x.type <> 'SYSTEM'
                  AND x.hidden_at IS NULL AND x.created_at >= me.joined_at
                  AND (me.last_read_at IS NULL OR x.created_at > me.last_read_at)
                LIMIT 100) q) AS unread,
             other.user_id AS other_user_id, ou.username AS other_username,
             other.last_read_message_id AS other_last_read,
             g.name AS group_name, g.logo_url AS group_logo, g.visibility AS group_visibility,
             g.member_count AS member_count,
             lm.id AS last_id, lm.sender_id, lu.username AS sender_username, lm.content, lm.type, lm.metadata,
             lm.client_message_id, lm.created_at, ${TIME_TEXT('lm.created_at')} AS created_at_text,
             lm.retracted_at, lm.hidden_at, lm.pinned_at
      FROM chat.dm_members me
      JOIN chat.dm_conversations c ON c.id = me.conversation_id
      LEFT JOIN chat.dm_members other
             ON c.kind = 'DIRECT' AND other.conversation_id = c.id AND other.user_id <> me.user_id
      LEFT JOIN identity.users ou ON ou.id = other.user_id AND ou.deleted_at IS NULL
      LEFT JOIN chat.dm_groups g ON g.conversation_id = c.id
      LEFT JOIN LATERAL (
        SELECT * FROM chat.dm_messages lm0 WHERE lm0.conversation_id = c.id
        ORDER BY lm0.created_at DESC, lm0.id DESC LIMIT 1
      ) lm ON true
      LEFT JOIN identity.users lu ON lu.id = lm.sender_id AND lu.deleted_at IS NULL
      WHERE me.user_id = ${userId}::uuid AND c.id = ANY(${ids}::uuid[])
    `;
    const position = new Map(ids.map((id, index) => [id, index]));
    const rows = unsorted.sort((a, b) => (position.get(a.conversation_id) ?? 0) - (position.get(b.conversation_id) ?? 0));
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      kind: row.kind,
      folder: row.folder,
      state: row.state,
      pinnedAt: row.pinned_at_me,
      nickname: row.nickname,
      notifications: row.notifications,
      sortAt: row.sort_at,
      sortAtText: row.sort_at_text,
      unread: row.unread,
      otherUserId: row.other_user_id,
      otherUsername: row.other_username,
      otherLastReadMessageId: row.other_last_read,
      groupName: row.group_name,
      groupLogoUrl: row.group_logo,
      groupVisibility: row.group_visibility,
      memberCount: row.member_count,
      merchantAppId: row.merchant_app_id,
      lastMessage: row.last_id
        ? toDmMessage({
            id: row.last_id,
            conversation_id: row.conversation_id,
            sender_id: row.sender_id,
            sender_username: row.sender_username,
            content: row.content,
            type: row.type,
            metadata: row.metadata,
            client_message_id: row.client_message_id,
            created_at: row.created_at,
            created_at_text: row.created_at_text,
            retracted_at: row.retracted_at,
            hidden_at: row.hidden_at,
            pinned_at: row.pinned_at,
          })
        : null,
    }));
  }

  // Unread conversations per folder and pending requests, for badges; CHANNELS counts the public groups again.
  async unreadSummary(userId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.$queryRaw<{ bucket: string; n: number; channels: number }[]>`
      SELECT CASE WHEN me.state = 'REQUEST' THEN 'REQUESTS' ELSE me.folder END AS bucket, count(*)::int AS n,
             count(*) FILTER (WHERE me.state = 'ACTIVE' AND g.visibility = 'PUBLIC')::int AS channels
      FROM chat.dm_members me
      JOIN chat.dm_conversations c ON c.id = me.conversation_id
      LEFT JOIN chat.dm_groups g ON g.conversation_id = c.id
      WHERE me.user_id = ${userId}::uuid AND me.state IN ('ACTIVE', 'REQUEST')
        AND ${UNREAD_EXISTS}
      GROUP BY 1
    `;
    return {
      ...Object.fromEntries(rows.map((row) => [row.bucket, row.n])),
      CHANNELS: rows.reduce((sum, row) => sum + row.channels, 0),
    };
  }

  // The merchant folder per app: conversations and how many have unread messages (null app = opened without one).
  async merchantApps(userId: string): Promise<{ appId: string | null; conversations: number; unread: number }[]> {
    const rows = await this.prisma.$queryRaw<{ app_id: string | null; conversations: number; unread: number }[]>`
      SELECT c.merchant_app_id AS app_id, count(*)::int AS conversations,
             count(*) FILTER (WHERE ${UNREAD_EXISTS})::int AS unread
      FROM chat.dm_members me
      JOIN chat.dm_conversations c ON c.id = me.conversation_id
      WHERE me.user_id = ${userId}::uuid AND me.state = 'ACTIVE' AND me.folder = 'MERCHANT'
      GROUP BY c.merchant_app_id
      ORDER BY c.merchant_app_id NULLS LAST
    `;
    return rows.map((row) => ({ appId: row.app_id, conversations: row.conversations, unread: row.unread }));
  }

  // Preferences
  async prefs(userIds: readonly string[]): Promise<Map<string, StoredPrefs>> {
    const now = Date.now();
    const out = new Map<string, StoredPrefs>();
    const missing: string[] = [];
    for (const id of userIds) {
      const hit = this.prefsCache.get(id);
      if (hit && now - hit.at < DmInboxDbOperation.PREFS_CACHE_MS) out.set(id, hit.value);
      else missing.push(id);
    }
    if (missing.length === 0) return out;
    const rows = await this.prisma.userChatPreference.findMany({
      where: { userId: { in: missing } },
      select: {
        userId: true,
        lastSeenVisibility: true,
        commonGroupsVisibility: true,
        notifyPrimary: true,
        notifyGeneral: true,
        notifyGroups: true,
        quietMode: true,
        quietStart: true,
        quietEnd: true,
        lastSeenAt: true,
        typingReceiptsEnabled: true,
      },
    });
    const found = new Map(rows.map(({ userId, ...rest }) => [userId, rest]));
    for (const id of missing) {
      const value = found.get(id) ?? NO_PREFS;
      out.set(id, value);
      this.prefsCache.set(id, { value, at: now });
    }
    if (this.prefsCache.size > 50_000) this.prefsCache.clear();
    return out;
  }

  // Who has "typing..." and read receipts on. A typing signal asks this for every member, so the answer is
// kept for a few seconds and dropped when the user changes the switch.
  async receiptSwitches(userIds: readonly string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const missing: string[] = [];
    for (const id of userIds) {
      const hit = this.switches.get(id);
      if (hit !== undefined && performance.now() - hit.at < 5_000) out.set(id, hit.on);
      else missing.push(id);
    }
    if (missing.length > 0) {
      const rows = await this.prisma.userChatPreference.findMany({
        where: { userId: { in: missing } },
        select: { userId: true, typingReceiptsEnabled: true },
      });
      const off = new Map(rows.map((r) => [r.userId, r.typingReceiptsEnabled]));
      for (const id of missing) {
        const on = off.get(id) ?? true;
        out.set(id, on);
        this.switches.set(id, { on, at: performance.now() });
      }
    }
    return out;
  }

  async savePrefs(userId: string, data: Partial<Omit<StoredPrefs, 'lastSeenAt'>>): Promise<void> {
    this.prefsCache.delete(userId);
    this.switches.delete(userId);
    await this.prisma.userChatPreference.upsert({
      where: { userId },
      update: data,
      create: { id: uuidv7(), userId, ...data },
    });
  }

  // Groups in common
  async commonGroups(
    a: string,
    b: string,
  ): Promise<{ id: string; name: string; logoUrl: string | null }[]> {
    return this.prisma.$queryRaw<{ id: string; name: string; logoUrl: string | null }[]>`
      SELECT g.conversation_id AS id, g.name, g.logo_url AS "logoUrl"
      FROM chat.dm_groups g
      JOIN chat.dm_members ma ON ma.conversation_id = g.conversation_id AND ma.user_id = ${a}::uuid AND ma.state = 'ACTIVE'
      JOIN chat.dm_members mb ON mb.conversation_id = g.conversation_id AND mb.user_id = ${b}::uuid AND mb.state = 'ACTIVE'
      ORDER BY g.name LIMIT 200
    `;
  }
}
