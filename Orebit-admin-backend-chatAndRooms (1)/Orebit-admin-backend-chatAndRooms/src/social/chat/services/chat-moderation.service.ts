/** Admin service for chat moderation: handles reports, bans, staff roles, and audit logging. */
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { ChatModerationDbOperation, type ModerationLogEntry } from '../chat-moderation.dboperation';
import { ChatStaffDbOperation, type TestEntitlement } from '../persistence/chat-staff.dboperation';
import type {
  ActionReportInput,
  AssignRoleInput,
  CreateBanInput,
  RemoveRoleInput,
  UnbanInput,
  UpsertTestEntitlementInput,
} from '../chat.dto';
import type {
  ChatReport,
  ChatStaffRole,
  FrequentHitter,
  ReportReason,
  UserBan,
} from '../chat.types';
import { ChatUtility } from '../chat.utility';

@Injectable()
export class ChatModerationService {
  constructor(
    private readonly moderation: ChatModerationDbOperation,
    private readonly staff: ChatStaffDbOperation,
  ) {}

  // Reports
  getReports(opts: {
    status?: string;
    reportedUserId?: string;
    before?: string;
    cursor?: string;
    limit: number;
  }): Promise<ChatReport[]> {
    return this.moderation.getReports(opts);
  }

  /** Claims a report and executes the corresponding moderation action within a single transaction. */
  async actionReport(dto: ActionReportInput, adminId: string): Promise<{ success: boolean }> {
    const report = await this.moderation.getReportById(dto.reportId);
    if (!report) {
      throw new ProblemException({
        type: ERR.CHAT_REPORT_NOT_FOUND,
        detail: `Report ${dto.reportId} not found`,
      });
    }
    const resolvedAlready = () =>
      new ProblemException({
        type: ERR.CHAT_REPORT_ALREADY_RESOLVED,
        detail: `Report ${dto.reportId} has already been resolved`,
      });
    if (report.status !== 'PENDING') throw resolvedAlready();
    if (dto.action === 'RETRACT_MESSAGE' && report.dm_message_id && report.dm_archived) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'Archived messages are read-only and cannot be retracted',
      });
    }
    if ((dto.action === 'WARN' || dto.action === 'BAN') && !report.reported_user_id) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'This report has no user target; dismiss it or retract its message instead',
      });
    }

    // Permanent only when asked for, otherwise 1 to maxBanHours; the database clock sets the end.
    const banSeconds =
      dto.action === 'BAN' ? (dto.banPermanent ? null : await this.banSeconds(dto.banDurationHours)) : null;
    const outcome = await this.moderation.actOnReport(dto.reportId, dto.action, adminId, async (tx) => {
      const after: Record<string, unknown>[] = [];
      let banId: string | null = null;
      if (dto.action === 'BAN') {
        const targetUserId = report.reported_user_id;
        if (!targetUserId) throw new ProblemException({ type: ERR.VALIDATION_FAILED, detail: 'This report has no user target' });
        banId = ChatUtility.generateUuid();
        const { expiresAt } = await this.moderation.createBan(
          {
            id: banId,
            userId: targetUserId,
            roomId: null,
            adminId,
            internalReason: dto.note,
            userReason: dto.userReason ?? null,
            seconds: banSeconds,
          },
          tx,
        );
        after.push({ kind: 'ban', userId: targetUserId });
        after.push({
          kind: 'notice',
          userId: targetUserId,
          // User receives the external note, while internal reason remains in audit log.
          notice: {
            action: 'ban',
            note: dto.userReason ?? null,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        });
      } else if (dto.action === 'RETRACT_MESSAGE' && report.message_id) {
        const retracted = await this.moderation.retractMessage(report.message_id, adminId, tx);
        if (retracted) {
          after.push({
            kind: 'retract',
            messageId: report.message_id,
            roomId: retracted.roomId,
            retractedAt: retracted.retractedAt.toISOString(),
          });
          after.push({
            kind: 'notice',
            userId: retracted.userId,
            notice: { action: 'retract', roomId: retracted.roomId, messageId: report.message_id, note: dto.userReason ?? null },
          });
        }
      } else if (dto.action === 'RETRACT_MESSAGE' && report.dm_message_id) {
        // A DM or group message: hidden from the members, kept for admins.
        const hidden = await this.moderation.hideDmMessage(report.dm_message_id, adminId, tx);
        if (hidden) {
          after.push({ kind: 'dm_hidden', conversationId: hidden.conversationId, messageId: report.dm_message_id });
          after.push({
            kind: 'notice',
            userId: hidden.senderId,
            notice: { action: 'retract', messageId: report.dm_message_id, note: dto.userReason ?? null },
          });
        }
      } else if (dto.action === 'WARN') {
        const targetUserId = report.reported_user_id;
        if (!targetUserId) throw new ProblemException({ type: ERR.VALIDATION_FAILED, detail: 'This report has no user target' });
        await this.moderation.createWarning(
          {
            userId: targetUserId,
            roomId: null,
            internalReason: dto.note,
            userReason: dto.userReason ?? null,
            adminId,
          },
          tx,
        );
        after.push({
          kind: 'notice',
          userId: targetUserId,
          notice: { action: 'warn', note: dto.userReason ?? null },
        });
      }
      // Every admin chat action is recorded, once.
      await this.moderation.recordModerationAction(
        {
          actorId: adminId,
          action: `REPORT_${dto.action}`,
          targetUserId: report.reported_user_id,
          targetMessageId: report.message_id ?? null,
          newValue: banId ? { banId } : undefined,
          note: dto.note,
        },
        tx,
      );
      return after;
    });
    if (!outcome.claimed) throw resolvedAlready();
    for (const payload of outcome.value) await this.moderation.notify(payload as { kind: string });
    return { success: true };
  }

  getReportReasons(type: 'MESSAGE' | 'USER' | null = null): Promise<ReportReason[]> {
    return this.moderation.getReportReasons(type);
  }

  async upsertReportReason(
    data: { code: string; label: string; reportType: 'MESSAGE' | 'USER'; isActive: boolean; sortOrder: number },
    adminId: string,
  ): Promise<{ success: boolean }> {
    await this.moderation.upsertReportReason(data);
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'UPDATE_REPORT_REASON',
      newValue: data,
    });
    return { success: true };
  }

  // Bans
  getBans(opts: {
    before?: string;
    cursor?: string;
    limit: number;
    userId?: string;
    activeOnly: boolean;
  }): Promise<UserBan[]> {
    return this.moderation.getBans(opts);
  }

  async createBan(dto: CreateBanInput, adminId: string): Promise<{ id: string }> {
    const userId = await this.moderation.resolveUserId(dto.userId);
    if (!userId) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: `User '${dto.userId}' not found` });
    }

    const id = ChatUtility.generateUuid();
    // Permanent only when asked for, otherwise 1 to maxBanHours; the database clock sets the end.
    const permanent = dto.permanent === true;
    const seconds = permanent ? null : await this.banSeconds(dto.durationHours);
    const { expiresAt } = await this.moderation.createBan({
      id,
      userId,
      roomId: dto.roomId,
      adminId,
      internalReason: dto.internalReason,
      userReason: dto.userReason ?? null,
      seconds,
    });

    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'BAN',
      targetUserId: userId,
      targetRoomId: dto.roomId ?? null,
      // banId links the audit note to the ban row, so the ban list can show it.
      newValue: { banId: id, permanent, expiresAt },
      note: dto.internalReason,
    });
    // User receives the external reason note, while internal reason remains for audit.
    await this.moderation.notify({
      kind: 'notice',
      userId,
      notice: {
        action: 'ban',
        roomId: dto.roomId ?? null,
        note: dto.userReason ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });
    await this.moderation.notify({ kind: 'ban', userId });
    return { id };
  }

  /** Ban length in seconds for `hours`, refused outside 1..maxBanHours. */
  private async banSeconds(hours: number | undefined): Promise<number> {
    const max = await this.moderation.maxBanHours();
    if (hours === undefined || !Number.isInteger(hours) || hours < 1 || hours > max) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: `Ban length must be a whole number of hours from 1 to ${max}, or permanent`,
      });
    }
    return hours * 3600;
  }

  async liftBan(dto: UnbanInput, adminId: string): Promise<{ success: boolean }> {
    const lifted = await this.moderation.liftBan(dto.banId, adminId);
    if (!lifted) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: `Ban ${dto.banId} not found or already lifted`,
      });
    }
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'UNBAN',
      targetUserId: lifted.userId,
      targetRoomId: lifted.roomId,
      newValue: { banId: dto.banId },
      note: dto.note,
    });
    // The user can write again at once, and is told why.
    await this.moderation.notify({ kind: 'ban', userId: lifted.userId });
    await this.moderation.notify({
      kind: 'notice',
      userId: lifted.userId,
      notice: { action: 'unban', roomId: lifted.roomId, note: dto.note },
    });
    return { success: true };
  }

  // Staff roles
  getStaffRoles(): Promise<ChatStaffRole[]> {
    return this.staff.getStaffRoles();
  }

  /**
   * Assigns a chat staff role. Only a super admin reaches this (SuperAdminGuard on the route); the old and
   * new role are recorded with the change, and open sockets pick up the new role at once.
   */
  async assignRole(dto: AssignRoleInput, adminId: string): Promise<{ success: boolean }> {
    const userId = await this.moderation.resolveUserId(dto.userId);
    if (!userId) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: `User '${dto.userId}' not found` });
    }
    await this.staff.setRole({
      userId,
      role: dto.role,
      adminId,
      action: 'ASSIGN_ROLE',
      note: dto.note,
    });
    await this.moderation.notify({ kind: 'user', userId });
    return { success: true };
  }

  async removeRole(dto: RemoveRoleInput, adminId: string): Promise<{ success: boolean }> {
    const userId = await this.moderation.resolveUserId(dto.userId);
    if (!userId) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: `User '${dto.userId}' not found` });
    }
    await this.staff.setRole({
      userId,
      role: null,
      adminId,
      action: 'REMOVE_ROLE',
      note: dto.note,
    });
    await this.moderation.notify({ kind: 'user', userId });
    return { success: true };
  }

  // Moderation log
  getModerationActions(opts: {
    before?: string;
    limit: number;
    actorType?: string;
  }): Promise<{ actions: ModerationLogEntry[]; nextCursor: string | null }> {
    return this.moderation.getModerationActions(opts);
  }

  // Test-only stand-in facts
  getTestEntitlements(): Promise<TestEntitlement[]> {
    return this.staff.getTestEntitlements();
  }

  async upsertTestEntitlement(
    dto: UpsertTestEntitlementInput,
    adminId: string,
  ): Promise<{ success: boolean; userId: string }> {
    const userId = await this.moderation.resolveUserId(dto.userId);
    if (!userId)
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: `User '${dto.userId}' not found` });
    // Follows are stored as ids; an unknown name is refused rather than silently dropped.
    const follows: string[] = [];
    for (const handle of dto.follows) {
      const id = await this.moderation.resolveUserId(handle);
      if (!id) throw new ProblemException({ type: ERR.NOT_FOUND, detail: `User '${handle}' not found` });
      if (id !== userId && !follows.includes(id)) follows.push(id);
    }
    await this.staff.upsertTestEntitlement({ ...dto, userId, follows });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'test_providers.upsert',
      targetUserId: userId,
      newValue: dto,
    });
    // The user's cached facts are dropped at once, so the demo user's rooms open without a reconnect.
    await this.moderation.notify({ kind: 'user', userId });
    return { success: true, userId };
  }

  async deleteTestEntitlement(handle: string, adminId: string): Promise<{ success: boolean }> {
    const userId = await this.moderation.resolveUserId(handle);
    if (!userId || !(await this.staff.deleteTestEntitlement(userId))) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: `No test facts for '${handle}'` });
    }
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'test_providers.delete',
      targetUserId: userId,
    });
    await this.moderation.notify({ kind: 'user', userId });
    return { success: true };
  }

  // Frequent hitters
  getFrequentHitters(opts: {
    limit: number;
    sort: 'date' | 'count';
    from: string | null;
    to: string | null;
  }): Promise<FrequentHitter[]> {
    return this.staff.getFrequentHitters(opts);
  }
}
