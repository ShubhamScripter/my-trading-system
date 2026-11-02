import { describe, expect, it, vi } from 'vitest';
import { DmDeliveryService } from '../../src/social/chat/dm/dm.delivery.service';

describe('DM group delivery batching', () => {
  it.each([10, 5_000])('batches member and preference work for %i members and loads zones only for quiet recipients', async (count) => {
    const quietCount = count === 10 ? 2 : 100;
    const members = Array.from({ length: count }, (_, index) => ({
      conversationId: 'conversation',
      kind: 'GROUP' as const,
      userId: `user-${index}`,
      username: `user${index}`,
      role: 'MEMBER' as const,
      state: 'ACTIVE' as const,
      folder: 'GROUPS' as const,
      folderChosen: true,
      pinnedAt: null,
      nickname: null,
      notifications: 'DEFAULT' as const,
      lastReadMessageId: null,
      lastReadAt: null,
      timeoutUntil: null,
      joinedAt: new Date('2026-01-01T00:00:00Z'),
    }));
    const prefs = new Map(members.map((member, index) => [member.userId, {
      notifyPrimary: true,
      notifyGeneral: true,
      notifyGroups: true,
      quietMode: index > 0 && index <= quietCount ? 'CUSTOM' : 'OFF',
      quietStart: '22:00',
      quietEnd: '07:00',
      timeZone: null,
    }]));
    const dm = { members: vi.fn(async () => members), dbNow: vi.fn(async () => new Date('2026-11-02T10:00:00Z')) };
    const inbox = { prefs: vi.fn(async (_ids: readonly string[]) => prefs) };
    const settings = { global: vi.fn(async () => ({
      privacy: {
        notifyPrimary: true,
        notifyGeneral: true,
        notifyGroups: true,
        quietModeDefault: 'OFF',
        allowQuietChange: true,
        quietStart: '22:00',
        quietEnd: '07:00',
      },
    })) };
    const chatPorts = { accountTimeZones: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, 'Asia/Kolkata']))) };
    const delivery = { toUser: vi.fn() };
    const service = new DmDeliveryService(dm as never, inbox as never, settings as never, chatPorts as never, delivery as never);

    await service.deliver({
      id: 'message', conversationId: 'conversation', senderId: 'user-0', senderUsername: 'user0',
      content: 'hello', type: 'TEXT', metadata: {}, clientMessageId: null,
      createdAt: new Date('2026-11-02T10:00:00Z'), createdAtText: '2026-11-02T10:00:00.000000Z',
      retractedAt: null, hiddenAt: null, pinnedAt: null,
    } as never);

    expect(dm.members).toHaveBeenCalledOnce();
    expect(inbox.prefs).toHaveBeenCalledOnce();
    expect(inbox.prefs.mock.calls[0]?.[0]).toHaveLength(count);
    expect(chatPorts.accountTimeZones).toHaveBeenCalledOnce();
    expect(chatPorts.accountTimeZones.mock.calls[0]?.[0]).toHaveLength(quietCount);
  });
});
