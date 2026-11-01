import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { signAccessToken } from '../../auth/security/jwt';
import { config } from '../../src/config';
import { ChatAuthHelper } from '../../src/social/chat/chat.auth.helper';
import type { ChatDbOperation } from '../../src/social/chat/chat.dboperation';
import {
  ChatSessionAdapter,
  HandshakeRefusal,
  allowedOrigins,
  readCookie,
  sessionRecordKey,
} from '../../src/social/chat/chat.session.adapter';
import type { RedisService } from '../../redis';
import type { SessionService } from '../../auth/services/session.service';

/**
 * The chat socket's only login is the session cookie of the new auth. This spec loads a session
 * record in the auth's format and connects with its cookie, so any drift in the record format fails here.
 */
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'bff-session-record.json'), 'utf8'),
) as {
  handle: string;
  record: Record<string, unknown>;
};

const USER_ID = '0192f6a0-0000-7000-8000-00000000bb01';
const FAMILY_ID = '0192f6a0-0000-7000-8000-00000000cc01';
// The developer's .env may list extra origins; this spec checks the default (the web app's origin only).
delete process.env.CHAT_ALLOWED_ORIGINS;
const ORIGIN = new URL(config.WEB_APP_URL).origin;

function record(overrides: Record<string, unknown> = {}): string {
  const { token, expiresAt } = signAccessToken({
    userId: USER_ID,
    sessionId: fixture.record.sessionId as string,
    publicCode: 'OREBiTTEST0001',
  });
  return JSON.stringify({
    ...fixture.record,
    accessToken: token,
    accessExpiresAt: expiresAt.getTime(),
    expiresAt: Date.now() + 86_400_000,
    ...overrides,
  });
}

function harness(
  opts: { stored?: string | null; redisFails?: boolean; live?: boolean; dbNow?: Date } = {},
) {
  const redis = {
    get: vi.fn(async (key: string) => {
      if (opts.redisFails) throw new Error('ECONNREFUSED');
      return key === sessionRecordKey(fixture.handle)
        ? opts.stored === undefined
          ? record()
          : opts.stored
        : null;
    }),
    mget: vi.fn(async (...keys: string[]) => keys.map(() => null)),
  };
  const sessions = { assertLive: vi.fn(async () => FAMILY_ID) };
  const db = {
    sessionLive: vi.fn(async () => ({ live: opts.live ?? true, dbNow: opts.dbNow ?? new Date() })),
    findChatUser: vi.fn(async () => ({
      id: USER_ID,
      username: 'ada',
      publicCode: 'OREBiTTEST0001',
      staffRole: null,
    })),
    deadFamilies: vi.fn(async (ids: string[]) => new Set(ids.slice(0, 1))),
  };
  const adapter = new ChatSessionAdapter(redis as unknown as RedisService);
  const helper = new ChatAuthHelper(
    db as unknown as ChatDbOperation,
    sessions as unknown as SessionService,
    adapter,
    redis as unknown as RedisService,
  );
  return { helper, redis, sessions, db };
}

const headers = (extra: Record<string, string> = {}) => ({
  origin: ORIGIN,
  cookie: `theme=dark; orebit_session=${fixture.handle}`,
  ...extra,
});

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof HandshakeRefusal) return err.reason;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('session record contract', () => {
  it('names the record the way the auth does: an HMAC of the handle', () => {
    const tag = createHmac('sha256', config.rateLimitKeySecret)
      .update(fixture.handle)
      .digest('hex')
      .slice(0, 32);
    expect(sessionRecordKey(fixture.handle)).toBe(`bff:session:${tag}`);
  });

  it('connects with only the session cookie from an allowed origin', async () => {
    const { helper, sessions } = harness();
    const result = await helper.authenticateHandshake(headers());
    expect(result).toMatchObject({
      user: { id: USER_ID },
      sessionId: fixture.record.sessionId,
      familyId: FAMILY_ID,
    });
    expect(sessions.assertLive).toHaveBeenCalledWith(fixture.record.sessionId);
  });

  it('reads one cookie among several', () => {
    expect(readCookie('a=1; orebit_session=abc%20d; b=2', 'orebit_session')).toBe('abc d');
    expect(readCookie('a=1', 'orebit_session')).toBeNull();
  });
});

describe('handshake refusals', () => {
  it('refuses a missing or unlisted Origin', async () => {
    const { helper } = harness();
    expect(await refusal(() => helper.authenticateHandshake({ cookie: headers().cookie }))).toBe(
      'origin_not_allowed',
    );
    expect(
      await refusal(() =>
        helper.authenticateHandshake(headers({ origin: 'https://evil.example' })),
      ),
    ).toBe('origin_not_allowed');
    expect(allowedOrigins()).toEqual([ORIGIN]);
  });

  it('ignores a bearer token anywhere: no cookie is unauthenticated', async () => {
    const { helper } = harness();
    const token = JSON.parse(record()).accessToken as string;
    expect(
      await refusal(() =>
        helper.authenticateHandshake({ origin: ORIGIN, authorization: `Bearer ${token}`, token }),
      ),
    ).toBe('unauthenticated');
  });

  it('after logout the record is gone: unauthenticated', async () => {
    const { helper } = harness({ stored: null });
    expect(await refusal(() => helper.authenticateHandshake(headers()))).toBe('unauthenticated');
  });

  it('Redis down: session_store_unavailable, never a logout', async () => {
    const { helper } = harness({ redisFails: true });
    expect(await refusal(() => helper.authenticateHandshake(headers()))).toBe(
      'session_store_unavailable',
    );
  });

  it('a token due for refresh (by the database clock): session_refresh_required', async () => {
    const { helper } = harness({ stored: record({ accessExpiresAt: Date.now() + 10_000 }) });
    expect(await refusal(() => helper.authenticateHandshake(headers()))).toBe(
      'session_refresh_required',
    );
  });

  it('a disabled or deleted account, or a dead family: unauthenticated', async () => {
    const { helper } = harness({ live: false });
    expect(await refusal(() => helper.authenticateHandshake(headers()))).toBe('unauthenticated');
  });
});

describe('revocation checks', () => {
  it('reads revocation flags with MGET in chunks of 1,000', async () => {
    const { helper, redis } = harness();
    const ids = Array.from({ length: 2500 }, (_, i) => `s${i}`);
    await helper.revokedSessions(ids);
    expect(redis.mget).toHaveBeenCalledTimes(3);
  });

  it('checks families in chunks of 1,000 statements', async () => {
    const { helper, db } = harness();
    const dead = await helper.deadFamilies(Array.from({ length: 2500 }, (_, i) => `f${i}`));
    expect(db.deadFamilies).toHaveBeenCalledTimes(3);
    expect(dead.size).toBe(3);
  });
});
