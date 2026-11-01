// The personal-chat routes (Modules 8–9). Declarative, no logic: every handler hands its parsed input to
// DmController. The platform's AuthGuard protects every route.
import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type SuccessEnvelope } from '../../../http';
import { body, HandleParam, UuidParam } from '../chat.routes';
import { DmController } from './dm.controller';
import * as dto from './dm.dto';

const id = (): UuidParam => new UuidParam('conversationId');
const messageId = (): UuidParam => new UuidParam('messageId');
const groupId = (): UuidParam => new UuidParam('groupId');
const userId = (): HandleParam => new HandleParam();

@Controller('social')
export class DmRoutes {
  constructor(private readonly controller: DmController) {}

  // Inbox
  // One tab: PRIMARY, GENERAL, GROUPS or REQUESTS.
  @Get('chat/dm/conversations')
  conversations(
    @Req() req: FastifyRequest,
    @Query(body) query: dto.DmListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.conversations(req, query);
  }

  // Opens (or finds) the direct conversation with a user, with an optional first message.
  @Post('chat/dm/conversations')
  open(
    @Req() req: FastifyRequest,
    @Body(body) b: dto.DmOpenDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.open(req, b);
  }

  @Get('chat/dm/unread')
  unread(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.unread(req);
  }

  // Chat MAIN "SO / Merchants: … sorted separately by apps": the merchant folder per app.
  @Get('chat/dm/merchant-apps')
  merchantApps(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.merchantApps(req);
  }

  @Get('chat/dm/conversations/:conversationId')
  conversation(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.conversation(req, cid);
  }

  @Get('chat/dm/conversations/:conversationId/messages')
  history(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Query(body) query: dto.DmPageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.history(req, cid, query);
  }

  @Post('chat/dm/conversations/:conversationId/messages')
  send(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Body(body) b: dto.DmSendDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.send(req, cid, b);
  }

  @Post('chat/dm/conversations/:conversationId/read')
  read(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Body(body) b: dto.DmReadBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.read(req, cid, b);
  }

  @Post('chat/dm/conversations/:conversationId/accept')
  accept(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.respond(req, cid, true);
  }

  @Post('chat/dm/conversations/:conversationId/decline')
  decline(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.respond(req, cid, false);
  }

  @Post('chat/dm/conversations/:conversationId/folder')
  folder(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Body(body) b: dto.DmFolderDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.moveFolder(req, cid, b);
  }

  @Post('chat/dm/conversations/:conversationId/pin')
  pinPerson(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Body(body) b: dto.DmPinDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.pinPerson(req, cid, b);
  }

  @Post('chat/dm/conversations/:conversationId/nickname')
  nickname(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Body(body) b: dto.DmNicknameDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.nickname(req, cid, b);
  }

  @Post('chat/dm/conversations/:conversationId/notifications')
  notifications(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Body(body) b: dto.DmNotificationsDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.notifications(req, cid, b);
  }

  @Get('chat/dm/conversations/:conversationId/pinned')
  pinned(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.pinned(req, cid);
  }

  @Get('chat/dm/conversations/:conversationId/shared')
  shared(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Query(body) query: dto.DmSharedQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.shared(req, cid, query);
  }

  // The gift button of a direct conversation; confirm with POST social/chat/gifts/{giftId}/confirm.
  @Post('chat/dm/conversations/:conversationId/gift')
  gift(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Body(body) b: dto.DmGiftDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.gift(req, cid, b);
  }

  // A gift card for the other person of a direct conversation: the card's title and value, never its code.
  @Post('chat/dm/conversations/:conversationId/gift-card')
  giftCard(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Body(body) b: dto.DmCardDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.giftCard(req, cid, b);
  }

  @Post('chat/dm/messages/:messageId/retract')
  retract(
    @Req() req: FastifyRequest,
    @Param('messageId', messageId()) mid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.retract(req, mid);
  }

  @Post('chat/dm/messages/:messageId/pin')
  pinMessage(
    @Req() req: FastifyRequest,
    @Param('messageId', messageId()) mid: string,
    @Body(body) b: dto.DmPinDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.pinMessage(req, mid, b);
  }

  @Post('chat/dm/messages/:messageId/forward')
  forward(
    @Req() req: FastifyRequest,
    @Param('messageId', messageId()) mid: string,
    @Body(body) b: dto.DmForwardDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.forward(req, mid, b);
  }

  @Post('chat/dm/messages/:messageId/report')
  report(
    @Req() req: FastifyRequest,
    @Param('messageId', messageId()) mid: string,
    @Body(body) b: dto.DmReportDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.report(req, mid, b);
  }

  @Get('chat/dm/search')
  search(
    @Req() req: FastifyRequest,
    @Query(body) query: dto.DmSearchQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.search(req, query);
  }

  @Get('chat/dm/privacy')
  privacy(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.privacy(req);
  }

  @Put('chat/dm/privacy')
  updatePrivacy(
    @Req() req: FastifyRequest,
    @Body(body) b: dto.DmPrivacyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.updatePrivacy(req, b);
  }

  @Get('chat/dm/users/:userId/common-groups')
  commonGroups(
    @Req() req: FastifyRequest,
    @Param('userId', new HandleParam()) handle: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.commonGroups(req, handle);
  }

  // Groups
  @Post('chat/dm/groups')
  createGroup(
    @Req() req: FastifyRequest,
    @Body(body) b: dto.GroupCreateDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.createGroup(req, b);
  }

  // "Channels: All Public Groups".
  @Get('chat/dm/groups/public')
  publicGroups(
    @Req() req: FastifyRequest,
    @Query(body) query: dto.GroupsQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.publicGroups(req, query);
  }

  @Get('chat/dm/users/:userId')
  resolveUser(
    @Req() req: FastifyRequest,
    @Param('userId', new HandleParam()) handle: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.resolveUser(req, handle);
  }

  // The caller's own groups (the GROUPS folder of the inbox).
  @Get('chat/dm/groups')
  myGroups(
    @Req() req: FastifyRequest,
    @Query(body) query: dto.DmListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.myGroups(req, query);
  }

  @Get('chat/dm/groups/:groupId')
  groupDetail(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.conversation(req, gid);
  }

  @Get('chat/dm/conversations/:conversationId/members')
  members(
    @Req() req: FastifyRequest,
    @Param('conversationId', id()) cid: string,
    @Query(body) query: dto.DmPageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.members(req, cid, query);
  }

  @Get('chat/dm/groups/:groupId/bans')
  bans(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Query(body) query: dto.DmPageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.bans(req, gid, query);
  }

  @Get('chat/dm/groups/:groupId/permissions')
  groupPermissionsView(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.groupPermissionsView(req, gid);
  }

  @Put('chat/dm/groups/:groupId')
  updateGroup(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Body(body) b: dto.GroupUpdateDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.updateGroup(req, gid, b);
  }

  @Put('chat/dm/groups/:groupId/permissions')
  groupPermissions(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Body(body) b: dto.GroupPermissionsDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.groupPermissions(req, gid, b);
  }

  @Post('chat/dm/groups/:groupId/join')
  join(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.join(req, gid);
  }

  @Post('chat/dm/groups/:groupId/leave')
  leave(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.leave(req, gid);
  }

  @Post('chat/dm/groups/:groupId/invites')
  invite(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Body(body) b: dto.GroupInviteDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.invite(req, gid, b);
  }

  @Get('chat/dm/invites')
  invites(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.invites(req);
  }

  // Withdraws a pending invite.
  @Post('chat/dm/groups/:groupId/invites/:inviteId/revoke')
  revokeInvite(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Param('inviteId', new UuidParam('inviteId')) inviteId: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.revokeInvite(req, gid, inviteId);
  }

  @Post('chat/dm/invites/:inviteId/answer')
  answerInvite(
    @Req() req: FastifyRequest,
    @Param('inviteId', new UuidParam('inviteId')) inviteId: string,
    @Body(body) b: dto.GroupInviteAnswerDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.answerInvite(req, inviteId, b);
  }

  @Put('chat/dm/groups/:groupId/members/:userId/role')
  putRole(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Param('userId', userId()) uid: string,
    @Body(body) b: dto.GroupRoleDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.setRole(req, gid, uid, b);
  }

  @Post('chat/dm/groups/:groupId/members/:userId/role')
  setRole(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Param('userId', userId()) uid: string,
    @Body(body) b: dto.GroupRoleDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.setRole(req, gid, uid, b);
  }

  @Post('chat/dm/groups/:groupId/members/:userId/remove')
  removeMember(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Param('userId', userId()) uid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.removeMember(req, gid, uid);
  }

  @Post('chat/dm/groups/:groupId/members/:userId/timeout')
  timeout(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Param('userId', userId()) uid: string,
    @Body(body) b: dto.GroupTimeoutDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.timeout(req, gid, uid, b);
  }

  @Post('chat/dm/groups/:groupId/members/:userId/ban')
  ban(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Param('userId', userId()) uid: string,
    @Body(body) b: dto.GroupBanDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.ban(req, gid, uid, b);
  }

  @Post('chat/dm/groups/:groupId/messages/:messageId/delete')
  deleteMessage(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Param('messageId', messageId()) mid: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.deleteMessage(req, gid, mid);
  }

  // Hands the group to another member at once; no code is asked.
  @Post('chat/dm/groups/:groupId/transfer')
  startTransfer(
    @Req() req: FastifyRequest,
    @Param('groupId', groupId()) gid: string,
    @Body(body) b: dto.GroupTransferDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.startTransfer(req, gid, b);
  }
}
