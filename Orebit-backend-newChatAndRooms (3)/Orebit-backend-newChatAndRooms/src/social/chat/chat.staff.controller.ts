/**
 * The Module 4 staff tools over HTTP: what the signed-in staff member may do, restrictions, penalties, the report
 * queue, history, room controls, roles, chat-wide commands and the requests lower roles filed. Paths are in
 * chat.staff.routes.ts. A REPORT-mode action answers `{ requested: true, requestId }` instead of acting.
 */
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ok, type SuccessEnvelope } from '../../http';
import { ChatAuthHelper } from './chat.auth.helper';
import type { NoteBodyDto } from './chat.dto';
import type {
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
import type { ChatUserContext } from './chat.types';
import { ChatStaffInsightService } from './services/chat.staff.insight.service';
import { ChatStaffPenaltiesService } from './services/chat.staff.penalties.service';
import { ChatStaffQueueService } from './services/chat.staff.queue.service';
import { ChatStaffRequestsService } from './services/chat.staff.requests.service';
import { ChatStaffToolsService } from './services/chat.staff.tools.service';

@Injectable()
export class ChatStaffController {
  constructor(
    private readonly auth: ChatAuthHelper,
    private readonly tools: ChatStaffToolsService,
    private readonly penalties: ChatStaffPenaltiesService,
    private readonly queue: ChatStaffQueueService,
    private readonly staffRequests: ChatStaffRequestsService,
    private readonly insight: ChatStaffInsightService,
  ) {}

  private user(req: FastifyRequest): Promise<ChatUserContext> {
    return this.auth.getChatUser(req);
  }

  async permissions(req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.tools.permissions(await this.user(req)));
  }

  async restrict(req: FastifyRequest, dto: StaffRestrictDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.tools.restrict(await this.user(req), dto));
  }

  async liftRestriction(
    req: FastifyRequest,
    id: string,
    dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.penalties.liftRestriction(await this.user(req), id, dto.note ?? null));
  }

  async liftBan(
    req: FastifyRequest,
    id: string,
    dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.penalties.liftBan(await this.user(req), id, dto.note ?? null));
  }

  async changeRestriction(
    req: FastifyRequest,
    id: string,
    dto: RestrictionChangeDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.penalties.changeRestriction(await this.user(req), id, dto));
  }

  async changeBan(
    req: FastifyRequest,
    id: string,
    dto: BanChangeDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.penalties.changeBan(await this.user(req), id, dto));
  }

  async userStats(req: FastifyRequest, userId: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.insight.userStats(await this.user(req), userId));
  }

  async botLog(
    req: FastifyRequest,
    userId: string,
    query: BotLogQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.insight.botLog(await this.user(req), userId, query));
  }

  async userHistory(
    req: FastifyRequest,
    userId: string,
    query: UserHistoryQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.insight.userHistory(await this.user(req), userId, query));
  }

  async listPenalties(
    req: FastifyRequest,
    query: PenaltiesQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.penalties.penalties(await this.user(req), query));
  }

  async reports(req: FastifyRequest, query: ReportsQueryDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.queue.reports(await this.user(req), query));
  }

  async actOnReport(
    req: FastifyRequest,
    id: string,
    dto: ReportActionDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.queue.actOnReport(await this.user(req), id, dto));
  }

  async userMessages(
    req: FastifyRequest,
    userId: string,
    query: HistoryQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.queue.userMessages(await this.user(req), userId, query));
  }

  async userTags(
    req: FastifyRequest,
    userId: string,
    query: HistoryQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.queue.userTags(await this.user(req), userId, query));
  }

  async roomHistory(
    req: FastifyRequest,
    roomId: string,
    query: HistoryQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.queue.roomHistory(await this.user(req), roomId, query));
  }

  async roomStatus(
    req: FastifyRequest,
    roomId: string,
    dto: StaffRoomStatusDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.tools.setRoomStatus(await this.user(req), roomId, dto));
  }

  async roomRules(
    req: FastifyRequest,
    roomId: string,
    dto: StaffRulesDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.tools.setRules(await this.user(req), roomId, dto));
  }

  async roomAccess(
    req: FastifyRequest,
    roomId: string,
    dto: StaffRoomAccessDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.tools.setRoomAccess(await this.user(req), roomId, dto));
  }

  async commands(req: FastifyRequest, dto: StaffCommandsDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.tools.setChatCommands(await this.user(req), dto));
  }

  async gifts(req: FastifyRequest, dto: StaffGiftsDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.tools.setGiftsEnabled(await this.user(req), dto));
  }

  async requests(req: FastifyRequest, query: RequestsQueryDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.staffRequests.requests(await this.user(req), query));
  }

  async resolveRequest(
    req: FastifyRequest,
    id: string,
    dto: ResolveRequestDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.staffRequests.resolveRequest(await this.user(req), id, dto));
  }
}
