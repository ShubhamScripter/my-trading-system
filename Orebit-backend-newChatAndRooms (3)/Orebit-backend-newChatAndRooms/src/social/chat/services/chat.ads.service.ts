// Manages ad lifecycle: quoting, creation, publishing, pinned slots, and refunds.
import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, SERVER_EVENTS, SYSTEM_AUTHOR_ID } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatSettingsService } from '../chat.settings';
import type { ChatSettings } from '../chat.settings.contract';
import { ChatAdPinsDbOperation } from '../persistence/chat.ad-pins.dboperation';
import { ChatAdDbOperation, type AdRecord } from '../persistence/chat.ad.dboperation';
import { ChatBus } from '../realtime/chat.bus';
import { ChatDelivery } from '../realtime/chat.delivery';
import type { ChatUserContext } from '../chat.types';
import { uuidv7 } from '../../../utils/public.utils';
import { fingerprint, requireKey } from '../platform/idempotency';
import { isPositive } from '../platform/money';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { refundForAdvertiserStop, refundForCancel } from './chat.ads.pricing';
import { ChatAdsPaymentService } from './chat.ads.payment';
import { ChatAdsPlanner, type AdInput } from './chat.ads.plan';
import { ChatRestrictionsService } from './chat.restrictions.service';
import { ChatAdsSettlementService } from './chat.ads.settlement';
import { adSkinOf } from './chat.ads.read';
import { missingMoneyNumbers, type MoneyJobConfig } from './chat.money-config';

export type { AdInput } from './chat.ads.plan';

// What a retry of a finished request is told: the first answer, in the shape the first one had.
function replayOf(ad: AdRecord) {
  return {
    adId: ad.id,
    status: ad.status,
    replayed: true,
    price: { totalUsd: ad.priceUsd, lines: ad.breakdown },
  };
}

@Injectable()
export class ChatAdsService {
  private readonly logger = new Logger('ChatAdsService');

  constructor(
    private readonly ads: ChatAdDbOperation,
    private readonly pins: ChatAdPinsDbOperation,
    private readonly db: ChatDbOperation,
    private readonly access: ChatAccessService,
    private readonly settings: ChatSettingsService,
    private readonly planner: ChatAdsPlanner,
    private readonly payment: ChatAdsPaymentService,
    private readonly moderation: ChatModerationService,
    private readonly restrictions: ChatRestrictionsService,
    private readonly delivery: ChatDelivery,
    private readonly settlement: ChatAdsSettlementService,
    private readonly bus: ChatBus,
    private readonly ports: ChatFeaturePorts,
  ) {}

  // "Rooms Where Advertising is Allowed", and the room's own "Ads: On / OFF".
  adRoom(room: Parameters<ChatAdsPlanner['adRoom']>[0], settings: ChatSettings): boolean {
    return this.planner.adRoom(room, settings);
  }

  async quote(user: ChatUserContext, input: AdInput) {
    return this.planner.summary(await this.planner.plan(input, user.id));
  }

  // Validates, persists, charges, and activates an advertisement idempotently.
  async create(user: ChatUserContext, input: AdInput, ip: string, idempotencyKey: string | null | undefined) {
    const key = requireKey(idempotencyKey);
    const settings = await this.settings.global();
    const missing = missingMoneyNumbers(settings);
    if (missing.length > 0) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
        'Ads cannot be bought until the admin sets the money-job numbers',
        { missing },
      );
    }
    // What the request asks for, in a fixed shape (the key itself is not part of it).
    const requestFingerprint = fingerprint({
      content: input.content,
      roomIds: [...new Set(input.roomIds ?? [])].sort(),
      allRooms: input.allRooms ?? false,
      pinMinutes: input.pinMinutes ?? null,
      repeatCount: input.repeatCount ?? 0,
      repeatGapMinutes: input.repeatGapMinutes ?? null,
      badgeId: input.badgeId ?? null,
      skinId: input.skinId ?? null,
      is18Plus: input.is18Plus ?? false,
      currencies: [...new Set((input.currencies ?? []).map((c) => c.trim().toUpperCase()))].sort(),
      hiddenCountries: [...new Set((input.hiddenCountries ?? []).map((c) => c.trim().toUpperCase()))].sort(),
    });
    // A claim older than the admin's job stale time is a dead worker's (no number of our own).
    const staleSeconds = settings.ads.jobStaleMinutes! * 60;
    const earlier = await this.payment.existing(user.id, key, requestFingerprint);
    if (earlier) return this.replay(earlier, staleSeconds);

    const dbNow = await this.db.dbNow();
    await this.moderation.assertNotBanned(user, null, dbNow);
    const plan = await this.planner.plan(input, user.id);
    const facts = await this.access.factsFor(user);
    if (facts.kycEntitlements && !facts.kycEntitlements.publicChat) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.RESTRICTED,
        'Your KYC level does not include placing ads',
        { requirement: { kind: 'KYC', minLevel: (facts.kycLevel ?? 0) + 1 } },
      );
    }
    for (const room of [null, ...plan.rooms]) {
      const found = await this.restrictions.find(user, facts, 'RESTRICT_ADS', room, dbNow);
      if (found) {
        throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, found.reason, {
          restriction: 'RESTRICT_ADS',
          expiresAt: found.expiresAt,
        });
      }
    }
    await this.moderation.checkSendLimits(user, ip, dbNow, await this.access.settingsFor(user), false);

    // Ask payment PIN for ad purchase only when the user turned the payment PIN on
    const hasPin = await this.ports.hasPaymentPin(user.id);
    if (hasPin) {
      if (!input.paymentPin) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.PAYMENT_FAILED,
          'Payment PIN is required to buy an ad',
          { requirement: 'PAYMENT_PIN' },
        );
      }
      const verified = await this.ports.verify(user.id, 'PAYMENT_PIN', input.paymentPin.trim());
      if (!verified) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.VERIFICATION_FAILED,
          'The payment PIN is not correct',
          { verification: 'PAYMENT_PIN' },
        );
      }
    }

    const begun = await this.payment.begin(user, plan, uuidv7(), key, requestFingerprint, settings.ads.pinned.maxQueue);
    if (begun.replay) return this.replay(begun.ad, staleSeconds);
    let ad = begun.ad;
    let publish = ad.status === 'ACTIVE'; // a free ad is ACTIVE from the start
    if (ad.status === 'PENDING_PAYMENT') {
      const settled = await this.payment.settle(ad);
      ad = settled.ad;
      publish = settled.activatedNow;
    }
    if (publish) await this.publish(ad, plan.price.totalUsd, staleSeconds);
    return { adId: ad.id, status: ad.status, ...this.planner.summary(plan) };
  }

  // A retry of a request that already has an ad: finish its payment if it was left pending, then answer as before.
  private async replay(ad: AdRecord, staleSeconds: number) {
    if (ad.status === 'PENDING_PAYMENT') {
      const settled = await this.payment.settle(ad);
      if (settled.activatedNow) await this.publish(settled.ad, settled.ad.priceUsd, staleSeconds);
      return replayOf(settled.ad);
    }
    if (ad.status === 'FAILED') {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.PAYMENT_FAILED, 'The ad could not be paid; start a new purchase', {
        detail: ad.failureReason,
      });
    }
    return replayOf(ad);
  }

  // The ad just became ACTIVE: reward it, post it now (a claim lets the loop do it if this dies), start its pins.
  private async publish(ad: AdRecord, totalUsd: string, staleSeconds: number): Promise<void> {
    if (ad.creatorId && ad.kind !== 'INTERNAL' && isPositive(totalUsd)) {
      const lb = await this.ports.leaderboard();
      if (lb) {
        try {
          await lb.recordAdSpend({ userId: ad.creatorId, usd: totalUsd, adId: ad.id });
        } catch (err: unknown) {
          this.logger.warn({ component: 'ChatAdsService', err, adId: ad.id }, 'leaderboard ad spend record failed');
        }
      }
    }
    await this.postClaimed(await this.ads.claimDueRepeats(1, staleSeconds, ad.id));
    if (ad.pinMinutes !== null) await this.syncPins();
  }

  // Posts the claimed ads (the first post and each repeat).
  async postClaimed(claimed: readonly AdRecord[]): Promise<void> {
    for (const ad of claimed) await this.post(ad);
  }

  // Posts the ad once into every one of its rooms that still accepts ads, then counts the post. The count is
// conditional on the number of posts the ad had when it was claimed, so a repeat is never counted twice.
  private async post(ad: AdRecord): Promise<void> {
    const settings = await this.settings.global();
    const badge = ad.badgeId ? (settings.ads.badges.find((b) => b.id === ad.badgeId) ?? null) : null;
    const skin = adSkinOf(ad.skinId, settings);
    let delivered = 0;
    for (const roomId of ad.roomIds) {
      const room = await this.access.findRoom(roomId);
      if (!room || !this.adRoom(room, settings)) continue;
      try {
        const { row } = await this.db.insertMessage({
          roomId,
          userId: ad.creatorId ?? SYSTEM_AUTHOR_ID,
          content: ad.content,
          type: 'AD',
          skinId: null,
          metadata: {
            ad: {
              adId: ad.id,
              ...(badge ? { badge } : {}),
              ...(skin ? { skin } : {}),
              ...(ad.hiddenCountries.length > 0 ? { hiddenCountries: [...ad.hiddenCountries] } : {}),
            },
          },
          taggedUserIds: [],
        });
        this.delivery.publish(row);
        delivered += 1;
      } catch (err: unknown) {
        this.logger.error({ component: 'ChatAdsService', err, adId: ad.id, roomId }, 'could not post an ad');
      }
    }
    if (delivered === 0) {
      await this.ads.deferPost(ad.id);
      return;
    }
    if (!(await this.ads.recordPosted(ad.id, ad.postedCount))) {
      this.logger.warn({ component: 'ChatAdsService', adId: ad.id }, 'a post was made for an ad whose count had moved');
    }
  }

  // The pinned ad showing in a room, unless it is hidden in the viewer's country or viewer has disabled ads.
  async activePin(roomId: string, country: string | null, viewerUserId?: string | null) {
    const pin = await this.pins.activePin(roomId);
    if (!pin || (country && pin.hidden_countries.includes(country))) return null;
    if (viewerUserId && viewerUserId !== pin.creator_id) {
      const prem = await this.ports.premium();
      if (prem && (await prem.hasDisableAllAds(viewerUserId))) {
        return null;
      }
    }
    const settings = await this.settings.global();
    return {
      roomId,
      adId: pin.ad_id,
      content: pin.content,
      badge: pin.badge_id ? (settings.ads.badges.find((b) => b.id === pin.badge_id) ?? null) : null,
      skin: adSkinOf(pin.skin_id, settings),
      startsAt: pin.starts_at.toISOString(),
      endsAt: pin.ends_at.toISOString(),
    };
  }

  // Ends finished pinned slots and starts the next queued ones, telling each room.
  async syncPins(): Promise<void> {
    try {
      for (const ended of await this.pins.endExpiredPins()) {
        this.delivery.toRoom(ended.roomId, SERVER_EVENTS.AD_UNPINNED, { roomId: ended.roomId, adId: ended.adId });
      }
      for (const started of await this.pins.startQueuedPins()) {
        const pin = await this.activePin(started.roomId, null);
        if (pin) this.delivery.toRoom(started.roomId, SERVER_EVENTS.AD_PINNED, pin);
      }
    } catch (err: unknown) {
      this.logger.error({ component: 'ChatAdsService', err }, 'pinned ad queue step failed');
    }
  }

  async announceCancelledPins(adId: string): Promise<void> {
    for (const roomId of await this.pins.cancelledActivePins(adId)) {
      this.delivery.toRoom(roomId, SERVER_EVENTS.AD_UNPINNED, { roomId, adId });
    }
  }

  // Handles maintenance mode transitions and pause/resume policies for ads.
  async applyAdsStatus(config: MoneyJobConfig, until: number): Promise<void> {
    const settings = await this.settings.global();
    const current = settings.maintenance.ads;
    const applied = await this.ads.appliedAdsStatus();
    if (current === applied) return;
    let outcome = 'none';
    if (applied === 'ACTIVE') {
      const action = settings.maintenance.adsOnStop === 'PAUSE' && current !== 'MAINTENANCE' ? 'FINISH' : settings.maintenance.adsOnStop;
      if (action === 'PAUSE') {
        const result = await this.ads.pauseActive();
        for (const pin of result.unpinned) {
          this.delivery.toRoom(pin.roomId, SERVER_EVENTS.AD_UNPINNED, { roomId: pin.roomId, adId: pin.adId });
        }
        outcome = `paused ${result.paused}`;
      } else if (action === 'REFUND_PENDING' || action === 'REFUND_FULL') {
        const result = await this.refundAll(
          ['ACTIVE', 'PAUSED'], action === 'REFUND_FULL', `Ads turned ${current.toLowerCase()}`,
          config.pageSize, until,
        );
        outcome = `refunded ${result.count}${result.complete ? '' : ' (continuing next pass)'}`;
        if (!result.complete) {
          this.logger.log({ component: 'ChatAdsService', from: applied, to: current, outcome }, 'ads status partially applied');
          return;
        }
      } else {
        outcome = 'finishing';
      }
    } else if (current === 'ACTIVE') {
      const action = settings.maintenance.adsOnResume;
      if (action === 'RESUME' || action === 'RESET_RESUME') {
        outcome = `resumed ${await this.ads.resumePaused(action === 'RESET_RESUME')}`;
      } else {
        const result = await this.refundAll(
          ['PAUSED'], action === 'REFUND_FULL', 'Ads back after maintenance', config.pageSize, until,
        );
        outcome = `refunded ${result.count}${result.complete ? '' : ' (continuing next pass)'}`;
        if (!result.complete) {
          this.logger.log({ component: 'ChatAdsService', from: applied, to: current, outcome }, 'ads status partially applied');
          return;
        }
      }
    }
    await this.ads.setAppliedAdsStatus(current);
    this.logger.log({ component: 'ChatAdsService', from: applied, to: current, outcome }, 'ads status applied');
  }

  // Cancels the ads in these states and refunds each paid one: what was not shown, or the whole price.
  private async refundAll(
    statuses: ('ACTIVE' | 'PAUSED')[], full: boolean, note: string, pageSize: number, until: number,
  ): Promise<{ count: number; complete: boolean }> {
    let count = 0;
    let afterId: string | null = null;
    while (Date.now() < until) {
      const page = await this.ads.adsWithStatus(statuses, afterId, pageSize);
      if (page.length === 0) return { count, complete: true };
      for (const ad of page) {
        if (Date.now() >= until) return { count, complete: false };
        afterId = ad.id;
        const result = await this.ads.cancel(ad.id, null, note, (locked, shown) =>
          !locked.chargeReference ? null : full ? locked.priceUsd : refundForCancel(locked, shown),
        );
        if (!result.cancelled) continue;
        count += 1;
        for (const roomId of result.unpinnedRoomIds) {
          this.delivery.toRoom(roomId, SERVER_EVENTS.AD_UNPINNED, { roomId, adId: ad.id });
        }
      }
      if (page.length < pageSize) return { count, complete: true };
    }
    return { count, complete: false };
  }

  // Background worker pass: settles pending payments and scheduled ad repeats.
  async moneyPass(config: MoneyJobConfig, until: number): Promise<void> {
    await this.applyAdsStatus(config, until);
    await this.postClaimed(await this.payment.sweep(config, until));
    while (Date.now() < until) {
      const due = await this.ads.claimDueRepeats(config.pageSize, config.staleSeconds);
      if (due.length === 0) break;
      await this.postClaimed(due);
      if (due.length < config.pageSize) break;
    }
    await this.ads.completeFinished();
    await this.settlement.settle(config, until);
  }

  // Cancels an active ad and issues a prorated refund for unserved views or minutes.
  async cancel(user: ChatUserContext, adId: string, refundCurrency?: string | null) {
    const ad = await this.ads.adById(adId);
    if (!ad || ad.creatorId !== user.id) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Ad not found' });
    const settings = await this.settings.global();
    let cancellationFee = settings.ads.cancellationFee ?? null;
    if (!cancellationFee) {
      const adv = await this.ports.advertising();
      if (adv?.cancellationFee) {
        cancellationFee = await adv.cancellationFee();
      }
    }
    const coins = settings.ads.refundCurrencies;
    const coin = refundCurrency?.trim().toUpperCase() || null;
    if (coin !== null && !coins.includes(coin)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'refundCurrency', message: coins.length ? `One of ${coins.join(', ')}` : 'No refund coin can be chosen' }],
      });
    }
    if (coin === null && coins.length > 0 && ad.chargeReference) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'refundCurrency', message: `Choose the coin to be refunded in: ${coins.join(', ')}` }],
      });
    }
    const result = await this.ads.cancel(
      adId,
      user.id,
      'Cancelled by the advertiser',
      (locked) => {
        if (locked.postedCount > 0) {
          throw refuse(
            ERR.FORBIDDEN,
            CHAT_REFUSAL_REASONS.FEATURE_DISABLED,
            'An ad cannot be cancelled by the advertiser after its first post',
            {},
            409,
          );
        }
        return locked.chargeReference ? refundForAdvertiserStop(locked, cancellationFee) : null;
      },
      coin,
      true,
    );
    if (!result.cancelled) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.FEATURE_DISABLED, 'This ad has already ended', {}, 409);
    }
    // Leaderboard ad spend refund adjustment
    if (ad.creatorId && ad.kind !== 'INTERNAL' && result.refundUsd && isPositive(result.refundUsd)) {
      const lb = await this.ports.leaderboard();
      if (lb) {
        try {
          await lb.recordAdSpend({ userId: ad.creatorId, usd: `-${result.refundUsd}`, adId: ad.id });
        } catch (err: unknown) {
          this.logger.warn({ component: 'ChatAdsService', err, adId }, 'leaderboard ad spend refund record failed');
        }
      }
    }
    for (const roomId of result.unpinnedRoomIds) {
      this.delivery.toRoom(roomId, SERVER_EVENTS.AD_UNPINNED, { roomId, adId });
    }
    await this.syncPins();
    // The refund is paid by the money loop; tell it there is one now.
    this.bus.publish({ kind: 'ad', adId });
    return { adId, status: 'CANCELLED', refundUsd: result.refundUsd, refundCurrency: coin };
  }
}
