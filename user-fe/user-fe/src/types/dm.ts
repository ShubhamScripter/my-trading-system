/** ─── DM & Groups type definitions (Modules 8–9) ─────────────────────────────
 *  Mirror the backend dto/contract shapes (dm.dto.ts, dm.groups.dboperation.ts,
 *  chat.features.contract.ts). Keep in sync with backend changes.
 */

// ─── Inbox ────────────────────────────────────────────────────────────────────

/** The tabs of the DM inbox (Chat DM Settings: CHANNELS = the public groups among GROUPS). */
export type DmFolder = 'PRIMARY' | 'GENERAL' | 'GROUPS' | 'MERCHANT' | 'CHANNELS' | 'REQUESTS';

/** A user summary as it appears in a conversation item. */
export interface DmUser {
  id: string;
  username: string;
  avatarUrl?: string | null;
  isOnline?: boolean;
  lastSeenAt?: string | null;
}

/** A group summary as it appears in a conversation item. */
export interface DmGroupSummary {
  id: string;
  name: string;
  imageUrl?: string | null;
  memberCount: number;
  visibility?: GroupType;
}

/** A single conversation row in the inbox. */
export interface DmConversation {
  id: string;
  kind: 'DIRECT' | 'GROUP';
  folder: DmFolder;
  /** Populated for DIRECT conversations. */
  peer?: DmUser;
  /** Populated for GROUP conversations. */
  group?: DmGroupSummary;
  /** Merchant DMs: the merchant's app the conversation is about ("sorted separately by apps"). */
  merchantApp?: { id: string; name: string } | null;
  /** The display name: nickname (if set), else peer username or group name. */
  displayName: string;
  /** Custom nickname set by current user for a DIRECT convo. */
  nickname?: string | null;
  lastMessage?: {
    content: string;
    createdAt: string;
    isRetracted?: boolean;
  } | null;
  unreadCount: number;
  isPinned: boolean;
  notificationsOff: boolean;
  /** DEFAULT follows the folder setting. */
  notifications?: 'DEFAULT' | 'ON' | 'OFF';
  /** The other member's read position (read receipts). */
  peerLastReadMessageId?: string | null;
  updatedAt: string;
}

/** Unread totals returned by GET /social/chat/dm/unread */
export interface DmUnread {
  total: number;
  primary: number;
  general: number;
  groups: number;
  /** Chat MAIN "SO / Merchants: a separate chat folder for all merchant chats" (site owners only). */
  merchant: number;
  /** The public groups among groups (counted in groups as well). */
  channels: number;
  requests: number;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

/** A message in a direct or group conversation. */
export interface DmMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderUsername: string;
  content: string;
  /** TEXT, MEDIA, GIFT (a gift notice) or SYSTEM (a group event line). */
  type: 'TEXT' | 'MEDIA' | 'GIFT' | 'CARD' | 'SYSTEM';
  isRetracted: boolean;
  /** Hidden by a group admin or chat staff. */
  isHidden: boolean;
  isPinned: boolean;
  gift?: { giftId: string; amount: string; currency: string; recipientId?: string; recipientUsername?: string } | null;
  /** A gift card (V2-99): what it is; the code never comes to the chat. */
  card?: { title: string; amount: string; currency: string; receiverUsername: string } | null;
  /** SYSTEM rows: what happened (joined, removed, role, …). */
  event?: { kind: string; actorId: string; targetId?: string; value?: string; joined?: number; left?: number } | null;
  clientMessageId?: string;
  media?: {
    type: 'image' | 'video' | 'gif';
    url: string;
    caption?: string;
    thumbnailUrl?: string;
  } | null;
  /** Present when this message was forwarded ("Forwarded" notice). */
  forwarded?: { fromUsername: string | null } | null;
  createdAt: string;
}

/** Cursor-paginated page of DM messages. */
export interface DmMessagePage {
  messages: DmMessage[];
  nextCursor: string | null;
}

// ─── Conversation detail ──────────────────────────────────────────────────────

/** Full conversation detail (GET /social/chat/dm/conversations/:id). */
export interface DmConversationDetail extends DmConversation {
  /** My membership: role in a group, timeout, read position. */
  me: {
    userId: string;
    role: GroupRole | null;
    state: string;
    timeoutUntil: string | null;
    lastReadMessageId: string | null;
  };
  members: GroupMember[];
  /** GROUP conversations only. */
  groupInfo: {
    description: string | null;
    ownerId: string;
    membersCanText: boolean;
    /** Who may do what: permission → the lowest role allowed. */
    permissions: Partial<Record<GroupPermissionKey, GroupRole>>;
    /** The permissions the owner lets admins change. */
    adminManageable: GroupPermissionKey[];
    /** A channel: only admins post. */
    isChannel: boolean;
  } | null;
}

// ─── Privacy ─────────────────────────────────────────────────────────────────

export type VisibilityChoice = 'ALL' | 'FRIENDS' | 'NOBODY';

export type QuietMode = 'AUTO_NIGHT' | 'OFF' | 'CUSTOM';

export interface DmPrivacy {
  lastSeenVisibility: VisibilityChoice;
  commonGroupsVisibility: VisibilityChoice;
  notifyPrimary: boolean;
  notifyGeneral: boolean;
  notifyGroups: boolean;
  quietMode: QuietMode;
  quietStart: string | null;
  quietEnd: string | null;
  /** Read-only: the account time zone; quiet hours follow it (set it in account settings). */
  timeZone: string | null;
  /** The one switch for "typing..." and read receipts, in both directions. */
  typingReceiptsEnabled: boolean;
  /** Read-only. */
  inQuietHoursNow?: boolean;
  /** Read-only: custom quiet times need the admin's permission. */
  canChangeQuietTimes?: boolean;
}

// ─── Groups (Module 9) ────────────────────────────────────────────────────────

export type GroupType = 'PUBLIC' | 'PRIVATE';
export type GroupRole = 'OWNER' | 'ADMIN' | 'SUB_ADMIN' | 'MEMBER';

export type GroupPermissionKey =
  | 'RENAME'
  | 'CHANGE_DESCRIPTION'
  | 'CHANGE_IMAGE'
  | 'REMOVE_PEOPLE'
  | 'ADD_PEOPLE'
  | 'CHANGE_TYPE'
  | 'DELETE_MESSAGES'
  | 'TIMEOUT'
  | 'BAN';

export interface GroupDetail {
  id: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  type: GroupType;
  memberCount: number;
  maxMembers: number;
  role: GroupRole | null;
  isMember: boolean;
  createdAt: string;
  /** Permissions the current member's role has been granted. */
  permissions?: GroupPermissionKey[];
  /** Permissions the group admin allows to be delegated. */
  delegablePermissions?: GroupPermissionKey[];
}

export interface GroupMember {
  userId: string;
  username: string;
  /** ACTIVE, or REQUEST for a direct conversation not yet accepted. */
  state?: string;
  lastReadMessageId?: string | null;
  avatarUrl?: string | null;
  role: GroupRole;
  isOnline?: boolean;
  bannedUntil?: string | null;
  timedOutUntil?: string | null;
  joinedAt: string;
}

export interface GroupInvite {
  id: string;
  group: { id: string; name: string; imageUrl?: string | null; memberCount: number };
  invitedBy: { id: string; username: string };
  createdAt: string;
}

// ─── Ads (Module 5) ──────────────────────────────────────────────────────────

/** ACTIVE / PAUSED run; COMPLETED, CANCELLED and REFUNDED have ended. */
export type AdStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED';

export interface AdBadge {
  id: string;
  emoji?: string;
  text?: string;
}

export interface AdSkin {
  id: string;
  name: string;
  /** Display hints (colours, border, icon). */
  style: Record<string, string>;
  /** Only in the composer options. */
  priceUsd?: string;
}

export interface AdPriceLine {
  label: string;
  usd: string;
}

export interface Ad {
  id: string;
  content: string;
  /** The rooms this ad runs in; with `allRooms`, every room ads may use. */
  roomIds: string[];
  allRooms: boolean;
  pinMinutes: number | null;
  repeatCount: number;
  repeatGapMinutes: number | null;
  postedCount: number;
  nextPostAt: string | null;
  badge?: AdBadge | null;
  skin?: AdSkin | null;
  /** The advertiser's own ads only. */
  priceUsd?: string;
  refundUsd?: string | null;
  breakdown?: AdPriceLine[];
  status: AdStatus;
  createdAt: string;
  endedAt: string | null;
}

export interface AdQuote {
  rooms: { id: string; slug: string; name: string; type: string }[];
  allRooms: boolean;
  pinMinutes: number | null;
  repeatCount: number;
  repeatGapMinutes: number | null;
  badge: AdBadge | null;
  skin: AdSkin | null;
  price: { perPostUsd: string; totalUsd: string; lines: AdPriceLine[] };
}

/** GET /social/chat/ads/options: what the composer may offer. */
export interface AdOptions {
  enabled: boolean;
  separateTab: boolean;
  allRoomsByDefault: boolean;
  maxChars: number;
  maxFreeLinks: number;
  maxPaidLinks: number;
  badges: AdBadge[];
  skins: AdSkin[];
  pinned: { enabled: boolean; minMinutes: number; maxMinutes: number };
  repeat: {
    enabled: boolean;
    minCount: number;
    maxCount: number;
    minGapMinutes: number;
    maxGapMinutes: number;
    discountPercent: number;
    maxDiscountPercent: number;
  };
  basePriceUsd: string;
}

// ─── Gifts (Module 5) ────────────────────────────────────────────────────────

/** POST /social/chat/gifts: waits for the payment PIN or 2FA code. */
export interface Gift {
  giftId: string;
  status: 'PENDING_VERIFICATION';
  verification: 'PAYMENT_PIN' | 'TWO_FA';
  recipient: { id: string; username: string };
  amount: string;
  currency: string;
  usdValue: string | null;
  feeAmount: string | null;
  expiresAt: string;
}

/** GET /social/chat/gifts/options. */
export interface GiftOptions {
  enabled: boolean;
  minUsd: string | null;
  maxUsd: string | null;
  verification: 'PAYMENT_PIN' | 'TWO_FA';
  currencies: { currency: string; min: string | null; max: string | null }[];
}

// ─── Mutes / Blocks (Module 5) ───────────────────────────────────────────────

export interface RelationUser {
  /** The user's id (the backend's userId). */
  id: string;
  username: string;
  avatarUrl?: string | null;
  createdAt: string;
}
