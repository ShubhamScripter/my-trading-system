// Running a group (Module 9, Chat MAIN "Users can create groups…", Chat DM Settings): roles ("Max Group Admins /
// Sub-Admins"), removing members, "Timeout User", "Ban User (for public groups)", "Delete Messages (only deleted on
// user end)" and "Group Admin can transfer ownership to other user". Handing a group over asks no code.
// Every action that checks a number and then changes it goes through a locked transaction in DmGroupsDbOperation.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, PAGE, SERVER_EVENTS } from '../chat.constants';
import { refuse } from '../chat.moderation.service';
import { ChatDelivery } from '../realtime/chat.delivery';
import type { ChatUserContext } from '../chat.types';
import * as utility from '../chat.utility';
import { DmDbOperation } from './dm.dboperation';
import { DmMessagesDbOperation } from './dm.messages.dboperation';
import { DmGroupsDbOperation } from './dm.groups.dboperation';
import { DmGroupBansDbOperation } from './dm.group-bans.dboperation';
import { DmGroupsService } from './dm.groups.service';
import { outranks, type GroupRole } from './dm.rules';
import { requireLimit } from './dm.limits';
import { DmService } from './dm.service';

@Injectable()
export class DmGroupsModerationService {
  constructor(
    private readonly base: DmGroupsService,
    private readonly dm: DmDbOperation,
    private readonly messagesDb: DmMessagesDbOperation,
    private readonly groups: DmGroupsDbOperation,
    private readonly bansDb: DmGroupBansDbOperation,
    private readonly delivery: ChatDelivery,
    private readonly messages: DmService,
  ) {}

  // Roles and moderation
  // Owner names admins and sub-admins; admins name sub-admins. "Max Group Admins / Sub-Admins: x (can be set infinite)".
  async setRole(user: ChatUserContext, groupId: string, userId: string, role: GroupRole) {
    const settings = await this.base.open(true);
    const { group, me } = await this.base.context(user, groupId);
    if (role === 'OWNER') throw this.base.invalid('role', 'Ownership moves only by transfer');
    const target = await this.base.target(groupId, me, userId);
    if (!outranks(me.role, role)) throw this.base.denied('You may only give roles below your own');
    const max =
      role === 'ADMIN'
        ? group.isChannel
          ? // a channel has its own, admin-set number of admins; unset refuses.
            requireLimit(settings.groups.maxChannelAdmins, 'groups.maxChannelAdmins')
          : settings.groups.maxAdmins
        : role === 'SUB_ADMIN'
          ? settings.groups.maxSubAdmins
          : null;
    // The cap is counted under the group lock, so two promotions at the last free place cannot both pass.
    const change = await this.groups.setRoleLocked(groupId, target.userId, role, target.role === role ? null : max);
    if (!change.ok) {
      if (change.reason === 'role_cap') {
        throw this.base.limit(`At most ${max} ${role === 'ADMIN' ? 'admins' : 'sub-admins'}`, { max });
      }
      throw refuse(ERR.NOT_FOUND, CHAT_REFUSAL_REASONS.GROUP_CLOSED, 'Group not found');
    }
    await this.base.event(groupId, user.id, 'role', target.userId, role);
    return { groupId, userId: target.userId, role };
  }

  async remove(user: ChatUserContext, groupId: string, userId: string) {
    const settings = await this.base.open(true);
    const { group, me } = await this.base.context(user, groupId);
    this.base.assertMay(settings, group, me, 'REMOVE_PEOPLE');
    const target = await this.base.target(groupId, me, userId);
    await this.dm.updateMember(groupId, target.userId, { state: 'REMOVED', pinned: false });
    await this.base.event(groupId, user.id, 'removed', target.userId);
    this.delivery.toUser(target.userId, SERVER_EVENTS.DM_CONVERSATION_UPDATED, {
      conversationId: groupId,
      state: 'REMOVED',
    });
    return { groupId, userId: target.userId, removed: true };
  }

  // "Timeout User (They cannot text)"; `minutes` null ends it.
  async timeout(user: ChatUserContext, groupId: string, userId: string, minutes: number | null) {
    const settings = await this.base.open(true);
    const { group, me } = await this.base.context(user, groupId);
    this.base.assertMay(settings, group, me, 'TIMEOUT');
    const target = await this.base.target(groupId, me, userId);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 60 * 24 * 30)) {
      throw this.base.invalid('minutes', 'From 1 minute to 30 days, or null to end it');
    }
    await this.dm.updateMember(groupId, target.userId, { timeoutMinutes: minutes });
    await this.base.event(
      groupId,
      user.id,
      minutes === null ? 'timeout_ended' : 'timeout',
      target.userId,
      minutes === null ? undefined : String(minutes),
    );
    return { groupId, userId: target.userId, timeoutMinutes: minutes };
  }

  // "Ban User (for public groups)". A person who is in the group must be below the actor; one who already left or was
// removed can be banned as well. A ban can be lifted only by someone whose role is not below the one that
// set it.
  async ban(
    user: ChatUserContext,
    groupId: string,
    userId: string,
    reason: string | null,
    banned: boolean,
  ) {
    const settings = await this.base.open(true);
    const { group, me } = await this.base.context(user, groupId);
    this.base.assertMay(settings, group, me, 'BAN');
    if (group.visibility !== 'PUBLIC')
      throw this.base.invalid('groupId', 'Bans are for public groups; remove the member instead');
    const targetId = (await this.base.resolveUser(userId)) ?? userId;
    if (!banned) {
      const result = await this.bansDb.unban(groupId, targetId, me.role, user.id);
      if (result === 'not_banned') {
        throw refuse(ERR.NOT_FOUND, CHAT_REFUSAL_REASONS.NOT_A_MEMBER, 'This person is not banned');
      }
      if (result === 'outranked') {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.TARGET_OUTRANKS_YOU,
          'This ban was set by a higher role',
        );
      }
      return { groupId, userId: targetId, banned: false };
    }
    const existing = await this.dm.member(groupId, targetId);
    if (existing?.state === 'ACTIVE') await this.base.target(groupId, me, targetId);
    else if (existing && !outranks(me.role, existing.role)) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.TARGET_OUTRANKS_YOU, 'You cannot act on this member');
    }
    await this.bansDb.banMember(groupId, targetId, { userId: user.id, role: me.role }, reason);
    await this.base.event(groupId, user.id, 'banned', targetId);
    this.delivery.toUser(targetId, SERVER_EVENTS.DM_CONVERSATION_UPDATED, {
      conversationId: groupId,
      state: 'BANNED',
    });
    return { groupId, userId: targetId, banned: true };
  }

  // "Group admins get a paged list of banned members": visible to those who may ban.
  async bans(user: ChatUserContext, groupId: string, query: { limit?: number; cursor?: string }) {
    const settings = await this.base.open(false);
    const { group, me } = await this.base.context(user, groupId);
    this.base.assertMay(settings, group, me, 'BAN');
    const limit = Math.min(query.limit ?? PAGE.DEFAULT, PAGE.MAX);
    const after = query.cursor ? utility.decodeCursor(query.cursor) : null;
    const page = await this.bansDb.bannedPage(
      groupId,
      limit,
      after ? { createdAt: after.createdAt, userId: after.id } : null,
    );
    return {
      items: page.rows.map((b) => ({
        username: b.username,
        reason: b.reason,
        bannedByRole: b.banned_by_role,
        bannedAt: b.created_at_text,
      })),
      nextCursor: page.nextAfter
        ? utility.encodeCursor({ createdAt: page.nextAfter.createdAt, id: page.nextAfter.userId })
        : null,
    };
  }

  // "Delete Messages (only deleted on user end)": hidden from members; admins keep it in the panel.
  async deleteMessage(user: ChatUserContext, groupId: string, messageId: string) {
    const settings = await this.base.open(true);
    const { group, me } = await this.base.context(user, groupId);
    const message = await this.messagesDb.messageById(messageId);
    if (!message || message.conversationId !== groupId)
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Message not found' });
    if (message.senderId !== user.id) {
      this.base.assertMay(settings, group, me, 'DELETE_MESSAGES');
      const sender = await this.dm.member(groupId, message.senderId);
      if (sender && !outranks(me.role, sender.role)) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.TARGET_OUTRANKS_YOU,
          "You cannot delete this member's message",
        );
      }
    }
    if (!(await this.messagesDb.hide(messageId, user.id))) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_RETRACTED,
        'Already deleted',
        {},
        409,
      );
    }
    await this.messages.broadcast(groupId, SERVER_EVENTS.DM_MESSAGE_HIDDEN, {
      conversationId: groupId,
      messageId,
    });
    return { groupId, messageId, hidden: true };
  }

  // Ownership transfer
  // "Group Admin can transfer ownership to other user", "X Times in y Hours". It happens at once and asks no code
// ; the checks and the swap are one locked transaction.
  async startTransfer(user: ChatUserContext, groupId: string, userId: string) {
    const settings = await this.base.open(true);
    const { me } = await this.base.context(user, groupId);
    if (me.role !== 'OWNER') throw this.base.denied('Only the owner transfers ownership');
    const targetId = (await this.base.resolveUser(userId)) ?? userId;
    const result = await this.groups.transferOwnership(groupId, user.id, targetId, {
      count: settings.groups.transfersPerWindow,
      windowHours: settings.groups.transferWindowHours,
    });
    if (!result.ok) {
      if (result.reason === 'limit') {
        throw this.base.limit(
          `Ownership can move ${settings.groups.transfersPerWindow} times every ${settings.groups.transferWindowHours} hours`,
          {
            max: settings.groups.transfersPerWindow,
            windowHours: settings.groups.transferWindowHours,
          },
        );
      }
      if (result.reason === 'not_owner') throw this.base.denied('Only the owner transfers ownership');
      throw refuse(ERR.NOT_FOUND, CHAT_REFUSAL_REASONS.NOT_A_MEMBER, 'Not a member');
    }
    await this.base.event(groupId, user.id, 'ownership', targetId);
    return { groupId, ownerId: targetId };
  }
}
