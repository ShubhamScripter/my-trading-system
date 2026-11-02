// The one gate in front of every chat action that is also a command: send, gift, ad, mute, block and their lists
// (rulebook C.5; , ). The same rules apply whether the action is typed as `/mute @bob`, sent over HTTP
// (`POST chat/users/:id/mute`), or started from a button (the DM gift button): first refusal wins.
// 1. chat-wide: "Disable Commands from Chat: ALL / Select Commands" and the commands under maintenance;
// 2. the room, when the action happens in one: "Chat Room Controls: Commands";
// 3. the user: RESTRICT_COMMANDS (and RESTRICT_RAIN for /rain) from the room, staff or an admin;
// 4. standing: a chat-banned user may still mute and block, but not DM, send money, advertise or rain;
// 5. the pace: mute, block, gift and ad actions are limited per user (ChatActionLimiter, the admin's chat limits).
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_COMMANDS, type ChatCommand } from '../chat.contract';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatSettingsService } from '../chat.settings';
import type { ChatSettings } from '../chat.settings.contract';
import type { ChatUserContext, EligibilityFacts, RoomRecord } from '../chat.types';
import { ChatActionLimiter } from '../platform/limiter';
import { roomControlRefusal } from './chat.availability';
import { ChatRestrictionsService } from './chat.restrictions.service';

// Commands that move money, reach other users or post: refused while chat-banned.
const NEEDS_GOOD_STANDING: readonly ChatCommand[] = ['dm', 'send', 'ad', 'rain'];

// The pace group of each limited command: mute and unmute share one counter, like block and unblock.
const LIMIT_GROUP: Partial<Record<ChatCommand, string>> = {
  mute: 'relation',
  unmute: 'relation',
  block: 'relation',
  unblock: 'relation',
  send: 'gift',
  ad: 'ad',
};

export interface GateOptions {
  readonly ip: string;
  // A finer counter than the command's group, e.g. `ad_quote`, so asking for a quote does not use up ad creation.
  readonly limitKey?: string;
  // false for reads (the lists): the switches and restrictions apply, the pace does not.
  readonly limit?: boolean;
}

@Injectable()
export class ChatActionGate {
  constructor(
    private readonly db: ChatDbOperation,
    private readonly access: ChatAccessService,
    private readonly settings: ChatSettingsService,
    private readonly moderation: ChatModerationService,
    private readonly restrictions: ChatRestrictionsService,
    private readonly limiter: ChatActionLimiter,
  ) {}

  // Why this command may not be used here, or null. `room` is null when the action is not typed in a room.
  async refusal(
    user: ChatUserContext,
    facts: EligibilityFacts,
    room: RoomRecord | null,
    settings: ChatSettings,
    command: ChatCommand,
    dbNow: Date,
  ): Promise<ProblemException | null> {
    if (!settings.commands.enabled || (settings.commands.disabled as readonly string[]).includes(command)) {
      return refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.COMMAND_DISABLED, `/${command} is switched off`, { command });
    }
    if ((settings.maintenance.commandsInMaintenance as readonly string[]).includes(command)) {
      return refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_MAINTENANCE,
        settings.maintenance.note ?? `/${command} is under maintenance`,
        { command },
      );
    }
    if (room) {
      const controlMaintenance = roomControlRefusal(room, settings, 'COMMANDS');
      if (controlMaintenance) return controlMaintenance;
      const controls = room.config.contentControls;
      if (!controls.allowCommands || (controls.commands.length > 0 && !controls.commands.includes(command))) {
        return refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.COMMAND_NOT_ALLOWED_HERE,
          `/${command} is not allowed in this room`,
          { command, roomId: room.id },
        );
      }
    }
    const restricted = await this.restrictions.find(user, facts, 'RESTRICT_COMMANDS', room, dbNow, command);
    if (restricted) {
      return refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, restricted.reason, {
        command,
        restriction: 'RESTRICT_COMMANDS',
        expiresAt: restricted.expiresAt,
      });
    }
    if (command === 'rain') {
      const rainBan = await this.restrictions.find(user, facts, 'RESTRICT_RAIN', room, dbNow);
      if (rainBan) {
        return refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, rainBan.reason, {
          command,
          restriction: 'RESTRICT_RAIN',
          expiresAt: rainBan.expiresAt,
        });
      }
    }
    return null;
  }

  // A chat-banned user may still mute and block, but not DM, send money, advertise or rain.
  async assertStanding(user: ChatUserContext, command: ChatCommand, roomId: string | null, dbNow: Date): Promise<void> {
    if (NEEDS_GOOD_STANDING.includes(command)) await this.moderation.assertNotBanned(user, roomId, dbNow);
  }

  // The pace of this user for this kind of action, from the admin's chat limits.
  async limit(
    user: ChatUserContext,
    command: ChatCommand,
    ip: string,
    settings: ChatSettings,
    key?: string,
  ): Promise<void> {
    const group = key ?? LIMIT_GROUP[command];
    if (!group) return;
    const { messagesPerWindow, messageWindowSeconds, cooldownSeconds } = settings.limits;
    const wait = await this.limiter.hit(`chat:limit:act:${user.id}:${group}`, {
      max: messagesPerWindow,
      windowSeconds: messageWindowSeconds,
      cooldownSeconds,
    });
    if (wait > 0) {
      this.moderation.noteFlood(user.id, ip);
      throw new ProblemException({
        type: ERR.RATE_LIMITED,
        detail: `Too fast; wait ${wait}s`,
        extra: { reason: CHAT_REFUSAL_REASONS.ACTION_LIMIT, remainingSeconds: wait },
        retryAfterSeconds: wait,
      });
    }
  }

  // Everything above for an action that is not typed in a room (the HTTP routes and buttons).
  async assert(user: ChatUserContext, command: ChatCommand, options: GateOptions): Promise<void> {
    if (!CHAT_COMMANDS.includes(command)) return;
    const dbNow = await this.db.dbNow();
    const settings = await this.settings.global();
    const refusal = await this.refusal(user, await this.access.factsFor(user), null, settings, command, dbNow);
    if (refusal) throw refusal;
    await this.assertStanding(user, command, null, dbNow);
    if (options.limit !== false) await this.limit(user, command, options.ip, settings, options.limitKey);
  }
}
