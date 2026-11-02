// Checking and pricing an ad before anything is stored or paid (Module 5, Chat SETTINGS "/Ad"): the rooms it may run
// in, the word lists, repeats, pinned slots, badge, skin, hidden countries and the price. Nothing here writes.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { refuse } from '../chat.moderation.service';
import { ChatSettingsService } from '../chat.settings';
import type { ChatSettings } from '../chat.settings.contract';
import { ChatAdPinsDbOperation } from '../persistence/chat.ad-pins.dboperation';
import { ChatFeaturePorts } from '../chat.feature-ports';
import type { RoomRecord } from '../chat.types';
import * as utility from '../chat.utility';
import { AdPriceError, priceAd, type AdPrice } from './chat.ads.pricing';
import { assertAvailable } from './chat.availability';

export interface AdInput {
  content: string;
  // Room ids or slugs; ignored with `allRooms` or when ALL rooms is the default.
  roomIds?: string[];
  allRooms?: boolean;
  pinMinutes?: number;
  repeatCount?: number;
  repeatGapMinutes?: number;
  badgeId?: string;
  // "Ad Skins": one of the skins the admin offers (priced once per ad).
  skinId?: string;
  // "GEO Targeting: Hide ad from specific country users".
  hiddenCountries?: string[];
  // "18+ Advertisements".
  is18Plus?: boolean;
  // Multi-coin payment preference.
  currencies?: string[];
  // Optional payment PIN.
  paymentPin?: string;
}

export interface PlannedAd {
  rooms: RoomRecord[];
  allRooms: boolean;
  pinMinutes: number | null;
  repeatCount: number;
  repeatGapMin: number | null;
  badge: ChatSettings['ads']['badges'][number] | null;
  skin: ChatSettings['ads']['skins'][number] | null;
  hiddenCountries: string[];
  price: AdPrice;
  content: string;
  is18Plus: boolean;
  currencies: string[];
  planId?: string | null;
  discountUsd?: string | null;
}

@Injectable()
export class ChatAdsPlanner {
  constructor(
    private readonly settings: ChatSettingsService,
    private readonly access: ChatAccessService,
    private readonly pins: ChatAdPinsDbOperation,
    private readonly ports: ChatFeaturePorts,
  ) {}

  invalid(path: string, message: string): ProblemException {
    return new ProblemException({
      type: ERR.VALIDATION_FAILED,
      errors: [{ path, message }],
    });
  }

  // "Rooms Where Advertising is Allowed", and the room's own "Ads: On / OFF".
  adRoom(room: RoomRecord, settings: ChatSettings): boolean {
    const allowed = settings.ads.allowedRoomIds;
    return (
      room.type !== 'STAFF' &&
      room.config.status === 'ACTIVE' &&
      room.config.contentControls.allowAds &&
      !room.config.controlsMaintenance.includes('ADS') &&
      (allowed.length === 0 || allowed.includes(room.id))
    );
  }

  // Validates the ad against the settings and prices it; nothing is stored.
  async plan(input: AdInput, userId?: string): Promise<PlannedAd> {
    const settings = await this.settings.global();
    const ads = settings.ads;
    if (!ads.enabled) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.FEATURE_DISABLED, 'Ads are switched off');
    }
    assertAvailable(settings, 'ads', true);
    const content = utility.normalizeContent(input.content ?? '');
    if (content.length === 0 || content.length > ads.maxChars) {
      throw this.invalid('content', `An ad is 1 to ${ads.maxChars} characters`);
    }

    const allRooms = ads.allRoomsByDefault || input.allRooms === true;
    let rooms: RoomRecord[];
    if (allRooms) {
      rooms = (await this.access.allRooms()).filter((room) => this.adRoom(room, settings));
    } else {
      const refs = [...new Set(input.roomIds ?? [])];
      if (refs.length === 0)
        throw this.invalid('roomIds', 'Choose at least one room, or all rooms');
      if (refs.length > 50) throw this.invalid('roomIds', 'At most 50 rooms');
      rooms = [];
      for (const ref of refs) {
        const room = await this.access.requireRoom(ref);
        if (!this.adRoom(room, settings)) {
          throw refuse(
            ERR.FORBIDDEN,
            CHAT_REFUSAL_REASONS.ADS_NOT_ALLOWED,
            `Ads are not allowed in ${room.name}`,
            { roomId: room.id },
          );
        }
        rooms.push(room);
      }
    }
    if (rooms.length === 0) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ADS_NOT_ALLOWED,
        'No room accepts ads right now',
      );
    }

    // The rooms' word lists apply to ads too.
    for (const room of rooms) {
      const matcher = utility.bannedWordMatcher(room.config.bannedWords);
      if (matcher?.test(content)) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.CONTENT_BLOCKED,
          'The ad contains a word that is not allowed',
          { rule: 'banned_word', roomId: room.id },
        );
      }
    }

    // Global advertising blocked words and blacklist check.
    const adv = await this.ports.advertising();
    if (adv) {
      if (await adv.hasBlockedWord(content)) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.CONTENT_BLOCKED,
          'The ad contains a blocked advertising word',
          { rule: 'advertising_blocked_words' },
        );
      }
      for (const link of utility.findLinks(content)) {
        if (await adv.isUrlBlacklisted(link.host)) {
          throw refuse(
            ERR.FORBIDDEN,
            CHAT_REFUSAL_REASONS.CONTENT_BLOCKED,
            'The ad contains a blacklisted URL',
            { rule: 'url_blacklist', url: link.host },
          );
        }
      }
    }

    // 18+ check.
    if (input.is18Plus && !ads.allow18Plus) {
      throw this.invalid('is18Plus', '18+ advertisements are not allowed');
    }

    // Currencies verification.
    const currencies = (input.currencies ?? []).map((c) => c.trim().toUpperCase());
    if (currencies.length > 0 && ads.acceptedCurrencies.length > 0) {
      const invalid = currencies.find((c) => !ads.acceptedCurrencies.includes(c));
      if (invalid) {
        throw this.invalid('currencies', `Currency ${invalid} is not accepted for ads`);
      }
    }
    const catalog = await this.ports.currencyCatalog();
    if (catalog) {
      for (const coin of currencies) {
        if (!(await catalog.isUsable({ currency: coin, purpose: 'AD_PAYMENT' }))) {
          throw refuse(
            ERR.FORBIDDEN,
            CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
            `Currency ${coin} is not usable for ads right now`,
            { currency: coin },
          );
        }
      }
    }

    const repeatCount = input.repeatCount ?? 0;
    let repeatGapMin: number | null = null;
    if (repeatCount > 0) {
      const r = ads.repeat;
      if (!r.enabled) throw this.invalid('repeatCount', 'Auto repeat is off');
      if (repeatCount < r.minCount || repeatCount > r.maxCount) {
        throw this.invalid('repeatCount', `From ${r.minCount} to ${r.maxCount}`);
      }
      repeatGapMin = input.repeatGapMinutes ?? r.minGapMinutes;
      if (repeatGapMin < r.minGapMinutes || repeatGapMin > r.maxGapMinutes) {
        throw this.invalid(
          'repeatGapMinutes',
          `From ${r.minGapMinutes} to ${r.maxGapMinutes} minutes`,
        );
      }
    }

    let pinMinutes: number | null = null;
    if (input.pinMinutes !== undefined && input.pinMinutes > 0) {
      const p = ads.pinned;
      if (!p.enabled) throw this.invalid('pinMinutes', 'Pinned ads are off');
      if (input.pinMinutes < p.minMinutes || input.pinMinutes > p.maxMinutes) {
        throw this.invalid('pinMinutes', `From ${p.minMinutes} to ${p.maxMinutes} minutes`);
      }
      pinMinutes = input.pinMinutes;
      const lengths = await this.pins.queueLengths(rooms.map((room) => room.id));
      const full = rooms.find((room) => (lengths.get(room.id) ?? 0) >= p.maxQueue);
      if (full) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.AD_QUEUE_FULL,
          `The pinned-ad queue of ${full.name} is full`,
          { roomId: full.id, maxQueue: p.maxQueue },
        );
      }
    }

    const badge = input.badgeId ? (ads.badges.find((b) => b.id === input.badgeId) ?? null) : null;
    if (input.badgeId && !badge) throw this.invalid('badgeId', 'Not a badge the admin offers');
    const skin = input.skinId ? (ads.skins.find((k) => k.id === input.skinId) ?? null) : null;
    if (input.skinId && !skin) throw this.invalid('skinId', 'Not a skin the admin offers');

    const hiddenCountries = [
      ...new Set((input.hiddenCountries ?? []).map((c) => c.trim().toUpperCase())),
    ];
    if (hiddenCountries.some((c) => !/^[A-Z]{2}$/.test(c)) || hiddenCountries.length > 250) {
      throw this.invalid('hiddenCountries', 'ISO-2 country codes');
    }

    let benefitDiscountUsd: string | null = null;
    const planId: string | null = null;
    const discounts = await this.ports.benefitDiscounts();
    if (discounts && userId) {
      const disc = await discounts.discountFor(userId, ads.basePriceUsd);
      if (disc?.usd) benefitDiscountUsd = disc.usd;
    }

    let price: AdPrice;
    try {
      price = priceAd(ads, {
        rooms: rooms.map((room) => ({
          id: room.id,
          type: room.type,
          planBound: room.access.allowedPlanIds.length > 0,
        })),
        skinPriceUsd: skin?.priceUsd ?? null,
        allRooms,
        links: utility.findLinks(content).length,
        repeatCount,
        pinMinutes,
        is18Plus: input.is18Plus === true,
        benefitDiscountUsd,
      });
    } catch (err: unknown) {
      if (err instanceof AdPriceError) throw this.invalid(err.field, err.message);
      throw err;
    }
    return {
      rooms,
      allRooms,
      pinMinutes,
      repeatCount,
      repeatGapMin,
      badge,
      skin,
      hiddenCountries,
      price,
      content,
      is18Plus: input.is18Plus === true,
      currencies,
      planId,
      discountUsd: benefitDiscountUsd,
    };
  }

  summary(plan: PlannedAd) {
    return {
      rooms: plan.rooms.map((room) => ({
        id: room.id,
        slug: room.slug,
        name: room.name,
        type: room.type,
      })),
      allRooms: plan.allRooms,
      pinMinutes: plan.pinMinutes,
      repeatCount: plan.repeatCount,
      repeatGapMinutes: plan.repeatGapMin,
      badge: plan.badge,
      skin: plan.skin,
      hiddenCountries: plan.hiddenCountries,
      is18Plus: plan.is18Plus,
      price: plan.price,
    };
  }
}
