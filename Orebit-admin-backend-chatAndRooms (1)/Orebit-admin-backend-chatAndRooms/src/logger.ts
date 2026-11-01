import type { LoggerService } from '@nestjs/common';
import pino, { type Logger as PinoLogger } from 'pino';
import { config } from './config';

/**
 * Nest's logging interface backed by pino, so application logs and framework
 * logs land in one stream with one format.
 *
 * JSON in production because that is what a log aggregator can query;
 * pino-pretty is deliberately NOT a dependency, so development gets plain JSON
 * too rather than a formatter that only exists on one machine.
 */
export class PinoNestLogger implements LoggerService {
  private readonly logger: PinoLogger;

  /**
   * `destination` and `level` exist for TESTS, and specifically so that a test can
   * assert on the bytes this class actually emits rather than on the arguments handed
   * to it. Redaction happens inside pino, after any spy on the calling side would
   * have run, so the difference is the whole point: an assertion about arguments
   * cannot prove a secret is censored.
   *
   * Taking them here rather than exporting the options object keeps ONE configuration
   * — the one that ships is the one under test, and the two cannot drift.
   */
  constructor(destination?: pino.DestinationStream, level = config.LOG_LEVEL) {
    this.logger = pino({
      level,
      base: { app: 'orebit-admin-backend' },
      // Redaction is a backstop, not the primary defence — the primary defence is
      // never putting these in a log line. It exists because a `{ err }` from a
      // library can carry a whole request object with it.
      //
      // This service has more to redact than the consumer backend does: a login
      // carries a `loginId` and a TOTP code as well as a password, and a decrypted
      // TOTP secret is the one value here that is permanently compromising rather
      // than compromising for thirty seconds.
      //
      // ─── `loginId` needs THREE paths, not one ───────────────────────────────
      //
      // It is the credential for a half-finished sign-in and it now travels in the
      // request body, so it can reach a log line by three different routes: named
      // directly, inside the `{ data }` success envelope, or — the realistic one —
      // inside a whole request object dragged in by a library's `{ err }`.
      //
      // `*` matches exactly ONE level, despite what the redaction library's README
      // implies, so `'*.loginId'` covers `data.loginId` and does NOT cover
      // `req.body.loginId`. Both are spelled out. (The `'*.password'` family below
      // has the same one-level limit; that is pre-existing and out of scope here.)
      redact: {
        paths: [
          'password',
          'confirmPassword',
          'code',
          'otp',
          'token',
          'refreshToken',
          'captchaToken',
          'loginId',
          'totpCode',
          'totpSecret',
          'secret',
          'req.headers.authorization',
          // Carries the opaque BFF session handle, its CSRF companion and the device
          // id. The handle is a bearer credential — holding it IS authentication —
          // so this line is protecting the same value `redactKey` protects on the
          // Redis side.
          'req.headers.cookie',
          // ═══ THE SECOND WAY A REDIS KEY REACHES A LOG ════════════════════════
          //
          // `CacheService` and `LockService` log `{ err, key }`, and pass the key
          // through `redactKey` first — but an ioredis rejection carries the failing
          // command with its ARGUMENTS attached, so the same key arrives a second
          // time inside `err`, by a route no call site can sanitise.
          //
          // Every Redis argument, not just the key: a `SET` on a session record
          // carries the record itself, which holds an access token.
          'err.command.args',
          '*.loginId',
          'req.body.loginId',
          '*.password',
          '*.code',
          '*.token',
          '*.secret',
        ],
        censor: '[redacted]',
      },
    }, destination);
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  /**
   * Nest calls its logger two ways — `log(msg, context)` and, from our own code,
   * `log(objectOfFields, msg)`. Both have to end up as one structured line, so
   * the object form is detected rather than stringified.
   */
  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    rest: unknown[],
  ): void {
    if (typeof message === 'object' && message !== null) {
      const msg = typeof rest[0] === 'string' ? rest[0] : undefined;
      this.logger[level](message as Record<string, unknown>, msg);
      return;
    }
    const context =
      typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : undefined;
    this.logger[level]({ context }, String(message));
  }
}
