// Personal chat over HTTP (Modules 8–9): conversations, messages, the inbox, privacy and groups. Paths are in
// dm.routes.ts; the socket events (`dm_send`, `dm_typing`, `dm_read`) are in dm.gateway.ts and use the same services.
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { config } from '../../../config';
import { ok, type SuccessEnvelope } from '../../../http';
import { ChatAuthHelper } from '../chat.auth.helper';
import type { GroupPermission } from '../chat.features.contract';
import type { ChatUserContext } from '../chat.types';
import { clientIp } from '../chat.utility';
import type * as dto from './dm.dto';
import { DmGroupsService } from './dm.groups.service';
import { DmGroupsModerationService } from './dm.groups.moderation.service';
import { DmInboxService } from './dm.inbox.service';
import type { GroupRole } from './dm.rules';
import { DmActionsService } from './dm.actions.service';
import { DmCardsService } from './dm.cards.service';
import { DmPrivacyService } from './dm.privacy.service';
import { DmGroupInvitesService } from './dm.groups.invites.service';
import { DmSignalsService } from './dm.signals.service';
import { DmService, type DmSendInput } from './dm.service';

// The message body of an HTTP or socket send, as the service takes it.
export function toDmInput(body: {
  content?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'gif' | 'video';
  thumbnailUrl?: string;
  clientMessageId?: string;
}): DmSendInput {
  return {
    ...(body.content !== undefined ? { content: body.content } : {}),
    ...(body.mediaUrl && body.mediaType
      ? {
          media: {
            url: body.mediaUrl,
            type: body.mediaType,
            ...(body.content ? { caption: body.content } : {}),
            ...(body.thumbnailUrl ? { thumbnailUrl: body.thumbnailUrl } : {}),
          },
        }
      : {}),
    ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
  };
}

@Injectable()
export class DmController {
  constructor(
    private readonly auth: ChatAuthHelper,
    private readonly dm: DmService,
    private readonly signals: DmSignalsService,
    private readonly actions: DmActionsService,
    private readonly cards: DmCardsService,
    private readonly inbox: DmInboxService,
    private readonly privacyService: DmPrivacyService,
    private readonly groups: DmGroupsService,
    private readonly groupInvites: DmGroupInvitesService,
    private readonly groupAdmin: DmGroupsModerationService,
  ) {}

  private user(req: FastifyRequest): Promise<ChatUserContext> {
    return this.auth.getChatUser(req);
  }

  private ip(req: FastifyRequest): string {
    return clientIp(req.headers['x-forwarded-for'], req.ip, config.trustedProxies);
  }

  // Inbox
  async conversations(
    req: FastifyRequest,
    query: dto.DmListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.conversations(await this.user(req), query));
  }

  async unread(req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.unread(await this.user(req)));
  }

  async merchantApps(req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.merchantApps(await this.user(req)));
  }

  async conversation(req: FastifyRequest, id: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.conversation(await this.user(req), id));
  }

  async resolveUser(req: FastifyRequest, handle: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.privacyService.resolveUser(await this.user(req), handle));
  }

  async myGroups(
    req: FastifyRequest,
    query: dto.DmListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.conversations(await this.user(req), { ...query, folder: 'GROUPS' }));
  }

  async groupPermissionsView(req: FastifyRequest, id: string): Promise<SuccessEnvelope<unknown>> {
    const view = await this.inbox.conversation(await this.user(req), id);
    return ok({
      groupId: id,
      role: view.me.role,
      permissions: view.group?.permissions ?? null,
      adminManageable: view.group?.adminManageable ?? [],
    });
  }

  // One page of a group's members.
  async members(
    req: FastifyRequest,
    id: string,
    query: dto.DmPageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.groupMembers(await this.user(req), id, query));
  }

  // The paged ban list of a public group.
  async bans(
    req: FastifyRequest,
    id: string,
    query: dto.DmPageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupAdmin.bans(await this.user(req), id, query));
  }

  async open(req: FastifyRequest, body: dto.DmOpenDto): Promise<SuccessEnvelope<unknown>> {
    return ok(
      await this.dm.openDirect(
        await this.user(req),
        body.userId,
        body.content ? { content: body.content } : null,
        this.ip(req),
        body.appId ?? null,
      ),
    );
  }

  async moveFolder(
    req: FastifyRequest,
    id: string,
    body: dto.DmFolderDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.moveFolder(await this.user(req), id, body.folder));
  }

  async pinPerson(
    req: FastifyRequest,
    id: string,
    body: dto.DmPinDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.pinPerson(await this.user(req), id, body.pinned));
  }

  async nickname(
    req: FastifyRequest,
    id: string,
    body: dto.DmNicknameDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.setNickname(await this.user(req), id, body.nickname));
  }

  async notifications(
    req: FastifyRequest,
    id: string,
    body: dto.DmNotificationsDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.setNotifications(await this.user(req), id, body.notifications));
  }

  async respond(
    req: FastifyRequest,
    id: string,
    accept: boolean,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.dm.respondToRequest(await this.user(req), id, accept));
  }

  async shared(
    req: FastifyRequest,
    id: string,
    query: dto.DmSharedQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.shared(await this.user(req), id, query));
  }

  async search(
    req: FastifyRequest,
    query: dto.DmSearchQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.inbox.search(await this.user(req), query));
  }

  async privacy(req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.privacyService.privacy(await this.user(req)));
  }

  async updatePrivacy(
    req: FastifyRequest,
    body: dto.DmPrivacyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.privacyService.updatePrivacy(await this.user(req), body));
  }

  async commonGroups(req: FastifyRequest, handle: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.privacyService.commonGroups(await this.user(req), handle));
  }

  // Messages
  async history(
    req: FastifyRequest,
    id: string,
    query: dto.DmPageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.dm.history(await this.user(req), id, query));
  }

  async send(
    req: FastifyRequest,
    id: string,
    body: dto.DmSendDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.dm.send(await this.user(req), id, toDmInput(body), this.ip(req)));
  }

  async read(
    req: FastifyRequest,
    id: string,
    body: dto.DmReadBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.signals.markRead(await this.user(req), id, body.messageId));
  }

  async pinned(req: FastifyRequest, id: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.actions.pinnedMessages(await this.user(req), id));
  }

  async retract(req: FastifyRequest, messageId: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.actions.retract(await this.user(req), messageId));
  }

  async pinMessage(
    req: FastifyRequest,
    messageId: string,
    body: dto.DmPinDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.actions.pin(await this.user(req), messageId, body.pinned));
  }

  async forward(
    req: FastifyRequest,
    messageId: string,
    body: dto.DmForwardDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(
      await this.actions.forward(
        await this.user(req),
        messageId,
        body.conversationIds,
        this.ip(req),
      ),
    );
  }

  async report(
    req: FastifyRequest,
    messageId: string,
    body: dto.DmReportDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.actions.report(await this.user(req), messageId, body));
  }

  async gift(
    req: FastifyRequest,
    id: string,
    body: dto.DmGiftDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.actions.startGift(await this.user(req), id, body, this.ip(req)));
  }

  async giftCard(
    req: FastifyRequest,
    id: string,
    body: dto.DmCardDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.cards.send(await this.user(req), id, body, this.ip(req)));
  }

  // Groups
  async createGroup(
    req: FastifyRequest,
    body: dto.GroupCreateDto,
  ): Promise<SuccessEnvelope<unknown>> {
    // The people to invite go out as invites after the group exists (the invite rules are the invites service's).
    const user = await this.user(req);
    const { inviteUserIds, ...details } = body;
    if (inviteUserIds?.length) await this.groupInvites.preflightCreateWithInvites();
    const created = await this.groups.create(user, details);
    const invited = inviteUserIds?.length
      ? await this.groupInvites.invite(user, created.groupId, inviteUserIds)
      : { invited: [], skipped: [] };
    return ok({ ...created, ...invited });
  }

  async publicGroups(
    req: FastifyRequest,
    query: dto.GroupsQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groups.publicGroups(await this.user(req), query));
  }

  async updateGroup(
    req: FastifyRequest,
    id: string,
    body: dto.GroupUpdateDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groups.update(await this.user(req), id, body));
  }

  async groupPermissions(
    req: FastifyRequest,
    id: string,
    body: dto.GroupPermissionsDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(
      await this.groups.setPermissions(
        await this.user(req),
        id,
        {
          permissions: body.permissions as Partial<Record<GroupPermission, GroupRole>> | undefined,
          adminManageable: body.adminManageable as GroupPermission[] | undefined,
        },
      ),
    );
  }

  async join(req: FastifyRequest, id: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groups.join(await this.user(req), id));
  }

  async leave(req: FastifyRequest, id: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groups.leave(await this.user(req), id));
  }

  async invite(
    req: FastifyRequest,
    id: string,
    body: dto.GroupInviteDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupInvites.invite(await this.user(req), id, body.userIds));
  }

  async invites(req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupInvites.invites(await this.user(req)));
  }

  async answerInvite(
    req: FastifyRequest,
    inviteId: string,
    body: dto.GroupInviteAnswerDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupInvites.respondToInvite(await this.user(req), inviteId, body.accept));
  }

  async revokeInvite(
    req: FastifyRequest,
    groupId: string,
    inviteId: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupInvites.revokeInvite(await this.user(req), groupId, inviteId));
  }

  async setRole(
    req: FastifyRequest,
    id: string,
    userId: string,
    body: dto.GroupRoleDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupAdmin.setRole(await this.user(req), id, userId, body.role));
  }

  async removeMember(
    req: FastifyRequest,
    id: string,
    userId: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupAdmin.remove(await this.user(req), id, userId));
  }

  async timeout(
    req: FastifyRequest,
    id: string,
    userId: string,
    body: dto.GroupTimeoutDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupAdmin.timeout(await this.user(req), id, userId, body.minutes));
  }

  async ban(
    req: FastifyRequest,
    id: string,
    userId: string,
    body: dto.GroupBanDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(
      await this.groupAdmin.ban(await this.user(req), id, userId, body.reason ?? null, body.banned),
    );
  }

  async deleteMessage(
    req: FastifyRequest,
    id: string,
    messageId: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupAdmin.deleteMessage(await this.user(req), id, messageId));
  }

  async startTransfer(
    req: FastifyRequest,
    id: string,
    body: dto.GroupTransferDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.groupAdmin.startTransfer(await this.user(req), id, body.userId));
  }
}
