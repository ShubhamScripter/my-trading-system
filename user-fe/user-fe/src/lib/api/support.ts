/** ─── Support chat API client (Module 10) ─────────────────────────────────────
 *  Every route of support.routes.ts, with the exact request bodies the backend validates (unknown fields are refused).
 */
import { apiFetch } from './client';

interface Envelope<T> { data: T }

export type SupportStatus = 'PENDING' | 'OPEN' | 'CLOSED';

export interface SupportTicket {
  id: string;
  subject: string;
  status: SupportStatus;
  createdAt: string;
  lastMessageAt: string;
  closedAt: string | null;
}

export interface SupportMessage {
  id: string;
  fromSupport: boolean;
  senderUsername: string | null;
  content: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const qs = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return q.toString();
};

export async function listTickets(
  status: SupportStatus,
  cursor: string | null = null,
): Promise<Page<SupportTicket>> {
  const res = await apiFetch<Envelope<Page<SupportTicket>>>(
    `/social/chat/support/tickets?${qs({ status, limit: 30, cursor })}`,
  );
  return { items: res.data.items ?? [], nextCursor: res.data.nextCursor ?? null };
}

export async function openTicket(subject: string, content: string): Promise<SupportTicket> {
  const res = await apiFetch<Envelope<SupportTicket>>('/social/chat/support/tickets', {
    method: 'POST',
    body: { subject, content },
    fallbackMessage: 'Could not open the ticket',
  });
  return res.data;
}

export async function getTicket(
  ticketId: string,
  cursor: string | null = null,
): Promise<{ ticket: SupportTicket } & Page<SupportMessage>> {
  const res = await apiFetch<Envelope<{ ticket: SupportTicket } & Page<SupportMessage>>>(
    `/social/chat/support/tickets/${ticketId}?${qs({ limit: 100, cursor })}`,
  );
  return res.data;
}

export async function sendTicketMessage(ticketId: string, content: string): Promise<SupportMessage> {
  const res = await apiFetch<Envelope<SupportMessage>>(`/social/chat/support/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: { content },
    fallbackMessage: 'Could not send the message',
  });
  return res.data;
}

export async function closeTicket(ticketId: string): Promise<SupportTicket> {
  const res = await apiFetch<Envelope<SupportTicket>>(`/social/chat/support/tickets/${ticketId}/close`, {
    method: 'POST',
    fallbackMessage: 'Could not close the ticket',
  });
  return res.data;
}
