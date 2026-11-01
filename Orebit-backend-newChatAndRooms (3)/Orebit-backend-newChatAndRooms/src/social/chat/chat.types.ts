import type { Socket } from 'socket.io';
import type { RoomAccess, RoomConfig, RoomType, StaffRole } from './chat.contract';

// The signed-in user as chat sees them. Premium, KYC, country and the rest come from ports, never from here.
// The kind of report a reason list belongs to: a message or request, or a user profile.
export type ReportType = 'MESSAGE' | 'USER';

// The two reasons of a penalty: the internal one is required and never reaches the user, the other is optional.
export interface PenaltyReasons {
  readonly internalReason: string;
  readonly userReason?: string;
}

export interface ChatUserContext {
  readonly id: string;
  readonly username: string;
  readonly publicCode: string;
  // From chat.staff_roles; null for everyone who is not chat staff.
  readonly staffRole: StaffRole | null;
}

export type RoomAccessMode = 'FULL_ACCESS' | 'VIEW_ONLY' | 'PROMO_ONLY' | 'LOCKED';

// What a locked or read-only room requires, so the app can show "get plan X" or "verify KYC level Y".
export type AccessRequirement =
  | { readonly kind: 'PREMIUM'; readonly planIds: readonly string[] }
  | { readonly kind: 'KYC'; readonly minLevel: number }
  | { readonly kind: 'SITE_OWNER' }
  | {
      readonly kind: 'CASINO';
      readonly onCasino: boolean;
      // USD cut, not rounded, to 2 decimals; null when no minimum applies.
      readonly minWagerUsd: string | null;
      readonly windowDays: number;
    }
  | { readonly kind: 'COUNTRY'; readonly countries: readonly string[] }
  | { readonly kind: 'LEVEL'; readonly minLevel: number }
  | { readonly kind: 'STAFF' };

export interface CasinoConditions {
  readonly onCasino: boolean;
  readonly wagerMet: boolean;
  // Both USD strings cut to 2 decimals.
  readonly minWagerUsd: string | null;
  readonly wagerUsd: string;
  readonly windowDays: number;
  readonly allMet: boolean;
}

export interface RoomAccessEvaluation {
  readonly accessMode: RoomAccessMode;
  // Shown in the room list. A hidden room is not.
  readonly isListed: boolean;
  readonly isEligibleToView: boolean;
  readonly isEligibleToWrite: boolean;
  // False for a promo-only viewer: they receive only system and admin alerts, never user messages.
  readonly receivesUserMessages: boolean;
  readonly reason?: string;
  readonly requirement?: AccessRequirement;
  readonly casinoConditions?: CasinoConditions;
  // Present while the room is in maintenance.
  readonly maintenance?: { readonly note: string | null; readonly until: string | null };
}

// The facts about a user that decide room access, each from the module that owns it (chat.ports.ts).
// `null` means the providing module is not connected yet: rooms that need that fact stay closed.
export interface EligibilityFacts {
  readonly staffRole: StaffRole | null;
  readonly country: string | null;
  readonly premiumPlanIds: readonly string[] | null;
  readonly kycLevel: number | null;
  // The KYC module's per-level chat entitlements; null while KYC is not connected.
  readonly kycEntitlements: {
    readonly publicChat: boolean;
    readonly roomIds: readonly string[] | null;
  } | null;
  readonly isSiteOwner: boolean | null;
  readonly level: number | null;
  // Asked only for casino rooms; null when not asked or not connected.
  readonly casino: { readonly onCasino: boolean; readonly wagerUsd: string } | null;
  // Rooms this user has been removed from (by an admin or staff; Site-Owner rooms included).
  readonly excludedRoomIds: ReadonlySet<string>;
  // Rooms staff or an admin added this user to, whatever the room's own gates say (Module 4).
  readonly includedRoomIds: ReadonlySet<string>;
  // A RESTRICT_STAFF_ROOM restriction is active on this user: the Staff room stays shut to them.
  readonly staffRoomBlocked: boolean;
}

// A room as the chat server holds it: the config and access rule already parsed through the contract.
export interface RoomRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: RoomType;
  readonly createdAt: Date;
  readonly config: RoomConfig;
  readonly access: RoomAccess;
  // The countries of the room's named region, when it has one.
  readonly regionCountries: readonly string[] | null;
  // Changes whenever anything above changes; used to re-check open sockets only for rooms that changed.
  readonly fingerprint: string;
}

export type MessageType = 'TEXT' | 'MEDIA' | 'SYSTEM_ALERT' | 'ADMIN_ALERT' | 'AD' | 'GIFT';

// What an AD row carries (Module 5).
export interface AdMetadata {
  adId: string;
  badge?: { id: string; emoji?: string; text?: string };
  // "GEO Targeting: Hide ad from specific country users".
  hiddenCountries?: string[];
  // "Ad Skins": the style the advertiser paid for.
  skin?: { id: string; name: string; style: Record<string, string> };
}

// What a GIFT row carries: the chat notice of a completed gift (Module 5).
export interface GiftMetadata {
  giftId: string;
  recipientId?: string;
  recipientUsername: string;
  currency: string;
  // Decimal string.
  amount: string;
}
export type MediaType = 'image' | 'gif' | 'video';

// What chat stores in `room_messages.metadata`. Built on the server only.
export interface MessageMetadata {
  media?: { type: MediaType; url: string; caption?: string; thumbnailUrl?: string };
  taggedUsernames?: string[];
  // The author hid their identity when the message was sent.
  anonymous?: true;
  alertType?: string;
  // "Chat Bot: Assign Profile": the account an automated alert was posted under, as it was then.
  bot?: { userId: string; username: string };
  broadcastId?: string;
  ad?: AdMetadata;
  gift?: GiftMetadata;
  title?: string;
  priority?: string;
}

// A message row as read for a viewer.
export interface MessageRow {
  readonly id: string;
  readonly roomId: string;
  readonly userId: string;
  readonly content: string;
  readonly type: MessageType;
  readonly metadata: MessageMetadata;
  // Database time as text with microseconds, for the cursor.
  readonly createdAtText: string;
  readonly createdAt: Date;
  readonly retractedAt: Date | null;
  readonly pinnedAt: Date | null;
  readonly authorUsername: string | null;
  readonly skin: { readonly id: string; readonly name: string; readonly style: unknown } | null;
}

export interface PublicSkin {
  readonly id: string;
  readonly name: string;
  readonly style: unknown;
}

// A message as any viewer receives it, over either transport (toPublicMessage).
export type PublicMessage =
  | {
      readonly id: string;
      readonly roomId: string;
      readonly userId: string;
      readonly username: string;
      readonly content: string;
      readonly type: MessageType;
      readonly skin: PublicSkin | null;
      readonly media: MessageMetadata['media'] | null;
      readonly taggedUsernames: readonly string[];
      readonly createdAt: string;
      readonly isRetracted: boolean;
      readonly isPinned: boolean;
      // Only for staff and for an alert.
      readonly alertType?: string;
      // An automated alert posted under the assigned bot profile; absent = the platform name.
      readonly bot?: { readonly userId: string; readonly username: string };
      // AD rows: the ad and its badge. Ads are never hidden by mute or block.
      readonly ad?: { readonly adId: string; readonly badge: AdMetadata['badge'] | null };
      // GIFT rows: who received what.
      readonly gift?: Omit<GiftMetadata, 'giftId'> & { readonly giftId: string };
    }
  | {
      readonly id: string;
      readonly roomId: string;
      readonly createdAt: string;
      readonly isRetracted: true;
    };

export interface Viewer {
  readonly userId: string;
  readonly isStaff: boolean;
}

export interface OnlineMember {
  readonly id: string;
  readonly username: string;
  readonly country: string | null;
  readonly isStaff: boolean;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

// What the gateway keeps on an authenticated socket.
// `sessionId` and `familyId` are captured at the handshake for the revocation checks; `roomId` is the one
// room this socket receives, decided by the server.
export interface ChatSocketData {
  user: ChatUserContext;
  sessionId: string;
  familyId: string;
  ip: string;
  roomId: string | null;
  access: RoomAccessEvaluation | null;
  // From the preferences; kept here so a send does not read them.
  hideIdentity: boolean;
  activeSkinId: string | null;
  // The user's country when the socket connected, for geo-targeted ads (Module 5).
  country: string | null;
  // The last room the browser remembers (Chat MAIN: saved "in their LS or Cookies"), sent in the handshake.
  lastRoomHint: string | null;
}

export type ChatSocket = Socket & { data: ChatSocketData };
