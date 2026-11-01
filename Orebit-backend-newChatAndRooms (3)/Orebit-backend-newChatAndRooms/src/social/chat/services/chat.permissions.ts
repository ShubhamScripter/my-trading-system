/**
 * Chat SETTINGS "Moderation Role Permissions" (Module 4), as pure rules: what a staff role may do, whether it acts
 * itself or asks a higher role (ACT / REPORT), and the scope limits that come with a permission (rooms, ban length,
 * whose penalties it may change). The settings are the `staffRoles` section of the chat settings; nothing here reads
 * a database, so one table-driven test covers it.
 */
import type { ChatCommand, RestrictionKind, StaffRole } from '../chat.contract';
import { STAFF_RANK } from '../chat.constants';
import {
  STAFF_PERMISSIONS,
  type PermissionMode,
  type RolePermissions,
  type StaffPermission,
} from '../chat.features.contract';
import type { ChatSettings } from '../chat.settings.contract';

/** Penalties an admin gave in the admin panel rank above every chat role: no app staff may change them. */
export const ADMIN_PANEL_RANK = 100;
/** Penalties from auto-moderation rank below every chat role. */
export const SYSTEM_RANK = 0;

export function rankOf(role: StaffRole | null | undefined): number {
  return role ? (STAFF_RANK[role] ?? 0) : 0;
}

export function rolePermissions(
  settings: ChatSettings,
  role: StaffRole | null | undefined,
): RolePermissions | null {
  if (!role) return null;
  return (settings.staffRoles as Record<string, RolePermissions | undefined>)[role] ?? null;
}

/** ACT, REPORT or NONE; everyone without a chat role has NONE for everything. */
export function modeOf(
  settings: ChatSettings,
  role: StaffRole | null | undefined,
  permission: StaffPermission,
): PermissionMode {
  return rolePermissions(settings, role)?.permissions[permission] ?? 'NONE';
}

export function canAct(
  settings: ChatSettings,
  role: StaffRole | null | undefined,
  permission: StaffPermission,
): boolean {
  return modeOf(settings, role, permission) === 'ACT';
}

/** Every permission with its mode, for the app's staff tools. */
export function permissionTable(
  settings: ChatSettings,
  role: StaffRole | null | undefined,
): Record<StaffPermission, PermissionMode> {
  const out = {} as Record<StaffPermission, PermissionMode>;
  for (const permission of STAFF_PERMISSIONS) out[permission] = modeOf(settings, role, permission);
  return out;
}

/**
 * The permission behind each restriction kind. A mute is a lighter ban; media restrictions are "Allow / Restrict
 * others to send pictures" or "… videos" (either is enough).
 */
export const RESTRICTION_PERMISSIONS: Readonly<
  Record<RestrictionKind, readonly StaffPermission[]>
> = {
  MUTE: ['BAN'],
  RESTRICT_MEDIA: ['MANAGE_PICTURES', 'MANAGE_VIDEOS'],
  RESTRICT_EMOJI: ['RESTRICT_EMOJI'],
  RESTRICT_GIF: ['RESTRICT_GIF'],
  RESTRICT_COMMANDS: ['RESTRICT_COMMANDS'],
  RESTRICT_ADS: ['RESTRICT_ADS'],
  RESTRICT_DM: ['RESTRICT_DM'],
  RESTRICT_GIFTS: ['RESTRICT_GIFTS'],
  // "Restrict a user from receiving Amount through chat" sits with the other money restriction.
  RESTRICT_RECEIVE_GIFTS: ['RESTRICT_GIFTS'],
  RESTRICT_RAIN: ['RESTRICT_RAIN'],
  RESTRICT_RAIN_RECEIVE: ['RESTRICT_RAIN_RECEIVE'],
  RESTRICT_PIN: ['PIN'],
  RESTRICT_DELETE_MESSAGES: ['DELETE_MESSAGES'],
  RESTRICT_HISTORY: ['SEE_HISTORY'],
  RESTRICT_STAFF_ROOM: ['JOIN_STAFF_ROOM'],
  RESTRICT_IMAGES: ['MANAGE_PICTURES'],
  RESTRICT_VIDEOS: ['MANAGE_VIDEOS'],
};

/** The best mode the role has for a restriction kind (ACT beats REPORT). */
export function restrictionMode(
  settings: ChatSettings,
  role: StaffRole | null | undefined,
  kind: RestrictionKind,
): PermissionMode {
  const modes = RESTRICTION_PERMISSIONS[kind].map((p) => modeOf(settings, role, p));
  if (modes.includes('ACT')) return 'ACT';
  if (modes.includes('REPORT')) return 'REPORT';
  return 'NONE';
}

/** "Pin Messages: Select Chat rooms" and "Edit Chat Rules: Chat Rooms Whose rules this role can change". */
export function roomInScope(roomIds: readonly string[], roomId: string): boolean {
  return roomIds.length === 0 || roomIds.includes(roomId);
}

/** "Restrict Commands of User: Select Commands which can be restricted by this role". */
export function commandsInScope(
  allowed: readonly ChatCommand[] | readonly string[],
  wanted: readonly string[],
): boolean {
  if (allowed.length === 0) return true;
  // An empty wanted list means "every command", which needs an unrestricted role.
  if (wanted.length === 0) return false;
  return wanted.every((command) => (allowed as readonly string[]).includes(command));
}

/** The longest ban the role may give, never more than the chat-wide maximum. */
export function maxBanHoursFor(settings: ChatSettings, role: StaffRole | null | undefined): number {
  const own = rolePermissions(settings, role)?.maxBanHours ?? 0;
  return Math.min(own, settings.limits.maxBanHours);
}

/**
 * "Change / Remove Penalties of Users banned / restricted by other Moderation Team: Only of same Level / Only of
 * Level Below their role / Same + Below". Your own penalties you may always change.
 */
export function penaltyInScope(
  settings: ChatSettings,
  role: StaffRole | null | undefined,
  issuerRank: number,
  issuedByMe: boolean,
): boolean {
  if (issuedByMe) return true;
  const scope = rolePermissions(settings, role)?.penaltyScope;
  if (!scope) return false;
  const mine = rankOf(role);
  if (scope === 'SAME') return issuerRank === mine;
  if (scope === 'BELOW') return issuerRank < mine;
  return issuerRank <= mine;
}

/**
 * How far back the role may read: CHAT "Can see Chat history of last: x days" (also the bot log), MESSAGES "Can see
 * message history of last: x Days", TAGS "Can see tag history of last: x Days", USER_HISTORY "View User History: Max
 * Time Period History Accessible". The last three fall back to the chat history days when not set.
 */
export function historyDaysFor(
  settings: ChatSettings,
  role: StaffRole | null | undefined,
  kind: 'CHAT' | 'MESSAGES' | 'TAGS' | 'USER_HISTORY' = 'CHAT',
): number {
  const perms = rolePermissions(settings, role);
  if (!perms) return 0;
  if (kind === 'MESSAGES') return perms.messageHistoryDays ?? perms.historyDays;
  if (kind === 'TAGS') return perms.tagHistoryDays ?? perms.historyDays;
  if (kind === 'USER_HISTORY') return perms.userHistoryDays ?? perms.historyDays;
  return perms.historyDays;
}
