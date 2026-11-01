/** Admin service for review and resolution of staff moderation requests submitted in REPORT mode. */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ERR } from '../../../contracts';
import { ProblemException, parseDto } from '../../../http';
import { RESTRICTION_KINDS } from '../chat.contract';
import { ChatModerationDbOperation } from '../chat-moderation.dboperation';
import { ChatModulesDbOperation } from '../persistence/chat-modules.dboperation';
import { ChatStaffDbOperation } from '../persistence/chat-staff.dboperation';
import { ChatSettingsAdminService } from './chat.settings.service';
import { ChatUtility } from '../chat.utility';
import { RainAdminDbOperation } from '../../rain/rain-admin.dboperation';

const UUID = z.string().uuid();
const LIMIT = z.coerce.number().int().min(1).max(200).default(50);

export const StaffRequestsQuerySchema = z
  .object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'),
    limit: LIMIT,
  })
  .strict();

export const ResolveStaffRequestSchema = z
  .object({ requestId: UUID, approve: z.boolean(), note: z.string().trim().max(1000).optional() })
  .strict();

@Injectable()
export class ChatStaffRequestsService {
  constructor(
    private readonly db: ChatModulesDbOperation,
    private readonly moderation: ChatModerationDbOperation,
    private readonly staff: ChatStaffDbOperation,
    private readonly settings: ChatSettingsAdminService,
    private readonly rain: RainAdminDbOperation,
  ) {}

  async staffRequests(query: unknown) {
    const q = parseDto(StaffRequestsQuerySchema, query);
    return { requests: await this.db.staffRequests(q.status, q.limit) };
  }

  /**
   * Approving carries the request out from the panel. Chat roles and the chat-wide command and money switches are super-admin
   * writes, as everywhere in the panel: another admin's approval of those is recorded with `applied: false` and a
   * super admin applies it from the role or settings view.
   */
  async resolveStaffRequest(body: unknown, adminId: string, adminRole: string) {
    const dto = parseDto(ResolveStaffRequestSchema, body);
    const request = await this.db.staffRequestById(dto.requestId);
    if (!request) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Request not found' });
    if (request.status !== 'PENDING') {
      throw new ProblemException({
        type: ERR.CHAT_REPORT_ALREADY_RESOLVED,
        detail: 'This request is already resolved',
      });
    }
    if (
      !(await this.db.resolveStaffRequest(
        request.id,
        dto.approve ? 'APPROVED' : 'REJECTED',
        adminId,
        dto.note ?? null,
      ))
    ) {
      throw new ProblemException({
        type: ERR.CHAT_REPORT_ALREADY_RESOLVED,
        detail: 'This request is already resolved',
      });
    }
    let applied = false;
    if (dto.approve)
      applied = await this.carryOut(
        request,
        adminId,
        adminRole === 'SUPER_ADMIN',
        dto.note ?? null,
      );
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'RESOLVE_STAFF_REQUEST',
      targetUserId: request.target_user_id,
      targetRoomId: request.target_room_id,
      newValue: {
        requestId: request.id,
        permission: request.permission,
        approved: dto.approve,
        applied,
      },
      note: dto.note ?? null,
    });
    await this.moderation.notify({
      kind: 'notice',
      userId: request.requester_id,
      notice: {
        action: dto.approve ? 'request_approved' : 'request_rejected',
        note: dto.note ?? null,
      },
    });
    await this.moderation.notify({ kind: 'staff_request', requestId: request.id });
    return { requestId: request.id, status: dto.approve ? 'APPROVED' : 'REJECTED', applied };
  }

  private async carryOut(
    request: NonNullable<Awaited<ReturnType<ChatModulesDbOperation['staffRequestById']>>>,
    adminId: string,
    superAdmin: boolean,
    note: string | null,
  ): Promise<boolean> {
    const p = request.payload;
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    // A request saved before the two reasons existed holds one `reason`: it is the internal one, never copied to the user.
    const internalReason = str(p.internalReason) ?? str(p.reason) ?? 'Requested by staff';
    const userReason = str(p.userReason);
    const userId = request.target_user_id;
    const roomId = request.target_room_id;
    switch (request.permission) {
      case 'WARN':
        if (!userId) return false;
        await this.moderation.createWarning({
          userId,
          roomId,
          internalReason,
          userReason,
          adminId,
        });
        await this.moderation.notify({
          kind: 'notice',
          userId,
          notice: { action: 'warn', roomId, note: userReason },
        });
        return true;
      case 'BAN': {
        if (!userId) return false;
        const hours = typeof p.durationHours === 'number' ? p.durationHours : 24;
        const { expiresAt } = await this.moderation.createBan({
          id: ChatUtility.generateUuid(),
          userId,
          roomId,
          adminId,
          internalReason,
          userReason,
          seconds: p.permanent === true ? null : Math.round(hours * 3600),
        });
        await this.moderation.notify({ kind: 'ban', userId });
        await this.moderation.notify({
          kind: 'notice',
          userId,
          notice: {
            action: 'ban',
            roomId,
            note: userReason,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        });
        return true;
      }
      case 'CHANGE_PENALTIES': {
        const banId = str(p.banId);
        const restrictionId = str(p.restrictionId);
        const hours = typeof p.durationHours === 'number' ? p.durationHours : null;
        if (banId && p.change === true) {
          const changed = await this.db.updateBan(banId, {
            seconds: p.permanent === true ? null : Math.round((hours ?? 24) * 3600),
            internalReason: str(p.internalReason),
            userReason,
          });
          if (changed) await this.moderation.notify({ kind: 'ban', userId: changed.userId });
          return changed !== null;
        }
        if (restrictionId && p.change === true) {
          const changed = await this.db.updateRestriction(restrictionId, {
            hours,
            internalReason: str(p.internalReason),
            userReason,
          });
          await this.moderation.notify({ kind: 'restrictions' });
          return changed !== null;
        }
        if (banId) {
          const lifted = await this.moderation.liftBan(banId, adminId);
          if (lifted) await this.moderation.notify({ kind: 'ban', userId: lifted.userId });
          return lifted !== null;
        }
        if (restrictionId) {
          const lifted = await this.db.liftRestriction(restrictionId, adminId);
          await this.moderation.notify({ kind: 'restrictions' });
          return lifted !== null;
        }
        return false;
      }
      case 'ROOM_STATUS':
        if (!roomId) return false;
        await this.db.patchRoomConfig(roomId, {
          status: str(p.status) ?? 'ACTIVE',
          ...(str(p.statusNote) ? { statusNote: str(p.statusNote) } : {}),
        });
        await this.moderation.notify({ kind: 'room', roomId });
        return true;
      case 'EDIT_RULES':
        if (!roomId || !Array.isArray(p.rules)) return false;
        await this.db.patchRoomConfig(roomId, {
          rules: p.rules.filter((r) => typeof r === 'string').slice(0, 50),
        });
        await this.moderation.notify({ kind: 'room', roomId });
        return true;
      case 'ROOM_ACCESS':
        if (!roomId || !userId) return false;
        await this.db.setRoomAccess(
          roomId,
          userId,
          p.action === 'ADD' || p.action === 'RESTORE' ? p.action : 'REMOVE',
          adminId,
        );
        await this.moderation.notify({ kind: 'user', userId });
        return true;
      case 'PIN': {
        const messageId = str(p.messageId);
        if (!messageId) return false;
        const pinned = p.pinned !== false;
        const done = await this.db.setPinned(messageId, pinned);
        if (done)
          await this.moderation.notify({ kind: 'pin', messageId, roomId: done.roomId, pinned });
        return done !== null;
      }
      case 'DISABLE_COMMANDS': {
        if (!superAdmin) return false;
        const commands: Record<string, unknown> = {};
        if (typeof p.enabled === 'boolean') commands.enabled = p.enabled;
        if (Array.isArray(p.disabled)) commands.disabled = p.disabled;
        await this.settings.savePatch({ patch: { global: { commands } }, actorId: adminId });
        return true;
      }
      case 'DISABLE_OVERALL_RAINS':
      case 'DISABLE_RAINPOOL_RAINS':
      case 'DISABLE_USER_RAINS': {
        // "Disable Overall / Rainpool / User Rains" switch a RainPool status: a super-admin write, like settings.
        if (!superAdmin) return false;
        const status = str(p.status);
        if (status !== 'ON' && status !== 'OFF') return false;
        const field =
          request.permission === 'DISABLE_OVERALL_RAINS'
            ? 'overall'
            : request.permission === 'DISABLE_RAINPOOL_RAINS'
              ? 'system'
              : 'user';
        const { before, after } = await this.rain.patchStatus({ [field]: status });
        await this.rain.audit({ adminId, action: 'RAIN_STATUS', reason: note, detail: { before, after, requestId: request.id } });
        await this.moderation.notify({ kind: 'rain' });
        return true;
      }
      case 'SENDING_MONEY': {
        // "Disable / Enable Sending Money from Chat" is a chat-wide setting: a super-admin write, like commands.
        if (!superAdmin) return false;
        await this.settings.savePatch({
          patch: { global: { gifts: { enabled: p.enabled !== false } } },
          actorId: adminId,
        });
        return true;
      }
      case 'DELETE_MESSAGES': {
        const messageId = str(p.messageId);
        if (!messageId) return false;
        const retracted = await this.moderation.retractMessage(messageId, adminId);
        if (retracted) {
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
        }
        return retracted !== null;
      }
      default: {
        // A restriction kind (MUTE, RESTRICT_*).
        if (!(RESTRICTION_KINDS as readonly string[]).includes(request.permission)) return false;
        const targetType = str(p.targetType) ?? 'USER';
        const targetValue = str(p.targetValue) ?? userId;
        if (!targetValue) return false;
        await this.db.createRestriction({
          targetType,
          targetValue,
          kind: request.permission,
          commands: Array.isArray(p.commands)
            ? p.commands.filter((c): c is string => typeof c === 'string')
            : [],
          roomId,
          internalReason,
          userReason,
          adminId,
          hours: typeof p.durationHours === 'number' ? p.durationHours : null,
        });
        await this.moderation.notify({ kind: 'restrictions' });
        return true;
      }
    }
  }
}
