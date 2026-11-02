// Personal chat messages (Module 8, Chat MAIN "Personal Chat"; groups reuse it in Module 9): opening a direct
// conversation, message requests, sending, history, read receipts and typing. Retract, pins, forwarding, reports and
// the gift button are in dm.actions.service.ts.
// Rules on every send: DMs on (Chat SETTINGS "ON / OFF / MAINTENANCE: DM"), no chat-wide ban, the shared send limits;
// direct: neither user blocked the other, "Restrict User From Sending DM to Random People (who don't follow them
// back)", and "Users cannot send links in their DM / PM message if they are not friends" (images, videos and GIFs
// too); group: "members can text" and timeouts. A new conversation counts toward "Rate Limit of Sending DMs to users
// with whom you never had chat".
// Every public method of the DM services starts with `assertOpen`: DMs OFF refuse everything, MAINTENANCE refuses
// writes, typing and read signals and still reads.
import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, GLOBAL_ROOM_ID, LIMITS, PAGE, SERVER_EVENTS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { ChatPorts } from '../chat.ports';
import { dmMissingValues } from '../chat.features.contract';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatContentService } from '../services/chat.content.service';
import { limitOf, newDmLimit, requireLimit } from './dm.limits';
import { ChatSettingsService } from '../chat.settings';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import type { ChatSettings } from '../chat.settings.contract';
import { assertAvailable } from '../services/chat.availability';
import { ChatBus } from '../realtime/chat.bus';
import { ChatDelivery } from '../realtime/chat.delivery';
import { chatMediaBase } from '../chat.upload';
import { ChatGiftsService } from '../services/chat.gifts.service';
import { ChatRelationsService } from '../services/chat.relations.service';
import { ChatRestrictionsService } from '../services/chat.restrictions.service';
import type { ChatUserContext, MediaType } from '../chat.types';
import * as utility from '../chat.utility';
import {
  DmDbOperation,
  type DmMessageRow,
  type DmMetadata,
  type MemberRow,
} from './dm.dboperation';
import { DmDeliveryService } from './dm.delivery.service';
import { DmMessagesDbOperation } from './dm.messages.dboperation';
import { DmGroupsDbOperation } from './dm.groups.dboperation';
import { DmInboxDbOperation } from './dm.inbox.dboperation';
import {
  directKey,
  directPlacement,
  GROUP_RANK,
  mayText,
} from './dm.rules';
import { toDmView, type DmMessageView } from './dm.view';

export interface DmSendInput {
  content?: string;
  media?: { url: string; type: MediaType; caption?: string; thumbnailUrl?: string };
  clientMessageId?: string;
}

@Injectable()
export class DmService {
  private readonly logger = new Logger(DmService.name);

  constructor(
    private readonly dm: DmDbOperation,
    private readonly messagesDb: DmMessagesDbOperation,
    private readonly inbox: DmInboxDbOperation,
    private readonly groups: DmGroupsDbOperation,
    private readonly db: ChatDbOperation,
    private readonly access: ChatAccessService,
    private readonly settingsService: ChatSettingsService,
    private readonly moderation: ChatModerationService,
    private readonly relations: ChatRelationsService,
    private readonly restrictions: ChatRestrictionsService,
    private readonly ports: ChatFeaturePorts,
    private readonly gifts: ChatGiftsService,
    private readonly delivery: ChatDelivery,
    private readonly records: ChatRecordsDbOperation,
    bus: ChatBus,
    private readonly chatPorts: ChatPorts,
    private readonly content: ChatContentService,
    private readonly notifier: DmDeliveryService,
  ) {
    // An admin hid a reported message: its members drop it from view.
    bus.subscribe((change) => {
      if (change.kind !== 'dm_hidden') return;
      return this.broadcast(change.conversationId, SERVER_EVENTS.DM_MESSAGE_HIDDEN, {
        conversationId: change.conversationId,
        messageId: change.messageId,
      });
    });
    // A completed gift from the DM gift button is posted into its conversation ("similar to Apple pay").
    this.gifts.registerDmPoster(async (gift, notice) => {
      if (!gift.conversationId) return;
      const { row } = await this.messagesDb.insertMessage({
        conversationId: gift.conversationId,
        senderId: gift.senderId,
        content: `Sent ${notice.amount} ${notice.currency}`,
        type: 'GIFT',
        metadata: { gift: notice },
      });
      void this.deliver(row).catch((err: unknown) =>
        this.logger.error({ err, conversationId: gift.conversationId, messageId: row.id }, 'DM message fan-out failed'),
      );
    });
  }

  // Shared checks
  async settings(): Promise<ChatSettings> {
    return this.settingsService.global();
  }

  // DMs OFF: nothing works. MAINTENANCE: reading works, writing (and typing and read signals) does not.
  assertOpen(settings: ChatSettings, write: boolean): void {
    assertAvailable(settings, 'chat', write);
    const status = settings.dm.status;
    if (status === 'ACTIVE') {
      // DM is on only while every value the admin has to set is set; a stored ACTIVE with a gap refuses all.
      const missing = dmMissingValues(settings.dm, settings.privacy);
      if (missing.length === 0) return;
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.DM_NOT_CONFIGURED,
        'Direct messages are not set up yet',
        { missing },
      );
    }
    if (status === 'MAINTENANCE' && !write) return;
    throw refuse(
      ERR.FORBIDDEN,
      CHAT_REFUSAL_REASONS.DM_UNAVAILABLE,
      status === 'MAINTENANCE'
        ? (settings.maintenance.note ?? 'Direct messages are under maintenance')
        : 'Direct messages are off',
      { status },
    );
  }

  // The guard of every DM service method: `write` = false for reads.
  async guard(write: boolean): Promise<ChatSettings> {
    const settings = await this.settings();
    this.assertOpen(settings, write);
    return settings;
  }

  // The user's membership; a conversation they are not in does not exist for them.
  async requireMember(
    userId: string,
    conversationId: string,
    states = ['ACTIVE', 'REQUEST'],
  ): Promise<MemberRow> {
    const member = await this.dm.member(conversationId, userId);
    if (!member || !states.includes(member.state)) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Conversation not found' });
    }
    return member;
  }

  private invalid(path: string, message: string): ProblemException {
    return new ProblemException({ type: ERR.VALIDATION_FAILED, errors: [{ path, message }] });
  }

  // Opening a direct conversation
  // The existing conversation with this user, or a new one placed by the folder rules; optionally with a message.
  async openDirect(
    user: ChatUserContext,
    handle: string,
    first: DmSendInput | null,
    ip: string,
    appId: string | null = null,
  ) {
    const settings = await this.guard(true);
    const otherId = await this.db.resolveUserHandle(handle);
    const other = otherId ? await this.db.findChatUser(otherId) : null;
    if (!other) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'User not found' });
    if (other.id === user.id) throw this.invalid('userId', 'You cannot message yourself');
    await this.relations.assertNotBlocked(user.id, other.id, 'You cannot message this user');

    // "SO / Merchants: … sorted separately by apps": a chat about one of a merchant's apps is its own conversation,
    // and only such a chat goes to the merchant's Merchant folder. A personal text to a site owner follows the normal
    // folders.
    if (appId) {
      if (!(await this.isMerchant(other)))
        throw this.invalid('appId', 'Only a chat with a merchant has an app');
      const apps = await this.chatPorts.merchantApps(other.id);
      if (apps && !apps.some((app) => app.id === appId))
        throw this.invalid('appId', 'This merchant has no such app');
    }
    const key = appId ? `${directKey(user.id, other.id)}:app:${appId}` : directKey(user.id, other.id);
    let conversationId = await this.dm.findDirect(key);
    let created = false;
    if (conversationId) {
      // the person who declined can start the chat again later; it becomes a normal two-way chat.
      const mine = await this.dm.member(conversationId, user.id);
      if (mine?.state === 'DECLINED') {
        await this.dm.updateMember(conversationId, user.id, { state: 'ACTIVE', folder: 'PRIMARY' });
      }
    } else {
      const dbNow = await this.dm.dbNow();
      await this.moderation.assertNotBanned(user, null, dbNow);
      const follow = (await this.ports.follows(user.id, [other.id])).get(other.id)!;
      await this.assertMayDmStranger(user, follow.followedBy, dbNow);
      const mine = directPlacement(true, follow);
      const theirs = appId
        ? ({ folder: 'MERCHANT', state: 'ACTIVE' } as const)
        : directPlacement(false, { following: follow.followedBy, followedBy: follow.following });
      // "Rate Limit of Sending DMs to users with whom you never had chat with (new DMs): X every Y Hours": counted
      // and created in one step, so parallel requests cannot pass the last free place.
      const made = await this.dm.createDirect({
        key,
        merchantAppId: appId,
        createdBy: user.id,
        // one limit when the other person follows the starter, another when they do not.
        limit: newDmLimit(settings, follow.followedBy),
        members: [
          { userId: user.id, folder: mine.folder, state: mine.state },
          { userId: other.id, folder: theirs.folder, state: theirs.state },
        ],
      });
      if ('limited' in made) {
        this.moderation.noteHit(user.id, 'new_dm_limit');
        throw new ProblemException({
          type: ERR.RATE_LIMITED,
          detail: `At most ${limitOf(settings, follow.followedBy).count} new conversations every ${limitOf(settings, follow.followedBy).hours} hours`,
          extra: {
            reason: CHAT_REFUSAL_REASONS.NEW_DM_LIMIT,
            remainingSeconds: made.limited.retryAfterSeconds,
          },
          retryAfterSeconds: made.limited.retryAfterSeconds,
        });
      }
      conversationId = made.id;
      created = made.created;
    }
    const message = first ? (await this.send(user, conversationId, first, ip)).message : null;
    return {
      conversationId,
      created,
      otherUser: { id: other.id, username: other.username },
      message,
    };
  }

  // the public chat's automatic checks on a group's message, name or description.
  async moderateGroupText(user: ChatUserContext, text: string, settings: ChatSettings, dbNow: Date): Promise<void> {
    if (text === '') return;
    const room = await this.access.findRoom(GLOBAL_ROOM_ID);
    await this.content.moderateGroupText({ user, room, settings, text, dbNow });
  }

  // "SO / Merchants": whether the user is a site owner (a chat can then be opened for one of their apps).
  private async isMerchant(user: ChatUserContext): Promise<boolean> {
    return (await this.access.factsFor(user)).isSiteOwner === true;
  }

  // RESTRICT_DM: DMs only to people who follow you back.
  private async assertMayDmStranger(
    user: ChatUserContext,
    followedBy: boolean,
    dbNow: Date,
  ): Promise<void> {
    if (followedBy) return;
    const facts = await this.access.factsFor(user);
    const found = await this.restrictions.find(user, facts, 'RESTRICT_DM', null, dbNow);
    if (found) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, found.reason, {
        restriction: 'RESTRICT_DM',
        expiresAt: found.expiresAt,
      });
    }
  }

  // Sending
  async send(
    user: ChatUserContext,
    conversationId: string,
    input: DmSendInput,
    ip: string,
    extra: { forwarded?: DmMetadata['forwarded'] } = {},
  ): Promise<{ message: DmMessageView; duplicate: boolean }> {
    const settings = await this.guard(true);
    // DECLINED is allowed in: the person who declined may write first later and the chat reopens.
    const me = await this.requireMember(user.id, conversationId, ['ACTIVE', 'REQUEST', 'DECLINED']);
    const dbNow = await this.dm.dbNow();
    await this.moderation.assertNotBanned(user, null, dbNow);

    const text = utility.normalizeContent(
      input.media ? (input.media.caption ?? input.content ?? '') : (input.content ?? ''),
    );
    if (!input.media && text === '') throw this.invalid('content', 'Message is empty');
    if (text.length > LIMITS.MESSAGE_CHARS)
      throw this.invalid('content', `At most ${LIMITS.MESSAGE_CHARS} characters`);
    const links = utility
      .findLinks(text)
      .map((link) => link.host)
      .filter((host) => host.length > 0);

    // What the sender's own member row becomes together with the message (accepting a request, reopening a chat).
    let memberUpdate:
      | { userId: string; state: 'ACTIVE'; folder: 'GENERAL' | 'PRIMARY' }
      | undefined;
    if (me.kind === 'DIRECT') {
      const other = (await this.dm.members(conversationId)).find((m) => m.userId !== user.id);
      if (!other)
        throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Conversation not found' });
      await this.relations.assertNotBlocked(user.id, other.userId, 'You cannot message this user');
      // the other person declined this request; nothing more can be sent until they write first.
      if (other.state === 'DECLINED') {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.DM_REQUEST_DECLINED,
          'This person declined your message request',
          {},
        );
      }
      const follow = (await this.ports.follows(user.id, [other.userId])).get(other.userId)!;
      // Links and media (images, videos, GIFs) are for friends only; forwarding comes through here too.
      if ((links.length > 0 || input.media) && !(follow.following && follow.followedBy)) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.LINKS_MEDIA_FRIENDS_ONLY,
          'Links and media are for friends only',
          {},
        );
      }
      // a stranger may send only x messages until the receiver accepts or replies; in a merchant / app chat
      // y messages until each reply. After that the normal limits apply.
      const appChat = other.folder === 'MERCHANT';
      if (other.state === 'REQUEST' || appChat) {
        const cap = requireLimit(
          appChat ? settings.dm.merchantMessageCap : settings.dm.strangerMessageCap,
          appChat ? 'dm.merchantMessageCap' : 'dm.strangerMessageCap',
        );
        if ((await this.messagesDb.messagesSinceReply(conversationId, user.id)) >= cap) {
          throw refuse(
            ERR.FORBIDDEN,
            CHAT_REFUSAL_REASONS.REQUEST_CAP_REACHED,
            'Wait for a reply before sending more',
            { max: cap },
          );
        }
      }
      // Replying to a request accepts it: "if a message request is accepted by user then it goes to general".
      if (me.state === 'REQUEST') memberUpdate = { userId: user.id, state: 'ACTIVE', folder: 'GENERAL' };
      else if (me.state === 'DECLINED')
        memberUpdate = { userId: user.id, state: 'ACTIVE', folder: 'PRIMARY' };
    } else {
      if (me.state !== 'ACTIVE')
        throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Conversation not found' });
      const group = await this.groups.group(conversationId);
      if (group?.closedAt) {
        throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.GROUP_CLOSED, 'This group is closed', {});
      }
      // in a channel only admins post.
      if (group?.isChannel && GROUP_RANK[me.role] < GROUP_RANK.ADMIN) {
        throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.CHANNEL_ADMINS_ONLY, 'Only admins post in a channel', {});
      }
      // a public group's messages get the same auto-moderation as public chat.
      if (group?.visibility === 'PUBLIC') await this.moderateGroupText(user, text, settings, dbNow);
      if (!group || !mayText(me.role, group.membersCanText, me.timeoutUntil, dbNow)) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.GROUP_TEXT_OFF,
          'You cannot text in this group right now',
          { timeoutUntil: me.timeoutUntil?.toISOString() ?? null },
        );
      }
    }

    let media: DmMetadata['media'];
    if (input.media) {
      const provider = (await this.access.settingsFor(user)).media.gifProvider;
      const base = chatMediaBase();
      if (!utility.isAllowedMediaUrl(input.media.url, input.media.type, provider, base)) {
        throw this.invalid('mediaUrl', 'Not an allowed media address');
      }
      if (
        input.media.thumbnailUrl &&
        !utility.isAllowedMediaUrl(input.media.thumbnailUrl, 'image', provider, base)
      ) {
        throw this.invalid('thumbnailUrl', 'Not an allowed media address');
      }
      media = {
        type: input.media.type,
        url: input.media.url,
        ...(text ? { caption: text } : {}),
        ...(input.media.thumbnailUrl ? { thumbnailUrl: input.media.thumbnailUrl } : {}),
      };
    }
    await this.moderation.checkSendLimits(
      user,
      ip,
      dbNow,
      await this.access.settingsFor(user),
      Boolean(media),
    );

    const { row, duplicate } = await this.messagesDb.insertMessage({
      conversationId,
      senderId: user.id,
      content: text,
      type: media ? 'MEDIA' : 'TEXT',
      metadata: {
        ...(media ? { media } : {}),
        ...(links.length > 0 ? { links: links.slice(0, 20) } : {}),
        ...(extra.forwarded ? { forwarded: extra.forwarded } : {}),
      },
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      ...(memberUpdate ? { memberUpdate } : {}),
    });
    if (!duplicate) {
      if (media) this.moderation.recordMediaSent(user.id, dbNow);
      void this.deliver(row).catch((err: unknown) =>
        this.logger.error({ err, conversationId, messageId: row.id }, 'DM message fan-out failed'),
      );
    }
    return { message: toDmView(row, user.id), duplicate };
  }

  // Sends a stored message to every member who may receive it (DmDeliveryService).
  deliver(row: DmMessageRow): Promise<void> {
    return this.notifier.deliver(row);
  }

  // A message that changed in place (a membership notice that grew): every member gets the new version.
  deliverUpdate(row: DmMessageRow): Promise<void> {
    return this.notifier.deliverUpdate(row);
  }

  // Reading
  async history(
    user: ChatUserContext,
    conversationId: string,
    query: { limit?: number; cursor?: string },
  ) {
    await this.guard(false);
    const me = await this.requireMember(user.id, conversationId);
    const limit = query.limit ?? PAGE.DEFAULT;
    // Group members see the group from the time they joined.
    const since = me.kind === 'GROUP' ? me.joinedAt : null;
    const rows = await this.messagesDb.history(
      conversationId,
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
      since,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      conversationId,
      items: page.map((row) => toDmView(row, user.id)),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
      // Months older than this are in the archive: a client that reaches it says so instead of looking empty.
      archivedBefore: rows.length <= limit ? await this.messagesDb.archivedBefore() : null,
    };
  }

  // Requests
  async respondToRequest(user: ChatUserContext, conversationId: string, accept: boolean) {
    await this.guard(true);
    const me = await this.requireMember(user.id, conversationId, ['REQUEST']);
    await this.dm.updateMember(
      conversationId,
      user.id,
      accept ? { state: 'ACTIVE', folder: 'GENERAL' } : { state: 'DECLINED' },
    );
    this.delivery.toUser(user.id, SERVER_EVENTS.DM_CONVERSATION_UPDATED, {
      conversationId,
      state: accept ? 'ACTIVE' : 'DECLINED',
      folder: accept ? 'GENERAL' : null,
    });
    return {
      conversationId,
      kind: me.kind,
      state: accept ? 'ACTIVE' : 'DECLINED',
      folder: accept ? 'GENERAL' : null,
    };
  }

  // Any event to every active member.
  broadcast(conversationId: string, event: string, payload: unknown): Promise<void> {
    return this.notifier.broadcast(conversationId, event, payload);
  }
}
