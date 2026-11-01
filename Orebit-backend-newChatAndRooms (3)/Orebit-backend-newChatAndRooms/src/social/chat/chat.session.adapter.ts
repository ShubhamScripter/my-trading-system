import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../../redis';
import { config } from '../../config';
import { HANDSHAKE_REFUSALS } from './chat.constants';

/**
 * ═══ THE CHAT SOCKET'S ONLY LOGIN: THE SESSION COOKIE ═══════════
 *
 * The new cookie-session auth (auth-wallet-integration) gives the browser one httpOnly cookie, `orebit_session`,
 * holding an opaque handle. The handle names a record in Redis that holds the access token on the browser's behalf.
 * This adapter reads that record exactly as the auth's `BffSessionService.resolve()` does — key format and record
 * shape copied READ-ONLY from `auth/security/bff.session.ts` on that branch — and nothing else. It never rotates a
 * token: a record whose access token is due for refresh is refused with `session_refresh_required`, and the web app
 * refreshes over HTTP and reconnects.
 *
 * At merge, replace this file with the auth's own BffSessionService (one file); the contract test
 * (tests/social/chat.session.adapter.spec.ts) fails on any drift in the record format.
 */

/** Copied from the auth: the cookie name and the refresh skew (SESSION.COOKIE_NAME, SESSION.ACCESS_REFRESH_SKEW_SECONDS). */
export const SESSION_COOKIE_NAME = 'orebit_session';
export const ACCESS_REFRESH_SKEW_SECONDS = 30;

/** What the auth stores under `bff:session:<tagged handle>`. */
export interface SessionRecord {
  readonly sessionId: string;
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly accessExpiresAt: number;
  readonly refreshSealed: string;
  readonly expiresAt: number;
}

export class HandshakeRefusal extends Error {
  constructor(readonly reason: (typeof HANDSHAKE_REFUSALS)[keyof typeof HANDSHAKE_REFUSALS]) {
    super(reason);
    this.name = 'HandshakeRefusal';
  }
}

/** The auth's `tag()` from redis/keys.ts: an HMAC of the handle, so a Redis dump does not reveal handles. */
export function sessionRecordKey(handle: string): string {
  const tag = createHmac('sha256', config.rateLimitKeySecret)
    .update(handle)
    .digest('hex')
    .slice(0, 32);
  return `bff:session:${tag}`;
}

/** Reads one cookie out of a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return value === '' ? null : decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** The origins the chat socket accepts: CHAT_ALLOWED_ORIGINS, comma-separated, else the web app's origin. */
export function allowedOrigins(): string[] {
  const configured = (process.env.CHAT_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
  if (configured.length > 0) return configured;
  try {
    return [new URL(config.WEB_APP_URL).origin];
  } catch {
    return [];
  }
}

@Injectable()
export class ChatSessionAdapter {
  private readonly logger = new Logger('ChatSessionAdapter');

  constructor(private readonly redis: RedisService) {}

  /**
   * The access token for the session cookie in `cookieHeader`, or a refusal with one of three distinct reasons:
   * `unauthenticated` (no cookie, no record), `session_store_unavailable` (Redis did not answer — the client should
   * retry, not log out), `session_refresh_required` (the token is due; refresh over HTTP, then reconnect).
   *
   * `dbNowMs` is the database clock; the due check never uses this process's clock.
   */
  async resolve(cookieHeader: string | undefined): Promise<SessionRecord> {
    const handle = readCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (handle === null) throw new HandshakeRefusal(HANDSHAKE_REFUSALS.UNAUTHENTICATED);

    let raw: string | null;
    try {
      raw = await this.redis.get(sessionRecordKey(handle));
    } catch (err: unknown) {
      this.logger.warn(
        { component: 'ChatSessionAdapter', err },
        'session store unavailable during chat handshake',
      );
      throw new HandshakeRefusal(HANDSHAKE_REFUSALS.SESSION_STORE_UNAVAILABLE);
    }
    if (raw === null) throw new HandshakeRefusal(HANDSHAKE_REFUSALS.UNAUTHENTICATED);

    const record = parseRecord(raw);
    if (record === null) throw new HandshakeRefusal(HANDSHAKE_REFUSALS.UNAUTHENTICATED);
    return record;
  }

  /** A record whose access token expires within the auth's skew of the database time is due for refresh. */
  isDueForRefresh(record: SessionRecord, dbNowMs: number): boolean {
    return record.accessExpiresAt - dbNowMs <= ACCESS_REFRESH_SKEW_SECONDS * 1000;
  }
}

function parseRecord(raw: string): SessionRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.sessionId !== 'string' ||
    typeof v.accessToken !== 'string' ||
    typeof v.accessExpiresAt !== 'number' ||
    typeof v.refreshSealed !== 'string' ||
    typeof v.expiresAt !== 'number'
  ) {
    return null;
  }
  return {
    sessionId: v.sessionId,
    accessToken: v.accessToken,
    accessExpiresAt: v.accessExpiresAt,
    refreshSealed: v.refreshSealed,
    expiresAt: v.expiresAt,
  };
}
