// The support chat (Module 10, Chat MAIN "Support Chat": "it will work exactly the same way as support tickets work,
// just in chat format"): a user opens a ticket with a first message (PENDING), support answers (OPEN), either side
// closes it with the close button (CLOSED), and a closed ticket takes no more messages.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { ChatDbOperation } from '../chat.dboperation';
import { CHAT_REFUSAL_REASONS, LIMITS, PAGE } from '../chat.constants';
import { SUPPORT_SUBJECT_MAX, type SupportStatus } from '../chat.contract';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatSettingsService } from '../chat.settings';
import type { ChatUserContext, Page } from '../chat.types';
import * as utility from '../chat.utility';
import {
  ChatSupportDbOperation,
  type TicketMessageRow,
  type TicketRow,
} from '../persistence/chat.support.dboperation';

export interface TicketView {
  readonly id: string;
  readonly subject: string;
  readonly status: SupportStatus;
  readonly createdAt: string;
  readonly lastMessageAt: string;
  readonly closedAt: string | null;
}

export interface TicketMessageView {
  readonly id: string;
  readonly fromSupport: boolean;
  readonly senderUsername: string | null;
  readonly content: string;
  readonly createdAt: string;
}

const toTicketView = (row: TicketRow): TicketView => ({
  id: row.id,
  subject: row.subject,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  lastMessageAt: row.lastMessageAt.toISOString(),
  closedAt: row.closedAt?.toISOString() ?? null,
});

const toMessageView = (row: TicketMessageRow): TicketMessageView => ({
  id: row.id,
  fromSupport: row.fromSupport,
  senderUsername: row.senderUsername,
  content: row.content,
  createdAt: row.createdAt.toISOString(),
});

@Injectable()
export class ChatSupportService {
  constructor(
    private readonly support: ChatSupportDbOperation,
    private readonly db: ChatDbOperation,
    private readonly settings: ChatSettingsService,
    private readonly moderation: ChatModerationService,
  ) {}

  private async requireTicket(user: ChatUserContext, ticketId: string): Promise<TicketRow> {
    const ticket = await this.support.ticketOf(ticketId, user.id);
    if (!ticket) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Ticket not found' });
    return ticket;
  }

  async open(
    user: ChatUserContext,
    input: { subject: string; content: string },
  ): Promise<TicketView> {
    const content = utility.normalizeContent(input.content);
    const subject = input.subject.trim();
    if (content === '' || subject === '') {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          { path: content === '' ? 'content' : 'subject', message: 'This field cannot be empty' },
        ],
      });
    }
    if (content.length > LIMITS.MESSAGE_CHARS) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'content', message: `1 to ${LIMITS.MESSAGE_CHARS} characters` }],
      });
    }
    if (subject.length > SUPPORT_SUBJECT_MAX) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'subject', message: `Subject cannot exceed ${SUPPORT_SUBJECT_MAX} characters` }],
      });
    }
    return toTicketView(await this.support.create(user.id, subject, content));
  }

  async list(
    user: ChatUserContext,
    query: { status?: SupportStatus; limit?: number; cursor?: string },
  ): Promise<Page<TicketView>> {
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.support.list(
      user.id,
      query.status ?? null,
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toTicketView),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.lastMessageAtText, id: last.id })
          : null,
    };
  }

  // One ticket with its conversation, oldest message first.
  async get(
    user: ChatUserContext,
    ticketId: string,
    query: { limit?: number; cursor?: string },
  ): Promise<{ ticket: TicketView } & Page<TicketMessageView>> {
    const ticket = await this.requireTicket(user, ticketId);
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.support.messages(
      ticket.id,
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      ticket: toTicketView(ticket),
      items: page.map(toMessageView),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
    };
  }

  async post(
    user: ChatUserContext,
    ticketId: string,
    input: { content: string },
  ): Promise<TicketMessageView> {
    await this.requireTicket(user, ticketId);
    const content = utility.normalizeContent(input.content);
    if (content === '' || content.length > LIMITS.MESSAGE_CHARS) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'content', message: `1 to ${LIMITS.MESSAGE_CHARS} characters` }],
      });
    }
    const result = await this.support.postUserMessage(ticketId, user.id, content);
    if (result.kind === 'closed') {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.TICKET_CLOSED, 'This ticket is closed');
    }
    return toMessageView(result.message);
  }

  // The close button.
  async close(user: ChatUserContext, ticketId: string): Promise<TicketView> {
    await this.requireTicket(user, ticketId);
    await this.support.closeByUser(ticketId, user.id);
    return toTicketView(await this.requireTicket(user, ticketId));
  }
}
