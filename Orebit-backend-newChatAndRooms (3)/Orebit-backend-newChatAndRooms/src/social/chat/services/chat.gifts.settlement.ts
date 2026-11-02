// The gift work that runs in the money loop (Module 5; , ):
// - reverts an admin asked for ("Revert ALL Transfers"): each gift is claimed by one worker, the Transfer port moves the
// money back by the gift's reference, a revert it refuses is REVERT_FAILED, the rewards are taken back;
// - gifts left PROCESSING (the transfer call was made and the answer never arrived): after the admin's number of
// minutes the Transfer port is asked what became of the reference, and the gift is settled either way — COMPLETED
// with its notice, or FAILED. A gift is never left PROCESSING for ever.
import { Injectable, Logger } from '@nestjs/common';
import { SERVER_EVENTS } from '../chat.constants';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { ChatGiftDbOperation } from '../persistence/chat.gift.dboperation';
import { ChatDelivery } from '../realtime/chat.delivery';
import { ChatGiftsService } from './chat.gifts.service';
import type { MoneyJobConfig } from './chat.money-config';

@Injectable()
export class ChatGiftsSettlementService {
  private readonly logger = new Logger('ChatGiftsSettlementService');

  constructor(
    private readonly gifts: ChatGiftDbOperation,
    private readonly giftService: ChatGiftsService,
    private readonly ports: ChatFeaturePorts,
    private readonly delivery: ChatDelivery,
  ) {}

  async run(config: MoneyJobConfig, until: number): Promise<void> {
    while (Date.now() < until) {
      const cancelled = await this.gifts.cancelExpiredVerification(config.pageSize);
      if (cancelled < config.pageSize) break;
    }
    await this.processReverts(config, until);
    await this.reconcileProcessing(config, until);
  }

  // The reverts an admin asked for, a page at a time.
  async processReverts(config: MoneyJobConfig, until: number): Promise<void> {
    while (Date.now() < until) {
      const pending = await this.gifts.claimReverts(config.pageSize, config.staleSeconds);
      if (pending.length === 0) return;
      const transfer = await this.ports.transfer();
      if (!transfer) {
        for (const gift of pending) await this.gifts.release(gift.id);
        return;
      }
      const rewards = await this.ports.rewards();
      let settled = 0;
      for (const gift of pending) {
        try {
          const result = await transfer.revert({
            reference: gift.transfer_reference ?? gift.id,
            giftId: gift.id,
            refundFees: gift.revert_refund_fees,
          });
          if (!(await this.gifts.finishRevert(gift.id, result.ok, result.ok ? null : result.reason))) continue;
          settled += 1;
          if (!result.ok) continue;
          const earned = gift.rewards ?? {};
          if (earned.awarded && !gift.rewards_revoked_at && rewards) {
            const revoked = await rewards.revoke({
              userId: gift.sender_id,
              kind: 'GIFT',
              reference: gift.id,
              exp: earned.exp ?? 0,
              currency: earned.currency ?? 0,
            });
            if (revoked) await this.gifts.markRewardsRevoked(gift.id);
          }
          for (const userId of [gift.sender_id, gift.recipient_id]) {
            this.delivery.toUser(userId, SERVER_EVENTS.MODERATION_NOTICE, {
              action: 'gift_reverted',
              giftId: gift.id,
              note: null,
            });
          }
        } catch (err: unknown) {
          this.logger.error({ component: 'ChatGiftsSettlementService', err, giftId: gift.id }, 'gift revert failed; will retry');
          await this.gifts.release(gift.id);
        }
      }
      if (settled === 0 || pending.length < config.pageSize) return;
    }
  }

  // Gifts stuck PROCESSING: ask the Transfer port what happened to each, and settle it.
  async reconcileProcessing(config: MoneyJobConfig, until: number): Promise<void> {
    if (config.giftProcessingMinutes === null) return;
    while (Date.now() < until) {
      const ids = await this.gifts.claimStaleProcessing(config.giftProcessingMinutes, config.pageSize, config.staleSeconds);
      if (ids.length === 0) return;
      const transfer = await this.ports.transfer();
      let settled = 0;
      for (const id of ids) {
        try {
          const gift = await this.gifts.byId(id);
          if (!gift || gift.status !== 'PROCESSING') continue;
          const answer = transfer ? await transfer.status(gift.id) : { state: 'UNKNOWN' as const };
          if (answer.state === 'COMPLETED') {
            if (await this.giftService.completeTransfer(gift, answer.reference, null)) settled += 1;
            else this.logger.error({ giftId: gift.id }, 'completed transfer could not update its gift row');
          } else if (answer.state === 'FAILED') {
            await this.gifts.finish(gift.id, 'FAILED', null, answer.reason);
            settled += 1;
          } else if (answer.state === 'NOT_FOUND') {
            if (transfer && await transfer.void(gift.id)) {
              await this.gifts.finish(gift.id, 'FAILED', null, 'the transfer reference was voided');
              settled += 1;
            } else {
              await this.gifts.release(id);
            }
          } else {
            await this.gifts.release(id);
          }
        } catch (err: unknown) {
          this.logger.warn({ component: 'ChatGiftsSettlementService', err, giftId: id }, 'gift reconcile failed; will retry');
          await this.gifts.release(id);
        }
      }
      if (settled === 0 || ids.length < config.pageSize) return;
    }
  }
}
