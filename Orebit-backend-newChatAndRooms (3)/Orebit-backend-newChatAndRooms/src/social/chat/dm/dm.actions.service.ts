// Actions on existing DM messages: retraction, pinning, forwarding, reporting, and direct gifts.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, SERVER_EVENTS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { refuse } from '../chat.moderation.service';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import { ChatGiftsService } from '../services/chat.gifts.service';
import type { ChatUserContext } from '../chat.types';
import { DmDbOperation, type DmMessageRow, type MemberRow } from './dm.dboperation';
import { DmMessagesDbOperation } from './dm.messages.dboperation';
import { requireLimit } from './dm.limits';
import { ChatActionGate } from '../services/chat.action-gate.service';
import { DmService } from './dm.service';
import { toDmView } from './dm.view';

export type ForwardResult =
  | { conversationId: string; ok: true; messageId: string }
  | { conversationId: string; ok: false; error: { type: string; reason: string } };

@Injectable()
export class DmActionsService {
  constructor(
    private readonly dm: DmDbOperation,
    private readonly messagesDb: DmMessagesDbOperation,
    private readonly messages: DmService,
    private readonly access: ChatAccessService,
    private readonly records: ChatRecordsDbOperation,
    private readonly gifts: ChatGiftsService,
    private readonly gate: ChatActionGate,
  ) {}

  private invalid(path: string, message: string): ProblemException {
    return new ProblemException({ type: ERR.VALIDATION_FAILED, errors: [{ path, message }] });
  }

  // Retract, pin, forward
  private async readableMessage(
    user: ChatUserContext,
    messageId: string,
    includeArchivedForReport = false,
  ): Promise<{ row: DmMessageRow; me: MemberRow }> {
    const row = includeArchivedForReport
      ? await this.messagesDb.messageForReport(messageId)
      : await this.messagesDb.messageById(messageId);
    if (!row) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Message not found' });
    const me = await this.messages.requireMember(user.id, row.conversationId);
    if (me.kind === 'GROUP' && row.createdAt < me.joinedAt) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Message not found' });
    }
    return { row, me };
  }

  // Retracts a previously sent user message within the allowed retraction window.
  async retract(user: ChatUserContext, messageId: string) {
    await this.messages.guard(true);
    const { row } = await this.readableMessage(user, messageId);
    // The gift notice that proves a payment, and every other non-text notice, stays.
    if (row.type !== 'TEXT' && row.type !== 'MEDIA') {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.NOT_RETRACTABLE,
        'This kind of message can be removed only from the admin panel',
      );
    }
    if (row.senderId !== user.id) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.STAFF_ONLY,
        'You can retract only your own messages',
      );
    }
    const window = (await this.access.settingsFor(user)).limits.retractWindowSeconds;
    const dbNow = await this.dm.dbNow();
    if (window > 0 && dbNow.getTime() - row.createdAt.getTime() > window * 1000) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.RETRACT_WINDOW_PASSED,
        'Too late to retract this message',
      );
    }
    const done = await this.messagesDb.retract(messageId, user.id);
    if (!done)
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_RETRACTED,
        'Already retracted',
        {},
        409,
      );
    await this.messages.broadcast(row.conversationId, SERVER_EVENTS.DM_MESSAGE_RETRACTED, {
      conversationId: row.conversationId,
      messageId,
      retractedAt: done.retractedAt?.toISOString() ?? null,
    });
    return {
      messageId,
      conversationId: row.conversationId,
      retractedAt: done.retractedAt?.toISOString() ?? null,
    };
  }

  // Pins or unpins a DM or group message according to member role and conversation limits.
  async pin(user: ChatUserContext, messageId: string, pinned: boolean) {
    await this.messages.guard(true);
    const { row, me } = await this.readableMessage(user, messageId);
    if (row.type !== 'TEXT' && row.type !== 'MEDIA') {
      throw this.invalid('messageId', 'This message cannot be pinned');
    }
    if (me.kind === 'GROUP' && !['OWNER', 'ADMIN', 'SUB_ADMIN'].includes(me.role)) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.PERMISSION_DENIED,
        'Only group admins pin messages',
      );
    }
    if (pinned) {
      const max = requireLimit((await this.messages.settings()).dm.maxPinnedMessages, 'dm.maxPinnedMessages');
      if ((await this.messagesDb.pinnedMessageCount(row.conversationId)) >= max) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.LIMIT_REACHED,
          `At most ${max} pinned messages`,
          { max },
        );
      }
    }
    await this.messagesDb.setPinned(messageId, pinned ? user.id : null);
    await this.messages.broadcast(
      row.conversationId,
      pinned ? SERVER_EVENTS.DM_MESSAGE_PINNED : SERVER_EVENTS.DM_MESSAGE_UNPINNED,
      { conversationId: row.conversationId, messageId },
    );
    return { messageId, conversationId: row.conversationId, isPinned: pinned };
  }

  async pinnedMessages(user: ChatUserContext, conversationId: string) {
    await this.messages.guard(false);
    await this.messages.requireMember(user.id, conversationId);
    return {
      conversationId,
      items: (await this.messagesDb.pinnedMessages(conversationId)).map((row) => toDmView(row, user.id)),
    };
  }

  // Forwards an existing message to up to 10 conversations.
  async forward(user: ChatUserContext, messageId: string, conversationIds: string[], ip: string) {
    await this.messages.guard(true);
    const { row } = await this.readableMessage(user, messageId);
    if (row.retractedAt || row.hiddenAt || (row.type !== 'TEXT' && row.type !== 'MEDIA')) {
      throw this.invalid('messageId', 'This message cannot be forwarded');
    }
    const targets = [...new Set(conversationIds)].slice(0, 10);
    // Every target is tried; one refusal does not stop the rest and the caller learns the result of each.
    // A failure says no more than a single send to that conversation would: its machine-readable reason.
    const results: ForwardResult[] = [];
    for (const conversationId of targets) {
      try {
        const result = await this.messages.send(
          user,
          conversationId,
          {
            content: row.content,
            ...(row.metadata.media
              ? {
                  media: {
                    url: row.metadata.media.url,
                    type: row.metadata.media.type,
                    ...(row.metadata.media.thumbnailUrl
                      ? { thumbnailUrl: row.metadata.media.thumbnailUrl }
                      : {}),
                  },
                }
              : {}),
          },
          ip,
          { forwarded: { fromUsername: row.senderUsername } },
        );
        results.push({ conversationId, ok: true, messageId: result.message.id });
      } catch (err: unknown) {
        if (!(err instanceof ProblemException)) throw err;
        results.push({
          conversationId,
          ok: false,
          error: { type: err.type, reason: String(err.extra?.reason ?? err.type) },
        });
      }
    }
    return {
      messageId,
      forwarded: results.flatMap((r) =>
        r.ok ? [{ conversationId: r.conversationId, messageId: r.messageId }] : [],
      ),
      results,
    };
  }

  // Reports
  // Submits an abuse report for a direct message or group message.
  async report(
    user: ChatUserContext,
    messageId: string,
    dto: { reason: string; details?: string },
  ) {
    await this.messages.guard(true);
    const { row } = await this.readableMessage(user, messageId, true);
    if (row.senderId === user.id) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.CANNOT_REPORT_OWN_MESSAGE,
        'You cannot report your own message',
      );
    }
    if (row.type === 'SYSTEM') throw this.invalid('messageId', 'This message cannot be reported');
    if (!(await this.records.isActiveReason(dto.reason)))
      throw this.invalid('reason', 'Not a report reason');
    const limit = (await this.access.settingsFor(user)).limits.reportsPerHour;
    if ((await this.records.recentReportCount(user.id)) >= limit) {
      throw new ProblemException({
        type: ERR.RATE_LIMITED,
        detail: `At most ${limit} reports an hour`,
        extra: { reason: 'report_limit', remainingSeconds: 3600 },
        retryAfterSeconds: 3600,
      });
    }
    const report = await this.records.insertDmReport({
      dmMessageId: messageId,
      reporterId: user.id,
      reportedUserId: row.senderId,
      reason: dto.reason,
      details: dto.details ?? null,
    });
    if (!report) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_REPORTED,
        'You already reported this message',
        {},
        409,
      );
    }
    return {
      reportId: report.id,
      messageId,
      reason: dto.reason,
      createdAt: report.createdAt.toISOString(),
    };
  }

  // The gift button
  // Initiates a gift transfer to the other participant in a direct conversation.
  async startGift(
    user: ChatUserContext,
    conversationId: string,
    input: { amount: string; currency: string },
    ip: string,
  ) {
    this.messages.assertOpen(await this.messages.settings(), true);
    // The same gate as /send and the HTTP route: the switch, restrictions, standing and the pace.
    await this.gate.assert(user, 'send', { ip });
    const me = await this.messages.requireMember(user.id, conversationId, ['ACTIVE']);
    if (me.kind !== 'DIRECT')
      throw this.invalid('conversationId', 'Gifts are sent in direct conversations');
    const other = (await this.dm.members(conversationId)).find((m) => m.userId !== user.id);
    if (!other)
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Conversation not found' });
    return this.gifts.start(user, {
      recipient: other.userId,
      amount: input.amount,
      currency: input.currency,
      conversationId,
    });
  }
}
