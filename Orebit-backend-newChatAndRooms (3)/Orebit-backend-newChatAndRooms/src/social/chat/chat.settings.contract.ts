import { z } from 'zod';
import {
  type AutoBanTier,
  AutoBanTierSchema,
  CountryCodeSchema,
  DomainSchema,
  GIF_PROVIDERS,
  MAX_BAN_HOURS_CEILING,
  SpamProtectionSchema,
  UPLOAD_TYPES,
} from './chat.contract';
import { FEATURE_DEFAULTS } from './chat.features.defaults';
import {
  adsSection,
  botSection,
  commandsSection,
  dmMissingValues,
  dmSection,
  giftsSection,
  groupsSection,
  maintenanceSection,
  privacySection,
  rewardsSection,
  staffRolesSection,
} from './chat.features.contract';

// Chat-wide admin settings contract: global defaults and country-specific overrides.

// Chat-wide settings schemas
const roomsSection = {
  // Room visibility and enablement toggles.
  byCountry: z.boolean(),
  byContinent: z.boolean(),
  byRegion: z.boolean(),
  byLanguage: z.boolean(),
  languagePremiumRooms: z.boolean(),
  regionPremiumRooms: z.boolean(),
  siteOwnerRoom: z.boolean(),
  siteOwnerPremiumRoom: z.boolean(),
  casinoPremiumRoom: z.boolean(),
  premiumPerPlan: z.boolean(),
  premiumOverall: z.boolean(),
};

const defaultRoomSection = {
  // Default room selection configuration.
  base: z.enum(['COUNTRY', 'GLOBAL']),
  premiumFirst: z.boolean(),
  kycFirst: z.boolean(),
};

const casinoSection = {
  // Casino chat switching rules and wager tracking window.
  autoSwitch: z.boolean(),
  autoSwitchWhenDmOpen: z.boolean(),
  wagerWindowDays: z.number().int().min(1).max(365),
};

const minLevelSection = {
  // Minimum account level required to participate in rooms.
  global: z.number().int().min(0).max(100000),
  countryLanguage: z.number().int().min(0).max(100000),
};

const linksSection = {
  // Whitelisted external domains for link policy.
  allowedDomains: z.array(DomainSchema).max(50),
};

const mediaSection = {
  gifProvider: z.enum(GIF_PROVIDERS),
};

const uploadsSection = {
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024),
  allowedTypes: z.array(z.enum(UPLOAD_TYPES)).min(1).max(UPLOAD_TYPES.length),
};

const limitsSection = {
  // Socket rate limits and slow-mode thresholds.
  eventsPerSecond: z.number().int().min(1).max(100),
  eventsBurst: z.number().int().min(1).max(200),
  connectionsPerAccount: z.number().int().min(1).max(20),
  messagesPerWindow: z.number().int().min(1).max(100),
  messageWindowSeconds: z.number().int().min(1).max(600),
  cooldownSeconds: z.number().int().min(1).max(3600),
  mediaCooldownSeconds: z.number().int().min(0).max(3600),
  retractWindowSeconds: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 3600),
  maxBanHours: z.number().int().min(1).max(MAX_BAN_HOURS_CEILING),
  sendsPerIpPerMinute: z.number().int().min(1).max(100000),
  reportsPerHour: z.number().int().min(1).max(1000),
  hitterThreshold: z.number().int().min(1).max(100000),
  hitterBlockMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
};

// Moderation rules: spam protection and penalty sequence ladder.
const moderationSection = {
  spamProtection: SpamProtectionSchema.nullable(),
  autoBanSequence: z.array(AutoBanTierSchema).max(10),
};

// Test stand-in provider configuration.
const testProvidersSection = {
  enabled: z.boolean(),
};

export const DEFAULT_CHAT_SETTINGS = {
  rooms: {
    byCountry: true,
    byContinent: true,
    byRegion: true,
    byLanguage: true,
    languagePremiumRooms: true,
    regionPremiumRooms: true,
    siteOwnerRoom: true,
    siteOwnerPremiumRoom: true,
    casinoPremiumRoom: true,
    premiumPerPlan: true,
    premiumOverall: true,
  },
  defaultRoom: { base: 'GLOBAL', premiumFirst: false, kycFirst: false },
  casino: {
    autoSwitch: false,
    autoSwitchWhenDmOpen: false,
    wagerWindowDays: 30,
  },
  minLevel: { global: 0, countryLanguage: 0 },
  links: { allowedDomains: [] as string[] },
  media: { gifProvider: 'TENOR' },
  uploads: {
    maxBytes: 5 * 1024 * 1024,
    allowedTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  },
  limits: {
    eventsPerSecond: 10,
    eventsBurst: 20,
    connectionsPerAccount: 5,
    messagesPerWindow: 5,
    messageWindowSeconds: 5,
    cooldownSeconds: 10,
    mediaCooldownSeconds: 30,
    retractWindowSeconds: 0,
    maxBanHours: 24 * 30,
    sendsPerIpPerMinute: 300,
    reportsPerHour: 10,
    hitterThreshold: 60,
    hitterBlockMinutes: 15,
  },
  moderation: { spamProtection: null, autoBanSequence: [] as AutoBanTier[] },
  testProviders: { enabled: false },
  ...FEATURE_DEFAULTS,
} as const;

function section<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

// Full effective settings schema including all configuration sections.
export const ChatSettingsSchema = z
  .object({
    rooms: section(roomsSection),
    defaultRoom: section(defaultRoomSection),
    casino: section(casinoSection),
    minLevel: section(minLevelSection),
    links: section(linksSection),
    media: section(mediaSection),
    uploads: section(uploadsSection),
    limits: section(limitsSection),
    moderation: section(moderationSection),
    testProviders: section(testProvidersSection),
    staffRoles: section(staffRolesSection),
    commands: section(commandsSection),
    gifts: section(giftsSection),
    ads: section(adsSection),
    dm: section(dmSection),
    maintenance: section(maintenanceSection),
    groups: section(groupsSection),
    privacy: section(privacySection),
    rewards: section(rewardsSection),
    bot: section(botSection),
  })
  .strict();
export type ChatSettings = z.infer<typeof ChatSettingsSchema>;

// Partial settings schema for overrides and country-specific layers.
export const ChatSettingsLayerSchema = z
  .object({
    rooms: section(roomsSection).partial().optional(),
    defaultRoom: section(defaultRoomSection).partial().optional(),
    casino: section(casinoSection).partial().optional(),
    minLevel: section(minLevelSection).partial().optional(),
    links: section(linksSection).partial().optional(),
    media: section(mediaSection).partial().optional(),
    uploads: section(uploadsSection).partial().optional(),
    limits: section(limitsSection).partial().optional(),
    moderation: section(moderationSection).partial().optional(),
    testProviders: section(testProvidersSection).partial().optional(),
    staffRoles: section(staffRolesSection).partial().optional(),
    commands: section(commandsSection).partial().optional(),
    gifts: section(giftsSection).partial().optional(),
    ads: section(adsSection).partial().optional(),
    dm: section(dmSection).partial().optional(),
    maintenance: section(maintenanceSection).partial().optional(),
    groups: section(groupsSection).partial().optional(),
    privacy: section(privacySection).partial().optional(),
    rewards: section(rewardsSection).partial().optional(),
    bot: section(botSection).partial().optional(),
  })
  .strict();
export type ChatSettingsLayer = z.infer<typeof ChatSettingsLayerSchema>;

// Settings keys restricted to global scope only.
export const GLOBAL_ONLY_SETTINGS = [
  'testProviders',
  'links',
  'limits',
  'moderation',
  'staffRoles',
  'commands',
  'gifts',
  'ads',
  'dm',
  'maintenance',
  'groups',
  'privacy',
  'rewards',
  'bot',
] as const;

export const ChatSettingsDocumentSchema = z
  .object({
    global: ChatSettingsLayerSchema.default({}),
    countries: z.record(CountryCodeSchema, ChatSettingsLayerSchema).default({}),
  })
  .strict()
  .superRefine((doc, ctx) => {
    for (const [country, layer] of Object.entries(doc.countries)) {
      for (const key of GLOBAL_ONLY_SETTINGS) {
        if (layer[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['countries', country, key],
            message: `${key} is chat-wide and cannot be set per country`,
          });
        }
      }
    }
    const merged = mergeSettings(DEFAULT_CHAT_SETTINGS as unknown as ChatSettings, doc.global);
    if (merged.limits.eventsBurst < merged.limits.eventsPerSecond) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['global', 'limits', 'eventsBurst'],
        message: 'eventsBurst must be at least eventsPerSecond',
      });
    }
    // DM requires all parameters configured before activation.
    if (merged.dm.status === 'ACTIVE') {
      const missing = dmMissingValues(merged.dm, merged.privacy);
      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['global', 'dm', 'status'],
          message: `DM cannot be ACTIVE until these are set: ${missing.join(', ')}`,
        });
      }
    }
    // Pausing ads is only permitted during maintenance mode.
    if (merged.maintenance.ads === 'DISABLED' && merged.maintenance.adsOnStop === 'PAUSE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['global', 'maintenance', 'adsOnStop'],
        message: 'Pausing existing ads is only for maintenance; choose FINISH, REFUND_PENDING or REFUND_FULL for off',
      });
    }
  });
export type ChatSettingsDocument = z.infer<typeof ChatSettingsDocumentSchema>;

// Merges a partial settings layer over base configuration.
export function mergeSettings(
  base: ChatSettings,
  layer: ChatSettingsLayer | undefined,
): ChatSettings {
  if (!layer) return base;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base) as (keyof ChatSettings)[]) {
    out[key] = {
      ...(base[key] as object),
      ...((layer[key] as object | undefined) ?? {}),
    };
  }
  return out as ChatSettings;
}

// Resolves effective settings for country including defaults and global overrides.
export function effectiveSettings(
  document: ChatSettingsDocument,
  country: string | null,
): ChatSettings {
  const global = mergeSettings(DEFAULT_CHAT_SETTINGS as unknown as ChatSettings, document.global);
  if (!country) return global;
  return mergeSettings(global, document.countries[country]);
}

// Settings changes schemas
export const SettingsPatchSchema = z
  .object({
    global: ChatSettingsLayerSchema.optional(),
    countries: z.record(CountryCodeSchema, ChatSettingsLayerSchema.nullable()).optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

function mergeLayer(
  base: ChatSettingsLayer | undefined,
  patch: ChatSettingsLayer,
): ChatSettingsLayer {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = {
      ...((out[key] as object | undefined) ?? {}),
      ...(value as object),
    };
  }
  return out as ChatSettingsLayer;
}

// Applies patch to stored settings document.
export function applySettingsPatch(
  document: ChatSettingsDocument,
  patch: SettingsPatch,
): ChatSettingsDocument {
  const countries: Record<string, ChatSettingsLayer> = {
    ...document.countries,
  };
  for (const [code, layer] of Object.entries(patch.countries ?? {})) {
    if (layer === null) delete countries[code];
    else countries[code] = mergeLayer(countries[code], layer);
  }
  return {
    global: patch.global ? mergeLayer(document.global, patch.global) : document.global,
    countries,
  };
}
