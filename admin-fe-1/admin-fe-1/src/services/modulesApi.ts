/**
 * The admin API of chat Modules 4–9 (Orebit-admin-backend chat.modules.routes.ts): restrictions, ban and restriction
 * edits, the bot log and staff requests (Module 4); ads, gifts, their reverts and the command log (Module 5); DM and
 * group oversight (Modules 8–9). Writes answer `{ success, error?, ...data }` like the rest of AdminAPI; reads throw.
 */
import { API_BASE, postJson } from './api';

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are shown as the backend sends them */

async function get<T = any>(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const res = await fetch(`${API_BASE}${path}${q.toString() ? `?${q}` : ''}`, { credentials: 'include' });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.errors?.[0]?.message || json?.detail || json?.title || `Request failed (${res.status})`);
  return (json?.data ?? json) as T;
}

const post = (path: string, body: unknown) => postJson(`${API_BASE}${path}`, body);

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
export const RESTRICTION_TARGETS = ['USER', 'PREMIUM', 'KYC', 'LEVEL'] as const;
export const CHAT_COMMANDS = ['help', 'dm', 'mute', 'unmute', 'mutelist', 'block', 'unblock', 'blocklist', 'send', 'ad', 'rain'] as const;

export interface Restriction {
  id: string;
  targetType: string;
  targetValue: string;
  targetUsername: string | null;
  kind: string;
  commands: string[];
  roomId: string | null;
  roomName: string | null;
  internalReason: string;
  userReason: string | null;
  createdBy: string | null;
  createdByRole: string | null;
  createdAt: string;
  expiresAt: string | null;
  liftedAt: string | null;
  isActive: boolean;
}

export interface StaffRequest {
  id: string;
  requesterUsername: string | null;
  requesterRole: string | null;
  permission: string;
  targetUserId: string | null;
  targetUsername: string | null;
  targetRoomName: string | null;
  payload: Record<string, unknown>;
  note: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface BotLogEntry {
  id: string;
  action: string;
  userId: string | null;
  username: string | null;
  roomId: string | null;
  detail: unknown;
  note: string | null;
  createdAt: string;
}

export interface AdRow {
  id: string;
  advertiser: string;
  content: string;
  roomIds: string[];
  allRooms: boolean;
  pinMinutes: number | null;
  repeatCount: number;
  postedCount: number;
  badgeId: string | null;
  skinId: string | null;
  rewardsReverted: boolean;
  priceUsd: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
  cancelNote: string | null;
  refundUsd: string | null;
  refundedAt: string | null;
}

export interface GiftRow {
  id: string;
  sender: string | null;
  recipient: string | null;
  currency: string;
  amount: string;
  usdValue: string | null;
  feeAmount: string | null;
  roomId: string | null;
  conversationId: string | null;
  verification: string;
  status: string;
  transferReference: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
  revertRequestedAt: string | null;
  revertedAt: string | null;
}

export interface RevertFilter {
  from: string;
  to: string;
  userIds?: string[];
  minUsd?: string;
  maxUsd?: string;
  /** "group of users": queued; the chat server checks who is in the group on its next tick. */
  group?: { targetType: 'PREMIUM' | 'KYC' | 'LEVEL'; value?: string };
  dryRun?: boolean;
  note?: string;
}

export type SupportStatus = 'PENDING' | 'OPEN' | 'CLOSED';

export interface SupportTicket {
  id: string;
  userId: string;
  username: string | null;
  subject: string;
  status: SupportStatus;
  lastMessageAt: string;
  createdAt: string;
  closedAt: string | null;
}

export interface SupportMessage {
  id: string;
  fromSupport: boolean;
  senderUsername: string | null;
  content: string;
  createdAt: string;
}

export const ModulesAPI = {
  // ─── Module 4: restrictions, penalties, bot log, staff requests ───
  restrictions: (q: { active?: boolean; userId?: string; before?: string } = {}) =>
    get<{ restrictions: Restriction[] }>('/restrictions', {
      active: q.active === false ? 'false' : 'true',
      userId: q.userId,
      before: q.before,
      limit: 100,
    }).then((d) => d.restrictions ?? []),
  createRestriction: (body: {
    targetType: (typeof RESTRICTION_TARGETS)[number];
    targetValue: string;
    kind: (typeof RESTRICTION_KINDS)[number];
    commands?: string[];
    roomId?: string | null;
    internalReason: string;
    userReason?: string;
    durationHours?: number;
  }) => post('/restrictions', body),
  liftRestriction: (restrictionId: string, note?: string) =>
    post('/restrictions/lift', { restrictionId, ...(note ? { note } : {}) }),
  changeRestriction: (restrictionId: string, durationHours: number | null, internalReason?: string, note?: string) =>
    post('/restrictions/change', { restrictionId, durationHours, ...(internalReason ? { internalReason } : {}), ...(note ? { note } : {}) }),
  changeBan: (banId: string, change: { durationHours?: number; permanent?: true; internalReason?: string; userReason?: string; note?: string }) =>
    post('/bans/change', { banId, ...change }),
  botLog: (q: { userId?: string; before?: string } = {}) =>
    get<{ entries: BotLogEntry[] }>('/bot-log', { userId: q.userId, before: q.before, limit: 100 }).then((d) => d.entries ?? []),
  staffRequests: (status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL' = 'PENDING') =>
    get<{ requests: StaffRequest[] }>('/staff/requests', { status, limit: 100 }).then((d) => d.requests ?? []),
  resolveStaffRequest: (requestId: string, approve: boolean, note?: string) =>
    post('/staff/requests/resolve', { requestId, approve, ...(note ? { note } : {}) }),

  // ─── Module 5: ads, gifts, reverts, command log ───
  ads: (status = 'ALL') => get<{ ads: AdRow[] }>('/ads', { status, limit: 100 }).then((d) => d.ads ?? []),
  createAd: (body: {
    content: string;
    roomIds: string[];
    allRooms: boolean;
    pinMinutes: number | null;
    repeatCount: number;
    repeatGapMinutes: number | null;
    badgeId: string | null;
    hiddenCountries: string[];
  }) => post('/ads', body),
  cancelAd: (adId: string, refund: 'NONE' | 'UNUSED' | 'FULL', note?: string) =>
    post('/ads/cancel', { adId, refund, ...(note ? { note } : {}) }),
  revertAds: (filter: RevertFilter & { adIds?: string[]; pinnedOnly?: boolean }) => post('/ads/revert', filter),
  gifts: (q: { status?: string; userId?: string } = {}) =>
    get<{ gifts: GiftRow[] }>('/gifts', { status: q.status ?? 'ALL', userId: q.userId, limit: 100 }).then((d) => d.gifts ?? []),
  revertGifts: (filter: RevertFilter & { currencies?: string[]; refundFees?: boolean }) => post('/gifts/revert', filter),
  commandLog: (userId?: string) =>
    get<{ commands: any[] }>('/commands', { userId, limit: 100 }).then((d) => d.commands ?? []),

  // ─── Modules 8–9: DM and group oversight ───
  /** One page of a user's conversations; looking is recorded in the moderation log. */
  userConversations: (userId: string, cursor?: string | null) =>
    get<{ userId: string; conversations: any[]; nextCursor: string | null }>('/dm/conversations', {
      userId,
      limit: 50,
      cursor: cursor ?? undefined,
    }),
  /** "UnEncrypt User Conversations": needs a reason, which is recorded with every page read. */
  readConversation: (conversationId: string, reason: string, cursor?: string | null) =>
    post('/dm/conversations/read', { conversationId, reason, limit: 100, ...(cursor ? { cursor } : {}) }),
  groups: (q?: string, cursor?: string | null) =>
    get<{ groups: any[]; nextCursor: string | null }>('/dm/groups', { q, limit: 50, cursor: cursor ?? undefined }),

  // ─── Module 10: support chat ───
  supportTickets: (q: { status?: SupportStatus; cursor?: string | null } = {}) =>
    get<{ items: SupportTicket[]; nextCursor: string | null }>('/support/tickets', { status: q.status, cursor: q.cursor, limit: 50 }),
  supportTicket: (ticketId: string) =>
    get<{ ticket: SupportTicket; messages: SupportMessage[] }>('/support/ticket', { ticketId }),
  replyTicket: (ticketId: string, content: string) => post('/support/tickets/reply', { ticketId, content }),
  closeTicket: (ticketId: string) => post('/support/tickets/close', { ticketId }),
};
