import { Injectable, Logger } from '@nestjs/common';
import { SERVER_EVENTS, SYSTEM_AUTHOR_ID } from '../chat/chat.constants';
import { ChatFeaturePorts } from '../chat/chat.feature-ports';
import { ChatService } from '../chat/chat.service';
import { ChatDelivery } from '../chat/realtime/chat.delivery';
import { RainDbOperation } from './rain.dboperation';
import { formatMinor, minorToUsd, rainReward, type LedgerLeg, type RainShare } from './rain.math';
import type { RainRewardsRecord, RainRunRow } from './rain.types';
import { RainWallet } from './rain.wallet';

const FEE_ACCOUNT = SYSTEM_AUTHOR_ID;

@Injectable()
export class RainPayoutService {
  private readonly logger = new Logger('RainPayoutService');

  constructor(
    private readonly db: RainDbOperation,
    private readonly wallet: RainWallet,
    private readonly chat: ChatService,
    private readonly delivery: ChatDelivery,
    private readonly featurePorts: ChatFeaturePorts,
  ) {}

  // Executes actions after a rain transaction has committed
  async afterPaid(run: RainRunRow): Promise<{
    rainId: string;
    status: RainRunRow['status'];
    currency: string;
    pot: string;
    fee: string;
    distributable: string;
    recipients: number;
    shares: { username: string | null; amount: string; tier: string }[];
    messageId?: string;
  }> {
    const shares = await this.db.sharesOf(run.id);
    const usernames = await this.db.usernamesByIds(shares.map((share) => share.userId));
    let messageId = run.messageId ?? undefined;
    if (!messageId) {
      const who = run.kind === 'SYSTEM' ? 'Rainpool' : 'Rain';
      const usd = run.usdValueMinor != null ? ` (~${formatMinor(run.usdValueMinor)} USD)` : '';
      const text = `${who}: ${formatMinor(run.distributableMinor)} ${run.currency}${usd} across ${shares.length} people.`;
      try {
        const row = await this.chat.postSystemAlert('RAIN', text, run.roomId, shares.map((share) => share.userId));
        await this.db.setMessage(run.id, row.id);
        messageId = row.id;
        if (run.kind === 'USER' && run.initiatorId) {
          await this.log('RAIN_SENT', run.initiatorId, run.roomId, {
            rainId: run.id,
            currency: run.currency,
            pot: formatMinor(run.potMinor),
            fee: formatMinor(run.feeMinor),
            recipients: shares.length,
          });
        }
      } catch (err: unknown) {
        this.logger.warn({ rainId: run.id, err }, 'rain was paid but its chat alert could not be posted');
      }
    }
    this.delivery.toRoom(run.roomId, SERVER_EVENTS.RAIN_COMPLETED, {
      rainId: run.id,
      kind: run.kind,
      roomId: run.roomId,
      currency: run.currency,
      pot: formatMinor(run.potMinor),
      usd: run.usdValueMinor != null ? formatMinor(run.usdValueMinor) : null,
      distributed: formatMinor(run.distributableMinor),
      recipients: shares.length,
      messageId: messageId ?? null,
    });
    for (const share of shares) {
      this.delivery.toUser(share.userId, SERVER_EVENTS.RAIN_RECEIVED, {
        rainId: run.id,
        kind: run.kind,
        currency: run.currency,
        amount: formatMinor(share.amount),
      });
    }
    await this.awardRewards(run, shares);
    return {
      rainId: run.id,
      status: run.status,
      currency: run.currency,
      pot: formatMinor(run.potMinor),
      fee: formatMinor(run.feeMinor),
      distributable: formatMinor(run.distributableMinor),
      recipients: shares.length,
      shares: shares.map((s) => ({ username: usernames.get(s.userId) ?? null, amount: formatMinor(s.amount), tier: s.tier })),
      messageId,
    };
  }

  // Awards EXP rewards for completed rains through the chat rewards port
  async awardRewards(run: RainRunRow, shares: readonly { userId: string; amount: bigint }[]): Promise<void> {
    try {
      const rewards = (await this.db.config()).rewards;
      const any = [rewards.perRainDone.exp, rewards.perRainDone.stars, rewards.perRainReceived.exp, rewards.perRainReceived.stars]
        .some((rule) => rule.amount > 0);
      if (!any) return;
      if (!(await this.db.claimRewards(run.id))) return;
      const port = await this.featurePorts.rewards();
      const price = run.usdPriceMinor ?? null;
      const doneUsd = run.usdValueMinor ?? (price !== null ? minorToUsd(run.potMinor, price) : null);
      const done = run.kind === 'USER' && run.initiatorId
        ? { exp: rainReward(rewards.perRainDone.exp, doneUsd), stars: rainReward(rewards.perRainDone.stars, doneUsd) }
        : { exp: 0, stars: 0 };
      const record: RainRewardsRecord = {
        done: { ...done, awarded: false },
        received: { exp: 0, stars: 0, awarded: 0, total: shares.length },
        perRecipient: {},
      };
      if (port && run.initiatorId && (done.exp || done.stars)) {
        record.done.awarded = await port.award({
          userId: run.initiatorId,
          kind: 'RAIN_DONE',
          reference: run.id,
          exp: done.exp,
          currency: done.stars,
        });
      }
      for (const share of shares) {
        const usd = price !== null ? minorToUsd(share.amount, price) : null;
        const exp = rainReward(rewards.perRainReceived.exp, usd);
        const stars = rainReward(rewards.perRainReceived.stars, usd);
        if (!exp && !stars) continue;
        record.received.exp += exp;
        record.received.stars += stars;
        const awarded = port
          ? await port.award({ userId: share.userId, kind: 'RAIN_RECEIVED', reference: `${run.id}:${share.userId}`, exp, currency: stars })
          : false;
        if (awarded) record.received.awarded += 1;
        record.perRecipient![share.userId] = { exp, stars, awarded };
      }
      await this.db.setRewards(run.id, record);
    } catch (err: unknown) {
      this.logger.warn({ rainId: run.id, err }, 'could not award rain rewards');
    }
  }

  // Revokes rewards when a rain is reverted
  async revokeRewards(run: RainRunRow, userIds: readonly string[], whole: boolean): Promise<void> {
    const earned = run.rewards;
    if (!earned || run.rewardsRevokedAt) return;
    try {
      const port = await this.featurePorts.rewards();
      if (!port) return;
      if (whole && earned.done.awarded && run.initiatorId) {
        await port.revoke({ userId: run.initiatorId, kind: 'RAIN_DONE', reference: run.id, exp: earned.done.exp, currency: earned.done.stars });
      }
      for (const userId of userIds) {
        const own = earned.perRecipient?.[userId];
        if (!own?.awarded) continue;
        await port.revoke({
          userId,
          kind: 'RAIN_RECEIVED',
          reference: `${run.id}:${userId}`,
          exp: own.exp,
          currency: own.stars,
        });
      }
      if (whole) await this.db.markRewardsRevoked(run.id);
    } catch (err: unknown) {
      this.logger.warn({ rainId: run.id, err }, 'could not take back rain rewards');
    }
  }

  legsOf(
    run: RainRunRow & { shares: readonly RainShare[] | readonly { userId: string; amount: bigint }[] },
    payerId: string,
  ): LedgerLeg[] {
    return [
      { key: `${run.id}:debit`, userId: payerId, delta: -run.potMinor },
      ...(run.feeMinor > 0n ? [{ key: `${run.id}:fee`, userId: FEE_ACCOUNT, delta: run.feeMinor }] : []),
      ...run.shares.map((share) => ({ key: `${run.id}:${share.userId}`, userId: share.userId, delta: share.amount })),
    ];
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

