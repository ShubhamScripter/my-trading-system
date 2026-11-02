/**
 * Admin-side chat types — kept in sync with the canonical contract in
 * Orebit-User/be/src/social/chat/chat.contract.ts. When the contract changes,
 * update chat.contract.ts in both repos and bump CHAT_CONTRACT_VERSION.
 */

export const ROOM_TYPES = [
  'GLOBAL',
  'COUNTRY',
  'CONTINENT',
  'REGION',
  'LANGUAGE',
  'PREMIUM',
  'VIP',
  'KYC',
  'CASINO',
  'SO',
  'STAFF',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const ROOM_STATUSES = ['ACTIVE', 'MAINTENANCE', 'DISABLED'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** Chat SETTINGS «If you are Not from the region / Language then: View Only / HIDE / Promo Only». */
export const INELIGIBLE_MODES = ['VIEW_ONLY', 'HIDE', 'PROMO_ONLY'] as const;
export type IneligibleMode = (typeof INELIGIBLE_MODES)[number];

export const LINK_POLICIES = ['NO_LINKS', 'OREBIT_ONLY', 'ALL_LINKS'] as const;
export type LinkPolicy = (typeof LINK_POLICIES)[number];

export const VISIBILITY_GROUPS = ['PREMIUM', 'VIP', 'SO', 'STAFF', 'KYC'] as const;
export type VisibilityGroup = (typeof VISIBILITY_GROUPS)[number];

export const STAFF_ROLES = ['ADMIN', 'MODERATOR', 'SUPPORT'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const GIF_PROVIDERS = ['TENOR', 'GIPHY'] as const;
export type GifProvider = (typeof GIF_PROVIDERS)[number];

// Room
/**
 * The content controls stored in `chat.rooms.config`. Defaults safe: media, ads and commands
 * are off unless an admin turns them on. Commands and ads are Module 5 and stay false.
 */
export interface ContentControls {
  allowText: boolean;
  allowEmoji: boolean;
  allowGif: boolean;
  /** Off by default. */
  allowImage: boolean;
  /** Off by default; per-room when admin enables. */
  allowVideo: boolean;
  /** Chat SETTINGS «Disable Auto Moderation for: Select Chat Rooms». */
  autoModeration: boolean;
  /** Module 5: commands allowed in the room. */
  allowCommands: boolean;
  /** Module 5: the commands the room accepts; empty = every command. */
  commands: string[];
  /** Module 5: ads may be posted and pinned in the room. */
  allowAds: boolean;
}

export interface RoomVisibility {
  /** Empty = everyone. */
  groups: VisibilityGroup[];
  /** Users at or above this level also see the room. 0 = no level audience. */
  minLevel: number;
}

/** The `chat.room_access_rules` row exposed to the admin. */
export interface RoomAccess {
  /** ISO 3166-1 alpha-2, empty = every country. */
  allowedCountries: string[];
  /** A REGION room may name a region instead of listing countries. */
  regionId: string | null;
  requirePremium: boolean;
  /** Premium plan ids from the Premium module; empty = any active plan. */
  allowedPlanIds: string[];
  requireVip: boolean;
  /** KYC level (0 = no KYC required). */
  minKycLevel: number;
  /** «Minimum Level Required to Chat». */
  minLevel: number;
  /** Casino rooms: «Minimum Wager Amount to Chat: x USD». Decimal string, null = no minimum. */
  minWagerUsd: string | null;
  ineligibleMode: IneligibleMode;
  visibility: RoomVisibility;
}

export interface AdminRoom {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: RoomType;
  status: RoomStatus;
  language?: string;
  /** Config: the JSON stored in chat.rooms.config. */
  statusNote?: string;
  statusUntil?: string;
  /** Controls under MAINTENANCE in this room (TEXT, EMOJI, GIF, IMAGE, VIDEO, COMMANDS, ADS). */
  controlsMaintenance: string[];
  linksPolicy?: LinkPolicy;
  bannedWords: string[];
  rules: string[];
  contentControls: ContentControls;
  access: RoomAccess;
  /** Casino rooms: whether the minimum wager applies. Absent = off. */
  casino?: { onlyUsersOnCasino: boolean };
  createdAt: string;
  deletedAt: string | null;
  onlineCount: number;
}

// Reports
export type ReportStatus = 'PENDING' | 'REVIEWED' | 'DISMISSED' | 'ACTIONED';

export interface ChatReport {
  id: string;
  /** The cursor of the page that follows this row (time to the microsecond and id). */
  cursor: string;
  /** Null for a user report (no specific message). */
  messageId: string | null;
  /** A reported DM or group message (Module 8); its conversation. */
  dmMessageId: string | null;
  dmMessageArchived: boolean;
  conversationId: string | null;
  messageContent: string | null;
  roomId: string | null;
  roomName: string | null;
  reporterId: string;
  reporterUsername: string;
  reportedUserId: string | null;
  reportedUsername: string | null;
  reason: string;
  details: string | null;
  status: ReportStatus;
  action: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ReportReason {
  code: string;
  label: string;
  // Target entity kind: chat message or user profile.
  reportType: 'MESSAGE' | 'USER';
  isActive: boolean;
  sortOrder: number;
}

// Bans
export interface UserBan {
  id: string;
  userId: string;
  username: string;
  roomId: string | null;
  roomName: string | null;
  /** Chat staff moderator (platform user id). */
  moderatorId: string | null;
  /** Admin-backend admin id. */
  adminId: string | null;
  // Internal audit reason recorded by staff or admin.
  internalReason: string;
  /** What the user sees; null when none was given. */
  userReason: string | null;
  bannedAt: string;
  /** The cursor of the page that follows this row (time to the microsecond and id). */
  cursor: string;
  /** Null = permanent. */
  expiresAt: string | null;
  isActive: boolean;
  liftedBy: string | null;
  liftedAt: string | null;
}

// Staff roles
export interface ChatStaffRole {
  userId: string;
  username: string;
  role: StaffRole;
  assignedBy: string | null;
  assignedAt: string;
}

// Cosmetics / skins
export interface ChatSkin {
  id: string;
  name: string;
  description: string;
  gradient: string;
  borderColor: string;
  badgeIcon: string;
  /** USD, stored 18d/8d, displayed cut to 2. */
  cost: string;
  isPremium: boolean;
  isActive: boolean;
  createdAt: string;
}

// Media uploads
export interface MediaUpload {
  id: string;
  uploaderId: string;
  uploaderUsername: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  createdAt: string;
  flaggedAt: string | null;
  flaggedBy: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  deleteNote: string | null;
}

// Broadcast
export interface BroadcastPayload {
  roomId?: string | null;
  type: 'ADMIN_ALERT' | 'SYSTEM_ALERT' | 'MAINTENANCE' | 'PROMO';
  title: string;
  content: string;
  priority?: 'HIGH' | 'NORMAL' | 'URGENT';
}

// Stats
export interface PlatformStats {
  totalRooms: number;
  activeRooms: number;
  totalOnlineUsers: number;
  totalMessages: number;
  pendingReports: number;
  activeBans: number;
  totalSkins: number;
  messagesLastMinute: number;
}

// Regions
export interface ChatRegion {
  id: string;
  name: string;
  countries: string[];
  createdAt: string;
  updatedAt: string;
}

// Settings
export type SettingsChangeStatus = 'SCHEDULED' | 'APPLIED' | 'CANCELLED';

export interface SettingsChange {
  id: string;
  target: 'SETTINGS' | 'ROOM';
  roomId: string | null;
  actorId: string | null;
  patch: unknown;
  before: unknown | null;
  effectiveAt: string;
  status: SettingsChangeStatus;
  createdAt: string;
  appliedAt: string | null;
}

// Frequent hitters
export interface FrequentHitter {
  userId: string;
  // Recent limit triggers breakdown within the last 24 hours.
  reasons: { reason: string; hits: number }[];
  username: string | null;
  lastIp: string | null;
  hits: number;
  lastHitAt: string;
  blockedUntil: string | null;
}
