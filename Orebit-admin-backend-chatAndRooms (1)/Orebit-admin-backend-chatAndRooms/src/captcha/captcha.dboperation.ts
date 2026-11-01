import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/client';

/**
 * Prisma access for `admin.admin_captcha_providers` — the operator's switch for
 * taking a captcha provider out of rotation without a redeploy.
 *
 * One statement, deliberately. This file exists at all because only
 * `*.dboperation.ts` may inject `PrismaService` (see README.md), and it sits in
 * `src/captcha/` rather than `auth/persistence/` because the filename is what
 * grants that access, not the directory — so the query belongs beside the module
 * that owns it.
 *
 * `disabled()` is the sign-in path's read and stays the narrowest query possible.
 * `list()` and `setEnabled()` serve the operator surface on `/captcha/providers`,
 * which is SUPER_ADMIN-gated at the route.
 */
@Injectable()
export class CaptchaProviderDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The providers an operator has switched off.
   *
   * ═══ THIS THROWS, AND MUST KEEP THROWING ═══════════════════════════════════
   *
   * "Nothing is disabled" and "we could not ask" are different facts here, and
   * they may only be turned into the same answer by a layer that knows the env
   * set — otherwise a failed query would be indistinguishable from an empty
   * table at a call site that cannot tell whether the resulting list is safe.
   * `CaptchaSettingsService.refresh` owns that decision; see the comment there.
   *
   * Returns `string[]` and NOT `CaptchaProvider[]`. The column is free text by
   * design, so an operator's typo would otherwise become a type lie that
   * TypeScript would then vouch for downstream.
   */
  async disabled(): Promise<readonly string[]> {
    const rows = await this.prisma.adminCaptchaProvider.findMany({
      where: { enabled: false },
      select: { provider: true },
    });

    return rows.map((row) => row.provider);
  }

  /**
   * Every row, enabled and disabled alike, for the operator's read.
   *
   * Separate from `disabled()` rather than filtered from it, because the two answer
   * different questions and only one of them is on the sign-in path. `disabled()` is
   * what the snapshot refreshes from and must stay the narrowest possible query;
   * this is a settings screen's read and can afford the whole table.
   *
   * Ordered by provider so the answer is stable between calls — a settings list that
   * reshuffles itself is a list nobody trusts.
   */
  async list(): Promise<readonly CaptchaProviderRow[]> {
    return this.prisma.adminCaptchaProvider.findMany({
      select: {
        provider: true,
        enabled: true,
        reason: true,
        updatedByAdminId: true,
        updatedAt: true,
      },
      orderBy: { provider: 'asc' },
    });
  }

  /**
   * Write one toggle.
   *
   * An UPSERT, because "disable HCAPTCHA" must mean the same thing whether or not a
   * row already exists — and the operator asking has no way to know which. An INSERT
   * would fail the second time; an UPDATE would silently do nothing the first.
   *
   * `updatedAt` is set by hand. The column has `@default(now())` rather than
   * `@updatedAt` precisely because rows are also written in psql, where Prisma is not
   * there to maintain it — so the write path that CAN maintain it does so explicitly
   * rather than leaving a stale timestamp behind.
   */
  async setEnabled(input: {
    readonly provider: string;
    readonly enabled: boolean;
    readonly reason: string | null;
    readonly actorAdminId: string;
  }): Promise<CaptchaProviderRow> {
    const data = {
      enabled: input.enabled,
      reason: input.reason,
      updatedByAdminId: input.actorAdminId,
      updatedAt: new Date(),
    };

    return this.prisma.adminCaptchaProvider.upsert({
      where: { provider: input.provider },
      create: { provider: input.provider, ...data },
      update: data,
      select: {
        provider: true,
        enabled: true,
        reason: true,
        updatedByAdminId: true,
        updatedAt: true,
      },
    });
  }
}

/** One row of the toggle table. Declared here rather than imported from Prisma so
 *  the shape this module depends on is visible, and narrowing the `select` above is
 *  a compile error rather than a silently thinner object. */
export interface CaptchaProviderRow {
  readonly provider: string;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly updatedByAdminId: string | null;
  readonly updatedAt: Date;
}
