/**
 * The chat HTTP route table: paths, methods, input pipes and guards. Declarative, no logic.
 *
 * Every handler hands its parsed input to ChatController, which turns the signed-in principal into a chat user and
 * calls the services. The platform's AuthGuard protects every route except the signed media link (`@Public`).
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  type PipeTransform,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../../auth/security/guards';
import { ERR } from '../../contracts';
import { ProblemException, type SuccessEnvelope } from '../../http';
import { LIMITS } from './chat.constants';
import { ChatController } from './chat.controller';
import {
  BanUserDto,
  GetMessagesQueryDto,
  MembersQueryDto,
  NoteBodyDto,
  LimitationsQueryDto,
  ReportReasonsQueryDto,
  PageQueryDto,
  PreferencesQueryDto,
  ReportDto,
  SendMediaMessageDto,
  UpdateChatPreferenceDto,
  WarnUserDto,
} from './chat.dto';
import { isUuid } from './chat.utility';
import { WsValidationPipe } from './chat.ws.pipe';

export const body = new WsValidationPipe();

/** A path id that must be a UUID; anything else is the caller's mistake (400), never a server error. */
export class UuidParam implements PipeTransform<string, string> {
  constructor(private readonly name: string) {}
  transform(value: string): string {
    if (!isUuid(value)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: this.name, message: 'Must be a UUID' }],
      });
    }
    return value.toLowerCase();
  }
}

/** A room path segment: UUID or slug, 1 to 128 characters. */
export class RoomParam implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > LIMITS.ROOM_REF_CHARS) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'roomId', message: 'A room id or slug' }],
      });
    }
    return value;
  }
}

/** A user handle: id, username or login code. */
export class HandleParam implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'userId', message: 'A user id, username or login code' }],
      });
    }
    return value;
  }
}

/**
 * The HTTP surface of chat. The platform's AuthGuard authenticates every route; chat turns the principal into a live
 * chat user. Messages sent here go through the same `ChatService.sendMessage` as the socket and are delivered by the
 * one delivery path (chat.delivery.ts).
 */

@Controller('social')
export class ChatRoutes {
  constructor(private readonly controller: ChatController) {}

  @Get('chat/rooms')
  rooms(
    @Req() req: FastifyRequest,
    @Query(body) query: PageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.rooms(req, query);
  }

  @Get('chat/rooms/:roomId/rules')
  rules(
    @Req() req: FastifyRequest,
    @Param('roomId', new RoomParam()) roomId: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.rules(req, roomId);
  }

  @Get('chat/rooms/:roomId/users')
  members(
    @Req() req: FastifyRequest,
    @Param('roomId', new RoomParam()) roomId: string,
    @Query(body) query: MembersQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.members(req, roomId, query);
  }

  @Get('chat/rooms/:roomId/messages')
  messages(
    @Req() req: FastifyRequest,
    @Param('roomId', new RoomParam()) roomId: string,
    @Query(body) query: GetMessagesQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.messages(req, roomId, query);
  }

  @Get('chat/rooms/:roomId/pinned')
  pinned(
    @Req() req: FastifyRequest,
    @Param('roomId', new RoomParam()) roomId: string,
    @Query(body) query: PageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.pinned(req, roomId, query);
  }

  @Get('chat/users/:userId/profile')
  profile(
    @Req() req: FastifyRequest,
    @Param('userId', new HandleParam()) handle: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.profile(req, handle);
  }

  @Post('chat/users/:userId/report')
  reportUser(
    @Req() req: FastifyRequest,
    @Param('userId', new HandleParam()) handle: string,
    @Body(body) dto: ReportDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.reportUser(req, handle, dto);
  }

  @Get('chat/preferences')
  preferences(
    @Req() req: FastifyRequest,
    @Query(body) query: PreferencesQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.preferences(req, query);
  }

  @Put('chat/preferences')
  updatePreferences(
    @Req() req: FastifyRequest,
    @Body(body) dto: UpdateChatPreferenceDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.updatePreferences(req, dto);
  }

  @Get('chat/skins')
  skins(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.skins(req);
  }

  @Post('chat/messages/media')
  sendMedia(
    @Req() req: FastifyRequest,
    @Body(body) dto: SendMediaMessageDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.sendMedia(req, dto);
  }

  /** Retracting keeps the message for staff ("visible to mods / team with retracted tag"); nothing is deleted. */
  @Post('chat/messages/:messageId/retract')
  retract(
    @Req() req: FastifyRequest,
    @Param('messageId', new UuidParam('messageId')) messageId: string,
    @Body(body) dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.retract(req, messageId, dto);
  }

  @Post('chat/messages/:messageId/report')
  reportMessage(
    @Req() req: FastifyRequest,
    @Param('messageId', new UuidParam('messageId')) messageId: string,
    @Body(body) dto: ReportDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.reportMessage(req, messageId, dto);
  }

  @Get('chat/report-reasons')
  reportReasons(
    @Req() req: FastifyRequest,
    @Query(body) query: ReportReasonsQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.reportReasons(req, query);
  }

  @Get('chat/tags')
  tags(
    @Req() req: FastifyRequest,
    @Query(body) query: PageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.tags(req, query);
  }

  @Get('chat/limitations')
  limitations(
    @Req() req: FastifyRequest,
    @Query(body) query: LimitationsQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.myLimitations(req, query);
  }

  @Get('chat/warnings')
  warnings(
    @Req() req: FastifyRequest,
    @Query(body) query: PageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.warnings(req, query);
  }

  @Post('chat/staff/warn')
  warn(
    @Req() req: FastifyRequest,
    @Body(body) dto: WarnUserDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.warn(req, dto);
  }

  @Post('chat/staff/ban')
  ban(@Req() req: FastifyRequest, @Body(body) dto: BanUserDto): Promise<SuccessEnvelope<unknown>> {
    return this.controller.ban(req, dto);
  }

  @Post('chat/messages/:messageId/pin')
  pin(
    @Req() req: FastifyRequest,
    @Param('messageId', new UuidParam('messageId')) messageId: string,
    @Body(body) dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.pin(req, messageId, dto);
  }

  @Post('chat/messages/:messageId/unpin')
  unpin(
    @Req() req: FastifyRequest,
    @Param('messageId', new UuidParam('messageId')) messageId: string,
    @Body(body) dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.unpin(req, messageId, dto);
  }

  /** Upload one image (multipart). Returns the chat media URL to send; the file is never served publicly. */
  @Post('chat/upload')
  upload(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.upload(req);
  }

  /**
   * An upload, by its signed link only: chat hands signed links to the people who may view the message, so
   * an <img> loads it without the session cookie being refreshed on that request. Its stored type, never sniffed by
   * the browser. 410 when removed.
   */
  @Public()
  @Get('chat/media/:mediaId')
  media(
    @Param('mediaId', new UuidParam('mediaId')) mediaId: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    return this.controller.media(mediaId, exp, sig, reply);
  }
}
