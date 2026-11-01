/**
 * Pure mapping between stored room rows and the admin room shape. No database access here.
 */
import { DEFAULT_CONTENT_CONTROLS } from '../chat.constants';
import type {
  AdminRoom,
  ContentControls,
  IneligibleMode,
  LinkPolicy,
  RoomAccess,
  RoomStatus,
  RoomType,
  VisibilityGroup,
} from '../chat.types';

/** A room row joined with its access rule and message count, as the room list query returns it. */
export interface RoomListRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  config: Record<string, unknown> | null;
  createdAt: Date;
  deletedAt: Date | null;
  allowedCountries: string[] | null;
  regionId: string | null;
  requirePremium: boolean | null;
  allowedPlanIds: string[] | null;
  requireVip: boolean | null;
  minKycLevel: number | null;
  minLevel: number | null;
  minWagerUsd: unknown;
  ineligibleMode: string | null;
  visibilityGroups: string[] | null;
  visibilityMinLevel: number | null;
  messageCount: bigint | number | null;
}

/** A stored room row (chat.rooms) with the access-rule columns the services read. */
export interface RoomRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  config: Record<string, unknown> | null;
  created_at: Date;
  deleted_at: Date | null;
}

/** One message of a room's history as the admin panel shows it. */
export interface AdminHistoryMessage {
  id: string;
  roomId: string;
  roomName: string;
  userId: string;
  username: string;
  content: string;
  type: string;
  metadata: Record<string, unknown>;
  retractedAt: string | null;
  createdAt: string;
}

export interface HistoryRow {
  id: string;
  roomId: string;
  roomName: string | null;
  userId: string;
  username: string | null;
  content: string;
  type: string | null;
  metadata: Record<string, unknown> | null;
  retractedAt: Date | null;
  createdAt: Date;
  cursorAt: string;
}

/** What a new room is made of. */
export interface NewRoom {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  type: RoomType;
  status: RoomStatus;
  statusNote?: string | null;
  statusUntil?: string | null;
  language?: string | null;
  rules: string[];
  contentControls: ContentControls;
  linksPolicy?: string | null;
  bannedWords: string[];
  access: Partial<RoomAccess>;
  casino?: { onlyUsersOnCasino: boolean };
}

/** A change to an existing room; absent fields stay as they are, null clears an optional value. */
export interface RoomUpdate {
  roomId: string;
  name?: string;
  slug?: string;
  description?: string | null;
  type?: RoomType;
  status?: RoomStatus;
  statusNote?: string | null;
  statusUntil?: string | null;
  language?: string | null;
  rules?: string[];
  contentControls?: Partial<ContentControls>;
  /** "Chat Room Controls" under MAINTENANCE. */
  controlsMaintenance?: string[];
  linksPolicy?: string | null;
  bannedWords?: string[];
  access?: Partial<RoomAccess>;
  casino?: { onlyUsersOnCasino: boolean } | null;
}

/** A decimal (Prisma Decimal, string or number) as a USD decimal string, or null. */
export function toUsdString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return text;
}

/** The content controls stored in a room config, with the safe default for every missing key. */
export function parseContentControls(config: Record<string, unknown>): ContentControls {
  const raw = (config.contentControls ?? {}) as Record<string, unknown>;
  const flag = (key: Exclude<keyof typeof DEFAULT_CONTENT_CONTROLS, 'commands'>): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : DEFAULT_CONTENT_CONTROLS[key];
  return {
    allowText: flag('allowText'),
    allowEmoji: flag('allowEmoji'),
    allowGif: flag('allowGif'),
    allowImage: flag('allowImage'),
    allowVideo: flag('allowVideo'),
    autoModeration: flag('autoModeration'),
    allowCommands: flag('allowCommands'),
    commands: Array.isArray(raw.commands)
      ? raw.commands.filter((c): c is string => typeof c === 'string')
      : [],
    allowAds: flag('allowAds'),
  };
}

/** Drops null and undefined keys (one level): the chat contract has optional keys, not nullable ones. */
export function withoutNulls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
}

/** A room list row as the admin panel shows it. */
export function toAdminRoom(row: RoomListRow): AdminRoom {
  const config = row.config ?? {};
  const access: RoomAccess = {
    allowedCountries: row.allowedCountries ?? [],
    regionId: row.regionId ?? null,
    requirePremium: row.requirePremium ?? false,
    allowedPlanIds: row.allowedPlanIds ?? [],
    requireVip: false,
    minKycLevel: row.minKycLevel ?? 0,
    minLevel: row.minLevel ?? 0,
    minWagerUsd: toUsdString(row.minWagerUsd),
    ineligibleMode: (row.ineligibleMode ?? 'VIEW_ONLY') as IneligibleMode,
    visibility: {
      groups: (row.visibilityGroups ?? []) as VisibilityGroup[],
      minLevel: row.visibilityMinLevel ?? 0,
    },
  };

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    type: row.type as RoomType,
    status: (config.status as RoomStatus | undefined) ?? (row.deletedAt ? 'DISABLED' : 'ACTIVE'),
    statusNote: (config.statusNote as string | undefined) ?? undefined,
    statusUntil: (config.statusUntil as string | undefined) ?? undefined,
    controlsMaintenance: Array.isArray(config.controlsMaintenance) ? (config.controlsMaintenance as string[]) : [],
    ...(config.casino && typeof config.casino === 'object'
      ? { casino: config.casino as { onlyUsersOnCasino: boolean } }
      : {}),
    language: (config.language as string | undefined) ?? undefined,
    linksPolicy: (config.linksPolicy as LinkPolicy | undefined) ?? undefined,
    bannedWords: (config.bannedWords as string[] | undefined) ?? [],
    rules: (config.rules as string[] | undefined) ?? [],
    contentControls: parseContentControls(config),
    access,
    createdAt: new Date(row.createdAt).toISOString(),
    deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
    // The chat server's runtime stats hold live counts; the list does not.
    onlineCount: 0,
    messageCount: Number(row.messageCount ?? 0),
  };
}
