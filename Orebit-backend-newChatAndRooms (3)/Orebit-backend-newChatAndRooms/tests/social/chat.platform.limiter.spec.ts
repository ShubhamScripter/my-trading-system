import { describe, expect, it, vi } from 'vitest';
import { ChatActionLimiter } from '../../src/social/chat/platform/limiter';
import { ChatSocialController } from '../../src/social/chat/chat.social.controller';

const RULE = { max: 2, windowSeconds: 60, cooldownSeconds: 10 };

/** A Redis that answers like ioredis for the calls the limiter makes. */
function fakeRedis() {
  const values = new Map<string, number>();
  const ttl = new Map<string, number>();
  return {
    pttl: vi.fn(async (k: string) => (ttl.has(k) ? ttl.get(k)! : values.has(k) ? -1 : -2)),
    incr: vi.fn(async (k: string) => {
      values.set(k, (values.get(k) ?? 0) + 1);
      return values.get(k)!;
    }),
    pexpire: vi.fn(async (k: string, ms: number) => {
      ttl.set(k, ms);
      return 1;
    }),
    set: vi.fn(async (k: string, _v: string, _mode: string, ms: number) => {
      values.set(k, 1);
      ttl.set(k, ms);
      return 'OK';
    }),
  };
}

describe('ChatActionLimiter', () => {
  it('allows max hits, then starts a cooldown with the wait in seconds', async () => {
    const limiter = new ChatActionLimiter(fakeRedis() as never);
    expect(await limiter.hit('k', RULE)).toBe(0);
    expect(await limiter.hit('k', RULE)).toBe(0);
    expect(await limiter.hit('k', RULE)).toBe(10);
    // While cooling, the wait is what is left of the cooldown.
    expect(await limiter.hit('k', RULE)).toBeGreaterThan(0);
  });

  it('keeps separate counters per key', async () => {
    const limiter = new ChatActionLimiter(fakeRedis() as never);
    await limiter.hit('a', RULE);
    await limiter.hit('a', RULE);
    expect(await limiter.hit('a', RULE)).toBeGreaterThan(0);
    expect(await limiter.hit('b', RULE)).toBe(0);
  });

  it('while Redis is down the same rule runs in this process: it never means "no limit" (V2-07, V2-145)', async () => {
    const down = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error('redis down');
        },
      },
    );
    const limiter = new ChatActionLimiter(down as never);
    expect(await limiter.hit('k', RULE)).toBe(0);
    expect(await limiter.hit('k', RULE)).toBe(0);
    expect(await limiter.hit('k', RULE)).toBe(10);
    expect(await limiter.hit('other', RULE)).toBe(0);
  });
});

describe('the HTTP routes ask the gate first (FR-103)', () => {
  const user = { id: 'u1', username: 'ada', publicCode: 'c', staffRole: null };
  function make() {
    const order: string[] = [];
    const gate = { assert: vi.fn(async (_u: unknown, command: string, o: { limitKey?: string; limit?: boolean }) => void order.push(`gate:${command}${o.limitKey ? `:${o.limitKey}` : ''}${o.limit === false ? ':read' : ''}`)) };
    const relations = {
      set: vi.fn(async () => void order.push('service:relation')),
      list: vi.fn(async () => void order.push('service:list')),
    };
    const ads = {
      quote: vi.fn(async () => void order.push('service:quote')),
      create: vi.fn(async () => void order.push('service:create')),
    };
    const gifts = { start: vi.fn(async () => void order.push('service:gift')) };
    const controller = new ChatSocialController(
      { getChatUser: async () => user } as never,
      {} as never,
      {} as never,
      relations as never,
      ads as never,
      {} as never,
      gifts as never,
      gate as never,
    );
    return { controller, order, gate };
  }
  const req = { headers: {}, ip: '10.0.0.9' } as never;

  it('mute, unmute, block and unblock', async () => {
    const { controller, order } = make();
    await controller.relation(req, 'bob', 'mutes', true);
    await controller.relation(req, 'bob', 'mutes', false);
    await controller.relation(req, 'bob', 'blocks', true);
    await controller.relation(req, 'bob', 'blocks', false);
    expect(order).toEqual([
      'gate:mute', 'service:relation',
      'gate:unmute', 'service:relation',
      'gate:block', 'service:relation',
      'gate:unblock', 'service:relation',
    ]);
  });

  it('the lists, ad quote, ad create and gift start', async () => {
    const { controller, order } = make();
    await controller.list(req, 'mutes', {} as never);
    await controller.quoteAd(req, {} as never);
    await controller.createAd(req, {} as never);
    await controller.startGift(req, { recipient: 'bob', amount: '1', currency: 'BTC' } as never);
    expect(order).toEqual([
      'gate:mutelist:read', 'service:list',
      'gate:ad:ad_quote', 'service:quote',
      'gate:ad', 'service:create',
      'gate:send', 'service:gift',
    ]);
  });

  it('a refusal by the gate stops the action', async () => {
    const { controller, order, gate } = make();
    gate.assert.mockRejectedValueOnce(new Error('command_disabled'));
    await expect(controller.relation(req, 'bob', 'mutes', true)).rejects.toThrow('command_disabled');
    expect(order).toEqual([]);
  });
});
