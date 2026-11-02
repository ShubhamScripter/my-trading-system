/** Admin service for chat rooms: manages room lifecycle, access rules, history, and broadcasts. */
import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { ChatModerationDbOperation } from './chat-moderation.dboperation';
import { ChatRegionDbOperation } from './persistence/chat-region.dboperation';
import { ChatRoomDbOperation, type AdminHistoryMessage } from './chat-room.dboperation';
import { defaultIneligibleMode } from './chat.constants';
import type {
  BroadcastInput,
  CreateRegionInput,
  CreateRoomInput,
  UpdateRoomAccessInput,
  UpdateRoomInput,
  UpdateRoomRulesInput,
} from './chat.dto';
import type { AdminRoom, ChatRegion, PlatformStats } from './chat.types';
import { ChatUtility } from './chat.utility';
import { RoomPatchSchema } from './chat.contract';

/** The author of system alerts and admin broadcasts: never an admin's id, which users must not learn. */
const SYSTEM_AUTHOR_ID = '00000000-0000-0000-0000-000000000000';

/** What an admin can do to rooms. */
@Injectable()
export class ChatService {
  private readonly logger = new Logger('ChatService');

  constructor(
    private readonly rooms: ChatRoomDbOperation,
    private readonly moderation: ChatModerationDbOperation,
    private readonly regions: ChatRegionDbOperation,
  ) {}

  // Dashboard
  getStats(): Promise<PlatformStats> {
    return this.rooms.getPlatformStats();
  }

  // Rooms
  getRooms(): Promise<AdminRoom[]> {
    return this.rooms.getRooms();
  }

  async createRoom(dto: CreateRoomInput, adminId: string): Promise<{ id: string; slug: string }> {
    const slug = ChatUtility.slugify(dto.slug ?? ChatUtility.slugify(dto.name));
    // The slug must still have at least two characters after cleaning.
    if (!slug || slug.length < 2) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: `Room name '${dto.name}' produces an invalid slug; provide a valid slug explicitly`,
      });
    }
    if (await this.rooms.getRoomBySlug(slug)) {
      throw new ProblemException({
        type: ERR.CHAT_ROOM_SLUG_EXISTS,
        detail: `A room with slug '${slug}' already exists`,
      });
    }

    const id = ChatUtility.generateUuid();
    await this.rooms.createRoom({
      id,
      slug,
      name: dto.name,
      description: dto.description,
      type: dto.type,
      status: dto.status,
      statusNote: dto.statusNote,
      statusUntil: dto.statusUntil,
      language: dto.language,
      rules: dto.rules,
      contentControls: {
        allowText: dto.contentControls.allowText ?? true,
        allowEmoji: dto.contentControls.allowEmoji ?? true,
        allowGif: dto.contentControls.allowGif ?? true,
        allowImage: dto.contentControls.allowImage ?? false,
        allowVideo: dto.contentControls.allowVideo ?? false,
        autoModeration: dto.contentControls.autoModeration ?? true,
        allowCommands: dto.contentControls.allowCommands ?? false,
        commands: dto.contentControls.commands ?? [],
        allowAds: dto.contentControls.allowAds ?? false,
      },
      linksPolicy: dto.linksPolicy,
      bannedWords: dto.bannedWords,
      ...(dto.casino ? { casino: dto.casino } : {}),
      access: {
        ...dto.access,
        ineligibleMode: dto.access.ineligibleMode ?? defaultIneligibleMode(dto.type),
      },
    });

    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'CREATE_ROOM',
      targetRoomId: id,
      newValue: { name: dto.name, slug, type: dto.type },
    });
    // Tell the chat server a new room exists, so open room lists refresh.
    await this.moderation.notify({ kind: 'room', roomId: id });

    this.logger.log({ adminId, roomId: id, slug }, 'chat room created');
    return { id, slug };
  }

  async updateRoom(
    dto: UpdateRoomInput,
    adminId: string,
  ): Promise<{ success: boolean; slug?: string; scheduled?: boolean; changeId?: string; effectiveAt?: string }> {
    const room = await this.rooms.getRoomById(dto.roomId);
    if (!room) {
      throw new ProblemException({
        type: ERR.CHAT_ROOM_NOT_FOUND,
        detail: `Room ${dto.roomId} not found`,
      });
    }
    // A deleted room stays deleted; editing it must not look like it worked.
    if (room.deleted_at) {
      throw new ProblemException({
        type: ERR.CHAT_ROOM_NOT_FOUND,
        detail: 'This room was deleted and can no longer be edited',
      });
    }

    let slug = dto.slug;
    if (slug !== undefined) {
      slug = ChatUtility.slugify(slug);
      if (!slug || slug.length < 2) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          detail: 'Provided slug is invalid after normalization',
        });
      }
      if (slug !== room.slug) {
        const existing = await this.rooms.getRoomBySlug(slug);
        if (existing && existing.id !== dto.roomId) {
          throw new ProblemException({
            type: ERR.CHAT_ROOM_SLUG_EXISTS,
            detail: `Slug '${slug}' already taken`,
          });
        }
      }
    }

    // "ON / OFF / MAINTENANCE (Can be scheduled)": a future time is kept for the chat server, decided on the
    // database clock.
    if (dto.effectiveAt) {
      const at = new Date(dto.effectiveAt);
      if (at > (await this.rooms.dbNow())) {
        const changeId = await this.scheduleRoomUpdate({ ...dto, slug }, room.config ?? {}, at, adminId);
        return { success: true, slug, scheduled: true, changeId, effectiveAt: at.toISOString() };
      }
    }

    await this.rooms.updateRoom({ ...dto, slug });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'UPDATE_ROOM',
      targetRoomId: dto.roomId,
      newValue: { slug, status: dto.status },
    });
    await this.moderation.notify({ kind: 'room', roomId: dto.roomId });
    return { success: true, slug };
  }

  /** The room update as a RoomPatch (shared contract) the chat server applies at `at`. */
  private async scheduleRoomUpdate(
    dto: UpdateRoomInput,
    current: Record<string, unknown>,
    at: Date,
    adminId: string,
  ): Promise<string> {
    const room: Record<string, unknown> = {};
    if (dto.name !== undefined) room.name = dto.name;
    if (dto.slug !== undefined) room.slug = dto.slug;
    if (dto.description !== undefined) room.description = dto.description;
    if (dto.type !== undefined) room.type = dto.type;
    const config: Record<string, unknown> = {};
    if (dto.status !== undefined) config.status = dto.status;
    if (typeof dto.statusNote === 'string') config.statusNote = dto.statusNote;
    if (typeof dto.statusUntil === 'string') config.statusUntil = dto.statusUntil;
    if (typeof dto.language === 'string') config.language = dto.language;
    if (dto.rules !== undefined) config.rules = dto.rules;
    if (dto.contentControls !== undefined) {
      // A config key replaces the stored one, so the whole set of controls goes in the change.
      const stored = (current.contentControls ?? {}) as Record<string, unknown>;
      config.contentControls = { ...stored, ...dto.contentControls };
    }
    if (dto.controlsMaintenance !== undefined) config.controlsMaintenance = dto.controlsMaintenance;
    if (typeof dto.linksPolicy === 'string') config.linksPolicy = dto.linksPolicy;
    if (dto.bannedWords !== undefined) config.bannedWords = dto.bannedWords;
    if (dto.casino) config.casino = dto.casino;
    const patch = RoomPatchSchema.safeParse({
      ...(Object.keys(room).length ? { room } : {}),
      ...(Object.keys(config).length ? { config } : {}),
    });
    if (!patch.success || Object.keys(patch.data).length === 0) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: patch.success
          ? 'Nothing to schedule'
          : patch.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const changeId = ChatUtility.generateUuid();
    await this.rooms.scheduleRoomChange({ id: changeId, roomId: dto.roomId, actorId: adminId, patch: patch.data, effectiveAt: at });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'SCHEDULE_ROOM_CHANGE',
      targetRoomId: dto.roomId,
      newValue: { changeId, effectiveAt: at.toISOString(), patch: patch.data },
    });
    return changeId;
  }

  // Updates room access rule with audit trail.
  async updateRoomAccess(dto: UpdateRoomAccessInput, adminId: string): Promise<{ success: boolean }> {
    const room = await this.rooms.getRoomById(dto.roomId);
    if (!room || room.deleted_at) {
      throw new ProblemException({ type: ERR.CHAT_ROOM_NOT_FOUND, detail: `Room ${dto.roomId} not found` });
    }
    await this.rooms.updateRoom({ roomId: dto.roomId, access: dto.access });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'UPDATE_ROOM_ACCESS',
      targetRoomId: dto.roomId,
      newValue: { access: dto.access },
    });
    await this.moderation.notify({ kind: 'room', roomId: dto.roomId });
    return { success: true };
  }

  async deleteRoom(roomId: string, adminId: string): Promise<{ success: boolean }> {
    if (!(await this.rooms.getRoomById(roomId))) {
      throw new ProblemException({
        type: ERR.CHAT_ROOM_NOT_FOUND,
        detail: `Room ${roomId} not found`,
      });
    }
    // Delete hides the room for good (soft delete); it is not the same as the DISABLED status.
    await this.rooms.softDeleteRoom(roomId);
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'DELETE_ROOM',
      targetRoomId: roomId,
    });
    await this.moderation.notify({ kind: 'room', roomId });
    return { success: true };
  }

  getRules(roomId: string): Promise<{ roomId: string; roomName: string; rules: string[] }> {
    return this.rooms.getRoomRules(roomId);
  }

  async updateRules(dto: UpdateRoomRulesInput, adminId: string): Promise<{ success: boolean }> {
    if (!(await this.rooms.getRoomById(dto.roomId))) {
      throw new ProblemException({
        type: ERR.CHAT_ROOM_NOT_FOUND,
        detail: `Room ${dto.roomId} not found`,
      });
    }
    await this.rooms.updateRoomRules(dto.roomId, dto.rules);
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'UPDATE_RULES',
      targetRoomId: dto.roomId,
      newValue: { rules: dto.rules },
    });
    await this.moderation.notify({ kind: 'room', roomId: dto.roomId });
    return { success: true };
  }

  /** Message history of a room, a user (username, public code or internal id) or both; see ChatRoomDbOperation.searchMessages. */
  async searchMessages(query: {
    roomId?: string;
    userId?: string;
    from?: string;
    to?: string;
    type?: string;
    sort: 'asc' | 'desc';
    cursor?: string;
    limit: number;
  }): Promise<{ messages: AdminHistoryMessage[]; nextCursor: string | null }> {
    let userId: string | undefined;
    if (query.userId) {
      const resolved = await this.moderation.resolveUserId(query.userId);
      if (!resolved) {
        throw new ProblemException({ type: ERR.NOT_FOUND, detail: `User '${query.userId}' not found` });
      }
      userId = resolved;
    }
    return this.rooms.searchMessages({ ...query, userId });
  }

  // Regions
  getRegions(): Promise<ChatRegion[]> {
    return this.regions.getRegions();
  }

  async createRegion(dto: CreateRegionInput, adminId: string): Promise<{ id: string }> {
    const id = ChatUtility.generateUuid();
    await this.regions.createRegion({ id, name: dto.name, countries: dto.countries });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'CREATE_REGION',
      newValue: { regionId: id, ...dto },
    });
    return { id };
  }

  async updateRegion(
    regionId: string,
    data: { name?: string; countries?: string[] },
    adminId: string,
  ): Promise<{ success: boolean }> {
    if (!(await this.regions.updateRegion(regionId, data))) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: `Region ${regionId} not found` });
    }
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'UPDATE_REGION',
      newValue: { regionId, ...data },
    });
    return { success: true };
  }

  async deleteRegion(regionId: string, adminId: string): Promise<{ success: boolean }> {
    if (!(await this.regions.deleteRegion(regionId))) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: `Region ${regionId} not found` });
    }
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'DELETE_REGION',
      newValue: { regionId },
    });
    return { success: true };
  }

  // Broadcast and retract
  async sendBroadcast(
    dto: BroadcastInput,
    adminId: string,
  ): Promise<{ success: boolean; dispatchedCount: number }> {
    let roomIds: string[];
    if (dto.roomId) {
      if (!(await this.rooms.getRoomById(dto.roomId))) {
        throw new ProblemException({
          type: ERR.CHAT_ROOM_NOT_FOUND,
          detail: `Room ${dto.roomId} not found`,
        });
      }
      roomIds = [dto.roomId];
    } else {
      // Every room that is neither deleted nor disabled.
      roomIds = await this.rooms.getActiveRoomIds();
    }

    // Broadcast alerts across rooms in a single transaction with audit logging.
    const broadcastId = ChatUtility.generateUuid();
    if (roomIds.length > 0) {
      await this.moderation.createBroadcast({
        broadcastId,
        roomIds,
        userId: SYSTEM_AUTHOR_ID,
        content: `[${dto.title}] ${dto.content}`,
        metadata: { broadcast: true, alertType: dto.type, priority: dto.priority ?? 'NORMAL', title: dto.title },
        audit: { actorId: adminId, action: 'BROADCAST', newValue: { type: dto.type, title: dto.title, roomIds } },
      });
      await this.moderation.notify({ kind: 'alert', broadcastId });
    }
    return { success: true, dispatchedCount: roomIds.length };
  }

  async retractMessage(
    messageId: string,
    adminId: string,
    note: string,
  ): Promise<{ success: boolean }> {
    const retracted = await this.moderation.retractMessage(messageId, adminId);
    if (!retracted) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: `Message ${messageId} not found or already retracted`,
      });
    }

    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'RETRACT',
      targetUserId: retracted.userId,
      targetRoomId: retracted.roomId,
      targetMessageId: messageId,
      targetMessageCreatedAt: retracted.createdAt,
      note,
    });
    // Open chats see the retraction at once, and only the author gets the note.
    await this.moderation.notify({
      kind: 'retract',
      messageId,
      roomId: retracted.roomId,
      retractedAt: retracted.retractedAt.toISOString(),
    });
    await this.moderation.notify({
      kind: 'notice',
      userId: retracted.userId,
      notice: { action: 'retract', roomId: retracted.roomId, messageId, note },
    });
    return { success: true };
  }
}
