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
/**
 * Field names whose VALUE must never appear in a log line, at any depth.
 *
 * Exported because two places need the same list and a second copy would drift:
 * pino's `redact` below, and the payload scrubber in src/http.ts that walks a
 * rejected request body before it is logged. Add a secret here and both the
 * backstop and the scrubber learn about it at once.
 */
export const SENSITIVE_KEYS = [
  'password',
  'confirmPassword',
  'code',
  'otp',
  'token',
  'refreshToken',
  'captchaToken',
  // The payment PIN and its hash. The PIN is six digits, so a single leaked
  // log line is the whole secret — and unlike a password there is no
  // Postgres-backed lockout behind the Redis quota to blunt what an attacker
  // does with it. `pinHash` is here as well because argon2 over a keyspace of
  // one million is a few CPU-hours, not a wall.
  'pin',
  'newPin',
  'currentPin',
  'pinHash',
  // The email-change recovery ticket. Single-use and short-lived, but while it
  // is live it authorises moving somebody's account to an address of the
  // holder's choosing — with no session and no second factor — so a log line
  // carrying one is a full takeover sitting in an aggregator.
  'recoveryId',
  'recoveryToken',
  'recoveryTokenHash',
  // The anti-phishing code. Not a credential — it authorises nothing and cannot sign
  // anyone in — but it is the value a reader checks to decide whether an email is
  // genuine, so one leaked line is everything an attacker needs to forge mail that
  // passes that check. Listed under its exact field name because pino's `redact`
  // matches paths literally rather than by suffix; `currentCode` is here for the same
  // reason, since `change` puts one on the wire.
  'antiPhishingCode',
  'currentCode',
] as const;

export class PinoNestLogger implements LoggerService {
  private readonly logger: PinoLogger;

  constructor() {
    this.logger = pino({
      level: config.LOG_LEVEL,
      base: { app: 'orebit-backend' },
      // Redaction is a backstop, not the primary defence — the primary defence is
      // never putting these in a log line. It exists because a `{ err }` from a
      // library can carry a whole request object with it.
      redact: {
        // Each secret at the top level and one nesting down — pino's `*` matches a
        // single level, so `{ body: { password } }` needs the second form. Deeper
        // nesting is not covered here and is not meant to be; that is what the
        // scrubber in src/http.ts is for.
        paths: [
          ...SENSITIVE_KEYS,
          ...SENSITIVE_KEYS.map((key) => `*.${key}`),
          'req.headers.authorization',
          'req.headers.cookie',
          // The refresh token leaves in a Set-Cookie header now, so the response
          // side needs the same treatment the request side already had.
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    });
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
  private write(level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal', message: unknown, rest: unknown[]): void {
    if (typeof message === 'object' && message !== null) {
      const msg = typeof rest[0] === 'string' ? rest[0] : undefined;
      this.logger[level](message as Record<string, unknown>, msg);
      return;
    }
    const context = typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : undefined;
    this.logger[level]({ context }, String(message));
  }
}
