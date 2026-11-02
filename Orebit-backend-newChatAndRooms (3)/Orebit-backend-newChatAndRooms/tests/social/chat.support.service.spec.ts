import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../src/http';
import {
  DEFAULT_CHAT_SETTINGS,
  type ChatSettings,
} from '../../src/social/chat/chat.settings.contract';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import type {
  ChatSupportDbOperation,
  TicketMessageRow,
  TicketRow,
} from '../../src/social/chat/persistence/chat.support.dboperation';
import { ChatSupportService } from '../../src/social/chat/support/support.service';

const USER = { id: 'u1', username: 'ada' } as unknown as ChatUserContext;

const ticket = (overrides: Partial<TicketRow> = {}): TicketRow => ({
  id: 't1',
  userId: 'u1',
  subject: 'Deposit missing',
  status: 'PENDING',
  closedAt: null,
  lastMessageAt: new Date('2026-10-18T10:00:00Z'),
  lastMessageAtText: '2026-10-18T10:00:00.000000Z',
  createdAt: new Date('2026-10-18T10:00:00Z'),
  ...overrides,
});

const message = (overrides: Partial<TicketMessageRow> = {}): TicketMessageRow => ({
  id: 'm1',
  ticketId: 't1',
  fromSupport: false,
  senderUsername: 'ada',
  content: 'hello',
  createdAt: new Date('2026-10-18T10:00:00Z'),
  createdAtText: '2026-10-18T10:00:00.000000Z',
  ...overrides,
});

function harness(
  opts: {
    ticket?: TicketRow | null;
    posted?: 'posted' | 'closed';
    banned?: boolean;
    chat?: 'ACTIVE' | 'MAINTENANCE' | 'DISABLED';
    rows?: TicketRow[];
  } = {},
) {
  const support = {
    create: vi.fn(async (_u: string, subject: string) => ticket({ subject })),
    ticketOf: vi.fn(async () => (opts.ticket === undefined ? ticket() : opts.ticket)),
    list: vi.fn(async () => opts.rows ?? [ticket()]),
    messages: vi.fn(async () => [message()]),
    postUserMessage: vi.fn(async (_t: string, _u: string, content: string) =>
      opts.posted === 'closed'
        ? ({ kind: 'closed' } as const)
        : ({ kind: 'posted', message: message({ content }) } as const),
    ),
    closeByUser: vi.fn(async () => true),
  };
  const settings: ChatSettings = {
    ...(DEFAULT_CHAT_SETTINGS as unknown as ChatSettings),
    maintenance: { ...DEFAULT_CHAT_SETTINGS.maintenance, chat: opts.chat ?? 'ACTIVE', note: null },
  } as ChatSettings;
  const moderation = {
    assertNotBanned: vi.fn(async () => {
      if (opts.banned) throw new ProblemException({ type: 'forbidden', detail: 'banned' });
    }),
  };
  const service = new ChatSupportService(
    support as unknown as ChatSupportDbOperation,
    { dbNow: vi.fn(async () => new Date('2026-10-18T10:00:00Z')) } as never,
    { global: vi.fn(async () => settings) } as never,
    moderation as never,
  );
  return { service, support, moderation };
}

const reasonOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (err) {
    return err instanceof ProblemException ? (err.extra?.reason ?? err.type) : err;
  }
  throw new Error('expected a refusal');
};

describe('ChatSupportService (Chat MAIN "Support Chat")', () => {
  it('opens a PENDING ticket with its first message', async () => {
    const { service, support } = harness();
    const view = await service.open(USER, { subject: '  Deposit missing ', content: 'hello' });
    expect(support.create).toHaveBeenCalledWith('u1', 'Deposit missing', 'hello');
    expect(view.status).toBe('PENDING');
  });

  it('allows a banned user or during chat maintenance to open a support ticket to appeal (V2-52 / FR-025)', async () => {
    const { service, support } = harness({ banned: true, chat: 'MAINTENANCE' });
    const view = await service.open(USER, { subject: 'Appeal Ban', content: 'Please review' });
    expect(view.status).toBe('PENDING');
    expect(support.create).toHaveBeenCalledWith('u1', 'Appeal Ban', 'Please review');
  });

  it('does not impose an invented chat-side ticket count cap', async () => {
    const { service, support } = harness();
    const opened = await service.open(USER, { subject: 'Another ticket', content: 'help' });
    expect(opened.status).toBe('PENDING');
    expect(support.create).toHaveBeenCalled();
  });

  it('a closed ticket takes no more messages', async () => {
    const { service } = harness({ ticket: ticket({ status: 'CLOSED' }), posted: 'closed' });
    expect(await reasonOf(service.post(USER, 't1', { content: 'still there?' }))).toBe(
      'ticket_closed',
    );
  });

  it("another user's ticket does not exist for this user", async () => {
    const { service, support } = harness({ ticket: null });
    expect(await reasonOf(service.post(USER, 't1', { content: 'hi' }))).toBe('not_found');
    expect(await reasonOf(service.get(USER, 't1', {}))).toBe('not_found');
    expect(support.postUserMessage).not.toHaveBeenCalled();
  });

  it('posts a message to an open ticket', async () => {
    const { service, support } = harness({ ticket: ticket({ status: 'OPEN' }) });
    const view = await service.post(USER, 't1', { content: 'more details' });
    expect(support.postUserMessage).toHaveBeenCalledWith('t1', 'u1', 'more details');
    expect(view).toMatchObject({ content: 'more details', fromSupport: false });
  });

  it('the close button closes the ticket', async () => {
    const { service, support } = harness();
    support.ticketOf
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(
        ticket({ status: 'CLOSED', closedAt: new Date('2026-10-18T11:00:00Z') }),
      );
    const view = await service.close(USER, 't1');
    expect(support.closeByUser).toHaveBeenCalledWith('t1', 'u1');
    expect(view.status).toBe('CLOSED');
  });

  it('pages tickets by status with an exact cursor', async () => {
    const rows = [ticket({ id: 'a' }), ticket({ id: 'b' }), ticket({ id: 'c' })];
    const { service, support } = harness({ rows });
    const page = await service.list(USER, { status: 'OPEN', limit: 2 });
    expect(support.list).toHaveBeenCalledWith('u1', 'OPEN', 2, null);
    expect(page.items.map((t) => t.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).not.toBeNull();
  });
});
