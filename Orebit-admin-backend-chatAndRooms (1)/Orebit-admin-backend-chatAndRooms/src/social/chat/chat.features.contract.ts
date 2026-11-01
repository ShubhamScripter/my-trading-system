import { z } from 'zod';
import { AdminUsdPriceSchema, CHAT_COMMANDS, MAX_BAN_HOURS_CEILING, UsdAmountSchema } from './chat.contract';

// Shared chat feature settings schemas for roles, commands, gifts, ads, DMs, groups, and privacy.

// Staff role permissions
export const STAFF_PERMISSIONS = [
  'WARN',
  'BAN',
  'ROOM_ACCESS',
  'RESTRICT_COMMANDS',
  'RESTRICT_EMOJI',
  'RESTRICT_GIF',
  'RESTRICT_ADS',
  'RESTRICT_GIFTS',
  'RESTRICT_RAIN',
  'RESTRICT_RAIN_RECEIVE',
  'RESTRICT_DM',
  'PIN',
  'ROOM_STATUS',
  'DISABLE_COMMANDS',
  'SEE_DELETED',
  'DELETE_MESSAGES',
  'JOIN_STAFF_ROOM',
  'SEE_REPORTS',
  'ACT_ON_REPORTS',
  'SEE_HISTORY',
  'USER_MESSAGES',
  'USER_TAGS',
  'EDIT_RULES',
  'CHANGE_PENALTIES',
  'SEE_PENALISED',
  'SEND_PICTURES',
  'MANAGE_PICTURES',
  'SEND_VIDEOS',
  'MANAGE_VIDEOS',
  'SENDING_MONEY',
  'DISABLE_RAINPOOL_RAINS',
  'DISABLE_USER_RAINS',
  'DISABLE_OVERALL_RAINS',
  'SEE_USER_STATS',
  'BOT_LOG',
  'VIEW_USER_HISTORY',
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

// Permission execution mode: direct action, escalation report, or disabled.
export const PERMISSION_MODES = ['NONE', 'REPORT', 'ACT'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// Relative hierarchy authority for modifying penalties created by other staff.
export const PENALTY_SCOPES = ['SAME', 'BELOW', 'SAME_AND_BELOW'] as const;

const RoomIdList = z
  .array(
    z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'A room id'),
  )
  .max(500);

// User metrics visible to staff.
export const USER_STATS = [
  'MESSAGES',
  'WARNINGS',
  'BANS',
  'REPORTS',
  'RESTRICTIONS',
  'GIFTS',
  'ADS',
] as const;
export type UserStat = (typeof USER_STATS)[number];

export const RolePermissionsSchema = z
  .object({
    permissions: z.record(z.enum(STAFF_PERMISSIONS), z.enum(PERMISSION_MODES)),
    maxBanHours: z.number().int().min(1).max(MAX_BAN_HOURS_CEILING),
    penaltyScope: z.enum(PENALTY_SCOPES),
    historyDays: z.number().int().min(1).max(3650),
    messageHistoryDays: z.number().int().min(1).max(3650).optional(),
    tagHistoryDays: z.number().int().min(1).max(3650).optional(),
    userHistoryFeatures: z
      .array(z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, 'A feature id such as FAUCET'))
      .max(50)
      .optional(),
    userHistoryDays: z.number().int().min(1).max(3650).optional(),
    pinRoomIds: RoomIdList,
    rulesRoomIds: RoomIdList,
    restrictableCommands: z.array(z.enum(CHAT_COMMANDS)).max(CHAT_COMMANDS.length),
    groupPrivilege: z.boolean(),
    visibleStats: z.array(z.enum(USER_STATS)).max(USER_STATS.length),
  })
  .strict();
export type RolePermissions = z.infer<typeof RolePermissionsSchema>;

export const staffRolesSection = {
  ADMIN: RolePermissionsSchema,
  MODERATOR: RolePermissionsSchema,
  SUPPORT: RolePermissionsSchema,
};

// Commands, gifts, and advertisements
export const commandsSection = {
  enabled: z.boolean(),
  disabled: z.array(z.enum(CHAT_COMMANDS)).max(CHAT_COMMANDS.length),
  maxMutes: z.number().int().min(1).max(100000),
  maxBlocks: z.number().int().min(1).max(100000),
};

export const giftsSection = {
  enabled: z.boolean(),
  allowToMutedBlocked: z.boolean(),
  minUsd: UsdAmountSchema.nullable(),
  maxUsd: UsdAmountSchema.nullable(),
  requirePaymentPin: z.boolean(),
  perCurrency: z
    .record(
      z.string().regex(/^[A-Z0-9]{2,12}$/, 'A currency code such as USDT'),
      z
        .object({
          min: z
            .string()
            .regex(/^\d{1,18}(\.\d{1,18})?$/)
            .nullable(),
          max: z
            .string()
            .regex(/^\d{1,18}(\.\d{1,18})?$/)
            .nullable(),
        })
        .strict(),
    )
    .refine((r) => Object.keys(r).length <= 100, 'At most 100 currencies'),
  processingStaleMinutes: z.number().int().min(1).max(10080).nullable(),
};

// Surcharge definition as either percentage or flat USD amount.
export const PriceAddSchema = z
  .object({ kind: z.enum(['USD', 'PERCENT']), value: UsdAmountSchema })
  .strict()
  .refine((add) => add.kind !== 'USD' || AdminUsdPriceSchema.safeParse(add.value).success, {
    message: 'A USD price with at most 2 decimals',
    path: ['value'],
  });
export type PriceAdd = z.infer<typeof PriceAddSchema>;

export const adsSection = {
  enabled: z.boolean(),
  basePriceUsd: AdminUsdPriceSchema,
  extraRoom: PriceAddSchema,
  premiumRoom: PriceAddSchema,
  subPremiumRoom: PriceAddSchema,
  soRoom: PriceAddSchema,
  allRooms: PriceAddSchema,
  allRoomsByDefault: z.boolean(),
  allowedRoomIds: RoomIdList,
  maxChars: z.number().int().min(10).max(1000),
  maxFreeLinks: z.number().int().min(0).max(20),
  maxPaidLinks: z.number().int().min(0).max(20),
  pricePerExtraLink: PriceAddSchema,
  cancellationFee: PriceAddSchema.nullable().default(null),
  allow18Plus: z.boolean().default(false),
  extra18PlusPercent: z.string().regex(/^\d{1,3}(\.\d{1,8})?$/).default('0'),
  acceptedCurrencies: z.array(z.string().regex(/^[A-Z0-9]{2,12}$/, 'A currency code such as USDT')).max(50).default([]),
  pinned: z
    .object({
      enabled: z.boolean(),
      pricePerMinute: PriceAddSchema,
      maxQueue: z.number().int().min(1).max(100),
      minMinutes: z.number().int().min(1).max(1440),
      maxMinutes: z.number().int().min(1).max(10080),
    })
    .strict()
    .refine((p) => p.minMinutes <= p.maxMinutes, 'minMinutes must not exceed maxMinutes'),
  badges: z
    .array(
      z
        .object({
          id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
          emoji: z.string().min(1).max(16).optional(),
          text: z.string().trim().min(1).max(20).optional(),
        })
        .strict(),
    )
    .max(20),
  skins: z
    .array(
      z
        .object({
          id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
          name: z.string().trim().min(1).max(40),
          style: z.record(z.string().max(40), z.string().max(200)),
          priceUsd: AdminUsdPriceSchema,
        })
        .strict(),
    )
    .max(20),
  separateTab: z.boolean(),
  refundCurrencies: z.array(z.string().regex(/^[A-Z0-9]{2,12}$/, 'A currency code such as USDT')).max(50),
  pendingPaymentMinutes: z.number().int().min(1).max(10080).nullable(),
  jobStaleMinutes: z.number().int().min(1).max(1440).nullable(),
  jobPageSize: z.number().int().min(1).max(1000).nullable(),
  jobBudgetSeconds: z.number().int().min(1).max(600).nullable(),
  repeat: z
    .object({
      enabled: z.boolean(),
      minCount: z.number().int().min(1).max(100),
      maxCount: z.number().int().min(1).max(100),
      minGapMinutes: z.number().int().min(1).max(10080),
      maxGapMinutes: z.number().int().min(1).max(10080),
      discountPercent: z.number().min(0).max(100),
      maxDiscountPercent: z.number().min(0).max(100),
      maxDiscountUsd: AdminUsdPriceSchema.nullable(),
    })
    .strict()
    .refine((r) => r.minCount <= r.maxCount && r.minGapMinutes <= r.maxGapMinutes, {
      message: 'minimums must not exceed maximums',
    }),
};

// Activity reward rule schema for fixed or scaled payouts.
export const RewardRuleSchema = z
  .object({
    mode: z.enum(['FIXED', 'DYNAMIC']),
    amount: z.number().int().min(0).max(1_000_000),
    everyUsd: UsdAmountSchema,
  })
  .strict();
export type RewardRule = z.infer<typeof RewardRuleSchema>;

const RewardPairSchema = z.object({ exp: RewardRuleSchema, currency: RewardRuleSchema }).strict();

// Reward rules for advertising and gifts.
export const rewardsSection = {
  advert: RewardPairSchema,
  gift: RewardPairSchema,
};

// Chatbot display profile configuration.
export const botSection = {
  profileUserId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'A user id')
    .nullable(),
};

// Direct messages, groups, and privacy settings
export const DM_STATUSES = ['ACTIVE', 'MAINTENANCE', 'DISABLED'] as const;

export const GROUP_PERMISSIONS = [
  'RENAME',
  'CHANGE_DESCRIPTION',
  'CHANGE_IMAGE',
  'REMOVE_PEOPLE',
  'ADD_PEOPLE',
  'CHANGE_TYPE',
  'DELETE_MESSAGES',
  'TIMEOUT',
  'BAN',
] as const;
export type GroupPermission = (typeof GROUP_PERMISSIONS)[number];

export const VISIBILITY_CHOICES = ['ALL', 'FRIENDS', 'NOBODY'] as const;
export type VisibilityChoice = (typeof VISIBILITY_CHOICES)[number];

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:MM');

// Helper for nullable numeric limit definitions.
const limit = (min: number, max: number) => z.number().int().min(min).max(max).nullable();

export const dmSection = {
  status: z.enum(DM_STATUSES),
  newDmFollowerCount: limit(1, 10000),
  newDmFollowerWindowHours: limit(1, 720),
  newDmNonFollowerCount: limit(1, 10000),
  newDmNonFollowerWindowHours: limit(1, 720),
  strangerMessageCap: limit(1, 1000),
  merchantMessageCap: limit(1, 1000),
  typingEverySeconds: limit(1, 60),
  maxPinnedPeople: limit(0, 100),
  maxPinnedMessages: limit(0, 100),
};

const DM_REQUIRED = [
  'newDmFollowerCount',
  'newDmFollowerWindowHours',
  'newDmNonFollowerCount',
  'newDmNonFollowerWindowHours',
  'strangerMessageCap',
  'merchantMessageCap',
  'typingEverySeconds',
  'maxPinnedPeople',
  'maxPinnedMessages',
] as const;
const PRIVACY_REQUIRED = ['lastSeenDefault', 'quietStart', 'quietEnd'] as const;

// Checks for unconfigured DM and privacy settings required before activation.
export function dmMissingValues(
  dm: Readonly<Record<string, unknown>>,
  privacy: Readonly<Record<string, unknown>>,
): string[] {
  return [
    ...DM_REQUIRED.filter((key) => dm[key] === null || dm[key] === undefined).map((key) => `dm.${key}`),
    ...PRIVACY_REQUIRED.filter((key) => privacy[key] === null || privacy[key] === undefined).map(
      (key) => `privacy.${key}`,
    ),
  ];
}

// Maintenance toggles and behavior configurations.
export const maintenanceSection = {
  chat: z.enum(DM_STATUSES),
  publicChat: z.enum(DM_STATUSES),
  skins: z.enum(DM_STATUSES),
  giftsInChat: z.enum(DM_STATUSES),
  ads: z.enum(DM_STATUSES),
  adsOnStop: z.enum(['PAUSE', 'FINISH', 'REFUND_PENDING', 'REFUND_FULL']),
  adsOnResume: z.enum(['RESUME', 'REFUND_PENDING', 'REFUND_FULL', 'RESET_RESUME']),
  autoModLinks: z.enum(DM_STATUSES),
  autoModWords: z.enum(DM_STATUSES),
  autoModSpam: z.enum(DM_STATUSES),
  commandsInMaintenance: z.array(z.enum(CHAT_COMMANDS)).max(CHAT_COMMANDS.length),
  note: z.string().trim().min(1).max(300).nullable(),
};

export const groupsSection = {
  maxCreatePublic: z.number().int().min(0).max(1000),
  maxCreatePrivate: z.number().int().min(0).max(1000),
  maxCreatePublicPremium: z.number().int().min(0).max(1000),
  maxCreatePrivatePremium: z.number().int().min(0).max(1000),
  maxJoinPublic: z.number().int().min(0).max(10000),
  maxJoinPrivate: z.number().int().min(0).max(10000),
  maxAdmins: z.number().int().min(0).max(1000).nullable(),
  maxSubAdmins: z.number().int().min(0).max(1000).nullable(),
  memberLimitPublic: limit(2, 100000),
  memberLimitPrivate: limit(2, 100000),
  memberLimitChannel: limit(2, 1000000),
  maxChannelAdmins: limit(0, 1000),
  receiptGroupSize: limit(2, 100000),
  invitesPerWindow: limit(1, 1000),
  inviteWindowHours: limit(1, 720),
  maxPendingInvitesPerPerson: limit(1, 100),
  inviteExpiryHours: limit(1, 8760),
  transfersPerWindow: z.number().int().min(1).max(100),
  transferWindowHours: z.number().int().min(1).max(8760),
  delegablePermissions: z.array(z.enum(GROUP_PERMISSIONS)).max(GROUP_PERMISSIONS.length),
};

export const privacySection = {
  lastSeenDefault: z.enum(VISIBILITY_CHOICES).nullable(),
  commonGroupsDefault: z.enum(VISIBILITY_CHOICES),
  notifyPrimary: z.boolean(),
  notifyGeneral: z.boolean(),
  notifyGroups: z.boolean(),
  quietModeDefault: z.enum(['AUTO_NIGHT', 'OFF']),
  quietStart: HHMM.nullable(),
  quietEnd: HHMM.nullable(),
  allowQuietChange: z.boolean(),
};
