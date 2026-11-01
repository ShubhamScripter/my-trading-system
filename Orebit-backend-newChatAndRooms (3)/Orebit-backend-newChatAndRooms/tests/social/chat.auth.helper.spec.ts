import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { HANDSHAKE_REFUSALS } from '../../src/social/chat/chat.constants';
import { ChatAuthHelper } from '../../src/social/chat/chat.auth.helper';
import { HandshakeRefusal } from '../../src/social/chat/chat.session.adapter';

// The platform guard that authenticates an HTTP request is out of scope here; chat only reads its principal.
const principal = vi.hoisted(() => ({
  current: { userId: 'u-1' } as { userId: string } | undefined,
}));
vi.mock('../../auth/security/guards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/security/guards')>()),
  requirePrincipal: () => {
    if (!principal.current) throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    return principal.current;
  },
}));

const USER = { id: 'u-1', username: 'alice', staffRole: null };

function make(
  over: { user?: unknown; mget?: (...keys: string[]) => Promise<(string | null)[]> } = {},
) {
  const db = {
    findChatUser: vi.fn(async () => ('user' in over ? over.user : USER)),
    deadFamilies: vi.fn(
      async (ids: readonly string[]) => new Set(ids.filter((id) => id.startsWith('dead'))),
    ),
  };
  const redis = { mget: vi.fn(over.mget ?? (async (...keys: string[]) => keys.map(() => null))) };
  const helper = new ChatAuthHelper(db as never, {} as never, {} as never, redis as never);
  return { helper, db, redis };
}

const req = {} as FastifyRequest;

describe('the chat user behind an HTTP request', () => {
  it('returns the live chat user for the authenticated principal', async () => {
    const { helper, db } = make();
    expect(await helper.getChatUser(req)).toBe(USER);
    expect(db.findChatUser).toHaveBeenCalledWith('u-1');
  });

  it('answers 401 for a disabled or deleted account', async () => {
    const { helper } = make({ user: null });
    await expect(helper.getChatUser(req)).rejects.toMatchObject({ type: ERR.UNAUTHENTICATED });
  });

  it('answers 401 when the request has no principal at all', async () => {
    principal.current = undefined;
    try {
      await expect(make().helper.getChatUser(req)).rejects.toMatchObject({
        type: ERR.UNAUTHENTICATED,
      });
    } finally {
      principal.current = { userId: 'u-1' };
    }
  });
});

describe('the socket handshake: the page is checked before any credential', () => {
  const refusal = async (headers: Record<string, string | undefined>) => {
    try {
      await make().helper.authenticateHandshake(headers);
    } catch (err) {
      if (err instanceof HandshakeRefusal) return err.reason;
      throw err;
    }
    return 'accepted';
  };

  it('refuses a missing or foreign origin', async () => {
    expect(await refusal({})).toBe(HANDSHAKE_REFUSALS.ORIGIN_NOT_ALLOWED);
    expect(await refusal({ origin: 'https://evil.example' })).toBe(
      HANDSHAKE_REFUSALS.ORIGIN_NOT_ALLOWED,
    );
  });
});

describe('re-checking open sockets', () => {
  it('reads revoked sessions in chunks of 1,000 and keeps only the flagged ones', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `s${i}`);
    const { helper, redis } = make({
      mget: async (...keys) =>
        keys.map((key) => (key.endsWith(':s7') || key.endsWith(':s2400') ? '1' : null)),
    });

    const revoked = await helper.revokedSessions(ids);

    expect([...revoked].sort()).toEqual(['s2400', 's7']);
    expect(redis.mget).toHaveBeenCalledTimes(3);
    expect(redis.mget.mock.calls.map((call) => call.length)).toEqual([1000, 1000, 500]);
  });

  it('does not count "0" and "false" as revoked', async () => {
    const { helper } = make({ mget: async () => ['0', 'false', 'true'] });
    expect([...(await helper.revokedSessions(['a', 'b', 'c']))]).toEqual(['c']);
  });

  it('lets a Redis error through so the caller keeps every socket', async () => {
    const { helper } = make({
      mget: async () => {
        throw new Error('redis down');
      },
    });
    await expect(helper.revokedSessions(['a'])).rejects.toThrow('redis down');
  });

  it('asks the database for dead families 1,000 at a time', async () => {
    const ids = [...Array.from({ length: 1500 }, (_, i) => `ok${i}`), 'dead-1'];
    const { helper, db } = make();
    expect([...(await helper.deadFamilies(ids))]).toEqual(['dead-1']);
    expect(db.deadFamilies).toHaveBeenCalledTimes(2);
  });
});
