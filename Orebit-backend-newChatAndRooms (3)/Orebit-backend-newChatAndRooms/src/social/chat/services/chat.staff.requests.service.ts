// The requests lower roles file in REPORT mode (Module 4: "report means they can ask their above role to do it"): what a
// member can resolve, what they asked for themselves, and carrying out an approved request. A request is resolved only
// by a higher role that may ACT on what it asks for; the action is then done as that member.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, PAGE } from '../chat.constants';
import { RESTRICTION_KINDS, STAFF_ROLES } from '../chat.contract';
import type { ChatCommand, RestrictionKind, RestrictionTarget, RoomStatus, StaffRole } from '../chat.contract';
import { STAFF_PERMISSIONS } from '../chat.features.contract';
import { refuse } from '../chat.moderation.service';
import { ChatService } from '../chat.service';
import { ChatStaffDbOperation } from '../persistence/chat.staff.dboperation';
import { ChatBus } from '../realtime/chat.bus';
import { ChatDelivery } from '../realtime/chat.delivery';
import type { ChatUserContext } from '../chat.types';
import { reasonsFromPayload } from '../chat.reasons';
import * as utility from '../chat.utility';
import { rankOf } from './chat.permissions';
import { ChatStaffGate, isRequested } from './chat.staff.gate';
import { ChatStaffPenaltiesService } from './chat.staff.penalties.service';
import { ChatStaffService } from './chat.staff.service';
import { ChatStaffToolsService } from './chat.staff.tools.service';
import { RainAdminService, scopeOfPermission } from '../../rain/rain.admin.service';

@Injectable()
export class ChatStaffRequestsService {
  constructor(
    private readonly gate: ChatStaffGate,
    private readonly staffDb: ChatStaffDbOperation,
    private readonly chat: ChatService,
    private readonly staff: ChatStaffService,
    private readonly tools: ChatStaffToolsService,
    private readonly rainAdmin: RainAdminService,
    private readonly penalties: ChatStaffPenaltiesService,
    private readonly delivery: ChatDelivery,
    private readonly bus: ChatBus,
  ) {}

  private staffOnly(user: ChatUserContext): StaffRole {
    if (!user.staffRole)
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    return user.staffRole;
  }

  // Requests (REPORT mode)
  // `TO_RESOLVE`: pending requests of lower roles this member may resolve. `MINE`: their own requests.
  async requests(
    user: ChatUserContext,
    query: { scope?: 'TO_RESOLVE' | 'MINE'; limit?: number; cursor?: string },
  ) {
    const role = this.staffOnly(user);
    const limit = query.limit ?? PAGE.DEFAULT;
    const mine = query.scope === 'MINE';
    // What this member may resolve is decided in SQL, BEFORE the limit: a page is never empty because the requests the
    // member cannot resolve filled it. Only requests from a lower role, for a permission they may ACT on.
    const settings = await this.gate.settings();
    const resolvable = mine
      ? {}
      : {
          requesterRoles: STAFF_ROLES.filter((r) => rankOf(r) < rankOf(role)),
          permissions: [...STAFF_PERMISSIONS, ...RESTRICTION_KINDS].filter((p) => this.gate.mayResolve(settings, user, p)),
        };
    const rows = await this.staffDb.requests({
      status: mine ? 'ALL' : 'PENDING',
      ...(mine ? { requesterId: user.id } : {}),
      ...resolvable,
      limit,
      before: query.cursor ? utility.decodeCursor(query.cursor) : null,
    });
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((r) => ({
        id: r.id,
        permission: r.permission,
        requesterId: r.requesterId,
        requesterUsername: r.requesterUsername,
        requesterRole: r.requesterRole,
        targetUserId: r.targetUserId,
        targetUsername: r.targetUsername,
        targetRoomId: r.targetRoomId,
        payload: r.payload,
        note: r.note,
        status: r.status,
        resolutionNote: r.resolutionNote,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
      })),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
    };
  }

  // Approve (carry the action out as the approver) or reject a request; the requester is told either way.
  async resolveRequest(
    user: ChatUserContext,
    requestId: string,
    input: { approve: boolean; note?: string },
  ) {
    const role = this.staffOnly(user);
    const request = await this.staffDb.requestById(requestId);
    if (!request)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Request not found',
      });
    if (request.status !== 'PENDING') {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_REPORTED,
        'This request is already resolved',
        {},
        409,
      );
    }
    const settings = await this.gate.settings();
    if (
      rankOf(request.requesterRole) >= rankOf(role) ||
      !this.gate.mayResolve(settings, user, request.permission)
    ) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.PERMISSION_DENIED,
        'Only a higher role that may do this can resolve the request',
        { permission: request.permission },
      );
    }
    const note = input.note ?? null;
    const claimed = await this.staffDb.resolveRequest(
      requestId,
      input.approve ? 'APPROVED' : 'REJECTED',
      user.id,
      note,
    );
    if (!claimed) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_REPORTED,
        'This request is already resolved',
        {},
        409,
      );
    }
    let result: unknown = null;
    if (input.approve) {
      try {
        result = await this.carryOut(
          user,
          request.permission,
          request.targetUserId,
          request.targetRoomId,
          request.payload,
          note,
        );
      } catch (err: unknown) {
        await this.staffDb.reopenRequest(requestId);
        throw err;
      }
    }
    this.bus.publish({
      kind: 'notice',
      userId: request.requesterId,
      notice: {
        action: input.approve ? 'request_approved' : 'request_rejected',
        note,
      },
    });
    this.bus.publish({ kind: 'staff_request', requestId });
    return {
      requestId,
      status: input.approve ? 'APPROVED' : 'REJECTED',
      result,
    };
  }

  // The approved action, done by the approver with their own permissions.
  private async carryOut(
    user: ChatUserContext,
    permission: string,
    targetUserId: string | null,
    targetRoomId: string | null,
    payload: Record<string, unknown>,
    note: string | null,
  ): Promise<unknown> {
    const str = (value: unknown): string | undefined =>
      typeof value === 'string' ? value : undefined;
    const num = (value: unknown): number | undefined =>
      typeof value === 'number' ? value : undefined;
    const need = <T>(value: T | null | undefined, what: string): T => {
      if (value === null || value === undefined) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          detail: `The request has no ${what}`,
        });
      }
      return value;
    };
    switch (permission) {
      case 'WARN':
        return this.staff.staffWarn(user, {
          userId: need(targetUserId, 'user'),
          roomId: targetRoomId,
          ...reasonsFromPayload(payload),
        });
      case 'BAN':
        return this.staff.staffBan(user, {
          userId: need(targetUserId, 'user'),
          roomId: targetRoomId,
          ...reasonsFromPayload(payload),
          ...(payload.permanent === true
            ? { permanent: true }
            : { durationHours: num(payload.durationHours) ?? 24 }),
        });
      case 'PIN':
        return this.staff.staffPin(
          user,
          need(str(payload.messageId), 'message'),
          payload.pinned !== false,
          note,
        );
      case 'DELETE_MESSAGES': {
        const result = await this.chat.retract(user, need(str(payload.messageId), 'message'), note);
        if (!isRequested(result)) this.delivery.publishRetracted(result);
        return result;
      }
      case 'CHANGE_PENALTIES':
        return this.penalties.fromRequest(user, payload, note);
      case 'SENDING_MONEY':
        return this.tools.setGiftsEnabled(user, {
          enabled: payload.enabled !== false,
        });
      case 'ROOM_STATUS':
        return this.tools.setRoomStatus(user, need(targetRoomId, 'room'), {
          status: need(str(payload.status), 'status') as RoomStatus,
          ...(str(payload.statusNote) ? { note: str(payload.statusNote) } : {}),
        });
      case 'EDIT_RULES':
        return this.tools.setRules(user, need(targetRoomId, 'room'), {
          rules: Array.isArray(payload.rules)
            ? payload.rules.filter((r): r is string => typeof r === 'string')
            : [],
        });
      case 'ROOM_ACCESS':
        return this.tools.setRoomAccess(user, need(targetRoomId, 'room'), {
          userId: need(targetUserId, 'user'),
          action:
            payload.action === 'RESTORE' || payload.action === 'ADD' ? payload.action : 'REMOVE',
        });
      case 'DISABLE_COMMANDS':
        return this.tools.setChatCommands(user, {
          ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
          ...(Array.isArray(payload.disabled)
            ? { disabled: payload.disabled as ChatCommand[] }
            : {}),
        });
      case 'DISABLE_OVERALL_RAINS':
      case 'DISABLE_RAINPOOL_RAINS':
      case 'DISABLE_USER_RAINS': {
        const status = str(payload.status);
        if (status !== 'ON' && status !== 'OFF') {
          throw new ProblemException({
            type: ERR.VALIDATION_FAILED,
            errors: [{ path: 'status', message: 'ON or OFF' }],
          });
        }
        const result = await this.rainAdmin.setStatus(scopeOfPermission(permission)!, status, user.id);
        this.bus.publish({ kind: 'rain' });
        return result;
      }
      default:
        // A restriction kind.
        return this.tools.restrict(user, {
          targetType: (str(payload.targetType) as RestrictionTarget | undefined) ?? 'USER',
          targetValue: need(str(payload.targetValue) ?? targetUserId, 'target'),
          kind: permission as RestrictionKind,
          ...(Array.isArray(payload.commands)
            ? { commands: payload.commands as ChatCommand[] }
            : {}),
          roomId: targetRoomId,
          ...reasonsFromPayload(payload),
          ...(num(payload.durationHours) !== undefined
            ? { durationHours: num(payload.durationHours) }
            : {}),
        });
    }
  }
}
