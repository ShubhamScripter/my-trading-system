import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../src/http';
import { RoomAccessSchema, RoomConfigSchema } from '../../src/social/chat/chat.contract';
import {
  DEFAULT_CHAT_SETTINGS,
  type ChatSettings,
} from '../../src/social/chat/chat.settings.contract';
import { ChatBus } from '../../src/social/chat/realtime/chat.bus';
import { ChatReadService } from '../../src/social/chat/services/chat.read.service';
import { ChatService } from '../../src/social/chat/chat.service';
import { ChatReportService } from '../../src/social/chat/services/chat.staff.service';
import type {
  ChatUserContext,
  MessageRow,
  RoomAccessEvaluation,
  RoomRecord,
} from '../../src/social/chat/chat.types';

const SETTINGS = DEFAULT_CHAT_SETTINGS as unknown as ChatSettings;
const USER: ChatUserContext = { id: 'u1', username: 'ada', publicCode: 'P', staffRole: null };
const FULL: RoomAccessEvaluation = {
  accessMode: 'FULL_ACCESS',
  isListed: true,
  isEligibleToView: true,
  isEligibleToWrite: true,
  receivesUserMessages: true,
};
const READ_ONLY: RoomAccessEvaluation = {
  accessMode: 'VIEW_ONLY',
  isListed: true,
  isEligibleToView: true,
  isEligibleToWrite: false,
  receivesUserMessages: true,
  reason: 'A premium plan is required to write here',
  requirement: { kind: 'PREMIUM', planIds: [] },
};

const ROOM: RoomRecord = {
  id: 'r1',
  slug: 'global',
  name: 'Global',
  description: null,
  type: 'GLOBAL',
  createdAt: new Date(0),
  config: RoomConfigSchema.parse({}),
  access: RoomAccessSchema.parse({}),
  regionCountries: null,
  fingerprint: '',
};

const row = (overrides: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1',
  roomId: 'r1',
  userId: 'u1',
  content: 'hi',
  type: 'TEXT',
  metadata: {},
  createdAt: new Date('2026-09-28T12:00:00Z'),
  createdAtText: '2026-09-28T12:00:00.000000Z',
  retractedAt: null,
  pinnedAt: null,
  authorUsername: 'ada',
  skin: null,
  ...overrides,
});

function harness(
  opts: {
    access?: RoomAccessEvaluation;
    room?: RoomRecord | null;
    message?: MessageRow | null;
    clientHit?: string | null;
  } = {},
) {
  const db = {
    findClientMessage: vi.fn(async () => (opts.clientHit ? { messageId: opts.clientHit } : null)),
    messageById: vi.fn(async () => (opts.message === undefined ? row() : opts.message)),
    readRoom: vi.fn(async () =>
      opts.room === null
        ? null
        : { room: opts.room ?? ROOM, dbNow: new Date('2026-09-28T12:00:00Z') },
    ),
    insertMessage: vi.fn(async (data: { content: string; type: string; metadata: unknown }) => ({
      row: row({
        content: data.content,
        type: data.type as MessageRow['type'],
        metadata: data.metadata as MessageRow['metadata'],
      }),
      duplicateOf: null,
    })),
    usersByUsernames: vi.fn(async (names: string[]) =>
      names.map((n) => ({ id: `id-${n}`, username: n })),
    ),
    findChatUser: vi.fn(async (id: string) => ({
      id,
      username: id,
      publicCode: 'P',
      staffRole: null,
    })),
    preferences: vi.fn(async () => ({ hideIdentity: false, activeSkinId: null, lastSeenAt: null })),
    dbNow: vi.fn(async () => new Date('2026-09-28T12:10:00Z')),
    retract: vi.fn(async () => ({
      roomId: 'r1',
      retractedAt: new Date('2026-09-28T12:10:00Z'),
      createdAt: new Date(),
    })),
    recordAction: vi.fn(async () => undefined),
    recordActionNow: vi.fn(async () => undefined),
    isActiveReason: vi.fn(async (code: string) => code === 'SPAM'),
    recentReportCount: vi.fn(async () => 0),
    insertReport: vi.fn(async () => ({ id: 'rep1', createdAt: new Date() })),
    resolveUserId: vi.fn(async (h: string) => (h === 'bob' ? 'u2' : null)),
    tagFeed: vi.fn(),
  };
  const access = {
    requireRoom: vi.fn(async () => ROOM),
    findRoom: vi.fn(async (id: string) => (id === 'hidden' ? { ...ROOM, id: 'hidden' } : ROOM)),
    factsFor: vi.fn(async () => ({ premiumPlanIds: [] })),
    settingsFor: vi.fn(async () => SETTINGS),
    evaluate: vi.fn(async (_u: unknown, room: RoomRecord) =>
      room.id === 'hidden'
        ? { ...FULL, isEligibleToView: false, isListed: false }
        : (opts.access ?? FULL),
    ),
    onConfigProblem: vi.fn(),
  };
  const moderation = {
    assertNotBanned: vi.fn(async () => undefined),
    checkSendLimits: vi.fn(async () => undefined),
    moderate: vi.fn(async () => undefined),
    recordMediaSent: vi.fn(),
    noteHit: vi.fn(),
  };
  const account = { assertSkinUsable: vi.fn(), usableSkin: vi.fn(async () => null) };
  const service = new ChatService(
    db as never,
    db as never,
    access as never,
    account as never,
    moderation as never,
    moderation as never,
    { count: vi.fn(() => 0) } as never,
    new ChatBus(),
    // The permission gate (Module 4): moderators act on DELETE_MESSAGES by default.
    { mode: vi.fn(async () => 'ACT'), report: vi.fn() } as never,
  );
  const relations = { hiddenAuthors: vi.fn(async () => new Set<string>()) };
  const read = new ChatReadService(db as never, db as never, access as never, relations as never, db as never);
  const reports = new ChatReportService(
    db as never,
    db as never,
    access as never,
    moderation as never,
  );
  return { service, read, reports, db, access, moderation };
}

async function problem(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    if (err instanceof ProblemException)
      return {
        type: err.type,
        status: err.status,
        reason: err.extra?.reason,
        paths: err.errors?.map((e) => e.path),
      };
    throw err;
  }
  return null;
}

describe('sendMessage (one path for both transports)', () => {
  it('a retried clientMessageId returns the first message and does no work', async () => {
    const { service, db, moderation } = harness({ clientHit: 'm1' });
    const result = await service.sendMessage(
      USER,
      { roomRef: 'global', content: 'hi', clientMessageId: 'c1' },
      { ip: '1.1.1.1' },
    );
    expect(result.duplicate).toBe(true);
    expect(db.readRoom).not.toHaveBeenCalled();
    expect(moderation.checkSendLimits).not.toHaveBeenCalled();
    expect(db.insertMessage).not.toHaveBeenCalled();
  });

  it('an unknown room is not_found and creates nothing', async () => {
    const { service, db } = harness({ room: null });
    expect(
      await problem(() =>
        service.sendMessage(USER, { roomRef: 'no-such-room', content: 'hi' }, { ip: 'x' }),
      ),
    ).toMatchObject({ type: 'not_found' });
    expect(db.insertMessage).not.toHaveBeenCalled();
  });

  it('a read-only room refuses with room_read_only and the requirement', async () => {
    const { service } = harness({ access: READ_ONLY });
    expect(
      await problem(() => service.sendMessage(USER, { roomRef: 'r1', content: 'hi' }, { ip: 'x' })),
    ).toMatchObject({
      type: 'forbidden',
      reason: 'room_read_only',
    });
  });

  it('stores TEXT as typed and never a client-chosen type', async () => {
    const { service, db } = harness();
    await service.sendMessage(
      USER,
      { roomRef: 'r1', content: "  don't <3  " },
      { ip: 'x', hideIdentity: false, activeSkinId: null },
    );
    expect(db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "don't <3", type: 'TEXT' }),
    );
  });

  it('stamps the profile hide-identity setting on the message', async () => {
    const { service, db } = harness();
    await service.sendMessage(
      USER,
      { roomRef: 'r1', content: 'hi' },
      { ip: 'x', hideIdentity: true, activeSkinId: null },
    );
    expect(db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ anonymous: true }) }),
    );
  });

  it('builds media on the server and refuses an address that is not allowed', async () => {
    const { service, db } = harness();
    for (const url of [
      'javascript:alert(1)',
      'http://media.tenor.com/x.gif',
      'https://media.giphy.com/x.gif',
    ]) {
      expect(
        await problem(() =>
          service.sendMessage(USER, { roomRef: 'r1', media: { url, type: 'gif' } }, { ip: 'x' }),
        ),
      ).toMatchObject({
        paths: ['mediaUrl'],
      });
    }
    await service.sendMessage(
      USER,
      { roomRef: 'r1', media: { url: 'https://media.tenor.com/x.gif', type: 'gif' } },
      { ip: 'x' },
    );
    expect(db.insertMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'MEDIA',
        metadata: { media: { type: 'gif', url: 'https://media.tenor.com/x.gif' } },
      }),
    );
  });

  it('tags at most 10 users with one user query', async () => {
    const { service, db } = harness();
    const text = Array.from({ length: 11 }, (_, i) => `@user${String(i).padStart(2, '0')}`).join(
      ' ',
    );
    const result = await service.sendMessage(USER, { roomRef: 'r1', content: text }, { ip: 'x' });
    expect(db.usersByUsernames).toHaveBeenCalledTimes(1);
    expect(result.taggedUserIds).toHaveLength(10);
  });
});

describe('retract', () => {
  it('a second retract is 409 already_retracted', async () => {
    const { service } = harness({ message: row({ retractedAt: new Date() }) });
    expect(await problem(() => service.retract(USER, 'm1', null))).toMatchObject({
      status: 409,
      reason: 'already_retracted',
    });
  });

  it('only the author or chat staff may retract', async () => {
    const { service } = harness({ message: row({ userId: 'someone-else' }) });
    expect(await problem(() => service.retract(USER, 'm1', null))).toMatchObject({
      reason: 'staff_only',
    });
  });

  it('an author past the retract window is refused; a moderator is not', async () => {
    const settings = { ...SETTINGS, limits: { ...SETTINGS.limits, retractWindowSeconds: 60 } };
    const { service, access } = harness({
      message: row({ createdAt: new Date('2026-09-28T12:00:00Z') }),
    });
    access.settingsFor.mockResolvedValue(settings);
    expect(await problem(() => service.retract(USER, 'm1', null))).toMatchObject({
      reason: 'retract_window_passed',
    });
    expect(
      await service.retract({ ...USER, id: 'mod', staffRole: 'MODERATOR' }, 'm1', 'rule 2'),
    ).toMatchObject({ messageId: 'm1', roomId: 'r1' });
  });

  it('the result carries no actor', async () => {
    const { service } = harness();
    expect(Object.keys(await service.retract(USER, 'm1', null)).sort()).toEqual([
      'messageId',
      'retractedAt',
      'roomId',
    ]);
  });
});

describe('reports', () => {
  it('own message is refused', async () => {
    const { reports: service } = harness();
    expect(
      await problem(() => service.reportMessage(USER, 'm1', { reason: 'SPAM' })),
    ).toMatchObject({ reason: 'cannot_report_own_message' });
  });

  it('a message in a room the reporter cannot view is 404', async () => {
    const { reports: service } = harness({ message: row({ userId: 'u2', roomId: 'hidden' }) });
    expect(
      await problem(() => service.reportMessage(USER, 'm1', { reason: 'SPAM' })),
    ).toMatchObject({ type: 'not_found' });
  });

  it('a duplicate is 409 already_reported; an unknown reason is 400', async () => {
    const { reports: service, db } = harness({ message: row({ userId: 'u2' }) });
    expect(await problem(() => service.reportMessage(USER, 'm1', { reason: 'FOO' }))).toMatchObject(
      { type: 'validation_failed' },
    );
    db.insertReport.mockResolvedValueOnce(null as never);
    expect(
      await problem(() => service.reportMessage(USER, 'm1', { reason: 'SPAM' })),
    ).toMatchObject({ status: 409, reason: 'already_reported' });
  });

  it('users can be reported (Chat MAIN)', async () => {
    const { reports: service, db } = harness();
    expect(await service.reportUser(USER, 'bob', { reason: 'SPAM' })).toMatchObject({
      userId: 'u2',
    });
    expect(db.insertReport).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: null, reportedUserId: 'u2' }),
    );
  });

  it('reports a system-authored ad message without inventing a reported user', async () => {
    const { reports: service, db } = harness({
      message: row({ userId: '00000000-0000-0000-0000-000000000000', type: 'AD' }),
    });
    await service.reportMessage(USER, 'm1', { reason: 'SPAM' });
    expect(db.insertReport).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1', reportedUserId: null }),
    );
  });

  it('over the hourly limit is 429', async () => {
    const { reports: service, db } = harness({ message: row({ userId: 'u2' }) });
    db.recentReportCount.mockResolvedValueOnce(10);
    expect(
      await problem(() => service.reportMessage(USER, 'm1', { reason: 'SPAM' })),
    ).toMatchObject({ type: 'rate_limited' });
  });
});

describe('tag feed', () => {
  it('filters rooms the reader cannot view and still gives a gap-free cursor', async () => {
    const { read, db } = harness();
    db.tagFeed.mockResolvedValueOnce({
      rows: [
        row({ id: '0192f6a0-0000-7000-8000-00000000000a', roomId: 'r1' }),
        row({ id: '0192f6a0-0000-7000-8000-00000000000b', roomId: 'hidden' }),
      ],
      scanned: [
        {
          createdAtText: '2026-09-28T12:00:02.000000Z',
          messageId: '0192f6a0-0000-7000-8000-00000000000a',
        },
        {
          createdAtText: '2026-09-28T12:00:01.000000Z',
          messageId: '0192f6a0-0000-7000-8000-00000000000b',
        },
        {
          createdAtText: '2026-09-28T12:00:00.000000Z',
          messageId: '0192f6a0-0000-7000-8000-00000000000c',
        },
      ],
    });
    const page = await read.tags(USER, { limit: 2 });
    expect(page.items.map((i) => i.room.id)).toEqual(['r1']);
    expect(page.items[0]).not.toHaveProperty('room.config');
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });
});
