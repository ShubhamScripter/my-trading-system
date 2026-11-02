import { randomInt, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../db/client';
import { ProblemException } from '../../http';
import { uuidv7 } from '../../utils/public.utils';
import { GLOBAL_ROOM_ID, SERVER_EVENTS, SYSTEM_AUTHOR_ID } from '../chat/chat.constants';
import { ChatAccessService } from '../chat/chat.access.service';
import { ChatDelivery } from '../chat/realtime/chat.delivery';
import { ChatBus } from '../chat/realtime/chat.bus';
import {
  durationSeconds,
  effectiveStatus,
  type RainConfig,
} from './rain.contract';
import { RainDbOperation } from './rain.dboperation';
import {
  desiredRecipientCount,
  distribute,
  formatMinor,
  parseMinor,
  randomMinor,
  usdToMinor,
  type RainShare,
} from './rain.math';
import { RainPorts } from './rain.ports';
import type { NextRain, RainJobRow, RainRunRow, RainSchedule } from './rain.types';
import { RainPayoutService } from './rain.payout.service';
import { RainRevertService } from './rain.revert.service';
import { RainSelectionService } from './rain.selection.service';
import { RainSeriesService } from './rain.series.service';
import { RainWallet } from './rain.wallet';

const FEE_ACCOUNT = SYSTEM_AUTHOR_ID;

export interface SystemPot {
  readonly currency: string;
  readonly pot: bigint | null;
  readonly usd: bigint;
}

@Injectable()
export class RainSchedulerService {
  private readonly logger = new Logger('RainSchedulerService');
  private walletNoted = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: RainDbOperation,
    private readonly wallet: RainWallet,
    private readonly access: ChatAccessService,
    private readonly delivery: ChatDelivery,
    private readonly bus: ChatBus,
    private readonly rainPorts: RainPorts,
    private readonly selection: RainSelectionService,
    private readonly payout: RainPayoutService,
    private readonly series: RainSeriesService,
    private readonly revert: RainRevertService,
  ) {}

  // Executes periodic scheduler passes
  async tick(): Promise<void> {
    const expired = await this.db.expireVerifications();
    for (const run of expired) await this.audit('SYSTEM', run.initiatorId, 'VERIFICATION_EXPIRED', run.id, null);
    await this.applyScheduledStatus();
    if (!this.wallet.available()) {
      if (!this.walletNoted) {
        this.walletNoted = true;
        this.logger.warn('rain tick is idle: RAIN_DEV_WALLET is off and no ledger is connected');
      }
      return;
    }
    await this.db.recoverStaleJobs();
    for (let i = 0; i < 5; i += 1) {
      const job = await this.db.claimJob();
      if (!job) break;
      await this.runJob(job);
    }
    const repeat = await this.db.claimRepeat();
    if (repeat) await this.series.runRepeat(repeat);
    await this.runSystemIfDue();
  }

  // Applies scheduled status changes when due
  async applyScheduledStatus(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      const due = await this.db.claimDueStatusChange();
      if (!due) return;
      if (!due.patch) {
        await this.db.failStatusChange(due.id, 'The stored change is not a valid status change');
        continue;
      }
      try {
        const { before, after } = await this.db.patchStatus(due.patch);
        await this.audit('SYSTEM', due.createdBy, 'SCHEDULED_STATUS_APPLIED', null, null, { changeId: due.id, before, after });
        this.bus.publish({ kind: 'rain' });
        await this.announceSchedule();
      } catch (err: unknown) {
        await this.db.failStatusChange(due.id, err instanceof Error ? err.message : 'failed');
      }
    }
  }

  // Executes due system rain
  async runSystemIfDue(): Promise<void> {
    const cfg = await this.db.config();
    const on = effectiveStatus(cfg, 'system') === 'ON';
    if (!on) {
      const hadSchedule = (await this.db.nextRainAt()) !== null;
      if (hadSchedule && (await this.db.clearSchedule())) await this.announceSchedule();
      return;
    }
    if (on && (await this.db.nextRainAt()) === null) {
      if (await this.db.setNextIfEmpty(await this.pickNext(cfg))) await this.announceSchedule();
    }
    const owner = `${process.pid}:${randomUUID()}`;
    const due = await this.db.claimSystemLock(owner);
    if (!due) return;
    try {
      const key = `system:${due.toISOString()}`;
      const existing = await this.db.findByKey(key);
      if (existing) {
        await this.payout.afterPaid(existing);
      } else {
        const chosen = await this.db.schedule();
        let paid: 'skip' | 'paid' = 'skip';
        try {
          paid = await this.trySystemPay(cfg, key, chosen);
        } catch (err: unknown) {
          if (!(err instanceof ProblemException)) throw err;
          this.logger.warn({ err }, 'system rain skipped: the wallet refused the payment');
          await this.audit('SYSTEM', null, 'SYSTEM_SKIPPED', null, err.message, {
            currency: chosen.currency,
            pot: chosen.potMinor !== null ? formatMinor(chosen.potMinor) : null,
          });
        }
        if (paid === 'paid') await this.payout.afterPaid((await this.db.findByKey(key))!);
      }
      await this.db.advanceSchedule(owner, await this.pickNext(cfg));
      await this.announceSchedule();
    } catch (err: unknown) {
      await this.db.releaseLock(owner);
      throw err;
    }
  }

  // Picks random interval, currency and amount for next scheduled rain
  async pickNext(cfg: RainConfig): Promise<NextRain> {
    const seconds = randomInt(
      durationSeconds(cfg.system.interval.min),
      durationSeconds(cfg.system.interval.max) + 1,
    );
    const at = new Date(Date.now() + seconds * 1000);
    const picked = await this.pickPot(cfg);
    return { at, currency: picked?.currency ?? null, potMinor: picked?.pot ?? null, potUsdMinor: picked?.usd ?? null };
  }

  async pickPot(cfg: RainConfig): Promise<SystemPot | null> {
    if (cfg.system.currencies.length === 0) return null;
    const currency = cfg.system.currencies[randomInt(cfg.system.currencies.length)]!;
    const min = parseMinor(cfg.system.amountUsd.min);
    const max = parseMinor(cfg.system.amountUsd.max);
    if (min === null || max === null || max < min) return null;
    const usd = randomMinor(min, max, () => randomInt(256));
    const price = await this.rainPorts.usdPrice(currency);
    const pot = price === null ? null : usdToMinor(usd, price, 'down');
    return { currency, pot: pot !== null && pot > 0n ? pot : null, usd };
  }

  async announceSchedule(): Promise<void> {
    const [cfg, schedule] = await Promise.all([this.db.config(), this.db.schedule()]);
    const system = effectiveStatus(cfg, 'system');
    const on = system === 'ON';
    this.delivery.toAll(SERVER_EVENTS.RAIN_STATE, {
      systemStatus: system,
      userStatus: effectiveStatus(cfg, 'user'),
      note: cfg.status.note,
      nextRainAt: on ? (schedule.nextRainAt?.toISOString() ?? null) : null,
      scheduledAt: on ? (schedule.scheduledAt?.toISOString() ?? null) : null,
      nextCurrency: on ? schedule.currency : null,
      nextPot: on && schedule.potMinor !== null ? formatMinor(schedule.potMinor) : null,
      nextPotUsd: on && schedule.potUsdMinor !== null ? formatMinor(schedule.potUsdMinor) : null,
    });
  }

  async trySystemPay(
    cfg: RainConfig,
    key: string,
    chosen: RainSchedule | null,
    manual: RainJobRow['manualSystem'] = null,
  ): Promise<'skip' | 'paid'> {
    const min = parseMinor(cfg.system.amountUsd.min) ?? 0n;
    const max = parseMinor(cfg.system.amountUsd.max) ?? 0n;
    let picked: SystemPot | null = null;
    if (manual) {
      const usd = parseMinor(manual.usdAmount);
      const price = await this.rainPorts.usdPrice(manual.currency);
      const pot = usd === null || price === null ? null : usdToMinor(usd, price, 'down');
      if (!cfg.system.currencies.includes(manual.currency) || usd === null || pot === null || pot <= 0n || usd < min || usd > max) {
        throw new Error('Manual system rain currency or USD amount is outside the admin settings');
      }
      picked = { currency: manual.currency, pot, usd };
    } else if (
      chosen?.currency &&
      chosen.potMinor !== null &&
      chosen.potUsdMinor !== null &&
      cfg.system.currencies.includes(chosen.currency) &&
      chosen.potUsdMinor >= min &&
      chosen.potUsdMinor <= max
    ) {
      picked = { currency: chosen.currency, pot: chosen.potMinor, usd: chosen.potUsdMinor };
    } else {
      picked = await this.pickPot(cfg);
    }
    if (!picked) {
      this.logger.warn('system rain skipped: no currency is configured');
      await this.audit('SYSTEM', null, 'SYSTEM_SKIPPED', null, 'no currency is configured');
      return 'skip';
    }
    if (picked.pot === null) {
      this.logger.warn({ currency: picked.currency }, 'system rain skipped: no USD price');
      await this.audit('SYSTEM', null, 'SYSTEM_SKIPPED', null, `no USD price for ${picked.currency}`);
      return 'skip';
    }
    const pot = picked.pot;
    const room = await this.access.requireRoom(manual?.roomId ?? cfg.system.roomId ?? GLOBAL_ROOM_ID);
    const people = await this.selection.eligible(room, null);
    const wanted = manual?.recipients ?? desiredRecipientCount(
      cfg.system.recipients.mode,
      people.length,
      cfg.system.recipients.count,
      cfg.system.recipients.percent,
      cfg.system.threshold,
    );
    if (wanted < 1 || (manual !== null && people.length < wanted)) {
      this.logger.warn({ eligible: people.length }, 'system rain skipped: nobody eligible is online');
      await this.audit('SYSTEM', null, 'SYSTEM_SKIPPED', null, 'nobody eligible is online', { eligible: people.length });
      return 'skip';
    }
    const recipients = this.selection.shuffle(people).slice(0, wanted);
    const shares = distribute(pot, recipients, cfg.system.allocation);
    if (shares.length === 0 || shares.reduce((sum, share) => sum + share.amount, 0n) !== pot) {
      this.logger.warn('system rain skipped: the pot is too small to split across the recipients');
      await this.audit('SYSTEM', null, 'SYSTEM_SKIPPED', null, 'pot too small to split', { recipients: wanted });
      return 'skip';
    }
    const price = await this.rainPorts.usdPrice(picked.currency);
    const run: RainRunRow & { shares: RainShare[] } = {
      id: uuidv7(),
      kind: 'SYSTEM',
      status: 'COMPLETED',
      roomId: room.id,
      initiatorId: null,
      currency: picked.currency,
      potMinor: pot,
      feeMinor: 0n,
      distributableMinor: pot,
      idempotencyKey: key,
      messageId: null,
      requestedRecipients: shares.length,
      recipientRule: null,
      usdPriceMinor: price,
      usdValueMinor: picked.usd,
      shares,
    };
    this.wallet.refuseIfUnavailable();
    await this.prisma.$transaction(async (tx) => {
      await this.wallet.ensurePayer(tx, FEE_ACCOUNT, run.currency);
      await this.wallet.apply(tx, this.payout.legsOf(run, FEE_ACCOUNT), run.currency, {
        allowNegative: this.wallet.systemPoolUnlimited(),
      });
      await this.db.insertRun(tx, { ...run, recipientCount: run.shares.length });
      await this.db.insertShares(tx, run.id, run.shares);
    });
    await this.audit('SYSTEM', null, 'SYSTEM_PAID', run.id, null, {
      pot: formatMinor(pot),
      usd: formatMinor(picked.usd),
      currency: run.currency,
      recipients: shares.length,
      eligible: people.length,
    });
    return 'paid';
  }

  async runJob(job: RainJobRow): Promise<void> {
    try {
      if (job.kind === 'MANUAL_SYSTEM') {
        if (!job.manualSystem) throw new Error('Manual system rain is missing the admin choices');
        const cfg = await this.db.config();
        if (effectiveStatus(cfg, 'system') !== 'ON') throw new Error('Rainpool is not ON');
        const key = `manual:${job.id}`;
        const existing = await this.db.findByKey(key);
        if (existing) {
          await this.payout.afterPaid(existing);
        } else {
          const result = await this.trySystemPay(cfg, key, null, job.manualSystem);
          if (result === 'skip') throw new Error('Nobody eligible is online, no currency is configured, or no USD price');
          const run = await this.db.findByKey(key);
          if (run) await this.payout.afterPaid(run);
        }
      } else if (job.kind === 'REVERT') {
        if (job.rainId) {
          const run = await this.db.findById(job.rainId);
          if (!run) throw new Error('Rain not found');
          const done = await this.revert.revertRain(run, job, null, (r, u, w) => this.payout.revokeRewards(r, u, w));
          if (!done && (await this.db.findById(run.id))?.status !== 'REVERSED') {
            throw new Error('Only a completed rain with shares left can be reverted');
          }
        } else if (job.filter) {
          await this.revert.bulkRevert(job, job.filter, (r, u, w) => this.payout.revokeRewards(r, u, w));
        } else {
          throw new Error('A revert needs a rain or a filter');
        }
      } else {
        if (!job.rainId) throw new Error('Missing rain id');
        const run = await this.db.findById(job.rainId);
        if (!run) throw new Error('Rain not found');
        if (job.kind === 'REJECT') {
          if ((await this.db.rejectReview(run.id, job.reason, job.actorId)) !== true) {
            throw new Error('Only a rain waiting for review can be rejected');
          }
          if (run.initiatorId) {
            this.delivery.toUser(run.initiatorId, SERVER_EVENTS.RAIN_REVIEWED, {
              rainId: run.id,
              decision: 'REJECT',
              reason: job.reason,
            });
            await this.log('RAIN_REJECTED', run.initiatorId, run.roomId, { rainId: run.id, why: 'ADMIN' }, job.reason);
          }
        } else {
          if (run.status === 'PENDING_REVIEW') await this.approve(run);
          else if (run.status !== 'COMPLETED') throw new Error('Only a rain waiting for review can be approved');
          if (run.initiatorId) {
            this.delivery.toUser(run.initiatorId, SERVER_EVENTS.RAIN_REVIEWED, { rainId: run.id, decision: 'APPROVE' });
          }
          await this.payout.afterPaid((await this.db.findById(run.id))!);
        }
      }
      await this.db.finishJob(job.id, 'DONE', null);
      await this.audit('SYSTEM', job.actorId, `JOB_${job.kind}_DONE`, job.rainId, job.reason);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Rain job failed';
      this.logger.warn({ jobId: job.id, err }, 'rain job failed');
      await this.db.finishJob(job.id, 'FAILED', message);
      await this.audit('SYSTEM', job.actorId, `JOB_${job.kind}_FAILED`, job.rainId, message);
    }
  }

  async approve(run: RainRunRow): Promise<void> {
    if (!run.initiatorId) throw new Error('A user rain has no initiator');
    const shares = await this.db.sharesOf(run.id);
    const payerId = run.initiatorId;
    this.wallet.refuseIfUnavailable();
    const count = await this.prisma.$executeRaw`
      UPDATE rain.runs SET status = 'COMPLETED'
      WHERE id = ${run.id}::uuid AND status = 'PENDING_REVIEW'
    `;
    if (count !== 1) throw new Error('Rain was no longer waiting for review');
    if (run.repeatCount && run.repeatGapSeconds) {
      await this.series.scheduleRepeatOf(
        payerId,
        {
          id: run.id,
          room: await this.access.requireRoom(run.roomId),
          currency: run.currency,
          pot: run.potMinor,
          rule: run.recipientRule ?? { mode: 'SPECIFIC', count: shares.length },
          repeatCount: run.repeatCount,
          repeatGapSeconds: run.repeatGapSeconds,
        },
        shares.length,
      );
    }
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

  private async log(
    action: string,
    users: string | readonly string[],
    roomId: string | null,
    detail: Record<string, unknown>,
    note?: string | null,
  ): Promise<void> {
    const ids = typeof users === 'string' ? [users] : users;
    try {
      await this.db.botLog(ids.map((userId) => ({ action, userId, roomId, detail, note: note ?? null })));
    } catch (err: unknown) {
      this.logger.warn({ action, err }, 'could not write the rain bot log');
    }
  }
}

