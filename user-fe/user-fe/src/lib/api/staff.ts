/** ─── Module 4 — Staff tools API client ─────────────────────────────────────
 *  What a chat staff member (ADMIN / MODERATOR / SUPPORT) may do in the app.
 *  Routes: chat.staff.routes.ts and the warn / ban routes of chat.routes.ts.
 *  An action the role only has in REPORT mode answers `{ requested: true, requestId }`:
 *  a higher role decides (see `isRequested`).
 */
import { apiFetch } from './client';

interface Envelope<T> { data: T }

export type PermissionMode = 'ACT' | 'REPORT' | 'NONE';
export type StaffRole = 'ADMIN' | 'MODERATOR' | 'SUPPORT';

export const RESTRICTION_KINDS = [
  'MUTE',
  'RESTRICT_MEDIA',
  'RESTRICT_EMOJI',
  'RESTRICT_GIF',
  'RESTRICT_COMMANDS',
  'RESTRICT_ADS',
  'RESTRICT_DM',
  'RESTRICT_GIFTS',
  'RESTRICT_RECEIVE_GIFTS',
  'RESTRICT_RAIN',
  'RESTRICT_RAIN_RECEIVE',
  'RESTRICT_PIN',
  'RESTRICT_DELETE_MESSAGES',
  'RESTRICT_HISTORY',
  'RESTRICT_STAFF_ROOM',
  'RESTRICT_IMAGES',
  'RESTRICT_VIDEOS',
] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export const CHAT_COMMANDS = [
  'help', 'dm', 'mute', 'unmute', 'mutelist', 'block', 'unblock', 'blocklist', 'send', 'ad', 'rain',
] as const;

export interface StaffPermissions {
  role: StaffRole | null;
  permissions: Record<string, PermissionMode>;
  maxBanHours: number;
  penaltyScope: string | null;
  historyDays: number;
  pinRoomIds: string[];
  rulesRoomIds: string[];
  restrictableCommands: string[];
  groupPrivilege: boolean;
}

export interface StaffRequested {
  requested: true;
  requestId: string;
  permission?: string;
}

export function isRequested(value: unknown): value is StaffRequested {
  return !!value && typeof value === 'object' && (value as { requested?: unknown }).requested === true;
}

export interface StaffBan {
  id: string;
  userId: string;
  username: string | null;
  roomId: string | null;
  internalReason: string;
  userReason: string | null;
  by: 'ADMIN_PANEL' | 'STAFF' | 'AUTO_MODERATION';
  bannedAt: string;
  expiresAt: string | null;
}

export interface StaffRestriction {
  id: string;
  targetType: string;
  targetValue: string;
  username: string | null;
  kind: string;
  commands: string[];
  roomId: string | null;
  internalReason: string;
  userReason?: string;
  by: 'ADMIN_PANEL' | 'STAFF';
  createdAt: string;
  expiresAt: string | null;
}

export interface StaffReport {
  id: string;
  messageId: string | null;
  dmMessageId: string | null;
  roomId: string | null;
  messageContent: string | null;
  messageRetracted: boolean;
  reporterUsername: string | null;
  reportedUserId: string | null;
  reportedUsername: string | null;
  internalReason: string;
  userReason?: string;
  reason?: string;
  details: string | null;
  status: string;
  action: string | null;
  createdAt: string;
}

export interface StaffRequest {
  id: string;
  permission: string;
  requesterUsername: string | null;
  requesterRole: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  targetRoomId: string | null;
  payload: Record<string, unknown>;
  note: string | null;
  status: string;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface StaffMessage {
  id: string;
  roomId: string;
  username?: string;
  authorId?: string;
  content?: string;
  type?: string;
  createdAt: string;
  isRetracted: boolean;
}

export interface BotLogEntry {
  id: string;
  action: string;
  roomId: string | null;
  detail: unknown;
  note: string | null;
  createdAt: string;
}

export interface Page<T> { items: T[]; nextCursor: string | null }

const enc = encodeURIComponent;
const query = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

async function get<T>(path: string, fallbackMessage: string): Promise<T> {
  return (await apiFetch<Envelope<T>>(path, { fallbackMessage })).data;
}

async function post<T>(path: string, body: unknown, fallbackMessage: string): Promise<T> {
  return (await apiFetch<Envelope<T>>(path, { method: 'POST', body, fallbackMessage })).data;
}

// ─── Who am I ─────────────────────────────────────────────────────────────────
export const getPermissions = () =>
  get<StaffPermissions>('/social/chat/staff/permissions', 'Could not load your staff permissions');

/** A username, login code or id → the user's id (the staff routes take ids). */
export async function resolveUser(handle: string): Promise<{ id: string; username: string }> {
  const profile = await get<{ id: string; username: string }>(
    `/social/chat/users/${enc(handle.trim().replace(/^@/, ''))}/profile`,
    'User not found',
  );
  return { id: profile.id, username: profile.username };
}

// ─── Warn, ban, restrict ──────────────────────────────────────────────────────
export const warnUser = (input: {
  userId?: string;
  group?: { targetType: 'PREMIUM' | 'KYC' | 'LEVEL'; targetValue: string };
  roomId?: string;
  internalReason?: string;
  userReason?: string;
  reason?: string;
}) =>
  post<unknown>(
    '/social/chat/staff/warn',
    {
      ...input,
      internalReason: input.internalReason ?? input.reason ?? '',
    },
    'Could not warn the user',
  );

export const banUser = (input: {
  userId: string;
  roomId?: string;
  internalReason: string;
  userReason?: string;
  durationHours?: number;
  permanent?: true;
}) => post<unknown>('/social/chat/staff/ban', input, 'Could not ban the user');

export const restrict = (input: {
  targetType: 'USER' | 'PREMIUM' | 'KYC' | 'LEVEL';
  targetValue: string;
  kind: RestrictionKind;
  commands?: string[];
  roomId?: string;
  internalReason: string;
  userReason?: string;
  durationHours?: number;
  note?: string;
}) => post<unknown>('/social/chat/staff/restrict', input, 'Could not add the restriction');

// ─── Penalties ────────────────────────────────────────────────────────────────
export const getPenalties = (userId?: string) =>
  get<{ bans: StaffBan[]; restrictions: StaffRestriction[]; nextBefore: string | null }>(
    `/social/chat/staff/penalties${query({ userId, limit: 100 })}`,
    'Could not load penalties',
  );

export const liftBan = (banId: string, note?: string) =>
  post<unknown>(`/social/chat/staff/bans/${banId}/lift`, note ? { note } : {}, 'Could not lift the ban');

export const changeBan = (
  banId: string,
  input: { durationHours?: number; permanent?: true; internalReason?: string; userReason?: string; note?: string },
) => post<unknown>(`/social/chat/staff/bans/${banId}/change`, input, 'Could not change the ban');

export const liftRestriction = (id: string, note?: string) =>
  post<unknown>(`/social/chat/staff/restrictions/${id}/lift`, note ? { note } : {}, 'Could not lift the restriction');

export const changeRestriction = (
  id: string,
  input: { durationHours?: number | null; internalReason?: string; userReason?: string; note?: string },
) => post<unknown>(`/social/chat/staff/restrictions/${id}/change`, input, 'Could not change the restriction');

// ─── Reports ──────────────────────────────────────────────────────────────────
export const getReports = (status = 'PENDING', cursor?: string | null) =>
  get<Page<StaffReport>>(
    `/social/chat/staff/reports${query({ status, cursor, limit: 50 })}`,
    'Could not load reports',
  );

export const actOnReport = (
  reportId: string,
  input: { action: 'DISMISS' | 'WARN' | 'BAN' | 'RETRACT_MESSAGE'; durationHours?: number; permanent?: true; note?: string },
) => post<unknown>(`/social/chat/staff/reports/${reportId}/action`, input, 'Could not act on the report');

// ─── A user ───────────────────────────────────────────────────────────────────
export const getUserMessages = (userId: string, cursor?: string | null) =>
  get<Page<StaffMessage>>(`/social/chat/staff/users/${userId}/messages${query({ cursor })}`, 'Could not load messages');

export const getUserTags = (userId: string, cursor?: string | null) =>
  get<Page<StaffMessage>>(`/social/chat/staff/users/${userId}/tags${query({ cursor })}`, 'Could not load tags');

/** "View User History": the user's activity in other features, within the role's features and days. */
export interface UserHistoryEntry {
  feature: string;
  at: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export const getUserHistory = (userId: string, feature?: string, cursor?: string | null) =>
  get<{ userId: string; days: number; features: string[] | 'ALL'; items: UserHistoryEntry[]; nextCursor: string | null }>(
    `/social/chat/staff/users/${userId}/history${query({ feature, cursor })}`,
    'Could not load the user history',
  );

export const getUserStats = (userId: string) =>
  get<{ userId: string; stats: Record<string, Record<string, number | string>> }>(
    `/social/chat/staff/users/${userId}/stats`,
    'Could not load stats',
  );

export const getBotLog = (userId: string, cursor?: string | null) =>
  get<{ userId: string; items: BotLogEntry[]; nextCursor: string | null }>(
    `/social/chat/staff/users/${userId}/bot-log${query({ cursor })}`,
    'Could not load the bot log',
  );

// ─── Rooms ────────────────────────────────────────────────────────────────────
export const getRoomHistory = (roomId: string, cursor?: string | null) =>
  get<Page<StaffMessage>>(`/social/chat/staff/rooms/${enc(roomId)}/history${query({ cursor })}`, 'Could not load history');

export const setRoomStatus = (roomId: string, status: 'ACTIVE' | 'MAINTENANCE' | 'DISABLED', note?: string) =>
  post<unknown>(`/social/chat/staff/rooms/${enc(roomId)}/status`, { status, ...(note ? { note } : {}) }, 'Could not change the room status');

export const setRoomRules = (roomId: string, rules: string[]) =>
  post<unknown>(`/social/chat/staff/rooms/${enc(roomId)}/rules`, { rules }, 'Could not save the rules');

export const setRoomAccess = (roomId: string, userId: string, action: 'ADD' | 'REMOVE' | 'RESTORE', note?: string) =>
  post<unknown>(`/social/chat/staff/rooms/${enc(roomId)}/access`, { userId, action, ...(note ? { note } : {}) }, 'Could not change room access');

// ─── Chat-wide ────────────────────────────────────────────────────────────────

export const setCommands = (input: { enabled?: boolean; disabled?: string[]; note?: string }) =>
  post<unknown>('/social/chat/staff/commands', input, 'Could not change commands');

/**
 * "Disable Overall Rains" (OVERALL), "Disable Rainpool Rains" (SYSTEM), "Disable User Rains" (USER). ACT switches it;
 * REPORT files a request to a higher role with the note.
 */
export const setRainStatus = (scope: 'OVERALL' | 'SYSTEM' | 'USER', status: 'ON' | 'OFF', note?: string) =>
  post<unknown>('/social/rain/status', { scope, status, ...(note ? { note } : {}) }, 'Could not change the rain status');

export const setGiftsEnabled = (enabled: boolean, note?: string) =>
  post<unknown>('/social/chat/staff/gifts', { enabled, ...(note ? { note } : {}) }, 'Could not change sending money');

// ─── Requests (REPORT mode) ───────────────────────────────────────────────────
export const getRequests = (scope: 'TO_RESOLVE' | 'MINE' = 'TO_RESOLVE') =>
  get<Page<StaffRequest>>(`/social/chat/staff/requests${query({ scope, limit: 50 })}`, 'Could not load requests');

export const resolveRequest = (requestId: string, approve: boolean, note?: string) =>
  post<unknown>(`/social/chat/staff/requests/${requestId}/resolve`, { approve, ...(note ? { note } : {}) }, 'Could not resolve the request');
