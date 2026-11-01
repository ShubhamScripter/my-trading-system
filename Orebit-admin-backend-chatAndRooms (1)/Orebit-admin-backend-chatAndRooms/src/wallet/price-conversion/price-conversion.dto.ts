import { z } from 'zod';
import {
  decodeBoundCursor,
  decodeHistoryCursor,
  historyCursorContext,
  priceCursorContext,
  isPriceCursorSortValue,
  scheduledCursorContext,
} from './price-conversion.cursor.js';
import {
  PRICE_CONFIG_ACTIONS,
  FIAT_CODES,
  PRICE_HISTORY_EVENT_TYPES,
  PRICE_HISTORY_STATUSES,
  PRICE_RECORD_STATUSES,
  PROVIDER_CODES,
  PROVIDER_ROLES,
  type PersistedPriceConfiguration,
  type PriceConversionBootstrapQuery,
  type PriceConversionHistoryQuery,
  type PriceConversionPatch,
  type PriceConversionPriceQuery,
} from './price-conversion.types.js';

const providerPatchSchema = z
  .object({
    code: z.enum(PROVIDER_CODES),
    enabled: z.boolean(),
    role: z.enum(PROVIDER_ROLES).nullable(),
    viewEnabled: z.boolean(),
    refreshIntervalSeconds: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();

const persistedProviderSchema = z.object({
  enabled: z.boolean(),
  sensitiveRole: z.enum(PROVIDER_ROLES).nullable(),
  viewEnabled: z.boolean(),
  refreshIntervalSeconds: z.number().int().min(1).max(2_147_483_647).optional(),
}).strict();

/** Strict stored representation of the provider configuration accepted by PATCH. */
export const persistedPriceConfigurationSchema: z.ZodType<PersistedPriceConfiguration> = z.object({
  settings: z.object({
    divergenceThresholdBps: z.number().int().min(0).max(10_000),
    visibleFiatCodes: z.array(z.enum(FIAT_CODES)).max(FIAT_CODES.length).optional(),
  }).strict(),
  providers: z.object({
    COINGECKO: persistedProviderSchema,
    ALCHEMY: persistedProviderSchema,
    COINMARKETCAP: persistedProviderSchema,
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const fiats = value.settings.visibleFiatCodes ?? [];
  if (new Set(fiats).size !== fiats.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'visibleFiatCodes'],
      message: 'Fiat codes must be unique.' });
  }
});

/** Validates action-specific governance input before any elevated write begins. */
export const priceConversionPatchSchema: z.ZodType<PriceConversionPatch> = z
  .object({
    action: z.enum(PRICE_CONFIG_ACTIONS),
    expectedRevision: z.number().int().min(0),
    reason: z.string().trim().min(1).max(500),
    changelog: z.string().trim().min(1).max(1000),
    effectiveAt: z.string().datetime().optional(),
    draftId: z.string().uuid().optional(),
    divergenceThresholdBps: z.number().int().min(0).max(10_000).optional(),
    visibleFiatCodes: z.array(z.enum(FIAT_CODES)).max(FIAT_CODES.length).optional(),
    providers: z.array(providerPatchSchema).max(PROVIDER_CODES.length).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const providers = value.providers?.map((provider) => provider.code) ?? [];
    if (new Set(providers).size !== providers.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providers'], message: 'Provider codes must be unique.' });
    const fiats = value.visibleFiatCodes ?? [];
    if (new Set(fiats).size !== fiats.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visibleFiatCodes'], message: 'Fiat codes must be unique.' });
    if ((value.action === 'SCHEDULE') !== (value.effectiveAt !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effectiveAt'], message: 'effectiveAt is required only for SCHEDULE.' });
    if (value.draftId !== undefined && value.action !== 'PUSH') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['draftId'], message: 'draftId is valid only for PUSH.' });
    if (value.draftId !== undefined && (value.divergenceThresholdBps !== undefined
      || value.visibleFiatCodes !== undefined || value.providers !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['draftId'], message: 'A draft PUSH cannot include replacement configuration.' });
    }
  });

const historyCursorSchema = z.string().min(1).max(512).refine((value) => decodeHistoryCursor(value) !== null, 'Invalid cursor.');

export const priceConversionBootstrapQuerySchema: z.ZodType<
  PriceConversionBootstrapQuery,
  z.ZodTypeDef,
  { readonly scheduledCursor?: string; readonly scheduledLimit?: number }
> = z.object({
  scheduledCursor: z.string().min(1).max(512).refine((value) => {
    const cursor = decodeHistoryCursor(value);
    return cursor !== null && cursor[2] === scheduledCursorContext;
  }, 'Invalid scheduled cursor.').optional(),
  scheduledLimit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const priceConversionHistoryQuerySchema: z.ZodType<
  PriceConversionHistoryQuery,
  z.ZodTypeDef,
  {
    readonly cursor?: string;
    readonly limit?: number;
    readonly eventType?: string;
    readonly currencyId?: string;
    readonly providerCode?: string;
    readonly status?: string;
    readonly from?: string;
    readonly to?: string;
    readonly sortBy?: string;
    readonly sortDirection?: string;
  }
> = z
  .object({
    cursor: historyCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    eventType: z.enum(PRICE_HISTORY_EVENT_TYPES).optional(),
    currencyId: z.string().uuid().optional(),
    providerCode: z.enum(PROVIDER_CODES).optional(),
    status: z.enum(PRICE_HISTORY_STATUSES).optional(),
    from: z.string().datetime({ offset: false }).optional(),
    to: z.string().datetime({ offset: false }).optional(),
    sortBy: z.literal('timestamp').default('timestamp'),
    sortDirection: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from !== undefined && value.to !== undefined
      && new Date(value.from).valueOf() >= new Date(value.to).valueOf()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to must be after from.' });
    }
    const cursor = value.cursor === undefined ? null : decodeHistoryCursor(value.cursor);
    if (cursor !== null && cursor[2] !== historyCursorContext(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cursor'], message: 'Cursor does not match query.' });
    }
  });

const priceCursorSchema = z.string().min(1).max(512)
  .refine((value) => decodeBoundCursor(value) !== null, 'Invalid cursor.');

export const priceConversionPriceQuerySchema: z.ZodType<
  PriceConversionPriceQuery,
  z.ZodTypeDef,
  {
    readonly cursor?: string;
    readonly limit?: number;
    readonly currencyId?: string;
    readonly providerCode?: string;
    readonly status?: string;
    readonly sortBy?: string;
    readonly sortDirection?: string;
  }
> = z.object({
  cursor: priceCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  currencyId: z.string().uuid().optional(),
  providerCode: z.enum(PROVIDER_CODES).optional(),
  status: z.enum(PRICE_RECORD_STATUSES).optional(),
  sortBy: z.enum(['currencyId', 'updatedAt']).default('currencyId'),
  sortDirection: z.enum(['asc', 'desc']).default('asc'),
}).strict().superRefine((value, ctx) => {
  const cursor = value.cursor === undefined ? null : decodeBoundCursor(value.cursor);
  if (cursor !== null && (cursor[2] !== priceCursorContext(value)
    || !isPriceCursorSortValue(cursor[0], value.sortBy))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cursor'], message: 'Cursor does not match query.' });
  }
});
