// Chat commands (Module 5, Chat MAIN "Public chat will contain commands to perform certain actions directly from
// chat"): the authorization layer and the actions.
// A command is allowed only when every layer allows it, first refusal wins:
// The rules (the switches, the room, restrictions, bans and the pace) are the shared ChatActionGate, the same ones the
// HTTP routes and buttons use. Every command run or refused is written to the command log (ids and amounts only).
import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_COMMANDS, type ChatCommand } from '../chat.contract';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatSettingsService } from '../chat.settings';
import type { ChatSettings } from '../chat.settings.contract';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import type { ChatUserContext, EligibilityFacts, RoomRecord } from '../chat.types';
import * as utility from '../chat.utility';
import { DmService } from '../dm/dm.service';
import { ChatActionGate } from './chat.action-gate.service';
import { ChatAdsService } from './chat.ads.service';
import { COMMAND_HELP, commandName, parseCommand } from './chat.commands.parser';
import { ChatGiftsService } from './chat.gifts.service';
import { ChatRelationsService } from './chat.relations.service';
import { ChatRestrictionsService } from './chat.restrictions.service';
import { RainService, type RainRequestContext } from '../../rain/rain.service';
import { parseMinor } from '../../rain/rain.math';

export interface CommandResult {
  readonly command: ChatCommand;
  readonly roomId: string;
  readonly result: unknown;
}

@Injectable()
export class ChatCommandsService {
  private readonly logger = new Logger('ChatCommandsService');

  constructor(
    private readonly db: ChatDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly access: ChatAccessService,
    private readonly settings: ChatSettingsService,
    private readonly moderation: ChatModerationService,
    private readonly restrictions: ChatRestrictionsService,
    private readonly relations: ChatRelationsService,
    private readonly gifts: ChatGiftsService,
    private readonly ads: ChatAdsService,
    private readonly dms: DmService,
    private readonly rain: RainService,
    private readonly gate: ChatActionGate,
  ) {}

  // Whether the text is a command attempt (`/word …`); everything else is an ordinary message.
  static isCommandText(text: string | undefined): boolean {
    return typeof text === 'string' && commandName(text) !== null;
  }

  async run(
    user: ChatUserContext,
    input: {
      roomRef: string | undefined;
      text: string;
      ip: string;
      clientMessageId?: string;
      // The request's session, network and country, for /rain's security tiers.
      context?: RainRequestContext;
    },
  ): Promise<CommandResult> {
    const read = await this.db.readRoom(
      utility.normalizeRoomRef(input.roomRef),
      this.access.onConfigProblem,
    );
    if (!read)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Room not found',
      });
    const { room, dbNow } = read;
    const parsed = parseCommand(input.text);
    const name = commandName(input.text) ?? '';
    const log = (
      result: 'EXECUTED' | 'REFUSED',
      reason: string | null,
      args: Record<string, unknown> = {},
    ) => {
      this.records
        .logCommand({
          userId: user.id,
          roomId: room.id,
          command: name.slice(0, 32),
          args,
          result,
          reason,
        })
        .catch((err: unknown) =>
          this.logger.warn({ component: 'ChatCommandsService', err }, 'could not log a command'),
        );
    };

    if (parsed.kind === 'none' || parsed.kind === 'unknown') {
      log('REFUSED', CHAT_REFUSAL_REASONS.UNKNOWN_COMMAND);
      throw refuse(
        ERR.VALIDATION_FAILED,
        CHAT_REFUSAL_REASONS.UNKNOWN_COMMAND,
        `/${name} is not a command; try /help`,
        { commands: CHAT_COMMANDS },
      );
    }
    const command: ChatCommand = parsed.kind === 'invalid' ? parsed.name : parsed.kind;

    try {
      const access = await this.access.evaluate(user, room);
      if (!access.isEligibleToView) {
        throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.ROOM_HIDDEN, 'You cannot use this room');
      }
      const facts = await this.access.factsFor(user);
      const settings = await this.settings.global();
      const refusal = await this.gate.refusal(user, facts, room, settings, command, dbNow);
      if (refusal) throw refusal;
      if (parsed.kind === 'invalid') {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          errors: [{ path: 'content', message: parsed.message }],
        });
      }
      await this.gate.assertStanding(user, command, room.id, dbNow);
      // The pace of mute, block, gift and ad actions, the same as over HTTP.
      await this.gate.limit(user, command, input.ip, settings);

      let result: unknown;
      let args: Record<string, unknown> = {};
      switch (parsed.kind) {
        case 'help':
          result = {
            commands: await this.available(user, facts, room, settings, dbNow),
          };
          break;
        case 'mute':
        case 'unmute':
        case 'block':
        case 'unblock': {
          const on = parsed.kind === 'mute' || parsed.kind === 'block';
          result = await this.relations.set(
            user,
            parsed.target,
            parsed.kind.endsWith('mute') ? 'mutes' : 'blocks',
            on,
          );
          args = { targetId: (result as { userId: string }).userId };
          break;
        }
        case 'mutelist':
          result = await this.relations.list(user, 'mutes', {});
          break;
        case 'blocklist':
          result = await this.relations.list(user, 'blocks', {});
          break;
        case 'dm': {
          const opened = await this.dms.openDirect(
            user,
            parsed.target,
            { content: parsed.text },
            input.ip,
          );
          result = {
            conversationId: opened.conversationId,
            otherUser: opened.otherUser,
            message: opened.message,
          };
          args = {
            targetId: opened.otherUser.id,
            conversationId: opened.conversationId,
          };
          break;
        }
        case 'send': {
          const gift = await this.gifts.start(user, {
            recipient: parsed.target,
            amount: parsed.amount,
            currency: parsed.currency,
            roomId: room.id,
          });
          result = gift;
          args = {
            giftId: gift.giftId,
            targetUsername: gift.recipient.username,
            amount: gift.amount,
            currency: gift.currency,
          };
          break;
        }
        case 'ad': {
          const ad = await this.ads.create(
            user,
            {
              content: parsed.text,
              // An /ad with no rooms goes to the room it was typed in.
              roomIds: parsed.allRooms
                ? []
                : parsed.roomIds.length > 0
                  ? parsed.roomIds
                  : [room.id],
              allRooms: parsed.allRooms,
              ...(parsed.pinMinutes !== undefined ? { pinMinutes: parsed.pinMinutes } : {}),
              ...(parsed.repeatCount !== undefined ? { repeatCount: parsed.repeatCount } : {}),
              ...(parsed.repeatGapMinutes !== undefined
                ? { repeatGapMinutes: parsed.repeatGapMinutes }
                : {}),
              ...(parsed.badgeId ? { badgeId: parsed.badgeId } : {}),
              ...(parsed.skinId ? { skinId: parsed.skinId } : {}),
              hiddenCountries: parsed.hiddenCountries,
            },
            input.ip,
            // The same typed message resent (a reconnect, a double tap) is the same purchase, never a second charge.
            input.clientMessageId ? `ad_${input.clientMessageId}` : null,
          );
          result = ad;
          args = { adId: ad.adId, priceUsd: ad.price.totalUsd };
          break;
        }
        case 'rain': {
          const pot = parseMinor(parsed.pot);
          if (pot === null) {
            throw new ProblemException({
              type: ERR.VALIDATION_FAILED,
              errors: [{ path: 'content', message: 'Use /rain CURRENCY AMOUNT RECIPIENTS, for example /rain BTC 0.01 5' }],
            });
          }
          result = await this.rain.executeUserCommand(user, {
            roomId: room.id,
            currency: parsed.currency,
            pot,
            recipients: parsed.recipients,
            repeatCount: parsed.repeatCount,
            repeatGapSeconds: parsed.repeatGapSeconds,
            // The same message resent (a reconnect, a double tap) is the same rain, never a second debit.
            clientMessageId: input.clientMessageId,
            ip: input.ip,
            context: input.context,
          });
          args = {
            rainId: (result as { rainId: string }).rainId,
            currency: parsed.currency,
            recipients: parsed.recipients,
          };
          break;
        }
      }
      log('EXECUTED', null, args);
      return { command, roomId: room.id, result };
    } catch (err: unknown) {
      const reason =
        err instanceof ProblemException ? String(err.extra?.reason ?? err.type) : 'error';
      log('REFUSED', reason.slice(0, 64));
      throw err;
    }
  }

  // /help: the commands this user may use in this room, with their usage.
  private async available(
    user: ChatUserContext,
    facts: EligibilityFacts,
    room: RoomRecord,
    settings: ChatSettings,
    dbNow: Date,
  ): Promise<{ command: ChatCommand; usage: string }[]> {
    const out: { command: ChatCommand; usage: string }[] = [];
    for (const command of CHAT_COMMANDS) {
      if ((await this.gate.refusal(user, facts, room, settings, command, dbNow)) === null) {
        out.push({ command, usage: COMMAND_HELP[command] });
      }
    }
    return out;
  }
}
