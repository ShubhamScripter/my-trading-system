// Paying for an ad without ever paying twice or paying for nothing (Module 5; , ):
// 1. the ad is SAVED first, as PENDING_PAYMENT, under the advertiser's idempotency key, with its pinned slots queued
// under the rooms' locks (so a full queue refuses before any money moves);
// 2. the Charge port is called with the ad id as the reference (idempotent by reference);
// 3. the ad becomes ACTIVE, or FAILED when the charge is refused.
// A crash, a timeout or a double tap leaves a row that is either finished by the same request sent again (same key) or
// reconciled by the sweeper against the Charge port. Nothing is charged that has no row to refund.
import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { refuse } from '../chat.moderation.service';
import type { ChatUserContext } from '../chat.types';
import { ChatAdPinsDbOperation, enqueuePin } from '../persistence/chat.ad-pins.dboperation';
import { ChatAdDbOperation, type AdRecord } from '../persistence/chat.ad.dboperation';
import { isUniqueViolation } from '../persistence/chat.sql';
import { keyConflict } from '../platform/idempotency';
import { isPositive } from '../platform/money';
import type { PlannedAd } from './chat.ads.plan';
import type { MoneyJobConfig } from './chat.money-config';

@Injectable()
export class ChatAdsPaymentService {
  private readonly logger = new Logger('ChatAdsPaymentService');

  constructor(
    private readonly ads: ChatAdDbOperation,
    private readonly pins: ChatAdPinsDbOperation,
    private readonly ports: ChatFeaturePorts,
  ) {}

  // The ad already made under this key (a retry, a double tap), refused if the request differs.
  async existing(userId: string, key: string, requestFingerprint: string): Promise<AdRecord | null> {
    const found = await this.ads.adByKey(userId, key);
    if (found && found.requestFingerprint !== requestFingerprint) throw keyConflict();
    return found;
  }

  // Saves the ad (PENDING_PAYMENT, or ACTIVE when it is free) and queues its pinned slots, in one transaction under the
// rooms' locks. A concurrent request with the same key loses the unique index and gets the first one's ad back.
  async begin(
    user: ChatUserContext,
    plan: PlannedAd,
    adId: string,
    key: string,
    requestFingerprint: string,
    maxQueue: number,
  ): Promise<{ ad: AdRecord; replay: boolean }> {
    const free = !isPositive(plan.price.totalUsd);
    try {
      await this.ads.transaction(async (tx) => {
        if (plan.pinMinutes !== null) {
          const lengths = await this.pins.lockAndCount(tx, plan.rooms.map((room) => room.id));
          const full = plan.rooms.find((room) => (lengths.get(room.id) ?? 0) >= maxQueue);
          if (full) {
            throw refuse(
              ERR.FORBIDDEN,
              CHAT_REFUSAL_REASONS.AD_QUEUE_FULL,
              `The pinned-ad queue of ${full.name} is full`,
              { roomId: full.id, maxQueue },
            );
          }
        }
        await this.ads.insertAd(tx, {
          id: adId,
          creatorId: user.id,
          content: plan.content,
          roomIds: plan.rooms.map((room) => room.id),
          allRooms: plan.allRooms,
          pinMinutes: plan.pinMinutes,
          repeatCount: plan.repeatCount,
          repeatGapMin: plan.repeatGapMin,
          hiddenCountries: plan.hiddenCountries,
          badgeId: plan.badge?.id ?? null,
          skinId: plan.skin?.id ?? null,
          priceUsd: plan.price.totalUsd,
          breakdown: plan.price.lines,
          chargeReference: null,
          status: free ? 'ACTIVE' : 'PENDING_PAYMENT',
          idempotencyKey: key,
          requestFingerprint,
          kind: 'COMMERCIAL',
          is18Plus: plan.is18Plus,
          planId: plan.planId ?? null,
          discountUsd: plan.discountUsd ?? null,
        });
        if (plan.pinMinutes !== null) {
          for (const room of plan.rooms) await enqueuePin(tx, adId, room.id, plan.pinMinutes * 60);
        }
      });
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) throw err;
      const first = await this.existing(user.id, key, requestFingerprint);
      if (!first) throw err;
      return { ad: first, replay: true };
    }
    return { ad: (await this.ads.adById(adId))!, replay: false };
  }

  // Charges a PENDING_PAYMENT ad and activates it. The charge is idempotent by reference, so this may be called again
// for the same ad (the request sent again, the sweeper). `activatedNow` is true only for the call that made it ACTIVE,
// which is the one that posts it. A refused charge makes it FAILED and throws; a charge that cannot be confirmed
// leaves it PENDING_PAYMENT and throws `payment_pending`.
  async settle(ad: AdRecord): Promise<{ ad: AdRecord; activatedNow: boolean }> {
    if (ad.status !== 'PENDING_PAYMENT') return { ad, activatedNow: false };
    const charge = await this.ports.charge();
    if (!charge) {
      await this.ads.fail(ad.id, 'payments are not connected');
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE, 'Ad payments are not connected yet');
    }
    let paid: Awaited<ReturnType<typeof charge.charge>>;
    try {
      paid = await charge.charge({
        userId: ad.creatorId!,
        usd: ad.priceUsd,
        reference: ad.id,
        memo: 'ChatAds',
      });
    } catch (err: unknown) {
      this.logger.error({ component: 'ChatAdsPaymentService', err, adId: ad.id }, 'charge call failed; left PENDING_PAYMENT');
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.PAYMENT_PENDING,
        'The payment could not be confirmed yet; send the same request again',
        { adId: ad.id },
        409,
      );
    }
    if (!paid.ok) {
      await this.ads.fail(ad.id, paid.reason);
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.PAYMENT_FAILED, 'The ad could not be paid', {
        detail: paid.reason,
      });
    }
    const activatedNow = await this.ads.activate(ad.id, paid.reference);
    const current = (await this.ads.adById(ad.id))!;
    if (!activatedNow && current.status === 'FAILED') {
      await this.ads.recordLateChargeRefund(ad.id, paid.reference, ad.priceUsd);
      this.logger.error({ component: 'ChatAdsPaymentService', adId: ad.id }, 'late charge recorded for refund');
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.PAYMENT_FAILED,
        'The ad expired during payment; the charge is being refunded',
        { adId: ad.id },
        409,
      );
    }
    return { ad: current, activatedNow };
  }

  // Reconciles ads left PENDING_PAYMENT: asks the Charge port what happened to each and finishes it. Returns the ads
// this pass activated (the caller posts them). An answer of UNKNOWN leaves the row for the next pass.
  async sweep(config: MoneyJobConfig, until: number): Promise<AdRecord[]> {
    const activated: AdRecord[] = [];
    while (Date.now() < until) {
      const batch = await this.ads.claimPendingPayments(config.pendingPaymentMinutes, config.pageSize, config.staleSeconds);
      if (batch.length === 0) break;
      const charge = await this.ports.charge();
      let resolved = 0;
      for (const ad of batch) {
        try {
          const answer = charge ? await charge.status(ad.id) : { state: 'UNKNOWN' as const };
          if (answer.state === 'PAID') {
            resolved += 1;
            if (await this.ads.activate(ad.id, answer.reference)) activated.push((await this.ads.adById(ad.id))!);
          } else if (answer.state === 'NOT_PAID') {
            resolved += 1;
            await this.ads.fail(ad.id, 'the charge never happened');
          } else {
            await this.ads.releaseAd(ad.id);
          }
        } catch (err: unknown) {
          this.logger.warn({ component: 'ChatAdsPaymentService', err, adId: ad.id }, 'payment check failed; will retry');
          await this.ads.releaseAd(ad.id);
        }
      }
      // A page the port could not answer is not asked again in this pass.
      if (resolved === 0 || batch.length < config.pageSize) break;
    }
    return activated;
  }
}
