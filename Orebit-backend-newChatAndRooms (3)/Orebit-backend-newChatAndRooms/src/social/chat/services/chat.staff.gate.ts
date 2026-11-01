// The door every staff action goes through (Module 4, Chat SETTINGS "Moderation Role Permissions"):
// - ACT: the staff member does it themselves;
// - REPORT: "they can ask their above role to do it" — a staff request is stored with the requester's text and
// shown to online staff of a higher role who may ACT on that permission (and to admins in the panel);
// - NONE: refused with `permission_denied`.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, SERVER_EVENTS, personalRoom } from '../chat.constants';
import { RESTRICTION_KINDS, type RestrictionKind } from '../chat.contract';
import type { PermissionMode, StaffPermission } from '../chat.features.contract';
import { ChatAccessService } from '../chat.access.service';
import { ChatDbOperation } from '../chat.dboperation';
import { refuse } from '../chat.moderation.service';
import { ChatPresenceService } from '../chat.presence.service';
import { ChatSettingsService } from '../chat.settings';
import type { ChatSettings } from '../chat.settings.contract';
import { ChatStaffDbOperation } from '../persistence/chat.staff.dboperation';
import { ChatBus } from '../realtime/chat.bus';
import type { ChatUserContext } from '../chat.types';
import { canAct, modeOf, rankOf, restrictionMode } from './chat.permissions';
import { ChatRestrictionsService } from './chat.restrictions.service';

// The permissions an admin or a higher role can take away from one staff member without changing the role's table
// : "Restrict Pinning", "Restrict Deleting Messages", "Restrict Seeing History". Staff room and media are
// enforced where the room is entered and the message is sent.
const TAKEN_AWAY_BY: Readonly<Partial<Record<StaffPermission, RestrictionKind>>> = {
  PIN: 'RESTRICT_PIN',
  DELETE_MESSAGES: 'RESTRICT_DELETE_MESSAGES',
  SEE_HISTORY: 'RESTRICT_HISTORY',
};

// What a REPORT-mode action answers with instead of acting.
export interface StaffRequested {
  readonly requested: true;
  readonly requestId: string;
  readonly permission: string;
  readonly createdAt: string;
}

export function isRequested(value: unknown): value is StaffRequested {
  return (
    typeof value === 'object' && value !== null && (value as StaffRequested).requested === true
  );
}

@Injectable()
export class ChatStaffGate {
  constructor(
    private readonly settingsService: ChatSettingsService,
    private readonly db: ChatStaffDbOperation,
    private readonly presence: ChatPresenceService,
    private readonly bus: ChatBus,
    private readonly restrictions: ChatRestrictionsService,
    private readonly access: ChatAccessService,
    private readonly chatDb: ChatDbOperation,
  ) {}

  // The restriction that takes this permission away from this staff member, or null.
  private async takenAway(
    user: ChatUserContext,
    permission: StaffPermission,
  ): Promise<{ kind: RestrictionKind; reason: string; expiresAt: string | null } | null> {
    const kind = TAKEN_AWAY_BY[permission];
    if (!kind || !user.staffRole) return null;
    const found = await this.restrictions.find(
      user,
      await this.access.factsFor(user),
      kind,
      null,
      await this.chatDb.dbNow(),
    );
    return found ? { kind, reason: found.reason, expiresAt: found.expiresAt } : null;
  }

  private async assertNotTakenAway(user: ChatUserContext, permission: StaffPermission): Promise<void> {
    const found = await this.takenAway(user, permission);
    if (!found) return;
    throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.RESTRICTED, found.reason, {
      permission,
      restriction: found.kind,
      expiresAt: found.expiresAt,
    });
  }

  // Staff permissions are chat-wide, never per country.
  settings(): Promise<ChatSettings> {
    return this.settingsService.global();
  }

  private denied(permission: string): ProblemException {
    return refuse(
      ERR.FORBIDDEN,
      CHAT_REFUSAL_REASONS.PERMISSION_DENIED,
      'Your chat role does not have this permission',
      { permission },
    );
  }

  // ACT or REPORT; NONE is refused.
  async mode(user: ChatUserContext, permission: StaffPermission): Promise<'ACT' | 'REPORT'> {
    const mode = modeOf(await this.settings(), user.staffRole, permission);
    if (mode === 'NONE') throw this.denied(permission);
    await this.assertNotTakenAway(user, permission);
    return mode;
  }

  async restrictionMode(user: ChatUserContext, kind: RestrictionKind): Promise<'ACT' | 'REPORT'> {
    const mode: PermissionMode = restrictionMode(await this.settings(), user.staffRole, kind);
    if (mode === 'NONE') throw this.denied(kind);
    return mode;
  }

  // ACT only (reading lists, resolving requests).
  async requireAct(user: ChatUserContext, permission: StaffPermission): Promise<ChatSettings> {
    const settings = await this.settings();
    if (!canAct(settings, user.staffRole, permission)) throw this.denied(permission);
    await this.assertNotTakenAway(user, permission);
    return settings;
  }

  async canAct(user: ChatUserContext, permission: StaffPermission): Promise<boolean> {
    if (!canAct(await this.settings(), user.staffRole, permission)) return false;
    return (await this.takenAway(user, permission)) === null;
  }

  // Files a REPORT-mode request and tells the online staff who may act on it. `note` is the requester's text box;
// the action's reason is used when they leave it empty.
  async report(
    user: ChatUserContext,
    permission: string,
    data: {
      targetUserId?: string | null;
      targetRoomId?: string | null;
      payload: Record<string, unknown>;
      note: string;
    },
  ): Promise<StaffRequested> {
    if (!user.staffRole) throw this.denied(permission);
    const created = await this.db.createRequest({
      requesterId: user.id,
      requesterRole: user.staffRole,
      permission,
      targetUserId: data.targetUserId ?? null,
      targetRoomId: data.targetRoomId ?? null,
      payload: data.payload,
      note: data.note.slice(0, 1000),
    });
    const request = {
      requestId: created.id,
      permission,
      requesterId: user.id,
      requesterUsername: user.username,
      targetUserId: data.targetUserId ?? null,
      targetRoomId: data.targetRoomId ?? null,
      note: data.note,
      createdAt: created.createdAt.toISOString(),
    };
    await this.notifyResolvers(user, permission, request);
    this.bus.publish({ kind: 'staff_request', requestId: created.id });
    return {
      requested: true,
      requestId: created.id,
      permission,
      createdAt: created.createdAt.toISOString(),
    };
  }

  // Online staff ranked above the requester who may ACT on the permission (or on any restriction kind).
  private async notifyResolvers(
    requester: ChatUserContext,
    permission: string,
    payload: unknown,
  ): Promise<void> {
    const settings = await this.settings();
    const mine = rankOf(requester.staffRole);
    const sent = new Set<string>();
    for (const socket of this.presence.allSockets()) {
      const staff = socket.data.user;
      if (!staff.staffRole || sent.has(staff.id) || rankOf(staff.staffRole) <= mine) continue;
      if (!this.mayResolve(settings, staff, permission)) continue;
      sent.add(staff.id);
      socket.nsp.to(personalRoom(staff.id)).emit(SERVER_EVENTS.STAFF_REQUEST, payload);
    }
  }

  // Whether `staff` may approve a request for `permission` (a permission name or a restriction kind).
  mayResolve(settings: ChatSettings, staff: ChatUserContext, permission: string): boolean {
    // A restriction kind is resolved by the permission behind it (RESTRICT_MEDIA by pictures or videos…).
    if ((RESTRICTION_KINDS as readonly string[]).includes(permission)) {
      return restrictionMode(settings, staff.staffRole, permission as RestrictionKind) === 'ACT';
    }
    return canAct(settings, staff.staffRole, permission as StaffPermission);
  }
}
