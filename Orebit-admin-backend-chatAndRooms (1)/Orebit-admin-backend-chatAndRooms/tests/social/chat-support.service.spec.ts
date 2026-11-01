import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../src/http';
import type { ChatModerationDbOperation } from '../../src/social/chat/chat-moderation.dboperation';
import type {
  ChatSupportDbOperation,
  ReplyResult,
  TicketSummary,
} from '../../src/social/chat/persistence/chat-support.dboperation';
import { ChatSupportService } from '../../src/social/chat/services/chat-support.service';

const TICKET_ID = '0190a3b4-0000-7000-8000-000000000001';
const ADMIN_ID = '0190a3b4-0000-7000-8000-0000000000aa';

const ticket = (overrides: Partial<TicketSummary> = {}): TicketSummary => ({
  id: TICKET_ID,
  userId: 'u1',
  username: 'ada',
  subject: 'Deposit missing',
  status: 'OPEN',
  lastMessageAt: '2026-10-18T10:00:00.000Z',
  createdAt: '2026-10-18T09:00:00.000Z',
  closedAt: null,
  ...overrides,
});

function harness(
  opts: { reply?: ReplyResult; closed?: boolean; found?: TicketSummary | null } = {},
) {
  const db = {
    list: vi.fn(async () => ({
      rows: [ticket()],
      cursors: ['2026-10-18T10:00:00.000000Z|' + TICKET_ID],
    })),
    ticket: vi.fn(async () => (opts.found === undefined ? ticket() : opts.found)),
    messages: vi.fn(async () => []),
    reply: vi.fn(async () => opts.reply ?? 'replied'),
    close: vi.fn(async () => opts.closed ?? true),
  };
  const moderation = {
    recordModerationAction: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
  };
  const service = new ChatSupportService(
    db as unknown as ChatSupportDbOperation,
    moderation as unknown as ChatModerationDbOperation,
  );
  return { service, db, moderation };
}

const failure = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (err) {
    if (err instanceof ProblemException) return err.type;
    throw err;
  }
  throw new Error('expected a refusal');
};

describe('admin ChatSupportService (Chat MAIN "Support Chat")', () => {
  it('an answer is recorded with the admin id and reaches the user', async () => {
    const { service, db, moderation } = harness();
    await service.reply({ ticketId: TICKET_ID, content: 'We are checking it' }, ADMIN_ID);
    expect(db.reply).toHaveBeenCalledWith(TICKET_ID, ADMIN_ID, 'We are checking it');
    expect(moderation.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: ADMIN_ID, action: 'SUPPORT_REPLY', targetUserId: 'u1' }),
    );
    expect(moderation.notify).toHaveBeenCalledWith({
      kind: 'support',
      userId: 'u1',
      ticketId: TICKET_ID,
      status: 'OPEN',
    });
  });

  it('a closed ticket takes no answer, and a missing one is not found', async () => {
    expect(
      await failure(
        harness({ reply: 'closed' }).service.reply({ ticketId: TICKET_ID, content: 'x' }, ADMIN_ID),
      ),
    ).toBe('forbidden');
    expect(
      await failure(
        harness({ reply: 'missing' }).service.reply(
          { ticketId: TICKET_ID, content: 'x' },
          ADMIN_ID,
        ),
      ),
    ).toBe('not_found');
  });

  it('the close button closes once and records it', async () => {
    const { service, moderation } = harness();
    await service.close({ ticketId: TICKET_ID }, ADMIN_ID);
    expect(moderation.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SUPPORT_CLOSE' }),
    );
    expect(
      await failure(harness({ closed: false }).service.close({ ticketId: TICKET_ID }, ADMIN_ID)),
    ).toBe('forbidden');
  });

  it('validates input: unknown fields, empty answers and bad statuses are refused', async () => {
    const { service } = harness();
    expect(await failure(service.reply({ ticketId: TICKET_ID, content: '' }, ADMIN_ID))).toBe(
      'validation_failed',
    );
    expect(
      await failure(service.reply({ ticketId: TICKET_ID, content: 'x', extra: 1 }, ADMIN_ID)),
    ).toBe('validation_failed');
    expect(await failure(service.tickets({ status: 'PAUSED' }))).toBe('validation_failed');
  });

  it('lists the queue by status', async () => {
    const { service, db } = harness();
    const page = await service.tickets({ status: 'PENDING' });
    expect(db.list).toHaveBeenCalledWith('PENDING', 50, null);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
