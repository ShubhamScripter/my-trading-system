import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../../db/client';
import { PLACES, cut } from '../platform/money';
import {
  parseRoomConfig,
  RoomAccessSchema,
  type RoomAccess,
  type RoomType,
} from '../chat.contract';
import type { MessageMetadata, MessageRow, MessageType, RoomRecord } from '../chat.types';

/** The SQL pieces and row mapping shared by the chat data classes. */

export type Db = PrismaService | Prisma.TransactionClient;

/** Renders a timestamptz as the cursor holds it: UTC text with microseconds, never through a JavaScript Date. */
export const TIME_TEXT = (column: string): Prisma.Sql =>
  Prisma.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

export interface RoomSqlRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: RoomType;
  created_at: Date;
  config: unknown;
  allowed_countries: string[] | null;
  region_id: string | null;
  require_premium: boolean | null;
  allowed_plan_ids: string[] | null;
  min_kyc_level: number | null;
  min_level: number | null;
  min_wager_usd: Prisma.Decimal | null;
  ineligible_mode: string | null;
  visibility_groups: string[] | null;
  visibility_min_level: number | null;
  region_countries: string[] | null;
}

export const ROOM_SELECT = Prisma.sql`
  SELECT r.id, r.slug, r.name, r.description, r.type::text AS type, r.created_at, r.config,
         ar.allowed_countries, ar.region_id, ar.require_premium, ar.allowed_plan_ids,
         ar.min_kyc_level, ar.min_level, ar.min_wager_usd, ar.ineligible_mode::text AS ineligible_mode,
         ar.visibility_groups, ar.visibility_min_level,
         reg.countries AS region_countries
  FROM chat.rooms r
  LEFT JOIN chat.room_access_rules ar ON ar.room_id = r.id
  LEFT JOIN chat.regions reg ON reg.id = ar.region_id
`;

export interface RoomConfigProblem {
  roomId: string;
  problems: string[];
}

/** Turns a joined room row into a RoomRecord, parsing config and rule through the contract. */
export function toRoomRecord(
  row: RoomSqlRow,
  onProblem?: (problem: RoomConfigProblem) => void,
): RoomRecord {
  const { config, problems } = parseRoomConfig(row.config);
  if (problems.length > 0) onProblem?.({ roomId: row.id, problems });

  const accessParsed = RoomAccessSchema.safeParse({
    allowedCountries: (row.allowed_countries ?? []).map((c) => c.trim().toUpperCase()),
    regionId: row.region_id,
    requirePremium: row.require_premium ?? false,
    allowedPlanIds: row.allowed_plan_ids ?? [],
    minKycLevel: row.min_kyc_level ?? 0,
    minLevel: row.min_level ?? 0,
    minWagerUsd:
      row.min_wager_usd === null ? null : cut(row.min_wager_usd, PLACES.usdStored).toFixed(),
    ineligibleMode:
      row.ineligible_mode ?? (row.type === 'STAFF' || row.type === 'SO' ? 'HIDE' : 'VIEW_ONLY'),
    visibility: { groups: row.visibility_groups ?? [], minLevel: row.visibility_min_level ?? 0 },
  });
  if (!accessParsed.success)
    onProblem?.({ roomId: row.id, problems: ['access rule fails the contract; closed'] });
  // A rule that fails the contract fails closed: hidden from outsiders.
  const access: RoomAccess = accessParsed.success
    ? accessParsed.data
    : RoomAccessSchema.parse({ ineligibleMode: 'HIDE', minKycLevel: 10 });

  const regionCountries = row.region_countries
    ? row.region_countries.map((c) => c.trim().toUpperCase())
    : null;
  const record = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    type: row.type,
    createdAt: row.created_at,
    config,
    access,
    regionCountries,
  };
  return { ...record, fingerprint: JSON.stringify(record) };
}

export interface MessageSqlRow {
  id: string;
  room_id: string;
  user_id: string;
  content: string;
  type: MessageType;
  metadata: MessageMetadata | null;
  created_at: Date;
  created_at_text: string;
  retracted_at: Date | null;
  pinned_at: Date | null;
  author_username: string | null;
  skin_id: string | null;
  skin_name: string | null;
  skin_style: unknown;
}

export function toMessageRow(row: MessageSqlRow): MessageRow {
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    content: row.content,
    type: row.type,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    createdAtText: row.created_at_text,
    retractedAt: row.retracted_at,
    pinnedAt: row.pinned_at,
    authorUsername: row.author_username,
    skin: row.skin_id
      ? { id: row.skin_id, name: row.skin_name ?? '', style: row.skin_style ?? {} }
      : null,
  };
}

/** The message columns every read path selects, with the author (live accounts only) and the skin (no price). */
export const MESSAGE_SELECT = Prisma.sql`
  SELECT m.id, m.room_id, m.user_id, m.content, m.type::text AS type, m.metadata, m.created_at,
         ${TIME_TEXT('m.created_at')} AS created_at_text, m.retracted_at, m.pinned_at,
         u.username AS author_username,
         s.id AS skin_id, s.name AS skin_name, s.style_config AS skin_style
  FROM chat.room_messages m
  LEFT JOIN identity.users u ON u.id = m.user_id AND u.deleted_at IS NULL
  LEFT JOIN chat.message_cosmetics s ON s.id = m.cosmetic_id
`;

export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return true;
    if (err.code === 'P2010') return /23505/.test(JSON.stringify(err.meta ?? {}));
  }
  return (
    typeof err === 'object' &&
    err !== null &&
    /23505|unique constraint/i.test(String((err as { message?: unknown }).message))
  );
}
