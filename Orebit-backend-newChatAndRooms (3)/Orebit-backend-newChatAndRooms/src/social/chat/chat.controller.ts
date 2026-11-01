/** HTTP controller for chat: handles rooms, messages, reports, uploads, and account preferences. */
import { Injectable, StreamableFile } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config';
import { ERR } from '../../contracts';
import { ok, ProblemException, type SuccessEnvelope } from '../../http';
import { ChatAccessService } from './chat.access.service';
import { ChatAccountService } from './services/chat.account.service';
import { ChatAuthHelper } from './chat.auth.helper';
import { LIMITS } from './chat.constants';
import type {
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
import { ChatDelivery } from './realtime/chat.delivery';
import { ChatReportService, ChatStaffService } from './services/chat.staff.service';
import { ChatStaffGroupService } from './services/chat.staff.group.service';
import { ChatReadService } from './services/chat.read.service';
import { ChatLimitationsService } from './services/chat.limitations.service';
import { ChatService } from './chat.service';
import { mediaLinkValid, type UploadedFilePart } from './chat.upload';
import { reasonsOf } from './chat.reasons';
import { clientIp } from './chat.utility';
import { isRequested } from './services/chat.staff.gate';

/** One method per chat route, called by ChatRoutes with already-validated input. */
@Injectable()
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly read: ChatReadService,
    private readonly account: ChatAccountService,
    private readonly access: ChatAccessService,
    private readonly reports: ChatReportService,
    private readonly staff: ChatStaffService,
    private readonly groups: ChatStaffGroupService,
    private readonly auth: ChatAuthHelper,
    private readonly delivery: ChatDelivery,
    private readonly limitations: ChatLimitationsService,
  ) {}

  async rooms(req: FastifyRequest, query: PageQueryDto): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    return ok(await this.chat.listRooms(user, query.limit, query.cursor ?? null));
  }

  async rules(req: FastifyRequest, roomId: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.chat.rules(await this.auth.getChatUser(req), roomId));
  }

  async members(
    req: FastifyRequest,
    roomId: string,
    query: MembersQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.chat.members(await this.auth.getChatUser(req), roomId, query));
  }

  async messages(
    req: FastifyRequest,
    roomId: string,
    query: GetMessagesQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.read.history(await this.auth.getChatUser(req), roomId, query));
  }

  async pinned(
    req: FastifyRequest,
    roomId: string,
    query: PageQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.read.pinned(await this.auth.getChatUser(req), roomId, query));
  }

  async profile(req: FastifyRequest, handle: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.account.profile(await this.auth.getChatUser(req), handle));
  }

  async reportUser(
    req: FastifyRequest,
    handle: string,
    dto: ReportDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.reports.reportUser(await this.auth.getChatUser(req), handle, dto));
  }

  async preferences(
    req: FastifyRequest,
    query: PreferencesQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(
      await this.account.preferences(await this.auth.getChatUser(req), query.lastRoomId ?? null),
    );
  }

  async updatePreferences(
    req: FastifyRequest,
    dto: UpdateChatPreferenceDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.account.updatePreferences(await this.auth.getChatUser(req), dto));
  }

  async skins(req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok({ items: await this.account.skins(await this.auth.getChatUser(req)) });
  }

  async sendMedia(
    req: FastifyRequest,
    dto: SendMediaMessageDto,
  ): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    const result = await this.chat.sendMessage(
      user,
      {
        roomRef: dto.roomId,
        media: {
          url: dto.mediaUrl,
          type: dto.mediaType,
          ...(dto.caption !== undefined ? { caption: dto.caption } : {}),
          ...(dto.thumbnailUrl !== undefined ? { thumbnailUrl: dto.thumbnailUrl } : {}),
        },
        ...(dto.skinId ? { skinId: dto.skinId } : {}),
        ...(dto.clientMessageId ? { clientMessageId: dto.clientMessageId } : {}),
      },
      { ip: clientIp(req.headers['x-forwarded-for'], req.ip, config.trustedProxies) },
    );
    if (!result.duplicate) {
      this.delivery.publish(result.row);
      this.delivery.notifyTagged(result.row, result.taggedUserIds);
    }
    return ok({ messageId: result.row.id, createdAt: result.row.createdAt.toISOString() });
  }

  /** Retracting keeps the message for staff ("visible to mods / team with retracted tag"); nothing is deleted. */
  async retract(
    req: FastifyRequest,
    messageId: string,
    dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    const result = await this.chat.retract(
      await this.auth.getChatUser(req),
      messageId,
      dto.note ?? null,
    );
    if (!isRequested(result)) this.delivery.publishRetracted(result);
    return ok(result);
  }

  async reportMessage(
    req: FastifyRequest,
    messageId: string,
    dto: ReportDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.reports.reportMessage(await this.auth.getChatUser(req), messageId, dto));
  }

  async reportReasons(req: FastifyRequest, query: ReportReasonsQueryDto): Promise<SuccessEnvelope<unknown>> {
    await this.auth.getChatUser(req);
    return ok({ items: await this.reports.reportReasons(query.type) });
  }

  async tags(req: FastifyRequest, query: PageQueryDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.read.tags(await this.auth.getChatUser(req), query));
  }

  async myLimitations(req: FastifyRequest, query: LimitationsQueryDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.limitations.list(await this.auth.getChatUser(req), query));
  }

  async warnings(req: FastifyRequest, query: PageQueryDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.read.warnings(await this.auth.getChatUser(req), query));
  }

  /** One user, or a group (exactly one of `userId` and `group`). */
  private oneTarget(dto: { userId?: string; group?: unknown }): void {
    if ((dto.userId === undefined) === (dto.group === undefined)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'userId', message: 'Give userId or group, not both and not neither' }],
      });
    }
  }

  async warn(req: FastifyRequest, dto: WarnUserDto): Promise<SuccessEnvelope<unknown>> {
    const staff = await this.auth.getChatUser(req);
    this.oneTarget(dto);
    const roomId = await this.roomIdOf(dto.roomId);
    if (dto.group) return ok(await this.groups.warn(staff, { group: dto.group, roomId, ...reasonsOf(dto) }));
    return ok(await this.staff.staffWarn(staff, { userId: dto.userId!, roomId, ...reasonsOf(dto) }));
  }

  async ban(req: FastifyRequest, dto: BanUserDto): Promise<SuccessEnvelope<unknown>> {
    const staff = await this.auth.getChatUser(req);
    this.oneTarget(dto);
    const length = {
      ...(dto.durationHours !== undefined ? { durationHours: dto.durationHours } : {}),
      ...(dto.permanent ? { permanent: true } : {}),
    };
    const roomId = await this.roomIdOf(dto.roomId);
    if (dto.group) return ok(await this.groups.ban(staff, { group: dto.group, roomId, ...reasonsOf(dto), ...length }));
    return ok(await this.staff.staffBan(staff, { userId: dto.userId!, roomId, ...reasonsOf(dto), ...length }));
  }

  async pin(
    req: FastifyRequest,
    messageId: string,
    dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(
      await this.staff.staffPin(
        await this.auth.getChatUser(req),
        messageId,
        true,
        dto.note ?? null,
      ),
    );
  }

  async unpin(
    req: FastifyRequest,
    messageId: string,
    dto: NoteBodyDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(
      await this.staff.staffPin(
        await this.auth.getChatUser(req),
        messageId,
        false,
        dto.note ?? null,
      ),
    );
  }

  /** Upload one image (multipart). Returns the chat media URL to send; the file is never served publicly. */
  async upload(req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    const multipart = req as FastifyRequest & {
      file?: () => Promise<UploadedFilePart | undefined>;
    };
    const part = multipart.file ? await multipart.file() : undefined;
    // The room the file is for: it must allow this media type, or nothing is stored (no orphan uploads).
    const roomRef = (req.query as Record<string, unknown> | undefined)?.roomId;
    return ok(
      await this.account.upload(
        user,
        part,
        typeof roomRef === 'string' && roomRef.length <= LIMITS.ROOM_REF_CHARS ? roomRef : null,
      ),
    );
  }

  /** Streams uploaded media using signed URL validation without session cookie refresh. */
  async media(
    mediaId: string,
    exp: string | undefined,
    sig: string | undefined,
    reply: FastifyReply,
  ): Promise<StreamableFile> {
    if (!mediaLinkValid(mediaId, exp, sig)) {
      throw new ProblemException({
        type: ERR.UNAUTHENTICATED,
        detail: 'This media link is not valid or has expired',
      });
    }
    const file = await this.account.media(mediaId);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, max-age=300');
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.size,
      disposition: 'inline',
    });
  }

  private async roomIdOf(ref: string | undefined): Promise<string | null> {
    return ref === undefined ? null : (await this.access.requireRoom(ref)).id;
  }
}
