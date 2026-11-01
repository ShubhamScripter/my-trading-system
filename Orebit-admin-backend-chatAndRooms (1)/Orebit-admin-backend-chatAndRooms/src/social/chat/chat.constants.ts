import type {
  ContentControls,
  IneligibleMode,
  RoomAccess,
  RoomStatus,
  RoomType,
  VisibilityGroup,
} from './chat.types';

/**
 * Defaults are safe: text/emoji/GIF allowed; images, video, ads, commands off.
 * These are the values stored when an admin creates a room without specifying controls.
 */
export const DEFAULT_CONTENT_CONTROLS: ContentControls = {
  allowText: true,
  allowEmoji: true,
  allowGif: true,
  allowImage: false,
  allowVideo: false,
  autoModeration: true,
  allowCommands: false,
  commands: [],
  allowAds: false,
};

export const DEFAULT_ROOM_STATUS: RoomStatus = 'ACTIVE';

/** Links off by default. */
export const DEFAULT_LINKS_POLICY = undefined as undefined;

/** Default access rule: VIEW_ONLY for public types, HIDE for STAFF/SO. */
export function defaultIneligibleMode(type: RoomType): IneligibleMode {
  return type === 'STAFF' || type === 'SO' ? 'HIDE' : 'VIEW_ONLY';
}

export const DEFAULT_ROOM_ACCESS: RoomAccess = {
  allowedCountries: [],
  regionId: null,
  requirePremium: false,
  allowedPlanIds: [],
  requireVip: false,
  minKycLevel: 0,
  minLevel: 0,
  minWagerUsd: null,
  ineligibleMode: 'VIEW_ONLY',
  visibility: { groups: [] as VisibilityGroup[], minLevel: 0 },
};

export const CHAT_CACHE_TTL = {
  /** Stats TTL in seconds — read from RuntimeStats, stale for at most this long. */
  STATS_SECONDS: 10,
  /** Settings TTL — kept in sync with the user BE (30 s). */
  SETTINGS_SECONDS: 30,
};
