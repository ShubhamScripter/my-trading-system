/**
 * The admin chat controller: parses and validates each request with its DTO schema, calls the service and
 * wraps the result in the standard success envelope.
 *
 * Route paths and guards are in chat.routes.ts; business rules are in ChatService (rooms), ChatModerationService
 * (reports, bans, roles), ChatSkinService (skins, media) and ChatSettingsAdminService (chat-wide settings).
 */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ok, parseDto, type SuccessEnvelope } from '../../http';
import {
  ActionReportSchema,
  AssignRoleSchema,
  BroadcastSchema,
  CreateBanSchema,
  CreateRegionSchema,
  CreateRoomSchema,
  CreateSkinSchema,
  DeactivateSkinSchema,
  DeleteMediaSchema,
  DeleteRoomSchema,
  FlagMediaSchema,
  GetBansQuerySchema,
  GetFrequentHittersQuerySchema,
  GetMediaQuerySchema,
  GetRegionQuerySchema,
  GetReportsQuerySchema,
  GetRoomMessagesQuerySchema,
  GetRulesQuerySchema,
  GetSettingsChangesQuerySchema,
  RemoveRoleSchema,
  RetractMessageSchema,
  RollbackSettingsSchema,
  SaveSettingsSchema,
  UpsertTestEntitlementSchema,
  DeleteTestEntitlementSchema,
  ModerationActionsQuerySchema,
  UnbanSchema,
  UpdateRegionSchema,
  UpdateRoomAccessSchema,
  UpdateRoomRulesSchema,
  UpdateRoomSchema,
  ReportReasonsQuerySchema,
  UpsertReportReasonSchema,
} from './chat.dto';
import { ChatModerationService } from './services/chat-moderation.service';
import type { ModerationLogEntry } from './chat-moderation.dboperation';
import type { AdminHistoryMessage } from './chat-room.dboperation';
import { ChatSkinService } from './services/chat-skin.service';
import type { TestEntitlement } from './persistence/chat-staff.dboperation';
import { ChatService } from './chat.service';
import { ChatSettingsAdminService } from './services/chat.settings.service';
import { ChatModerationSettingsService } from './services/chat.moderation-settings.service';
import type {
  AdminRoom,
  ChatRegion,
  ChatReport,
  ChatSkin,
  ChatStaffRole,
  FrequentHitter,
  MediaUpload,
  PlatformStats,
  ReportReason,
  SettingsChange,
  UserBan,
} from './chat.types';

/** One method per admin chat route: validate the input, delegate, return `ok(...)`. */
@Injectable()
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly moderation: ChatModerationService,
    private readonly skins: ChatSkinService,
    private readonly settingsService: ChatSettingsAdminService,
    private readonly moderationSettings: ChatModerationSettingsService,
  ) {}

  // Stats
  async getStats(): Promise<SuccessEnvelope<{ stats: PlatformStats }>> {
    const stats = await this.chat.getStats();
    return ok({ stats });
  }

  // Rooms
  async getRooms(): Promise<SuccessEnvelope<{ rooms: AdminRoom[] }>> {
    const rooms = await this.chat.getRooms();
    return ok({ rooms });
  }

  async createRoom(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ id: string; slug: string }>> {
    const input = parseDto(CreateRoomSchema, body);
    const result = await this.chat.createRoom(input, adminId);
    return ok(result);
  }

  async updateRoom(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean; slug?: string; scheduled?: boolean; changeId?: string; effectiveAt?: string }>> {
    const input = parseDto(UpdateRoomSchema, body);
    const result = await this.chat.updateRoom(input, adminId);
    return ok(result);
  }

  async updateRoomAccess(body: unknown, adminId: string): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(UpdateRoomAccessSchema, body);
    return ok(await this.chat.updateRoomAccess(input, adminId));
  }

  async deleteRoom(body: unknown, adminId: string): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(DeleteRoomSchema, body);
    const result = await this.chat.deleteRoom(input.roomId, adminId);
    return ok(result);
  }

  async getRules(
    query: unknown,
  ): Promise<SuccessEnvelope<{ roomId: string; roomName: string; rules: string[] }>> {
    const { roomId } = parseDto(GetRulesQuerySchema, query);
    const result = await this.chat.getRules(roomId);
    return ok(result);
  }

  async updateRules(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(UpdateRoomRulesSchema, body);
    const result = await this.chat.updateRules(input, adminId);
    return ok(result);
  }

  async getRoomMessages(
    query: unknown,
  ): Promise<SuccessEnvelope<{ messages: AdminHistoryMessage[]; nextCursor: string | null }>> {
    const q = parseDto(GetRoomMessagesQuerySchema, query);
    // The older timestamp-only cursor is a cursor whose id sorts before every id: strictly before that time.
    const cursor = q.cursor ?? (q.before ? `${q.before}_00000000-0000-0000-0000-000000000000` : undefined);
    return ok(await this.chat.searchMessages({ ...q, cursor }));
  }

  // Reports
  async getReports(
    query: unknown,
  ): Promise<SuccessEnvelope<{ reports: ChatReport[]; nextCursor: string | null }>> {
    const input = parseDto(GetReportsQuerySchema, query);
    const reports = await this.moderation.getReports({
      status: input.status,
      reportedUserId: input.reportedUserId,
      before: input.before,
      cursor: input.cursor,
      limit: input.limit ?? 50,
    });
    // A full page means there may be more; the next page starts after the last row (time and id).
    const limit = input.limit ?? 50;
    const nextCursor = reports.length >= limit ? (reports.at(-1)?.cursor ?? null) : null;
    return ok({ reports, nextCursor });
  }

  async actionReport(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(ActionReportSchema, body);
    const result = await this.moderation.actionReport(input, adminId);
    return ok(result);
  }

  // Report reasons
  async getReportReasons(query: unknown = {}): Promise<SuccessEnvelope<{ reasons: ReportReason[] }>> {
    const reasons = await this.moderation.getReportReasons(parseDto(ReportReasonsQuerySchema, query).type ?? null);
    return ok({ reasons });
  }

  async upsertReportReason(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(UpsertReportReasonSchema, body);
    const result = await this.moderation.upsertReportReason(input, adminId);
    return ok(result);
  }

  // Bans
  async getBans(
    query: unknown,
  ): Promise<SuccessEnvelope<{ bans: UserBan[]; nextCursor: string | null }>> {
    const input = parseDto(GetBansQuerySchema, query);
    const bans = await this.moderation.getBans({
      before: input.before,
      cursor: input.cursor,
      limit: input.limit ?? 50,
      userId: input.userId,
      activeOnly: input.activeOnly ?? false,
    });
    const limit = input.limit ?? 50;
    const nextCursor = bans.length >= limit ? (bans.at(-1)?.cursor ?? null) : null;
    return ok({ bans, nextCursor });
  }

  async createBan(body: unknown, adminId: string): Promise<SuccessEnvelope<{ id: string }>> {
    const input = parseDto(CreateBanSchema, body);
    const result = await this.moderation.createBan(input, adminId);
    return ok(result);
  }

  async liftBan(body: unknown, adminId: string): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(UnbanSchema, body);
    const result = await this.moderation.liftBan(input, adminId);
    return ok(result);
  }

  // Staff roles
  async getStaffRoles(): Promise<SuccessEnvelope<{ roles: ChatStaffRole[] }>> {
    const roles = await this.moderation.getStaffRoles();
    return ok({ roles });
  }

  async assignRole(body: unknown, adminId: string): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(AssignRoleSchema, body);
    const result = await this.moderation.assignRole(input, adminId);
    return ok(result);
  }

  async removeRole(body: unknown, adminId: string): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(RemoveRoleSchema, body);
    const result = await this.moderation.removeRole(input, adminId);
    return ok(result);
  }

  // Regions
  async getRegions(): Promise<SuccessEnvelope<{ regions: ChatRegion[] }>> {
    const regions = await this.chat.getRegions();
    return ok({ regions });
  }

  async createRegion(body: unknown, adminId: string): Promise<SuccessEnvelope<{ id: string }>> {
    const input = parseDto(CreateRegionSchema, body);
    const result = await this.chat.createRegion(input, adminId);
    return ok(result);
  }

  async updateRegion(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(UpdateRegionSchema, body);
    const { regionId, ...data } = input;
    const result = await this.chat.updateRegion(regionId, data, adminId);
    return ok(result);
  }

  async deleteRegion(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { regionId } = parseDto(GetRegionQuerySchema, body);
    const result = await this.chat.deleteRegion(regionId, adminId);
    return ok(result);
  }

  // Skins
  async getSkins(): Promise<SuccessEnvelope<{ skins: ChatSkin[] }>> {
    const skins = await this.skins.getSkins();
    return ok({ skins });
  }

  async createSkin(body: unknown, adminId: string): Promise<SuccessEnvelope<{ id: string }>> {
    const input = parseDto(CreateSkinSchema, body);
    const result = await this.skins.createSkin(input, adminId);
    return ok(result);
  }

  async activateSkin(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(DeactivateSkinSchema, body);
    return ok(await this.skins.activateSkin(input.id, adminId));
  }

  async deactivateSkin(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(DeactivateSkinSchema, body);
    const result = await this.skins.deactivateSkin(input.id, adminId);
    return ok(result);
  }

  // Media uploads
  async getMediaUploads(query: unknown): Promise<SuccessEnvelope<{ uploads: MediaUpload[] }>> {
    const input = parseDto(GetMediaQuerySchema, query);
    const uploads = await this.skins.getMediaUploads({
      before: input.before,
      limit: input.limit ?? 50,
      flaggedOnly: input.flaggedOnly ?? false,
    });
    return ok({ uploads });
  }

  async flagMedia(body: unknown, adminId: string): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(FlagMediaSchema, body);
    const result = await this.skins.flagMedia(input, adminId);
    return ok(result);
  }

  async deleteMedia(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(DeleteMediaSchema, body);
    const result = await this.skins.deleteMedia(input, adminId);
    return ok(result);
  }

  // Broadcast
  async sendBroadcast(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean; dispatchedCount: number }>> {
    const input = parseDto(BroadcastSchema, body);
    const result = await this.chat.sendBroadcast(input, adminId);
    return ok(result);
  }

  // Retract
  async retractMessage(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const input = parseDto(RetractMessageSchema, body);
    const result = await this.chat.retractMessage(input.messageId, adminId, input.note);
    return ok(result);
  }

  // Frequent hitters
  async getFrequentHitters(
    query: unknown,
  ): Promise<SuccessEnvelope<{ hitters: FrequentHitter[] }>> {
    const { limit, sort, from, to } = parseDto(GetFrequentHittersQuerySchema, query);
    const hitters = await this.moderation.getFrequentHitters({ limit, sort, from: from ?? null, to: to ?? null });
    return ok({ hitters });
  }

  // Test-only stand-in facts
  async getTestEntitlements(): Promise<SuccessEnvelope<{ entitlements: TestEntitlement[] }>> {
    return ok({ entitlements: await this.moderation.getTestEntitlements() });
  }

  async upsertTestEntitlement(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean; userId: string }>> {
    return ok(
      await this.moderation.upsertTestEntitlement(
        parseDto(UpsertTestEntitlementSchema, body),
        adminId,
      ),
    );
  }

  async deleteTestEntitlement(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    return ok(
      await this.moderation.deleteTestEntitlement(
        parseDto(DeleteTestEntitlementSchema, body).userId,
        adminId,
      ),
    );
  }

  // Per-room moderation settings
  async getModerationSettings(roomId: string): Promise<SuccessEnvelope<Record<string, unknown>>> {
    return ok(await this.moderationSettings.get(roomId));
  }

  async saveModerationSettings(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    return ok(await this.moderationSettings.save(body, adminId));
  }

  // Moderation log
  async getModerationActions(
    query: unknown,
  ): Promise<SuccessEnvelope<{ actions: ModerationLogEntry[]; nextCursor: string | null }>> {
    const q = parseDto(ModerationActionsQuerySchema, query);
    return ok(
      await this.moderation.getModerationActions({
        before: q.before,
        limit: q.limit,
        actorType: q.actorType,
      }),
    );
  }

  // Settings
  async getSettings(): Promise<
    SuccessEnvelope<{ document: unknown; version: number; updatedAt: string }>
  > {
    const result = await this.settingsService.getDocument();
    return ok(result);
  }

  async saveSettings(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ changeId: string; applied: boolean }>> {
    const input = parseDto(SaveSettingsSchema, body);
    const result = await this.settingsService.savePatch({
      patch: input.patch,
      actorId: adminId,
      effectiveAt: input.effectiveAt,
    });
    return ok(result);
  }

  async rollbackSettings(
    body: unknown,
    adminId: string,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { changeId } = parseDto(RollbackSettingsSchema, body);
    const result = await this.settingsService.rollback(changeId, adminId);
    return ok(result);
  }

  async getSettingsChanges(
    query: unknown,
  ): Promise<SuccessEnvelope<{ changes: SettingsChange[] }>> {
    const input = parseDto(GetSettingsChangesQuerySchema, query);
    const changes = await this.settingsService.getChanges({
      before: input.before,
      limit: input.limit ?? 50,
      status: input.status ?? 'ALL',
    });
    return ok({ changes });
  }

  async previewSettings(query: unknown): Promise<SuccessEnvelope<{ settings: unknown }>> {
    const PreviewQuerySchema = z
      .object({
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
      })
      .strict();
    const { country } = parseDto(PreviewQuerySchema, query);
    const settings = await this.settingsService.preview(country);
    return ok({ settings });
  }
}
