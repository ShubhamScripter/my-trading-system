// The personal-chat inbox (Modules 8–9, Chat MAIN "Personal Chat will have 4 Tabs", Chat DM Settings): folders and
// requests, moving people between Primary and General, pinned people, nicknames, per-conversation and folder
// notifications with quiet mode, last-seen and common-group privacy, search, and the shared links and media.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, PAGE, SERVER_EVENTS } from '../chat.constants';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { ChatPorts } from '../chat.ports';
import { refuse } from '../chat.moderation.service';
import { ChatPresenceService } from '../chat.presence.service';
import type { VisibilityChoice } from '../chat.features.contract';
import { ChatDelivery } from '../realtime/chat.delivery';
import type { ChatUserContext } from '../chat.types';
import * as utility from '../chat.utility';
import { DmDbOperation } from './dm.dboperation';
import { DmMessagesDbOperation } from './dm.messages.dboperation';
import { DmGroupsDbOperation } from './dm.groups.dboperation';
import {
  DmInboxDbOperation,
  type ConversationListRow,
  type StoredPrefs,
} from './dm.inbox.dboperation';
import {
  mayDo,
  visibleTo,
  type DmFolder,
} from './dm.rules';
import { requireLimit } from './dm.limits';
import { ChatRelationsService } from '../services/chat.relations.service';
import { signMediaUrl } from '../chat.upload';
import { DmService } from './dm.service';
import { toDmView } from './dm.view';

export type InboxFolder = DmFolder | 'REQUESTS' | 'CHANNELS';

@Injectable()
export class DmInboxService {
  constructor(
    private readonly dm: DmDbOperation,
    private readonly messagesDb: DmMessagesDbOperation,
    private readonly inbox: DmInboxDbOperation,
    private readonly groups: DmGroupsDbOperation,
    private readonly db: ChatDbOperation,
    private readonly ports: ChatFeaturePorts,
    private readonly presence: ChatPresenceService,
    private readonly delivery: ChatDelivery,
    private readonly messages: DmService,
    private readonly chatPorts: ChatPorts,
    private readonly relations: ChatRelationsService,
  ) {}

  private invalid(path: string, message: string): ProblemException {
    return new ProblemException({ type: ERR.VALIDATION_FAILED, errors: [{ path, message }] });
  }

  // App names of the merchants in these rows, from the merchant module (the id stands in when it cannot tell).
  private async appNames(viewerId: string, rows: ConversationListRow[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const merchants = new Set<string>();
    for (const row of rows) {
      if (!row.merchantAppId) continue;
      const merchant = row.folder === 'MERCHANT' ? viewerId : row.otherUserId;
      if (merchant) merchants.add(merchant);
    }
    const lists = await Promise.all(
      [...merchants].map((merchant) => this.chatPorts.merchantApps(merchant).catch(() => null)),
    );
    for (const list of lists) for (const app of list ?? []) names.set(app.id, app.name);
    return names;
  }

  // Chat MAIN "SO / Merchants: … sorted separately by apps": the merchant folder per app.
  async merchantApps(user: ChatUserContext) {
    await this.messages.guard(false);
    const [rows, apps] = await Promise.all([this.inbox.merchantApps(user.id), this.chatPorts.merchantApps(user.id)]);
    const names = new Map((apps ?? []).map((app) => [app.id, app.name]));
    return {
      apps: rows.map((row) => ({
        appId: row.appId,
        name: row.appId === null ? null : (names.get(row.appId) ?? row.appId),
        conversations: row.conversations,
        unread: row.unread,
      })),
    };
  }

  // Online and last seen of each user as `viewerId` may see them ("which can be hidden ( privacy settings )").
  async presenceFor(viewerId: string, userIds: readonly string[]) {
    const ids = [...new Set(userIds)].filter((id) => id !== viewerId);
    const settings = await this.messages.settings();
    const [prefs, follows] = await Promise.all([
      this.inbox.prefs(ids),
      this.ports.follows(viewerId, ids),
    ]);
    const out = new Map<string, { online: boolean; lastSeenAt: string | null } | null>();
    for (const id of ids) {
      const stored: StoredPrefs | undefined = prefs.get(id);
      const choice =
        // DM cannot be ACTIVE without the admin's default; until then nothing is shown.
        (stored?.lastSeenVisibility as VisibilityChoice | null) ?? settings.privacy.lastSeenDefault ?? 'NOBODY';
      const follow = follows.get(id);
      const friend = Boolean(follow?.following && follow.followedBy);
      out.set(
        id,
        visibleTo(choice, false, friend)
          ? {
              online: this.presence.isOnline(id),
              lastSeenAt: stored?.lastSeenAt?.toISOString() ?? null,
            }
          : null,
      );
    }
    return out;
  }

  private async views(userId: string, rows: ConversationListRow[]) {
    const presence = await this.presenceFor(
      userId,
      rows.map((r) => r.otherUserId).filter((id): id is string => id !== null),
    );
    const appNames = await this.appNames(userId, rows);
    return rows.map((row) => ({
      id: row.conversationId,
      kind: row.kind,
      folder: row.state === 'REQUEST' ? 'REQUESTS' : row.folder,
      merchantApp: row.merchantAppId
        ? { id: row.merchantAppId, name: appNames.get(row.merchantAppId) ?? row.merchantAppId }
        : null,
      isPinned: row.pinnedAt !== null,
      notifications: row.notifications,
      unread: row.unread,
      lastActivityAt: row.sortAt.toISOString(),
      lastMessage: row.lastMessage ? toDmView(row.lastMessage, userId) : null,
      ...(row.kind === 'DIRECT'
        ? {
            user: {
              id: row.otherUserId,
              username: row.otherUsername,
              nickname: row.nickname,
              presence: row.otherUserId ? (presence.get(row.otherUserId) ?? null) : null,
              // Read receipts: the other member's read position.
              lastReadMessageId: row.otherLastReadMessageId,
            },
          }
        : {
            group: {
              name: row.groupName,
              logoUrl: row.groupLogoUrl ? signMediaUrl(row.groupLogoUrl) : null,
              visibility: row.groupVisibility,
              memberCount: row.memberCount,
            },
          }),
    }));
  }

  // One tab: Primary, General, Groups, Channels or Requests. Pinned people come first on the first page.
  async conversations(
    user: ChatUserContext,
    query: { folder?: string; limit?: number; cursor?: string; appId?: string },
  ) {
    await this.messages.guard(false);
    const folder = (query.folder ?? 'PRIMARY').toUpperCase() as InboxFolder;
    if (!['PRIMARY', 'GENERAL', 'GROUPS', 'MERCHANT', 'CHANNELS', 'REQUESTS'].includes(folder)) {
      throw this.invalid('folder', 'PRIMARY, GENERAL, GROUPS, MERCHANT, CHANNELS or REQUESTS');
    }
    // "sorted separately by apps": one app of the merchant folder.
    const appId = folder === 'MERCHANT' && query.appId ? query.appId : null;
    const limit = query.limit ?? PAGE.DEFAULT;
    const cursor = query.cursor ? utility.decodeCursor(query.cursor) : null;
    const pinned =
      !cursor && folder !== 'REQUESTS'
        ? await this.inbox.conversations(user.id, folder, 100, null, true, appId)
        : [];
    const rows = await this.inbox.conversations(user.id, folder, limit, cursor, false, appId);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      folder,
      pinned: await this.views(user.id, pinned.slice(0, 100)),
      items: await this.views(user.id, page),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.sortAtText, id: last.conversationId })
          : null,
    };
  }

  async unread(user: ChatUserContext) {
    await this.messages.guard(false);
    const counts = await this.inbox.unreadSummary(user.id);
    return {
      primary: counts.PRIMARY ?? 0,
      general: counts.GENERAL ?? 0,
      groups: counts.GROUPS ?? 0,
      merchant: counts.MERCHANT ?? 0,
      channels: counts.CHANNELS ?? 0,
      requests: counts.REQUESTS ?? 0,
    };
  }

  // One conversation: my settings, the group, and the members with presence. A direct conversation has its two
// members; a group returns only the count and the caller's own row, never the group: the members are
// GET .../members?cursor=. A member's timeout is shown to group admins and to that member only.
  async conversation(user: ChatUserContext, conversationId: string) {
    await this.messages.guard(false);
    const me = await this.messages.requireMember(user.id, conversationId);
    const group = me.kind === 'GROUP' ? await this.groups.group(conversationId) : null;
    let members: unknown[];
    let memberCount: number;
    if (me.kind === 'GROUP') {
      // A group's detail is constant in size: the count and the caller's own row. The members come page by
      // page from GET .../members, with their timeouts shown only to admins and to the member themself.
      members = [
        {
          userId: user.id,
          username: user.username,
          role: me.role,
          state: me.state,
          lastReadMessageId: me.lastReadMessageId,
          timeoutUntil: me.timeoutUntil?.toISOString() ?? null,
          presence: null,
        },
      ];
      memberCount = group?.memberCount ?? 0;
    } else {
      const direct = await this.dm.members(conversationId, ['ACTIVE', 'REQUEST']);
      const presence = await this.presenceFor(
        user.id,
        direct.map((m) => m.userId),
      );
      members = direct.map((m) => ({
        userId: m.userId,
        username: m.username,
        role: m.role,
        state: m.state,
        lastReadMessageId: m.lastReadMessageId,
        timeoutUntil: null,
        presence: m.userId === user.id ? null : (presence.get(m.userId) ?? null),
      }));
      memberCount = direct.length;
    }
    return {
      id: conversationId,
      kind: me.kind,
      me: {
        userId: user.id,
        role: me.role,
        state: me.state,
        folder: me.state === 'REQUEST' ? 'REQUESTS' : me.folder,
        isPinned: me.pinnedAt !== null,
        nickname: me.nickname,
        notifications: me.notifications,
        timeoutUntil: me.timeoutUntil?.toISOString() ?? null,
        lastReadMessageId: me.lastReadMessageId,
      },
      members,
      memberCount,
      group: group
        ? {
            name: group.name,
            description: group.description,
            logoUrl: group.logoUrl ? signMediaUrl(group.logoUrl) : null,
            visibility: group.visibility,
            ownerId: group.ownerId,
            ownerUsername: (await this.dm.members(conversationId)).find((m) => m.role === 'OWNER')?.username ?? null,
            membersCanText: group.membersCanText,
            permissions: group.permissions,
            adminManageable: group.adminManageable,
            isClosed: group.closedAt !== null,
            isChannel: group.isChannel,
          }
        : null,
    };
  }

  // One page of a group's members, oldest first. A row has the username, role and presence; the timeout only
// for group admins and for the member themself. The page size is capped at PAGE.MAX.
  async groupMembers(
    user: ChatUserContext,
    groupId: string,
    query: { limit?: number; cursor?: string },
  ) {
    const settings = await this.messages.guard(false);
    const me = await this.messages.requireMember(user.id, groupId);
    if (me.kind !== 'GROUP') throw this.invalid('groupId', 'Not a group');
    const group = await this.groups.group(groupId);
    const limit = Math.min(query.limit ?? PAGE.DEFAULT, PAGE.MAX);
    const after = query.cursor ? utility.decodeCursor(query.cursor) : null;
    const page = await this.dm.memberPage(
      groupId,
      limit,
      after ? { joinedAt: after.createdAt, userId: after.id } : null,
    );
    const seesTimeouts =
      group !== null &&
      mayDo(me.role, 'TIMEOUT', group.permissions, settings.groups.delegablePermissions);
    const presence = await this.presenceFor(
      user.id,
      page.rows.map((m) => m.userId),
    );
    return {
      groupId,
      memberCount: group?.memberCount ?? (await this.groups.memberCount(groupId)),
      items: page.rows.map((m) => ({
        username: m.username,
        role: m.role,
        state: m.state,
        lastReadMessageId: m.userId === user.id ? m.lastReadMessageId : null,
        timeoutUntil:
          seesTimeouts || m.userId === user.id ? (m.timeoutUntil?.toISOString() ?? null) : null,
        presence: m.userId === user.id ? null : (presence.get(m.userId) ?? null),
      })),
      nextCursor: page.nextAfter
        ? utility.encodeCursor({ createdAt: page.nextAfter.joinedAt, id: page.nextAfter.userId })
        : null,
    };
  }

  private updated(userId: string, conversationId: string, change: Record<string, unknown>): void {
    this.delivery.toUser(userId, SERVER_EVENTS.DM_CONVERSATION_UPDATED, {
      conversationId,
      ...change,
    });
  }

  // "User can switch friends onto general or primary".
  async moveFolder(user: ChatUserContext, conversationId: string, folder: string) {
    await this.messages.guard(true);
    const me = await this.messages.requireMember(user.id, conversationId, ['ACTIVE']);
    if (me.kind !== 'DIRECT')
      throw this.invalid('conversationId', 'Only direct conversations move between folders');
    if (me.folder === 'MERCHANT')
      throw this.invalid('conversationId', 'Merchant chats stay in the Merchant folder');
    if (folder !== 'PRIMARY' && folder !== 'GENERAL')
      throw this.invalid('folder', 'PRIMARY or GENERAL');
    // A pinned person stays pinned only within their folder's limit; moving unpins.
    await this.dm.updateMember(conversationId, user.id, {
      folder,
      folderChosen: true,
      pinned: false,
    });
    this.updated(user.id, conversationId, { folder, isPinned: false });
    return { conversationId, folder };
  }

  // "Users can Pin People in their DM (in each folder)", up to "Maximum Number of Pinned People".
  async pinPerson(user: ChatUserContext, conversationId: string, pinned: boolean) {
    const settings = await this.messages.guard(true);
    const me = await this.messages.requireMember(user.id, conversationId, ['ACTIVE']);
    if (pinned && me.pinnedAt === null) {
      const max = requireLimit(settings.dm.maxPinnedPeople, 'dm.maxPinnedPeople');
      if ((await this.dm.pinnedPeople(user.id, me.folder)) >= max) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.LIMIT_REACHED,
          `At most ${max} pinned in this folder`,
          { max },
        );
      }
    }
    await this.dm.updateMember(conversationId, user.id, { pinned });
    this.updated(user.id, conversationId, { isPinned: pinned });
    return { conversationId, isPinned: pinned };
  }

  // "Users can add Nickname to their friends in DM (only for friends)".
  async setNickname(user: ChatUserContext, conversationId: string, nickname: string | null) {
    await this.messages.guard(true);
    const me = await this.messages.requireMember(user.id, conversationId, ['ACTIVE']);
    if (me.kind !== 'DIRECT')
      throw this.invalid('conversationId', 'Nicknames are for direct conversations');
    const value = nickname?.trim() ?? null;
    if (value !== null && (value.length < 1 || value.length > 32))
      throw this.invalid('nickname', '1 to 32 characters');
    if (value !== null) {
      const other = (await this.dm.members(conversationId)).find((m) => m.userId !== user.id);
      if (!other || !(await this.ports.areFriends(user.id, other.userId))) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.FRIENDS_ONLY,
          'Nicknames are for friends only',
        );
      }
    }
    await this.dm.updateMember(conversationId, user.id, { nickname: value });
    this.updated(user.id, conversationId, { nickname: value });
    return { conversationId, nickname: value };
  }

  // "Notification Preferences: Inbox wise": DEFAULT follows the folder setting.
  async setNotifications(user: ChatUserContext, conversationId: string, mode: string) {
    await this.messages.guard(true);
    await this.messages.requireMember(user.id, conversationId);
    if (!['DEFAULT', 'ON', 'OFF'].includes(mode))
      throw this.invalid('notifications', 'DEFAULT, ON or OFF');
    await this.dm.updateMember(conversationId, user.id, {
      notifications: mode as 'DEFAULT' | 'ON' | 'OFF',
    });
    this.updated(user.id, conversationId, { notifications: mode });
    return { conversationId, notifications: mode };
  }

  // Search, shared items, common groups
  async search(
    user: ChatUserContext,
    query: { q: string; conversationId?: string; limit?: number; cursor?: string },
  ) {
    await this.messages.guard(false);
    const text = (query.q ?? '').trim();
    if (text.length < 2 || text.length > 100) throw this.invalid('q', '2 to 100 characters');
    if (query.conversationId) await this.messages.requireMember(user.id, query.conversationId);
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.messagesDb.search(
      user.id,
      text,
      query.conversationId ?? null,
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toDmView(row, user.id)),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
    };
  }

  async shared(
    user: ChatUserContext,
    conversationId: string,
    query: { kind?: string; limit?: number; cursor?: string },
  ) {
    await this.messages.guard(false);
    const me = await this.messages.requireMember(user.id, conversationId);
    const kind = query.kind === 'links' ? 'links' : 'media';
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.messagesDb.shared(
      conversationId,
      kind,
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
      me.kind === 'GROUP' ? me.joinedAt : null,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      conversationId,
      kind,
      items: page.map((row) => {
        const view = toDmView(row, user.id);
        return {
          messageId: row.id,
          senderId: row.senderId,
          createdAt: view.createdAt,
          ...(kind === 'media'
            ? { media: view.media }
            : { links: row.metadata.links ?? [], content: view.content }),
        };
      }),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
    };
  }
}
