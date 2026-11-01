// Database access for bans from public groups (Module 9, ): the ban and the member's state change together, a
// ban is lifted only by a role not below the one that set it, and the list of banned members is keyset-paged.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { TIME_TEXT } from '../persistence/chat.sql';
import type { BanRow, UnbanResult } from './dm.groups.dboperation';
import { dmMemberCache } from './dm.member-cache';
import { GROUP_RANK, type GroupRole } from './dm.rules';

@Injectable()
export class DmGroupBansDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  async isBanned(conversationId: string, userId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.dm_group_bans
      WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  // Which of these users are banned from the group, in one query.
  async bannedAmong(conversationId: string, userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM chat.dm_group_bans
      WHERE conversation_id = ${conversationId}::uuid AND removed_at IS NULL AND user_id = ANY(${userIds as string[]}::uuid[])
    `;
    return new Set(rows.map((r) => r.user_id));
  }

  // The ban row and the member's state change together: a person who already left or was removed can be
// banned too, and a crash cannot leave a ban without the removal or the reverse.
  async banMember(
    conversationId: string,
    userId: string,
    by: { userId: string; role: GroupRole },
    reason: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO chat.dm_group_bans (conversation_id, user_id, banned_by, banned_by_role, reason)
        VALUES (${conversationId}::uuid, ${userId}::uuid, ${by.userId}::uuid, ${by.role}, ${reason})
        ON CONFLICT (conversation_id, user_id) WHERE removed_at IS NULL DO UPDATE SET banned_by = EXCLUDED.banned_by,
          banned_by_role = EXCLUDED.banned_by_role, reason = EXCLUDED.reason, created_at = now()
      `;
      await tx.$executeRaw`
        UPDATE chat.dm_members SET state = 'BANNED', role = 'MEMBER', pinned_at = NULL, updated_at = now()
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid
      `;
    });
    dmMemberCache.invalidate(conversationId);
  }

  // Lifts a ban only for someone who outranks the role that set it; false-y outcomes say why.
  async unban(conversationId: string, userId: string, actorRole: GroupRole, actorId: string): Promise<UnbanResult> {
    const result = await this.prisma.$transaction(async (tx): Promise<UnbanResult> => {
      const rows = await tx.$queryRaw<{ banned_by_role: GroupRole }[]>`
        SELECT banned_by_role FROM chat.dm_group_bans
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL FOR UPDATE
      `;
      const ban = rows[0];
      if (!ban) return 'not_banned';
      if (GROUP_RANK[actorRole] < GROUP_RANK[ban.banned_by_role]) return 'outranked';
      await tx.$executeRaw`
        UPDATE chat.dm_group_bans SET removed_at = now(), removed_by = ${actorId}::uuid
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL
      `;
      await tx.$executeRaw`
        UPDATE chat.dm_members SET state = 'REMOVED', updated_at = now()
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND state = 'BANNED'
      `;
      return 'ok';
    });
    dmMemberCache.invalidate(conversationId);
    return result;
  }

  // "Group admins get a paged list of banned members": keyset over (created_at, user_id).
  async bannedPage(
    conversationId: string,
    limit: number,
    after: { createdAt: string; userId: string } | null,
  ): Promise<{ rows: BanRow[]; nextAfter: { createdAt: string; userId: string } | null }> {
    const cursor = after
      ? Prisma.sql`AND (b.created_at, b.user_id) < (${after.createdAt}::timestamptz, ${after.userId}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<BanRow[]>`
      SELECT b.user_id, u.username, b.reason, b.banned_by_role, ${TIME_TEXT('b.created_at')} AS created_at_text
      FROM chat.dm_group_bans b
      LEFT JOIN identity.users u ON u.id = b.user_id AND u.deleted_at IS NULL
      WHERE b.conversation_id = ${conversationId}::uuid AND b.removed_at IS NULL ${cursor}
      ORDER BY b.created_at DESC, b.user_id DESC
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page.at(-1) : undefined;
    return {
      rows: page,
      nextAfter: last ? { createdAt: last.created_at_text, userId: last.user_id } : null,
    };
  }
}
