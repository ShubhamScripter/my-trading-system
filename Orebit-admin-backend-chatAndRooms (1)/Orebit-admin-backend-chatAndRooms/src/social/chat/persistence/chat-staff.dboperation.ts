/**
 * Database access for chat staff roles, the test-only stand-in facts and the frequent-hitter list.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import type { ChatStaffRole, FrequentHitter } from '../chat.types';
import { ChatUtility } from '../chat.utility';

/** One user's test-only stand-in facts (NEW-2). */
export interface TestEntitlement {
  userId: string;
  username: string;
  onCasino: boolean;
  wagerUsd: string;
  premiumPlanIds: string[];
  kycLevel: number | null;
  isSiteOwner: boolean;
  level: number | null;
  /** Usernames this user follows (test stand-in for the follow module). */
  follows: string[];
  updatedAt: string;
}

interface StaffRoleRow {
  userId: string;
  username: string | null;
  role: string;
  assignedBy: string | null;
  assignedAt: Date;
}

interface HitterRow {
  userId: string;
  username: string | null;
  lastIp: string | null;
  hits: number;
  lastHitAt: Date;
  blockedUntil: Date | null;
}

type TestEntitlementRow = Omit<TestEntitlement, 'updatedAt'> & { updatedAt: Date };

@Injectable()
export class ChatStaffDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Staff roles
  async getStaffRoles(): Promise<ChatStaffRole[]> {
    const rows = await this.prisma.$queryRaw<StaffRoleRow[]>`
      SELECT
        sr.user_id        AS "userId",
        u.username,
        sr.role::text     AS role,
        sr.assigned_by    AS "assignedBy",
        sr.assigned_at    AS "assignedAt"
      FROM chat.staff_roles sr
      INNER JOIN identity.users u ON u.id = sr.user_id AND u.deleted_at IS NULL
      WHERE sr.removed_at IS NULL
      ORDER BY sr.assigned_at DESC
    `;
    return rows.map((row) => ({
      userId: row.userId,
      username: row.username ?? 'Unknown',
      role: row.role as ChatStaffRole['role'],
      assignedBy: row.assignedBy ?? null,
      assignedAt: new Date(row.assignedAt).toISOString(),
    }));
  }

  /**
   * Gives a user a chat role, or removes it when `role` is null. In one transaction it reads the old role,
   * writes the new one and appends the audit row with both, so a role never changes without its record
   *. Returns the role the user had before.
   */
  async setRole(data: {
    userId: string;
    role: string | null;
    adminId: string;
    action: 'ASSIGN_ROLE' | 'REMOVE_ROLE';
    note: string;
  }): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.$queryRaw<{ role: string }[]>`
        SELECT role::text AS role FROM chat.staff_roles WHERE user_id = ${data.userId}::uuid AND removed_at IS NULL FOR UPDATE
      `;
      const oldRole = before[0]?.role ?? null;
      if (data.role === null) {
        // Soft-delete role assignment to preserve assignment audit history.
        await tx.$executeRaw`
          UPDATE chat.staff_roles SET removed_at = now(), removed_by = ${data.adminId}::uuid
          WHERE user_id = ${data.userId}::uuid AND removed_at IS NULL
        `;
      } else {
        await tx.$executeRaw`
          INSERT INTO chat.staff_roles (user_id, role, assigned_by, assigned_at)
          VALUES (${data.userId}::uuid, ${data.role}::chat."StaffRole", ${data.adminId}::uuid, now())
          ON CONFLICT (user_id) WHERE removed_at IS NULL DO UPDATE SET role = EXCLUDED.role, assigned_by = EXCLUDED.assigned_by, assigned_at = now()
        `;
      }
      await tx.$executeRaw`
        INSERT INTO chat.moderation_actions (
          id, actor_type, actor_id, action, target_user_id, old_value, new_value, note, created_at
        ) VALUES (
          ${ChatUtility.generateUuid()}::uuid, 'ADMIN', ${data.adminId}::uuid, ${data.action}, ${data.userId}::uuid,
          ${JSON.stringify({ role: oldRole })}::jsonb, ${JSON.stringify({ role: data.role })}::jsonb, ${data.note}, now()
        )
      `;
      return oldRole;
    });
  }

  // Test-only stand-in facts
  async getTestEntitlements(): Promise<TestEntitlement[]> {
    const rows = await this.prisma.$queryRaw<TestEntitlementRow[]>`
      SELECT t.user_id AS "userId", u.username, t.on_casino AS "onCasino", t.wager_usd::text AS "wagerUsd",
             t.premium_plan_ids AS "premiumPlanIds", t.kyc_level AS "kycLevel", t.is_site_owner AS "isSiteOwner",
             t.level, t.updated_at AS "updatedAt",
             COALESCE((SELECT array_agg(f.username ORDER BY f.username) FROM identity.users f
                       WHERE f.id = ANY(t.follows) AND f.deleted_at IS NULL), ARRAY[]::text[]) AS follows
      FROM chat.test_entitlements t
      INNER JOIN identity.users u ON u.id = t.user_id AND u.deleted_at IS NULL
      ORDER BY t.updated_at DESC
      LIMIT 200
    `;
    return rows.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt).toISOString() }));
  }

  async upsertTestEntitlement(data: {
    userId: string;
    onCasino: boolean;
    wagerUsd: string;
    premiumPlanIds: string[];
    kycLevel: number | null;
    isSiteOwner: boolean;
    level: number | null;
    follows: string[];
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.test_entitlements (user_id, premium_plan_ids, kyc_level, is_site_owner, is_vip, level, on_casino, wager_usd, follows, updated_at)
      VALUES (${data.userId}::uuid, ${data.premiumPlanIds}::text[], ${data.kycLevel}::int, ${data.isSiteOwner}, false,
              ${data.level}::int, ${data.onCasino}, ${data.wagerUsd}::numeric, ${data.follows}::uuid[], now())
      ON CONFLICT (user_id) DO UPDATE SET
        premium_plan_ids = EXCLUDED.premium_plan_ids, kyc_level = EXCLUDED.kyc_level, is_site_owner = EXCLUDED.is_site_owner,
        is_vip = false, level = EXCLUDED.level, on_casino = EXCLUDED.on_casino, wager_usd = EXCLUDED.wager_usd,
        follows = EXCLUDED.follows, updated_at = now()
    `;
  }

  async deleteTestEntitlement(userId: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      DELETE FROM chat.test_entitlements WHERE user_id = ${userId}::uuid
    `;
    return changed > 0;
  }

  // Frequent hitters
  async getFrequentHitters(opts: {
    limit: number;
    sort: 'date' | 'count';
    from: string | null;
    to: string | null;
  }): Promise<FrequentHitter[]> {
    const order = opts.sort === 'count' ? Prisma.sql`fh.hits DESC, fh.user_id` : Prisma.sql`fh.last_hit_at DESC, fh.user_id`;
    const rows = await this.prisma.$queryRaw<HitterRow[]>`
      SELECT
        fh.user_id        AS "userId",
        u.username,
        fh.last_ip        AS "lastIp",
        fh.hits,
        fh.last_hit_at    AS "lastHitAt",
        fh.blocked_until  AS "blockedUntil"
      FROM chat.frequent_hitters fh
      LEFT JOIN identity.users u ON u.id = fh.user_id
      WHERE (${opts.from}::timestamptz IS NULL OR fh.last_hit_at >= ${opts.from}::timestamptz)
        AND (${opts.to}::timestamptz IS NULL OR fh.last_hit_at < ${opts.to}::timestamptz)
      ORDER BY ${order}
      LIMIT ${opts.limit}
    `;
    // What each of these users was doing: their last 24 hours of hits by reason, in one query for the whole page.
    const reasons = await this.prisma.$queryRaw<{ user_id: string; reason: string; hits: number }[]>`
      SELECT user_id, reason, sum(hits)::int AS hits
      FROM chat.limit_hits_hourly
      WHERE user_id = ANY(${rows.map((row) => row.userId)}::uuid[]) AND hour >= now() - interval '24 hours'
      GROUP BY user_id, reason
      ORDER BY hits DESC
    `;
    return rows.map((row) => ({
      reasons: reasons.filter((r) => r.user_id === row.userId).map((r) => ({ reason: r.reason, hits: r.hits })),
      userId: row.userId,
      username: row.username ?? null,
      lastIp: row.lastIp ?? null,
      hits: row.hits,
      lastHitAt: new Date(row.lastHitAt).toISOString(),
      blockedUntil: row.blockedUntil ? new Date(row.blockedUntil).toISOString() : null,
    }));
  }
}
