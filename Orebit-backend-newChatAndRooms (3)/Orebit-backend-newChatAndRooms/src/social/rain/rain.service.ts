import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../db/client';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { uuidv7 } from '../../utils/public.utils';
import { ChatAccessService } from '../chat/chat.access.service';
import { CHAT_REFUSAL_REASONS } from '../chat/chat.constants';
import { refuse } from '../chat/chat.moderation.service';
import { ChatPorts } from '../chat/chat.ports';
import type { ChatUserContext } from '../chat/chat.types';
import {
  durationSeconds,
  effectiveStatus,
  type RainAmountLimit,
  type RainConfig,
} from './rain.contract';
import {
  RainDbOperation,
  type RainRunRow,
} from './rain.dboperation';
import {
  applyFee,
  distribute,
  formatMinor,
  minorToUsd,
  parseMinor,
  percentToBps,
  usdToMinor,
  userRecipientCount,
  type RainPerson,
  type RainShare,
  type RecipientRule,
} from './rain.math';
import { RainPorts } from './rain.ports';
import { needsUsdValue } from './rain.security';
import { RainWallet } from './rain.wallet';
import { RainSelectionService } from './rain.selection.service';
import { RainPayoutService } from './rain.payout.service';
import { RainSeriesService, type UserRainSeed } from './rain.series.service';
import { RainSchedulerService } from './rain.scheduler.service';
import { RainRevertService } from './rain.revert.service';

export interface RainRequestContext {
  readonly sessionId: string;
  readonly ipClass: string;
  readonly country: string | null;
  readonly anonymised: boolean;
}

export interface UserRainInput {
  readonly roomId: string;
  readonly currency: string;
  readonly pot: bigint;
  readonly recipients: RecipientRule;
  readonly repeatCount: number | null;
  readonly repeatGapSeconds: number | null;
  readonly clientMessageId?: string;
  readonly ip?: string;
  readonly context?: RainRequestContext;
}

export interface UserRainResult {
  readonly rainId: string;
  readonly status: RainRunRow['status'];
  readonly currency: string;
  readonly pot: string;
  readonly fee: string;
  readonly distributable: string;
  readonly recipients: number;
  readonly shares: { username: string | null; amount: string; tier: string }[];
  readonly verification?: unknown;
  readonly repeat?: { count: number; gapSeconds: number };
  readonly messageId?: string;
}

export interface ConfirmInput {
  readonly rainId: string;
  readonly totpCode?: string;
  readonly emailCode?: string;
  readonly answers?: number[];
}

@Injectable()
export class RainService {
  private readonly logger = new Logger('RainService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: RainDbOperation,
    private readonly wallet: RainWallet,
    private readonly access: ChatAccessService,
    private readonly chatPorts: ChatPorts,
    private readonly rainPorts: RainPorts,
    private readonly selection: RainSelectionService,
    private readonly payout: RainPayoutService,
    private readonly series: RainSeriesService,
    private readonly scheduler: RainSchedulerService,
    private readonly revertService: RainRevertService,
  ) {}

  private cachedState: { expiresAt: number; value: unknown } | null = null;

  invalidateStateCache(): void {
    this.cachedState = null;
  }

  // Returns public state of rain countdown and active pot with 2s cache
  async publicState() {
    const now = Date.now();
    if (this.cachedState && now < this.cachedState.expiresAt) {
      return this.cachedState.value;
    }
    const [cfg, schedule] = await Promise.all([this.db.config(), this.db.schedule()]);
    const system = effectiveStatus(cfg, 'system');
    const on = system === 'ON';
    const delta =
      schedule.scheduledAt && schedule.nextRainAt
        ? schedule.nextRainAt.getTime() - schedule.scheduledAt.getTime()
        : 0;
    const fillPercent =
      on && delta > 0 && schedule.scheduledAt
        ? Math.min(
            100,
            Math.max(
              0,
              Math.round(((now - schedule.scheduledAt.getTime()) / delta) * 100),
            ),
          )
        : 0;

    const result = {
      systemStatus: system,
      userStatus: effectiveStatus(cfg, 'user'),
      note: cfg.status.note,
      nextRainAt: on ? (schedule.nextRainAt?.toISOString() ?? null) : null,
      scheduledAt: on ? (schedule.scheduledAt?.toISOString() ?? null) : null,
      nextCurrency: on ? schedule.currency : null,
      nextPot: on && schedule.potMinor !== null ? formatMinor(schedule.potMinor) : null,
      nextPotUsd: on && schedule.potUsdMinor !== null ? formatMinor(schedule.potUsdMinor) : null,
      fillPercent,
      userRules: {
        allowedCurrencies: cfg.user.currencies.all ? 'ALL' : cfg.user.currencies.codes,
        allowedChannels: cfg.user.channels.all ? 'ALL' : cfg.user.channels.roomIds,
        allowedRecipientModes: cfg.user.recipients.modes,
        autoRepeat: cfg.user.autoRepeat.enabled,
        feePercent: cfg.user.feePercent,
      },
    };
    this.cachedState = { expiresAt: now + 2000, value: result };
    return result;
  }

  // Returns amount limits for a currency
  async limits(currency: string) {
    const cfg = await this.db.config();
    const code = currency.trim().toUpperCase();
    const allowed = cfg.user.currencies.all || cfg.user.currencies.codes.includes(code);
    const price = await this.rainPorts.usdPrice(code);
    const limits = allowed ? this.amountLimits(cfg, code, price) : null;
    return {
      currency: code,
      allowed,
      usdPrice: price === null ? null : formatMinor(price),
      min: limits && typeof limits !== 'string' ? formatMinor(limits.min) : null,
      max: limits && typeof limits !== 'string' ? formatMinor(limits.max) : null,
      problem: !allowed ? `${code} is not enabled for user rain` : typeof limits === 'string' ? limits : null,
      feePercent: cfg.user.feePercent,
      recipients: cfg.user.recipients,
    };
  }

  async history(limit: number) {
    return this.db.publicHistory(limit);
  }

  async mine(userId: string, limit: number) {
    const [sent, received, repeats] = await Promise.all([
      this.db.sentBy(userId, limit),
      this.db.receivedBy(userId, limit),
      this.db.repeatsOf(userId),
    ]);
    return { sent, received, repeats };
  }

  async pending(userId: string): Promise<UserRainResult[]> {
    const runs = await this.db.sentBy(userId, 50);
    const pendingRuns = runs.filter((r) => r.status === 'PENDING_VERIFICATION' || r.status === 'PENDING_REVIEW');
    const fullRuns = await Promise.all(pendingRuns.map((r) => this.db.findById(r.id)));
    return fullRuns.filter((r): r is RainRunRow => r !== null).map((r) => this.answer(r));
  }

  async balances(userId: string): Promise<{ currency: string; balance: string }[]> {
    const cfg = await this.db.config();
    const coins = cfg.user.currencies.all ? await this.rainPorts.currencyCodes() : cfg.user.currencies.codes;
    if (!coins) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
        'The wallet currency list is not connected',
      );
    }
    const balances = await Promise.all(
      coins.map(async (c) => ({
        currency: c,
        balance: formatMinor(await this.wallet.spendable(this.prisma, userId, c)),
      })),
    );
    return balances;
  }

  async cancelRepeat(user: ChatUserContext, repeatId: string): Promise<{ cancelled: boolean }> {
    const count = await this.db.cancelRepeat(repeatId, user.id);
    if (count === 0) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Repeat series not found or already finished' });
    }
    await this.db.audit({ actorType: 'USER', actorId: user.id, action: 'REPEAT_CANCELLED', rainId: null, reason: null, detail: { repeatId } });
    return { cancelled: true };
  }

  // Executes the user rain /rain command
  async executeUserCommand(user: ChatUserContext, input: UserRainInput): Promise<UserRainResult> {
    const room = await this.access.requireRoom(input.roomId);
    const access = await this.access.evaluate(user, room);
    if (!access.isEligibleToWrite) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.ROOM_READ_ONLY, access.reason ?? 'You cannot write in this room', {
        roomId: room.id,
      });
    }

    const cfg = await this.db.config();
    this.assertUserRainOn(cfg);
    const entitled = await this.chatPorts.rainEntitlements(user.id);
    if (entitled && !entitled.canRain) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, 'Your KYC level does not allow raining');
    }
    if (!cfg.user.currencies.all && !cfg.user.currencies.codes.includes(input.currency)) {
      throw invalid(`${input.currency} is not enabled for user rain`);
    }
    if (!cfg.user.channels.all && !cfg.user.channels.roomIds.includes(room.id)) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.COMMAND_NOT_ALLOWED_HERE, 'Raining is not allowed in this room', {
        roomId: room.id,
      });
    }
    if (!cfg.user.recipients.modes.includes(input.recipients.mode)) {
      throw invalid(`Raining on ${describeRule(input.recipients)} is not allowed. Use ${cfg.user.recipients.modes.map(ruleExample).join(', ')}.`);
    }

    const price = await this.rainPorts.usdPrice(input.currency);
    const limits = this.amountLimits(cfg, input.currency, price);
    if (typeof limits === 'string') throw invalid(limits);
    if (input.pot < limits.min || input.pot > limits.max) {
      throw invalid(`Amount must be between ${formatMinor(limits.min)} and ${formatMinor(limits.max)} ${input.currency}`);
    }
    this.assertRepeat(cfg, input.repeatCount, input.repeatGapSeconds);
    const usdValue = price === null ? null : minorToUsd(input.pot, price);
    if (usdValue === null && needsUsdValue(cfg)) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
        `There is no USD price for ${input.currency} right now, so this rain cannot be checked. Nothing was sent.`,
      );
    }

    const key = `user:${user.id}:${input.clientMessageId ?? uuidv7()}`;
    const existing = await this.db.findByKey(key);
    if (existing) return this.answer(existing);

    const priced = applyFee(input.pot, percentToBps(cfg.user.feePercent));
    this.wallet.refuseIfUnavailable();
    const spendable = await this.wallet.spendable(this.prisma, user.id, input.currency);
    if (spendable < input.pot) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
        `Not enough ${input.currency}: you have ${formatMinor(spendable)}. Nothing was sent.`,
      );
    }

    const people = await this.selection.eligible(room, user.id);
    const count = userRecipientCount(input.recipients, people.length, cfg.user.recipients);
    if (typeof count === 'string') throw invalid(`${count}. Nothing was sent.`);
    if (priced.distributable < BigInt(count)) {
      throw invalid('Amount is too small to split across that many people after the fee. Nothing was sent.');
    }

    const seed: UserRainSeed = {
      id: uuidv7(),
      room,
      currency: input.currency,
      pot: input.pot,
      rule: input.recipients,
      repeatCount: input.repeatCount,
      repeatGapSeconds: input.repeatGapSeconds,
    };

    return this.settle(user, seed, priced, count, key, price, usdValue, cfg, people);
  }

  private async settle(
    user: ChatUserContext,
    seed: UserRainSeed,
    priced: { fee: bigint; distributable: bigint },
    recipientCount: number,
    key: string,
    price: bigint | null,
    usdValue: bigint | null,
    cfg: RainConfig,
    people: RainPerson[],
  ): Promise<UserRainResult> {
    const chosen = this.selection.shuffle(people).slice(0, recipientCount);
    const shares = distribute(priced.distributable, chosen, cfg.user.allocation);
    if (shares.length !== chosen.length) {
      throw invalid('Amount is too small to split across that many people. Nothing was sent.');
    }

    const run: RainRunRow & { shares: RainShare[] } = {
      id: seed.id,
      kind: 'USER',
      status: 'COMPLETED',
      roomId: seed.room.id,
      initiatorId: user.id,
      currency: seed.currency,
      potMinor: seed.pot,
      feeMinor: priced.fee,
      distributableMinor: priced.distributable,
      idempotencyKey: key,
      messageId: null,
      requestedRecipients: recipientCount,
      recipientRule: seed.rule,
      repeatCount: seed.repeatCount ?? null,
      repeatGapSeconds: seed.repeatGapSeconds ?? null,
      usdPriceMinor: price,
      usdValueMinor: usdValue,
      shares,
    };

    this.wallet.refuseIfUnavailable();
    await this.prisma.$transaction(async (tx) => {
      await this.wallet.ensurePayer(tx, user.id, seed.currency);
      await this.wallet.apply(tx, this.payout.legsOf(run, user.id), seed.currency);
      await this.db.insertRun(tx, { ...run, recipientCount: run.shares.length });
      await this.db.insertShares(tx, run.id, run.shares);
    });

    await this.db.audit({
      actorType: 'USER',
      actorId: user.id,
      action: 'PAID',
      rainId: seed.id,
      reason: null,
      detail: { pot: formatMinor(seed.pot), currency: seed.currency },
    });
    this.invalidateStateCache();
    await this.series.scheduleRepeatOf(user.id, seed, shares.length);
    return (await this.payout.afterPaid((await this.db.findById(seed.id))!)) as UserRainResult;
  }

  async confirm(user: ChatUserContext, input: ConfirmInput): Promise<UserRainResult> {
    const run = await this.db.findById(input.rainId);
    if (!run || run.initiatorId !== user.id || run.kind !== 'USER') {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Rain not found' });
    }
    return this.answer(run);
  }

  async resendCode(_user: ChatUserContext, _rainId: string, _ip: string): Promise<{ sent: boolean }> {
    return { sent: true };
  }

  async cancel(user: ChatUserContext, rainId: string): Promise<{ cancelled: true }> {
    if (!(await this.db.expireOne(rainId, user.id))) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Pending rain not found' });
    }
    await this.db.audit({
      actorType: 'USER',
      actorId: user.id,
      action: 'CANCELLED',
      rainId,
      reason: null,
      detail: { status: 'EXPIRED' },
    });
    return { cancelled: true };
  }

  async tick(): Promise<void> {
    return this.scheduler.tick();
  }

  private amountLimits(cfg: RainConfig, currency: string, price: bigint | null): { min: bigint; max: bigint } | string {
    const side = (limit: RainAmountLimit, round: 'up' | 'down'): bigint | string => {
      if (limit.mode === 'USD') {
        if (price === null) return `There is no USD price for ${currency} right now, so its rain limits are unknown`;
        const usd = parseMinor(limit.usd);
        const amount = usd === null ? null : usdToMinor(usd, price, round);
        return amount === null ? `The rain limits of ${currency} are not valid` : amount;
      }
      const own = limit.perCurrency.find((c) => c.code === currency);
      const amount = own ? parseMinor(own.amount) : null;
      return amount ?? `No rain limit is set for ${currency}`;
    };
    const min = side(cfg.user.minAmount, 'up');
    if (typeof min === 'string') return min;
    const max = side(cfg.user.maxAmount, 'down');
    if (typeof max === 'string') return max;
    const floor = min < 1n ? 1n : min;
    if (max < floor) return `The rain limits of ${currency} leave no amount that can be rained`;
    return { min: floor, max };
  }

  private assertUserRainOn(cfg: RainConfig): void {
    const status = effectiveStatus(cfg, 'user');
    if (status === 'ON') return;
    const note = cfg.status.note ? `: ${cfg.status.note}` : '';
    throw refuse(
      ERR.FORBIDDEN,
      status === 'MAINTENANCE' ? CHAT_REFUSAL_REASONS.FEATURE_MAINTENANCE : CHAT_REFUSAL_REASONS.FEATURE_DISABLED,
      status === 'MAINTENANCE' ? `User rain is under maintenance${note}` : 'User rain is turned off',
    );
  }

  private assertRepeat(cfg: RainConfig, repeatCount: number | null, repeatGapSeconds: number | null): void {
    if (repeatCount === null && repeatGapSeconds === null) return;
    const repeat = cfg.user.autoRepeat;
    if (!repeat.enabled) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.FEATURE_DISABLED, 'Auto-repeat is turned off');
    }
    const count = repeatCount ?? 0;
    const gap = repeatGapSeconds ?? 0;
    if (count < repeat.minCount || count > repeat.maxCount) {
      throw invalid(`Repeat count must be between ${repeat.minCount} and ${repeat.maxCount}`);
    }
    const lo = durationSeconds(repeat.minGap);
    const hi = durationSeconds(repeat.maxGap);
    if (gap < lo || gap > hi) {
      throw invalid(`Repeat gap must be between ${lo} and ${hi} seconds`);
    }
  }

  private answer(run: RainRunRow): UserRainResult {
    return {
      rainId: run.id,
      status: run.status,
      currency: run.currency,
      pot: formatMinor(run.potMinor),
      fee: formatMinor(run.feeMinor),
      distributable: formatMinor(run.distributableMinor),
      recipients: run.requestedRecipients ?? 0,
      shares: [],
      repeat: run.repeatCount && run.repeatGapSeconds ? { count: run.repeatCount, gapSeconds: run.repeatGapSeconds } : undefined,
      messageId: run.messageId ?? undefined,
    };
  }
}

function invalid(message: string): ProblemException {
  return new ProblemException({ type: ERR.VALIDATION_FAILED, errors: [{ path: 'content', message }] });
}

function describeRule(rule: RecipientRule): string {
  if (rule.mode === 'ALL') return 'all active users';
  if (rule.mode === 'PERCENT') return `${rule.percent}% of active users`;
  return 'a specific number of users';
}

function ruleExample(mode: RecipientRule['mode']): string {
  if (mode === 'ALL') return '"all"';
  if (mode === 'PERCENT') return '"10%"';
  return 'a number';
}
