// Warn and ban a GROUP of users (Chat SETTINGS "Group Privilege": a role may manage grouped users — Premium, KYC or a
// minimum level; ). A group is one RULE, evaluated when it matters, never one row per user:
// - a group ban is a chat-wide (or room) restriction rule, so it is enforced and lifted like any restriction, and the
// user can read but not post (B-15);
// - a group warning is one rule row that a user's warnings list shows when it names them.
// Only a role with Group Privilege, and only in ACT mode: asking a higher role to do a group action is not offered.
// The ban length rules are the same as for one user (chat.staff.ban-rules.ts).
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import type { StaffRole } from '../chat.contract';
import { refuse } from '../chat.moderation.service';
import { ChatAccessService } from '../chat.access.service';
import type { ChatUserContext, PenaltyReasons } from '../chat.types';
import { ChatStaffDbOperation } from '../persistence/chat.staff.dboperation';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import { ChatBus } from '../realtime/chat.bus';
import { rolePermissions } from './chat.permissions';
import { assertBanLength } from './chat.staff.ban-rules';
import { ChatStaffGate } from './chat.staff.gate';

export interface GroupTarget {
  readonly targetType: 'PREMIUM' | 'KYC' | 'LEVEL';
  readonly targetValue: string;
}

@Injectable()
export class ChatStaffGroupService {
  constructor(
    private readonly gate: ChatStaffGate,
    private readonly staffDb: ChatStaffDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly access: ChatAccessService,
    private readonly bus: ChatBus,
  ) {}

  // Staff, the permission in ACT mode, Group Privilege, and a well-formed group.
  private async assertMayAct(
    staff: ChatUserContext,
    permission: 'WARN' | 'BAN',
    group: GroupTarget,
  ): Promise<StaffRole> {
    if (!staff.staffRole) throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    const mode = await this.gate.mode(staff, permission);
    if (mode === 'REPORT') {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.OUTSIDE_ROLE_SCOPE,
        'A group action needs this permission in ACT mode',
        { permission },
      );
    }
    const own = rolePermissions(await this.gate.settings(), staff.staffRole);
    if (!own?.groupPrivilege) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.OUTSIDE_ROLE_SCOPE, 'Your role may not act on groups of users');
    }
    if (group.targetType === 'LEVEL' && !/^\d{1,6}$/.test(group.targetValue)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'group.targetValue', message: 'A LEVEL group is the minimum level, a whole number' }],
      });
    }
    return staff.staffRole;
  }

  async warn(
    staff: ChatUserContext,
    input: PenaltyReasons & { group: GroupTarget; roomId: string | null },
  ): Promise<{ id: string; group: GroupTarget; roomId: string | null }> {
    const role = await this.assertMayAct(staff, 'WARN', input.group);
    const id = await this.records.transaction(async (tx) => {
      const warningId = await this.records.createGroupWarning(tx, {
        ...input.group,
        roomId: input.roomId,
        internalReason: input.internalReason,
        userReason: input.userReason ?? null,
        issuedBy: staff.id,
        issuedByRole: role,
      });
      await this.records.recordAction(tx, {
        actorType: 'STAFF',
        actorId: staff.id,
        action: 'staff.warn_group',
        targetRoomId: input.roomId,
        newValue: { warningId, ...input.group },
        note: input.internalReason,
      });
      return warningId;
    });
    return { id, group: input.group, roomId: input.roomId };
  }

  async ban(
    staff: ChatUserContext,
    input: PenaltyReasons & {
      group: GroupTarget;
      roomId: string | null;
      durationHours?: number;
      permanent?: boolean;
    },
  ): Promise<{ id: string; group: GroupTarget; roomId: string | null; expiresAt: string | null }> {
    const role = await this.assertMayAct(staff, 'BAN', input.group);
    assertBanLength(await this.gate.settings(), role, 'ACT', input);
    const hours = input.permanent === true ? null : (input.durationHours as number);
    const created = await this.staffDb.transaction(async (tx) => {
      // "MUTE" is the stored form of a ban on a group: the users named can read, not post.
      const row = await this.staffDb.createRestriction(tx, {
        targetType: input.group.targetType,
        targetValue: input.group.targetValue,
        kind: 'MUTE',
        commands: [],
        roomId: input.roomId,
        internalReason: input.internalReason,
        userReason: input.userReason ?? null,
        createdBy: staff.id,
        createdByRole: role,
        hours,
      });
      await this.records.recordAction(tx, {
        actorType: 'STAFF',
        actorId: staff.id,
        action: 'staff.ban_group',
        targetRoomId: input.roomId,
        newValue: { restrictionId: row.id, ...input.group, hours },
        note: input.internalReason,
      });
      return row;
    });
    this.bus.publish({ kind: 'restrictions' });
    return { id: created.id, group: input.group, roomId: input.roomId, expiresAt: created.expiresAt?.toISOString() ?? null };
  }
}
