import { Injectable } from '@nestjs/common';
import type { SecurityRestrictionPolicy, UserFeatureRestriction } from '@prisma/client';
import { PrismaService } from '../../db/client';

/**
 * Prisma access for the three restriction tables.
 *
 * Only `*.dboperation.ts` files may inject `PrismaService` — the README rule — so
 * every query the engine makes is in this file, and the one write that must happen
 * inside somebody else's transaction is not: that is
 * `auth/persistence/restriction.lock.ts`, a free function over a `TransactionClient`,
 * following `assertNoRecentEmailChangeLocked`.
 *
 * ─── What is deliberately NOT here ────────────────────────────────────────
 *
 * No Admin write path. Policies are configured by the Admin backend, which reaches
 * `identity.security_restriction_policies` with its own schema-qualified SQL. This
 * service only ever READS policy; giving it a writer would make two services
 * authoritative for one table.
 */
@Injectable()
export class RestrictionDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every configured policy row.
   *
   * The whole table on purpose: it is at most sixteen rows — eight trigger actions by
   * two configurable contexts — so paging or filtering it would be ceremony around a
   * query that fits in one page. `RestrictionPolicySnapshotService` calls this on a
   * timer and holds the result.
   */
  async listPolicies(): Promise<readonly SecurityRestrictionPolicy[]> {
    return this.prisma.securityRestrictionPolicy.findMany({
      orderBy: [{ action: 'asc' }, { context: 'asc' }],
    });
  }

  /**
   * Live restrictions for one account and one feature.
   *
   * `expiresAt > now` is evaluated here rather than by a sweeper, so a restriction
   * ends exactly on time — there is no job whose failure could leave an account
   * restricted, and no lag between the deadline and the release.
   *
   * Both the feature's own rows and its whole-feature rows come back: `subFeature`
   * null means the entire feature is withheld, so a caller asking about one
   * sub-feature must see the parent's restriction too. One query, one index
   * (`ix_user_feature_restrictions_live` on `(user_id, feature, expires_at DESC)`),
   * no second round trip to check the parent.
   *
   * Expired rows are left in place — they are this feature's audit trail.
   */
  async liveRestrictionsFor(
    userId: string,
    feature: string,
    subFeature: string | null,
    now: Date,
  ): Promise<readonly UserFeatureRestriction[]> {
    return this.prisma.userFeatureRestriction.findMany({
      where: {
        userId,
        feature,
        expiresAt: { gt: now },
        // `subFeature: null` is the whole-feature row and always applies. When the
        // caller named a sub-feature, its own rows apply as well.
        ...(subFeature === null ? { subFeature: null } : { OR: [{ subFeature: null }, { subFeature }] }),
      },
      orderBy: { expiresAt: 'desc' },
    });
  }

  /**
   * Every live restriction on an account, for the user's own "why can't I…" screen.
   *
   * Served by the Prisma-declared `(user_id, expires_at)` index rather than
   * `ix_user_feature_restrictions_live`, whose leading `(user_id, feature)` cannot
   * answer a query with no feature in it.
   */
  async liveRestrictions(userId: string, now: Date): Promise<readonly UserFeatureRestriction[]> {
    return this.prisma.userFeatureRestriction.findMany({
      where: { userId, expiresAt: { gt: now } },
      orderBy: { expiresAt: 'desc' },
    });
  }

  /**
   * Restrictions already written for one request.
   *
   * The idempotency read. `requestId` is Fastify's per-request id, so a retry of the
   * SAME request carries the same value and a genuine second attempt by the user
   * carries a different one — which is the distinction that matters: replaying a
   * request must not stack restrictions, while deliberately changing a password twice
   * legitimately produces two sets.
   *
   * Scoped to the account as well as the id so one account's request id can never
   * suppress another's write.
   */
  async restrictionsForRequest(
    userId: string,
    requestId: string,
  ): Promise<readonly UserFeatureRestriction[]> {
    return this.prisma.userFeatureRestriction.findMany({ where: { userId, requestId } });
  }
}
