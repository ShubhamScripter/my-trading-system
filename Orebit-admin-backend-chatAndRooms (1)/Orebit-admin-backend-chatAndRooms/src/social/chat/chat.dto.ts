import { z } from 'zod';
import {
  INELIGIBLE_MODES,
  LINK_POLICIES,
  ROOM_STATUSES,
  ROOM_TYPES,
  STAFF_ROLES,
  VISIBILITY_GROUPS,
} from './chat.types';
import { CHAT_COMMANDS, ROOM_CONTROLS } from './chat.contract';

// Building blocks
export const CountryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'A two-letter ISO 3166-1 alpha-2 country code');

// Decimal money string formatted with up to 8 decimals.
export const UsdAmountSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .pipe(
    z
      .string()
      .regex(
        /^\d{1,10}(\.\d{1,8})?$/,
        'A USD amount with at most 8 decimals, below 10,000,000,000',
      ),
  );

const ACTIVE_ROOM_TYPES = ROOM_TYPES.filter((t) => t !== 'VIP') as [
  Exclude<(typeof ROOM_TYPES)[number], 'VIP'>,
  ...Exclude<(typeof ROOM_TYPES)[number], 'VIP'>[],
];
const ACTIVE_VISIBILITY_GROUPS = VISIBILITY_GROUPS.filter((g) => g !== 'VIP') as [
  Exclude<(typeof VISIBILITY_GROUPS)[number], 'VIP'>,
  ...Exclude<(typeof VISIBILITY_GROUPS)[number], 'VIP'>[],
];

export const CasinoConfigSchema = z.object({ onlyUsersOnCasino: z.boolean() }).strict();

// Room content controls
export const ContentControlsSchema = z
  .object({
    allowText: z.boolean().default(true),
    allowEmoji: z.boolean().default(true),
    allowGif: z.boolean().default(true),
    allowImage: z.boolean().default(false),
    allowVideo: z.boolean().default(false),
    autoModeration: z.boolean().default(true),
    allowCommands: z.boolean().default(false),
    commands: z.array(z.enum(CHAT_COMMANDS)).max(CHAT_COMMANDS.length).default([]),
    allowAds: z.boolean().default(false),
  })
  .strict();
export type ContentControlsInput = z.infer<typeof ContentControlsSchema>;

// Room access
export const RoomVisibilitySchema = z
  .object({
    groups: z
      .array(z.enum(ACTIVE_VISIBILITY_GROUPS))
      .max(ACTIVE_VISIBILITY_GROUPS.length)
      .default([]),
    minLevel: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export const RoomAccessSchema = z
  .object({
    allowedCountries: z.array(CountryCodeSchema).max(250).default([]),
    regionId: z.string().uuid().nullable().default(null),
    requirePremium: z.boolean().default(false),
    allowedPlanIds: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
    requireVip: z.literal(false).default(false),
    minKycLevel: z.number().int().min(0).max(10).default(0),
    minLevel: z.number().int().min(0).max(100_000).default(0),
    minWagerUsd: UsdAmountSchema.nullable().default(null),
    ineligibleMode: z.enum(INELIGIBLE_MODES).default('VIEW_ONLY'),
    visibility: RoomVisibilitySchema.default({}),
  })
  .strict();
export type RoomAccessInput = z.infer<typeof RoomAccessSchema>;

// Room create and update
export const CreateRoomSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase, alphanumeric, hyphens only')
      .optional(),
    description: z.string().trim().max(500).nullable().optional(),
    type: z.enum(ACTIVE_ROOM_TYPES).default('GLOBAL'),
    status: z.enum(ROOM_STATUSES).default('ACTIVE'),
    statusNote: z.string().trim().min(1).max(300).optional(),
    statusUntil: z.string().datetime({ offset: true }).optional(),
    language: z.string().trim().min(1).max(50).optional(),
    rules: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    contentControls: ContentControlsSchema.partial().default({}),
    linksPolicy: z.enum(LINK_POLICIES).optional(),
    bannedWords: z.array(z.string().trim().min(1).max(100)).max(1_000).default([]),
    access: RoomAccessSchema.partial().default({}),
    casino: CasinoConfigSchema.optional(),
  })
  .strict();
export type CreateRoomInput = z.infer<typeof CreateRoomSchema>;

// Room update patch schema.
export const UpdateRoomSchema = z
  .object({
    roomId: z.string().uuid(),
    name: z.string().trim().min(2).max(100).optional(),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase, alphanumeric, hyphens only')
      .optional(),
    description: z.string().trim().max(500).nullable().optional(),
    type: z.enum(ACTIVE_ROOM_TYPES).optional(),
    status: z.enum(ROOM_STATUSES).optional(),
    statusNote: z.string().trim().min(1).max(300).nullable().optional(),
    statusUntil: z.string().datetime({ offset: true }).nullable().optional(),
    language: z.string().trim().min(1).max(50).nullable().optional(),
    rules: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    contentControls: ContentControlsSchema.partial().optional(),
    controlsMaintenance: z.array(z.enum(ROOM_CONTROLS)).max(ROOM_CONTROLS.length).optional(),
    linksPolicy: z.enum(LINK_POLICIES).nullable().optional(),
    bannedWords: z.array(z.string().trim().min(1).max(100)).max(1_000).optional(),
    casino: CasinoConfigSchema.nullable().optional(),
    effectiveAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type UpdateRoomInput = z.infer<typeof UpdateRoomSchema>;

// Updates room access rule independently from room configuration.
export const UpdateRoomAccessSchema = z
  .object({
    roomId: z.string().uuid(),
    access: RoomAccessSchema.partial().refine((a) => Object.keys(a).length > 0, 'Give at least one access field'),
  })
  .strict();
export type UpdateRoomAccessInput = z.infer<typeof UpdateRoomAccessSchema>;

export const DeleteRoomSchema = z.object({ roomId: z.string().uuid() }).strict();
export type DeleteRoomInput = z.infer<typeof DeleteRoomSchema>;

// Message history search query parameters
export const HISTORY_TYPES = ['TEXT', 'MEDIA', 'AD', 'GIFT', 'SYSTEM_ALERT', 'ADMIN_ALERT'] as const;

export const ListCursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'A cursor from a previous page')
  .optional();

export const GetRoomMessagesQuerySchema = z
  .object({
    roomId: z.string().uuid().optional(),
    userId: z.string().trim().min(1).max(64).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    type: z.enum(HISTORY_TYPES).optional(),
    sort: z.enum(['asc', 'desc']).default('desc'),
    before: z.string().datetime({ offset: true }).optional(),
    cursor: ListCursorSchema,
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((q) => q.roomId !== undefined || q.userId !== undefined, {
    message: 'Either roomId or userId must be provided',
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), {
    message: 'from must be before or equal to to',
    path: ['to'],
  });
export type GetRoomMessagesQuery = z.infer<typeof GetRoomMessagesQuerySchema>;

// Rules
export const GetRulesQuerySchema = z.object({ roomId: z.string().uuid() }).strict();
export const UpdateRoomRulesSchema = z
  .object({
    roomId: z.string().uuid(),
    rules: z.array(z.string().trim().min(1).max(500)).max(50),
  })
  .strict();
export type UpdateRoomRulesInput = z.infer<typeof UpdateRoomRulesSchema>;

// Reports
export const GetReportsQuerySchema = z
  .object({
    status: z
      .enum(['ALL', 'PENDING', 'ACTIONED', 'DISMISSED', 'REVIEWED'])
      .default('ALL')
      .optional(),
    reportedUserId: z.string().uuid().optional(),
    before: z.string().datetime({ offset: true }).optional(),
    cursor: ListCursorSchema,
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type GetReportsQuery = z.infer<typeof GetReportsQuerySchema>;

export const ActionReportSchema = z
  .object({
    reportId: z.string().uuid(),
    action: z.enum(['DISMISS', 'WARN', 'BAN', 'RETRACT_MESSAGE']),
    note: z.string().trim().min(1).max(1_000),
    banDurationHours: z.number().int().min(1).optional(),
    banPermanent: z.literal(true).optional(),
    userReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((dto, ctx) => {
    if (dto.action === 'BAN' && dto.banDurationHours === undefined && dto.banPermanent !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['banDurationHours'],
        message: 'A BAN action needs banDurationHours or banPermanent: true',
      });
    }
  });
export type ActionReportInput = z.infer<typeof ActionReportSchema>;

// Report reasons
export const UpsertReportReasonSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[A-Z0-9_]+$/, 'Code must be UPPER_SNAKE_CASE'),
    label: z.string().trim().min(1).max(100),
    reportType: z.enum(['MESSAGE', 'USER']).default('MESSAGE'),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();
export const ReportReasonsQuerySchema = z.object({ type: z.enum(['MESSAGE', 'USER']).optional() }).strict();
export type UpsertReportReasonInput = z.infer<typeof UpsertReportReasonSchema>;

// Bans
export const GetBansQuerySchema = z
  .object({
    before: z.string().datetime({ offset: true }).optional(),
    cursor: ListCursorSchema,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    userId: z.string().trim().optional(),
    activeOnly: z.coerce.boolean().default(false),
  })
  .strict();

export const CreateBanSchema = z
  .object({
    userId: z.string().trim().min(1),
    internalReason: z.string().trim().min(1).max(1_000),
    userReason: z.string().trim().min(1).max(500).optional(),
    durationHours: z.number().int().min(1).optional(),
    permanent: z.literal(true).optional(),
    roomId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .superRefine((dto, ctx) => {
    if (dto.permanent !== true && dto.durationHours === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationHours'],
        message: 'A ban needs durationHours (1 or more) or permanent: true',
      });
    }
    if (dto.permanent === true && dto.durationHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationHours'],
        message: 'Give durationHours or permanent, not both',
      });
    }
  });
export type CreateBanInput = z.infer<typeof CreateBanSchema>;

export const UnbanSchema = z
  .object({
    banId: z.string().uuid(),
    note: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type UnbanInput = z.infer<typeof UnbanSchema>;

// Staff roles
export const AssignRoleSchema = z
  .object({
    userId: z.string().trim().min(1).max(64),
    role: z.enum(STAFF_ROLES),
    note: z.string().trim().min(1).max(500),
  })
  .strict();
export type AssignRoleInput = z.infer<typeof AssignRoleSchema>;

export const RemoveRoleSchema = z
  .object({
    userId: z.string().trim().min(1).max(64),
    note: z.string().trim().min(1).max(500),
  })
  .strict();
export type RemoveRoleInput = z.infer<typeof RemoveRoleSchema>;

// Regions
export const CreateRegionSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    countries: z.array(CountryCodeSchema).min(1).max(250),
  })
  .strict();
export type CreateRegionInput = z.infer<typeof CreateRegionSchema>;

export const UpdateRegionSchema = z
  .object({
    regionId: z.string().uuid(),
    name: z.string().trim().min(2).max(100).optional(),
    countries: z.array(CountryCodeSchema).min(1).max(250).optional(),
  })
  .strict();

export const GetRegionQuerySchema = z.object({ regionId: z.string().uuid() }).strict();

// Cosmetics and skins
export const CreateSkinSchema = z
  .object({
    name: z.string().trim().min(2).max(50),
    description: z.string().trim().max(200).default(''),
    gradient: z.string().trim().min(3).max(200),
    borderColor: z.string().trim().min(3).max(100),
    badgeIcon: z.string().trim().min(1).max(100),
    cost: UsdAmountSchema.default('0'),
    isPremium: z.boolean().default(false),
  })
  .strict();
export type CreateSkinInput = z.infer<typeof CreateSkinSchema>;

export const DeactivateSkinSchema = z.object({ id: z.string().uuid() }).strict();

// Media uploads
export const GetMediaQuerySchema = z
  .object({
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    flaggedOnly: z.coerce.boolean().default(false),
  })
  .strict();

export const FlagMediaSchema = z
  .object({
    uploadId: z.string().uuid(),
    note: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type FlagMediaInput = z.infer<typeof FlagMediaSchema>;

export const DeleteMediaSchema = z
  .object({
    uploadId: z.string().uuid(),
    note: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type DeleteMediaInput = z.infer<typeof DeleteMediaSchema>;

// Broadcast alerts
export const BroadcastSchema = z
  .object({
    roomId: z.string().uuid().nullable().optional(),
    type: z.enum(['ADMIN_ALERT', 'SYSTEM_ALERT', 'MAINTENANCE', 'PROMO']).default('ADMIN_ALERT'),
    title: z.string().trim().min(2).max(200),
    content: z.string().trim().min(1).max(2_000),
    priority: z.enum(['HIGH', 'NORMAL', 'URGENT']).optional().default('NORMAL'),
  })
  .strict();
export type BroadcastInput = z.infer<typeof BroadcastSchema>;

// Chat settings
export const SaveSettingsSchema = z
  .object({
    patch: z.record(z.unknown()),
    effectiveAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type SaveSettingsInput = z.infer<typeof SaveSettingsSchema>;

export const RollbackSettingsSchema = z.object({ changeId: z.string().uuid() }).strict();

export const GetSettingsChangesQuerySchema = z
  .object({
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: z.enum(['ALL', 'SCHEDULED', 'APPLIED', 'CANCELLED']).default('ALL'),
  })
  .strict();

// Retract
export const RetractMessageSchema = z
  .object({
    messageId: z.string().uuid(),
    note: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type RetractMessageInput = z.infer<typeof RetractMessageSchema>;

// Frequent limit triggers
export const GetFrequentHittersQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    sort: z.enum(['date', 'count']).default('date'),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

// Moderation log
export const ModerationActionsQuerySchema = z
  .object({
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    actorType: z.enum(['ADMIN', 'STAFF', 'SYSTEM']).optional(),
  })
  .strict();

// Test entitlements schema for development environments
export const UpsertTestEntitlementSchema = z
  .object({
    userId: z.string().trim().min(1),
    onCasino: z.boolean().default(false),
    wagerUsd: UsdAmountSchema.default('0'),
    premiumPlanIds: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
    kycLevel: z.number().int().min(0).max(10).nullable().default(0),
    isSiteOwner: z.boolean().default(false),
    level: z.number().int().min(0).max(100_000).nullable().default(0),
    follows: z.array(z.string().trim().min(1).max(64)).max(200).default([]),
  })
  .strict();
export type UpsertTestEntitlementInput = z.infer<typeof UpsertTestEntitlementSchema>;

export const DeleteTestEntitlementSchema = z.object({ userId: z.string().trim().min(1) }).strict();
