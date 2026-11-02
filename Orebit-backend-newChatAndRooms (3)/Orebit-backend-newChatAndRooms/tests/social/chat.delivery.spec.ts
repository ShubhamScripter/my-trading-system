import { describe, expect, it } from 'vitest';
import { ChatDelivery } from '../../src/social/chat/realtime/chat.delivery';
import type { MessageRow } from '../../src/social/chat/chat.types';

describe('ChatDelivery batching with mute filters', () => {
  it('broadcasts one room batch and sends each hiding member only their visible messages', () => {
    const emitted: { to: string[]; except: string[]; event: string; payload: unknown }[] = [];
    const operator = (to: string[]) => {
      let except: string[] = [];
      const value = {
        except: (rooms: string[]) => {
          except = rooms;
          return value;
        },
        emit: (event: string, payload: unknown) => emitted.push({ to, except, event, payload }),
      };
      return value;
    };
    const server = { to: (rooms: string | string[]) => operator([].concat(rooms as never)) };
    const relations = {
      hidersOf: (authorId: string) =>
        authorId === 'author-a' ? ['hider-a'] : authorId === 'author-b' ? ['hider-b'] : [],
    };
    const presence = {
      userIdsInRoom: () => ['hider-a', 'hider-b', 'reader'],
      socketsOf: (userId: string) => [
        {
          data: { roomId: 'room-1' },
          emit: (event: string, payload: unknown) =>
            emitted.push({ to: [`socket:${userId}`], except: [], event, payload }),
        },
      ],
    };
    const delivery = new ChatDelivery(presence as never, relations as never);
    delivery.attach(server as never);

    const message = (id: string, userId: string): MessageRow => ({
      id,
      roomId: 'room-1',
      userId,
      content: id,
      type: 'TEXT',
      metadata: {},
      createdAt: new Date(),
      createdAtText: '',
      retractedAt: null,
      pinnedAt: null,
      authorUsername: userId,
      skin: null,
    });
    for (let index = 0; index < 13; index += 1) {
      const author = index === 10 ? 'author-a' : index === 11 ? 'author-b' : 'author-c';
      delivery.publish(message(`m${index}`, author));
    }
    (delivery as unknown as { flush: (roomId: string) => void }).flush('room-1');

    const batches = emitted.filter((entry) => entry.event === 'new_messages');
    expect(batches).toHaveLength(3);
    const publicBatch = batches.find((entry) => entry.to.includes('room:room-1'))!;
    expect(publicBatch.except.sort()).toEqual(['user:hider-a', 'user:hider-b']);
    const publicMessages = publicBatch.payload as MessageRow[];
    expect(publicMessages.map((entry) => entry.id)).toEqual(
      ['m10', 'm11', 'm12'],
    );
    expect((batches.find((entry) => entry.to.includes('socket:hider-a'))!.payload as MessageRow[]).some((m) => m.userId === 'author-a')).toBe(false);
    expect((batches.find((entry) => entry.to.includes('socket:hider-b'))!.payload as MessageRow[]).some((m) => m.userId === 'author-b')).toBe(false);
  });

  it('keeps room-wide frames bounded when 200 authors each have a different hider', () => {
    const emitted: { to: string[]; except: string[]; event: string; payload: unknown }[] = [];
    const operator = (to: string[]) => {
      let except: string[] = [];
      const value = {
        except: (rooms: string[]) => {
          except = rooms;
          return value;
        },
        emit: (event: string, payload: unknown) => emitted.push({ to, except, event, payload }),
      };
      return value;
    };
    const hiderIds = Array.from({ length: 200 }, (_, index) => `hider-${index}`);
    const relations = {
      hidersOf: (authorId: string) => {
        if (authorId === 'reader') return [];
        const index = Number(authorId.slice('author-'.length));
        return Number.isInteger(index) && index >= 0 && index < hiderIds.length ? [hiderIds[index]!] : [];
      },
    };
    const presence = {
      userIdsInRoom: () => [...hiderIds, 'reader'],
      socketsOf: (userId: string) => [
        {
          data: { roomId: 'room-1' },
          emit: (event: string, payload: unknown) =>
            emitted.push({ to: [`socket:${userId}`], except: [], event, payload }),
        },
      ],
    };
    const delivery = new ChatDelivery(presence as never, relations as never);
    delivery.attach({ to: (rooms: string | string[]) => operator([].concat(rooms as never)) } as never);

    for (let index = 0; index < 210; index += 1) {
      const author = index < 10 ? 'reader' : `author-${index - 10}`;
      delivery.publish({
        id: `m${index}`,
        roomId: 'room-1',
        userId: author,
        content: 'message',
        type: 'TEXT',
        metadata: {},
        createdAt: new Date(),
        createdAtText: '',
        retractedAt: null,
        pinnedAt: null,
        authorUsername: author,
        skin: null,
      });
    }

    const roomBatches = emitted.filter(
      (entry) => entry.event === 'new_messages' && entry.to.includes('room:room-1'),
    );
    const personalBatches = emitted.filter((entry) => entry.event === 'new_messages' && entry.to[0]?.startsWith('socket:'));
    const filteredMessages = emitted.filter((entry) => entry.event === 'new_message' && entry.to.includes('room:room-1'));
    expect(roomBatches).toHaveLength(0);
    expect(personalBatches).toHaveLength(0);
    expect(filteredMessages.filter((entry) => entry.except.length === 1)).toHaveLength(200);
  });

  it('sends one shared batch for one muter hiding 200 authors', () => {
    const emitted: { to: string[]; except: string[]; event: string; payload: unknown }[] = [];
    const operator = (to: string[]) => {
      let except: string[] = [];
      const value = {
        except: (rooms: string[]) => {
          except = rooms;
          return value;
        },
        emit: (event: string, payload: unknown) => emitted.push({ to, except, event, payload }),
      };
      return value;
    };
    const hider = {
      data: { roomId: 'room-1' },
      emit: (event: string, payload: unknown) => emitted.push({ to: ['socket:hider'], except: [], event, payload }),
    };
    const delivery = new ChatDelivery(
      { userIdsInRoom: () => ['hider', 'reader'], socketsOf: () => [hider] } as never,
      { hidersOf: () => ['hider'] } as never,
    );
    delivery.attach({ to: (rooms: string | string[]) => operator([].concat(rooms as never)) } as never);

    for (let index = 0; index < 210; index += 1) {
      const author = index < 10 ? 'reader' : `author-${index - 10}`;
      delivery.publish({
        id: `m${index}`,
        roomId: 'room-1',
        userId: author,
        content: 'message',
        type: 'TEXT',
        metadata: {},
        createdAt: new Date(),
        createdAtText: '',
        retractedAt: null,
        pinnedAt: null,
        authorUsername: author,
        skin: null,
      });
    }

    const roomBatches = emitted.filter(
      (entry) => entry.event === 'new_messages' && entry.to.includes('room:room-1'),
    );
    expect(roomBatches).toHaveLength(4);
    expect(roomBatches.every((entry) => (entry.payload as MessageRow[]).length === 50)).toBe(true);
    expect(emitted.filter((entry) => entry.to.includes('socket:hider'))).toHaveLength(0);
  });
});
