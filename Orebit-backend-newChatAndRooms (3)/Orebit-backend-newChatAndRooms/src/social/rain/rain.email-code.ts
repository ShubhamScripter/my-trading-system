import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../db/client';
import { RedisService } from '../../../redis';
import { config } from '../../config';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { MailService } from '../../mail/mail.service';
import { CHAT_REFUSAL_REASONS } from '../chat/chat.constants';
import { refuse } from '../chat/chat.moderation.service';
import { VERIFY_TTL_SECONDS } from './rain.dboperation';

/** Rain's own Redis keys. Kept here, apart from redis/keys.ts and chat.keys.ts: they belong to nobody else. */
const KEYS = {
  code: (userId: string) => `chat:rain:otp:${userId}`,
  cooldown: (userId: string) => `chat:rain:otp:cooldown:${userId}`,
  hourly: (userId: string) => `chat:rain:otp:hourly:${userId}`,
} as const;

/** Seconds between two mails to one account, and mails per hour. */
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_MAILS_PER_HOUR = 5;
/** Wrong guesses before the code is burnt and a new one has to be mailed. */
const MAX_ATTEMPTS = 5;

interface StoredCode {
  /** HMAC of the code, never the code. */
  readonly h: string;
  /** Wrong guesses so far. */
  readonly n: number;
}

/**
 * RainPool Settings, "Security Verifications": a risky rain needs the code mailed to the account ("EMAIL & 2FA").
 *
 * Chat's own: mail goes through the existing MailService and the code lives in chat's own Redis keys, so nothing
 * in auth/, redis/ or the 2FA module is touched (decision D-02). The authenticator half of the check is not here;
 * it goes through ChatFeaturePorts.verify(..., 'TWO_FA', ...).
 */
@Injectable()
export class RainEmailCode {
  private readonly logger = new Logger('RainEmailCode');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
  ) {}

  /** Mails a fresh code to the account. Replaces any earlier one. */
  async request(userId: string, _ip: string): Promise<{ sent: true }> {
    const email = await this.emailOf(userId);
    if (!email) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'This account has no email address' });

    // The cooldown is set first and undone if the mail cannot be queued, so a failure never costs the user a wait.
    const claimed = await this.redis.set(KEYS.cooldown(userId), '1', 'EX', RESEND_COOLDOWN_SECONDS, 'NX');
    if (claimed !== 'OK') {
      throw refuse(
        ERR.RATE_LIMITED,
        CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
        `A code was just sent. Wait ${RESEND_COOLDOWN_SECONDS} seconds before asking for another.`,
      );
    }
    const mails = await this.redis.incr(KEYS.hourly(userId));
    if (mails === 1) await this.redis.expire(KEYS.hourly(userId), 3600);
    if (mails > MAX_MAILS_PER_HOUR) {
      throw refuse(ERR.RATE_LIMITED, CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE, 'Too many codes were requested. Try again later.');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + VERIFY_TTL_SECONDS * 1000);
    try {
      await this.redis.set(
        KEYS.code(userId),
        JSON.stringify({ h: this.hash(userId, code), n: 0 } satisfies StoredCode),
        'EX',
        VERIFY_TTL_SECONDS,
      );
      await this.mail.sendOtp(email, code, expiresAt, [], null);
    } catch (err: unknown) {
      await this.redis.del(KEYS.cooldown(userId), KEYS.code(userId)).catch(() => undefined);
      this.logger.warn({ userId, err }, 'could not send the rain email code');
      throw err;
    }
    return { sent: true };
  }

  /** Spends the code: right once, then gone. Throws when it is wrong, expired or used up. */
  async consume(userId: string, code: string): Promise<void> {
    const raw = await this.redis.get(KEYS.code(userId));
    const stored = raw ? (JSON.parse(raw) as StoredCode) : null;
    if (!stored) throw this.wrong('That code has expired. Ask for a new one.');
    if (stored.n >= MAX_ATTEMPTS) {
      await this.redis.del(KEYS.code(userId));
      throw this.wrong('Too many wrong codes. Ask for a new one.');
    }

    const given = Buffer.from(this.hash(userId, code.trim()), 'hex');
    const real = Buffer.from(stored.h, 'hex');
    if (given.length !== real.length || !timingSafeEqual(given, real)) {
      const ttl = await this.redis.ttl(KEYS.code(userId));
      if (ttl > 0) {
        await this.redis.set(KEYS.code(userId), JSON.stringify({ h: stored.h, n: stored.n + 1 } satisfies StoredCode), 'EX', ttl);
      }
      throw this.wrong('The email code is not right.');
    }
    // `del` returns 1 for exactly one caller, so two requests with the same code cannot both pass.
    if ((await this.redis.del(KEYS.code(userId))) !== 1) throw this.wrong('That code was already used.');
  }

  private wrong(detail: string): ProblemException {
    return new ProblemException({ type: ERR.VALIDATION_FAILED, detail });
  }

  private hash(userId: string, code: string): string {
    return createHmac('sha256', config.rateLimitKeySecret).update(`rain-otp:${userId}:${code}`).digest('hex');
  }

  private async emailOf(userId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ email: string }[]>`
      SELECT email FROM identity.users WHERE id = ${userId}::uuid
    `;
    return rows[0]?.email ?? null;
  }
}
