/** Admin service for chat monetization: manages advertisements, gift transfers, and bulk financial reverts. */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ERR } from '../../../contracts';
import { ProblemException, parseDto } from '../../../http';
import { ChatModerationDbOperation } from '../chat-moderation.dboperation';
import { ChatRoomDbOperation } from '../chat-room.dboperation';
import type { ChatSettings } from '../chat.settings.contract';
import { ChatSettingsAdminService } from './chat.settings.service';
import { ChatMoneyDbOperation } from '../persistence/chat-money.dboperation';

type AdSettings = ChatSettings['ads'];
const UUID = z.string().uuid();
const LIMIT = z.coerce.number().int().min(1).max(200).default(50);
const USD = z.string().regex(/^\d{1,12}(\.\d{1,8})?$/, 'A USD amount');

export const AdsQuerySchema = z
  .object({
    status: z
      .enum(['PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'ALL'])
      .default('ALL'),
    limit: LIMIT,
  })
  .strict();

export const CreateAdminAdSchema = z
  .object({
    content: z.string().trim().min(1).max(1000),
    roomIds: z.array(UUID).max(200).default([]),
    allRooms: z.boolean().default(false),
    pinMinutes: z.number().int().min(1).max(10080).nullable().default(null),
    repeatCount: z.number().int().min(0).max(100).default(0),
    repeatGapMinutes: z.number().int().min(1).max(10080).nullable().default(null),
    badgeId: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .nullable()
      .default(null),
    hiddenCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(250)
      .default([]),
  })
  .strict()
  .refine((ad) => ad.allRooms || ad.roomIds.length > 0, {
    message: 'Choose rooms or all rooms',
    path: ['roomIds'],
  })
  .refine((ad) => ad.repeatCount === 0 || ad.repeatGapMinutes !== null, {
    message: 'A repeated ad needs repeatGapMinutes',
    path: ['repeatGapMinutes'],
  });

export const CancelAdSchema = z
  .object({
    adId: UUID,
    /** "Refund Pending Views" (UNUSED) or "Refund Complete ad price" (FULL). */
    refund: z.enum(['NONE', 'UNUSED', 'FULL']).default('UNUSED'),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const GiftsQuerySchema = z
  .object({
    status: z
      .enum([
        'PENDING_VERIFICATION',
        'PROCESSING',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'REVERT_PENDING',
        'REVERTED',
        'REVERT_FAILED',
        'ALL',
      ])
      .default('ALL'),
    userId: z.string().trim().min(1).max(64).optional(),
    limit: LIMIT,
  })
  .strict();

export const CommandLogQuerySchema = z
  .object({ userId: z.string().trim().min(1).max(64).optional(), limit: LIMIT })
  .strict();

/** "for a Specific Time Frame [for specific users / group of users] [for a specific amount range]". */
const RevertBase = {
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  /** Ids, usernames or login codes. */
  userIds: z.array(z.string().trim().min(1).max(64)).max(500).default([]),
  minUsd: USD.optional(),
  maxUsd: USD.optional(),
  /** Target group of users (Premium, KYC, Level threshold) queued for batch revert execution. */
  group: z
    .object({
      targetType: z.enum(['PREMIUM', 'KYC', 'LEVEL']),
      value: z.string().trim().regex(/^\d{0,6}$/, 'A level').default(''),
    })
    .strict()
    .optional(),
  /** true: only count and list what would be reverted. */
  dryRun: z.boolean().default(false),
  // Required written reason on every revert (minimum 3 characters).
  reason: z.string().trim().min(3).max(500).optional(),
  note: z.string().trim().max(500).optional(),
  // Explicit revert all flag required when no specific filter is specified.
  revertAll: z.boolean().default(false),
};

export const RevertAdsSchema = z
  .object({
    ...RevertBase,
    /** "for specific Ad". */
    adIds: z.array(UUID).max(500).default([]),
    /** "for specific settings": only ads with a pinned slot. */
    pinnedOnly: z.boolean().default(false),
  })
  .strict()
  .refine((r) => Date.parse(r.from) < Date.parse(r.to), {
    message: 'from must be before to',
    path: ['to'],
  })
  .refine((r) => Boolean((r.reason && r.reason.length >= 3) || (r.note && r.note.length >= 3)), {
    message: 'A written reason of at least 3 characters is required for every revert',
    path: ['reason'],
  })
  .refine(
    (r) =>
      r.revertAll ||
      r.userIds.length > 0 ||
      r.minUsd !== undefined ||
      r.maxUsd !== undefined ||
      r.group !== undefined ||
      r.adIds.length > 0 ||
      r.pinnedOnly,
    {
      message: 'A bulk revert must name a filter or set revertAll: true',
      path: ['revertAll'],
    },
  );

export const RevertGiftsSchema = z
  .object({
    ...RevertBase,
    /** "for specific Currencies". */
    currencies: z
      .array(z.string().regex(/^[A-Z0-9]{2,12}$/))
      .max(50)
      .default([]),
    /** "Refund Fees: YES / NO". */
    refundFees: z.boolean().default(false),
    // Shortfall handling strategy when recipient has insufficient balance.
    shortfall: z.enum(['ZERO', 'NEGATIVE']),
  })
  .strict()
  .refine((r) => Date.parse(r.from) < Date.parse(r.to), {
    message: 'from must be before to',
    path: ['to'],
  })
  .refine((r) => Boolean((r.reason && r.reason.length >= 3) || (r.note && r.note.length >= 3)), {
    message: 'A written reason of at least 3 characters is required for every revert',
    path: ['reason'],
  })
  .refine(
    (r) =>
      r.revertAll ||
      r.userIds.length > 0 ||
      r.minUsd !== undefined ||
      r.maxUsd !== undefined ||
      r.group !== undefined ||
      r.currencies.length > 0,
    {
      message: 'A bulk revert must name a filter or set revertAll: true',
      path: ['revertAll'],
    },
  );

@Injectable()
export class ChatMoneyService {
  constructor(
    private readonly money: ChatMoneyDbOperation,
    private readonly moderation: ChatModerationDbOperation,
    private readonly rooms: ChatRoomDbOperation,
    private readonly settings: ChatSettingsAdminService,
  ) {}

  private async userId(handle: string): Promise<string> {
    const id = await this.moderation.resolveUserId(handle);
    if (!id)
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: `User '${handle}' not found` });
    return id;
  }

  private async userIds(handles: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const handle of handles) ids.push(await this.userId(handle));
    return ids;
  }

  private window(dto: { from: string; to: string; minUsd?: string; maxUsd?: string }) {
    return { from: dto.from, to: dto.to, minUsd: dto.minUsd ?? null, maxUsd: dto.maxUsd ?? null };
  }

  // Ads
  async ads(query: unknown) {
    const q = parseDto(AdsQuerySchema, query);
    return { ads: await this.money.ads(q.status, q.limit) };
  }

  /** Creates an administrative advertisement with verified room permissions and pin schedules. */
  async createAd(body: unknown, adminId: string) {
    const dto = parseDto(CreateAdminAdSchema, body);
    const ads = ((await this.settings.preview()) as { ads: AdSettings }).ads;
    const roomIds = await this.resolveAdRooms(dto.allRooms, dto.roomIds, ads);
    if (dto.badgeId !== null && !ads.badges.some((b) => b.id === dto.badgeId)) {
      throw new ProblemException({ type: ERR.VALIDATION_FAILED, detail: 'badgeId is not a badge the admin offers' });
    }
    if (dto.pinMinutes !== null) {
      const p = ads.pinned;
      if (!p.enabled) throw new ProblemException({ type: ERR.VALIDATION_FAILED, detail: 'Pinned ads are off' });
      if (dto.pinMinutes < p.minMinutes || dto.pinMinutes > p.maxMinutes) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          detail: `pinMinutes must be from ${p.minMinutes} to ${p.maxMinutes}`,
        });
      }
    }
    const id = await this.money.createAdminAd({
      adminId,
      content: dto.content,
      roomIds,
      allRooms: dto.allRooms,
      pinMinutes: dto.pinMinutes,
      repeatCount: dto.repeatCount,
      repeatGapMin: dto.repeatGapMinutes,
      badgeId: dto.badgeId,
      hiddenCountries: dto.hiddenCountries,
    });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'CREATE_AD',
      newValue: { adId: id, roomIds, allRooms: dto.allRooms },
    });
    await this.moderation.notify({ kind: 'ad', adId: id });
    return { adId: id, roomIds };
  }

  /** The rooms an ad may run in: the user-side rule, applied to the rooms as they are now. */
  private async resolveAdRooms(allRooms: boolean, wanted: readonly string[], ads: AdSettings): Promise<string[]> {
    const accepting = (await this.rooms.getRooms()).filter(
      (room) =>
        !room.deletedAt &&
        room.type !== 'STAFF' &&
        room.status === 'ACTIVE' &&
        room.contentControls.allowAds &&
        !room.controlsMaintenance.includes('ADS') &&
        (ads.allowedRoomIds.length === 0 || ads.allowedRoomIds.includes(room.id)),
    );
    if (allRooms) {
      if (accepting.length === 0) {
        throw new ProblemException({ type: ERR.VALIDATION_FAILED, detail: 'No room accepts ads right now' });
      }
      return accepting.map((room) => room.id);
    }
    const ok = new Set(accepting.map((room) => room.id));
    const refused = [...new Set(wanted)].filter((id) => !ok.has(id));
    if (refused.length > 0) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'Ads are not allowed in, or there is no such room: ' + refused.join(', '),
      });
    }
    return [...new Set(wanted)];
  }

  async cancelAd(body: unknown, adminId: string) {
    const dto = parseDto(CancelAdSchema, body);
    const cancelled = await this.money.cancelAd(dto.adId, adminId, dto.note ?? null, dto.refund);
    if (!cancelled.cancelled) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'This ad has already ended',
      });
    }
    const refundUsd = cancelled.refundUsd;
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'CANCEL_AD',
      newValue: { adId: dto.adId, refund: dto.refund, refundUsd },
      note: dto.note ?? null,
    });
    // The chat server unpins it and pays the refund through the payment module.
    await this.moderation.notify({ kind: 'ad', adId: dto.adId });
    return { adId: dto.adId, status: 'CANCELLED', refundUsd };
  }

  // Reverts (Chat SETTINGS "MODERATION Actions")
  /**
   * "Revert ALL Advertisements for a Specific Time Frame": running ads stop and are refunded "only for Pending /
   * uncompleted views, not the utilised ones"; for every ad matched, "Reverting will also revert EXP and Stars
   * Earned" (the chat server takes them back). `dryRun` lists what would be reverted.
   */
  async revertAds(body: unknown, adminId: string) {
    const dto = parseDto(RevertAdsSchema, body);
    const userIds = await this.userIds(dto.userIds);
    const ads = await this.money.adsForRevert({
      ...this.window(dto),
      userIds,
      adIds: dto.adIds,
      pinnedOnly: dto.pinnedOnly,
    });
    if (dto.group) {
      // "group of users": the chat server keeps only the ads whose advertiser is in the group.
      if (dto.dryRun) return { dryRun: true, count: ads.length, groupCheckedLater: true };
      const jobId = await this.money.queueGroupRevert('ADS', adminId, {
        ...this.window(dto),
        userIds,
        group: dto.group,
        note: dto.note ?? null,
        adIds: dto.adIds,
        pinnedOnly: dto.pinnedOnly,
      });
      await this.moderation.recordModerationAction({
        actorId: adminId,
        action: 'REVERT_ADS',
        newValue: { ...dto, jobId, candidates: ads.length },
        note: dto.note ?? null,
      });
      return { dryRun: false, queued: true, jobId, candidates: ads.length };
    }
    if (dto.dryRun) return { dryRun: true, count: ads.length, adIds: ads.map((a) => a.id) };
    let refunded = 0;
    for (const ad of ads.filter((a) => a.status === 'ACTIVE' || a.status === 'PAUSED')) {
      if ((await this.money.cancelAd(ad.id, adminId, dto.note ?? 'Reverted by admin', 'UNUSED')).cancelled) {
        refunded += 1;
        await this.moderation.notify({ kind: 'ad', adId: ad.id });
      }
    }
    const rewards = await this.money.markAdRewardsRevert(ads.map((a) => a.id));
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'REVERT_ADS',
      newValue: { ...dto, count: ads.length, stopped: refunded, rewardsReverted: rewards },
      note: dto.note ?? null,
    });
    // The chat server pays the refunds and takes back the rewards on its next tick.
    return { dryRun: false, count: ads.length, stopped: refunded, rewardsReverted: rewards };
  }

  /**
   * "Revert ALL Transfers for a Specific Time Frame [for specific users] [Currencies] [amount range]", with "Refund
   * Fees: YES / NO". Gifts are marked REVERT_PENDING; the chat server asks the transfer module to move each back —
   * "If the user doesn't have enough balance, revert will not be conducted" (REVERT_FAILED with the reason) — and
   * takes back the EXP and currency the gift earned.
   */
  async revertGifts(body: unknown, adminId: string) {
    const dto = parseDto(RevertGiftsSchema, body);
    const userIds = await this.userIds(dto.userIds);
    const effectiveNote = dto.reason ?? dto.note ?? 'Reverted by admin';
    if (dto.group) {
      // "group of users": the chat server keeps only the transfers whose sender or recipient is in the group.
      const candidates = await this.money.revertGifts({
        ...this.window(dto),
        userIds,
        currencies: dto.currencies,
        refundFees: dto.refundFees,
        adminId,
        dryRun: true,
        shortfall: dto.shortfall,
        reason: effectiveNote,
      });
      if (dto.dryRun) return { dryRun: true, count: candidates.count, usdValue: candidates.usd, groupCheckedLater: true };
      const jobId = await this.money.queueGroupRevert('GIFTS', adminId, {
        ...this.window(dto),
        userIds,
        group: dto.group,
        note: effectiveNote,
        currencies: dto.currencies,
        refundFees: dto.refundFees,
      });
      await this.moderation.recordModerationAction({
        actorId: adminId,
        action: 'REVERT_GIFTS',
        newValue: { ...dto, jobId, candidates: candidates.count },
        note: effectiveNote,
      });
      return { dryRun: false, queued: true, jobId, candidates: candidates.count };
    }
    const result = await this.money.revertGifts({
      ...this.window(dto),
      userIds,
      currencies: dto.currencies,
      refundFees: dto.refundFees,
      adminId,
      dryRun: dto.dryRun,
      shortfall: dto.shortfall,
      reason: effectiveNote,
    });
    if (!dto.dryRun) {
      await this.moderation.recordModerationAction({
        actorId: adminId,
        action: 'REVERT_GIFTS',
        newValue: { ...dto, count: result.count, usd: result.usd },
        note: effectiveNote,
      });
    }
    return { dryRun: dto.dryRun, count: result.count, usdValue: result.usd };
  }

  // Gifts and the command log
  async gifts(query: unknown) {
    const q = parseDto(GiftsQuerySchema, query);
    return {
      gifts: await this.money.gifts(
        q.status,
        q.userId ? await this.userId(q.userId) : null,
        q.limit,
      ),
    };
  }

  async commandLog(query: unknown) {
    const q = parseDto(CommandLogQuerySchema, query);
    return {
      commands: await this.money.commandLog(q.userId ? await this.userId(q.userId) : null, q.limit),
    };
  }
}
