import { z } from 'zod';

// Chat contract definitions for rooms, access rules, and configuration schemas.
export const CHAT_CONTRACT_VERSION = 8;

// Enumerations
export const ROOM_TYPES = [
  'GLOBAL',
  'COUNTRY',
  'CONTINENT',
  'REGION',
  'LANGUAGE',
  'PREMIUM',
  'KYC',
  'CASINO',
  'SO',
  'STAFF',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

// Support ticket workflow statuses.
export const SUPPORT_STATUSES = ['PENDING', 'OPEN', 'CLOSED'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export const SUPPORT_SUBJECT_MAX = 120;

// Room availability states.
export const ROOM_STATUSES = ['ACTIVE', 'MAINTENANCE', 'DISABLED'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

// Room handling mode for ineligible users.
export const INELIGIBLE_MODES = ['VIEW_ONLY', 'HIDE', 'PROMO_ONLY'] as const;
export type IneligibleMode = (typeof INELIGIBLE_MODES)[number];

// Link posting policy options.
export const LINK_POLICIES = ['NO_LINKS', 'OREBIT_ONLY', 'ALL_LINKS'] as const;
export type LinkPolicy = (typeof LINK_POLICIES)[number];

// Audience visibility groups.
export const VISIBILITY_GROUPS = ['PREMIUM', 'SO', 'STAFF', 'KYC'] as const;
export type VisibilityGroup = (typeof VISIBILITY_GROUPS)[number];

// Canonical chat commands.
export const CHAT_COMMANDS = [
  'help',
  'dm',
  'mute',
  'unmute',
  'mutelist',
  'block',
  'unblock',
  'blocklist',
  'send',
  'ad',
  'rain',
] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];

// Moderation restriction types.
export const RESTRICTION_KINDS = [
  'MUTE',
  'RESTRICT_MEDIA',
  'RESTRICT_EMOJI',
  'RESTRICT_GIF',
  'RESTRICT_COMMANDS',
  'RESTRICT_ADS',
  'RESTRICT_DM',
  'RESTRICT_GIFTS',
  'RESTRICT_RECEIVE_GIFTS',
  'RESTRICT_RAIN',
  'RESTRICT_RAIN_RECEIVE',
  'RESTRICT_PIN',
  'RESTRICT_DELETE_MESSAGES',
  'RESTRICT_HISTORY',
  'RESTRICT_STAFF_ROOM',
  'RESTRICT_IMAGES',
  'RESTRICT_VIDEOS',
] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

// Restriction targets.
export const RESTRICTION_TARGETS = ['USER', 'PREMIUM', 'KYC', 'LEVEL'] as const;
export type RestrictionTarget = (typeof RESTRICTION_TARGETS)[number];

export const AUTO_BAN_ACTIONS = ['WARNING', 'BAN'] as const;

// Third-party GIF integration providers.
export const GIF_PROVIDERS = ['TENOR', 'GIPHY'] as const;
export type GifProvider = (typeof GIF_PROVIDERS)[number];

export const UPLOAD_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

export const STAFF_ROLES = ['ADMIN', 'MODERATOR', 'SUPPORT'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// Building blocks
export const CountryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'An ISO 3166-1 alpha-2 code in capitals');

// Decimal string with up to 8 decimals for financial amounts.
export const UsdAmountSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? String(value) : value.trim()))
  .pipe(
    z
      .string()
      .regex(
        /^\d{1,10}(\.\d{1,8})?$/,
        'A USD amount with at most 8 decimals, below 10,000,000,000',
      ),
  );

// Price in USD formatted with at most 2 decimal places.
export const AdminUsdPriceSchema = UsdAmountSchema.pipe(
  z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'A USD price with at most 2 decimals'),
);

// Fully qualified domain name schema.
export const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'A domain such as orebit.io',
  );

// Maximum ban duration in hours.
export const MAX_BAN_HOURS_CEILING = 24 * 365 * 10;

// Room configuration schemas
export const DEFAULT_CONTENT_CONTROLS = {
  allowText: true,
  allowEmoji: true,
  allowGif: true,
  allowImage: false,
  allowVideo: false,
  autoModeration: true,
  allowCommands: false,
  allowAds: false,
} as const;

export const ContentControlsSchema = z
  .object({
    allowText: z.boolean().default(DEFAULT_CONTENT_CONTROLS.allowText),
    allowEmoji: z.boolean().default(DEFAULT_CONTENT_CONTROLS.allowEmoji),
    allowGif: z.boolean().default(DEFAULT_CONTENT_CONTROLS.allowGif),
    allowImage: z.boolean().default(DEFAULT_CONTENT_CONTROLS.allowImage),
    allowVideo: z.boolean().default(DEFAULT_CONTENT_CONTROLS.allowVideo),
    autoModeration: z.boolean().default(DEFAULT_CONTENT_CONTROLS.autoModeration),
    allowCommands: z.boolean().default(DEFAULT_CONTENT_CONTROLS.allowCommands),
    commands: z.array(z.enum(CHAT_COMMANDS)).max(CHAT_COMMANDS.length).default([]),
    allowAds: z.boolean().default(DEFAULT_CONTENT_CONTROLS.allowAds),
  })
  .strict();
export type ContentControls = z.infer<typeof ContentControlsSchema>;

// Room controls eligible for maintenance mode.
export const ROOM_CONTROLS = ['TEXT', 'EMOJI', 'GIF', 'IMAGE', 'VIDEO', 'COMMANDS', 'ADS'] as const;
export type RoomControl = (typeof ROOM_CONTROLS)[number];

// Message repetition rate limit configuration.
export const SpamProtectionSchema = z
  .object({
    enabled: z.boolean(),
    repeatCount: z.number().int().min(2).max(20),
    windowSeconds: z.number().int().min(1).max(3600),
  })
  .strict();
export type SpamProtection = z.infer<typeof SpamProtectionSchema>;

// Automatic penalty progression levels.
export const AutoBanTierSchema = z
  .object({
    tier: z.number().int().min(1).max(10),
    action: z.enum(AUTO_BAN_ACTIONS),
    durationSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_BAN_HOURS_CEILING * 3600)
      .optional(),
    permanent: z.literal(true).optional(),
    resetWindowHours: z
      .number()
      .positive()
      .max(24 * 365),
  })
  .strict()
  .superRefine((tier, ctx) => {
    if (tier.action === 'BAN' && tier.durationSeconds === undefined && tier.permanent !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A BAN tier needs durationSeconds or permanent: true',
      });
    }
    if (tier.action === 'WARNING' && (tier.durationSeconds !== undefined || tier.permanent !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A WARNING tier has no duration' });
    }
  });
export type AutoBanTier = z.infer<typeof AutoBanTierSchema>;

// User penalty record schema.
export const UserRestrictionSchema = z
  .object({
    targetType: z.enum(RESTRICTION_TARGETS),
    targetValue: z.string().trim().min(1).max(64),
    restriction: z.enum(RESTRICTION_KINDS),
    internalReason: z.string().trim().min(1).max(500),
    userReason: z.string().trim().min(1).max(500).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    commands: z.array(z.enum(CHAT_COMMANDS)).max(CHAT_COMMANDS.length).optional(),
  })
  .strict()
  .refine((r) => r.commands === undefined || r.restriction === 'RESTRICT_COMMANDS', {
    message: 'commands applies only to RESTRICT_COMMANDS',
    path: ['commands'],
  });
export type UserRestriction = z.infer<typeof UserRestrictionSchema>;

export const RoomConfigSchema = z
  .object({
    status: z.enum(ROOM_STATUSES).default('ACTIVE'),
    statusNote: z.string().trim().min(1).max(300).optional(),
    statusUntil: z.string().datetime({ offset: true }).optional(),
    language: z.string().trim().min(1).max(50).optional(),
    rules: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    contentControls: ContentControlsSchema.default({}),
    controlsMaintenance: z.array(z.enum(ROOM_CONTROLS)).max(ROOM_CONTROLS.length).default([]),
    linksPolicy: z.enum(LINK_POLICIES).optional(),
    bannedWords: z.array(z.string().trim().min(1).max(100)).max(1000).default([]),
    userRestrictions: z.array(UserRestrictionSchema).max(500).default([]),
    casino: z.object({ onlyUsersOnCasino: z.boolean() }).strict().optional(),
  })
  .strict();
export type RoomConfig = z.infer<typeof RoomConfigSchema>;

// Parses room configuration payload safely, collecting validation errors without throwing.
export function parseRoomConfig(raw: unknown): { config: RoomConfig; problems: string[] } {
  const source =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const problems: string[] = [];
  const shape = RoomConfigSchema.shape;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    const value = source[key];
    if (key === 'userRestrictions' || key === 'bannedWords' || key === 'rules') {
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        problems.push(`${key}: not a list`);
        continue;
      }
      const item =
        key === 'userRestrictions'
          ? UserRestrictionSchema
          : key === 'bannedWords'
            ? z.string().trim().min(1).max(100)
            : z.string().trim().min(1).max(500);
      const kept: unknown[] = [];
      value.forEach((entry, index) => {
        const parsed = item.safeParse(entry);
        if (parsed.success) kept.push(parsed.data);
        else problems.push(`${key}[${index}]: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      });
      out[key] = kept;
      continue;
    }
    if (value === undefined) continue;
    const parsed = (shape[key] as z.ZodTypeAny).safeParse(value);
    if (parsed.success) out[key] = parsed.data;
    else problems.push(`${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }

  for (const key of Object.keys(source)) {
    if (!(key in shape)) problems.push(`${key}: unknown key`);
  }

  const whole = RoomConfigSchema.safeParse(out);
  if (whole.success) return { config: whole.data, problems };
  problems.push(`config: ${whole.error.issues[0]?.message ?? 'invalid'}; using the defaults`);
  return { config: RoomConfigSchema.parse({}), problems };
}

// Room access rule schemas
export const RoomVisibilitySchema = z
  .object({
    groups: z.array(z.enum(VISIBILITY_GROUPS)).max(VISIBILITY_GROUPS.length).default([]),
    minLevel: z.number().int().min(0).max(100000).default(0),
  })
  .strict();

export const RoomAccessSchema = z
  .object({
    allowedCountries: z.array(CountryCodeSchema).max(250).default([]),
    regionId: z.string().uuid().nullable().default(null),
    requirePremium: z.boolean().default(false),
    allowedPlanIds: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
    minKycLevel: z.number().int().min(0).max(10).default(0),
    minLevel: z.number().int().min(0).max(100000).default(0),
    minWagerUsd: AdminUsdPriceSchema.nullable().default(null),
    ineligibleMode: z.enum(INELIGIBLE_MODES).default('VIEW_ONLY'),
    visibility: RoomVisibilitySchema.default({}),
  })
  .strict();
export type RoomAccess = z.infer<typeof RoomAccessSchema>;

// Returns default access rules based on room privacy requirements.
export function defaultAccessFor(type: RoomType): RoomAccess {
  return RoomAccessSchema.parse({
    ineligibleMode: type === 'STAFF' || type === 'SO' ? 'HIDE' : 'VIEW_ONLY',
  });
}

// Room update payload schema.
export const RoomPatchSchema = z
  .object({
    room: z
      .object({
        name: z.string().trim().min(2).max(100).optional(),
        slug: z.string().trim().min(2).max(100).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        type: z.enum(ROOM_TYPES).optional(),
      })
      .strict()
      .optional(),
    config: RoomConfigSchema.partial().optional(),
    access: RoomAccessSchema.partial().optional(),
  })
  .strict();
export type RoomPatch = z.infer<typeof RoomPatchSchema>;
