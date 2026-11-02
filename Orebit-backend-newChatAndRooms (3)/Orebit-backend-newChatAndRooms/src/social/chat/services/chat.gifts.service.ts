// Handles peer-to-peer gifts and transfers in public rooms and direct messages.
import { Injectable, Logger } from '@nestjs/common';
import { compare, isPositive, money } from '../platform/money';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, SERVER_EVENTS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatSettingsService } from '../chat.settings';
import { ChatGiftDbOperation, type GiftRecord } from '../persistence/chat.gift.dboperation';
import { ChatDelivery } from '../realtime/chat.delivery';
import type { ChatUserContext, GiftMetadata, MessageRow, RoomRecord } from '../chat.types';
import { uuidv7 } from '../../../utils/public.utils';
import { assertAvailable } from './chat.availability';
import { ChatRelationsService } from './chat.relations.service';
import { ChatRestrictionsService } from './chat.restrictions.service';

// How long a started gift waits for its verification code.
export const GIFT_VERIFICATION_MINUTES = 10;

const AMOUNT = /^\d{1,18}(\.\d{1,18})?$/;
const CURRENCY = /^[A-Z0-9]{2,12}$/;

// Posts a gift notice into a DM conversation; registered by the DM service (Module 8).
export type DmGiftPoster = (gift: GiftRecord, notice: GiftMetadata) => Promise<void>;

@Injectable()
export class ChatGiftsService {
  private readonly logger = new Logger('ChatGiftsService');
  private dmPoster: DmGiftPoster | null = null;

  constructor(
    private readonly gifts: ChatGiftDbOperation,
    private readonly db: ChatDbOperation,
    private readonly access: ChatAccessService,
    private readonly settings: ChatSettingsService,
    private readonly ports: ChatFeaturePorts,
    private readonly moderation: ChatModerationService,
    private readonly restrictions: ChatRestrictionsService,
    private readonly relations: ChatRelationsService,
    private readonly delivery: ChatDelivery,
  ) {}

  registerDmPoster(poster: DmGiftPoster): void {
    this.dmPoster = poster;
  }

  // Step 1. `place` is where the notice goes: a public room or a DM conversation (checked by the caller).
  async start(
    user: ChatUserContext,
    input: {
      recipient: string;
      amount: string;
      currency: string;
      roomId?: string | null;
      conversationId?: string | null;
    },
  ) {
    const settings = await this.settings.global();
    if (!settings.gifts.enabled) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_DISABLED,
        'Sending money from chat is off',
      );
    }
    if (settings.gifts.processingStaleMinutes === null) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
        'Gift processing limits have not been configured by an administrator',
      );
    }
    assertAvailable(settings, 'giftsInChat', true);
    const amount = input.amount.trim();
    const currency = input.currency.trim().toUpperCase();
    if (!AMOUNT.test(amount) || !isPositive(amount)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'amount', message: 'A positive amount, at most 18 decimals' }],
      });
    }
    if (!CURRENCY.test(currency)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'currency', message: 'A currency code such as USDT' }],
      });
    }

    const dbNow = await this.db.dbNow();
    // A room is named only to post the notice there: the user needs the same view and write rights as for a message
    // (a hidden or Staff room answers like any outsider, a view-only room refuses), and a room ban applies.
    let room: RoomRecord | null = null;
    if (input.roomId) {
      const seen = await this.access.assertCanView(user, input.roomId);
      if (!seen.access.isEligibleToWrite) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.ROOM_READ_ONLY,
          seen.access.reason ?? 'You cannot write in this room',
          { roomId: seen.room.id },
        );
      }
      room = seen.room;
    }
    await this.moderation.assertNotBanned(user, room?.id ?? null, dbNow);
    const facts = await this.access.factsFor(user);
    // Transfer KYC eligibility is owned by the transfer provider below; chat's publicChat entitlement is only for
    // chat access and must not invent a transfer KYC level for gifts.
    const restricted = await this.restrictions.find(user, facts, 'RESTRICT_GIFTS', room, dbNow);
    if (restricted) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, restricted.reason, {
        restriction: 'RESTRICT_GIFTS',
        expiresAt: restricted.expiresAt,
      });
    }

    const recipientId = await this.db.resolvePublicUsername(input.recipient);
    const recipient = recipientId ? await this.db.findChatUser(recipientId) : null;
    if (!recipient)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'User not found',
      });
    if (recipient.id === user.id) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'recipient', message: 'You cannot send money to yourself' }],
      });
    }
    // "Restrict a user from receiving Amount through chat" (Module 4).
    const receiving = await this.restrictions.find(
      recipient,
      await this.access.factsFor(recipient),
      'RESTRICT_RECEIVE_GIFTS',
      room,
      dbNow,
    );
    if (receiving) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.RESTRICTED,
        'This user cannot receive money through chat',
        {
          restriction: 'RESTRICT_RECEIVE_GIFTS',
        },
      );
    }
    // "Maximum / Minimum Amount that can be sent through chat … Set separately for each crypto".
    const own = settings.gifts.perCurrency[currency];
    if (
      own &&
      ((own.min && compare(amount, own.min) < 0) || (own.max && compare(amount, own.max) > 0))
    ) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.LIMIT_REACHED,
        `The amount is outside the chat limits for ${currency}`,
        {
          currency,
          min: own.min,
          max: own.max,
        },
      );
    }
    const relation = await this.relations.relation(user.id, recipient.id);
    if (relation.blockedMe || relation.mutedMe) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.BLOCKED,
        'You cannot send money to this user',
      );
    }
    if (!settings.gifts.allowToMutedBlocked && (relation.iBlocked || relation.iMuted)) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.BLOCKED,
        'You cannot send money to a muted or blocked user',
      );
    }

    const transfer = await this.ports.transfer();
    if (!transfer) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
        'Transfers are not connected yet',
      );
    }
    if (await transfer.isRestricted(user.id)) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.RESTRICTED,
        'You cannot make transfers right now',
        { restriction: 'USER_TO_USER_TRANSFER' },
      );
    }
    if (await transfer.isRestricted(recipient.id)) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.RESTRICTED,
        'This user cannot receive money right now',
        { restriction: 'RECEIVE_THROUGH_CHAT' },
      );
    }
    const quote = await transfer.quote({
      senderId: user.id,
      recipientId: recipient.id,
      currency,
      amount,
      kind: 'CHAT_GIFT',
    });
    if (!quote.ok) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.PAYMENT_FAILED,
        'This transfer is not possible',
        { detail: quote.reason },
      );
    }
    // "Maximum / Minimum Amount that can be sent through chat: X USD … Same as Internal Transfer".
    const minUsd = settings.gifts.minUsd ?? quote.minUsd;
    const maxUsd = settings.gifts.maxUsd ?? quote.maxUsd;
    const usd = money(quote.usdValue);
    if ((minUsd && usd.lt(minUsd)) || (maxUsd && usd.gt(maxUsd))) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.LIMIT_REACHED,
        'The amount is outside the chat limits',
        { minUsd, maxUsd, usdValue: quote.usdValue },
      );
    }

    const id = uuidv7();
    const hasPin = await this.ports.hasPaymentPin(user.id);
    const verification = hasPin ? ('PAYMENT_PIN' as const) : null;
    const { expiresAt } = await this.gifts.insert({
      id,
      senderId: user.id,
      recipientId: recipient.id,
      currency,
      amount,
      usdValue: quote.usdValue,
      feeAmount: quote.feeAmount,
      roomId: room?.id ?? null,
      conversationId: input.conversationId ?? null,
      verification: 'PAYMENT_PIN',
      minutes: GIFT_VERIFICATION_MINUTES,
    });
    return {
      giftId: id,
      status: 'PENDING_VERIFICATION' as const,
      verification,
      recipient: { username: recipient.username },
      amount,
      currency,
      usdValue: quote.usdValue,
      feeAmount: quote.feeAmount,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // What the gift form needs: on or off, the USD limits, the per-currency limits and which code is asked.
  async options(user?: ChatUserContext) {
    const gifts = (await this.settings.global()).gifts;
    const transfer = await this.ports.transfer();
    let currencies: { currency: string; min?: string | null; max?: string | null }[] = [];
    if (transfer?.currencies) {
      try {
        const list = await transfer.currencies(user?.id);
        currencies = list.map((c) => ({
          currency: c.currency,
          min: gifts.perCurrency[c.currency]?.min ?? c.min,
          max: gifts.perCurrency[c.currency]?.max ?? c.max,
        }));
      } catch (err: unknown) {
        this.logger.warn({ component: 'ChatGiftsService', err, userId: user?.id }, 'transfer currencies query failed');
      }
    }
    if (currencies.length === 0) {
      currencies = Object.entries(gifts.perCurrency).map(([currency, limits]) => ({
        currency,
        ...limits,
      }));
    }
    return {
      enabled: gifts.enabled,
      minUsd: gifts.minUsd,
      maxUsd: gifts.maxUsd,
      verification: 'PAYMENT_PIN' as const,
      currencies,
    };
  }

  // Step 2: the code, then the transfer, then the notice.
  async confirm(user: ChatUserContext, giftId: string, code: string) {
    const gift = await this.gifts.byId(giftId);
    if (!gift || gift.senderId !== user.id) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Gift not found',
      });
    }
    if (gift.status !== 'PENDING_VERIFICATION' || gift.expired) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.GIFT_EXPIRED,
        'This gift is no longer waiting for you',
        { status: gift.status },
        409,
      );
    }
    const dbNow = await this.db.dbNow();
    const room = gift.roomId ? await this.access.findRoom(gift.roomId) : null;
    await this.moderation.assertNotBanned(user, gift.roomId, dbNow);
    const facts = await this.access.factsFor(user);
    const restriction = await this.restrictions.find(user, facts, 'RESTRICT_GIFTS', room, dbNow);
    if (restriction) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, restriction.reason, {
        restriction: 'RESTRICT_GIFTS',
        expiresAt: restriction.expiresAt,
      });
    }
    const hasPin = await this.ports.hasPaymentPin(user.id);
    if (hasPin) {
      const verified = await this.ports.verify(user.id, 'PAYMENT_PIN', code.trim());
      if (verified === null) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
          'This verification method is not connected',
          { verification: 'PAYMENT_PIN' },
        );
      }
      if (!verified) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.VERIFICATION_FAILED,
          'The code is not correct',
          { verification: 'PAYMENT_PIN' },
        );
      }
    }
    if (!(await this.gifts.claim(gift.id))) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.GIFT_EXPIRED,
        'This gift is no longer waiting for you',
        {},
        409,
      );
    }

    const transfer = await this.ports.transfer();
    if (!transfer) {
      await this.gifts.finish(gift.id, 'FAILED', null, 'transfer module not connected');
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
        'Transfers are not connected yet',
      );
    }
    let outcome: Awaited<ReturnType<typeof transfer.transfer>>;
    try {
      outcome = await transfer.transfer({
        reference: gift.id,
        senderId: gift.senderId,
        recipientId: gift.recipientId,
        currency: gift.currency,
        amount: gift.amount,
        kind: 'CHAT_GIFT',
      });
    } catch (err: unknown) {
      // Left PROCESSING: the transfer module may still complete it under this reference.
      this.logger.error({ component: 'ChatGiftsService', err, giftId }, 'transfer call failed');
      throw err;
    }
    if (outcome.status === 'FAILED') {
      await this.gifts.finish(gift.id, 'FAILED', null, outcome.reason);
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.PAYMENT_FAILED, 'The transfer failed', {
        detail: outcome.reason,
      });
    }
    if (outcome.status === 'ON_HOLD') {
      await this.gifts.finish(gift.id, 'HELD', outcome.holdId, 'Transfer is on hold');
      return {
        giftId: gift.id,
        status: 'HELD' as const,
        holdId: outcome.holdId,
        message: 'The transfer is on hold for review',
      };
    }
    const completed = await this.completeTransfer(gift, outcome.reference, user.username);
    if (!completed) {
      const current = await this.gifts.byId(gift.id);
      if (current?.status !== 'COMPLETED') {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.PAYMENT_PENDING,
          'The transfer completed but its status is still being reconciled',
          { giftId: gift.id },
          409,
        );
      }
    }
    return {
      giftId: gift.id,
      status: 'COMPLETED' as const,
      reference: outcome.reference,
    };
  }

  // Marks transfer COMPLETED idempotently, awards user rewards, and emits notices.
  async completeTransfer(gift: GiftRecord, reference: string, senderName: string | null): Promise<boolean> {
    if (!(await this.gifts.finish(gift.id, 'COMPLETED', reference, null))) return false;

    const names = await this.db.usersByIds([gift.recipientId, gift.senderId]);
    const sender = names.get(gift.senderId) ?? senderName ?? '';
    const notice: GiftMetadata = {
      giftId: gift.id,
      recipientUsername: names.get(gift.recipientId) ?? '',
      currency: gift.currency,
      amount: gift.amount,
    };
    await this.postNotice(gift, notice, sender);
    this.delivery.toUser(gift.recipientId, SERVER_EVENTS.GIFT_RECEIVED, {
      ...notice,
      senderUsername: sender,
      roomId: gift.roomId,
      conversationId: gift.conversationId,
    });
    return true;
  }

  async cancel(user: ChatUserContext, giftId: string) {
    if (!(await this.gifts.cancel(giftId, user.id))) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'No gift waiting for verification',
      });
    }
    return { giftId, status: 'CANCELLED' as const };
  }

  private async postNotice(
    gift: GiftRecord,
    notice: GiftMetadata,
    senderName: string,
  ): Promise<void> {
    try {
      if (gift.conversationId && this.dmPoster) {
        await this.dmPoster(gift, notice);
        return;
      }
      if (!gift.roomId) return;
      const room = await this.access.findRoom(gift.roomId);
      if (!room) return;
      const { row }: { row: MessageRow } = await this.db.insertMessage({
        roomId: room.id,
        userId: gift.senderId,
        content: `${senderName} sent ${notice.amount} ${notice.currency} to @${notice.recipientUsername}`,
        type: 'GIFT',
        skinId: null,
        metadata: { gift: notice },
        taggedUserIds: [],
      });
      this.delivery.publish(row);
    } catch (err: unknown) {
      // The money moved; a missing notice is logged, never a failed gift.
      this.logger.error(
        { component: 'ChatGiftsService', err, giftId: gift.id },
        'could not post the gift notice',
      );
    }
  }
}
