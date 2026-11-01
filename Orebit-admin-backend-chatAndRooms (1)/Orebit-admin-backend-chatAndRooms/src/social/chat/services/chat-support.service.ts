/** Admin service for support chat tickets: manages queues, ticket histories, and staff replies. */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ERR } from '../../../contracts';
import { ProblemException, parseDto } from '../../../http';
import { ChatModerationDbOperation } from '../chat-moderation.dboperation';
import { SUPPORT_STATUSES } from '../chat.contract';
import {
  ChatSupportDbOperation,
  type TicketMessage,
  type TicketSummary,
} from '../persistence/chat-support.dboperation';

const UUID = z.string().uuid();
const CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{36}$/i;

export const TicketsQuerySchema = z
  .object({
    status: z.enum(SUPPORT_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().regex(CURSOR, 'Not a cursor this API returned').optional(),
  })
  .strict();

export const TicketQuerySchema = z.object({ ticketId: UUID }).strict();

export const TicketReplySchema = z
  .object({ ticketId: UUID, content: z.string().trim().min(1).max(4000) })
  .strict();

export const TicketCloseSchema = z
  .object({ ticketId: UUID, note: z.string().trim().max(500).optional() })
  .strict();

@Injectable()
export class ChatSupportService {
  constructor(
    private readonly db: ChatSupportDbOperation,
    private readonly moderation: ChatModerationDbOperation,
  ) {}

  async tickets(query: unknown): Promise<{ items: TicketSummary[]; nextCursor: string | null }> {
    const q = parseDto(TicketsQuerySchema, query);
    const [at, id] = q.cursor ? q.cursor.split('|') : [];
    const { rows, cursors } = await this.db.list(
      q.status ?? null,
      q.limit,
      at && id ? { at, id } : null,
    );
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: rows.length > q.limit ? (cursors[q.limit - 1] ?? null) : null,
    };
  }

  async ticket(query: unknown): Promise<{ ticket: TicketSummary; messages: TicketMessage[] }> {
    const { ticketId } = parseDto(TicketQuerySchema, query);
    const ticket = await this.require(ticketId);
    return { ticket, messages: await this.db.messages(ticketId) };
  }

  async reply(body: unknown, adminId: string): Promise<{ ticket: TicketSummary }> {
    const dto = parseDto(TicketReplySchema, body);
    const result = await this.db.reply(dto.ticketId, adminId, dto.content);
    if (result === 'missing') this.missing();
    if (result === 'closed') {
      throw new ProblemException({ type: ERR.FORBIDDEN, detail: 'This ticket is closed' });
    }
    return { ticket: await this.recordChange(dto.ticketId, adminId, 'SUPPORT_REPLY', null) };
  }

  async close(body: unknown, adminId: string): Promise<{ ticket: TicketSummary }> {
    const dto = parseDto(TicketCloseSchema, body);
    await this.require(dto.ticketId);
    if (!(await this.db.close(dto.ticketId, adminId))) {
      throw new ProblemException({ type: ERR.FORBIDDEN, detail: 'This ticket is already closed' });
    }
    return {
      ticket: await this.recordChange(dto.ticketId, adminId, 'SUPPORT_CLOSE', dto.note ?? null),
    };
  }

  private async recordChange(
    ticketId: string,
    adminId: string,
    action: 'SUPPORT_REPLY' | 'SUPPORT_CLOSE',
    note: string | null,
  ): Promise<TicketSummary> {
    const ticket = await this.require(ticketId);
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action,
      targetUserId: ticket.userId,
      newValue: { ticketId, status: ticket.status },
      note,
    });
    await this.moderation.notify({
      kind: 'support',
      userId: ticket.userId,
      ticketId,
      status: ticket.status,
    });
    return ticket;
  }

  private async require(ticketId: string): Promise<TicketSummary> {
    const ticket = await this.db.ticket(ticketId);
    if (!ticket) this.missing();
    return ticket!;
  }

  private missing(): never {
    throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Ticket not found' });
  }
}
