export interface User {
  id: string;
  username: string;
  email: string;
  publicCode: string;
  role?: string;
  staffRole?: 'ADMIN' | 'MODERATOR' | 'SUPPORT' | null;
  isPremium?: boolean;
  isVip?: boolean;
  isKycCompleted?: boolean;
  country?: string;
  wagerTotalUsd?: number;
  hideIdentity?: boolean;
}

export interface OnlineUser {
  id: string;
  username: string;
  role?: string;
  staffRole?: string | null;
  isStaff?: boolean;
  isPremium?: boolean;
  isVip?: boolean;
  isKycCompleted?: boolean;
  country?: string | null;
  joinedAt?: string;
}

export interface RoomAccessEvaluation {
  isEligibleToView: boolean;
  isEligibleToWrite: boolean;
  receivesUserMessages: boolean;
  reason?: string | null;
  requirement?: Record<string, unknown> | null;
}

export interface RoomContentControls {
  allowText: boolean;
  allowEmoji: boolean;
  allowGif: boolean;
  allowImage: boolean;
  allowVideo: boolean;
  autoModeration: boolean;
  allowCommands: false;
  allowAds: false;
}

export interface RoomItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  status?: 'ACTIVE' | 'MAINTENANCE' | 'DISABLED';
  statusNote?: string | null;
  statusUntil?: string | null;
  language?: string;
  continent?: string;
  allowedCountries?: string[];
  rules?: string[];
  contentControls?: Partial<RoomContentControls>;
  linksPolicy?: 'NO_LINKS' | 'OREBIT_ONLY' | 'ALL_LINKS';
  onlineCount?: number;
  accessMode: 'FULL_ACCESS' | 'VIEW_ONLY' | 'PROMO_ONLY' | 'LOCKED';
  isEligibleToView?: boolean;
  isEligibleToWrite?: boolean;
  reason?: string | null;
  /** What a locked room needs (CH-092), e.g. `{ kind: 'CASINO', minWagerUsd, windowDays }`. */
  requirement?: Record<string, unknown> | null;
  access?: RoomAccessEvaluation;
  /** The user's casino facts as the server evaluated them (D-10); read-only. */
  casinoConditions?: {
    onCasino: boolean;
    wagerMet: boolean;
    minWagerUsd: string | null;
    wagerUsd: string;
    windowDays: number;
    allMet: boolean;
  };
  maintenance?: { note: string | null; until: string | null };
  /** Casino room: "Casino Auto-Switch" as the admin set it. */
  casinoAutoSwitch?: { enabled: boolean; evenIfDmOpen: boolean };
}

export interface Message {
  id: string;
  roomId?: string;
  userId: string;
  username: string;
  content: string;
  type?: 'TEXT' | 'MEDIA' | 'SYSTEM_ALERT' | 'ADMIN_ALERT' | 'AD' | 'GIFT';
  /** Alerts: the kind of automated alert. */
  alertType?: string;
  /** Automated alerts posted under the chat bot profile the admin assigned. */
  bot?: { userId: string; username: string };
  /** AD rows (Module 5): the ad and its badge. */
  ad?: { adId: string; badge: { id: string; emoji?: string; text?: string } | null };
  /** GIFT rows (Module 5): who received what. */
  gift?: { giftId: string; amount: string; currency: string; recipientId?: string; recipientUsername?: string };
  /** The message skin (ads may carry a paid skin). */
  skin?: { id: string; name: string; style: Record<string, string> } | null;
  skinId?: string | null;
  cosmeticId?: string | null;
  retractedAt?: string | null;
  retractedBy?: string | null;
  /** What the server sends (CH-003): retracted messages reach others without content. */
  isRetracted?: boolean;
  /** Server-built media (CH-008): `{ type, url, caption?, thumbnailUrl? }`. */
  media?: { type: 'image' | 'video' | 'gif'; url: string; caption?: string; thumbnailUrl?: string } | null;
  isPinned?: boolean;
  clientMessageId?: string;
  metadata?: {
    tags?: string[];
    mentions?: string[];
    mediaUrl?: string;
    mediaType?: 'image' | 'video' | 'gif';
    thumbnailUrl?: string;
    fileSize?: number;
    caption?: string;
    isAnonymous?: boolean;
    hideIdentity?: boolean;
    [key: string]: any;
  } | null;
  createdAt: string;
}

export interface RoomRules {
  roomName?: string;
  roomId?: string;
  rules?: string[];
  [key: string]: unknown;
}

export interface SkinItem {
  id: string;
  name: string;
  type?: string;
  description?: string;
  gradient?: string;
  borderColor?: string;
  badgeIcon?: string;
  cost?: string | number;
  isPremium?: boolean;
  isActive?: boolean;
  style?: {
    badge?: string;
    textColor?: string;
    border?: string;
    borderColor?: string;
    gradient?: string;
    glowColor?: string;
    [key: string]: unknown;
  };
}

export type CosmeticItem = SkinItem;
