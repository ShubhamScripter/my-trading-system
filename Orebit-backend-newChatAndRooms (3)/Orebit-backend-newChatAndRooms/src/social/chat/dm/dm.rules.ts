// The pure rules of personal chat (Modules 8–9, Chat MAIN "Personal Chat", Chat DM Settings). No I/O, so one test
// covers them.
import type { GroupPermission, VisibilityChoice } from '../chat.features.contract';
import type { ChatSettings } from '../chat.settings.contract';

export type DmFolder = 'PRIMARY' | 'GENERAL' | 'GROUPS' | 'MERCHANT';
export type MemberState = 'ACTIVE' | 'REQUEST' | 'DECLINED' | 'LEFT' | 'REMOVED' | 'BANNED';
export type GroupRole = 'OWNER' | 'ADMIN' | 'SUB_ADMIN' | 'MEMBER';

export interface Follow {
  // The viewer follows the other user.
  readonly following: boolean;
  // The other user follows the viewer.
  readonly followedBy: boolean;
}

// Where a new direct conversation lands for one of its two members (Chat DM Settings "Auto Assign Folders"):
// - Primary: friends (follow and follow back); people the user follows; everyone the user DMs first.
// - General: people who follow the user (not followed back) when they DM first.
// - Neither follows the other and the other wrote first: a message request, which goes to General once accepted
// ("General: Accepted Requests from Pending DMs").
export function directPlacement(
  startedByViewer: boolean,
  follow: Follow,
): { folder: 'PRIMARY' | 'GENERAL'; state: 'ACTIVE' | 'REQUEST' } {
  if (startedByViewer || follow.following) return { folder: 'PRIMARY', state: 'ACTIVE' };
  if (follow.followedBy) return { folder: 'GENERAL', state: 'ACTIVE' };
  return { folder: 'GENERAL', state: 'REQUEST' };
}

export function areFriends(follow: Follow): boolean {
  return follow.following && follow.followedBy;
}

// The two user ids of a direct conversation in order: one conversation per pair.
export function directKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// "Last seen / online … which can be hidden" and "Common Groups … who can see": ALL, FRIENDS or NOBODY.
export function visibleTo(choice: VisibilityChoice, isSelf: boolean, isFriend: boolean): boolean {
  if (isSelf) return true;
  if (choice === 'ALL') return true;
  if (choice === 'FRIENDS') return isFriend;
  return false;
}

// Quiet mode and notifications

export interface NotificationPrefs {
  readonly notifyPrimary: boolean;
  readonly notifyGeneral: boolean;
  readonly notifyGroups: boolean;
  readonly quietMode: 'AUTO_NIGHT' | 'OFF' | 'CUSTOM';
  // Null while the admin has not set the quiet window: quiet hours then never apply.
  readonly quietStart: string | null;
  readonly quietEnd: string | null;
  readonly timeZone: string | null;
}

// The user's stored choices over the admin defaults ("Default Notifications", "Quiet Mode Defaults").
export function effectivePrefs(
  settings: ChatSettings,
  stored: {
    notifyPrimary: boolean | null;
    notifyGeneral: boolean | null;
    notifyGroups: boolean | null;
    quietMode: string | null;
    quietStart: string | null;
    quietEnd: string | null;
    timeZone: string | null;
  },
): NotificationPrefs {
  const p = settings.privacy;
  const chosen = (stored.quietMode as NotificationPrefs['quietMode'] | null) ?? p.quietModeDefault;
  // "Allow User to change Quiet mode timings: YES / NO": without it a stored CUSTOM is ignored and the admin's
  // default mode applies (it used to become AUTO_NIGHT even when the admin default was OFF).
  const mode = chosen === 'CUSTOM' && !p.allowQuietChange ? p.quietModeDefault : chosen;
  const custom = mode === 'CUSTOM';
  return {
    notifyPrimary: stored.notifyPrimary ?? p.notifyPrimary,
    notifyGeneral: stored.notifyGeneral ?? p.notifyGeneral,
    notifyGroups: stored.notifyGroups ?? p.notifyGroups,
    quietMode: mode,
    quietStart: custom ? (stored.quietStart ?? p.quietStart) : p.quietStart,
    quietEnd: custom ? (stored.quietEnd ?? p.quietEnd) : p.quietEnd,
    timeZone: stored.timeZone,
  };
}

// Minutes since midnight in the time zone; null when the zone is unknown or invalid (there is no UTC fallback).
const formatters = new Map<string, Intl.DateTimeFormat>();

export function localMinutes(at: Date, timeZone: string | null): number | null {
  if (!timeZone) return null;
  try {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      if (formatters.size >= 128) formatters.delete(formatters.keys().next().value!);
      formatters.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(at);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

// "Quiet mode … automatically disable all notifications for a specific time frame of the day (example: night)", in the
// user's account time zone. Without a known zone quiet hours never apply: no automatic night mode.
export function inQuietHours(prefs: NotificationPrefs, at: Date): boolean {
  if (prefs.quietMode === 'OFF') return false;
  if (prefs.quietStart === null || prefs.quietEnd === null) return false;
  const now = localMinutes(at, prefs.timeZone);
  if (now === null) return false;
  const start = toMinutes(prefs.quietStart);
  const end = toMinutes(prefs.quietEnd);
  if (start === end) return false;
  // A window across midnight (22:00–07:00) wraps.
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// Whether a new message should notify this member: their per-conversation choice ("Inbox wise") over the folder's
// ("Folder wise"), and never in quiet hours.
export function shouldNotify(
  prefs: NotificationPrefs,
  member: { folder: DmFolder; notifications: 'DEFAULT' | 'ON' | 'OFF'; state: MemberState },
  at: Date,
): boolean {
  if (member.state !== 'ACTIVE' && member.state !== 'REQUEST') return false;
  if (inQuietHours(prefs, at)) return false;
  if (member.notifications !== 'DEFAULT') return member.notifications === 'ON';
  if (member.folder === 'GROUPS') return prefs.notifyGroups;
  if (member.folder === 'PRIMARY') return prefs.notifyPrimary;
  return prefs.notifyGeneral;
}

// Groups

export const GROUP_RANK: Readonly<Record<GroupRole, number>> = {
  OWNER: 4,
  ADMIN: 3,
  SUB_ADMIN: 2,
  MEMBER: 1,
};

// The group's defaults: who may do each action until the owner changes it.
export const DEFAULT_GROUP_PERMISSIONS: Readonly<Record<GroupPermission, GroupRole>> = {
  RENAME: 'ADMIN',
  CHANGE_DESCRIPTION: 'ADMIN',
  CHANGE_IMAGE: 'ADMIN',
  REMOVE_PEOPLE: 'ADMIN',
  ADD_PEOPLE: 'SUB_ADMIN',
  CHANGE_TYPE: 'OWNER',
  DELETE_MESSAGES: 'SUB_ADMIN',
  TIMEOUT: 'SUB_ADMIN',
  BAN: 'ADMIN',
};

// The lowest role allowed an action in this group. A permission the admin panel does not let group admins delegate
// ("Settings / Permissions which Group Admins can allow others to set") stays with the owner.
export function roleFor(
  permission: GroupPermission,
  stored: Partial<Record<GroupPermission, GroupRole>>,
  delegable: readonly GroupPermission[],
): GroupRole {
  if (!delegable.includes(permission)) return 'OWNER';
  return stored[permission] ?? DEFAULT_GROUP_PERMISSIONS[permission];
}

export function mayDo(
  role: GroupRole,
  permission: GroupPermission,
  stored: Partial<Record<GroupPermission, GroupRole>>,
  delegable: readonly GroupPermission[],
): boolean {
  return GROUP_RANK[role] >= GROUP_RANK[roleFor(permission, stored, delegable)];
}

// A member may act on another only when strictly above them.
export function outranks(actor: GroupRole, target: GroupRole): boolean {
  return GROUP_RANK[actor] > GROUP_RANK[target];
}

// "Group Admin can set if the members can text in the group or not": admins and above always can.
export function mayText(
  role: GroupRole,
  membersCanText: boolean,
  timeoutUntil: Date | null,
  now: Date,
): boolean {
  if (timeoutUntil && timeoutUntil.getTime() > now.getTime()) return false;
  return membersCanText || GROUP_RANK[role] >= GROUP_RANK.SUB_ADMIN;
}
