import { createHmac, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ChatRedisService } from './chat.redis';
import { config } from '../../config';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { type ChatSettings } from './chat.settings.contract';
import { CHAT_REFUSAL_REASONS } from './chat.constants';
import { CHAT_KEY_TTL, CHAT_REDIS_KEYS } from './chat.keys';
import { ChatBus } from './realtime/chat.bus';
import { ChatRecordsDbOperation } from './persistence/chat.records.dboperation';
import type { ChatUserContext } from './chat.types';
import { ChatAccessService } from './chat.access.service';
import { ChatRestrictionsService } from './services/chat.restrictions.service';

interface BanEntry {
  readonly roomId: string | null;
  // ISO database time, or null for permanent.
  readonly expiresAt: string | null;
}

interface BanState {
  readonly v: string;
  readonly bans: BanEntry[];
}

interface WindowState {
  ws: number;
  n: number;
  cu: number;
}

interface LocalWindowState extends WindowState {}

const SEND_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local cooldownMs = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])
local ws, count, cu = now, 0, 0
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, state = pcall(cjson.decode, raw)
  if ok and type(state.ws) == 'number' and type(state.n) == 'number' then
    ws, count, cu = state.ws, state.n, (type(state.cu) == 'number' and state.cu or 0)
  end
end
if cu > now then return {0, math.max(1, math.ceil((cu - now) / 1000))} end
if now - ws >= windowMs then ws, count = now, 0 end
count = count + 1
if count > max then
  if cooldownMs > 0 then cu = now + cooldownMs end
  redis.call('SET', KEYS[1], cjson.encode({ws = ws, n = count, cu = cu}), 'EX', ttlSeconds)
  if cooldownMs > 0 then return {0, math.ceil(cooldownMs / 1000)} end
  return {0, math.max(1, math.ceil((ws + windowMs - now) / 1000))}
end
redis.call('SET', KEYS[1], cjson.encode({ws = ws, n = count, cu = cu}), 'EX', ttlSeconds)
return {1, 0}
`;

const START_MEDIA_LUA = `
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return {1, 0} end
return {0, math.max(1, redis.call('PTTL', KEYS[1]))}
`;

const RELEASE_MEDIA_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

const LOCAL_WINDOW_MAX = 50_000;

// A refusal with its machine-readable reason in both transports.
export function refuse(
  type:
    | typeof ERR.FORBIDDEN
    | typeof ERR.RATE_LIMITED
    | typeof ERR.NOT_FOUND
    | typeof ERR.VALIDATION_FAILED,
  reason: string,
  detail: string,
  extra: Record<string, unknown> = {},
  status?: number,
): ProblemException {
  return new ProblemException({
    type,
    detail,
    extra: { reason, ...extra },
    ...(status ? { status } : {}),
  });
}

// Enforces chat limits, user penalties, word filters, and moderation actions.
export type LimitHitReason =
  | 'slow_mode'
  | 'ip_limit'
  | 'media_cooldown'
  | 'flood'
  | 'new_dm_limit'
  | 'report_limit';

interface LimitHit {
  count: number;
  ip: string;
  reasons: Map<LimitHitReason, number>;
}

@Injectable()
export class ChatModerationService {
  private readonly logger = new Logger('ChatModerationService');
  // Limit hits of the current minute, flushed by the maintenance tick into chat.frequent_hitters.
  private hits = new Map<string, LimitHit>();
  // Limit hits per user in the current minute: the frequent-hitter threshold counts a whole minute.
  private minuteHits = new Map<string, number>();
  private minuteStartedAt = Date.now();
  // Users blocked as frequent hitters, with the database time they are blocked until.
  private blocked = new Map<string, Date>();
  private readonly localWindows = new Map<string, LocalWindowState>();
  private readonly localMedia = new Map<string, { token: string; expiresAt: number }>();
  private redisLimitWarningLogged = false;

  constructor(
    private readonly records: ChatRecordsDbOperation,
    private readonly redis: ChatRedisService,
    private readonly bus: ChatBus,
    private readonly access: ChatAccessService,
    private readonly restrictions: ChatRestrictionsService,
  ) {
    this.bus.subscribe((change) => {
      if (change.kind === 'ban') void this.bumpBanVersion(change.userId);
    });
  }

  // Bans
  // A new random version: the next ban check misses its cache and reads Postgres. One SET, never INCR+EXPIRE.
  async bumpBanVersion(userId: string): Promise<void> {
    try {
      await this.redis.set(
        CHAT_REDIS_KEYS.banVersion(userId),
        randomUUID(),
        'EX',
        CHAT_KEY_TTL.BAN_VERSION,
      );
    } catch (err: unknown) {
      // The ban state cache expires on its own within 30 seconds; the ban is in Postgres either way.
      this.logger.warn(
        { component: 'ChatModerationService', err, userId },
        'could not bump ban version',
      );
    }
  }

  private async banState(userId: string): Promise<BanEntry[]> {
    let version: string | null = null;
    let cached: string | null = null;
    try {
      const values = await this.redis.mget(
        CHAT_REDIS_KEYS.banVersion(userId),
        CHAT_REDIS_KEYS.banState(userId),
      );
      version = values[0] ?? null;
      cached = values[1] ?? null;
    } catch {
      // Redis unavailable: read the database.
    }
    if (version !== null && cached !== null) {
      try {
        const state = JSON.parse(cached) as BanState;
        if (state.v === version) return state.bans;
      } catch {
        // Corrupt cache: read the database.
      }
    }
    const bans = (await this.records.activeBans(userId)).map((ban) => ({
      roomId: ban.roomId,
      expiresAt: ban.expiresAt ? ban.expiresAt.toISOString() : null,
    }));
    // A missing version key means "read the database" every time until a ban or unban sets one.
    if (version !== null) {
      this.redis
        .set(
          CHAT_REDIS_KEYS.banState(userId),
          JSON.stringify({ v: version, bans }),
          'EX',
          CHAT_KEY_TTL.BAN_STATE,
        )
        .catch(() => undefined);
    }
    return bans;
  }

  // The ban that applies to the user in `roomId` (a room ban or a global ban), judged at `dbNow`.
  async activeBan(userId: string, roomId: string | null, dbNow: Date): Promise<BanEntry | null> {
    const bans = await this.banState(userId);
    return (
      bans.find(
        (ban) =>
          (ban.roomId === null || ban.roomId === roomId) &&
          (ban.expiresAt === null || new Date(ban.expiresAt).getTime() > dbNow.getTime()),
      ) ?? null
    );
  }

  // Banned users can read, and are refused on send, upload, report and retracting their own message.
  async assertNotBanned(user: ChatUserContext, roomId: string | null, dbNow: Date): Promise<void> {
    const ban = await this.activeBan(user.id, roomId, dbNow);
    if (ban) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.CHAT_BANNED, 'You are banned from chat', {
        expiresAt: ban.expiresAt,
        ...(ban.roomId ? { roomId: ban.roomId } : {}),
      });
    }
    const room = roomId ? await this.access.findRoom(roomId) : null;
    const facts = await this.access.factsFor(user);
    const groupMute = await this.restrictions.find(user, facts, 'MUTE', room, dbNow, undefined, true);
    if (groupMute) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.CHAT_BANNED, groupMute.reason, {
        expiresAt: groupMute.expiresAt,
        ...(roomId ? { roomId } : {}),
      });
    }
  }

  // Send limits
  isBlocked(userId: string, dbNow: Date): Date | null {
    const until = this.blocked.get(userId);
    return until && until.getTime() > dbNow.getTime() ? until : null;
  }

  // One limit hit, with what the user was doing when it happened. An empty `ip` keeps the one on record.
  noteHit(userId: string, reason: LimitHitReason, ip = ''): void {
    let entry = this.hits.get(userId);
    if (!entry) {
      entry = { count: 0, ip, reasons: new Map() };
      this.hits.set(userId, entry);
    }
    entry.count += 1;
    if (ip) entry.ip = ip;
    entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
  }

  // Counts a refused socket event from the flood bucket as a limit hit too.
  noteFlood(userId: string, ip: string): void {
    this.noteHit(userId, 'flood', ip);
  }

  private rateLimited(
    userId: string,
    ip: string,
    remainingSeconds: number,
    detail: string,
    hit: LimitHitReason = 'slow_mode',
  ): ProblemException {
    this.noteHit(userId, hit, ip);
    return new ProblemException({
      type: ERR.RATE_LIMITED,
      detail,
      extra: { reason: 'slow_mode', remainingSeconds },
      retryAfterSeconds: remainingSeconds,
    });
  }

  private async consumeWindow(
    key: string,
    now: number,
    windowMs: number,
    max: number,
    cooldownMs = 0,
  ): Promise<number> {
    try {
      const result = await this.redis.eval(
        SEND_WINDOW_LUA,
        1,
        key,
        String(now),
        String(windowMs),
        String(max),
        String(cooldownMs),
        String(CHAT_KEY_TTL.LIMIT_WINDOW),
      );
      if (!Array.isArray(result) || result.length < 2) throw new Error('invalid Redis limiter response');
      return Number(result[0]) === 1 ? 0 : Math.max(1, Number(result[1]));
    } catch (err: unknown) {
      if (!this.redisLimitWarningLogged) {
        this.redisLimitWarningLogged = true;
        this.logger.warn({ err }, 'Redis unavailable: chat send limits are enforced in this process');
      }
      return this.consumeWindowLocal(key, now, windowMs, max, cooldownMs);
    }
  }

  private consumeWindowLocal(key: string, now: number, windowMs: number, max: number, cooldownMs: number): number {
    let state = this.localWindows.get(key);
    if (!state) {
      if (this.localWindows.size >= LOCAL_WINDOW_MAX) this.localWindows.delete(this.localWindows.keys().next().value!);
      state = { ws: now, n: 0, cu: 0 };
      this.localWindows.set(key, state);
    }
    if (state.cu > now) return Math.max(1, Math.ceil((state.cu - now) / 1000));
    if (now - state.ws >= windowMs) {
      state.ws = now;
      state.n = 0;
    }
    state.n += 1;
    if (state.n <= max) return 0;
    if (cooldownMs > 0) {
      state.cu = now + cooldownMs;
      return Math.max(1, Math.ceil(cooldownMs / 1000));
    }
    return Math.max(1, Math.ceil((state.ws + windowMs - now) / 1000));
  }

  // Slow mode, media cooldown and the per-IP limit, on the database clock. Each window is one Redis value written
// with one SET … EX; the TTL only cleans up. A lost write can never lock a user out. Throws rate_limited with
// `remainingSeconds`.
  async checkSendLimits(
    user: ChatUserContext,
    ip: string,
    dbNow: Date,
    settings: ChatSettings,
    isMedia: boolean,
  ): Promise<string | null> {
    const now = dbNow.getTime();
    const limits = settings.limits;

    const blockedUntil = this.isBlocked(user.id, dbNow);
    if (blockedUntil) {
      const remaining = Math.max(1, Math.ceil((blockedUntil.getTime() - now) / 1000));
      throw new ProblemException({
        type: ERR.RATE_LIMITED,
        detail: 'Too many limit hits; chat is paused for you',
        extra: { reason: CHAT_REFUSAL_REASONS.LIMIT_BLOCKED, remainingSeconds: remaining },
        retryAfterSeconds: remaining,
      });
    }

    // Per IP, a generous minute window shared by every account on that address.
    const ipKey = CHAT_REDIS_KEYS.ipWindow(
      createHmac('sha256', config.rateLimitKeySecret).update(ip).digest('hex').slice(0, 32),
    );
    const ipWait = await this.consumeWindow(ipKey, now, 60_000, limits.sendsPerIpPerMinute);
    if (ipWait > 0) {
      throw this.rateLimited(
        user.id,
        ip,
        ipWait,
        'Too many messages from this network',
        'ip_limit',
      );
    }

    // Slow mode: at most N per window, then a cooldown.
    const key = CHAT_REDIS_KEYS.messageWindow(user.id);
    const slowWait = await this.consumeWindow(
      key,
      now,
      limits.messageWindowSeconds * 1000,
      limits.messagesPerWindow,
      limits.cooldownSeconds * 1000,
    );
    if (slowWait > 0) {
      throw this.rateLimited(
        user.id,
        ip,
        slowWait,
        slowWait === limits.cooldownSeconds ? `Too many messages; wait ${slowWait}s` : 'Slow down: cooldown active',
      );
    }

    if (isMedia && limits.mediaCooldownSeconds > 0) {
      return this.startMediaCooldown(user.id, ip, now, limits.mediaCooldownSeconds);
    }
    return null;
  }

  // Reserve the media cooldown before inserting the message. A failed insert releases the lease.
  async startMediaCooldown(userId: string, ip: string, now: number, seconds: number): Promise<string> {
    const key = CHAT_REDIS_KEYS.mediaWindow(userId);
    const token = randomUUID();
    const ttlMs = seconds * 1000;
    try {
      const result = await this.redis.eval(START_MEDIA_LUA, 1, key, token, String(ttlMs));
      if (Array.isArray(result) && Number(result[0]) === 1) return token;
      const remaining = Array.isArray(result) ? Math.ceil(Number(result[1]) / 1000) : seconds;
      throw this.rateLimited(userId, ip, Math.max(1, remaining), 'Media cooldown active', 'media_cooldown');
    } catch (err: unknown) {
      if (err instanceof ProblemException) throw err;
      if (!this.redisLimitWarningLogged) {
        this.redisLimitWarningLogged = true;
        this.logger.warn({ err }, 'Redis unavailable: media cooldown is enforced in this process');
      }
      const existing = this.localMedia.get(userId);
      if (existing && existing.expiresAt > now) {
        throw this.rateLimited(
          userId,
          ip,
          Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
          'Media cooldown active',
          'media_cooldown',
        );
      }
      this.localMedia.set(userId, { token, expiresAt: now + ttlMs });
      return token;
    }
  }

  async releaseMediaCooldown(userId: string, token: string): Promise<void> {
    const key = CHAT_REDIS_KEYS.mediaWindow(userId);
    try {
      await this.redis.eval(RELEASE_MEDIA_LUA, 1, key, token);
    } catch {
      if (this.localMedia.get(userId)?.token === token) this.localMedia.delete(userId);
    }
  }

  // Called by the maintenance tick once a minute.
  // Writes the hits gathered since the last flush (every 10 s, so the admin's list is current) and blocks users whose
// hits in the current minute reach the threshold. The minute window is a server stopwatch, like the flood bucket.
  async flushLimitHits(settings: ChatSettings): Promise<void> {
    const hits = this.hits;
    this.hits = new Map();
    if (Date.now() - this.minuteStartedAt >= 60_000) {
      this.minuteHits = new Map();
      this.minuteStartedAt = Date.now();
    }
    const batch = new Map<string, LimitHit & { block: boolean }>();
    for (const [userId, entry] of hits) {
      const total = (this.minuteHits.get(userId) ?? 0) + entry.count;
      this.minuteHits.set(userId, total);
      batch.set(userId, { ...entry, block: total >= settings.limits.hitterThreshold });
    }
    this.blocked = await this.records.recordLimitHits(batch, settings.limits.hitterBlockMinutes);
  }

  // Limit hits in the current minute, for the one-a-minute stats line.
  hitsThisMinute(): number {
    let total = 0;
    for (const count of this.minuteHits.values()) total += count;
    for (const entry of this.hits.values()) total += entry.count;
    return total;
  }
}
