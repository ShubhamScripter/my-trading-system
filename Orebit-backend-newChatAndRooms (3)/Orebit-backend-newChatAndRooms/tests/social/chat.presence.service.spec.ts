import { describe, expect, it, vi } from 'vitest';
import { ChatPresenceService } from '../../src/social/chat/chat.presence.service';
import type { ChatDbOperation } from '../../src/social/chat/chat.dboperation';
import type { ChatSocket, OnlineMember } from '../../src/social/chat/chat.types';
import type { ChatRedisService } from '../../src/social/chat/chat.redis';

function harness() {
  const redis = {
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    pipeline: vi.fn(() => ({ set: vi.fn(), exec: vi.fn(async () => []) })),
  };
  const db = { touchLastSeen: vi.fn(async () => undefined) };
  const presence = new ChatPresenceService(
    redis as unknown as ChatRedisService,
    db as unknown as ChatDbOperation,
  );
  return { presence, redis, db };
}

const member = (id: string, username: string): OnlineMember => ({
  id,
  username,
  country: null,
  isStaff: false,
});
const socket = (userId: string): ChatSocket =>
  ({ id: `s-${Math.random()}`, data: { user: { id: userId } } }) as unknown as ChatSocket;

describe('ChatPresenceService', () => {
  it('goes offline only when the last socket closes, and records last seen both times', () => {
    const { presence, db } = harness();
    const a = socket('u1');
    const b = socket('u1');
    presence.add(a, member('u1', 'ada'));
    presence.add(b, member('u1', 'ada'));
    expect(presence.remove(a)).toBe(false);
    expect(presence.isOnline('u1')).toBe(true);
    expect(presence.remove(b)).toBe(true);
    expect(presence.isOnline('u1')).toBe(false);
    expect(db.touchLastSeen).toHaveBeenCalledTimes(2);
  });

  it('counts each user once per room however many tabs they have', () => {
    const { presence } = harness();
    presence.joinRoom('r', 'u1');
    presence.joinRoom('r', 'u1');
    presence.joinRoom('r', 'u2');
    expect(presence.count('r')).toBe(2);
    presence.leaveRoom('r', 'u1');
    expect(presence.count('r')).toBe(2);
    presence.leaveRoom('r', 'u1');
    expect(presence.count('r')).toBe(1);
  });

  it('returns members on request: 50 per page with a cursor and a prefix search', () => {
    const { presence } = harness();
    for (let i = 0; i < 120; i += 1) {
      const id = `u${String(i).padStart(3, '0')}`;
      presence.add(socket(id), member(id, `user${String(i).padStart(3, '0')}`));
      presence.joinRoom('r', id);
    }
    const first = presence.members('r');
    expect(first.count).toBe(120);
    expect(first.items).toHaveLength(50);
    const seen = new Set(first.items.map((m) => m.id));
    let cursor = first.nextCursor;
    while (cursor) {
      const page = presence.members('r', 50, cursor);
      for (const m of page.items) seen.add(m.id);
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(120);
    expect(presence.members('r', 50, null, 'user11').items.map((m) => m.username)).toEqual([
      'user110',
      'user111',
      'user112',
      'user113',
      'user114',
      'user115',
      'user116',
      'user117',
      'user118',
      'user119',
    ]);
  });

  it('uses the same ordering for usernames and the paging cursor', () => {
    const { presence } = harness();
    for (const [id, username] of [
      ['u0', 'a_b'],
      ['u1', 'a1'],
      ['u2', 'a2'],
      ['u3', 'ab'],
      ['u4', 'a_c'],
      ['u5', 'a0'],
    ] as const) {
      presence.add(socket(id), member(id, username));
      presence.joinRoom('r', id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = presence.members('r', 1, cursor);
      seen.push(...page.items.map((row) => row.username));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set(['a_b', 'a1', 'a2', 'ab', 'a_c', 'a0']));
  });

  it('refreshes every marker with a TTL in one pipeline', async () => {
    const { presence, redis } = harness();
    presence.add(socket('u1'), member('u1', 'ada'));
    await presence.refreshMarkers();
    expect(redis.pipeline).toHaveBeenCalledTimes(1);
  });
});
