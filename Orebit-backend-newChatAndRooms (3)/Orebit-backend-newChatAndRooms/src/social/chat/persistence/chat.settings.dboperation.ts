/**
 * Database access for the chat-wide settings and their scheduled changes.
 *
 * ChatSettingsService decides what to apply; every query it needs is here, so the service never touches Prisma.
 * Room patches that a scheduled change applies are written here too, with the same rules as the admin backend's
 * immediate saves.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import { RoomPatchSchema } from '../chat.contract';
import { usdStored } from '../platform/money';

type Tx = Prisma.TransactionClient;

/** A scheduled change that is due. */
export interface DueSettingsChange {
  id: string;
  target: string;
  room_id: string | null;
  actor_id: string | null;
  patch: unknown;
}

/** A room's current values in patch shape, kept as `before` so a change can be rolled back. */
export interface RoomSnapshot {
  room: { name: string; slug: string; description: string | null; type: string };
  config: Record<string, unknown>;
  access: Record<string, unknown>;
}

/** The access-rule fields a patch may set. */
export type AccessRulePatch = Partial<{
  allowedCountries: string[];
  regionId: string | null;
  requirePremium: boolean;
  allowedPlanIds: string[];
  minKycLevel: number;
  minLevel: number;
  minWagerUsd: string | null;
  ineligibleMode: 'VIEW_ONLY' | 'HIDE' | 'PROMO_ONLY';
  visibility: { groups: string[]; minLevel: number };
}>;

@Injectable()
export class ChatSettingsDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /** The stored settings document and its version, or null before the first save. */
  async settingsRow(): Promise<{ document: unknown; version: number } | null> {
    return this.prisma.chatSettings.findUnique({
      where: { id: 1 },
      select: { document: true, version: true },
    });
  }

  /** Runs `work` in one transaction. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /** Scheduled changes whose time has come on the database clock; SKIP LOCKED so two ticks never take the same one. */
  dueChanges(tx: Tx): Promise<DueSettingsChange[]> {
    return tx.$queryRaw<DueSettingsChange[]>`
      SELECT id, target, room_id, actor_id, patch
      FROM chat.settings_changes
      WHERE status = 'SCHEDULED' AND effective_at <= now()
      ORDER BY effective_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `;
  }

  /** The current settings document, locked for the rest of the transaction. */
  async lockSettingsDocument(tx: Tx): Promise<unknown> {
    const rows = await tx.$queryRaw<{ document: unknown }[]>`
      SELECT document FROM chat.settings WHERE id = 1 FOR UPDATE
    `;
    return rows[0]?.document ?? {};
  }

  async cancelChange(tx: Tx, changeId: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE chat.settings_changes SET status = 'CANCELLED', applied_at = now() WHERE id = ${changeId}::uuid
    `;
  }

  async writeSettingsDocument(tx: Tx, document: unknown, actorId: string | null): Promise<void> {
    await tx.$executeRaw`
      UPDATE chat.settings
      SET document = ${JSON.stringify(document)}::jsonb, version = version + 1,
          updated_by = ${actorId}::uuid, updated_at = now()
      WHERE id = 1
    `;
  }

  /** Marks a change applied (or cancelled when `before` is null) and keeps `before` for rollback. */
  async finishChange(tx: Tx, changeId: string, before: unknown | null): Promise<void> {
    await tx.$executeRaw`
      UPDATE chat.settings_changes
      SET status = ${before === null ? 'CANCELLED' : 'APPLIED'}, applied_at = now(),
          before = ${before === null ? null : JSON.stringify(before)}::jsonb
      WHERE id = ${changeId}::uuid
    `;
  }

  /**
   * Writes a room patch and returns the values it replaced, or null when the room does not exist or is deleted.
   * The admin backend's writer does the same for immediate saves; this one serves scheduled changes.
   */
  async applyRoomPatch(
    tx: Tx,
    roomId: string,
    patch: ReturnType<typeof RoomPatchSchema.parse>,
  ): Promise<RoomSnapshot | null> {
    const rows = await tx.$queryRaw<
      {
        name: string;
        slug: string;
        description: string | null;
        type: string;
        config: Record<string, unknown>;
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
      }[]
    >`
      SELECT r.name, r.slug, r.description, r.type::text AS type, r.config,
             ar.allowed_countries, ar.region_id, ar.require_premium, ar.allowed_plan_ids,
             ar.min_kyc_level, ar.min_level, ar.min_wager_usd, ar.ineligible_mode::text AS ineligible_mode,
             ar.visibility_groups, ar.visibility_min_level
      FROM chat.rooms r
      LEFT JOIN chat.room_access_rules ar ON ar.room_id = r.id
      WHERE r.id = ${roomId}::uuid AND r.deleted_at IS NULL
      FOR UPDATE OF r
    `;
    const current = rows[0];
    if (!current) return null;

    const before: RoomSnapshot = {
      room: {
        name: current.name,
        slug: current.slug,
        description: current.description,
        type: current.type,
      },
      config: {},
      access: {},
    };

    if (patch.room) {
      for (const key of Object.keys(patch.room) as (keyof typeof patch.room)[]) {
        (before.room as Record<string, unknown>)[key] = current[key];
      }
      await tx.$executeRaw`
        UPDATE chat.rooms SET
          name = COALESCE(${patch.room.name ?? null}, name),
          slug = COALESCE(${patch.room.slug ?? null}, slug),
          description = CASE WHEN ${patch.room.description !== undefined} THEN ${patch.room.description ?? null} ELSE description END,
          type = COALESCE(${patch.room.type ?? null}::chat."RoomType", type)
        WHERE id = ${roomId}::uuid
      `;
    }

    if (patch.config && Object.keys(patch.config).length > 0) {
      for (const key of Object.keys(patch.config))
        before.config[key] = current.config?.[key] ?? null;
      await tx.$executeRaw`
        UPDATE chat.rooms SET config = config || ${JSON.stringify(patch.config)}::jsonb WHERE id = ${roomId}::uuid
      `;
    }

    if (patch.access && Object.keys(patch.access).length > 0) {
      before.access = {
        allowedCountries: current.allowed_countries ?? [],
        regionId: current.region_id,
        requirePremium: current.require_premium ?? false,
        allowedPlanIds: current.allowed_plan_ids ?? [],
        minKycLevel: current.min_kyc_level ?? 0,
        minLevel: current.min_level ?? 0,
        minWagerUsd: current.min_wager_usd === null ? null : usdStored(current.min_wager_usd),
        ineligibleMode: current.ineligible_mode ?? 'VIEW_ONLY',
        visibility: {
          groups: current.visibility_groups ?? [],
          minLevel: current.visibility_min_level ?? 0,
        },
      };
      await this.upsertAccessRule(tx, roomId, patch.access);
    }

    return before;
  }

  /** Writes the given access fields, creating the room's one rule if it has none. */
  async upsertAccessRule(tx: Tx, roomId: string, a: AccessRulePatch): Promise<void> {
    const set = (value: unknown): boolean => value !== undefined;
    await tx.$executeRaw`
      INSERT INTO chat.room_access_rules (
        id, room_id, allowed_countries, region_id, require_premium, allowed_plan_ids,
        min_kyc_level, min_level, min_wager_usd, ineligible_mode, visibility_groups, visibility_min_level
      ) VALUES (
        ${uuidv7()}::uuid, ${roomId}::uuid,
        ${a.allowedCountries ?? []}::char(2)[], ${a.regionId ?? null}::uuid, ${a.requirePremium ?? false},
        ${a.allowedPlanIds ?? []}::text[], ${a.minKycLevel ?? 0}, ${a.minLevel ?? 0},
        ${a.minWagerUsd ?? null}::numeric, ${a.ineligibleMode ?? 'VIEW_ONLY'}::chat."IneligibleMode",
        ${a.visibility?.groups ?? []}::text[], ${a.visibility?.minLevel ?? 0}
      )
      ON CONFLICT (room_id) DO UPDATE SET
        allowed_countries = CASE WHEN ${set(a.allowedCountries)} THEN EXCLUDED.allowed_countries ELSE chat.room_access_rules.allowed_countries END,
        region_id = CASE WHEN ${set(a.regionId)} THEN EXCLUDED.region_id ELSE chat.room_access_rules.region_id END,
        require_premium = CASE WHEN ${set(a.requirePremium)} THEN EXCLUDED.require_premium ELSE chat.room_access_rules.require_premium END,
        allowed_plan_ids = CASE WHEN ${set(a.allowedPlanIds)} THEN EXCLUDED.allowed_plan_ids ELSE chat.room_access_rules.allowed_plan_ids END,
        min_kyc_level = CASE WHEN ${set(a.minKycLevel)} THEN EXCLUDED.min_kyc_level ELSE chat.room_access_rules.min_kyc_level END,
        min_level = CASE WHEN ${set(a.minLevel)} THEN EXCLUDED.min_level ELSE chat.room_access_rules.min_level END,
        min_wager_usd = CASE WHEN ${set(a.minWagerUsd)} THEN EXCLUDED.min_wager_usd ELSE chat.room_access_rules.min_wager_usd END,
        ineligible_mode = CASE WHEN ${set(a.ineligibleMode)} THEN EXCLUDED.ineligible_mode ELSE chat.room_access_rules.ineligible_mode END,
        visibility_groups = CASE WHEN ${set(a.visibility)} THEN EXCLUDED.visibility_groups ELSE chat.room_access_rules.visibility_groups END,
        visibility_min_level = CASE WHEN ${set(a.visibility)} THEN EXCLUDED.visibility_min_level ELSE chat.room_access_rules.visibility_min_level END
    `;
  }
}
