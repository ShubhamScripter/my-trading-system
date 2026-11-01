/**
 * The Module 4 staff routes (Chat SETTINGS "Moderation Role Permissions"). Declarative, no logic: every handler hands
 * its parsed input to ChatStaffController. The platform's AuthGuard protects every route; what a staff member may do
 * is their role's permission set, checked by the services.
 */
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type SuccessEnvelope } from '../../http';
import { NoteBodyDto } from './chat.dto';
import { body, RoomParam, UuidParam } from './chat.routes';
import {
  HistoryQueryDto,
  PenaltiesQueryDto,
  ReportActionDto,
  ReportsQueryDto,
  RequestsQueryDto,
  ResolveRequestDto,
  StaffCommandsDto,
  StaffGiftsDto,
  BanChangeDto,
  RestrictionChangeDto,
  BotLogQueryDto,
  UserHistoryQueryDto,
  StaffRestrictDto,
  StaffRoomAccessDto,
  StaffRoomStatusDto,
  StaffRulesDto,
} from './chat.social.dto';
import { ChatStaffController } from './chat.staff.controller';
import { ChatStaffGuard, OpenToEveryUser } from './chat.staff.guard';

@Controller('social')
@UseGuards(ChatStaffGuard)
export class ChatStaffRoutes {
  constructor(private readonly controller: ChatStaffController) {}

  @Get('chat/staff/permissions')
  @OpenToEveryUser()
  permissions(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.permissions(req);
  }

  @Post('chat/staff/restrict')
  restrict(
    @Req() req: FastifyRequest,
    @Body(body) dto: StaffRestrictDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.restrict(req, dto);
  }

  @Post('chat/staff/restrictions/:restrictionId/lift')
  liftRestriction(
    @Req() req: FastifyRequest,
    @Param('restrictionId', new UuidParam('restrictionId')) id: string,
    @Body(body) dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.liftRestriction(req, id, dto);
  }

  @Post('chat/staff/bans/:banId/lift')
  liftBan(
    @Req() req: FastifyRequest,
    @Param('banId', new UuidParam('banId')) id: string,
    @Body(body) dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.liftBan(req, id, dto);
  }

  @Post('chat/staff/restrictions/:restrictionId/change')
  changeRestriction(
    @Req() req: FastifyRequest,
    @Param('restrictionId', new UuidParam('restrictionId')) id: string,
    @Body(body) dto: RestrictionChangeDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.changeRestriction(req, id, dto);
  }

  @Post('chat/staff/bans/:banId/change')
  changeBan(
    @Req() req: FastifyRequest,
    @Param('banId', new UuidParam('banId')) id: string,
    @Body(body) dto: BanChangeDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.changeBan(req, id, dto);
  }

  @Get('chat/staff/users/:userId/stats')
  userStats(
    @Req() req: FastifyRequest,
    @Param('userId', new UuidParam('userId')) userId: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.userStats(req, userId);
  }

  @Get('chat/staff/users/:userId/bot-log')
  botLog(
    @Req() req: FastifyRequest,
    @Param('userId', new UuidParam('userId')) userId: string,
    @Query(body) query: BotLogQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.botLog(req, userId, query);
  }

  /** "View User History": the user's history in other features (Faucet, SL…), within the role's features and days. */
  @Get('chat/staff/users/:userId/history')
  userHistory(
    @Req() req: FastifyRequest,
    @Param('userId', new UuidParam('userId')) userId: string,
    @Query(body) query: UserHistoryQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.userHistory(req, userId, query);
  }

  @Get('chat/staff/penalties')
  penalties(
    @Req() req: FastifyRequest,
    @Query(body) query: PenaltiesQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.listPenalties(req, query);
  }

  @Get('chat/staff/reports')
  reports(
    @Req() req: FastifyRequest,
    @Query(body) query: ReportsQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.reports(req, query);
  }

  @Post('chat/staff/reports/:reportId/action')
  actOnReport(
    @Req() req: FastifyRequest,
    @Param('reportId', new UuidParam('reportId')) id: string,
    @Body(body) dto: ReportActionDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.actOnReport(req, id, dto);
  }

  @Get('chat/staff/users/:userId/messages')
  userMessages(
    @Req() req: FastifyRequest,
    @Param('userId', new UuidParam('userId')) userId: string,
    @Query(body) query: HistoryQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.userMessages(req, userId, query);
  }

  @Get('chat/staff/users/:userId/tags')
  userTags(
    @Req() req: FastifyRequest,
    @Param('userId', new UuidParam('userId')) userId: string,
    @Query(body) query: HistoryQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.userTags(req, userId, query);
  }

  @Get('chat/staff/rooms/:roomId/history')
  roomHistory(
    @Req() req: FastifyRequest,
    @Param('roomId', new RoomParam()) roomId: string,
    @Query(body) query: HistoryQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.roomHistory(req, roomId, query);
  }

  @Post('chat/staff/rooms/:roomId/status')
  roomStatus(
    @Req() req: FastifyRequest,
    @Param('roomId', new RoomParam()) roomId: string,
    @Body(body) dto: StaffRoomStatusDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.roomStatus(req, roomId, dto);
  }

  @Post('chat/staff/rooms/:roomId/rules')
  roomRules(
    @Req() req: FastifyRequest,
    @Param('roomId', new RoomParam()) roomId: string,
    @Body(body) dto: StaffRulesDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.roomRules(req, roomId, dto);
  }

  @Post('chat/staff/rooms/:roomId/access')
  roomAccess(
    @Req() req: FastifyRequest,
    @Param('roomId', new RoomParam()) roomId: string,
    @Body(body) dto: StaffRoomAccessDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.roomAccess(req, roomId, dto);
  }

  @Post('chat/staff/commands')
  commands(
    @Req() req: FastifyRequest,
    @Body(body) dto: StaffCommandsDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.commands(req, dto);
  }

  @Post('chat/staff/gifts')
  gifts(
    @Req() req: FastifyRequest,
    @Body(body) dto: StaffGiftsDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.gifts(req, dto);
  }

  @Get('chat/staff/requests')
  requests(
    @Req() req: FastifyRequest,
    @Query(body) query: RequestsQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.requests(req, query);
  }

  @Post('chat/staff/requests/:requestId/resolve')
  resolveRequest(
    @Req() req: FastifyRequest,
    @Param('requestId', new UuidParam('requestId')) id: string,
    @Body(body) dto: ResolveRequestDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.resolveRequest(req, id, dto);
  }
}
