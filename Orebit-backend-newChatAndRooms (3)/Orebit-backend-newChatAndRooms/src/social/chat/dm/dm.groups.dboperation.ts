// Database access for groups (Module 9): the group row, invites, bans from public groups and ownership transfers.
// Membership itself is chat.dm_members (dm.dboperation.ts); group messages are chat.dm_messages.
// Every action that checks a number and then changes it (join and the member limit, the per-user join limit, the
// admin caps, ownership) runs in ONE transaction that first locks the group row. Parallel requests queue on
// the lock, so the limit holds; the partial unique indexes (one OWNER, one pending invite, one pending transfer) are the
// backstop if a code path is ever wrong. The lock order is always: the user's advisory lock, then the group row.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import { TIME_TEXT, type Db } from '../persistence/chat.sql';
import type { GroupPermission } from '../chat.features.contract';
import type { Cursor } from '../chat.utility';
import { dmMemberCache } from './dm.member-cache';
import { type GroupRole } from './dm.rules';

export type GroupVisibility = 'PUBLIC' | 'PRIVATE';

export interface GroupRecord {
  readonly conversationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly logoUrl: string | null;
  readonly visibility: GroupVisibility;
  readonly ownerId: string;
  readonly creatorId: string;
  readonly membersCanText: boolean;
  // A channel: only admins post.
  readonly isChannel: boolean;
  readonly permissions: Partial<Record<GroupPermission, GroupRole>>;
  // The permissions the owner lets group admins change.
  readonly adminManageable: readonly GroupPermission[];
  // Set when the last member left: the group is kept but no longer counts or lists.
  readonly closedAt: Date | null;
  // Active members, kept by a trigger: reading it never counts rows.
  readonly memberCount: number;
  readonly createdAt: Date;
}

interface GroupSql {
  conversation_id: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  visibility: GroupVisibility;
  owner_id: string;
  creator_id: string;
  members_can_text: boolean;
  is_channel: boolean;
  permissions: Partial<Record<GroupPermission, GroupRole>> | null;
  admin_manageable: GroupPermission[] | null;
  closed_at: Date | null;
  member_count: number;
  created_at: Date;
}

const GROUP_SELECT = Prisma.sql`
  SELECT conversation_id, name, description, logo_url, visibility, owner_id, creator_id, members_can_text, is_channel,
         permissions, admin_manageable, closed_at, member_count, created_at
  FROM chat.dm_groups`;

const toGroup = (row: GroupSql): GroupRecord => ({
  conversationId: row.conversation_id,
  name: row.name,
  description: row.description,
  logoUrl: row.logo_url,
  visibility: row.visibility,
  ownerId: row.owner_id,
  creatorId: row.creator_id,
  membersCanText: row.members_can_text,
  isChannel: row.is_channel,
  permissions: row.permissions ?? {},
  adminManageable: row.admin_manageable ?? [],
  closedAt: row.closed_at,
  memberCount: row.member_count,
  createdAt: row.created_at,
});

export interface InviteRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly inviterId: string;
  readonly inviteeId: string;
  readonly status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED';
  readonly createdAt: Date;
}

// Why a locked join or role change did not happen.
export type GroupChangeFailure = 'closed' | 'banned' | 'already_member' | 'full' | 'join_limit' | 'role_cap';
export type GroupChange = { readonly ok: true } | { readonly ok: false; readonly reason: GroupChangeFailure };

export type TransferResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_owner' | 'target_not_member' | 'limit' };

export type UnbanResult = 'ok' | 'not_banned' | 'outranked';

export interface BanRow {
  readonly user_id: string;
  readonly username: string | null;
  readonly reason: string | null;
  readonly banned_by_role: GroupRole;
  readonly created_at_text: string;
}

@Injectable()
export class DmGroupsDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async group(conversationId: string, db: Db = this.prisma): Promise<GroupRecord | null> {
    const rows = await db.$queryRaw<GroupSql[]>`
      ${GROUP_SELECT} WHERE conversation_id = ${conversationId}::uuid
    `;
    return rows[0] ? toGroup(rows[0]) : null;
  }

  // Locks the group row until the transaction ends; null when there is no such group.
  private async lockGroup(tx: Prisma.TransactionClient, conversationId: string): Promise<GroupRecord | null> {
    const rows = await tx.$queryRaw<GroupSql[]>`
      ${GROUP_SELECT} WHERE conversation_id = ${conversationId}::uuid FOR UPDATE
    `;
    return rows[0] ? toGroup(rows[0]) : null;
  }

  // One user's own joins and role changes queue behind this lock, so the per-user limit cannot be passed in parallel.
  private async lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`group-join:${userId}`}, 0))`;
  }

  // The conversation, the group and its owner as the first member, in one transaction.
  async createGroup(data: {
    ownerId: string;
    name: string;
    description: string | null;
    logoUrl: string | null;
    visibility: GroupVisibility;
    isChannel?: boolean;
  }): Promise<string> {
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO chat.dm_conversations (id, kind, created_by, last_message_at)
        VALUES (${id}::uuid, 'GROUP', ${data.ownerId}::uuid, now())
      `;
      await tx.$executeRaw`
        INSERT INTO chat.dm_groups (conversation_id, name, description, logo_url, visibility, owner_id, creator_id,
          created_public, is_channel)
        VALUES (${id}::uuid, ${data.name}, ${data.description}, ${data.logoUrl}, ${data.visibility},
          ${data.ownerId}::uuid, ${data.ownerId}::uuid, ${data.visibility === 'PUBLIC'}, ${data.isChannel ?? false})
      `;
      await tx.$executeRaw`
        INSERT INTO chat.dm_members (conversation_id, user_id, role, state, folder)
        VALUES (${id}::uuid, ${data.ownerId}::uuid, 'OWNER', 'ACTIVE', 'GROUPS')
      `;
    });
    dmMemberCache.invalidate(id);
    return id;
  }

  // Open groups this user created, by the type they were created as: "Change Group Type: This will be still counted
// towards creator's limit". A closed group no longer counts.
  async createdCount(userId: string, visibility: GroupVisibility): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.dm_groups
      WHERE creator_id = ${userId}::uuid AND created_public = ${visibility === 'PUBLIC'} AND closed_at IS NULL
    `;
    return rows[0]?.n ?? 0;
  }

  // Groups of this type the user is an active member of.
  async joinedCount(userId: string, visibility: GroupVisibility, db: Db = this.prisma): Promise<number> {
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.dm_members m
      JOIN chat.dm_groups g ON g.conversation_id = m.conversation_id
      WHERE m.user_id = ${userId}::uuid AND m.state = 'ACTIVE' AND g.visibility = ${visibility}
    `;
    return rows[0]?.n ?? 0;
  }

  async memberCount(conversationId: string, role?: GroupRole, db: Db = this.prisma): Promise<number> {
    const byRole = role ? Prisma.sql`AND role = ${role}` : Prisma.empty;
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.dm_members
      WHERE conversation_id = ${conversationId}::uuid AND state = 'ACTIVE' ${byRole}
    `;
    return rows[0]?.n ?? 0;
  }

  async updateGroup(
    conversationId: string,
    patch: Partial<{
      name: string;
      description: string | null;
      logoUrl: string | null;
      visibility: GroupVisibility;
      membersCanText: boolean;
      permissions: Partial<Record<GroupPermission, GroupRole>>;
      adminManageable: readonly GroupPermission[];
      ownerId: string;
    }>,
    db: Db = this.prisma,
  ): Promise<void> {
    const has = (key: keyof typeof patch): boolean => patch[key] !== undefined;
    await db.$executeRaw`
      UPDATE chat.dm_groups SET
        name = CASE WHEN ${has('name')} THEN ${patch.name ?? null} ELSE name END,
        description = CASE WHEN ${has('description')} THEN ${patch.description ?? null} ELSE description END,
        logo_url = CASE WHEN ${has('logoUrl')} THEN ${patch.logoUrl ?? null} ELSE logo_url END,
        visibility = CASE WHEN ${has('visibility')} THEN ${patch.visibility ?? null} ELSE visibility END,
        members_can_text = CASE WHEN ${has('membersCanText')} THEN ${patch.membersCanText ?? true} ELSE members_can_text END,
        permissions = CASE WHEN ${has('permissions')} THEN ${JSON.stringify(patch.permissions ?? {})}::jsonb ELSE permissions END,
        admin_manageable = CASE WHEN ${has('adminManageable')} THEN ${JSON.stringify(patch.adminManageable ?? [])}::jsonb
                                ELSE admin_manageable END,
        owner_id = CASE WHEN ${has('ownerId')} THEN ${patch.ownerId ?? null}::uuid ELSE owner_id END,
        updated_at = now()
      WHERE conversation_id = ${conversationId}::uuid
    `;
  }

  // "Channels: All Public Groups", by name, with an optional name search. Closed groups are not listed.
  async publicGroups(userId: string, search: string | null, limit: number, cursor: Cursor | null) {
    const like = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const filter = like ? Prisma.sql`AND g.name ILIKE ${like}` : Prisma.empty;
    const after = cursor
      ? Prisma.sql`AND (g.created_at, g.conversation_id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    return this.prisma.$queryRaw<
      {
        id: string;
        name: string;
        description: string | null;
        logo_url: string | null;
        member_count: number;
        my_state: string | null;
        created_at_text: string;
      }[]
    >`
      SELECT g.conversation_id AS id, g.name, g.description, g.logo_url,
             g.member_count,
             (SELECT m.state FROM chat.dm_members m WHERE m.conversation_id = g.conversation_id AND m.user_id = ${userId}::uuid) AS my_state,
             ${TIME_TEXT('g.created_at')} AS created_at_text
      FROM chat.dm_groups g
      WHERE g.visibility = 'PUBLIC' AND g.closed_at IS NULL ${filter} ${after}
      ORDER BY g.created_at DESC, g.conversation_id DESC
      LIMIT ${limit + 1}
    `;
  }

  // Locked changes: join, roles, leave, ownership
  // Puts the user in the group as a MEMBER when every rule holds: not closed, not banned, not already in, room in
// the group and room in the user's own joined-groups limit. The checks and the insert are one locked transaction.
// `insert` lets the caller add more writes (accepting the invite) to the same transaction.
  async addMemberLocked(
    conversationId: string,
    userId: string,
    limits: { maxMembers: number; maxJoined: number },
    insert: (tx: Prisma.TransactionClient, group: GroupRecord) => Promise<void> = async () => undefined,
  ): Promise<GroupChange> {
    const result = await this.prisma.$transaction(async (tx): Promise<GroupChange> => {
      await this.lockUser(tx, userId);
      const group = await this.lockGroup(tx, conversationId);
      if (!group || group.closedAt) return { ok: false, reason: 'closed' };
      const banned = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.dm_group_bans
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL
      `;
      if ((banned[0]?.n ?? 0) > 0) return { ok: false, reason: 'banned' };
      const mine = await tx.$queryRaw<{ state: string }[]>`
        SELECT state FROM chat.dm_members
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid
      `;
      if (mine[0]?.state === 'ACTIVE') return { ok: false, reason: 'already_member' };
      if (group.memberCount >= limits.maxMembers) {
        return { ok: false, reason: 'full' };
      }
      if ((await this.joinedCount(userId, group.visibility, tx)) >= limits.maxJoined) {
        return { ok: false, reason: 'join_limit' };
      }
      await tx.$executeRaw`
        INSERT INTO chat.dm_members (conversation_id, user_id, role, state, folder)
        VALUES (${conversationId}::uuid, ${userId}::uuid, 'MEMBER', 'ACTIVE', 'GROUPS')
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET
          role = 'MEMBER', state = 'ACTIVE', folder = 'GROUPS', joined_at = now(), updated_at = now(),
          -- A timeout still running when the member leaves and comes back stays.
          timeout_until = CASE WHEN chat.dm_members.timeout_until > now() THEN chat.dm_members.timeout_until ELSE NULL END
      `;
      await insert(tx, group);
      return { ok: true };
    });
    dmMemberCache.invalidate(conversationId);
    return result;
  }

  // Gives a member a role when fewer than `max` hold it (null = no cap): "Max Group Admins / Sub-Admins".
  async setRoleLocked(
    conversationId: string,
    userId: string,
    role: GroupRole,
    max: number | null,
  ): Promise<GroupChange> {
    const result = await this.prisma.$transaction(async (tx): Promise<GroupChange> => {
      const group = await this.lockGroup(tx, conversationId);
      if (!group || group.closedAt) return { ok: false, reason: 'closed' };
      if (max !== null) {
        const holders = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM chat.dm_members
          WHERE conversation_id = ${conversationId}::uuid AND state = 'ACTIVE' AND role = ${role}
            AND user_id <> ${userId}::uuid
        `;
        if ((holders[0]?.n ?? 0) >= max) return { ok: false, reason: 'role_cap' };
      }
      await tx.$executeRaw`
        UPDATE chat.dm_members SET role = ${role}, updated_at = now()
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND state = 'ACTIVE'
      `;
      return { ok: true };
    });
    dmMemberCache.invalidate(conversationId);
    return result;
  }

  // The member leaves and gives up the role. The last member to leave closes the group. The owner may not
// leave while others are in: ownership has to move first.
  async leaveLocked(
    conversationId: string,
    userId: string,
  ): Promise<{ left: boolean; closed: boolean; ownerMustTransfer: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const group = await this.lockGroup(tx, conversationId);
      if (!group) return { left: false, closed: false, ownerMustTransfer: false };
      const mine = await tx.$queryRaw<{ role: GroupRole; state: string }[]>`
        SELECT role, state FROM chat.dm_members
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid
      `;
      if (mine[0]?.state !== 'ACTIVE') return { left: false, closed: false, ownerMustTransfer: false };
      const active = group.memberCount;
      if (mine[0].role === 'OWNER' && active > 1) return { left: false, closed: false, ownerMustTransfer: true };
      await tx.$executeRaw`
        UPDATE chat.dm_members SET state = 'LEFT', role = 'MEMBER', pinned_at = NULL, updated_at = now()
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid
      `;
      const closed = active === 1;
      if (closed) {
        await tx.$executeRaw`UPDATE chat.dm_groups SET closed_at = now(), updated_at = now() WHERE conversation_id = ${conversationId}::uuid`;
      }
      return { left: true, closed, ownerMustTransfer: false };
    });
    dmMemberCache.invalidate(conversationId);
    return result;
  }

  // Hands the group to another active member at once (no code). One locked transaction: the caller is still
// the owner, the target is still an active member, the "x times in y hours" limit holds, other pending transfers
// are cancelled, the old owner becomes an admin. The OWNER unique index forces the demote to run before the promote.
  async transferOwnership(
    conversationId: string,
    from: string,
    to: string,
    limit: { count: number; windowHours: number },
  ): Promise<TransferResult> {
    const result = await this.prisma.$transaction(async (tx): Promise<TransferResult> => {
      const group = await this.lockGroup(tx, conversationId);
      if (!group || group.closedAt || group.ownerId !== from) return { ok: false, reason: 'not_owner' };
      const parties = await tx.$queryRaw<{ user_id: string; role: GroupRole; state: string }[]>`
        SELECT user_id, role, state FROM chat.dm_members
        WHERE conversation_id = ${conversationId}::uuid AND user_id IN (${from}::uuid, ${to}::uuid)
      `;
      const me = parties.find((p) => p.user_id === from);
      const target = parties.find((p) => p.user_id === to);
      if (!me || me.state !== 'ACTIVE' || me.role !== 'OWNER') return { ok: false, reason: 'not_owner' };
      if (!target || target.state !== 'ACTIVE' || to === from) return { ok: false, reason: 'target_not_member' };
      const recent = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.dm_ownership_transfers
        WHERE conversation_id = ${conversationId}::uuid AND status = 'COMPLETED'
          AND completed_at > now() - make_interval(hours => ${limit.windowHours}::int)
      `;
      if ((recent[0]?.n ?? 0) >= limit.count) return { ok: false, reason: 'limit' };
      await tx.$executeRaw`
        UPDATE chat.dm_ownership_transfers SET status = 'CANCELLED'
        WHERE conversation_id = ${conversationId}::uuid AND status = 'PENDING'
      `;
      await tx.$executeRaw`
        UPDATE chat.dm_members SET role = 'ADMIN', updated_at = now()
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${from}::uuid
      `;
      await tx.$executeRaw`
        UPDATE chat.dm_members SET role = 'OWNER', updated_at = now()
        WHERE conversation_id = ${conversationId}::uuid AND user_id = ${to}::uuid
      `;
      await this.updateGroup(conversationId, { ownerId: to }, tx);
      await tx.$executeRaw`
        INSERT INTO chat.dm_ownership_transfers (id, conversation_id, from_user_id, to_user_id, status, expires_at, completed_at)
        VALUES (${uuidv7()}::uuid, ${conversationId}::uuid, ${from}::uuid, ${to}::uuid, 'COMPLETED', now(), now())
      `;
      return { ok: true };
    });
    dmMemberCache.invalidate(conversationId);
    return result;
  }
}
