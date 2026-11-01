import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { PinoNestLogger } from '../../../src/logger';
import { CacheService } from '../../../redis/cache';
import { LockService } from '../../../redis/lock';
import { BffSessionService } from '../../../auth/security/bff.session';
import { KEYS, redactKey } from '../../../redis/keys';
import { toPublicAdmin } from '../../../auth/auth.utility';
import { makeAdmin } from '../../harness';
import type { IssuedSession } from '../../../auth/auth.types';

/**
 * ═══ THE BROWSER'S SESSION HANDLE MUST NEVER REACH A LOG (F05) ═══════════════
 *
 * The handle is not merely identifying, it is a BEARER CREDENTIAL: `generateSessionHandle`
 * calls it "the only thing standing between a stranger and a live admin session".
 * Anyone who can read a log line containing it can replay it and be that admin.
 *
 * `redis/keys.ts` builds `bff:session:<handle>` with the handle raw, and argues the
 * case for doing so — it is a server-minted CSPRNG value that "discloses nothing".
 * That argument is about PRIVACY and it is correct on that axis. It is silent on the
 * axis that matters here: a credential does not have to disclose anything, because
 * holding it IS authentication. `CacheService` then logs `{ err, key }` on every
 * failure path, and the credential is in the log.
 *
 * ─── Two channels, and both have to be closed ──────────────────────────────
 *
 *   the field we build   `key`, passed to the logger by our own code.
 *   the field the        `err.command.args` — an ioredis rejection can carry the
 *   driver attaches      failing command, arguments included, which is the same key
 *                        arriving by a route `redactKey` never sees.
 *
 * ─── Two layers of test, because one is not enough ─────────────────────────
 *
 * Spying on `Logger.prototype` proves INTENT: our code did not pass the handle. It
 * cannot prove the second channel, because it observes the arguments before pino's
 * redaction ever runs. So the second layer drives the real `PinoNestLogger` into a
 * capturing stream and asserts on the BYTES actually emitted.
 */

/** Deliberately unmistakable: any occurrence anywhere in the output is a failure,
 *  and no other value in the system can be confused for it. */
const HANDLE = 'RECOGNISABLE-HANDLE-DO-NOT-LOG-b7f3a1c92e';

function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
    getdel: vi.fn(async () => null),
    eval: vi.fn(async () => 1),
  };
}

/** An error shaped like a real ioredis rejection: the failing command, with its
 *  arguments, hanging off the error. This is the second channel. */
function ioredisError(key: string): Error & { command: { name: string; args: string[] } } {
  const err = new Error('Connection is closed.') as Error & {
    command: { name: string; args: string[] };
  };
  err.command = { name: 'get', args: [key] };
  return err;
}

function down(key: string) {
  return () => Promise.reject(ioredisError(key));
}

function issued(): IssuedSession {
  return {
    sessionId: '01920000-0000-7000-8000-00000000000b',
    accessToken: 'access',
    refreshToken: 'refresh',
    accessExpiresAt: new Date(Date.now() + 900_000),
    refreshExpiresAt: new Date(Date.now() + 1_800_000),
    reauthenticateAt: new Date(Date.now() + 43_200_000),
    admin: toPublicAdmin(makeAdmin()),
  };
}

describe('F05 — layer 1: the application never passes the handle to a logger', () => {
  /** Every BFF path that can fail against Redis, driven with Redis rejecting. */
  async function driveEveryFailingPath() {
    const redis = makeRedis();
    const cache = new CacheService(redis as never);
    const locks = new LockService(redis as never);
    const bff = new BffSessionService({ rotate: vi.fn() } as never, cache, locks);

    redis.get.mockImplementation(down(KEYS.bff.session(HANDLE)) as never);
    redis.set.mockImplementation(down(KEYS.bff.session(HANDLE)) as never);
    redis.del.mockImplementation(down(KEYS.bff.session(HANDLE)) as never);
    redis.exists.mockImplementation(down(KEYS.bff.session(HANDLE)) as never);
    redis.eval.mockImplementation(down(KEYS.bff.refreshLock(HANDLE)) as never);

    await bff.destroy(HANDLE);
    await bff.recordState(HANDLE);
    await cache.get(KEYS.bff.session(HANDLE));
    await cache.clear(KEYS.bff.session(HANDLE));
    await cache.flag(KEYS.bff.session(HANDLE));
    await cache.set(KEYS.bff.session(HANDLE), 'v', 60, 'allow');
    // Both of LockService's logger calls: the acquire, which now refuses with a typed
    // problem when Redis cannot answer, and the release, which swallows. Caught here
    // because the refusal is the point of that path, not a failure of this test.
    await locks.withLock(KEYS.bff.refreshLock(HANDLE), 5, async () => undefined).catch(
      () => undefined,
    );
    await bff.create(issued()).catch(() => undefined);
  }

  it('never puts the raw handle in the `key` field it constructs', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);

    await driveEveryFailingPath();

    // Only the fields the application itself builds. What ioredis hangs off `err` is
    // not ours to sanitise at the call site — it arrives already attached, which is
    // exactly why layer 2 exists and why redaction is needed as well as this.
    const keys = [...error.mock.calls, ...warn.mock.calls]
      .map(([meta]) => (meta as { key?: string } | undefined)?.key)
      .filter((k): k is string => typeof k === 'string');

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).not.toContain(HANDLE);

    error.mockRestore();
    warn.mockRestore();
  });

  it('still says which key family failed, so the log is worth having', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);

    await driveEveryFailingPath();

    const keys = error.mock.calls
      .map(([meta]) => (meta as { key?: string } | undefined)?.key)
      .filter((k): k is string => typeof k === 'string');
    // The namespace survives; only the credential is replaced by its fingerprint.
    expect(keys.some((k) => k.startsWith('bff:session:'))).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('leaves a key with no secret in it completely alone', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
    const redis = makeRedis();
    const cache = new CacheService(redis as never);
    const plain = KEYS.session.revoked('01920000-0000-7000-8000-00000000000b');
    redis.get.mockImplementation(down(plain) as never);

    await cache.get(plain);

    // Redaction is targeted, not blanket: a non-sensitive key must read exactly as
    // it always did, or every Redis diagnostic in the service gets worse.
    expect(JSON.stringify(error.mock.calls)).toContain(plain);
    error.mockRestore();
  });
});

describe('F05 — layer 2: the serialized output', () => {
  /**
   * Layer 1 watches the arguments; this watches the BYTES.
   *
   * It is the only layer that can prove the `err.command.args` channel is closed,
   * because pino censors that field after our code has already handed the error over
   * — a spy on the calling side sees the secret still present and would pass.
   *
   * Nest's logger is pointed at a real `PinoNestLogger` writing to a capturing
   * stream, and the real `CacheService` / `LockService` / `BffSessionService` are
   * driven against a dead Redis. So this is the production pipeline end to end:
   * our key redaction, pino's redaction, and the serializer, in the order they
   * actually run.
   */
  function capture() {
    const stream = new PassThrough();
    let out = '';
    stream.on('data', (c: Buffer) => {
      out += c.toString();
    });
    return { stream, read: () => out };
  }

  async function emitEveryFailure(): Promise<string> {
    const { stream, read } = capture();
    Logger.overrideLogger(new PinoNestLogger(stream, 'error'));
    try {
      const redis = makeRedis();
      const cache = new CacheService(redis as never);
      const locks = new LockService(redis as never);
      const bff = new BffSessionService({ rotate: vi.fn() } as never, cache, locks);

      const sessionKey = KEYS.bff.session(HANDLE);
      redis.get.mockImplementation(down(sessionKey) as never);
      redis.set.mockImplementation(down(sessionKey) as never);
      redis.del.mockImplementation(down(sessionKey) as never);
      redis.exists.mockImplementation(down(sessionKey) as never);
      redis.eval.mockImplementation(down(KEYS.bff.refreshLock(HANDLE)) as never);

      await bff.destroy(HANDLE);
      await bff.recordState(HANDLE);
      await cache.get(sessionKey);
      await cache.set(sessionKey, 'v', 60, 'allow');
      await cache.flag(sessionKey);
      await bff.create(issued()).catch(() => undefined);
      return read();
    } finally {
      // Restore the suite-wide silence installed by tests/setup.ts.
      Logger.overrideLogger({
        log: () => undefined,
        error: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        verbose: () => undefined,
        fatal: () => undefined,
      });
    }
  }

  it('never emits the raw handle, through any channel, for any failing BFF path', async () => {
    const out = await emitEveryFailure();

    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(HANDLE);
  });

  it('still emits a useful diagnostic', async () => {
    const out = await emitEveryFailure();

    // The operator can still see WHAT failed and on which family of key.
    expect(out).toContain('bff:session:');
    expect(out).toContain('cache read failed');
  });

  it('closes the err.command.args channel specifically', () => {
    const { stream, read } = capture();
    const logger = new PinoNestLogger(stream, 'error');

    // The key arrives inside the driver's error, where no call site can sanitise it.
    logger.error({ err: ioredisError(KEYS.bff.session(HANDLE)) }, 'cache read failed');

    const out = read();
    expect(out).not.toContain(HANDLE);
    expect(out).toContain('cache read failed');
  });

  it('closes the key channel specifically', () => {
    const { stream, read } = capture();
    const logger = new PinoNestLogger(stream, 'error');

    // What `CacheService` actually logs, after `redactKey`.
    logger.error({ key: redactKey(KEYS.bff.session(HANDLE)) }, 'cache read failed');

    const out = read();
    expect(out).not.toContain(HANDLE);
    expect(out).toContain('bff:session:');
  });
});
