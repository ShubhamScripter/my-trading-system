export type RoomType =
  | 'GLOBAL'
  | 'COUNTRY'
  | 'CONTINENT'
  | 'REGION'
  | 'LANGUAGE'
  | 'PREMIUM'
  | 'VIP'
  | 'KYC'
  | 'CASINO'
  | 'SO'
  | 'STAFF';

export interface RoomContentControls {
  allowText: boolean;
  allowGif: boolean;
  allowImage: boolean;
  allowVideo: boolean;
  allowEmoji: boolean;
  autoModeration: boolean;
  allowCommands: boolean;
  allowAds: boolean;
  visibility?: 'ALL' | 'PREMIUM' | 'VIP' | 'STAFF' | 'KYC';
}

/** Lowest to highest. `ALL` means no tier requirement. */
export type PremiumTier = 'ALL' | 'BASIC' | 'MEDIUM' | 'TOP';

export interface RoomAccessSettings {
  requirePremium: boolean;
  requireVip: boolean;
  requireKyc?: boolean;
  requireMerchant?: boolean;
  allowedCountries: string[];
  viewOnlyCountries?: string[];
  isViewOnlyForOthers?: boolean;
  ineligibleBehavior?: 'VIEW_ONLY' | 'HIDE' | 'PROMO_ONLY';
  minWagerUsd?: number | string | null;
  minLevel?: number;
  minKycLevel?: number;
  allowedPlanIds?: string[];
  premiumTier?: PremiumTier;
}

export interface RoomAccess {
  allowedCountries: string[];
  regionId: string | null;
  requirePremium: boolean;
  allowedPlanIds: string[];
  requireVip: boolean;
  minKycLevel: number;
  minLevel: number;
  minWagerUsd: string | null;
  ineligibleMode: 'VIEW_ONLY' | 'HIDE' | 'PROMO_ONLY';
  visibility: {
    groups: ('PREMIUM' | 'VIP' | 'SO' | 'STAFF' | 'KYC')[];
    minLevel: number;
  };
}

export interface CasinoRoomSettings {
  autoSwitch?: boolean;
  switchIfDmOpen?: boolean;
  requireCasinoOpen?: boolean;
  minWagerUsd?: number | string;
  separatePremiumCasino?: boolean;
}

export interface SoRoomSettings {
  isSoRoom?: boolean;
  separateSoPremium?: boolean;
}

export interface RegionRoomSettings {
  separateVipRoom?: boolean;
}

export interface AdminRoom {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: RoomType;
  language?: string;
  continent?: string;
  status?: 'ACTIVE' | 'MAINTENANCE' | 'DISABLED';
  statusNote?: string | null;
  statusUntil?: string | null;
  /** Controls under MAINTENANCE in this room: TEXT, EMOJI, GIF, IMAGE, VIDEO, COMMANDS, ADS. */
  controlsMaintenance?: string[];
  linksPolicy?: 'OREBIT_ONLY' | 'NO_LINKS' | 'ALL_LINKS';
  bannedWords?: string[];
  allowedCommands?: string[];
  adsAllowed?: boolean;
  pinnedAdsAllowed?: boolean;
  casinoSettings?: CasinoRoomSettings;
  soSettings?: SoRoomSettings;
  regionSettings?: RegionRoomSettings;
  isActive: boolean;
  rules: string[];
  contentControls: RoomContentControls;
  accessSettings?: RoomAccessSettings;
  access?: RoomAccess;
  createdAt: string;
  onlineCount: number;
}

export type ReportReason =
  | 'SPAM'
  | 'HARASSMENT'
  | 'INAPPROPRIATE'
  | 'SCAM'
  | 'HATE_SPEECH'
  | 'OTHER';

export type ReportStatus = 'ALL' | 'PENDING' | 'REVIEWED' | 'DISMISSED' | 'ACTIONED';

export interface ChatReport {
  id: string;
  messageId: string | null;
  messageContent?: string | null;
  roomId?: string | null;
  roomName?: string | null;
  reporterId: string;
  reporterUsername?: string | null;
  reportedUserId: string | null;
  dmMessageArchived?: boolean;
  reportedUsername?: string | null;
  reason: ReportReason | string;
  details?: string | null;
  status: ReportStatus;
  createdAt: string;
  actionTaken?: string | null;
}

export interface UserBan {
  id: string;
  userId: string;
  username: string;
  roomId?: string | null;
  roomName?: string | null;
  moderatorId: string;
  moderatorName?: string;
  reason: string;
  note?: string;
  durationHours?: number;
  permanent?: boolean;
  bannedAt: string;
  expiresAt: string | null;
  isActive: boolean;
}

export interface ChatSkin {
  id: string;
  name: string;
  description: string;
  gradient: string;
  borderColor: string;
  badgeIcon: string;
  cost: string | number;
  isPremium: boolean;
  isActive: boolean;
  createdAt: string;
}

export type ChatCosmetic = ChatSkin;

export interface ChatRegion {
  id: string;
  name: string;
  countries: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MediaUpload {
  id: string;
  uploaderId: string;
  uploaderUsername: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  isFlagged: boolean;
  flagNote: string | null;
  isDeleted: boolean;
  deletedAt: string | null;
  createdAt: string;
}

export interface ChatStaffRole {
  userId: string;
  username: string;
  role: 'ADMIN' | 'MODERATOR' | 'SUPPORT';
  assignedAt: string;
  assignedBy: string;
}

export interface FrequentHitter {
  userId: string;
  username: string | null;
  lastIp: string | null;
  hits: number;
  lastHitAt: string;
  blockedUntil: string | null;
}

export interface SettingsChange {
  id: string;
  version: number;
  patch: Record<string, unknown>;
  scheduledFor: string | null;
  appliedAt: string | null;
  rolledBackAt: string | null;
  createdBy: string;
  createdAt: string;
  status: 'SCHEDULED' | 'APPLIED' | 'CANCELLED';
  /** SETTINGS = chat-wide settings; ROOM = a scheduled room status / controls change. */
  target?: 'SETTINGS' | 'ROOM';
  roomId?: string | null;
}

export interface ReportReasonItem {
  id?: string;
  code: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
}

export interface BroadcastPayload {
  roomId?: string | null;
  type: 'ADMIN_ALERT' | 'SYSTEM_ALERT' | 'MAINTENANCE' | 'PROMO';
  title: string;
  content: string;
  priority?: 'HIGH' | 'NORMAL' | 'URGENT';
}

export interface PlatformStats {
  totalRooms: number;
  activeRooms: number;
  totalOnlineUsers: number;
  totalMessages: number;
  pendingReports: number;
  activeBans: number;
  totalCosmetics: number;
  totalSkins?: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR';
  avatar?: string;
  token?: string;
  lastLoginAt?: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  roomName?: string;
  userId: string;
  username: string;
  content: string;
  type: 'TEXT' | 'ADMIN_ALERT' | 'SYSTEM_ALERT' | 'GIF' | 'IMAGE' | 'VIDEO';
  metadata?: Record<string, any>;
  retractedAt?: string | null;
  retractedBy?: string | null;
  createdAt: string;
}

export interface AutoBanTier {
  tier: number;
  action: 'WARNING' | 'BAN';
  durationSeconds?: number;
  permanent?: boolean;
  resetWindowHours: number;
}

export interface StaffPermissionSetting {
  act: boolean;
  report: boolean;
  scope?: string;
}

export interface ModeratorRole {
  id: string;
  name: string;
  level: number;
  groupPrivilege: boolean;
  permissions: Record<number, StaffPermissionSetting>;
}

export interface UserGroupRestriction {
  id: string;
  targetType: 'USER' | 'VIP' | 'PREMIUM' | 'KYC' | 'LEVEL' | 'ROLE';
  targetValue: string;
  restriction: string;
  reason: string;
  durationHours?: number;
  /** Set on an entry that is already stored: null = permanent. Kept as it is on save. */
  expiresAt?: string | null;
  createdAt: string;
}

export interface BotPersonaConfig {
  botName: string;
  botUserId: string;
  botAvatar: string;
  isActive: boolean;
  welcomeTemplate: string;
}

export interface BotLogEntry {
  id: string;
  event: string;
  type: string;
  roomName: string;
  details: string;
  createdAt: string;
}

export interface ModerationSettings {
  roomId: string;
  linkPolicy: 'ALL_LINKS' | 'OREBIT_ONLY' | 'NO_LINKS';
  bannedWords: string[];
  globalDisabledCommands: string[];
  allCommandsDisabled: boolean;
  staffRoles: ModeratorRole[];
  userRestrictions: UserGroupRestriction[];
  botConfig: BotPersonaConfig;
}
