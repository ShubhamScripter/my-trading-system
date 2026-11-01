// Database access for mute and block lists (Module 5, Chat MAIN and Chat SETTINGS "/mute", "/block").
// - Mute: the muter no longer sees the target's public messages; DMs still work.
// - Block: the blocker no longer sees the target's public messages; neither can DM the other, the target cannot open
// the blocker's profile, and gifts between the two are refused.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { TIME_TEXT } from './chat.sql';
import type { Cursor } from '../chat.utility';

export type RelationList = 'mutes' | 'blocks';

export interface RelationEntry {
  readonly userId: string;
  readonly username: string;
  readonly createdAt: Date;
  readonly createdAtText: string;
}

// Both directions of mute and block between two users, from one query.
export interface Relation {
  readonly iMuted: boolean;
  readonly iBlocked: boolean;
  readonly mutedMe: boolean;
  readonly blockedMe: boolean;
}

@Injectable()
export class ChatMuteBlockDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Adds the pair unless the list already holds `max` people. The count and the insert run under one lock per
// user and list, so parallel requests cannot all pass the last place. EXISTS: it was already there.
  async add(list: RelationList, userId: string, targetId: string, max: number): Promise<'ADDED' | 'EXISTS' | 'FULL'> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${list}:${userId}`}, 0))`;
      const table = list === 'mutes' ? Prisma.raw('chat.user_mutes') : Prisma.raw('chat.user_blocks');
      const present = await tx.$queryRaw<{ n: number; has: boolean }[]>`
        SELECT count(*)::int AS n, bool_or(target_id = ${targetId}::uuid) AS has FROM ${table} WHERE user_id = ${userId}::uuid AND removed_at IS NULL
      `;
      if (present[0]?.has) return 'EXISTS';
      if ((present[0]?.n ?? 0) >= max) return 'FULL';
      await tx.$executeRaw`INSERT INTO ${table} (user_id, target_id) VALUES (${userId}::uuid, ${targetId}::uuid)`;
      return 'ADDED';
    });
  }

  // Removes the pair; false when it was not there.
  async remove(list: RelationList, userId: string, targetId: string): Promise<boolean> {
    const changed =
      list === 'mutes'
        ? await this.prisma.$executeRaw`
            UPDATE chat.user_mutes SET removed_at = now(), removed_by = ${userId}::uuid
            WHERE user_id = ${userId}::uuid AND target_id = ${targetId}::uuid AND removed_at IS NULL`
        : await this.prisma.$executeRaw`
            UPDATE chat.user_blocks SET removed_at = now(), removed_by = ${userId}::uuid
            WHERE user_id = ${userId}::uuid AND target_id = ${targetId}::uuid AND removed_at IS NULL`;
    return changed > 0;
  }

  // /mutelist and /blocklist: newest first, live accounts only, exact keyset paging.
  async list(
    list: RelationList,
    userId: string,
    limit: number,
    cursor: Cursor | null,
  ): Promise<RelationEntry[]> {
    const table = list === 'mutes' ? Prisma.sql`chat.user_mutes` : Prisma.sql`chat.user_blocks`;
    const after = cursor
      ? Prisma.sql`AND (r.created_at, r.target_id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { target_id: string; username: string; created_at: Date; created_at_text: string }[]
    >`
      SELECT r.target_id, u.username, r.created_at, ${TIME_TEXT('r.created_at')} AS created_at_text
      FROM ${table} r
      JOIN identity.users u ON u.id = r.target_id AND u.deleted_at IS NULL
      WHERE r.user_id = ${userId}::uuid AND r.removed_at IS NULL ${after}
      ORDER BY r.created_at DESC, r.target_id DESC
      LIMIT ${limit + 1}
    `;
    return rows.map((row) => ({
      userId: row.target_id,
      username: row.username,
      createdAt: row.created_at,
      createdAtText: row.created_at_text,
    }));
  }

  // Every author whose public messages this user does not see: muted or blocked by them.
  async hiddenAuthorIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ target_id: string }[]>`
      SELECT target_id FROM chat.user_mutes WHERE user_id = ${userId}::uuid AND removed_at IS NULL
      UNION
      SELECT target_id FROM chat.user_blocks WHERE user_id = ${userId}::uuid AND removed_at IS NULL
    `;
    return rows.map((row) => row.target_id);
  }

  async relation(userId: string, otherId: string): Promise<Relation> {
    const rows = await this.prisma.$queryRaw<
      { i_muted: boolean; i_blocked: boolean; muted_me: boolean; blocked_me: boolean }[]
    >`
      SELECT
        EXISTS (SELECT 1 FROM chat.user_mutes WHERE user_id = ${userId}::uuid AND target_id = ${otherId}::uuid AND removed_at IS NULL) AS i_muted,
        EXISTS (SELECT 1 FROM chat.user_blocks WHERE user_id = ${userId}::uuid AND target_id = ${otherId}::uuid AND removed_at IS NULL) AS i_blocked,
        EXISTS (SELECT 1 FROM chat.user_mutes WHERE user_id = ${otherId}::uuid AND target_id = ${userId}::uuid AND removed_at IS NULL) AS muted_me,
        EXISTS (SELECT 1 FROM chat.user_blocks WHERE user_id = ${otherId}::uuid AND target_id = ${userId}::uuid AND removed_at IS NULL) AS blocked_me
    `;
    const row = rows[0];
    return {
      iMuted: row?.i_muted ?? false,
      iBlocked: row?.i_blocked ?? false,
      mutedMe: row?.muted_me ?? false,
      blockedMe: row?.blocked_me ?? false,
    };
  }

  // Of `others`, those blocked by `userId` or blocking `userId` (DM lists, group invites).
  async blockedEitherWay(userId: string, others: readonly string[]): Promise<Set<string>> {
    if (others.length === 0) return new Set();
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT target_id AS id FROM chat.user_blocks
      WHERE user_id = ${userId}::uuid AND removed_at IS NULL AND target_id = ANY(${[...others]}::uuid[])
      UNION
      SELECT user_id AS id FROM chat.user_blocks
      WHERE target_id = ${userId}::uuid AND removed_at IS NULL AND user_id = ANY(${[...others]}::uuid[])
    `;
    return new Set(rows.map((row) => row.id));
  }
}
