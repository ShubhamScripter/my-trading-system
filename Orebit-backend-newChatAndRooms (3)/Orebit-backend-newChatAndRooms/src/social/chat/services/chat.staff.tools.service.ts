// The Module 4 staff tools that change someone's standing or a room (Chat SETTINGS "Moderation Role Permissions"):
// restrict a user or a group, lift a ban or a restriction, change a room's status, rules or a user's access to it,
// give or take chat roles below one's own, and switch commands off chat-wide. Each goes through the permission gate:
// ACT does it now, REPORT files a request for a higher role. Every change writes a moderation record.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import {
  ROOM_STATUSES,
  type ChatCommand,
  type RestrictionKind,
  type RestrictionTarget,
  type RoomStatus,
  type StaffRole,
} from '../chat.contract';
import { ChatAccessService } from '../chat.access.service';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatSettingsDocumentSchema, applySettingsPatch } from '../chat.settings.contract';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import { ChatSettingsDbOperation } from '../persistence/chat.settings.dboperation';
import { ChatStaffDbOperation } from '../persistence/chat.staff.dboperation';
import { ChatBus } from '../realtime/chat.bus';
import type { ChatUserContext } from '../chat.types';
import {
  commandsInScope,
  historyDaysFor,
  maxBanHoursFor,
  permissionTable,
  rolePermissions,
  roomInScope,
} from './chat.permissions';
import { ChatStaffGate, type StaffRequested } from './chat.staff.gate';
import { ChatStaffService } from './chat.staff.service';

export interface RestrictInput {
  targetType: RestrictionTarget;
  // USER: an id, username or login code. LEVEL: the minimum level. PREMIUM / KYC: ignored.
  targetValue: string;
  kind: RestrictionKind;
  commands?: ChatCommand[];
  roomId?: string | null;
  // Required, never shown to the user.
  internalReason: string;
  // Optional: what the user sees in the notice and in their limitations.
  userReason?: string;
  // At least one hour. Permanent is `permanent: true`; neither is refused.
  durationHours?: number;
  permanent?: boolean;
  note?: string;
}

@Injectable()
export class ChatStaffToolsService {
  constructor(
    private readonly gate: ChatStaffGate,
    private readonly staffDb: ChatStaffDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly settingsDb: ChatSettingsDbOperation,
    private readonly db: ChatDbOperation,
    private readonly access: ChatAccessService,
    private readonly staff: ChatStaffService,
    private readonly moderation: ChatModerationService,
    private readonly bus: ChatBus,
  ) {}

  private staffOnly(user: ChatUserContext): StaffRole {
    if (!user.staffRole)
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    return user.staffRole;
  }

  private outOfScope(detail: string, extra: Record<string, unknown> = {}): ProblemException {
    return refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.OUTSIDE_ROLE_SCOPE, detail, extra);
  }

  // What the signed-in staff member may do, for the app's staff tools.
  async permissions(user: ChatUserContext) {
    const settings = await this.gate.settings();
    const role = user.staffRole;
    const own = rolePermissions(settings, role);
    return {
      role,
      permissions: permissionTable(settings, role),
      maxBanHours: role ? maxBanHoursFor(settings, role) : 0,
      penaltyScope: own?.penaltyScope ?? null,
      historyDays: historyDaysFor(settings, role),
      pinRoomIds: own?.pinRoomIds ?? [],
      rulesRoomIds: own?.rulesRoomIds ?? [],
      restrictableCommands: own?.restrictableCommands ?? [],
      groupPrivilege: own?.groupPrivilege ?? false,
    };
  }

  // Restrictions
  async restrict(
    user: ChatUserContext,
    input: RestrictInput,
  ): Promise<{ id: string; kind: RestrictionKind; expiresAt: string | null } | StaffRequested> {
    const role = this.staffOnly(user);
    // "Mute" is one user muting another. Staff stop someone posting with a timed ban.
    if (input.kind === 'MUTE') {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'kind', message: 'Staff do not mute; ban the user for a time instead' }],
      });
    }
    const mode = await this.gate.restrictionMode(user, input.kind);
    const settings = await this.gate.settings();
    const own = rolePermissions(settings, role);

    let targetValue = input.targetValue.trim();
    let targetUserId: string | null = null;
    if (input.targetType === 'USER') {
      const id = await this.db.resolveUserId(targetValue.replace(/^@/, ''));
      if (!id)
        throw new ProblemException({
          type: ERR.NOT_FOUND,
          detail: 'User not found',
        });
      targetUserId = (await this.staff.assertCanActOn(user, id)).id;
      targetValue = targetUserId;
    } else if (mode === 'ACT' && !own?.groupPrivilege) {
      // "Group Privilege: Allow users with this role to manage grouped users".
      throw this.outOfScope('Your role may not restrict groups of users');
    }
    if (input.targetType === 'LEVEL' && !/^\d{1,6}$/.test(targetValue)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'targetValue',
            message: 'A LEVEL target is the minimum level, a whole number',
          },
        ],
      });
    }
    const commands = input.kind === 'RESTRICT_COMMANDS' ? (input.commands ?? []) : [];
    if (
      mode === 'ACT' &&
      input.kind === 'RESTRICT_COMMANDS' &&
      !commandsInScope(own?.restrictableCommands ?? [], commands)
    ) {
      throw this.outOfScope('Your role may not restrict these commands', {
        restrictableCommands: own?.restrictableCommands ?? [],
      });
    }
    const roomId = input.roomId ? (await this.access.requireRoom(input.roomId)).id : null;
    // How long it lasts is always said: permanent, or a whole number of hours of at least 1. The role's maximum is for
    // bans; other restrictions (GIFs, emoji, links...) may last as long as the contract allows.
    const permanent = input.permanent === true;
    const hours = permanent ? null : (input.durationHours ?? null);
    if (permanent === (input.durationHours !== undefined) || (!permanent && (hours === null || !Number.isInteger(hours) || hours < 1))) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'durationHours', message: 'Give durationHours (a whole number, at least 1) or permanent: true, not both' }],
      });
    }

    if (mode === 'REPORT') {
      return this.gate.report(user, input.kind, {
        targetUserId,
        targetRoomId: roomId,
        payload: {
          targetType: input.targetType,
          targetValue,
          kind: input.kind,
          commands,
          internalReason: input.internalReason,
          userReason: input.userReason,
          ...(permanent ? { permanent: true } : { durationHours: hours }),
        },
        note: input.note ?? input.internalReason,
      });
    }

    const created = await this.staffDb.transaction(async (tx) => {
      const row = await this.staffDb.createRestriction(tx, {
        targetType: input.targetType,
        targetValue,
        kind: input.kind,
        commands,
        roomId,
        internalReason: input.internalReason,
        userReason: input.userReason ?? null,
        createdBy: user.id,
        createdByRole: role,
        hours,
      });
      await this.records.recordAction(tx, {
        actorType: 'STAFF',
        actorId: user.id,
        action: 'staff.restrict',
        targetUserId,
        targetRoomId: roomId,
        newValue: {
          restrictionId: row.id,
          kind: input.kind,
          targetType: input.targetType,
          targetValue,
          commands,
          hours,
        },
        note: input.internalReason,
      });
      return row;
    });
    this.bus.publish({ kind: 'restrictions' });
    if (targetUserId) {
      this.bus.publish({
        kind: 'notice',
        userId: targetUserId,
        notice: {
          action: 'restrict',
          roomId,
          note: input.userReason ?? null,
          expiresAt: created.expiresAt?.toISOString() ?? null,
        },
      });
    }
    return {
      id: created.id,
      kind: input.kind,
      expiresAt: created.expiresAt?.toISOString() ?? null,
    };
  }

  // Rooms
  // "Disable / Enable Chat Rooms" (OFF hides the room; MAINTENANCE shows the note).
  async setRoomStatus(
    user: ChatUserContext,
    roomRef: string,
    input: { status: RoomStatus; note?: string },
  ): Promise<{ roomId: string; status: RoomStatus } | StaffRequested> {
    this.staffOnly(user);
    if (!(ROOM_STATUSES as readonly string[]).includes(input.status)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'status', message: 'ACTIVE, MAINTENANCE or DISABLED' }],
      });
    }
    const mode = await this.gate.mode(user, 'ROOM_STATUS');
    const room = await this.access.requireRoom(roomRef);
    if (mode === 'REPORT') {
      return this.gate.report(user, 'ROOM_STATUS', {
        targetRoomId: room.id,
        payload: {
          status: input.status,
          ...(input.note ? { statusNote: input.note } : {}),
        },
        note: input.note ?? `Please set the room to ${input.status}`,
      });
    }
    const patch: Record<string, unknown> = { status: input.status };
    if (input.note) patch.statusNote = input.note.slice(0, 300);
    await this.writeRoomConfig(user, room.id, patch, 'staff.room_status');
    return { roomId: room.id, status: input.status };
  }

  // "Edit Chat Rules (Text): Chat Rooms Whose rules this role can change".
  async setRules(
    user: ChatUserContext,
    roomRef: string,
    input: { rules: string[]; note?: string },
  ): Promise<{ roomId: string; rules: string[] } | StaffRequested> {
    const role = this.staffOnly(user);
    const rules = input.rules.map((r) => r.trim()).filter((r) => r.length > 0);
    if (rules.length > 50 || rules.some((r) => r.length > 500)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'rules',
            message: 'At most 50 rules of at most 500 characters',
          },
        ],
      });
    }
    const mode = await this.gate.mode(user, 'EDIT_RULES');
    const room = await this.access.requireRoom(roomRef);
    if (mode === 'REPORT') {
      return this.gate.report(user, 'EDIT_RULES', {
        targetRoomId: room.id,
        payload: { rules },
        note: input.note ?? 'Please update the rules of this room',
      });
    }
    const scope = rolePermissions(await this.gate.settings(), role)?.rulesRoomIds ?? [];
    if (!roomInScope(scope, room.id))
      throw this.outOfScope('Your role may not edit the rules of this room');
    await this.writeRoomConfig(user, room.id, { rules }, 'staff.room_rules');
    return { roomId: room.id, rules };
  }

  // "Change chat Room access for user (Remove / Add user from specific rooms)".
  async setRoomAccess(
    user: ChatUserContext,
    roomRef: string,
    input: {
      userId: string;
      action: 'ADD' | 'REMOVE' | 'RESTORE';
      note?: string;
    },
  ): Promise<
    { roomId: string; userId: string; action: 'ADD' | 'REMOVE' | 'RESTORE' } | StaffRequested
  > {
    this.staffOnly(user);
    const mode = await this.gate.mode(user, 'ROOM_ACCESS');
    const room = await this.access.requireRoom(roomRef);
    const target = await this.staff.assertCanActOn(user, input.userId);
    if (mode === 'REPORT') {
      return this.gate.report(user, 'ROOM_ACCESS', {
        targetUserId: target.id,
        targetRoomId: room.id,
        payload: { action: input.action },
        note: input.note ?? `Please ${input.action.toLowerCase()} this user's access to the room`,
      });
    }
    await this.staffDb.transaction(async (tx) => {
      await this.staffDb.setRoomAccess(tx, room.id, target.id, input.action, user.id);
      await this.records.recordAction(tx, {
        actorType: 'STAFF',
        actorId: user.id,
        action: `staff.room_${input.action.toLowerCase()}`,
        targetUserId: target.id,
        targetRoomId: room.id,
        note: input.note ?? null,
      });
    });
    this.bus.publish({ kind: 'user', userId: target.id });
    return { roomId: room.id, userId: target.id, action: input.action };
  }

  private async writeRoomConfig(
    user: ChatUserContext,
    roomId: string,
    patch: Record<string, unknown>,
    action: string,
  ): Promise<void> {
    const found = await this.staffDb.transaction(async (tx) => {
      const before = await this.staffDb.patchRoomConfig(tx, roomId, patch);
      if (before === null) return false;
      await this.records.recordAction(tx, {
        actorType: 'STAFF',
        actorId: user.id,
        action,
        targetRoomId: roomId,
        oldValue: before,
        newValue: patch,
      });
      return true;
    });
    if (!found)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Room not found',
      });
    this.bus.publish({ kind: 'room', roomId });
  }

  // Chat-wide commands
  // "Disable Specific Commands from chat" / "Disable All Commands from chat".
  async setChatCommands(
    user: ChatUserContext,
    input: { enabled?: boolean; disabled?: ChatCommand[]; note?: string },
  ): Promise<{ enabled: boolean; disabled: string[] } | StaffRequested> {
    this.staffOnly(user);
    const mode = await this.gate.mode(user, 'DISABLE_COMMANDS');
    const patch = {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
    };
    if (mode === 'REPORT') {
      return this.gate.report(user, 'DISABLE_COMMANDS', {
        payload: patch,
        note: input.note ?? 'Please change which commands chat accepts',
      });
    }
    await this.writeGlobal(user, { commands: patch }, 'staff.commands', input.note ?? null);
    const effective = await this.gate.settings();
    return {
      enabled: effective.commands.enabled,
      disabled: [...effective.commands.disabled],
    };
  }

  // "Disable / Enable Sending Money from Chat", for everyone.
  async setGiftsEnabled(
    user: ChatUserContext,
    input: { enabled: boolean; note?: string },
  ): Promise<{ enabled: boolean } | StaffRequested> {
    this.staffOnly(user);
    const mode = await this.gate.mode(user, 'SENDING_MONEY');
    if (mode === 'REPORT') {
      return this.gate.report(user, 'SENDING_MONEY', {
        payload: { enabled: input.enabled },
        note: input.note ?? `Please turn sending money from chat ${input.enabled ? 'on' : 'off'}`,
      });
    }
    await this.writeGlobal(
      user,
      { gifts: { enabled: input.enabled } },
      'staff.gifts',
      input.note ?? null,
    );
    return { enabled: (await this.gate.settings()).gifts.enabled };
  }

  // Merges keys into the chat-wide settings under a row lock, validated against the contract, recorded.
  private async writeGlobal(
    user: ChatUserContext,
    global: Record<string, Record<string, unknown>>,
    action: string,
    note: string | null,
  ): Promise<void> {
    await this.settingsDb.transaction(async (tx) => {
      const current = ChatSettingsDocumentSchema.parse(
        await this.settingsDb.lockSettingsDocument(tx),
      );
      const next = ChatSettingsDocumentSchema.safeParse(applySettingsPatch(current, { global }));
      if (!next.success) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          errors: next.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
      }
      await this.settingsDb.writeSettingsDocument(tx, next.data, null);
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(global)) {
        before[key] = (current.global as Record<string, unknown>)[key] ?? null;
      }
      await this.records.recordAction(tx, {
        actorType: 'STAFF',
        actorId: user.id,
        action,
        oldValue: before,
        newValue: global,
        note,
      });
    });
    this.bus.publish({ kind: 'settings' });
  }
}
