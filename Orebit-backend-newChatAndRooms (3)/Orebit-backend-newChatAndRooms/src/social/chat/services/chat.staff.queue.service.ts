// What staff read and do with reports in the app (Module 4): the reported-message queue and its actions, a user's recent
// messages and tags, and a room's full history. Reading needs the matching permission in ACT mode. A report is claimed
// before it is acted on, so two moderators never both act. The requests lower roles file in REPORT mode are in
// chat.staff.requests.service.ts.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, PAGE } from '../chat.constants';
import type { StaffRole } from '../chat.contract';
import { ChatAccessService } from '../chat.access.service';
import { refuse } from '../chat.moderation.service';
import { ChatService } from '../chat.service';
import { ChatStaffQueueDbOperation } from '../persistence/chat.staff-queue.dboperation';
import { ChatDelivery } from '../realtime/chat.delivery';
import type { ChatUserContext, MessageRow, PenaltyReasons, Viewer } from '../chat.types';
import * as utility from '../chat.utility';
import { historyDaysFor } from './chat.permissions';
import { ChatStaffGate, isRequested } from './chat.staff.gate';
import { ChatStaffService } from './chat.staff.service';

export const REPORT_ACTIONS = ['DISMISS', 'WARN', 'BAN', 'RETRACT_MESSAGE'] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

@Injectable()
export class ChatStaffQueueService {
  constructor(
    private readonly gate: ChatStaffGate,
    private readonly queueDb: ChatStaffQueueDbOperation,
    private readonly access: ChatAccessService,
    private readonly chat: ChatService,
    private readonly staff: ChatStaffService,
    private readonly delivery: ChatDelivery,
  ) {}

  private staffOnly(user: ChatUserContext): StaffRole {
    if (!user.staffRole)
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    return user.staffRole;
  }

  private async viewer(user: ChatUserContext): Promise<Viewer> {
    return {
      userId: user.id,
      isStaff: await this.gate.canAct(user, 'SEE_DELETED'),
    };
  }

  private page(rows: MessageRow[], limit: number, viewer: Viewer) {
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        ...utility.toPublicMessage(row, viewer),
        // Staff see who wrote a message even when it is retracted or anonymous to others.
        authorId: row.userId,
      })),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
    };
  }

  // Reports
  // "See Reported Messages".
  async reports(
    user: ChatUserContext,
    query: { status?: string; limit?: number; cursor?: string },
  ) {
    this.staffOnly(user);
    await this.gate.requireAct(user, 'SEE_REPORTS');
    const limit = query.limit ?? PAGE.DEFAULT;
    const status = (query.status ?? 'PENDING').toUpperCase();
    if (!['PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED', 'ALL'].includes(status)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'status',
            message: 'PENDING, REVIEWED, DISMISSED, ACTIONED or ALL',
          },
        ],
      });
    }
    const seeDeleted = await this.gate.canAct(user, 'SEE_DELETED');
    const rows = await this.queueDb.reports({
      status,
      limit,
      before: query.cursor ? utility.decodeCursor(query.cursor) : null,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        messageId: r.message_id,
        dmMessageId: r.dm_message_id,
        roomId: r.room_id,
        // A retracted message's text only for staff who may see deleted messages.
        messageContent: r.message_retracted && !seeDeleted ? null : r.message_content,
        messageRetracted: r.message_retracted ?? false,
        reporterId: r.reporter_id,
        reporterUsername: r.reporter_username,
        reportedUserId: r.reported_user_id,
        reportedUsername: r.reported_username,
        reason: r.reason,
        details: r.details,
        status: r.status,
        action: r.action,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({
              createdAt: last.created_at_text,
              id: last.id,
            })
          : null,
    };
  }

  // "Take Action on Reported Messages". The action itself needs its own permission (WARN, BAN, DELETE_MESSAGES).
  async actOnReport(
    user: ChatUserContext,
    reportId: string,
    input: {
      action: ReportAction;
      durationHours?: number;
      permanent?: boolean;
      note?: string;
      userReason?: string;
    },
  ) {
    this.staffOnly(user);
    await this.gate.requireAct(user, 'ACT_ON_REPORTS');
    const report = await this.queueDb.reportById(reportId);
    if (!report)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Report not found',
      });
    if (report.status !== 'PENDING') {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_REPORTED,
        'This report is already resolved',
        {},
        409,
      );
    }
    // The report is claimed FIRST (PENDING → resolved, one statement): of two moderators acting together only one gets
    // it, so a ban or a warning is made once. The other is told it is resolved and does nothing. If the action
    // fails, or REPORT mode only asks someone else to act, the claim is given back.
    if (!(await this.queueDb.resolveReport(reportId, input.action, user.id))) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.ALREADY_REPORTED,
        'This report is already resolved',
        {},
        409,
      );
    }
    const reasons: PenaltyReasons = {
      internalReason: input.note ?? 'Reported in chat',
      ...(input.userReason ? { userReason: input.userReason } : {}),
    };
    let outcome: unknown = null;
    try {
      outcome = await this.performReportAction(user, report, reasons, input);
    } catch (err: unknown) {
      await this.queueDb.reopenReport(reportId, user.id);
      throw err;
    }
    // A REPORT-mode action is only a request: the report stays open until someone acts.
    if (isRequested(outcome)) {
      await this.queueDb.reopenReport(reportId, user.id);
      return { reportId, resolved: false, request: outcome };
    }
    return { reportId, resolved: true, action: input.action, result: outcome };
  }

  // The action itself, after the report was claimed.
  private async performReportAction(
    user: ChatUserContext,
    report: { message_id: string | null; reported_user_id: string; room_id: string | null },
    reasons: PenaltyReasons,
    input: { action: ReportAction; durationHours?: number; permanent?: boolean; note?: string },
  ): Promise<unknown> {
    let outcome: unknown = null;
    switch (input.action) {
      case 'DISMISS':
        break;
      case 'WARN':
        outcome = await this.staff.staffWarn(user, {
          userId: report.reported_user_id,
          roomId: report.room_id,
          ...reasons,
        });
        break;
      case 'BAN':
        outcome = await this.staff.staffBan(user, {
          userId: report.reported_user_id,
          roomId: report.room_id,
          ...reasons,
          ...(input.permanent ? { permanent: true } : { durationHours: input.durationHours ?? 24 }),
        });
        break;
      case 'RETRACT_MESSAGE': {
        if (!report.message_id) {
          throw new ProblemException({
            type: ERR.VALIDATION_FAILED,
            errors: [
              {
                path: 'action',
                message: 'Only a public-room message can be retracted from a report',
              },
            ],
          });
        }
        const result = await this.chat.retract(user, report.message_id, input.note ?? null);
        if (!isRequested(result)) this.delivery.publishRetracted(result);
        outcome = result;
        break;
      }
    }
    return outcome;
  }

  // History
  // "Sort and See all recent messages of a single user: Can see message history of last: x Days".
  async userMessages(
    user: ChatUserContext,
    userId: string,
    query: { limit?: number; cursor?: string },
  ) {
    const role = this.staffOnly(user);
    const settings = await this.gate.requireAct(user, 'USER_MESSAGES');
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.queueDb.userMessages(
      userId,
      historyDaysFor(settings, role, 'MESSAGES'),
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    return {
      userId,
      days: historyDaysFor(settings, role, 'MESSAGES'),
      ...this.page(rows, limit, await this.viewer(user)),
    };
  }

  // "See all tags of a user: Can see tag history of last: x Days".
  async userTags(
    user: ChatUserContext,
    userId: string,
    query: { limit?: number; cursor?: string },
  ) {
    const role = this.staffOnly(user);
    const settings = await this.gate.requireAct(user, 'USER_TAGS');
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.queueDb.userTags(
      userId,
      historyDaysFor(settings, role, 'TAGS'),
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    return {
      userId,
      days: historyDaysFor(settings, role, 'TAGS'),
      ...this.page(rows, limit, await this.viewer(user)),
    };
  }

  // "See Previous Chat (chat history): Can see Chat history of last: x days", retracted messages included.
  async roomHistory(
    user: ChatUserContext,
    roomRef: string,
    query: { limit?: number; cursor?: string },
  ) {
    const role = this.staffOnly(user);
    const settings = await this.gate.requireAct(user, 'SEE_HISTORY');
    const room = await this.access.requireRoom(roomRef);
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.queueDb.roomMessages(
      room.id,
      historyDaysFor(settings, role),
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    return {
      roomId: room.id,
      days: historyDaysFor(settings, role),
      ...this.page(rows, limit, await this.viewer(user)),
    };
  }
}
