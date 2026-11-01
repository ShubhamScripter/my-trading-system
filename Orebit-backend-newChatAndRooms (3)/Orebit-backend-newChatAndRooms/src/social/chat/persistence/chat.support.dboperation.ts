/**
 * Database access for support tickets (Module 10, Chat MAIN "Support Chat"): a ticket is PENDING until support
 * answers, OPEN while it is worked and CLOSED by a button. Messages are never deleted; pages are exact keysets over
 * the database's microsecond text.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import type { SupportStatus } from '../chat.contract';
import type { Cursor } from '../chat.utility';
import { TIME_TEXT } from './chat.sql';

export interface TicketRow {
  readonly id: string;
  readonly userId: string;
  readonly subject: string;
  readonly status: SupportStatus;
  readonly closedAt: Date | null;
  readonly lastMessageAt: Date;
  readonly lastMessageAtText: string;
  readonly createdAt: Date;
}

export interface TicketMessageRow {
  readonly id: string;
  readonly ticketId: string;
  readonly fromSupport: boolean;
  readonly senderUsername: string | null;
  readonly content: string;
  readonly createdAt: Date;
  readonly createdAtText: string;
}

interface TicketSql {
  id: string;
  user_id: string;
  subject: string;
  status: SupportStatus;
  closed_at: Date | null;
  last_message_at: Date;
  last_message_at_text: string;
  created_at: Date;
}

interface TicketMessageSql {
  id: string;
  ticket_id: string;
  sender_admin_id: string | null;
  sender_username: string | null;
  content: string;
  created_at: Date;
  created_at_text: string;
}

const TICKET_SELECT = Prisma.sql`
  SELECT t.id, t.user_id, t.subject, t.status, t.closed_at, t.last_message_at,
         ${TIME_TEXT('t.last_message_at')} AS last_message_at_text, t.created_at
  FROM chat.support_tickets t
`;

const MESSAGE_SELECT = Prisma.sql`
  SELECT m.id, m.ticket_id, m.sender_admin_id, u.username AS sender_username, m.content, m.created_at,
         ${TIME_TEXT('m.created_at')} AS created_at_text
  FROM chat.support_messages m
  LEFT JOIN identity.users u ON u.id = m.sender_user_id
`;

const toTicket = (row: TicketSql): TicketRow => ({
  id: row.id,
  userId: row.user_id,
  subject: row.subject,
  status: row.status,
  closedAt: row.closed_at,
  lastMessageAt: row.last_message_at,
  lastMessageAtText: row.last_message_at_text,
  createdAt: row.created_at,
});

const toMessage = (row: TicketMessageSql): TicketMessageRow => ({
  id: row.id,
  ticketId: row.ticket_id,
  fromSupport: row.sender_admin_id !== null,
  senderUsername: row.sender_username,
  content: row.content,
  createdAt: row.created_at,
  createdAtText: row.created_at_text,
});

export type PostResult = { kind: 'posted'; message: TicketMessageRow } | { kind: 'closed' };

@Injectable()
export class ChatSupportDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /** A new PENDING ticket with its first message, in one transaction. */
  async create(userId: string, subject: string, content: string): Promise<TicketRow> {
    const ticketId = uuidv7();
    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        INSERT INTO chat.support_tickets (id, user_id, subject)
        VALUES (${ticketId}::uuid, ${userId}::uuid, ${subject})`,
      this.prisma.$executeRaw`
        INSERT INTO chat.support_messages (id, ticket_id, sender_user_id, content)
        VALUES (${uuidv7()}::uuid, ${ticketId}::uuid, ${userId}::uuid, ${content})`,
    ]);
    return (await this.ticketOf(ticketId, userId))!;
  }

  async ticketOf(ticketId: string, userId: string): Promise<TicketRow | null> {
    const rows = await this.prisma.$queryRaw<TicketSql[]>`
      ${TICKET_SELECT} WHERE t.id = ${ticketId}::uuid AND t.user_id = ${userId}::uuid`;
    return rows[0] ? toTicket(rows[0]) : null;
  }

  /** Count active (non-closed) tickets of the user to enforce ticket limit (FR-132). */
  async countActive(userId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM chat.support_tickets
      WHERE user_id = ${userId}::uuid AND status <> 'CLOSED'`;
    return Number(rows[0]?.count ?? 0n);
  }

  /** The user's tickets, most recently active first; `status` narrows to one tab. */
  async list(
    userId: string,
    status: SupportStatus | null,
    limit: number,
    cursor: Cursor | null,
  ): Promise<TicketRow[]> {
    const byStatus = status ? Prisma.sql`AND t.status = ${status}` : Prisma.empty;
    const after = cursor
      ? Prisma.sql`AND (t.last_message_at, t.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<TicketSql[]>`
      ${TICKET_SELECT}
      WHERE t.user_id = ${userId}::uuid ${byStatus} ${after}
      ORDER BY t.last_message_at DESC, t.id DESC
      LIMIT ${limit + 1}`;
    return rows.map(toTicket);
  }

  /** Messages of a ticket, oldest first; `after` pages forward. */
  async messages(
    ticketId: string,
    limit: number,
    after: Cursor | null,
  ): Promise<TicketMessageRow[]> {
    const next = after
      ? Prisma.sql`AND (m.created_at, m.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<TicketMessageSql[]>`
      ${MESSAGE_SELECT}
      WHERE m.ticket_id = ${ticketId}::uuid ${next}
      ORDER BY m.created_at, m.id
      LIMIT ${limit + 1}`;
    return rows.map(toMessage);
  }

  /** The user's message on an unclosed ticket; a closed ticket takes none. */
  async postUserMessage(ticketId: string, userId: string, content: string): Promise<PostResult> {
    const messageId = uuidv7();
    const touched = await this.prisma.$executeRaw`
      UPDATE chat.support_tickets SET last_message_at = now(), updated_at = now()
      WHERE id = ${ticketId}::uuid AND user_id = ${userId}::uuid AND status <> 'CLOSED'`;
    if (touched === 0) return { kind: 'closed' };
    await this.prisma.$executeRaw`
      INSERT INTO chat.support_messages (id, ticket_id, sender_user_id, content)
      VALUES (${messageId}::uuid, ${ticketId}::uuid, ${userId}::uuid, ${content})`;
    const rows = await this.prisma.$queryRaw<TicketMessageSql[]>`
      ${MESSAGE_SELECT} WHERE m.id = ${messageId}::uuid`;
    return { kind: 'posted', message: toMessage(rows[0]!) };
  }

  /** Closes the user's own ticket; false when it is already closed. */
  async closeByUser(ticketId: string, userId: string): Promise<boolean> {
    const closed = await this.prisma.$executeRaw`
      UPDATE chat.support_tickets
      SET status = 'CLOSED', closed_by_user = ${userId}::uuid, closed_at = now(), updated_at = now()
      WHERE id = ${ticketId}::uuid AND user_id = ${userId}::uuid AND status <> 'CLOSED'`;
    return closed > 0;
  }
}
