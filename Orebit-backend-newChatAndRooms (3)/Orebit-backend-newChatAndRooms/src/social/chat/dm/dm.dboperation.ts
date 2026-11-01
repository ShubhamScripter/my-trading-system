// Database access for personal chat (Modules 8–9): conversations and members, and the member cache they keep exact.
// Messages are in dm.messages.dboperation.ts; the rows and their SQL in dm.rows.ts; the inbox lists and the privacy
// preferences in dm.inbox.dboperation.ts; group-only tables (the group, invites, bans, ownership transfers) in
// dm.groups.dboperation.ts.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import { TIME_TEXT, isUniqueViolation, type Db } from '../persistence/chat.sql';
import { dmMemberCache } from './dm.member-cache';
import { MEMBER_SELECT, toMember, type MemberRow, type MemberSql } from './dm.rows';
import type { DmFolder, GroupRole, MemberState } from './dm.rules';

// The rows are defined in dm.rows.ts; importers keep using this module.
export * from './dm.rows';

@Injectable()
export class DmDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async dbNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]!.now;
  }

  // Conversations and members
  async findDirect(key: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM chat.dm_conversations WHERE direct_key = ${key}
    `;
    return rows[0]?.id ?? null;
  }

  // Creates a direct conversation between two users with concurrency locking and new-DM rate limit checks.
  async createDirect(data: {
    key: string;
    createdBy: string;
    members: { userId: string; folder: DmFolder; state: MemberState }[];
    // The merchant app this chat with a site owner was opened from.
    merchantAppId?: string | null;
    // The limit of the kind of new DM this is: the other person follows the starter, or does not.
    limit?: { count: number; hours: number; withFollower: boolean };
  }): Promise<{ id: string; created: boolean } | { limited: { retryAfterSeconds: number } }> {
    const id = uuidv7();
    try {
      const limited = await this.prisma.$transaction(async (tx) => {
        if (data.limit) {
          const { count, hours, withFollower } = data.limit;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'dm_new:' + data.createdBy}, 0))`;
          const counted = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM chat.dm_conversations
            WHERE created_by = ${data.createdBy}::uuid AND kind = 'DIRECT' AND started_with_follower = ${withFollower}
              AND created_at > now() - make_interval(hours => ${hours}::int)
          `;
          const n = counted[0]?.n ?? 0;
          if (n >= count) {
            // The conversation whose leaving the window frees a place is the (n - count + 1)th oldest.
            const wait = await tx.$queryRaw<{ seconds: number }[]>`
              SELECT GREATEST(1, ceil(extract(epoch FROM (created_at + make_interval(hours => ${hours}::int) - now()))))::int AS seconds
              FROM chat.dm_conversations
              WHERE created_by = ${data.createdBy}::uuid AND kind = 'DIRECT' AND started_with_follower = ${withFollower}
                AND created_at > now() - make_interval(hours => ${hours}::int)
              ORDER BY created_at ASC OFFSET ${n - count} LIMIT 1
            `;
            return { retryAfterSeconds: wait[0]?.seconds ?? 1 };
          }
        }
        await tx.$executeRaw`
          INSERT INTO chat.dm_conversations (id, kind, direct_key, created_by, merchant_app_id, started_with_follower)
          VALUES (${id}::uuid, 'DIRECT', ${data.key}, ${data.createdBy}::uuid, ${data.merchantAppId ?? null},
                  ${data.limit?.withFollower ?? null})
        `;
        for (const member of data.members) {
          await this.insertMember(
            id,
            member.userId,
            { folder: member.folder, state: member.state },
            tx,
          );
        }
        return null;
      });
      if (limited) return { limited };
      return { id, created: true };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        const existing = await this.findDirect(data.key);
        if (existing) return { id: existing, created: false };
      }
      throw err;
    }
  }

  // Who started the conversation (the folder rules depend on who wrote first).
  async conversationCreator(conversationId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ created_by: string | null }[]>`
      SELECT created_by FROM chat.dm_conversations WHERE id = ${conversationId}::uuid
    `;
    return rows[0]?.created_by ?? null;
  }

  // Conversations of either kind this user started in the last `hours` (the new-DM limit counts DIRECT ones).
  async newDirectCount(userId: string, hours: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.dm_conversations
      WHERE created_by = ${userId}::uuid AND kind = 'DIRECT' AND created_at > now() - make_interval(hours => ${hours}::int)
    `;
    return rows[0]?.n ?? 0;
  }

  async insertMember(
    conversationId: string,
    userId: string,
    data: { folder: DmFolder; state: MemberState; role?: GroupRole },
    db: Db = this.prisma,
  ): Promise<void> {
    // A timeout still running when the member leaves and comes back stays: leaving is not a way out of it.
    await db.$executeRaw`
      INSERT INTO chat.dm_members (conversation_id, user_id, role, state, folder)
      VALUES (${conversationId}::uuid, ${userId}::uuid, ${data.role ?? 'MEMBER'}, ${data.state}, ${data.folder})
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET
        role = EXCLUDED.role, state = EXCLUDED.state, folder = EXCLUDED.folder, joined_at = now(),
        updated_at = now(),
        timeout_until = CASE WHEN chat.dm_members.timeout_until > now() THEN chat.dm_members.timeout_until ELSE NULL END
    `;
    dmMemberCache.invalidate(conversationId);
  }

  async member(
    conversationId: string,
    userId: string,
    db: Db = this.prisma,
  ): Promise<MemberRow | null> {
    // Outside a transaction a fresh cached member list answers without a query.
    if (db === this.prisma) {
      const cached = dmMemberCache.get(conversationId);
      if (cached) return cached.find((m) => m.userId === userId) ?? null;
    }
    const rows = await db.$queryRaw<MemberSql[]>`
      ${MEMBER_SELECT} WHERE dm.conversation_id = ${conversationId}::uuid AND dm.user_id = ${userId}::uuid
    `;
    return rows[0] ? toMember(rows[0]) : null;
  }

  // Members in the given states (all states when empty), oldest first.
  async members(conversationId: string, states: readonly MemberState[] = []): Promise<MemberRow[]> {
    let all = dmMemberCache.get(conversationId);
    if (!all) {
      const rows = await this.prisma.$queryRaw<MemberSql[]>`
        ${MEMBER_SELECT} WHERE dm.conversation_id = ${conversationId}::uuid
        ORDER BY dm.joined_at, dm.user_id
        LIMIT 100000
      `;
      const mapped = rows.map(toMember);
      dmMemberCache.set(conversationId, mapped);
      all = mapped;
    }
    return states.length === 0 ? [...all] : all.filter((m) => states.includes(m.state));
  }

  // One page of the members who are in the conversation now (ACTIVE), oldest first, for the group member list
// : a keyset over (joined_at, user_id), never the whole group.
  async memberPage(
    conversationId: string,
    limit: number,
    after: { joinedAt: string; userId: string } | null,
  ): Promise<{ rows: MemberRow[]; nextAfter: { joinedAt: string; userId: string } | null }> {
    const cursor = after
      ? Prisma.sql`AND (dm.joined_at, dm.user_id) > (${after.joinedAt}::timestamptz, ${after.userId}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<(MemberSql & { joined_at_text: string })[]>`
      SELECT dm.conversation_id, c.kind, dm.user_id, u.username, dm.role, dm.state, dm.folder, dm.folder_chosen,
             dm.pinned_at, dm.nickname, dm.notifications, dm.last_read_message_id, dm.last_read_at, dm.timeout_until,
             dm.joined_at, ${TIME_TEXT('dm.joined_at')} AS joined_at_text
      FROM chat.dm_members dm
      JOIN chat.dm_conversations c ON c.id = dm.conversation_id
      LEFT JOIN identity.users u ON u.id = dm.user_id AND u.deleted_at IS NULL
      WHERE dm.conversation_id = ${conversationId}::uuid AND dm.state = 'ACTIVE' ${cursor}
      ORDER BY dm.joined_at, dm.user_id
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page.at(-1) : undefined;
    return {
      rows: page.map(toMember),
      nextAfter: last ? { joinedAt: last.joined_at_text, userId: last.user_id } : null,
    };
  }

  // Updates one member's own fields; untouched fields stay.
  async updateMember(
    conversationId: string,
    userId: string,
    data: Partial<{
      state: MemberState;
      folder: DmFolder;
      folderChosen: boolean;
      pinned: boolean;
      nickname: string | null;
      notifications: 'DEFAULT' | 'ON' | 'OFF';
      role: GroupRole;
      timeoutMinutes: number | null;
    }>,
    db: Db = this.prisma,
  ): Promise<boolean> {
    const has = (key: keyof typeof data): boolean => data[key] !== undefined;
    // Whoever leaves, is removed, banned or declines gives up the role in the same statement (one OWNER per group).
    const clearRole =
      data.state !== undefined && data.state !== 'ACTIVE' && data.state !== 'REQUEST';
    const changed = await db.$executeRaw`
      UPDATE chat.dm_members SET
        state = CASE WHEN ${has('state')} THEN ${data.state ?? null} ELSE state END,
        folder = CASE WHEN ${has('folder')} THEN ${data.folder ?? null} ELSE folder END,
        folder_chosen = CASE WHEN ${has('folderChosen')} THEN ${data.folderChosen ?? false} ELSE folder_chosen END,
        pinned_at = CASE WHEN ${has('pinned')} THEN (CASE WHEN ${data.pinned ?? false} THEN now() ELSE NULL END)
                         ELSE pinned_at END,
        nickname = CASE WHEN ${has('nickname')} THEN ${data.nickname ?? null} ELSE nickname END,
        notifications = CASE WHEN ${has('notifications')} THEN ${data.notifications ?? 'DEFAULT'} ELSE notifications END,
        role = CASE WHEN ${clearRole} THEN 'MEMBER' WHEN ${has('role')} THEN ${data.role ?? 'MEMBER'} ELSE role END,
        timeout_until = CASE WHEN ${has('timeoutMinutes')}
                             THEN (CASE WHEN ${data.timeoutMinutes ?? null}::int IS NULL THEN NULL
                                        ELSE now() + make_interval(mins => ${data.timeoutMinutes ?? 0}::int) END)
                             ELSE timeout_until END,
        updated_at = now()
      WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid
    `;
    dmMemberCache.invalidate(conversationId);
    return changed > 0;
  }

  // "Maximum Number of Pinned People (separate for each folder)".
  async pinnedPeople(userId: string, folder: DmFolder): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.dm_members
      WHERE user_id = ${userId}::uuid AND folder = ${folder} AND pinned_at IS NOT NULL AND state = 'ACTIVE'
    `;
    return rows[0]?.n ?? 0;
  }
}
