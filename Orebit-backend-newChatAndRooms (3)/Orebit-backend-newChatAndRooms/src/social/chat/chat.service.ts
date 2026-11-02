// Core message service: handles sending, history, retractions, pins, and room alerts.
import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import * as constants from './chat.constants';
import { ChatAccessService } from './chat.access.service';
import { ChatAccountService } from './services/chat.account.service';
import { chatMediaBase } from './chat.upload';
import { ChatBus } from './realtime/chat.bus';
import { ChatDbOperation } from './chat.dboperation';
import { ChatRecordsDbOperation } from './persistence/chat.records.dboperation';
import { assertPublicChatOpen } from './services/chat.availability';
import { ChatContentService } from './services/chat.content.service';
import { ChatModerationService, refuse } from './chat.moderation.service';
import { ChatPresenceService } from './chat.presence.service';
import type {
  ChatUserContext,
  MediaType,
  MessageMetadata,
  MessageRow,
  OnlineMember,
  RoomAccessEvaluation,
  RoomRecord,
} from './chat.types';
import * as utility from './chat.utility';
import { resolveSendSkin, taggedViewers } from './services/chat.send.helpers';
import { ChatStaffGate, type StaffRequested } from './services/chat.staff.gate';

export interface SendInput {
  roomRef: string | undefined;
  content?: string;
  media?: {
    url: string;
    type: MediaType;
    caption?: string;
    thumbnailUrl?: string;
  };
  skinId?: string;
  clientMessageId?: string;
}

// What the sender's connection already knows, so a send reads no preferences.
export interface SendContext {
  ip: string;
  hideIdentity?: boolean;
  activeSkinId?: string | null;
}

export interface SendResult {
  // The stored row; publish it through the gateway.
  row: MessageRow;
  room: RoomRecord;
  // Users tagged in the message who may view the room.
  taggedUserIds: string[];
  // True when a retried send matched an earlier one: ack it, broadcast nothing, count nothing.
  duplicate: boolean;
}

// The public view of a message for the room broadcast (kept in chat.utility.ts so delivery needs no service).
export const broadcastView = utility.broadcastView;

// Sends, retracts and reads chat messages. Delivery to open sockets is the gateway's job.
@Injectable()
export class ChatService {
  private readonly logger = new Logger('ChatService');
  // Messages accepted since the last maintenance tick, for the one-a-minute stats line.
  private sentThisMinute = 0;

  constructor(
    private readonly db: ChatDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly access: ChatAccessService,
    private readonly account: ChatAccountService,
    private readonly moderation: ChatModerationService,
    private readonly content: ChatContentService,
    private readonly presence: ChatPresenceService,
    private readonly bus: ChatBus,
    private readonly gate: ChatStaffGate,
  ) {}

  takeSentCount(): number {
    const n = this.sentThisMinute;
    this.sentThisMinute = 0;
    return n;
  }

  // Rooms
  // The rooms the user may see, paged, with the GIF provider the picker must use (NEW-3).
  async listRooms(
    user: ChatUserContext,
    limit: number = constants.PAGE.DEFAULT,
    cursor: string | null = null,
  ) {
    const [visible, settings] = await Promise.all([
      this.access.visibleRooms(user),
      this.access.settingsFor(user),
    ]);
    assertPublicChatOpen(settings, false);
    let start = 0;
    if (cursor) {
      const afterId = Buffer.from(cursor, 'base64url').toString('utf8');
      const index = visible.findIndex((entry) => entry.room.id === afterId);
      if (index < 0) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          errors: [{ path: 'cursor', message: 'Not a cursor this API returned' }],
        });
      }
      start = index + 1;
    }
    const page = visible.slice(start, start + limit);
    const last = page.at(-1);
    return {
      items: page.map(({ room, access }) => this.roomSummary(room, access, settings)),
      nextCursor:
        last && start + limit < visible.length
          ? Buffer.from(last.room.id, 'utf8').toString('base64url')
          : null,
      gifProvider: settings.media.gifProvider,
    };
  }

  private roomSummary(
    room: RoomRecord,
    access: RoomAccessEvaluation,
    settings: Awaited<ReturnType<ChatAccessService['settingsFor']>>,
  ) {
    return {
      id: room.id,
      slug: room.slug,
      name: room.name,
      description: room.description,
      type: room.type,
      // Only what the admin set; never a guess from the web name.
      language: room.config.language ?? null,
      contentControls: room.config.contentControls,
      accessMode: access.accessMode,
      isEligibleToView: access.isEligibleToView,
      isEligibleToWrite: access.isEligibleToWrite,
      ...(access.reason ? { reason: access.reason } : {}),
      ...(access.requirement ? { requirement: access.requirement } : {}),
      ...(access.casinoConditions ? { casinoConditions: access.casinoConditions } : {}),
      ...(access.maintenance ? { maintenance: access.maintenance } : {}),
      ...(room.type === 'CASINO'
        ? {
            casinoAutoSwitch: {
              enabled: settings.casino.autoSwitch,
              evenIfDmOpen: settings.casino.autoSwitchWhenDmOpen,
            },
          }
        : {}),
      onlineCount: this.presence.count(room.id),
      createdAt: room.createdAt.toISOString(),
    };
  }

  // The rules box; a room without rules returns [], never rules nobody approved.
  async rules(user: ChatUserContext, ref: string) {
    const { room } = await this.access.assertCanView(user, ref);
    return {
      roomId: room.id,
      roomSlug: room.slug,
      roomName: room.name,
      rules: room.config.rules,
    };
  }

  // Members on request only, with view access; promo-only viewers get the count only.
  async members(
    user: ChatUserContext,
    ref: string,
    query: { limit?: number; cursor?: string; prefix?: string },
  ) {
    const { room, access } = await this.access.assertCanView(user, ref);
    const page = this.presence.members(
      room.id,
      query.limit ?? constants.PAGE.DEFAULT,
      query.cursor ?? null,
      query.prefix ?? null,
    );
    if (!access.receivesUserMessages)
      return {
        roomId: room.id,
        count: page.count,
        items: [] as OnlineMember[],
        nextCursor: null,
      };
    return { roomId: room.id, ...page };
  }

  // Sending (one path for both transports)
  // retry lookup → one room read (with the database clock) → ban → limits → access → content → insert.
  async sendMessage(
    user: ChatUserContext,
    input: SendInput,
    context: SendContext,
  ): Promise<SendResult> {
    if (input.clientMessageId) {
      const earlier = await this.db.findClientMessage(user.id, input.clientMessageId);
      if (earlier) {
        const row = await this.db.messageById(earlier.messageId);
        if (row)
          return {
            row,
            room: await this.access.requireRoom(row.roomId),
            taggedUserIds: [],
            duplicate: true,
          };
      }
    }

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

    await this.moderation.assertNotBanned(user, room.id, dbNow);

    const facts = await this.access.factsFor(user);
    const settings = await this.access.settingsFor(user);
    assertPublicChatOpen(settings, true);
    const media = input.media ?? null;
    const access = await this.access.evaluate(user, room);
    if (!access.isEligibleToWrite) {
      throw refuse(
        ERR.FORBIDDEN,
        constants.CHAT_REFUSAL_REASONS.ROOM_READ_ONLY,
        access.reason ?? 'You cannot write in this room',
        {
          roomId: room.id,
          ...(access.requirement ? { requirement: access.requirement } : {}),
        },
      );
    }

    const text = utility.normalizeContent(
      media ? (input.media?.caption ?? input.content ?? '') : (input.content ?? ''),
    );
    if (media === null && text === '') {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'content', message: 'Message is empty' }],
      });
    }
    if (text.length > constants.LIMITS.MESSAGE_CHARS) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'content',
            message: `At most ${constants.LIMITS.MESSAGE_CHARS} characters`,
          },
        ],
      });
    }

    // Media is built here from validated fields only; no client value can relabel it.
    let mediaMeta: MessageMetadata['media'] | undefined;
    if (media) {
      const base = chatMediaBase();
      if (!utility.isAllowedMediaUrl(media.url, media.type, settings.media.gifProvider, base)) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          errors: [{ path: 'mediaUrl', message: 'Not an allowed media address' }],
        });
      }
      if (
        media.thumbnailUrl !== undefined &&
        !utility.isAllowedMediaUrl(media.thumbnailUrl, 'image', settings.media.gifProvider, base)
      ) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          errors: [{ path: 'thumbnailUrl', message: 'Not an allowed media address' }],
        });
      }
      mediaMeta = {
        type: media.type,
        url: media.url,
        ...(text ? { caption: text } : {}),
        ...(media.thumbnailUrl ? { thumbnailUrl: media.thumbnailUrl } : {}),
      };
    }

    await this.content.moderate({
      user,
      facts,
      room,
      settings,
      text,
      media: media?.type ?? null,
      dbNow,
    });

    // An explicit skin must be usable; a saved skin that no longer is is simply not applied.
    const skinId =
      settings.maintenance.skins === 'ACTIVE'
        ? await resolveSendSkin(this.db, this.account, user, facts, input.skinId, context)
        : null;
    const hideIdentity =
      context.hideIdentity !== undefined
        ? context.hideIdentity
        : (await this.db.preferences(user.id)).hideIdentity;

    const tagged = utility.extractTaggedUsernames(text).slice(0, constants.LIMITS.TAGS_PER_MESSAGE);
    const taggedUserIds = await taggedViewers(this.db, this.access, room, tagged, user.id);

    const metadata: MessageMetadata = {
      ...(mediaMeta ? { media: mediaMeta } : {}),
      ...(tagged.length > 0 ? { taggedUsernames: tagged } : {}),
      // The profile setting is stamped on the message, so it stays masked if the setting changes later.
      ...(hideIdentity ? { anonymous: true as const } : {}),
    };

    const mediaLease = await this.moderation.checkSendLimits(
      user,
      context.ip,
      dbNow,
      settings,
      media !== null,
    );
    let inserted: Awaited<ReturnType<ChatDbOperation['insertMessage']>>;
    try {
      inserted = await this.db.insertMessage({
        roomId: room.id,
        userId: user.id,
        content: text,
        type: media ? 'MEDIA' : 'TEXT',
        skinId,
        metadata,
        taggedUserIds,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      });
    } catch (err) {
      if (mediaLease) await this.moderation.releaseMediaCooldown(user.id, mediaLease);
      throw err;
    }
    const { row, duplicateOf } = inserted;
    if (duplicateOf) {
      if (mediaLease) await this.moderation.releaseMediaCooldown(user.id, mediaLease);
      return { row, room, taggedUserIds: [], duplicate: true };
    }

    this.sentThisMinute += 1;
    return { row, room, taggedUserIds, duplicate: false };
  }

  // Retract
  async retract(
    user: ChatUserContext,
    messageId: string,
    note: string | null,
    reportId?: string,
  ): Promise<{ messageId: string; roomId: string; retractedAt: string } | StaffRequested> {
    const message = await this.db.messageById(messageId);
    if (!message)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Message not found',
      });
    if (message.retractedAt) {
      throw refuse(
        ERR.FORBIDDEN,
        constants.CHAT_REFUSAL_REASONS.ALREADY_RETRACTED,
        'Already retracted',
        {},
        409,
      );
    }
    // Authors and staff retract only text and media. Ad and gift notices stand for a payment, and alerts are official:
    // they are removed only from the admin panel.
    if (message.type !== 'TEXT' && message.type !== 'MEDIA') {
      throw refuse(
        ERR.FORBIDDEN,
        constants.CHAT_REFUSAL_REASONS.NOT_RETRACTABLE,
        'This kind of message can be removed only from the admin panel',
      );
    }
    const isAuthor = message.userId === user.id;
    const staff = utility.isChatStaff(user.staffRole);
    if (!isAuthor && !user.staffRole) {
      throw refuse(
        ERR.FORBIDDEN,
        constants.CHAT_REFUSAL_REASONS.STAFF_ONLY,
        'You can retract only your own messages',
      );
    }
    // Someone else's message: the role permission "Delete Messages from chat" (Module 4).
    const deleteMode = isAuthor ? null : await this.gate.mode(user, 'DELETE_MESSAGES');
    // Staff may retract only messages of users ranked below them; alerts are the admin panel's.
    if (!isAuthor && message.userId !== constants.SYSTEM_AUTHOR_ID) {
      const author = await this.db.findChatUser(message.userId);
      const mine = constants.STAFF_RANK[user.staffRole ?? ''] ?? 0;
      const theirs = author?.staffRole ? (constants.STAFF_RANK[author.staffRole] ?? 0) : 0;
      if (theirs >= mine) {
        throw refuse(
          ERR.FORBIDDEN,
          constants.CHAT_REFUSAL_REASONS.TARGET_OUTRANKS_YOU,
          "You cannot retract this user's message",
        );
      }
    }

    if (deleteMode === 'REPORT') {
      return this.gate.report(user, 'DELETE_MESSAGES', {
        targetUserId: message.userId,
        targetRoomId: message.roomId,
        payload: { messageId, ...(reportId ? { reportId } : {}) },
        note: note ?? 'Please remove this message',
      });
    }

    const dbNow = await this.db.dbNow();
    if (isAuthor && !staff) {
      await this.moderation.assertNotBanned(user, message.roomId, dbNow);
      const window = (await this.access.settingsFor(user)).limits.retractWindowSeconds;
      if (window > 0 && dbNow.getTime() - message.createdAt.getTime() > window * 1000) {
        throw refuse(
          ERR.FORBIDDEN,
          constants.CHAT_REFUSAL_REASONS.RETRACT_WINDOW_PASSED,
          'Too late to retract this message',
        );
      }
    }

    const done = await this.db.retract(messageId, user.id);
    if (!done)
      throw refuse(
        ERR.FORBIDDEN,
        constants.CHAT_REFUSAL_REASONS.ALREADY_RETRACTED,
        'Already retracted',
        {},
        409,
      );

    if (!isAuthor || note) {
      await this.records.recordActionNow({
        actorType: 'STAFF',
        actorId: user.id,
        action: isAuthor ? 'author.retract' : 'staff.retract',
        targetUserId: message.userId,
        targetRoomId: done.roomId,
        targetMessageId: messageId,
        targetMessageCreatedAt: done.createdAt,
        note,
      });
    }
    if (!isAuthor && message.userId !== constants.SYSTEM_AUTHOR_ID) {
      // The note reaches only the author, on their own channel.
      this.bus.publish({
        kind: 'notice',
        userId: message.userId,
        notice: { action: 'retract', roomId: done.roomId, messageId, note },
      });
    }
    return {
      messageId,
      roomId: done.roomId,
      retractedAt: done.retractedAt.toISOString(),
    };
  }

  // System alerts (Chat MAIN "Chat Alerts")
  // An automated alert, posted by the system author. Only this and the admin broadcast create SYSTEM_ALERT /
// ADMIN_ALERT rows; a user send is always TEXT or MEDIA. Delivered through the gateway's publish. Posted under the
// chat bot profile when one is assigned (Chat SETTINGS "Chat Bot") and that account is live.
  async postSystemAlert(
    alertType:
      | 'CASINO_BIG_WIN'
      | 'CASINO_JACKPOT'
      | 'PREMIUM_PURCHASE'
      | 'LEVEL_UP'
      | 'LOTTERY_ANNOUNCEMENT'
      | 'LUCKY_WIN'
      | 'RAIN',
    text: string,
    roomRef: string = constants.GLOBAL_ROOM_ID,
    taggedUserIds: readonly string[] = [],
  ): Promise<MessageRow> {
    const room = await this.access.requireRoom(roomRef);
    const botId = (await this.gate.settings()).bot.profileUserId;
    const bot = botId ? await this.db.findChatUser(botId) : null;
    const { row } = await this.db.insertMessage({
      roomId: room.id,
      userId: constants.SYSTEM_AUTHOR_ID,
      content: utility.normalizeContent(text),
      type: 'SYSTEM_ALERT',
      skinId: null,
      metadata: {
        alertType,
        ...(bot ? { bot: { userId: bot.id, username: bot.username } } : {}),
      },
      taggedUserIds: [...new Set(taggedUserIds)],
    });
    this.bus.publish({ kind: 'alert', messageIds: [row.id] });
    return row;
  }
}
