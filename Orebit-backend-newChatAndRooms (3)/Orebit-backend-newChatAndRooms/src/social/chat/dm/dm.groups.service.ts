// Groups (Module 9, Chat MAIN "Users can create groups…", Chat DM Settings): public (publicly joinable) and private
// (invite only) groups, owner / admin / sub-admin roles, the permissions the owner hands out, members who may not
// text and group details. Roles, timeouts, bans, deleting messages and ownership transfer are in
// dm.groups.moderation.service.ts. Every limit comes from the chat settings `groups` section.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, GROUP_NOTICE_WINDOW_SECONDS, PAGE, SERVER_EVENTS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { GROUP_PERMISSIONS, type GroupPermission } from '../chat.features.contract';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import type { ChatSettings } from '../chat.settings.contract';
import { chatMediaBase, signMediaUrl } from '../chat.upload';
import { ChatRelationsService } from '../services/chat.relations.service';
import { ChatDelivery } from '../realtime/chat.delivery';
import type { ChatUserContext } from '../chat.types';
import * as utility from '../chat.utility';
import { DmDbOperation, type MemberRow } from './dm.dboperation';
import { DmMessagesDbOperation } from './dm.messages.dboperation';
import {
  DmGroupsDbOperation,
  type GroupRecord,
  type GroupVisibility,
} from './dm.groups.dboperation';
import { DmGroupInvitesDbOperation } from './dm.group-invites.dboperation';
import { DmGroupBansDbOperation } from './dm.group-bans.dboperation';
import { GROUP_RANK, mayDo, outranks, roleFor, type GroupRole } from './dm.rules';
import { requireLimit } from './dm.limits';
import { DmService } from './dm.service';

@Injectable()
export class DmGroupsService {
  constructor(
    private readonly dm: DmDbOperation,
    private readonly messagesDb: DmMessagesDbOperation,
    private readonly groups: DmGroupsDbOperation,
    private readonly invitesDb: DmGroupInvitesDbOperation,
    private readonly bansDb: DmGroupBansDbOperation,
    private readonly db: ChatDbOperation,
    private readonly access: ChatAccessService,
    private readonly ports: ChatFeaturePorts,
    private readonly relations: ChatRelationsService,
    private readonly delivery: ChatDelivery,
    private readonly messages: DmService,
    private readonly moderation: ChatModerationService,
  ) {}

  invalid(path: string, message: string): ProblemException {
    return new ProblemException({ type: ERR.VALIDATION_FAILED, errors: [{ path, message }] });
  }

  denied(detail: string, extra: Record<string, unknown> = {}): ProblemException {
    return refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.PERMISSION_DENIED, detail, extra);
  }

  limit(detail: string, extra: Record<string, unknown>): ProblemException {
    return refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.LIMIT_REACHED, detail, extra);
  }

  async open(write: boolean): Promise<ChatSettings> {
    const settings = await this.messages.settings();
    this.messages.assertOpen(settings, write);
    return settings;
  }

  // The group and the caller's active membership.
  async context(
    user: ChatUserContext,
    groupId: string,
  ): Promise<{ group: GroupRecord; me: MemberRow }> {
    const group = await this.groups.group(groupId);
    const me = group ? await this.dm.member(groupId, user.id) : null;
    if (!group || group.closedAt || !me || me.state !== 'ACTIVE') {
      throw refuse(ERR.NOT_FOUND, CHAT_REFUSAL_REASONS.NOT_A_MEMBER, 'Group not found');
    }
    return { group, me };
  }

  assertMay(
    settings: ChatSettings,
    group: GroupRecord,
    me: MemberRow,
    permission: GroupPermission,
  ): void {
    if (!mayDo(me.role, permission, group.permissions, settings.groups.delegablePermissions)) {
      throw this.denied('Your group role may not do this', {
        permission,
        requiredRole: roleFor(permission, group.permissions, settings.groups.delegablePermissions),
      });
    }
  }

  // A target who is an active member and below the actor. Accepts either a user ID or username handle.
  async target(groupId: string, me: MemberRow, userId: string): Promise<MemberRow> {
    const id = (await this.db.resolveUserHandle(userId)) ?? userId;
    const target = await this.dm.member(groupId, id);
    if (!target || target.state !== 'ACTIVE')
      throw refuse(ERR.NOT_FOUND, CHAT_REFUSAL_REASONS.NOT_A_MEMBER, 'Not a member');
    if (!outranks(me.role, target.role)) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.TARGET_OUTRANKS_YOU,
        'You cannot act on this member',
      );
    }
    return target;
  }

  async resolveUser(handle: string): Promise<string | null> {
    return this.db.resolveUserHandle(handle);
  }

  // A SYSTEM line in the group ("X joined"), delivered like any message.
  async event(
    groupId: string,
    actorId: string,
    kind: string,
    targetId?: string,
    value?: string,
  ): Promise<void> {
    // joins and leaves close together are one line whose counts grow, announced as an update.
    if (kind === 'joined' || kind === 'left') {
      const { row, updated } = await this.messagesDb.addMembershipNotice(groupId, actorId, kind, GROUP_NOTICE_WINDOW_SECONDS);
      if (updated) await this.messages.deliverUpdate(row);
      else await this.messages.deliver(row);
      return;
    }
    const ids = [actorId, ...(targetId ? [targetId] : [])];
    const names = await this.db.usersByIds(ids);
    const actorUsername = names.get(actorId) ?? undefined;
    const targetUsername = targetId ? (names.get(targetId) ?? undefined) : undefined;
    const { row } = await this.messagesDb.insertMessage({
      conversationId: groupId,
      senderId: actorId,
      content: '',
      type: 'SYSTEM',
      metadata: {
        event: {
          kind,
          actorId,
          targetId,
          actorUsername,
          targetUsername,
          ...(value ? { value } : {}),
        },
      },
    });
    await this.messages.deliver(row);
  }

  // only a public-chat ban stops creating groups and inviting (a DM ban does not).
  async assertNotChatBanned(user: ChatUserContext): Promise<void> {
    await this.moderation.assertNotBanned(user.id, null, await this.dm.dbNow());
  }

  // the name and description of a public group get public chat's auto-moderation.
  private async moderateDetails(
    user: ChatUserContext,
    settings: ChatSettings,
    name: string | undefined,
    description: string | null | undefined,
  ): Promise<void> {
    const dbNow = await this.dm.dbNow();
    for (const text of [name, description]) {
      if (text) await this.messages.moderateGroupText(user, text, settings, dbNow);
    }
  }

  // The logo as a signed, short-lived link: every group output goes through here.
  logo(url: string | null): string | null {
    return url ? signMediaUrl(url) : null;
  }

  private async isPremium(user: ChatUserContext): Promise<boolean> {
    return ((await this.access.factsFor(user)).premiumPlanIds?.length ?? 0) > 0;
  }

  private validLogo(url: string | null | undefined): void {
    if (url && !utility.isChatMediaUrl(url, chatMediaBase()))
      throw this.invalid('logoUrl', 'Upload the image through chat first');
  }

  // Create, update, permissions
  async create(
    user: ChatUserContext,
    input: {
      name: string;
      description?: string;
      logoUrl?: string;
      visibility: GroupVisibility;
      // A channel: only admins post; public or private like any group.
      isChannel?: boolean;
    },
  ) {
    const settings = await this.open(true);
    await this.assertNotChatBanned(user);
    const name = input.name.trim();
    if (input.visibility === 'PUBLIC') await this.moderateDetails(user, settings, name, input.description);
    if (name.length < 1 || name.length > 64) throw this.invalid('name', '1 to 64 characters');
    if ((input.description?.length ?? 0) > 500)
      throw this.invalid('description', 'At most 500 characters');
    this.validLogo(input.logoUrl);
    // "Maximum Groups a User Can Create [both settings separate for Premium]".
    const premium = await this.isPremium(user);
    const g = settings.groups;
    const max =
      input.visibility === 'PUBLIC'
        ? premium
          ? g.maxCreatePublicPremium
          : g.maxCreatePublic
        : premium
          ? g.maxCreatePrivatePremium
          : g.maxCreatePrivate;
    if ((await this.groups.createdCount(user.id, input.visibility)) >= max) {
      throw this.limit(`You may create at most ${max} ${input.visibility.toLowerCase()} groups`, {
        max,
      });
    }
    await this.assertJoinLimit(user.id, input.visibility, settings);
    const id = await this.groups.createGroup({
      ownerId: user.id,
      name,
      description: input.description?.trim() || null,
      logoUrl: input.logoUrl ?? null,
      visibility: input.visibility,
      isChannel: input.isChannel ?? false,
    });
    await this.event(id, user.id, 'created', undefined, name);
    return { groupId: id, conversationId: id };
  }

  private async assertJoinLimit(
    userId: string,
    visibility: GroupVisibility,
    settings: ChatSettings,
  ): Promise<void> {
    const max =
      visibility === 'PUBLIC' ? settings.groups.maxJoinPublic : settings.groups.maxJoinPrivate;
    if ((await this.groups.joinedCount(userId, visibility)) >= max) {
      throw this.limit(`You may be in at most ${max} ${visibility.toLowerCase()} groups`, { max });
    }
  }

  // Name, description, logo, type and "members can text", each behind its permission.
  async update(
    user: ChatUserContext,
    groupId: string,
    input: {
      name?: string;
      description?: string | null;
      logoUrl?: string | null;
      visibility?: GroupVisibility;
      membersCanText?: boolean;
    },
  ) {
    const settings = await this.open(true);
    const { group, me } = await this.context(user, groupId);
    // The group counts as public after this change when it is public now and stays so, or becomes public.
    if ((input.visibility ?? group.visibility) === 'PUBLIC' && (input.name !== undefined || input.description)) {
      await this.moderateDetails(user, settings, input.name, input.description);
    }
    if (input.name !== undefined) {
      this.assertMay(settings, group, me, 'RENAME');
      if (input.name.trim().length < 1 || input.name.trim().length > 64)
        throw this.invalid('name', '1 to 64 characters');
    }
    if (input.description !== undefined) {
      this.assertMay(settings, group, me, 'CHANGE_DESCRIPTION');
      if ((input.description?.length ?? 0) > 500)
        throw this.invalid('description', 'At most 500 characters');
    }
    if (input.logoUrl !== undefined) {
      this.assertMay(settings, group, me, 'CHANGE_IMAGE');
      this.validLogo(input.logoUrl);
    }
    if (input.visibility !== undefined && input.visibility !== group.visibility) {
      this.assertMay(settings, group, me, 'CHANGE_TYPE');
      // a changed group still counts by the type it was created as, so changing the type never needs room.
    }
    // "Group Admin can set if the members can text in the group or not."
    if (input.membersCanText !== undefined && GROUP_RANK[me.role] < GROUP_RANK.ADMIN) {
      throw this.denied('Only group admins decide whether members can text');
    }
    await this.groups.updateGroup(groupId, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined
        ? { description: input.description?.trim() || null }
        : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.membersCanText !== undefined ? { membersCanText: input.membersCanText } : {}),
    });
    if (input.name !== undefined)
      await this.event(groupId, user.id, 'renamed', undefined, input.name.trim());
    await this.messages.broadcast(groupId, SERVER_EVENTS.DM_CONVERSATION_UPDATED, {
      conversationId: groupId,
      group: { ...input, ...(input.logoUrl ? { logoUrl: this.logo(input.logoUrl) } : {}) },
    });
    return { groupId, ...input, logoUrl: input.logoUrl === undefined ? undefined : this.logo(input.logoUrl) };
  }

  // "Group admin can set who has permission to add / remove people" (and the rest). The owner sets any permission and
// decides which ones admins may change (`adminManageable`); an admin changes only those, never to OWNER.
  async setPermissions(
    user: ChatUserContext,
    groupId: string,
    input: {
      permissions?: Partial<Record<GroupPermission, GroupRole>>;
      adminManageable?: GroupPermission[];
    },
  ) {
    const settings = await this.open(true);
    const { group, me } = await this.context(user, groupId);
    const isOwner = me.role === 'OWNER';
    if (!isOwner && me.role !== 'ADMIN') throw this.denied('Only the owner and admins set group permissions');
    if (input.adminManageable !== undefined && !isOwner) {
      throw this.denied('Only the owner decides which permissions admins may change');
    }
    const next = { ...group.permissions };
    for (const [key, role] of Object.entries(input.permissions ?? {})) {
      if (!(GROUP_PERMISSIONS as readonly string[]).includes(key))
        throw this.invalid(key, 'Not a group permission');
      if (!['OWNER', 'ADMIN', 'SUB_ADMIN', 'MEMBER'].includes(role))
        throw this.invalid(key, 'OWNER, ADMIN, SUB_ADMIN or MEMBER');
      if (!isOwner && !group.adminManageable.includes(key as GroupPermission)) {
        throw this.denied('The owner has not allowed admins to change this permission', { permission: key });
      }
      if (!isOwner && role === 'OWNER') throw this.denied('Only the owner keeps a permission for the owner alone');
      if (role !== 'OWNER' && !settings.groups.delegablePermissions.includes(key as GroupPermission)) {
        throw this.denied('This permission cannot be handed out', { permission: key });
      }
      next[key as GroupPermission] = role;
    }
    let manageable = group.adminManageable;
    if (input.adminManageable !== undefined) {
      for (const key of input.adminManageable) {
        if (!(GROUP_PERMISSIONS as readonly string[]).includes(key)) throw this.invalid(key, 'Not a group permission');
        if (!settings.groups.delegablePermissions.includes(key))
          throw this.denied('This permission cannot be handed out', { permission: key });
      }
      manageable = [...new Set(input.adminManageable)];
    }
    await this.groups.updateGroup(groupId, { permissions: next, adminManageable: manageable });
    await this.messages.broadcast(groupId, SERVER_EVENTS.DM_CONVERSATION_UPDATED, {
      conversationId: groupId,
      permissions: next,
      adminManageable: manageable,
    });
    return { groupId, permissions: next, adminManageable: manageable };
  }

  // Finding and joining
  // "Channels: All Public Groups".
  async publicGroups(
    user: ChatUserContext,
    query: { q?: string; limit?: number; cursor?: string },
  ) {
    await this.open(false);
    const limit = query.limit ?? PAGE.DEFAULT;
    const cursor = query.cursor ? utility.decodeCursor(query.cursor) : null;
    const rows = await this.groups.publicGroups(user.id, query.q?.trim() || null, limit, cursor);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        logoUrl: this.logo(g.logo_url),
        memberCount: g.member_count,
        isMember: g.my_state === 'ACTIVE',
      })),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.created_at_text, id: last.id })
          : null,
    };
  }

  // The member limit of this kind of group.
  memberLimit(group: GroupRecord, settings: ChatSettings): number {
    const g = settings.groups;
    return group.isChannel
      ? requireLimit(g.memberLimitChannel, 'groups.memberLimitChannel')
      : group.visibility === 'PUBLIC'
        ? requireLimit(g.memberLimitPublic, 'groups.memberLimitPublic')
        : requireLimit(g.memberLimitPrivate, 'groups.memberLimitPrivate');
  }

  // The checks and the insert of a join are one locked transaction: a full group or a user at the join limit
// lets exactly the free places through, however many requests arrive together.
  async addMember(
    user: ChatUserContext,
    group: GroupRecord,
    settings: ChatSettings,
    invite: { id: string } | null,
  ): Promise<void> {
    const maxJoined =
      group.visibility === 'PUBLIC' ? settings.groups.maxJoinPublic : settings.groups.maxJoinPrivate;
    // public, private and channel groups each have their own member limit; an unset one refuses the join.
    const maxMembers = this.memberLimit(group, settings);
    const outcome = await this.groups.addMemberLocked(
      group.conversationId,
      user.id,
      { maxMembers, maxJoined },
      async (tx) => {
        // Accepting the invite is part of the same transaction: a revoked invite aborts the join.
        if (invite && !(await this.invitesDb.answerInvite(invite.id, 'ACCEPTED', tx))) {
          throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Invite not found' });
        }
      },
    );
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'closed':
          throw refuse(ERR.NOT_FOUND, CHAT_REFUSAL_REASONS.GROUP_CLOSED, 'Group not found');
        case 'banned':
          throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.GROUP_BANNED, 'You are banned from this group');
        case 'full':
          throw this.limit('This group is full', { max: maxMembers });
        case 'join_limit':
          throw this.limit(
            `You may be in at most ${maxJoined} ${group.visibility.toLowerCase()} groups`,
            { max: maxJoined },
          );
        default:
          return;
      }
    }
    await this.event(group.conversationId, user.id, 'joined');
  }

  // "Public (Publicly Joinable)".
  async join(user: ChatUserContext, groupId: string) {
    const settings = await this.open(true);
    const group = await this.groups.group(groupId);
    if (!group || group.closedAt) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Group not found' });
    const existing = await this.dm.member(groupId, user.id);
    if (existing?.state === 'ACTIVE') return { groupId, joined: false };
    const invite = await this.invitesDb.pendingInvite(groupId, user.id);
    if (group.visibility === 'PRIVATE' && !invite) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.INVITE_ONLY, 'This group is invite only');
    }
    await this.addMember(user, group, settings, invite);
    return { groupId, joined: true };
  }

  async leave(user: ChatUserContext, groupId: string) {
    await this.open(false);
    await this.context(user, groupId);
    const result = await this.groups.leaveLocked(groupId, user.id);
    if (result.ownerMustTransfer) throw this.denied('Transfer ownership before leaving the group');
    if (!result.left) throw refuse(ERR.NOT_FOUND, CHAT_REFUSAL_REASONS.NOT_A_MEMBER, 'Group not found');
    // The last member to leave closes the group: nobody is left to read a notice.
    if (!result.closed) await this.event(groupId, user.id, 'left');
    return { groupId, left: true, closed: result.closed };
  }
}
