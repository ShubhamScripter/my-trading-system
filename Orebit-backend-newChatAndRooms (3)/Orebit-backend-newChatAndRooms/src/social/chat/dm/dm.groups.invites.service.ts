// Group invites (Module 9, , ): "If user has to add someone they'll have to send invite". Every limit is an
// admin setting with no built-in number (invites per window, pending invites per person, the time an invite lives);
// an unset one refuses inviting. A blocked person looks exactly like an unknown one, a person is never invited twice
// (the pending invite is the same one), and an invite ends by itself or can be revoked.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, SERVER_EVENTS } from '../chat.constants';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatDelivery } from '../realtime/chat.delivery';
import type { ChatUserContext } from '../chat.types';
import { ChatRelationsService } from '../services/chat.relations.service';
import { DmDbOperation } from './dm.dboperation';
import { DmGroupBansDbOperation } from './dm.group-bans.dboperation';
import { DmGroupInvitesDbOperation } from './dm.group-invites.dboperation';
import { DmGroupsDbOperation } from './dm.groups.dboperation';
import { DmGroupsService } from './dm.groups.service';
import { requireLimit } from './dm.limits';

@Injectable()
export class DmGroupInvitesService {
  constructor(
    private readonly base: DmGroupsService,
    private readonly dm: DmDbOperation,
    private readonly groups: DmGroupsDbOperation,
    private readonly invitesDb: DmGroupInvitesDbOperation,
    private readonly bansDb: DmGroupBansDbOperation,
    private readonly db: ChatDbOperation,
    private readonly relations: ChatRelationsService,
    private readonly delivery: ChatDelivery,
  ) {}

  // "If user has to add someone they'll have to send invite": adding is always an invite the user accepts.
  async invite(user: ChatUserContext, groupId: string, userIds: string[]) {
    const settings = await this.base.open(true);
    await this.base.assertNotChatBanned(user);
    const { group, me } = await this.base.context(user, groupId);
    this.base.assertMay(settings, group, me, 'ADD_PEOPLE');
    // every invite value is an admin setting with no built-in number; any unset one refuses inviting.
    const g = settings.groups;
    const inviteLimits = {
      perWindow: requireLimit(g.invitesPerWindow, 'groups.invitesPerWindow'),
      windowHours: requireLimit(g.inviteWindowHours, 'groups.inviteWindowHours'),
      pendingPerPerson: requireLimit(g.maxPendingInvitesPerPerson, 'groups.maxPendingInvitesPerPerson'),
      expiryHours: requireLimit(g.inviteExpiryHours, 'groups.inviteExpiryHours'),
    };
    const invited: { username: string; inviteId: string }[] = [];
    const skipped: { username: string; reason: string }[] = [];
    // Usernames become ids first (a login code or id is not accepted from a user, ); the block check needs ids.
    const ids: string[] = [];
    const nameOf = new Map<string, string>();
    for (const handle of [...new Set(userIds)].slice(0, 50)) {
      const id = await this.db.resolveUserHandle(handle);
      if (!id || id === user.id) skipped.push({ username: handle, reason: 'not_found' });
      else if (!ids.includes(id)) {
        ids.push(id);
        nameOf.set(id, handle);
      }
    }
    // One read of the members and one of the bans, not one query per person.
    const blocked = await this.relations.blockedEitherWay(user.id, ids);
    const members = new Map((await this.dm.members(groupId)).map((m) => [m.userId, m]));
    const banned = await this.bansDb.bannedAmong(groupId, ids);
    for (const id of ids) {
      const handle = nameOf.get(id) ?? id;
      // A blocked person looks exactly like an unknown one: the inviter learns nothing about the block.
      if (blocked.has(id)) {
        skipped.push({ username: handle, reason: 'not_found' });
        continue;
      }
      if (members.get(id)?.state === 'ACTIVE') {
        skipped.push({ username: handle, reason: 'already_member' });
        continue;
      }
      if (banned.has(id)) {
        skipped.push({ username: handle, reason: CHAT_REFUSAL_REASONS.GROUP_BANNED });
        continue;
      }
      const made = await this.invitesDb.createInvite(groupId, user.id, id, inviteLimits);
      if ('refused' in made) {
        skipped.push({ username: handle, reason: made.refused === 'window_limit' ? 'invite_limit_reached' : 'too_many_pending_invites' });
        continue;
      }
      const inviteId = made.inviteId;
      invited.push({ username: handle, inviteId });
      this.delivery.toUser(id, SERVER_EVENTS.DM_CONVERSATION_UPDATED, {
        conversationId: groupId,
        invite: { inviteId, groupName: group.name, inviterUsername: user.username },
      });
    }
    return { invited, skipped };
  }

  //  "a revoke action": the inviter, or anyone who may add people, withdraws a pending invite.
  async revokeInvite(user: ChatUserContext, groupId: string, inviteId: string) {
    const settings = await this.base.open(true);
    const { group, me } = await this.base.context(user, groupId);
    const invite = await this.invitesDb.inviteById(inviteId);
    if (!invite || invite.conversationId !== groupId || invite.status !== 'PENDING') {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Invite not found' });
    }
    if (invite.inviterId !== user.id) this.base.assertMay(settings, group, me, 'ADD_PEOPLE');
    if (!(await this.invitesDb.answerInvite(inviteId, 'REVOKED'))) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Invite not found' });
    }
    return { inviteId, revoked: true };
  }

  async invites(user: ChatUserContext) {
    return {
      items: (await this.invitesDb.invitesFor(user.id)).map((i) => ({
        id: i.id,
        groupId: i.conversation_id,
        groupName: i.group_name,
        groupLogoUrl: this.base.logo(i.group_logo),
        visibility: i.visibility,
        inviterUsername: i.inviter_username,
        createdAt: i.created_at.toISOString(),
      })),
    };
  }

  async respondToInvite(user: ChatUserContext, inviteId: string, accept: boolean) {
    const settings = await this.base.open(true);
    const invite = await this.invitesDb.inviteById(inviteId);
    if (!invite || invite.inviteeId !== user.id || invite.status !== 'PENDING') {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Invite not found' });
    }
    const group = await this.groups.group(invite.conversationId);
    if (!group || group.closedAt) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Group not found' });
    if (accept) await this.base.addMember(user, group, settings, invite);
    else await this.invitesDb.answerInvite(inviteId, 'DECLINED');
    return { inviteId, groupId: group.conversationId, accepted: accept };
  }
}
