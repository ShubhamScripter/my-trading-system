import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../db/client';
import { SERVER_EVENTS, SYSTEM_AUTHOR_ID } from '../chat/chat.constants';
import { ChatAccessService } from '../chat/chat.access.service';
import { ChatDelivery } from '../chat/realtime/chat.delivery';
import { restrictionTargets } from '../chat/services/chat.restrictions.service';
import type { EligibilityFacts } from '../chat/chat.types';
import type { RainRevertFilter } from './rain.contract';
import { RainDbOperation } from './rain.dboperation';
import { formatMinor, reversalPlan } from './rain.math';
import type { RainJobRow, RainRunRow } from './rain.types';
import { RainWallet } from './rain.wallet';

const FEE_ACCOUNT = SYSTEM_AUTHOR_ID;
const REVERT_PAGE = 50;

@Injectable()
export class RainRevertService {
  private readonly logger = new Logger('RainRevertService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: RainDbOperation,
    private readonly wallet: RainWallet,
    private readonly delivery: ChatDelivery,
    private readonly access: ChatAccessService,
  ) {}

  // Reverts a single rain according to job policy and takes back recipient shares
  async revertRain(
    run: RainRunRow,
    job: Pick<RainJobRow, 'id' | 'actorId' | 'reason' | 'payerRefund' | 'shortfall'>,
    onlyUserIds: readonly string[] | null,
    onRevokeRewards?: (run: RainRunRow, userIds: readonly string[], whole: boolean) => Promise<void>,
  ): Promise<boolean> {
    const payerId = run.kind === 'SYSTEM' ? FEE_ACCOUNT : run.initiatorId;
    if (!payerId) throw new Error('Rain has no payer');
    this.wallet.refuseIfUnavailable();
    const note = job.reason ?? 'reverted';

    const outcome = await this.prisma.$transaction(async (tx) => {
      const locked = await this.db.lockRun(tx, run.id);
      if (!locked || (locked.status !== 'COMPLETED' && locked.status !== 'PARTIALLY_REVERSED')) return null;
      const taken = await this.db.takeShares(tx, run.id, onlyUserIds);
      if (taken.length === 0) return null;
      const held =
        job.shortfall === 'ZERO'
          ? await this.wallet.heldForUpdate(tx, taken.map((s) => s.userId), run.currency)
          : new Map<string, bigint>();
      const plan = reversalPlan({
        rainId: run.id,
        batchId: job.id,
        kind: run.kind,
        payerId,
        platformAccountId: FEE_ACCOUNT,
        shares: taken,
        held,
        payerRefund: job.payerRefund,
        shortfall: job.shortfall,
      });
      await this.wallet.apply(tx, plan.legs, run.currency, { allowNegative: job.shortfall === 'NEGATIVE' });
      const debits = new Map(plan.legs.filter((leg) => leg.delta < 0n).map((leg) => [leg.userId, -leg.delta]));
      const reclaimed = new Map(taken.map((share) => [share.userId, debits.get(share.userId) ?? 0n]));
      await this.db.setReclaimed(tx, run.id, reclaimed, job.id);
      const status = (await this.db.openShareCount(tx, run.id)) === 0 ? 'REVERSED' : 'PARTIALLY_REVERSED';
      await this.db.markReverted(tx, run.id, status, note, {
        jobId: job.id,
        at: new Date().toISOString(),
        recipients: taken.length,
        payerRefund: job.payerRefund,
        shortfall: job.shortfall,
        reclaimed: formatMinor(plan.reclaimed),
        missing: formatMinor(plan.missing),
        creditedTo: plan.creditedTo === 'none' ? 'NONE' : plan.creditedTo === FEE_ACCOUNT ? 'PLATFORM' : 'PAYER',
      });
      return { taken, plan, status };
    });
    if (!outcome) return false;

    if (onRevokeRewards) {
      await onRevokeRewards(
        run,
        outcome.taken.map((s) => s.userId),
        outcome.status === 'REVERSED',
      );
    }

    const payer = run.kind === 'USER' && run.initiatorId ? [run.initiatorId] : [];
    const affected = [...new Set([...payer, ...outcome.taken.map((s) => s.userId)])];
    this.delivery.toUser(affected, SERVER_EVENTS.RAIN_REVERSED, {
      rainId: run.id,
      currency: run.currency,
      reason: note,
      reclaimed: formatMinor(outcome.plan.reclaimed),
      partial: outcome.status === 'PARTIALLY_REVERSED',
    });

    await this.audit('SYSTEM', job.actorId, 'REVERTED', run.id, note, {
      jobId: job.id,
      status: outcome.status,
      recipients: outcome.taken.length,
      reclaimed: formatMinor(outcome.plan.reclaimed),
      missing: formatMinor(outcome.plan.missing),
    });
    return true;
  }

  // Bulk reverts rains matching a filter in pages
  async bulkRevert(
    job: RainJobRow,
    filter: RainRevertFilter,
    onRevokeRewards?: (run: RainRunRow, userIds: readonly string[], whole: boolean) => Promise<void>,
  ): Promise<void> {
    const progress = { matched: 0, reverted: 0, skipped: 0, failed: 0 };
    const factsCache = new Map<string, EligibilityFacts>();
    const now = await this.db.dbNow();
    const inGroup = async (userId: string): Promise<boolean> => {
      const group = filter.who?.group;
      if (!group) return false;
      let facts = factsCache.get(userId);
      if (!facts) {
        facts = await this.access.factsFor({ id: userId, username: '', publicCode: '', staffRole: null });
        factsCache.set(userId, facts);
      }
      return restrictionTargets(
        { targetType: group.targetType, targetValue: group.value || '0', expiresAt: null },
        { id: userId, username: '', publicCode: '', staffRole: null },
        facts,
        now,
      );
    };
    const picked = async (userId: string) =>
      (filter.who?.userIds.includes(userId) ?? false) || (await inGroup(userId));

    let after: string | null = null;
    for (;;) {
      const page = await this.db.rainsMatching(filter, after, REVERT_PAGE);
      if (page.length === 0) break;
      for (const run of page) {
        after = run.id;
        progress.matched += 1;
        let only: string[] | null = null;
        if (filter.who?.role === 'RAINER') {
          if (!run.initiatorId || !(await picked(run.initiatorId))) {
            progress.skipped += 1;
            continue;
          }
        } else if (filter.who?.role === 'RECIPIENT') {
          only = [];
          for (const share of await this.db.sharesOf(run.id)) {
            if (share.reversedAt === null && (await picked(share.userId))) only.push(share.userId);
          }
          if (only.length === 0) {
            progress.skipped += 1;
            continue;
          }
        }
        try {
          if (await this.revertRain(run, job, only, onRevokeRewards)) progress.reverted += 1;
          else progress.skipped += 1;
        } catch (err: unknown) {
          progress.failed += 1;
          this.logger.warn({ jobId: job.id, rainId: run.id, err }, 'a rain in a bulk revert failed');
        }
      }
      await this.db.jobProgress(job.id, progress);
    }
    await this.db.jobProgress(job.id, progress);
    if (progress.failed > 0) throw new Error(`${progress.failed} of ${progress.matched} rains could not be reverted`);
  }

  private async audit(
    actorType: 'ADMIN' | 'STAFF' | 'USER' | 'SYSTEM',
    actorId: string | null,
    action: string,
    rainId: string | null,
    reason: string | null,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.audit({ actorType, actorId, action, rainId, reason, detail: detail ?? null });
    } catch (err: unknown) {
      this.logger.warn({ action, rainId, err }, 'could not write the rain audit log');
    }
  }
}

