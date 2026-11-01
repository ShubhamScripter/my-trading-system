/** Database operations for support ticket queues, message histories, and ticket status updates. */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import type { SupportStatus } from '../chat.contract';
import { ChatUtility } from '../chat.utility';

export interface TicketSummary {
  id: string;
  userId: string;
  username: string | null;
  subject: string;
  status: SupportStatus;
  lastMessageAt: string;
  createdAt: string;
  closedAt: string | null;
}

export interface TicketMessage {
  id: string;
  fromSupport: boolean;
  senderUsername: string | null;
  content: string;
  createdAt: string;
}

interface TicketSql {
  id: string;
  user_id: string;
  username: string | null;
  subject: string;
  status: SupportStatus;
  last_message_at: Date;
  last_message_at_text: string;
  created_at: Date;
  closed_at: Date | null;
}

const TIME_TEXT = Prisma.raw(
  `to_char(t.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
);

const TICKET_SELECT = Prisma.sql`
  SELECT t.id, t.user_id, u.username, t.subject, t.status, t.last_message_at,
         ${TIME_TEXT} AS last_message_at_text, t.created_at, t.closed_at
  FROM chat.support_tickets t
  LEFT JOIN identity.users u ON u.id = t.user_id
`;

const toSummary = (row: TicketSql): TicketSummary => ({
  id: row.id,
  userId: row.user_id,
  username: row.username,
  subject: row.subject,
  status: row.status,
  lastMessageAt: row.last_message_at.toISOString(),
  createdAt: row.created_at.toISOString(),
  closedAt: row.closed_at?.toISOString() ?? null,
});

export type ReplyResult = 'replied' | 'closed' | 'missing';

@Injectable()
export class ChatSupportDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /** The queue, most recently active first; a cursor is the `lastMessageAtText|id` of the last row seen. */
  async list(
    status: SupportStatus | null,
    limit: number,
    after: { at: string; id: string } | null,
  ): Promise<{ rows: TicketSummary[]; cursors: string[] }> {
    const byStatus = status ? Prisma.sql`AND t.status = ${status}` : Prisma.empty;
    const next = after
      ? Prisma.sql`AND (t.last_message_at, t.id) < (${after.at}::timestamptz, ${after.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<TicketSql[]>`
      ${TICKET_SELECT}
      WHERE true ${byStatus} ${next}
      ORDER BY t.last_message_at DESC, t.id DESC
      LIMIT ${limit + 1}`;
    return {
      rows: rows.map(toSummary),
      cursors: rows.map((row) => `${row.last_message_at_text}|${row.id}`),
    };
  }

  async ticket(ticketId: string): Promise<TicketSummary | null> {
    const rows = await this.prisma.$queryRaw<TicketSql[]>`
      ${TICKET_SELECT} WHERE t.id = ${ticketId}::uuid`;
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async messages(ticketId: string, limit = 50): Promise<TicketMessage[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        sender_admin_id: string | null;
        username: string | null;
        content: string;
        created_at: Date;
      }[]
    >`
      SELECT m.id, m.sender_admin_id, u.username, m.content, m.created_at
      FROM chat.support_messages m
      LEFT JOIN identity.users u ON u.id = m.sender_user_id
      WHERE m.ticket_id = ${ticketId}::uuid
      ORDER BY m.created_at, m.id
      LIMIT ${limit}`;
    return rows.map((row) => ({
      id: row.id,
      fromSupport: row.sender_admin_id !== null,
      senderUsername: row.username,
      content: row.content,
      createdAt: row.created_at.toISOString(),
    }));
  }

  /** An admin's answer; the first one moves a PENDING ticket to OPEN. A closed ticket takes none. */
  async reply(ticketId: string, adminId: string, content: string): Promise<ReplyResult> {
    return this.prisma.$transaction(async (tx) => {
      const touched = await tx.$queryRaw<{ status: SupportStatus }[]>`
        UPDATE chat.support_tickets
        SET status = 'OPEN', last_message_at = now(), updated_at = now()
        WHERE id = ${ticketId}::uuid AND status <> 'CLOSED'
        RETURNING status`;
      if (touched.length === 0) {
        const exists = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM chat.support_tickets WHERE id = ${ticketId}::uuid`;
        return exists.length === 0 ? 'missing' : 'closed';
      }
      await tx.$executeRaw`
        INSERT INTO chat.support_messages (id, ticket_id, sender_admin_id, content)
        VALUES (${ChatUtility.generateUuid()}::uuid, ${ticketId}::uuid, ${adminId}::uuid, ${content})`;
      return 'replied';
    });
  }

  /** The close button; false when the ticket is already closed or missing. */
  async close(ticketId: string, adminId: string): Promise<boolean> {
    const closed = await this.prisma.$executeRaw`
      UPDATE chat.support_tickets
      SET status = 'CLOSED', closed_by_admin = ${adminId}::uuid, closed_at = now(), updated_at = now()
      WHERE id = ${ticketId}::uuid AND status <> 'CLOSED'`;
    return closed > 0;
  }
}
