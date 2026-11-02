// Chat SETTINGS "MODERATION Actions: Revert ALL Transfers / Advertisements … [group of users]", the group part: picks
// the gifts and ads whose people are in the admin's group (Premium, KYC or Level ≥ x), then reverts them the usual way
// — gifts become REVERT_PENDING for the gift revert step; ads are cancelled with the unused part refunded ("only for
// Pending / uncompleted views") and their EXP and Stars taken back.
// A job is worked a page at a time inside the money loop's time budget. It keeps where it stopped, so a job over
// thousands of rows carries on in the next pass, and a crashed worker's claim is taken over after the admin's stale time:
// the job resumes from its saved place and nothing is picked twice (marking a gift or cancelling an ad is conditional).
import { Injectable, Logger } from '@nestjs/common';
import { SERVER_EVENTS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import type { ChatUserContext, EligibilityFacts } from '../chat.types';
import { ChatAdDbOperation } from '../persistence/chat.ad.dboperation';
import {
  ChatMoneyRevertDbOperation,
  type MoneyRevertFilter,
  type MoneyRevertJob,
  type MoneyRevertProgress,
} from '../persistence/chat.money-revert.dboperation';
import { ChatDelivery } from '../realtime/chat.delivery';
import { refundForCancel } from './chat.ads.pricing';
import type { MoneyJobConfig } from './chat.money-config';
import { restrictionTargets } from './chat.restrictions.service';

@Injectable()
export class ChatMoneyRevertService {
  private readonly logger = new Logger('ChatMoneyRevertService');

  constructor(
    private readonly jobs: ChatMoneyRevertDbOperation,
    private readonly ads: ChatAdDbOperation,
    private readonly access: ChatAccessService,
    private readonly delivery: ChatDelivery,
  ) {}

  // The queued and interrupted group reverts, as many as fit in the budget.
  async process(config: MoneyJobConfig, until: number): Promise<void> {
    while (Date.now() < until) {
      const job = await this.jobs.claim(config.staleSeconds);
      if (!job) return;
      try {
        const finished =
          job.kind === 'GIFTS' ? await this.gifts(job, config, until) : await this.adsOf(job, config, until);
        if (finished) await this.jobs.finish(job.id, 'DONE', finished, null);
      } catch (err: unknown) {
        this.logger.error({ component: 'ChatMoneyRevertService', err, jobId: job.id }, 'group revert failed');
        await this.jobs.finish(job.id, 'FAILED', null, err instanceof Error ? err.message : 'failed');
      }
    }
  }

  private start(job: MoneyRevertJob): MoneyRevertProgress {
    return job.progress ?? { after: null, totals: {} };
  }

  // Counts a page into the totals.
  private add(progress: MoneyRevertProgress, counts: Record<string, number>): void {
    for (const [name, n] of Object.entries(counts)) progress.totals[name] = (progress.totals[name] ?? 0) + n;
  }

  // Returns the result when the job is complete, or null after saving where it stopped (out of time).
  private async gifts(job: MoneyRevertJob, config: MoneyJobConfig, until: number): Promise<Record<string, number> | null> {
    const inGroup = this.groupCheck(job.filter);
    const progress = this.start(job);
    for (;;) {
      const page = await this.jobs.giftCandidates(job.filter, progress.after, config.pageSize);
      const picked: string[] = [];
      for (const gift of page) {
        if ((await inGroup(gift.senderId)) || (await inGroup(gift.recipientId))) picked.push(gift.id);
      }
      const marked = await this.jobs.markGifts(picked, job.filter.refundFees === true, job.createdBy);
      this.add(progress, { candidates: page.length, inGroup: picked.length, marked });
      const last = page[page.length - 1];
      if (last) progress.after = { createdAt: last.createdAt, id: last.id };
      if (page.length < config.pageSize) return progress.totals;
      if (Date.now() >= until) {
        await this.jobs.saveProgress(job.id, progress);
        return null;
      }
    }
  }

  private async adsOf(job: MoneyRevertJob, config: MoneyJobConfig, until: number): Promise<Record<string, number> | null> {
    const inGroup = this.groupCheck(job.filter);
    const progress = this.start(job);
    for (;;) {
      const page = await this.jobs.adCandidates(job.filter, progress.after, config.pageSize);
      const picked: string[] = [];
      let stopped = 0;
      for (const candidate of page) {
        if (!candidate.creatorId || !(await inGroup(candidate.creatorId))) continue;
        picked.push(candidate.id);
        if (candidate.status !== 'ACTIVE' && candidate.status !== 'PAUSED') continue;
        const result = await this.ads.cancel(candidate.id, job.createdBy, job.filter.note ?? 'Reverted by admin', (ad, shown) =>
          ad.chargeReference ? refundForCancel(ad, shown) : null,
        );
        if (!result.cancelled) continue;
        stopped += 1;
        for (const roomId of result.unpinnedRoomIds) {
          this.delivery.toRoom(roomId, SERVER_EVENTS.AD_UNPINNED, { roomId, adId: candidate.id });
        }
      }
      const rewardsReverted = await this.jobs.markAdRewardsRevert(picked);
      this.add(progress, { candidates: page.length, inGroup: picked.length, stopped, rewardsReverted });
      const last = page[page.length - 1];
      if (last) progress.after = { createdAt: last.createdAt, id: last.id };
      if (page.length < config.pageSize) return progress.totals;
      if (Date.now() >= until) {
        await this.jobs.saveProgress(job.id, progress);
        return null;
      }
    }
  }

  // Whether a user is in the filter's group, by the same rule as a group restriction; facts read once per user.
  private groupCheck(filter: MoneyRevertFilter): (userId: string) => Promise<boolean> {
    const cache = new Map<string, boolean>();
    const now = new Date();
    return async (userId: string) => {
      const known = cache.get(userId);
      if (known !== undefined) return known;
      const person: ChatUserContext = { id: userId, username: '', publicCode: '', staffRole: null };
      const facts: EligibilityFacts = await this.access.factsFor(person);
      const yes = restrictionTargets(
        { targetType: filter.group.targetType, targetValue: filter.group.value, expiresAt: null },
        person,
        facts,
        now,
      );
      cache.set(userId, yes);
      return yes;
    };
  }
}
