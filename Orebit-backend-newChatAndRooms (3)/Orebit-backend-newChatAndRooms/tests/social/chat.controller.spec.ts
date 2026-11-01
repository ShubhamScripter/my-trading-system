import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ChatController } from '../../src/social/chat/chat.controller';
import { ChatRoutes } from '../../src/social/chat/chat.routes';

/**
 * ChatController: one method per route. Each resolves the signed-in chat user first, then hands the validated
 * input to a service; the controller itself holds no rules. ChatRoutes holds the paths and which route is public.
 */
const USER = { id: 'u-1', username: 'alice', staffRole: 'MODERATOR' };
const req = { headers: {}, ip: '10.0.0.1' } as unknown as FastifyRequest;

function make() {
  const auth = { getChatUser: vi.fn(async () => USER) };
  const chat = {
    listRooms: vi.fn(async () => ({ items: [], nextCursor: null })),
    sendMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
    retract: vi.fn(async () => ({
      messageId: 'm1',
      roomId: 'r1',
      retractedAt: '2026-10-02T00:00:00Z',
    })),
  };
  const read = { history: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })) };
  const account = { skins: vi.fn(async () => [{ id: 's1' }]) };
  const access = {
    requireRoom: vi.fn(async (ref: string) => ({ id: `room-of-${ref}` })),
    settingsFor: vi.fn(async () => ({ limits: { maxBanHours: 24 } })),
  };
  const reports = { reportReasons: vi.fn(async () => [{ code: 'SPAM' }]) };
  const staff = {
    staffBan: vi.fn(async (..._args: unknown[]) => ({ id: 'ban-1' })),
    staffWarn: vi.fn(),
  };
  const delivery = { publish: vi.fn(), notifyTagged: vi.fn(), publishRetracted: vi.fn() };
  const controller = new ChatController(
    chat as never,
    read as never,
    account as never,
    access as never,
    reports as never,
    staff as never,
    { warn: vi.fn(), ban: vi.fn() } as never,
    auth as never,
    delivery as never,
    { list: vi.fn() } as never,
  );
  return { controller, auth, chat, read, account, access, reports, staff, delivery };
}

describe('reading', () => {
  it('lists rooms for the signed-in user with the page the client asked for', async () => {
    const { controller, chat } = make();
    await controller.rooms(req, { limit: 20 } as never);
    expect(chat.listRooms).toHaveBeenCalledWith(USER, 20, null);
  });

  it('reads history through the read service and wraps it in the success envelope', async () => {
    const { controller, read } = make();
    const res = await controller.messages(req, 'global', { limit: 10 } as never);
    expect(read.history).toHaveBeenCalledWith(USER, 'global', { limit: 10 });
    expect(res).toMatchObject({ data: { items: [], hasMore: false } });
  });

  it('wraps skins as { items }', async () => {
    expect(await make().controller.skins(req)).toMatchObject({ data: { items: [{ id: 's1' }] } });
  });

  it('only lets a signed-in user read the report reasons', async () => {
    const { controller, auth, reports } = make();
    auth.getChatUser.mockRejectedValueOnce(new Error('unauthenticated'));
    await expect(controller.reportReasons(req, {})).rejects.toThrow('unauthenticated');
    expect(reports.reportReasons).not.toHaveBeenCalled();
  });
});

describe('sending media over HTTP', () => {
  const dto = { roomId: 'global', mediaUrl: 'https://x/y.png', mediaType: 'image' as const };

  it('broadcasts a new message and tells the tagged users', async () => {
    const { controller, chat, delivery } = make();
    const row = { id: 'm1', createdAt: new Date('2026-10-02T10:00:00Z') };
    chat.sendMessage.mockResolvedValueOnce({ row, taggedUserIds: ['u-2'], duplicate: false });

    const res = await controller.sendMedia(req, dto as never);

    expect(delivery.publish).toHaveBeenCalledWith(row);
    expect(delivery.notifyTagged).toHaveBeenCalledWith(row, ['u-2']);
    expect(res).toMatchObject({ data: { messageId: 'm1', createdAt: '2026-10-02T10:00:00.000Z' } });
  });

  it('acknowledges a retried send without broadcasting it again', async () => {
    const { controller, chat, delivery } = make();
    const row = { id: 'm1', createdAt: new Date() };
    chat.sendMessage.mockResolvedValueOnce({ row, taggedUserIds: [], duplicate: true });

    await controller.sendMedia(req, dto as never);

    expect(delivery.publish).not.toHaveBeenCalled();
    expect(delivery.notifyTagged).not.toHaveBeenCalled();
  });

  it('leaves optional fields out of the service input when the client sent none', async () => {
    const { controller, chat } = make();
    chat.sendMessage.mockResolvedValueOnce({
      row: { id: 'm1', createdAt: new Date() },
      taggedUserIds: [],
      duplicate: false,
    });
    await controller.sendMedia(req, dto as never);
    expect(chat.sendMessage.mock.calls[0]![1]).toEqual({
      roomRef: 'global',
      media: { url: 'https://x/y.png', type: 'image' },
    });
  });
});

describe('retracting and staff actions', () => {
  it('publishes the retract to open sockets once the service has done it', async () => {
    const { controller, chat, delivery } = make();
    await controller.retract(req, 'm1', { note: 'spam' } as never);
    expect(chat.retract).toHaveBeenCalledWith(USER, 'm1', 'spam');
    expect(delivery.publishRetracted).toHaveBeenCalledWith(
      await chat.retract.mock.results[0]!.value,
    );
  });

  it('resolves the room reference of a ban and hands over the staff member', async () => {
    const { controller, staff, access } = make();
    await controller.ban(req, {
      userId: 'u-9',
      roomId: 'global',
      internalReason: 'rude',
      durationHours: 2,
    } as never);
    expect(access.requireRoom).toHaveBeenCalledWith('global');
    expect(staff.staffBan).toHaveBeenCalledWith(USER, {
      userId: 'u-9',
      roomId: 'room-of-global',
      internalReason: 'rude',
      durationHours: 2,
    });
  });

  it('makes a ban without a room chat-wide', async () => {
    const { controller, staff, access } = make();
    await controller.ban(req, { userId: 'u-9', internalReason: 'rude', permanent: true } as never);
    expect(access.requireRoom).not.toHaveBeenCalled();
    expect(staff.staffBan.mock.calls[0]![1]).toEqual({
      userId: 'u-9',
      roomId: null,
      internalReason: 'rude',
      permanent: true,
    });
  });
});

describe('the routes', () => {
  const proto = ChatRoutes.prototype as unknown as Record<string, unknown>;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (name) =>
      name !== 'constructor' && Reflect.getMetadata('path', proto[name] as object) !== undefined,
  );
  const isPublic = (name: string) =>
    Reflect.getMetadataKeys(proto[name] as object).some(
      (key) => String(key) === 'Symbol(isPublic)',
    );

  it('serves every chat route under /social', () => {
    expect(Reflect.getMetadata('path', ChatRoutes)).toBe('social');
    expect(handlers.length).toBe(23);
    for (const name of handlers) {
      expect(Reflect.getMetadata('path', proto[name] as object)).toMatch(/^chat\//);
    }
  });

  it('keeps every route behind sign-in except the signed media link', () => {
    const open = handlers
      .filter(isPublic)
      .map((name) => Reflect.getMetadata('path', proto[name] as object));
    expect(open).toEqual(['chat/media/:mediaId']);
  });
});
