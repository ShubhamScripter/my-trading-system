// Gift cards in a direct conversation (Module 8, , ): "Gift cards/coupons chat se bhejna". The card is owned
// by the coupon module (CouponPort); chat checks the gift rules, asks the module to give the card, and posts a CARD
// message that shows the title and value and never the code.
// The rules are the gift rules of money: the sender and the receiver may not be restricted from gifts,
// and nobody gifts someone who blocked or muted them. A card goes only to a person in an accepted conversation.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import type { ChatUserContext } from '../chat.types';
import { assertAvailable } from '../services/chat.availability';
import { ChatActionGate } from '../services/chat.action-gate.service';
import { ChatRelationsService } from '../services/chat.relations.service';
import { ChatRestrictionsService } from '../services/chat.restrictions.service';
import { DmDbOperation } from './dm.dboperation';
import { DmMessagesDbOperation } from './dm.messages.dboperation';
import { DmService } from './dm.service';

@Injectable()
export class DmCardsService {
  constructor(
    private readonly dm: DmDbOperation,
    private readonly messagesDb: DmMessagesDbOperation,
    private readonly messages: DmService,
    private readonly access: ChatAccessService,
    private readonly ports: ChatFeaturePorts,
    private readonly moderation: ChatModerationService,
    private readonly restrictions: ChatRestrictionsService,
    private readonly relations: ChatRelationsService,
    private readonly gate: ChatActionGate,
  ) {}

  // Sends one of the user's gift cards to the other person of a direct conversation. `clientMessageId` makes a retry
// safe: it is the reference the coupon module de-duplicates on and the message's own client id.
  async send(
    user: ChatUserContext,
    conversationId: string,
    input: { couponId: string; clientMessageId: string },
    ip: string,
  ) {
    const settings = await this.messages.guard(true);
    // A gift card is a gift: the same gate as money gifts (the switch, restrictions, standing and the pace).
    await this.gate.assert(user, 'send', { ip });
    if (!settings.gifts.enabled) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.FEATURE_DISABLED, 'Sending gifts from chat is off');
    }
    assertAvailable(settings, 'giftsInChat', true);
    const me = await this.messages.requireMember(user.id, conversationId, ['ACTIVE']);
    if (me.kind !== 'DIRECT') {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'conversationId', message: 'Gift cards are sent in direct conversations' }],
      });
    }
    const other = (await this.dm.members(conversationId)).find((m) => m.userId !== user.id);
    if (!other || other.state !== 'ACTIVE') {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FRIENDS_ONLY,
        'A gift card goes only to someone who has accepted the conversation',
      );
    }

    const dbNow = await this.dm.dbNow();
    await this.moderation.assertNotBanned(user, null, dbNow);
    const sender = await this.restrictions.find(user, await this.access.factsFor(user), 'RESTRICT_GIFTS', null, dbNow);
    if (sender) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, sender.reason, {
        restriction: 'RESTRICT_GIFTS',
        expiresAt: sender.expiresAt,
      });
    }
    const receiver: ChatUserContext = { id: other.userId, username: other.username ?? '', publicCode: '', staffRole: null };
    const receiving = await this.restrictions.find(
      receiver,
      await this.access.factsFor(receiver),
      'RESTRICT_RECEIVE_GIFTS',
      null,
      dbNow,
    );
    if (receiving) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, 'This user cannot receive gifts through chat', {
        restriction: 'RESTRICT_RECEIVE_GIFTS',
      });
    }
    const relation = await this.relations.relation(user.id, other.userId);
    if (relation.iBlocked || relation.blockedMe) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.BLOCKED, 'You cannot send a gift to this user');
    }
    if (!settings.gifts.allowToMutedBlocked && (relation.iMuted || relation.mutedMe)) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.BLOCKED, 'You cannot send a gift to a muted user');
    }

    const coupons = await this.ports.coupons();
    if (!coupons) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE, 'Gift cards are not connected yet');
    }
    const card = await coupons.describe(user.id, input.couponId);
    if (!card) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Gift card not found' });
    const given = await coupons.give({
      reference: input.clientMessageId,
      couponId: input.couponId,
      fromUserId: user.id,
      toUserId: other.userId,
    });
    if (given.status === 'FAILED') {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE, given.reason);
    }
    const { row, duplicate } = await this.messagesDb.insertMessage({
      conversationId,
      senderId: user.id,
      content: `Sent a gift card: ${card.title}`,
      type: 'CARD',
      metadata: {
        card: {
          title: card.title,
          amount: card.amount,
          currency: card.currency,
          receiverUsername: other.username ?? '',
        },
      },
      clientMessageId: input.clientMessageId,
    });
    if (!duplicate) await this.messages.deliver(row);
    return { messageId: row.id, duplicate };
  }
}
