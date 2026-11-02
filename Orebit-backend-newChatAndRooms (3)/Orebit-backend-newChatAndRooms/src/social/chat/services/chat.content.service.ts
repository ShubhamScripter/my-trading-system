// The content rules of a room, run on every message before it is stored: allowed message types, deliberate
// restrictions, banned words, links and repeated messages, and the offence ladder behind them. Bans, send limits and the frequent-hitter list are in ChatModerationService.
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ChatRedisService } from '../chat.redis';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { ChatBus } from '../realtime/chat.bus';
import { CHAT_REFUSAL_REASONS, CONTENT_RULES } from '../chat.constants';
import { CHAT_KEY_TTL, CHAT_REDIS_KEYS } from '../chat.keys';
import type { AutoBanTier } from '../chat.contract';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import type { ChatSettings } from '../chat.settings.contract';
import { assertRoomControl, autoModerationActive } from './chat.availability';
import type { ChatUserContext, EligibilityFacts, MediaType, RoomRecord } from '../chat.types';
import * as utility from '../chat.utility';
import { canAct } from './chat.permissions';
import { ChatRestrictionsService, type ActiveRestriction } from './chat.restrictions.service';

const SPAM_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local hash = ARGV[2]
local windowMs = tonumber(ARGV[3])
local repeatCount = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local state = nil
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded.h) == 'string' and type(decoded.ws) == 'number' and type(decoded.n) == 'number' then
    state = decoded
  end
end
if not state or state.h ~= hash or now - state.ws > windowMs then state = {h = hash, ws = now, n = 0} end
state.n = state.n + 1
local hit = state.n >= repeatCount
if hit then state = {h = hash, ws = now, n = 0} end
redis.call('SET', KEYS[1], cjson.encode(state), 'EX', ttl)
if hit then return 1 end
return 0
`;

const LOCAL_SPAM_MAX = 50_000;

@Injectable()
export class ChatContentService {
  private readonly logger = new Logger('ChatContentService');
  private readonly localSpam = new Map<string, { hash: string; startedAt: number; count: number }>();
  private spamRedisWarningLogged = false;
  constructor(
    private readonly records: ChatRecordsDbOperation,
    private readonly redis: ChatRedisService,
    private readonly bus: ChatBus,
    private readonly moderation: ChatModerationService,
    private readonly restrictions: ChatRestrictionsService,
  ) {}

  // Every content rule of the room, on the text as typed. Room content controls and deliberate restrictions
// apply to everyone; the automatic checks (words, links, spam) skip staff and rooms with auto-moderation off.
// A violation of an automatic check counts on the offence ladder and may warn or ban.
  async moderate(input: {
    user: ChatUserContext;
    facts: EligibilityFacts;
    room: RoomRecord;
    settings: ChatSettings;
    text: string;
    media: MediaType | null;
    dbNow: Date;
  }): Promise<void> {
    const { user, facts, room, settings, text, media, dbNow } = input;
    const controls = room.config.contentControls;

    // "Chat Room Controls" under MAINTENANCE refuse with the maintenance text before their ON / OFF switch.
    if (media === 'image') assertRoomControl(room, settings, 'IMAGE');
    if (media === 'gif') assertRoomControl(room, settings, 'GIF');
    if (media === 'video') assertRoomControl(room, settings, 'VIDEO');
    if (media === null) assertRoomControl(room, settings, 'TEXT');
    if (utility.containsEmoji(text)) assertRoomControl(room, settings, 'EMOJI');

    // Chat SETTINGS role permissions "Send Pictures / Videos in Chat": staff with them may send where the room
    // does not allow it.
    if (
      media === 'image' &&
      !controls.allowImage &&
      !canAct(settings, user.staffRole, 'SEND_PICTURES')
    )
      throw this.contentBlocked(CONTENT_RULES.MEDIA_TYPE, 'Images are not allowed in this room');
    if (media === 'gif' && !controls.allowGif)
      throw this.contentBlocked(CONTENT_RULES.MEDIA_TYPE, 'GIFs are not allowed in this room');
    if (
      media === 'video' &&
      !controls.allowVideo &&
      !canAct(settings, user.staffRole, 'SEND_VIDEOS')
    )
      throw this.contentBlocked(CONTENT_RULES.MEDIA_TYPE, 'Videos are not allowed in this room');
    if (media === null && !controls.allowText)
      throw this.contentBlocked(CONTENT_RULES.TEXT, 'Text messages are not allowed in this room');
    const hasEmoji = utility.containsEmoji(text);
    if (!controls.allowEmoji && hasEmoji)
      throw this.contentBlocked(CONTENT_RULES.EMOJI, 'Emoji are not allowed in this room');

    // Deliberate restrictions: the room's list and chat-wide or room rows (staff and admins).
    const restricted = (kind: Parameters<ChatRestrictionsService['find']>[2]) =>
      this.restrictions.find(user, facts, kind, room, dbNow);
    const mute = await restricted('MUTE');
    if (mute) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.CHAT_MUTED, mute.reason, {
        expiresAt: mute.expiresAt,
      });
    }
    const blockedBy = async (
      kind: Parameters<ChatRestrictionsService['find']>[2],
      rule: string,
    ): Promise<void> => {
      const found: ActiveRestriction | null = await restricted(kind);
      if (found) throw this.contentBlocked(rule, found.reason, found.expiresAt);
    };
    if (media === 'image' || media === 'video')
      await blockedBy('RESTRICT_MEDIA', CONTENT_RULES.MEDIA_TYPE);
    if (media === 'image') await blockedBy('RESTRICT_IMAGES', CONTENT_RULES.MEDIA_TYPE);
    if (media === 'video') await blockedBy('RESTRICT_VIDEOS', CONTENT_RULES.MEDIA_TYPE);
    if (media === 'gif') await blockedBy('RESTRICT_GIF', CONTENT_RULES.MEDIA_TYPE);
    if (hasEmoji) await blockedBy('RESTRICT_EMOJI', CONTENT_RULES.EMOJI);

    if (!controls.autoModeration || utility.isChatStaff(user.staffRole)) return;
    await this.automatic({ user, room, settings, text, dbNow });
  }

  // public groups get the same auto-moderation as public chat, on messages, group names and descriptions. The
// rules are the public chat's own (the Global room's word list, link policy and spam rule); a violation counts on
// the same chat-wide offence ladder. Staff and a chat with auto-moderation off are not checked, like in a room.
  async moderateGroupText(input: {
    user: ChatUserContext;
    room: RoomRecord | null;
    settings: ChatSettings;
    text: string;
    dbNow: Date;
  }): Promise<void> {
    const { user, room, settings, text, dbNow } = input;
    if (!room || !room.config.contentControls.autoModeration || utility.isChatStaff(user.staffRole)) return;
    await this.automatic({ user, room, settings, text, dbNow });
  }

  // The automatic checks: banned words, links, repeated messages. Each violation counts on the offence ladder.
  private async automatic(input: {
    user: ChatUserContext;
    room: RoomRecord;
    settings: ChatSettings;
    text: string;
    dbNow: Date;
  }): Promise<void> {
    const { user, room, settings, text, dbNow } = input;

    const matcher = autoModerationActive(settings, 'autoModWords')
      ? utility.bannedWordMatcher(room.config.bannedWords)
      : null;
    if (matcher && matcher.test(text)) {
      await this.offence(user, room, settings, 'banned word');
      throw this.contentBlocked(
        CONTENT_RULES.BANNED_WORD,
        'Your message contains a word that is not allowed here',
      );
    }

    const links = autoModerationActive(settings, 'autoModLinks') ? utility.findLinks(text) : [];
    if (links.length > 0) {
      const policy = room.config.linksPolicy;
      const disallowed =
        policy === 'ALL_LINKS'
          ? []
          : policy === 'OREBIT_ONLY'
            ? links.filter((link) => !utility.hostAllowed(link.host, settings.links.allowedDomains))
            : links;
      if (disallowed.length > 0) {
        // No admin-set policy (links off by default), or only bare domains: refused, never an offence.
        const counts = policy !== undefined && disallowed.some((link) => !link.bare);
        if (counts) await this.offence(user, room, settings, 'link');
        throw this.contentBlocked(CONTENT_RULES.LINK, 'This link is not allowed here');
      }
    }

    const spam = settings.moderation.spamProtection;
    if (
      spam?.enabled &&
      autoModerationActive(settings, 'autoModSpam') &&
      (await this.isSpam(user.id, room.id, text, spam.repeatCount, spam.windowSeconds, dbNow))
    ) {
      await this.offence(user, room, settings, 'spam');
      throw this.contentBlocked(CONTENT_RULES.SPAM, 'Repeated message');
    }
  }

  private contentBlocked(
    rule: string,
    detail: string,
    expiresAt?: string | null,
  ): ProblemException {
    return refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.CONTENT_BLOCKED, detail, {
      rule,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
  }

  // Chat SETTINGS "If Same Message is sent x Times in a row within y seconds": the window starts at the database time
// of the first copy and is never restarted by a repeat. One value per user and room, one SET.
  private async isSpam(
    userId: string,
    roomId: string,
    text: string,
    repeat: number,
    windowSeconds: number,
    dbNow: Date,
  ): Promise<boolean> {
    const key = CHAT_REDIS_KEYS.spamWindow(userId, roomId);
    const now = dbNow.getTime();
    const hash = createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 32);
    try {
      const result = await this.redis.eval(
        SPAM_WINDOW_LUA,
        1,
        key,
        String(now),
        hash,
        String(windowSeconds * 1000),
        String(repeat),
        String(CHAT_KEY_TTL.SPAM_WINDOW),
      );
      return Number(result) === 1;
    } catch (err: unknown) {
      if (!this.spamRedisWarningLogged) {
        this.spamRedisWarningLogged = true;
        this.logger.warn({ err }, 'Redis unavailable: repeated-message limits are enforced in this process');
      }
    }
    let state = this.localSpam.get(key);
    if (!state || state.hash !== hash || now - state.startedAt > windowSeconds * 1000) {
      state = { hash, startedAt: now, count: 0 };
      if (this.localSpam.size >= LOCAL_SPAM_MAX) this.localSpam.delete(this.localSpam.keys().next().value!);
      this.localSpam.set(key, state);
    }
    state.count += 1;
    const hit = state.count >= repeat;
    if (hit) {
      state.startedAt = now;
      state.count = 0;
    }
    return hit;
  }

  // One offence on the chat-wide ladder: the position comes from Postgres and counts across rooms, then that
// tier's warning or ban is applied in the room where it happened.
  private async offence(
    user: ChatUserContext,
    room: RoomRecord,
    settings: ChatSettings,
    what: string,
  ): Promise<void> {
    // No ladder set by the admin means no automatic penalty: the message is refused and nothing is counted.
    const sequence: readonly AutoBanTier[] = settings.moderation.autoBanSequence;
    if (sequence.length === 0) return;
    const tierFor = (count: number): AutoBanTier => sequence[Math.min(count, sequence.length) - 1]!;
    const count = await this.records.recordOffence(user.id, (n) => tierFor(n).resetWindowHours);
    const tier = tierFor(count);
    // The rule that fired is the internal reason; it is no secret, so the user is told the same.
    const reason = `Auto-moderation: ${what}`;

    if (tier.action === 'BAN') {
      const seconds = tier.permanent ? null : (tier.durationSeconds ?? 3600);
      const ban = await this.records.transaction(async (tx) => {
        const created = await this.records.createBan(tx, {
          userId: user.id,
          roomId: room.id,
          internalReason: reason,
          userReason: reason,
          seconds,
          moderatorId: null,
        });
        // Auto-moderation never asks for the duplicate guard, so a ban always comes back.
        if (!created) throw new Error('auto-ban was not created');
        await this.records.recordAction(tx, {
          actorType: 'SYSTEM',
          actorId: null,
          action: 'auto.ban',
          targetUserId: user.id,
          targetRoomId: room.id,
          newValue: { tier: tier.tier, seconds, permanent: seconds === null },
          note: reason,
        });
        return created;
      });
      await this.moderation.bumpBanVersion(user.id);
      this.bus.publish({
        kind: 'notice',
        userId: user.id,
        notice: {
          action: 'ban',
          roomId: room.id,
          note: reason,
          expiresAt: ban.expiresAt?.toISOString() ?? null,
        },
      });
      return;
    }

    await this.records.transaction(async (tx) => {
      await this.records.createWarning(tx, {
        userId: user.id,
        roomId: room.id,
        internalReason: reason,
        userReason: reason,
        issuedBy: null,
      });
      await this.records.recordAction(tx, {
        actorType: 'SYSTEM',
        actorId: null,
        action: 'auto.warn',
        targetUserId: user.id,
        targetRoomId: room.id,
        newValue: { tier: tier.tier },
        note: reason,
      });
    });
    this.bus.publish({
      kind: 'notice',
      userId: user.id,
      notice: { action: 'warn', roomId: room.id, note: reason },
    });
  }
}
