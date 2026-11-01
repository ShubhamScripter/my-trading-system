/** ─── DM API client (Modules 8–9) ─────────────────────────────────────────────
 *  Every route of dm.routes.ts, with the exact request bodies the backend validates (unknown fields are refused).
 *  Responses are mapped into the shapes in `@/types/dm` here, so components never see the raw backend views.
 */
import { apiFetch } from './client';
import type {
  DmConversation,
  DmConversationDetail,
  DmFolder,
  DmMessage,
  DmMessagePage,
  DmPrivacy,
  DmUnread,
  GroupDetail,
  GroupInvite,
  GroupMember,
  GroupPermissionKey,
  GroupRole,
  GroupType,
} from '@/types/dm';

interface Envelope<T> { data: T }

/* eslint-disable @typescript-eslint/no-explicit-any -- raw backend views are mapped right below */
type Raw = any;

// ─── Mapping backend views ────────────────────────────────────────────────────

export function toMessage(m: Raw): DmMessage {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderUsername: m.senderUsername ?? 'unknown',
    content: m.content ?? '',
    type: m.type ?? 'TEXT',
    isRetracted: !!m.isRetracted,
    isHidden: !!m.isHidden,
    isPinned: !!m.isPinned,
    gift: m.gift ?? null,
    card: m.card ?? null,
    event: m.event ?? null,
    forwarded: m.forwarded ?? null,
    media: m.media ?? null,
    createdAt: m.createdAt,
    ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
  };
}

function lastMessageText(m: Raw): string {
  if (!m) return '';
  if (m.isRetracted) return 'Message retracted';
  if (m.isHidden) return 'Message removed';
  if (m.type === 'GIFT' && m.gift) return `🎁 ${m.gift.amount} ${m.gift.currency}`;
  if (m.type === 'CARD' && m.card) return `🎁 ${m.card.title}`;
  if (m.type === 'SYSTEM') return m.event?.kind ? `Group: ${m.event.kind.replace(/_/g, ' ')}` : '';
  if (m.media && !m.content) return m.media.type === 'video' ? '🎬 Video' : '🖼️ Photo';
  return m.content ?? '';
}

/** One inbox row. */
export function toConversation(c: Raw): DmConversation {
  const isGroup = c.kind === 'GROUP';
  const peer = !isGroup && c.user
    ? {
        id: c.user.id,
        username: c.user.username ?? 'unknown',
        isOnline: c.user.presence?.online ?? undefined,
        lastSeenAt: c.user.presence?.lastSeenAt ?? null,
      }
    : undefined;
  const group = isGroup && c.group
    ? {
        id: c.id,
        name: c.group.name,
        imageUrl: c.group.logoUrl ?? null,
        memberCount: c.group.memberCount ?? 0,
        visibility: c.group.visibility,
      }
    : undefined;
  return {
    id: c.id,
    kind: c.kind,
    folder: c.folder,
    peer,
    group,
    merchantApp: c.merchantApp ?? null,
    nickname: c.user?.nickname ?? null,
    displayName: isGroup ? (c.group?.name ?? 'Group') : (c.user?.nickname || c.user?.username || 'Unknown'),
    lastMessage: c.lastMessage
      ? { content: lastMessageText(c.lastMessage), createdAt: c.lastMessage.createdAt, isRetracted: c.lastMessage.isRetracted }
      : null,
    unreadCount: c.unread ?? 0,
    isPinned: !!c.isPinned,
    notifications: c.notifications ?? 'DEFAULT',
    notificationsOff: c.notifications === 'OFF',
    peerLastReadMessageId: c.user?.lastReadMessageId ?? null,
    updatedAt: c.lastActivityAt,
  };
}

/** GET /dm/conversations/:id → the detail with members and group info. */
export function toDetail(d: Raw): DmConversationDetail {
  const selfId: string = d.me?.userId;
  const members: GroupMember[] = (d.members ?? []).map((m: Raw) => ({
    userId: m.userId,
    username: m.username,
    role: m.role ?? 'MEMBER',
    state: m.state,
    isOnline: m.presence?.online ?? undefined,
    timedOutUntil: m.timeoutUntil ?? null,
    lastReadMessageId: m.lastReadMessageId ?? null,
    joinedAt: '',
  }));
  const other = d.kind === 'DIRECT' ? d.members?.find((m: Raw) => m.userId !== selfId) : null;
  const isGroup = d.kind === 'GROUP';
  return {
    id: d.id,
    kind: d.kind,
    folder: d.me?.folder,
    peer: other
      ? {
          id: other.userId,
          username: other.username,
          isOnline: other.presence?.online ?? undefined,
          lastSeenAt: other.presence?.lastSeenAt ?? null,
        }
      : undefined,
    group: isGroup && d.group
      ? {
          id: d.id,
          name: d.group.name,
          imageUrl: d.group.logoUrl ?? null,
          memberCount: d.memberCount ?? 0,
          visibility: d.group.visibility,
        }
      : undefined,
    nickname: d.me?.nickname ?? null,
    displayName: isGroup ? (d.group?.name ?? 'Group') : (d.me?.nickname || other?.username || 'Unknown'),
    lastMessage: null,
    unreadCount: 0,
    isPinned: !!d.me?.isPinned,
    notifications: d.me?.notifications ?? 'DEFAULT',
    notificationsOff: d.me?.notifications === 'OFF',
    peerLastReadMessageId: other?.lastReadMessageId ?? null,
    updatedAt: new Date().toISOString(),
    me: {
      userId: selfId,
      role: d.me?.role ?? null,
      state: d.me?.state,
      timeoutUntil: d.me?.timeoutUntil ?? null,
      lastReadMessageId: d.me?.lastReadMessageId ?? null,
    },
    members,
    groupInfo: isGroup && d.group
      ? {
          description: d.group.description ?? null,
          ownerId: d.group.ownerId,
          membersCanText: !!d.group.membersCanText,
          permissions: d.group.permissions ?? {},
          adminManageable: d.group.adminManageable ?? [],
          isChannel: !!d.group.isChannel,
        }
      : null,
  };
}

function page<T>(raw: Raw, map: (x: Raw) => T): { items: T[]; nextCursor: string | null } {
  return { items: (raw?.items ?? []).map(map), nextCursor: raw?.nextCursor ?? null };
}

const qs = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  return q.toString();
};

// ─── Inbox ───────────────────────────────────────────────────────────────────

/** One tab of the inbox. Pinned people come first on the first page. */
export async function getConversations(
  folder: DmFolder = 'PRIMARY',
  options: { limit?: number; cursor?: string | null; appId?: string | null } = {},
): Promise<{ items: DmConversation[]; nextCursor: string | null }> {
  const res = await apiFetch<Envelope<Raw>>(
    `/social/chat/dm/conversations?${qs({ folder, limit: options.limit ?? 30, cursor: options.cursor, appId: options.appId })}`,
  );
  const raw = res.data;
  return {
    items: [...(raw?.pinned ?? []), ...(raw?.items ?? [])].map(toConversation),
    nextCursor: raw?.nextCursor ?? null,
  };
}

/** The Merchant folder per app: conversations and unread of each (appId null = no app). */
export async function getMerchantApps(): Promise<
  { appId: string | null; name: string | null; conversations: number; unread: number }[]
> {
  const res = await apiFetch<Envelope<Raw>>('/social/chat/dm/merchant-apps');
  return res.data?.apps ?? [];
}

export async function getUnread(): Promise<DmUnread> {
  const u = (await apiFetch<Envelope<Raw>>('/social/chat/dm/unread')).data ?? {};
  const primary = u.primary ?? 0;
  const general = u.general ?? 0;
  const groups = u.groups ?? 0;
  const merchant = u.merchant ?? 0;
  const requests = u.requests ?? 0;
  return {
    primary,
    general,
    groups,
    merchant,
    channels: u.channels ?? 0,
    requests,
    total: primary + general + groups + merchant + requests,
  };
}

/** Opens (or finds) the direct conversation with a user (id, username or login code), optionally with a message. */
export async function openConversation(
  userId: string,
  firstMessage?: string,
): Promise<DmConversation> {
  const res = await apiFetch<Envelope<Raw>>('/social/chat/dm/conversations', {
    method: 'POST',
    body: { userId, ...(firstMessage ? { content: firstMessage } : {}) },
    fallbackMessage: 'Could not open conversation',
  });
  return getConversation(res.data.conversationId ?? res.data.id);
}

export async function getConversation(conversationId: string): Promise<DmConversationDetail> {
  const res = await apiFetch<Envelope<Raw>>(`/social/chat/dm/conversations/${conversationId}`);
  return toDetail(res.data);
}

/** "Users can also search DMs for specific texts": matching messages, newest first. */
export async function searchMessages(
  query: string,
  options: { conversationId?: string; limit?: number; cursor?: string | null } = {},
): Promise<{ items: DmMessage[]; nextCursor: string | null }> {
  const res = await apiFetch<Envelope<Raw>>(
    `/social/chat/dm/search?${qs({ q: query, conversationId: options.conversationId, limit: options.limit ?? 20, cursor: options.cursor })}`,
    { fallbackMessage: 'Search failed' },
  );
  return page(res.data, toMessage);
}

// ─── Messages ─────────────────────────────────────────────────────────────────

/** Newest first from the server; returned oldest → newest for display. */
export async function getDmHistory(
  conversationId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<DmMessagePage> {
  const res = await apiFetch<Envelope<Raw>>(
    `/social/chat/dm/conversations/${conversationId}/messages?${qs({ limit: options.limit ?? 50, cursor: options.cursor })}`,
  );
  const p = page(res.data, toMessage);
  return { messages: p.items.reverse(), nextCursor: p.nextCursor };
}

export async function sendDmMessage(
  conversationId: string,
  content: string,
  options: { mediaUrl?: string; mediaType?: 'image' | 'gif' | 'video'; thumbnailUrl?: string; clientMessageId?: string } = {},
): Promise<DmMessage> {
  const res = await apiFetch<Envelope<Raw>>(`/social/chat/dm/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { ...(content ? { content } : {}), ...options },
    fallbackMessage: 'Failed to send message',
  });
  return toMessage(res.data.message ?? res.data);
}

/** Read receipts: my read position moves to this message (never backwards). */
export async function markRead(conversationId: string, messageId: string): Promise<void> {
  await apiFetch(`/social/chat/dm/conversations/${conversationId}/read`, {
    method: 'POST',
    body: { messageId },
    fallbackMessage: 'Failed to mark as read',
  });
}

export async function acceptRequest(conversationId: string): Promise<void> {
  await apiFetch(`/social/chat/dm/conversations/${conversationId}/accept`, {
    method: 'POST',
    fallbackMessage: 'Failed to accept request',
  });
}

export async function declineRequest(conversationId: string): Promise<void> {
  await apiFetch(`/social/chat/dm/conversations/${conversationId}/decline`, {
    method: 'POST',
    fallbackMessage: 'Failed to decline request',
  });
}

// ─── Conversation settings ────────────────────────────────────────────────────

/** Only direct conversations move, between PRIMARY and GENERAL. */
export async function moveFolder(conversationId: string, folder: 'PRIMARY' | 'GENERAL'): Promise<void> {
  await apiFetch(`/social/chat/dm/conversations/${conversationId}/folder`, {
    method: 'POST',
    body: { folder },
    fallbackMessage: 'Failed to move conversation',
  });
}

export async function pinPerson(conversationId: string, pinned: boolean): Promise<void> {
  await apiFetch(`/social/chat/dm/conversations/${conversationId}/pin`, {
    method: 'POST',
    body: { pinned },
    fallbackMessage: 'Failed to update pin',
  });
}

/** Friends only; null removes it. */
export async function setNickname(conversationId: string, nickname: string | null): Promise<void> {
  await apiFetch(`/social/chat/dm/conversations/${conversationId}/nickname`, {
    method: 'POST',
    body: { nickname },
    fallbackMessage: 'Failed to set nickname',
  });
}

/** `muted` true = OFF; false = DEFAULT (follow the folder setting). */
export async function setNotifications(conversationId: string, muted: boolean): Promise<void> {
  await apiFetch(`/social/chat/dm/conversations/${conversationId}/notifications`, {
    method: 'POST',
    body: { notifications: muted ? 'OFF' : 'DEFAULT' },
    fallbackMessage: 'Failed to update notifications',
  });
}

export async function getPinnedMessages(conversationId: string): Promise<DmMessage[]> {
  const res = await apiFetch<Envelope<Raw>>(`/social/chat/dm/conversations/${conversationId}/pinned`);
  return (res.data?.items ?? []).map(toMessage);
}

/** "See all the shared links and media (photos and videos)". */
export async function getSharedMedia(
  conversationId: string,
  kind: 'media' | 'links' = 'media',
): Promise<{ messageId: string; url?: string; type?: string; links?: string[]; content?: string; createdAt: string }[]> {
  const res = await apiFetch<Envelope<Raw>>(
    `/social/chat/dm/conversations/${conversationId}/shared?${qs({ kind, limit: 50 })}`,
  );
  return (res.data?.items ?? []).map((i: Raw) => ({
    messageId: i.messageId,
    createdAt: i.createdAt,
    ...(i.media ? { url: i.media.url, type: i.media.type } : {}),
    ...(i.links ? { links: i.links, content: i.content } : {}),
  }));
}

/** The gift button: a gift to the other member; confirm with POST /social/chat/gifts/{giftId}/confirm. */
export async function startDmGift(
  conversationId: string,
  amount: string,
  currency: string,
): Promise<{ giftId: string; verification: 'PAYMENT_PIN' | 'TWO_FA'; expiresAt: string }> {
  const res = await apiFetch<Envelope<Raw>>(`/social/chat/dm/conversations/${conversationId}/gift`, {
    method: 'POST',
    body: { amount, currency },
    fallbackMessage: 'Failed to start gift',
  });
  return res.data;
}

/** "Users can also see common groups with their friends" (follows their privacy). */
export async function getCommonGroups(
  userId: string,
): Promise<{ id: string; name: string; imageUrl?: string | null }[]> {
  const res = await apiFetch<Envelope<Raw>>(`/social/chat/dm/users/${encodeURIComponent(userId)}/common-groups`);
  return (res.data?.items ?? []).map((g: Raw) => ({ id: g.id, name: g.name, imageUrl: g.logoUrl ?? null }));
}

// ─── Message actions ──────────────────────────────────────────────────────────

export async function retractDmMessage(messageId: string): Promise<void> {
  await apiFetch(`/social/chat/dm/messages/${messageId}/retract`, {
    method: 'POST',
    fallbackMessage: 'Failed to retract message',
  });
}

export async function pinDmMessage(messageId: string, pinned: boolean): Promise<void> {
  await apiFetch(`/social/chat/dm/messages/${messageId}/pin`, {
    method: 'POST',
    body: { pinned },
    fallbackMessage: 'Failed to pin message',
  });
}

export async function forwardDmMessage(messageId: string, targetConversationIds: string[]): Promise<void> {
  await apiFetch(`/social/chat/dm/messages/${messageId}/forward`, {
    method: 'POST',
    body: { conversationIds: targetConversationIds },
    fallbackMessage: 'Failed to forward message',
  });
}

/** `reason` is a report-reason code (GET /social/chat/report-reasons). */
export async function reportDmMessage(messageId: string, reason: string, details?: string): Promise<void> {
  await apiFetch(`/social/chat/dm/messages/${messageId}/report`, {
    method: 'POST',
    body: { reason, ...(details ? { details } : {}) },
    fallbackMessage: 'Failed to report message',
  });
}

// ─── Privacy settings ────────────────────────────────────────────────────────

export async function getDmPrivacy(): Promise<DmPrivacy> {
  return (await apiFetch<Envelope<DmPrivacy>>('/social/chat/dm/privacy')).data;
}

/** Read-only fields are dropped: the server refuses unknown fields. */
export async function updateDmPrivacy(patch: Partial<DmPrivacy>): Promise<DmPrivacy> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- read-only fields (and the account time zone) stay out of the body
  const { inQuietHoursNow, canChangeQuietTimes, timeZone, ...body } = patch;
  const res = await apiFetch<Envelope<DmPrivacy>>('/social/chat/dm/privacy', {
    method: 'PUT',
    body,
    fallbackMessage: 'Failed to update privacy settings',
  });
  return res.data;
}

// ─── Groups (Module 9) ────────────────────────────────────────────────────────

export interface GroupCreateInput {
  name: string;
  description?: string;
  type: GroupType;
  /** A channel: only admins post. It is public or private like any group. */
  isChannel?: boolean;
  /** A chat upload URL (POST /social/chat/messages/media) — other URLs are refused. */
  imageUrl?: string;
  /** Usernames to invite (private groups). */
  inviteUserIds?: string[];
}

/** Creates the group; answers its id and the invites sent. */
export async function createGroup(
  input: GroupCreateInput,
): Promise<{ groupId: string; invited: { username: string }[] }> {
  const res = await apiFetch<Envelope<Raw>>('/social/chat/dm/groups', {
    method: 'POST',
    body: {
      name: input.name,
      visibility: input.type,
      ...(input.isChannel ? { isChannel: true } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.imageUrl ? { logoUrl: input.imageUrl } : {}),
      ...(input.inviteUserIds?.length ? { inviteUserIds: input.inviteUserIds } : {}),
    },
    fallbackMessage: 'Failed to create group',
  });
  return { groupId: res.data.groupId, invited: res.data.invited ?? [] };
}

/** A gift card from the user's coupons to the other person of a direct chat (V2-99). A retry with the same id gives it once. */
export async function sendGiftCard(
  conversationId: string,
  couponId: string,
  clientMessageId: string,
): Promise<{ messageId: string; duplicate: boolean }> {
  const res = await apiFetch<Envelope<Raw>>(`/social/chat/dm/conversations/${conversationId}/gift-card`, {
    method: 'POST',
    body: { couponId, clientMessageId },
    fallbackMessage: 'Failed to send the gift card',
  });
  return { messageId: res.data.messageId, duplicate: !!res.data.duplicate };
}

/** One page of a group's members (a group is never sent whole). Timeouts show only to admins and to the member. */
export async function getGroupMembers(
  groupId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<{ items: GroupMember[]; nextCursor: string | null; memberCount: number }> {
  const res = await apiFetch<Envelope<Raw>>(
    `/social/chat/dm/conversations/${groupId}/members?${qs({ limit: options.limit ?? 50, cursor: options.cursor })}`,
  );
  const items: GroupMember[] = (res.data.items ?? []).map((m: Raw) => ({
    userId: m.userId,
    username: m.username,
    role: m.role ?? 'MEMBER',
    state: m.state,
    isOnline: m.presence?.online ?? undefined,
    timedOutUntil: m.timeoutUntil ?? null,
    lastReadMessageId: m.lastReadMessageId ?? null,
    joinedAt: '',
  }));
  return { items, nextCursor: res.data.nextCursor ?? null, memberCount: res.data.memberCount ?? items.length };
}

/** Public groups anyone may join, searchable by name. */
export async function getPublicGroups(options: {
  limit?: number;
  cursor?: string | null;
  q?: string;
} = {}): Promise<{ items: GroupDetail[]; nextCursor: string | null }> {
  const res = await apiFetch<Envelope<Raw>>(
    `/social/chat/dm/groups/public?${qs({ limit: options.limit ?? 20, q: options.q, cursor: options.cursor })}`,
  );
  return page(res.data, (g: Raw) => ({
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    imageUrl: g.logoUrl ?? null,
    type: 'PUBLIC' as const,
    memberCount: g.memberCount ?? 0,
    maxMembers: 0,
    role: null,
    isMember: !!g.isMember,
    createdAt: '',
  }));
}

export interface GroupUpdateInput {
  name?: string;
  description?: string | null;
  type?: GroupType;
  imageUrl?: string | null;
  membersCanText?: boolean;
}

export async function updateGroup(groupId: string, input: GroupUpdateInput): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}`, {
    method: 'PUT',
    body: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.type !== undefined ? { visibility: input.type } : {}),
      ...(input.imageUrl !== undefined ? { logoUrl: input.imageUrl } : {}),
      ...(input.membersCanText !== undefined ? { membersCanText: input.membersCanText } : {}),
    },
    fallbackMessage: 'Failed to update group',
  });
}

/** "Settings / Permissions which Group Admins can allow others to set": each permission → the lowest role allowed. */
export async function updateGroupPermissions(
  groupId: string,
  permissions: Partial<Record<GroupPermissionKey, GroupRole>>,
): Promise<Partial<Record<GroupPermissionKey, GroupRole>>> {
  const res = await apiFetch<Envelope<Raw>>(`/social/chat/dm/groups/${groupId}/permissions`, {
    method: 'PUT',
    body: { permissions },
    fallbackMessage: 'Failed to update permissions',
  });
  return res.data?.permissions ?? permissions;
}

export async function joinGroup(groupId: string): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}/join`, { method: 'POST', fallbackMessage: 'Failed to join group' });
}

export async function leaveGroup(groupId: string): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}/leave`, { method: 'POST', fallbackMessage: 'Failed to leave group' });
}

/** Ids, usernames or login codes. */
export async function inviteToGroup(groupId: string, userIds: string[]): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}/invites`, {
    method: 'POST',
    body: { userIds },
    fallbackMessage: 'Failed to send invites',
  });
}

export async function getInvites(): Promise<GroupInvite[]> {
  const res = await apiFetch<Envelope<Raw>>('/social/chat/dm/invites');
  return (res.data?.items ?? []).map((i: Raw) => ({
    id: i.id,
    group: { id: i.groupId, name: i.groupName, imageUrl: i.groupLogoUrl ?? null, memberCount: 0 },
    invitedBy: { id: i.inviterId, username: i.inviterUsername ?? 'member' },
    createdAt: i.createdAt,
  }));
}

export async function answerInvite(inviteId: string, accept: boolean): Promise<void> {
  await apiFetch(`/social/chat/dm/invites/${inviteId}/answer`, {
    method: 'POST',
    body: { accept },
    fallbackMessage: 'Failed to answer invite',
  });
}

// ─── Member management ────────────────────────────────────────────────────────

/** Owners name admins and sub-admins; admins name sub-admins. Ownership moves only by transfer. */
export async function setMemberRole(groupId: string, userId: string, role: Exclude<GroupRole, 'OWNER'>): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}/members/${userId}/role`, {
    method: 'POST',
    body: { role },
    fallbackMessage: 'Failed to set role',
  });
}

export async function removeMember(groupId: string, userId: string): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}/members/${userId}/remove`, {
    method: 'POST',
    fallbackMessage: 'Failed to remove member',
  });
}

/** "Timeout User (They cannot text)"; null ends it. */
export async function timeoutMember(groupId: string, userId: string, minutes: number | null): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}/members/${userId}/timeout`, {
    method: 'POST',
    body: { minutes },
    fallbackMessage: 'Failed to timeout member',
  });
}

/** "Ban User (for public groups)"; `banned: false` lifts it. */
export async function banMember(
  groupId: string,
  userId: string,
  options: { banned?: boolean; reason?: string } = {},
): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}/members/${userId}/ban`, {
    method: 'POST',
    body: { banned: options.banned ?? true, ...(options.reason ? { reason: options.reason } : {}) },
    fallbackMessage: 'Failed to ban member',
  });
}

/** "Delete Messages (only deleted on user end)". */
export async function deleteGroupMessage(groupId: string, messageId: string): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}/messages/${messageId}/delete`, {
    method: 'POST',
    fallbackMessage: 'Failed to delete message',
  });
}

/** "Group Admin can transfer ownership to other user": it happens at once and asks no code (V2-144). */
export async function startOwnershipTransfer(groupId: string, newOwnerUserId: string): Promise<void> {
  await apiFetch(`/social/chat/dm/groups/${groupId}/transfer`, {
    method: 'POST',
    body: { userId: newOwnerUserId },
    fallbackMessage: 'Failed to transfer ownership',
  });
}
