/**
 * The reading side of chat ads (Module 5): the advertiser's own ads with their price breakdown and refunds, and the
 * "Separate Advertisement Tab" every user may open (without what others paid).
 */
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { CHAT_REFUSAL_REASONS, PAGE } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { ChatDbOperation } from '../chat.dboperation';
import { refuse } from '../chat.moderation.service';
import { ChatSettingsService } from '../chat.settings';
import type { ChatSettings } from '../chat.settings.contract';
import { ChatAdDbOperation, type AdRecord } from '../persistence/chat.ad.dboperation';
import type { ChatUserContext } from '../chat.types';
import * as utility from '../chat.utility';

/** The skin of an ad as messages, the pinned slot and the lists carry it. */
export function adSkinOf(skinId: string | null, settings: ChatSettings) {
  const skin = skinId ? settings.ads.skins.find((k) => k.id === skinId) : undefined;
  return skin ? { id: skin.id, name: skin.name, style: skin.style } : null;
}

@Injectable()
export class ChatAdsReadService {
  constructor(
    private readonly ads: ChatAdDbOperation,
    private readonly db: ChatDbOperation,
    private readonly access: ChatAccessService,
    private readonly settings: ChatSettingsService,
  ) {}

  private view(ad: AdRecord, settings: ChatSettings) {
    return {
      id: ad.id,
      content: ad.content,
      roomIds: ad.roomIds,
      allRooms: ad.allRooms,
      pinMinutes: ad.pinMinutes,
      repeatCount: ad.repeatCount,
      repeatGapMinutes: ad.repeatGapMin,
      postedCount: ad.postedCount,
      nextPostAt: ad.nextPostAt?.toISOString() ?? null,
      badge: ad.badgeId ? (settings.ads.badges.find((b) => b.id === ad.badgeId) ?? null) : null,
      skin: adSkinOf(ad.skinId, settings),
      priceUsd: utility.toDisplayUsd(ad.priceUsd),
      status: ad.status,
      createdAt: ad.createdAt.toISOString(),
      endedAt: ad.endedAt?.toISOString() ?? null,
      refundUsd: ad.refundUsd ? utility.toDisplayUsd(ad.refundUsd) : null,
    };
  }

  /**
   * What the ad composer needs before quoting: whether ads are on, the badges and skins to pick from (with the skin
   * price), the link, length, pinned and repeat limits, and the price rules. Never what other users paid.
   */
  async options() {
    const ads = (await this.settings.global()).ads;
    return {
      enabled: ads.enabled,
      separateTab: ads.separateTab,
      allRoomsByDefault: ads.allRoomsByDefault,
      maxChars: ads.maxChars,
      maxFreeLinks: ads.maxFreeLinks,
      maxPaidLinks: ads.maxPaidLinks,
      badges: ads.badges,
      skins: ads.skins.map((s) => ({
        id: s.id,
        name: s.name,
        style: s.style,
        priceUsd: s.priceUsd,
      })),
      pinned: {
        enabled: ads.pinned.enabled,
        minMinutes: ads.pinned.minMinutes,
        maxMinutes: ads.pinned.maxMinutes,
      },
      repeat: {
        enabled: ads.repeat.enabled,
        minCount: ads.repeat.minCount,
        maxCount: ads.repeat.maxCount,
        minGapMinutes: ads.repeat.minGapMinutes,
        maxGapMinutes: ads.repeat.maxGapMinutes,
        discountPercent: ads.repeat.discountPercent,
        maxDiscountPercent: ads.repeat.maxDiscountPercent,
      },
      basePriceUsd: ads.basePriceUsd,
    };
  }

  async mine(user: ChatUserContext, query: { limit?: number; cursor?: string }) {
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.ads.adsByCreator(
      user.id,
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    const settings = await this.settings.global();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((ad) => ({
        ...this.view(ad, settings),
        breakdown: ad.breakdown,
      })),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
    };
  }

  /** "Separate Advertisement Tab: ON / OFF": running ads the viewer's country may see. */
  async feed(user: ChatUserContext, query: { limit?: number; cursor?: string }) {
    const settings = await this.settings.global();
    if (!settings.ads.separateTab) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_DISABLED,
        'The advertisement tab is off',
      );
    }
    const country = (await this.access.factsFor(user)).country;
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.ads.activeAds(
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
      country,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const names = await this.db.usersByIds(
      page.map((ad) => ad.creatorId).filter((id): id is string => id !== null),
    );
    return {
      items: page
        .map((ad) => {
          // What other users paid is not theirs to see.
          const view: Partial<ReturnType<ChatAdsReadService['view']>> = this.view(ad, settings);
          delete view.priceUsd;
          delete view.refundUsd;
          return {
            ...view,
            advertiser: ad.creatorId ? (names.get(ad.creatorId) ?? null) : 'OREBiT',
          };
        }),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
    };
  }
}
