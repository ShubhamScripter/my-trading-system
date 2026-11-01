import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requirePrincipal, SuperAdminGuard } from '../../../auth/security/guards';
import { type SuccessEnvelope } from '../../http';

import { ChatController } from './chat.controller';
import { ChatAuthorityService } from './services/chat-authority.service';
import type { ModerationLogEntry } from './chat-moderation.dboperation';
import type { AdminHistoryMessage } from './chat-room.dboperation';
import type { TestEntitlement } from './persistence/chat-staff.dboperation';
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

/** Admin chat HTTP routes with role-based authorization and moderation action auditing. */
@Controller('social/chat')
export class ChatRoutes {
  constructor(
    private readonly controller: ChatController,
    private readonly authority: ChatAuthorityService,
  ) { }

  // Stats
  @Get('stats')
  async getStats(): Promise<SuccessEnvelope<{ stats: PlatformStats }>> {
    return this.controller.getStats();
  }

  // Rooms
  @Get('rooms')
  async getRooms(): Promise<SuccessEnvelope<{ rooms: AdminRoom[] }>> {
    return this.controller.getRooms();
  }

  @Post('rooms')
  @HttpCode(201)
  async createRoom(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ id: string; slug: string }>> {
    const { adminId } = requirePrincipal(req);
    // Room access rule changes require super-admin permissions.
    const access = (body as { access?: unknown } | null)?.access;
    if (typeof access === 'object' && access !== null && Object.keys(access).length > 0) {
      await this.authority.assertSuperAdmin(adminId, 'Only a super admin may set a room access rule.');
    }
    return this.controller.createRoom(body, adminId);
  }

  @Post('rooms/update')
  async updateRoom(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean; slug?: string }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.updateRoom(body, adminId);
  }

  /** The room's access rule (who may enter): super admin only, the one route that writes it after creation. */
  @Post('rooms/access')
  @UseGuards(SuperAdminGuard)
  async updateRoomAccess(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.updateRoomAccess(body, adminId);
  }

  @Post('rooms/delete')
  async deleteRoom(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.deleteRoom(body, adminId);
  }

  @Get('rules')
  async getRules(
    @Query() query: unknown,
  ): Promise<SuccessEnvelope<{ roomId: string; roomName: string; rules: string[] }>> {
    return this.controller.getRules(query);
  }

  @Post('rules')
  async updateRules(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.updateRules(body, adminId);
  }

  @Get('history')
  async getRoomMessages(
    @Query() query: unknown,
  ): Promise<SuccessEnvelope<{ messages: AdminHistoryMessage[]; nextCursor: string | null }>> {
    return this.controller.getRoomMessages(query);
  }

  // Reports
  @Get('reports')
  async getReports(
    @Query() query: unknown,
  ): Promise<SuccessEnvelope<{ reports: ChatReport[]; nextCursor: string | null }>> {
    return this.controller.getReports(query);
  }

  @Post('reports/action')
  async actionReport(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.actionReport(body, adminId);
  }

  // Report reasons
  @Get('report-reasons')
  async getReportReasons(@Query() query: unknown): Promise<SuccessEnvelope<{ reasons: ReportReason[] }>> {
    return this.controller.getReportReasons(query);
  }

  @Post('report-reasons')
  async upsertReportReason(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.upsertReportReason(body, adminId);
  }

  // Bans
  @Get('bans')
  async getBans(
    @Query() query: unknown,
  ): Promise<SuccessEnvelope<{ bans: UserBan[]; nextCursor: string | null }>> {
    return this.controller.getBans(query);
  }

  @Post('bans')
  @HttpCode(201)
  async createBan(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ id: string }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.createBan(body, adminId);
  }

  @Post('bans/lift')
  async liftBan(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.liftBan(body, adminId);
  }

  // Staff roles
  @Get('staff/roles')
  async getStaffRoles(): Promise<SuccessEnvelope<{ roles: ChatStaffRole[] }>> {
    return this.controller.getStaffRoles();
  }

  /**
   * Only a super admin may assign chat roles. The global AuthGuard signs the caller in and
   * SuperAdminGuard reads the role from the database; anyone else gets 403 `forbidden`.
   */
  @Post('staff/assign-role')
  @UseGuards(SuperAdminGuard)
  async assignRole(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.assignRole(body, adminId);
  }

  @Post('staff/remove-role')
  @UseGuards(SuperAdminGuard)
  async removeRole(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.removeRole(body, adminId);
  }

  // Regions
  @Get('regions')
  async getRegions(): Promise<SuccessEnvelope<{ regions: ChatRegion[] }>> {
    return this.controller.getRegions();
  }

  @Post('regions')
  @HttpCode(201)
  async createRegion(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ id: string }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.createRegion(body, adminId);
  }

  @Post('regions/update')
  async updateRegion(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.updateRegion(body, adminId);
  }

  @Post('regions/delete')
  async deleteRegion(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.deleteRegion(body, adminId);
  }

  // Skins
  @Get('skins')
  async getSkins(): Promise<SuccessEnvelope<{ skins: ChatSkin[] }>> {
    return this.controller.getSkins();
  }

  @Post('skins')
  @HttpCode(201)
  async createSkin(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ id: string }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.createSkin(body, adminId);
  }

  /** Makes a deactivated skin selectable again. */
  @Post('skins/activate')
  async activateSkin(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.activateSkin(body, adminId);
  }

  /** Deactivates a skin; it is never deleted, so old messages keep their look. */
  @Post('skins/deactivate')
  async deactivateSkin(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.deactivateSkin(body, adminId);
  }

  // Media uploads
  @Get('media')
  async getMediaUploads(
    @Query() query: unknown,
  ): Promise<SuccessEnvelope<{ uploads: MediaUpload[] }>> {
    return this.controller.getMediaUploads(query);
  }

  @Post('media/flag')
  async flagMedia(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.flagMedia(body, adminId);
  }

  @Post('media/delete')
  async deleteMedia(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.deleteMedia(body, adminId);
  }

  // Broadcast
  @Post('broadcast')
  @HttpCode(201)
  async sendBroadcast(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean; dispatchedCount: number }>> {
    const { adminId } = requirePrincipal(req);
    // A broadcast without a room goes to every room: a super admin only, read from the database. The
    // guard cannot be a decorator because it depends on the body.
    const roomId = (body as { roomId?: unknown } | null)?.roomId;
    if (roomId === undefined || roomId === null || roomId === '') {
      await this.authority.assertSuperAdmin(adminId, 'Only a super admin may broadcast to every room.');
    }
    return this.controller.sendBroadcast(body, adminId);
  }

  // Retract
  @Post('retract')
  async retractMessage(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.retractMessage(body, adminId);
  }

  // Frequent hitters
  @Get('hitters')
  async getFrequentHitters(
    @Query() query: unknown,
  ): Promise<SuccessEnvelope<{ hitters: FrequentHitter[] }>> {
    return this.controller.getFrequentHitters(query);
  }

  // Moderation log: every admin, staff and auto-moderation action
  @Get('actions')
  async getModerationActions(
    @Query() query: unknown,
  ): Promise<SuccessEnvelope<{ actions: ModerationLogEntry[]; nextCursor: string | null }>> {
    return this.controller.getModerationActions(query);
  }

  // Per-room moderation settings: spam, auto-ban sequence, links, words, restrictions
  @Get('moderation/settings')
  async getModerationSettings(
    @Query('roomId') roomId: string,
  ): Promise<SuccessEnvelope<Record<string, unknown>>> {
    return this.controller.getModerationSettings(String(roomId ?? ''));
  }

  @Post('moderation/settings')
  async saveModerationSettings(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.saveModerationSettings(body, adminId);
  }

  // Test-only stand-in facts: the Module 2 demo, e.g. a user on the casino
  @Get('test-entitlements')
  @UseGuards(SuperAdminGuard)
  async getTestEntitlements(): Promise<SuccessEnvelope<{ entitlements: TestEntitlement[] }>> {
    this.authority.assertTestToolsAllowed();
    return this.controller.getTestEntitlements();
  }

  @Post('test-entitlements')
  @UseGuards(SuperAdminGuard)
  async upsertTestEntitlement(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean; userId: string }>> {
    this.authority.assertTestToolsAllowed();
    const { adminId } = requirePrincipal(req);
    return this.controller.upsertTestEntitlement(body, adminId);
  }

  @Post('test-entitlements/delete')
  @UseGuards(SuperAdminGuard)
  async deleteTestEntitlement(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    this.authority.assertTestToolsAllowed();
    const { adminId } = requirePrincipal(req);
    return this.controller.deleteTestEntitlement(body, adminId);
  }

  // Settings (NEW-2, NEW-3)
  /** Returns the raw settings document and the effective settings for a preview country. */
  @Get('settings')
  async getSettings(): Promise<
    SuccessEnvelope<{ document: unknown; version: number; updatedAt: string }>
  > {
    return this.controller.getSettings();
  }

  /** Preview the effective settings for a country (admin can see what users will see). */
  @Get('settings/preview')
  async previewSettings(@Query() query: unknown): Promise<SuccessEnvelope<{ settings: unknown }>> {
    return this.controller.previewSettings(query);
  }

  /** Immediate or scheduled settings change. Super-admin only. */
  @Post('settings')
  @UseGuards(SuperAdminGuard)
  async saveSettings(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ changeId: string; applied: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.saveSettings(body, adminId);
  }

  @Get('settings/changes')
  async getSettingsChanges(
    @Query() query: unknown,
  ): Promise<SuccessEnvelope<{ changes: SettingsChange[] }>> {
    return this.controller.getSettingsChanges(query);
  }

  @Post('settings/rollback')
  @UseGuards(SuperAdminGuard)
  async rollbackSettings(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<{ success: boolean }>> {
    const { adminId } = requirePrincipal(req);
    return this.controller.rollbackSettings(body, adminId);
  }
}
