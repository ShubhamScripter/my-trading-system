import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  PIPES_METADATA,
} from '@nestjs/common/constants';
import { MESSAGE_METADATA } from '@nestjs/websockets/constants';
import type { ExecutionContext } from '@nestjs/common';
import { ChatGateway } from '../../src/social/chat/chat.gateway';
import { ChatGatewayGuard } from '../../src/social/chat/chat.gateway.guard';
import { ChatWsExceptionFilter } from '../../src/social/chat/chat.ws.filter';
import { WsValidationPipe } from '../../src/social/chat/chat.ws.pipe';
import { ChatBus } from '../../src/social/chat/realtime/chat.bus';
import { ChatPresenceService } from '../../src/social/chat/chat.presence.service';
import { ChatDelivery } from '../../src/social/chat/realtime/chat.delivery';
import { TIMERS } from '../../src/social/chat/chat.constants';
import type { MessageRow } from '../../src/social/chat/chat.types';

describe('gateway wiring', () => {
  const proto = ChatGateway.prototype as unknown as Record<string, unknown>;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (name) =>
      typeof proto[name] === 'function' &&
      Reflect.getMetadata(MESSAGE_METADATA, proto[name] as object) !== undefined,
  );

  it('found the socket handlers', () => {
    expect(handlers.sort()).toEqual(
      [
        'handleGetOnlineUsers',
        'handleJoinRoom',
        'handleLeaveRoom',
        'handleRetractMessage',
        'handleSendMessage',
      ].sort(),
    );
  });

  it.each(handlers)('%s carries ChatGatewayGuard and WsValidationPipe', (name) => {
    const fn = proto[name] as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, fn)).toContain(ChatGatewayGuard);
    expect(Reflect.getMetadata(PIPES_METADATA, fn)).toContain(WsValidationPipe);
  });

  it('carries the socket exception filter', () => {
    expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, ChatGateway)).toContain(
      ChatWsExceptionFilter,
    );
  });

  it('no handler accepts casino state from the app any more', () => {
    expect(handlers).not.toContain('handleCasinoState');
  });
});

describe('ChatGatewayGuard', () => {
  const ctx = (data: unknown) =>
    ({ switchToWs: () => ({ getClient: () => ({ data }) }) }) as unknown as ExecutionContext;
  it('admits a handshaken socket and refuses one without a session', () => {
    expect(new ChatGatewayGuard().canActivate(ctx({ user: { id: 'u' }, sessionId: 's' }))).toBe(
      true,
    );
    expect(() => new ChatGatewayGuard().canActivate(ctx(undefined))).toThrow(
      expect.objectContaining({ type: 'unauthenticated' }),
    );
  });
});

// ─── Behaviour with fakes ─────────────────────────────────────────────────────────────────────────────────────────

interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  emit: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  use: ReturnType<typeof vi.fn>;
  rooms: Set<string>;
  middleware?: (packet: unknown[], next: (err?: Error) => void) => void;
}

function makeSocket(userId: string): FakeSocket {
  const socket: FakeSocket = {
    id: `sock-${Math.random().toString(36).slice(2)}`,
    data: {
      user: { id: userId, username: userId, publicCode: 'P', staffRole: null },
      sessionId: 'sid',
      familyId: 'fam',
      ip: '1.1.1.1',
      roomId: null,
      access: null,
      hideIdentity: false,
      activeSkinId: null,
      lastRoomHint: null,
    },
    emit: vi.fn(),
    join: vi.fn(async (room: string) => void socket.rooms.add(room)),
    leave: vi.fn(async (room: string) => void socket.rooms.delete(room)),
    disconnect: vi.fn(),
    use: vi.fn((fn) => {
      socket.middleware = fn;
    }),
    rooms: new Set(),
  };
  return socket;
}

function harness() {
  const emitted: { to: string[]; event: string; payload: unknown }[] = [];
  const target = (rooms: string | string[]) => ({
    emit: (event: string, payload: unknown) =>
      emitted.push({ to: ([] as string[]).concat(rooms), event, payload }),
  });
  const server = { to: vi.fn(target), volatile: { to: vi.fn(target) }, use: vi.fn() };
  const room = (id: string) => ({ id, slug: id, type: 'GLOBAL', config: {}, access: {} });
  const full = {
    accessMode: 'FULL_ACCESS',
    isListed: true,
    isEligibleToView: true,
    isEligibleToWrite: true,
    receivesUserMessages: true,
  };
  const access = {
    effectiveRoom: vi.fn(async () => ({ room: room('global-id'), access: full })),
    requireRoom: vi.fn(async (ref: string) => room(ref)),
    evaluate: vi.fn(async () => full),
    factsFor: vi.fn(async () => ({ country: 'IN' })),
    findRoom: vi.fn(async (ref: string) => room(ref)),
    forgetUser: vi.fn(),
    reloadRooms: vi.fn(async () => []),
  };
  const presence = new ChatPresenceService(
    { set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } as never,
    {
      touchLastSeen: vi.fn(async () => undefined),
      rememberLastRoom: vi.fn(async () => undefined),
      lastOpenedRoom: vi.fn(async () => null),
    } as never,
  );
  const settings = {
    global: vi.fn(async () => ({
      limits: { eventsPerSecond: 10, eventsBurst: 20, connectionsPerAccount: 5 },
    })),
  };
  const moderation = { noteFlood: vi.fn() };
  const relations = {
    hidersOf: vi.fn(() => [] as string[]),
    load: vi.fn(async () => undefined),
    unload: vi.fn(),
  };
  const delivery = new ChatDelivery(presence, relations as never);
  delivery.attach(server as never);
  const gateway = new ChatGateway(
    {} as never,
    access as never,
    presence,
    moderation as never,
    {} as never,
    settings as never,
    {} as never,
    new ChatBus(),
    delivery,
    {} as never,
    relations as never,
    { activePin: vi.fn(async () => null) } as never,
  );
  (gateway as unknown as { server: unknown }).server = server;
  (gateway as unknown as { limits: unknown }).limits = {
    eventsPerSecond: 10,
    eventsBurst: 20,
    connectionsPerAccount: 5,
  };
  return { gateway, delivery, emitted, presence, access, moderation };
}

const row = (i: number, type: MessageRow['type'] = 'TEXT'): MessageRow => ({
  id: `m${i}`,
  roomId: 'r1',
  userId: 'u',
  content: `hi ${i}`,
  type,
  metadata: {},
  createdAt: new Date(),
  createdAtText: '',
  retractedAt: null,
  pinnedAt: null,
  authorUsername: 'u',
  skin: null,
});

describe('connections', () => {
  it('joins the personal room and the effective room, and announces it', async () => {
    const { gateway } = harness();
    const socket = makeSocket('u1');
    await gateway.handleConnection(socket as never);
    expect(socket.rooms).toEqual(new Set(['user:u1', 'room:global-id', 'room:global-id:country:IN']));
    expect(socket.emit).toHaveBeenCalledWith(
      'room_access',
      expect.objectContaining({ status: 'joined', roomId: 'global-id' }),
    );
  });

  it('a 6th connection pushes the oldest out with session_replaced', async () => {
    const { gateway } = harness();
    const sockets = Array.from({ length: 6 }, () => makeSocket('u1'));
    for (const s of sockets) await gateway.handleConnection(s as never);
    expect(sockets[0]!.emit).toHaveBeenCalledWith('session_replaced', expect.anything());
    expect(sockets[0]!.disconnect).toHaveBeenCalled();
    expect(sockets[5]!.disconnect).not.toHaveBeenCalled();
  });

  it('the flood bucket answers rate_limited to the ack and drops the packet', async () => {
    const { gateway, moderation } = harness();
    const socket = makeSocket('u1');
    await gateway.handleConnection(socket as never);
    let passed = 0;
    let refusedAck: unknown = null;
    for (let i = 0; i < 25; i += 1) {
      socket.middleware!(
        ['send_message', {}, (reply: unknown) => (refusedAck = reply)],
        () => (passed += 1),
      );
    }
    expect(passed).toBe(20);
    expect(refusedAck).toMatchObject({
      ok: false,
      error: { type: 'rate_limited', extra: { remainingSeconds: 1 } },
    });
    expect(moderation.noteFlood).toHaveBeenCalled();
  });

  it('join A then B: the socket is only in B and its personal room', async () => {
    const { gateway } = harness();
    const socket = makeSocket('u1');
    await gateway.handleConnection(socket as never);
    await gateway.handleJoinRoom({ roomId: 'a' } as never, socket as never);
    await gateway.handleJoinRoom({ roomId: 'b' } as never, socket as never);
    expect(socket.rooms).toEqual(new Set(['user:u1', 'room:b', 'room:b:country:IN']));
  });

  it('refuses queued sends with a typed retryable server_busy acknowledgement', async () => {
    const { gateway } = harness();
    (gateway as unknown as { pendingSends: number }).pendingSends = TIMERS.MAX_PENDING_SENDS;
    const ack = await gateway.handleSendMessage({ content: 'hello' } as never, makeSocket('u1') as never);
    expect(ack).toMatchObject({
      ok: false,
      error: { type: 'server_busy', retryAfterSeconds: 1, extra: { reason: 'server_busy' } },
    });
  });

  it('keeps infrastructure handshake failures distinct from sign-in failures', async () => {
    const { gateway } = harness();
    (gateway as unknown as { auth: unknown }).auth = {
      authenticateHandshake: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    };
    const socket = makeSocket('u1') as unknown as FakeSocket & {
      handshake: { headers: Record<string, string>; auth: Record<string, unknown>; address: string };
    };
    socket.handshake = { headers: {}, auth: {}, address: '127.0.0.1' };
    const next = vi.fn();
    await (gateway as unknown as { handshake: (socket: unknown, next: (err?: Error) => void) => Promise<void> })
      .handshake(socket, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'session_store_unavailable' }));
  });

  it('maps transient Prisma transaction timeouts to server_busy', async () => {
    const { gateway } = harness();
    (gateway as unknown as { chat: unknown }).chat = {
      sendMessage: vi.fn(async () => {
        throw { code: 'P2028' };
      }),
    };
    const ack = await gateway.handleSendMessage(
      { content: 'hello', clientMessageId: '123e4567-e89b-42d3-a456-426614174000' } as never,
      makeSocket('u1') as never,
    );
    expect(ack).toMatchObject({ ok: false, error: { type: 'server_busy' } });
  });
});

describe('delivery (chat.delivery.ts)', () => {
  it('sends single messages, then groups a busy room into new_messages frames in order', async () => {
    vi.useFakeTimers();
    try {
      const { delivery, emitted } = harness();
      for (let i = 0; i < 30; i += 1) delivery.publish(row(i));
      const singles = emitted.filter((e) => e.event === 'new_message');
      expect(singles).toHaveLength(10);
      vi.advanceTimersByTime(150);
      const frames = emitted.filter((e) => e.event === 'new_messages');
      expect(frames).toHaveLength(1);
      expect((frames[0]!.payload as { id: string }[]).map((m) => m.id)).toEqual(
        Array.from({ length: 20 }, (_, i) => `m${i + 10}`),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('user messages never reach promo-only viewers; alerts do', () => {
    const { delivery, emitted } = harness();
    delivery.publish(row(1));
    delivery.publish(row(2, 'ADMIN_ALERT'));
    expect(
      emitted
        .filter((e) => e.to.includes('room:r1:promo'))
        .map((e) => (e.payload as { id: string }).id),
    ).toEqual(['m2']);
  });

  it('a tag reaches only the tagged users, on their own channel', () => {
    const { delivery, emitted } = harness();
    delivery.notifyTagged(row(1), ['u2']);
    expect(emitted).toEqual([expect.objectContaining({ to: ['user:u2'], event: 'user_tagged' })]);
  });
});
