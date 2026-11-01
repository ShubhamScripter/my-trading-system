/**
 * What chat staff and users do through moderation records: staff actions (pin, warn, ban, retract) and user reports.
 * Both write audit records and tell the affected user; both are used only by the controller.
 */
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { ChatBus } from '../realtime/chat.bus';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import type { ChatUserContext, PenaltyReasons, ReportType } from '../chat.types';
import { ChatAccessService } from '../chat.access.service';
import { rankOf, roomInScope, rolePermissions } from './chat.permissions';
import { assertBanLength } from './chat.staff.ban-rules';
import { ChatStaffGate, type StaffRequested } from './chat.staff.gate';

// Staff actions

/**
 * What chat staff do from their own platform account: warn, ban, pin and unpin. Each needs the role permission
 * (Module 4): ACT does it, REPORT asks a higher role instead (a staff request). Staff may act only on users whose
 * chat role is lower than theirs, and every action writes one append-only moderation record in the same transaction.
 */
@Injectable()
export class ChatStaffService {
  constructor(
    private readonly db: ChatDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly moderation: ChatModerationService,
    private readonly bus: ChatBus,
    private readonly gate: ChatStaffGate,
  ) {}

  /** Staff may moderate only users whose chat role is lower than theirs (ADMIN above MODERATOR above SUPPORT). */
  async assertCanActOn(staff: ChatUserContext, targetUserId: string): Promise<ChatUserContext> {
    if (!staff.staffRole) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    }
    const target = await this.db.findChatUser(targetUserId);
    if (!target)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'User not found',
      });
    if (target.id === staff.id || rankOf(target.staffRole) >= rankOf(staff.staffRole)) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.TARGET_OUTRANKS_YOU,
        'You cannot moderate this user',
      );
    }
    return target;
  }

  async staffWarn(
    staff: ChatUserContext,
    input: PenaltyReasons & {
      userId: string;
      roomId: string | null;
      note?: string;
    },
  ): Promise<{ id: string; userId: string; roomId: string | null } | StaffRequested> {
    if (!staff.staffRole)
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    const mode = await this.gate.mode(staff, 'WARN');
    const target = await this.assertCanActOn(staff, input.userId);
    if (mode === 'REPORT') {
      return this.gate.report(staff, 'WARN', {
        targetUserId: target.id,
        targetRoomId: input.roomId,
        payload: { internalReason: input.internalReason, userReason: input.userReason },
        note: input.note ?? input.internalReason,
      });
    }
    const id = await this.records.transaction(async (tx) => {
      const warningId = await this.records.createWarning(tx, {
        userId: target.id,
        roomId: input.roomId,
        internalReason: input.internalReason,
        userReason: input.userReason ?? null,
        issuedBy: staff.id,
      });
      await this.records.recordAction(tx, {
        actorType: 'STAFF',
        actorId: staff.id,
        action: 'staff.warn',
        targetUserId: target.id,
        targetRoomId: input.roomId,
        note: input.internalReason,
      });
      return warningId;
    });
    this.bus.publish({
      kind: 'notice',
      userId: target.id,
      notice: { action: 'warn', roomId: input.roomId, note: input.userReason ?? null },
    });
    return { id, userId: target.id, roomId: input.roomId };
  }

  async staffBan(
    staff: ChatUserContext,
    input: PenaltyReasons & {
      userId: string;
      roomId: string | null;
      durationHours?: number;
      permanent?: boolean;
      note?: string;
    },
  ): Promise<
    | {
        id: string;
        userId: string;
        roomId: string | null;
        expiresAt: string | null;
      }
    | StaffRequested
  > {
    if (!staff.staffRole)
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    const mode = await this.gate.mode(staff, 'BAN');
    const settings = await this.gate.settings();
    const permanent = input.permanent === true;
    assertBanLength(settings, staff.staffRole, mode, input);
    const target = await this.assertCanActOn(staff, input.userId);
    if (mode === 'REPORT') {
      return this.gate.report(staff, 'BAN', {
        targetUserId: target.id,
        targetRoomId: input.roomId,
        payload: {
          internalReason: input.internalReason,
          userReason: input.userReason,
          ...(permanent ? { permanent: true } : { durationHours: input.durationHours }),
        },
        note: input.note ?? input.internalReason,
      });
    }
    const seconds = permanent ? null : (input.durationHours as number) * 3600;
    const ban = await this.records.transaction(async (tx) => {
      const created = await this.records.createBan(tx, {
        userId: target.id,
        roomId: input.roomId,
        internalReason: input.internalReason,
        userReason: input.userReason ?? null,
        seconds,
        moderatorId: staff.id,
        moderatorRole: staff.staffRole,
        refuseIfBanned: true,
      });
      if (!created) return null;
      await this.records.recordAction(tx, {
        actorType: 'STAFF',
        actorId: staff.id,
        action: 'staff.ban',
        targetUserId: target.id,
        targetRoomId: input.roomId,
        newValue: { permanent, durationHours: input.durationHours ?? null },
        note: input.internalReason,
      });
      return created;
    });
    if (!ban) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_BANNED,
        'This user is already banned',
        { userId: target.id, roomId: input.roomId },
        409,
      );
    }
    await this.moderation.bumpBanVersion(target.id);
    const expiresAt = ban.expiresAt?.toISOString() ?? null;
    this.bus.publish({
      kind: 'notice',
      userId: target.id,
      notice: {
        action: 'ban',
        roomId: input.roomId,
        note: input.userReason ?? null,
        expiresAt,
      },
    });
    return { id: ban.id, userId: target.id, roomId: input.roomId, expiresAt };
  }

  async staffPin(
    staff: ChatUserContext,
    messageId: string,
    pinned: boolean,
    note: string | null,
  ): Promise<{ messageId: string; roomId: string; isPinned: boolean } | StaffRequested> {
    if (!staff.staffRole) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    }
    const mode = await this.gate.mode(staff, 'PIN');
    const message = await this.db.messageById(messageId);
    if (!message)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Message not found',
      });
    // "Select Chat rooms where this user can pin messages".
    const scope = rolePermissions(await this.gate.settings(), staff.staffRole)?.pinRoomIds ?? [];
    if (mode === 'ACT' && !roomInScope(scope, message.roomId)) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.OUTSIDE_ROLE_SCOPE,
        'Your role may not pin messages in this room',
      );
    }
    if (mode === 'REPORT') {
      return this.gate.report(staff, 'PIN', {
        targetUserId: message.userId,
        targetRoomId: message.roomId,
        payload: { messageId, pinned },
        note: note ?? (pinned ? 'Please pin this message' : 'Please unpin this message'),
      });
    }
    const result = await this.db.setPinned(messageId, pinned ? staff.id : null, pinned);
    if (!result)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Message not found',
      });
    await this.records.recordActionNow({
      actorType: 'STAFF',
      actorId: staff.id,
      action: pinned ? 'staff.pin' : 'staff.unpin',
      targetRoomId: result.roomId,
      targetMessageId: messageId,
      targetMessageCreatedAt: result.createdAt,
      note,
    });
    this.bus.publish({ kind: 'pin', messageId, roomId: result.roomId, pinned });
    return { messageId, roomId: result.roomId, isPinned: pinned };
  }
}

// Reports

/**
 * Reports: users report a message or a user (Chat MAIN "Users can report messages / other users from
 * chat"), with a reason from the list the admin edits. One report per user per message; only messages the reporter
 * may view; banned users are refused; at most `limits.reportsPerHour` per reporter an hour, on the database clock.
 */
@Injectable()
export class ChatReportService {
  constructor(
    private readonly db: ChatDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly access: ChatAccessService,
    private readonly moderation: ChatModerationService,
  ) {}

  reportReasons(type: ReportType = 'MESSAGE') {
    return this.records.activeReportReasons(type);
  }

  private async reportPreconditions(
    user: ChatUserContext,
    roomId: string | null,
    reason: string,
    type: ReportType,
  ): Promise<void> {
    const dbNow = await this.db.dbNow();
    await this.moderation.assertNotBanned(user.id, roomId, dbNow);
    if (!(await this.records.isActiveReason(reason, type))) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'reason', message: 'Not a report reason' }],
      });
    }
    const limit = (await this.access.settingsFor(user)).limits.reportsPerHour;
    if ((await this.records.recentReportCount(user.id)) >= limit) {
      this.moderation.noteHit(user.id, 'report_limit');
      throw new ProblemException({
        type: ERR.RATE_LIMITED,
        detail: `At most ${limit} reports an hour`,
        extra: { reason: 'report_limit', remainingSeconds: 3600 },
        retryAfterSeconds: 3600,
      });
    }
  }

  async reportMessage(
    user: ChatUserContext,
    messageId: string,
    dto: { reason: string; details?: string },
  ) {
    const message = await this.db.messageById(messageId);
    if (!message)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Message not found',
      });
    // A message in a room the reporter cannot view does not exist for them.
    const room = await this.access.findRoom(message.roomId);
    const access = room ? await this.access.evaluate(user, room) : null;
    if (
      !room ||
      !access?.isEligibleToView ||
      (!access.receivesUserMessages &&
        message.type !== 'ADMIN_ALERT' &&
        message.type !== 'SYSTEM_ALERT')
    ) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Message not found',
      });
    }
    if (message.userId === user.id) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.CANNOT_REPORT_OWN_MESSAGE,
        'You cannot report your own message',
      );
    }
    if (message.type === 'SYSTEM_ALERT' || message.type === 'ADMIN_ALERT') {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Official alerts cannot be reported',
      });
    }
    await this.reportPreconditions(user, message.roomId, dto.reason, 'MESSAGE');
    const report = await this.records.insertReport({
      messageId,
      messageCreatedAt: message.createdAtText,
      reporterId: user.id,
      reportedUserId: message.userId,
      reason: dto.reason,
      details: dto.details ?? null,
    });
    if (!report)
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_REPORTED,
        'You already reported this message',
        {},
        409,
      );
    return {
      reportId: report.id,
      messageId,
      reason: dto.reason,
      createdAt: report.createdAt.toISOString(),
    };
  }

  /** Chat MAIN "Users can report messages / other users from chat". */
  async reportUser(
    user: ChatUserContext,
    handle: string,
    dto: { reason: string; details?: string },
  ) {
    const targetId = await this.db.resolveUserId(handle);
    if (!targetId)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'User not found',
      });
    if (targetId === user.id) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.CANNOT_REPORT_OWN_MESSAGE,
        'You cannot report yourself',
      );
    }
    await this.reportPreconditions(user, null, dto.reason, 'USER');
    const report = await this.records.insertReport({
      messageId: null,
      messageCreatedAt: null,
      reporterId: user.id,
      reportedUserId: targetId,
      reason: dto.reason,
      details: dto.details ?? null,
    });
    if (!report)
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_REPORTED,
        'You already reported this user',
        {},
        409,
      );
    return {
      reportId: report.id,
      userId: targetId,
      reason: dto.reason,
      createdAt: report.createdAt.toISOString(),
    };
  }
}
