/**
 * Penalties as staff see them (Module 4): "See Penalised / Banned Users List [Chat banned / penalty only]" and
 * "Change / Remove Penalties of Users banned / restricted by other Moderation Team" — only of roles the staff
 * member's penalty scope covers (same, below, or both); penalties from the admin panel stay the panel's.
 */
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, PAGE } from '../chat.constants';
import type { StaffRole } from '../chat.contract';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import { ChatStaffDbOperation } from '../persistence/chat.staff.dboperation';
import { ChatBus } from '../realtime/chat.bus';
import type { ChatUserContext, PenaltyReasons } from '../chat.types';
import {
  ADMIN_PANEL_RANK,
  SYSTEM_RANK,
  maxBanHoursFor,
  penaltyInScope,
  rankOf,
} from './chat.permissions';
import { ChatRestrictionsService } from './chat.restrictions.service';
import { ChatStaffGate, type StaffRequested } from './chat.staff.gate';
import { ChatStaffService } from './chat.staff.service';
import * as utility from '../chat.utility';

@Injectable()
export class ChatStaffPenaltiesService {
  constructor(
    private readonly gate: ChatStaffGate,
    private readonly staffDb: ChatStaffDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly restrictions: ChatRestrictionsService,
    private readonly staff: ChatStaffService,
    private readonly moderation: ChatModerationService,
    private readonly bus: ChatBus,
  ) {}

  private staffOnly(user: ChatUserContext): StaffRole {
    if (!user.staffRole)
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    return user.staffRole;
  }

  private outOfScope(detail: string): ProblemException {
    return refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.OUTSIDE_ROLE_SCOPE, detail);
  }

  /** Live bans and restrictions, newest first; one user's when `userId` is given. */
  async penalties(
    user: ChatUserContext,
    query: { userId?: string; limit?: number; before?: string; restrictionBefore?: string },
  ) {
    this.staffOnly(user);
    await this.gate.requireAct(user, 'SEE_PENALISED');
    const limit = query.limit ?? PAGE.DEFAULT;
    const before = query.before ? utility.decodeCursor(query.before) : null;
    const restrictionBefore = query.restrictionBefore ? utility.decodeCursor(query.restrictionBefore) : null;
    const userId = query.userId ? await this.staff.resolveTargetId(query.userId) : null;
    const bans = await this.staffDb.activeBans(userId, limit, before);
    const banRows = bans.slice(0, limit);
    const restrictionPage = await this.staffDb.activeRestrictionPage(userId, limit, restrictionBefore);
    const restrictions = restrictionPage.rows;
    const names = await this.staffDb.usernames(
      restrictions.filter((r) => r.targetType === 'USER').map((r) => r.targetValue),
    );
    return {
      bans: banRows.map((b) => ({
        id: b.id,
        userId: b.user_id,
        username: b.username,
        roomId: b.room_id,
        internalReason: b.internal_reason,
        userReason: b.user_reason,
        by: b.admin_id ? 'ADMIN_PANEL' : b.moderator_id ? 'STAFF' : 'AUTO_MODERATION',
        bannedAt: b.banned_at.toISOString(),
        expiresAt: b.expires_at?.toISOString() ?? null,
      })),
      nextBefore:
        bans.length > limit && bans[limit - 1]
          ? utility.encodeCursor({ createdAt: bans[limit - 1]!.banned_at_text, id: bans[limit - 1]!.id })
          : null,
      nextRestrictions: restrictionPage.nextAfter
        ? utility.encodeCursor(restrictionPage.nextAfter)
        : null,
      restrictions: restrictions.map((r) => ({
        id: r.id,
        targetType: r.targetType,
        targetValue: r.targetValue,
        username: r.targetType === 'USER' ? (names.get(r.targetValue) ?? null) : null,
        kind: r.kind,
        commands: r.commands,
        roomId: r.roomId,
        internalReason: r.internalReason,
        userReason: r.userReason,
        by: r.createdByAdmin ? 'ADMIN_PANEL' : 'STAFF',
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null,
      })),
    };
  }

  /** "Change / Remove Penalties of Users banned / restricted by other Moderation Team". */
  async liftRestriction(
    user: ChatUserContext,
    restrictionId: string,
    note: string | null,
  ): Promise<{ id: string; lifted: true } | StaffRequested> {
    const role = this.staffOnly(user);
    const mode = await this.gate.mode(user, 'CHANGE_PENALTIES');
    const row = await this.staffDb.restrictionById(restrictionId);
    if (!row || row.liftedAt) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'No such active restriction',
      });
    }
    const issuerRank = row.createdByAdmin
      ? ADMIN_PANEL_RANK
      : rankOf((row.createdByRole as StaffRole | null) ?? null);
    const targetUserId = row.targetType === 'USER' ? row.targetValue : null;
    if (targetUserId) await this.staff.assertCanActOn(user, targetUserId);
    if (mode === 'REPORT') {
      return this.gate.report(user, 'CHANGE_PENALTIES', {
        targetUserId,
        targetRoomId: row.roomId,
        payload: { restrictionId },
        note: note ?? 'Please lift this restriction',
      });
    }
    if (!penaltyInScope(await this.gate.settings(), role, issuerRank, row.createdBy === user.id)) {
      throw this.outOfScope('This restriction was given by a role your role may not overrule');
    }
    const lifted = await this.staffDb.transaction(async (tx) => {
      const done = await this.staffDb.liftRestriction(tx, restrictionId, user.id);
      if (done) {
        await this.records.recordAction(tx, {
          actorType: 'STAFF',
          actorId: user.id,
          action: 'staff.unrestrict',
          targetUserId,
          targetRoomId: row.roomId,
          newValue: { restrictionId, kind: row.kind },
          note,
        });
      }
      return done;
    });
    if (!lifted)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'No such active restriction',
      });
    this.bus.publish({ kind: 'restrictions' });
    if (targetUserId) {
      this.bus.publish({
        kind: 'notice',
        userId: targetUserId,
        notice: { action: 'unrestrict', roomId: row.roomId, note },
      });
    }
    return { id: restrictionId, lifted: true };
  }

  async liftBan(
    user: ChatUserContext,
    banId: string,
    note: string | null,
  ): Promise<{ id: string; userId: string; lifted: true } | StaffRequested> {
    const role = this.staffOnly(user);
    const mode = await this.gate.mode(user, 'CHANGE_PENALTIES');
    const ban = await this.staffDb.banById(banId);
    if (!ban || !ban.isActive)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'No such active ban',
      });
    await this.staff.assertCanActOn(user, ban.userId);
    if (mode === 'REPORT') {
      return this.gate.report(user, 'CHANGE_PENALTIES', {
        targetUserId: ban.userId,
        targetRoomId: ban.roomId,
        payload: { banId },
        note: note ?? 'Please lift this ban',
      });
    }
    const issuerRank = ban.adminId
      ? ADMIN_PANEL_RANK
      : ban.moderatorId
        ? rankOf(ban.moderatorRole)
        : SYSTEM_RANK;
    if (
      !penaltyInScope(await this.gate.settings(), role, issuerRank, ban.moderatorId === user.id)
    ) {
      throw this.outOfScope('This ban was given by a role your role may not overrule');
    }
    const lifted = await this.staffDb.transaction(async (tx) => {
      const done = await this.staffDb.liftBan(tx, banId, user.id);
      if (done) {
        await this.records.recordAction(tx, {
          actorType: 'STAFF',
          actorId: user.id,
          action: 'staff.unban',
          targetUserId: ban.userId,
          targetRoomId: ban.roomId,
          newValue: { banId },
          note,
        });
      }
      return done;
    });
    if (!lifted)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'No such active ban',
      });
    await this.moderation.bumpBanVersion(ban.userId);
    this.bus.publish({
      kind: 'notice',
      userId: ban.userId,
      notice: { action: 'unban', roomId: ban.roomId, note },
    });
    return { id: banId, userId: ban.userId, lifted: true };
  }

  // Editing a penalty ("Check Chat Banned / Penalised Users List: Edit")
  /** A new end for a live ban (counted from now, or none) and optionally a new reason, within the role's scope. */
  async changeBan(
    user: ChatUserContext,
    banId: string,
    input: Partial<PenaltyReasons> & {
      durationHours?: number;
      permanent?: boolean;
      note?: string;
    },
  ): Promise<{ id: string; userId: string; expiresAt: string | null } | StaffRequested> {
    const role = this.staffOnly(user);
    const mode = await this.gate.mode(user, 'CHANGE_PENALTIES');
    const ban = await this.staffDb.banById(banId);
    if (!ban || !ban.isActive)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'No such active ban',
      });
    await this.staff.assertCanActOn(user, ban.userId);
    const settings = await this.gate.settings();
    const permanent = input.permanent === true;
    const hours = input.durationHours;
    if (
      !permanent &&
      (hours === undefined ||
        !Number.isInteger(hours) ||
        hours < 1 ||
        hours > settings.limits.maxBanHours)
    ) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'durationHours',
            message: `1 to ${settings.limits.maxBanHours}, or permanent: true`,
          },
        ],
      });
    }
    if (mode === 'REPORT') {
      return this.gate.report(user, 'CHANGE_PENALTIES', {
        targetUserId: ban.userId,
        targetRoomId: ban.roomId,
        payload: {
          banId,
          change: true,
          ...(permanent ? { permanent: true } : { durationHours: hours }),
          ...(input.internalReason ? { internalReason: input.internalReason } : {}),
          ...(input.userReason ? { userReason: input.userReason } : {}),
        },
        note: input.note ?? 'Please change this ban',
      });
    }
    const issuerRank = ban.adminId
      ? ADMIN_PANEL_RANK
      : ban.moderatorId
        ? rankOf(ban.moderatorRole)
        : SYSTEM_RANK;
    if (!penaltyInScope(settings, role, issuerRank, ban.moderatorId === user.id)) {
      throw this.outOfScope('This ban was given by a role your role may not overrule');
    }
    // The same limits as giving a ban: the role's maximum, and permanent only for the chat admin.
    if (
      (permanent && role !== 'ADMIN') ||
      (!permanent && hours! > maxBanHoursFor(settings, role))
    ) {
      throw this.outOfScope(
        `Your role may ban for at most ${maxBanHoursFor(settings, role)} hours`,
      );
    }
    const updated = await this.staffDb.transaction(async (tx) => {
      const row = await this.staffDb.updateBan(tx, banId, {
        seconds: permanent ? null : hours! * 3600,
        internalReason: input.internalReason ?? null,
        userReason: input.userReason ?? null,
      });
      if (row) {
        await this.records.recordAction(tx, {
          actorType: 'STAFF',
          actorId: user.id,
          action: 'staff.ban_change',
          targetUserId: ban.userId,
          targetRoomId: ban.roomId,
          oldValue: {
            expiresAt: ban.expiresAt?.toISOString() ?? null,
            internalReason: ban.internalReason,
            userReason: ban.userReason,
          },
          newValue: {
            banId,
            permanent,
            durationHours: hours ?? null,
            internalReason: input.internalReason ?? null,
            userReason: input.userReason ?? null,
          },
          note: input.note ?? null,
        });
      }
      return row;
    });
    if (!updated)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'No such active ban',
      });
    await this.moderation.bumpBanVersion(ban.userId);
    const expiresAt = updated.expiresAt?.toISOString() ?? null;
    this.bus.publish({
      kind: 'notice',
      userId: ban.userId,
      notice: {
        action: 'ban',
        roomId: ban.roomId,
        note: input.userReason ?? ban.userReason,
        expiresAt,
      },
    });
    return { id: banId, userId: ban.userId, expiresAt };
  }

  /** A new end for a live restriction (from now, or until lifted) and optionally a new reason. */
  async changeRestriction(
    user: ChatUserContext,
    restrictionId: string,
    input: Partial<PenaltyReasons> & { durationHours?: number; permanent?: boolean; note?: string },
  ): Promise<{ id: string; expiresAt: string | null } | StaffRequested> {
    const role = this.staffOnly(user);
    const mode = await this.gate.mode(user, 'CHANGE_PENALTIES');
    const row = await this.staffDb.restrictionById(restrictionId);
    if (!row || row.liftedAt)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'No such active restriction',
      });
    const targetUserId = row.targetType === 'USER' ? row.targetValue : null;
    if (targetUserId) await this.staff.assertCanActOn(user, targetUserId);
    const settings = await this.gate.settings();
    // A new end (hours from now), until lifted (permanent: true), or neither: the end stays as it is.
    const permanent = input.permanent === true;
    const hours = permanent ? null : (input.durationHours ?? null);
    if (permanent && input.durationHours !== undefined) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'permanent', message: 'Give permanent or durationHours, not both' }],
      });
    }
    if (hours !== null && (!Number.isInteger(hours) || hours < 1)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'durationHours', message: 'A whole number of hours, at least 1' }],
      });
    }
    const keepEnd = !permanent && hours === null;
    if (mode === 'REPORT') {
      return this.gate.report(user, 'CHANGE_PENALTIES', {
        targetUserId,
        targetRoomId: row.roomId,
        payload: {
          restrictionId,
          change: true,
          ...(permanent ? { permanent: true } : hours !== null ? { durationHours: hours } : {}),
          ...(input.internalReason ? { internalReason: input.internalReason } : {}),
          ...(input.userReason ? { userReason: input.userReason } : {}),
        },
        note: input.note ?? 'Please change this restriction',
      });
    }
    const issuerRank = row.createdByAdmin
      ? ADMIN_PANEL_RANK
      : rankOf((row.createdByRole as StaffRole | null) ?? null);
    if (!penaltyInScope(settings, role, issuerRank, row.createdBy === user.id)) {
      throw this.outOfScope('This restriction was given by a role your role may not overrule');
    }
    const updated = await this.staffDb.transaction(async (tx) => {
      const changed = await this.staffDb.updateRestriction(tx, restrictionId, {
        hours,
        keepEnd,
        internalReason: input.internalReason ?? null,
        userReason: input.userReason ?? null,
      });
      if (changed) {
        await this.records.recordAction(tx, {
          actorType: 'STAFF',
          actorId: user.id,
          action: 'staff.restriction_change',
          targetUserId,
          targetRoomId: row.roomId,
          oldValue: {
            expiresAt: row.expiresAt?.toISOString() ?? null,
            internalReason: row.internalReason,
            userReason: row.userReason,
          },
          newValue: {
            restrictionId,
            durationHours: hours,
            permanent,
            internalReason: input.internalReason ?? null,
            userReason: input.userReason ?? null,
          },
          note: input.note ?? null,
        });
      }
      return changed;
    });
    if (!updated)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'No such active restriction',
      });
    this.bus.publish({ kind: 'restrictions' });
    return {
      id: restrictionId,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
    };
  }

  /** Carries out an approved CHANGE_PENALTIES request: a lift, or (with `change`) a new end or reason. */
  fromRequest(user: ChatUserContext, payload: Record<string, unknown>, note: string | null) {
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const banId = str(payload.banId);
    const restrictionId = str(payload.restrictionId);
    if (!banId && !restrictionId) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'The request names no ban or restriction',
      });
    }
    const reason = {
      ...(str(payload.internalReason) ? { internalReason: str(payload.internalReason) } : {}),
      ...(str(payload.userReason) ? { userReason: str(payload.userReason) } : {}),
    };
    if (payload.change === true) {
      return banId
        ? this.changeBan(user, banId, {
            ...(payload.permanent === true
              ? { permanent: true }
              : { durationHours: num(payload.durationHours) ?? 24 }),
            ...reason,
          })
        : this.changeRestriction(user, restrictionId!, {
            ...(payload.permanent === true ? { permanent: true } : {}),
            ...(num(payload.durationHours) !== undefined ? { durationHours: num(payload.durationHours)! } : {}),
            ...reason,
          });
    }
    return banId
      ? this.liftBan(user, banId, note)
      : this.liftRestriction(user, restrictionId!, note);
  }
}
