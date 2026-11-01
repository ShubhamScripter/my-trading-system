import { z } from 'zod';
import { uuidv7 } from '../../utils/public.utils.js';
import {
  decodeWalletQueryCursor,
  MAX_WALLET_QUERY_CURSOR_LENGTH,
  walletQueryFingerprint,
} from './wallet-core.cursor.js';
import { normalizeCustodyAddressLists, normalizeReconciliationAlertPercent } from './wallet-core.policy.js';
import {
  WALLET_ACCESS_LEVELS,
  WALLET_AVAILABILITIES,
  WALLET_CONFIG_ACTIONS,
  WALLET_DESIRED_STATES,
  WALLET_OPERATIONS,
  WALLET_PRICE_PROVIDERS,
  WALLET_RECONCILIATION_ALERT_BASES,
} from './wallet-core.types.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTINENTS = ['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA'] as const;
const entityIdSchema = z.string().trim().transform((value) => value.toLowerCase())
  .refine((value) => UUID_V7.test(value), 'Expected UUIDv7.');
const optionalReferenceIdSchema = z.string().uuid().transform((value) => value.toLowerCase()).optional();
const generatedEntityIdSchema = entityIdSchema.optional().default(() => uuidv7());
const instantSchema = z.string().datetime({ offset: false });
const identitySchema = z.string().trim().min(1).max(32)
  .refine((value) => value === value.toUpperCase(), 'Identity must be uppercase.');
const addressListSchema = z.array(z.string().trim().min(1).max(256)).max(10_000);
const operationListSchema = z.array(z.enum(WALLET_OPERATIONS)).max(WALLET_OPERATIONS.length);
const postDelistOperationListSchema = z.array(z.enum(['WITHDRAW', 'EXCHANGE'])).max(2);
const feeSchema = z.number().int().min(0).max(10_000);
const providerIdSchema = z.number().int().safe().positive();
const providerReferenceTextSchema = z.string().trim().min(1).max(160)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Reference contains control characters.');

/** Adds a field-local validation issue without leaking implementation errors to callers. */
function issue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

const settingsSchema = z.object({
  globalDesiredState: z.enum(WALLET_DESIRED_STATES),
  catalogueMode: z.enum(['ALL', 'RELEVANT']),
  reconciliationIncludeTreasury: z.boolean(),
  reconciliationIncludeCollection: z.boolean(),
  reconciliationAlertPercent: z.string().transform((value, ctx) => {
    try {
      return normalizeReconciliationAlertPercent(value).reconciliationAlertPercent;
    } catch {
      issue(ctx, [], 'Invalid reconciliation alert threshold.');
      return z.NEVER;
    }
  }),
  reconciliationAlertBasis: z.enum(WALLET_RECONCILIATION_ALERT_BASES).optional(),
  defaultCurrencyIds: z.array(entityIdSchema).max(10).refine(unique,
    'Default currency ids must be unique.'),
}).strict();

const chainSchema = z.object({
  id: generatedEntityIdSchema,
  providerChainId: providerIdSchema,
  blockchainReference: providerReferenceTextSchema,
  name: z.string().trim().min(1).max(128),
  shortName: identitySchema,
  isEvm: z.boolean(),
  logoObjectKey: z.string().trim().min(1).max(255).optional(),
  availableFor: z.enum(WALLET_AVAILABILITIES),
  desiredState: z.enum(WALLET_DESIRED_STATES).optional().default('OFF'),
}).strict();

const bindingSchema = z.object({
  id: generatedEntityIdSchema,
  chainId: entityIdSchema,
  providerCoinId: providerIdSchema,
  blockchainReference: providerReferenceTextSchema,
  isToken: z.boolean(),
  tokenContractAddress: z.string().trim().min(1).max(256).optional(),
  blockchainPrecision: z.number().int().min(0).max(18),
  desiredState: z.enum(WALLET_DESIRED_STATES).optional().default('OFF'),
  hotWalletAddresses: addressListSchema,
  coldWalletAddresses: addressListSchema,
  stakingWalletAddresses: addressListSchema,
}).strict().superRefine((binding, ctx) => {
  if (binding.isToken !== (binding.tokenContractAddress !== undefined)) {
    issue(ctx, ['tokenContractAddress'], 'Tokens require a contract address and native bindings forbid one.');
  }
  if (binding.isToken && binding.stakingWalletAddresses.length !== 0) {
    issue(ctx, ['stakingWalletAddresses'], 'Token bindings cannot have staking addresses.');
  }
});

const providerReferenceSchema = z.object({
  provider: z.enum(WALLET_PRICE_PROVIDERS),
  providerAssetId: providerReferenceTextSchema,
  providerSymbol: identitySchema,
  network: z.string().trim().min(1).max(64).optional(),
  address: z.string().trim().min(1).max(256).optional(),
}).strict();

const currencySchema = z.object({
  id: generatedEntityIdSchema,
  symbol: identitySchema,
  name: z.string().trim().min(1).max(128),
  providerRefs: z.array(providerReferenceSchema).max(WALLET_PRICE_PROVIDERS.length),
  binanceReference: z.string().trim().min(1).max(64).optional(),
  logoObjectKey: z.string().trim().min(1).max(255).optional(),
  viewEnabled: z.boolean(),
  geoCountryDeny: z.array(z.string().regex(/^[A-Z]{2}$/)).max(249),
  geoContinentDeny: z.array(z.enum(CONTINENTS)).max(CONTINENTS.length),
  accessLevel: z.enum(WALLET_ACCESS_LEVELS),
  availableFor: z.enum(WALLET_AVAILABILITIES),
  listingKind: z.enum(['PERMANENT', 'TIME_LIMITED']),
  listingStartsAt: instantSchema.optional(),
  showBeforeListing: z.boolean(),
  premiumEarlyAccessAt: instantSchema.optional(),
  premiumOperations: operationListSchema,
  soEarlyAccessAt: instantSchema.optional(),
  soOperations: operationListSchema,
  delistAt: instantSchema.optional(),
  afterDelistMode: z.enum(['AUTO_EXCHANGE', 'LEAVE']).optional(),
  autoExchangeToCurrencyId: entityIdSchema.optional(),
  autoExchangeFeeBps: feeSchema.optional(),
  leaveDays: z.number().int().positive().optional(),
  afterLeaveMode: z.enum(['LOSS', 'AUTO_EXCHANGE']).optional(),
  afterLeaveAutoExchangeToCurrencyId: entityIdSchema.optional(),
  afterLeaveAutoExchangeFeeBps: feeSchema.optional(),
  postDelistOperations: postDelistOperationListSchema,
  desiredState: z.enum(WALLET_DESIRED_STATES).optional().default('OFF'),
  maintenanceAudiences: z.array(z.enum(['USER', 'SO'])).max(2),
  showBalanceInMaintenance: z.object({ USER: z.boolean(), SO: z.boolean() }).strict(),
  bindings: z.array(bindingSchema).max(100),
}).strict().superRefine((currency, ctx) => {
  for (const [path, values] of [
    ['providerRefs', currency.providerRefs.map((ref) => ref.provider)],
    ['geoCountryDeny', currency.geoCountryDeny],
    ['geoContinentDeny', currency.geoContinentDeny],
    ['premiumOperations', currency.premiumOperations],
    ['soOperations', currency.soOperations],
    ['postDelistOperations', currency.postDelistOperations],
    ['maintenanceAudiences', currency.maintenanceAudiences],
  ] as const) if (!unique(values)) issue(ctx, [path], `${path} values must be unique.`);

  if (currency.desiredState === 'ON') {
    const present = new Set(currency.providerRefs.map((ref) => ref.provider));
    if (currency.providerRefs.length !== WALLET_PRICE_PROVIDERS.length
      || WALLET_PRICE_PROVIDERS.some((provider) => !present.has(provider))) {
      issue(ctx, ['providerRefs'], 'ON crypto requires exactly CoinGecko, Alchemy, and CoinMarketCap references.');
    }
  }
  if (currency.listingKind === 'TIME_LIMITED' && currency.delistAt === undefined) {
    issue(ctx, ['delistAt'], 'TIME_LIMITED listing requires delistAt.');
  }
  if (currency.listingKind === 'PERMANENT' && currency.delistAt !== undefined) {
    issue(ctx, ['delistAt'], 'PERMANENT listing cannot have delistAt.');
  }
  const listing = currency.listingStartsAt === undefined ? null : Date.parse(currency.listingStartsAt);
  const delist = currency.delistAt === undefined ? null : Date.parse(currency.delistAt);
  if (listing !== null && delist !== null && listing >= delist) {
    issue(ctx, ['delistAt'], 'delistAt must be after listingStartsAt.');
  }
  for (const [path, instant, operations] of [
    ['premiumEarlyAccessAt', currency.premiumEarlyAccessAt, currency.premiumOperations],
    ['soEarlyAccessAt', currency.soEarlyAccessAt, currency.soOperations],
  ] as const) {
    if ((instant === undefined) !== (operations.length === 0)) {
      issue(ctx, [path], `${path} and its operations must be configured together.`);
    }
    if (instant !== undefined && (listing === null || Date.parse(instant) > listing)) {
      issue(ctx, [path], `${path} must not be after listingStartsAt.`);
    }
  }
  validateDelistPolicy(currency, ctx);
});

type ParsedCurrency = z.infer<typeof currencySchema>;

function validateDelistPolicy(currency: ParsedCurrency, ctx: z.RefinementCtx): void {
  const auto = currency.autoExchangeToCurrencyId !== undefined || currency.autoExchangeFeeBps !== undefined;
  const leave = currency.leaveDays !== undefined || currency.afterLeaveMode !== undefined
    || currency.afterLeaveAutoExchangeToCurrencyId !== undefined
    || currency.afterLeaveAutoExchangeFeeBps !== undefined;
  if (currency.afterDelistMode === 'AUTO_EXCHANGE') {
    if (currency.autoExchangeToCurrencyId === undefined || currency.autoExchangeFeeBps === undefined) {
      issue(ctx, ['afterDelistMode'], 'AUTO_EXCHANGE requires target and fee.');
    }
    if (leave) issue(ctx, ['leaveDays'], 'AUTO_EXCHANGE cannot contain LEAVE settings.');
  } else if (currency.afterDelistMode === 'LEAVE') {
    if (currency.leaveDays === undefined || currency.afterLeaveMode === undefined) {
      issue(ctx, ['afterDelistMode'], 'LEAVE requires days and an after-leave action.');
    }
    if (auto) issue(ctx, ['autoExchangeToCurrencyId'], 'LEAVE cannot contain immediate exchange settings.');
    const laterAuto = currency.afterLeaveAutoExchangeToCurrencyId !== undefined
      || currency.afterLeaveAutoExchangeFeeBps !== undefined;
    if (currency.afterLeaveMode === 'AUTO_EXCHANGE'
      && (currency.afterLeaveAutoExchangeToCurrencyId === undefined
        || currency.afterLeaveAutoExchangeFeeBps === undefined)) {
      issue(ctx, ['afterLeaveMode'], 'After-leave AUTO_EXCHANGE requires target and fee.');
    }
    if (currency.afterLeaveMode === 'LOSS' && laterAuto) {
      issue(ctx, ['afterLeaveMode'], 'LOSS cannot contain exchange settings.');
    }
  } else if (auto || leave) {
    issue(ctx, ['afterDelistMode'], 'Delist settings require afterDelistMode.');
  }
  if (currency.afterDelistMode !== undefined && currency.delistAt === undefined) {
    issue(ctx, ['afterDelistMode'], 'Delist policy requires delistAt.');
  }
}

const providerPinSchema = z.object({
  subject: z.enum(['CHAIN', 'CURRENCY_CHAIN']),
  subjectId: entityIdSchema,
  pinned: z.boolean(),
}).strict();

const configurationSchema = z.object({
  settings: settingsSchema.optional(),
  chains: z.array(chainSchema).max(100).optional(),
  currencies: z.array(currencySchema).max(10_000).optional(),
  providerPins: z.array(providerPinSchema).max(10_000).optional(),
}).strict().superRefine((config, ctx) => {
  if (Object.values(config).every((value) => value === undefined)) issue(ctx, [], 'Configuration cannot be empty.');
  validateConfigurationIdentities(config, ctx);
});

type ParsedConfiguration = z.infer<typeof configurationSchema>;

/** Enforces cross-entity uniqueness and normalizes custody addresses with chain context. */
function validateConfigurationIdentities(config: ParsedConfiguration, ctx: z.RefinementCtx): void {
  const chains = config.chains ?? [];
  for (const [name, values] of [
    ['chain ids', chains.map((chain) => chain.id)],
    ['provider chain ids', chains.map((chain) => chain.providerChainId)],
    ['chain short names', chains.map((chain) => chain.shortName)],
  ] as const) if (!unique(values)) issue(ctx, ['chains'], `${name} must be unique.`);
  const chainById = new Map(chains.map((chain) => [chain.id, chain]));
  const currencies = config.currencies ?? [];
  if (!unique(currencies.map((currency) => currency.id))) issue(ctx, ['currencies'], 'Currency ids must be unique.');
  if (!unique(currencies.map((currency) => currency.symbol))) {
    issue(ctx, ['currencies'], 'Currency symbols must be unique.');
  }
  const referenceIds = new Set<string>();
  const bindingIds = new Set<string>();
  const bindingKeys = new Set<string>();
  const providerCoinKeys = new Set<string>();
  const nativeChains = new Set<string>();
  for (const [currencyIndex, currency] of currencies.entries()) {
    for (const [refIndex, ref] of currency.providerRefs.entries()) {
      const key = `${ref.provider}:${ref.providerAssetId}`;
      if (referenceIds.has(key)) issue(ctx, ['currencies', currencyIndex, 'providerRefs', refIndex], 'Provider asset ids must be unique.');
      referenceIds.add(key);
    }
    for (const [bindingIndex, binding] of currency.bindings.entries()) {
      if (bindingIds.has(binding.id)) issue(ctx, ['currencies', currencyIndex, 'bindings', bindingIndex, 'id'], 'Binding ids must be unique.');
      bindingIds.add(binding.id);
      const bindingKey = `${currency.id}:${binding.chainId}`;
      if (bindingKeys.has(bindingKey)) issue(ctx, ['currencies', currencyIndex, 'bindings', bindingIndex], 'Currency-chain bindings must be unique.');
      bindingKeys.add(bindingKey);
      const providerKey = `${binding.chainId}:${binding.providerCoinId}`;
      if (providerCoinKeys.has(providerKey)) issue(ctx, ['currencies', currencyIndex, 'bindings', bindingIndex], 'Provider coin ids must be unique per chain.');
      providerCoinKeys.add(providerKey);
      if (!binding.isToken) {
        if (nativeChains.has(binding.chainId)) issue(ctx, ['currencies', currencyIndex, 'bindings', bindingIndex], 'A chain has at most one native binding.');
        nativeChains.add(binding.chainId);
      }
      const chain = chainById.get(binding.chainId);
      if (chain !== undefined) {
        try {
          const addresses = normalizeCustodyAddressLists({ ...binding, isEvm: chain.isEvm });
          Object.assign(binding, addresses);
        } catch (error) {
          issue(ctx, ['currencies', currencyIndex, 'bindings', bindingIndex], (error as Error).message);
        }
      }
    }
  }
  const pins = config.providerPins ?? [];
  if (!unique(pins.map((pin) => `${pin.subject}:${pin.subjectId}`))) {
    issue(ctx, ['providerPins'], 'Provider pins must be unique.');
  }
}

export const walletCorePatchSchema = z.object({
  action: z.enum(WALLET_CONFIG_ACTIONS),
  expectedRevision: z.number().int().safe().nonnegative(),
  reason: z.string().trim().min(1).max(500),
  changelogId: optionalReferenceIdSchema,
  effectiveAt: instantSchema.optional(),
  config: configurationSchema,
}).strict().superRefine((patch, ctx) => {
  if ((patch.action === 'SCHEDULE') !== (patch.effectiveAt !== undefined)) {
    issue(ctx, ['effectiveAt'], 'effectiveAt is required only for SCHEDULE.');
  }
});

const httpReferenceFields = (value: Record<string, unknown>, ctx: z.RefinementCtx,
  fields: readonly (readonly [current: string, internal: string])[]) => {
  for (const [current, internal] of fields) {
    if (!Object.hasOwn(value, current) || Object.hasOwn(value, internal)) {
      issue(ctx, [current], `Expected ${current}.`);
    }
  }
};
const httpChainSchema = z.object({}).passthrough().superRefine((value, ctx) =>
  httpReferenceFields(value, ctx, [['blockchainCatalogueChainId', 'providerChainId'],
    ['blockchainRequestReference', 'blockchainReference']]))
  .transform(({ blockchainCatalogueChainId, blockchainRequestReference, ...chain }) => ({
    ...chain, providerChainId: blockchainCatalogueChainId,
    blockchainReference: blockchainRequestReference,
  }));
const httpBindingSchema = z.object({}).passthrough().superRefine((value, ctx) =>
  httpReferenceFields(value, ctx, [['blockchainCatalogueCoinId', 'providerCoinId'],
    ['blockchainRequestReference', 'blockchainReference']]))
  .transform(({ blockchainCatalogueCoinId, blockchainRequestReference, ...binding }) => ({
    ...binding, providerCoinId: blockchainCatalogueCoinId,
    blockchainReference: blockchainRequestReference,
  }));
const httpCurrencySchema = z.object({ bindings: z.array(httpBindingSchema) }).passthrough()
  .superRefine((value, ctx) => httpReferenceFields(value, ctx,
    [['priceProviderReferences', 'providerRefs']]))
  .transform(({ priceProviderReferences, ...currency }) => ({
    ...currency, providerRefs: priceProviderReferences,
  }));
const httpConfigurationSchema = z.object({
  settings: z.unknown().optional(), chains: z.array(httpChainSchema).optional(),
  currencies: z.array(httpCurrencySchema).optional(), providerPins: z.unknown().optional(),
}).strict();
const publicReferencePath = new Map<string, string>([
  ['providerChainId', 'blockchainCatalogueChainId'],
  ['providerCoinId', 'blockchainCatalogueCoinId'],
  ['blockchainReference', 'blockchainRequestReference'],
  ['providerRefs', 'priceProviderReferences'],
]);
/** Translates only public HTTP reference names before the unchanged internal validator runs. */
export const walletCoreHttpPatchSchema = z.object({
  action: z.unknown(), expectedRevision: z.unknown(), reason: z.unknown(),
  changelogId: z.unknown().optional(), effectiveAt: z.unknown().optional(),
  config: httpConfigurationSchema,
}).strict().transform((value, ctx) => {
  const result = walletCorePatchSchema.safeParse(value);
  if (result.success) return result.data;
  for (const problem of result.error.issues) ctx.addIssue({ ...problem,
    path: problem.path.map((segment) => typeof segment === 'string'
      ? publicReferencePath.get(segment) ?? segment : segment) });
  return z.NEVER;
});

const pageLimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const optionalPageLimitSchema = z.coerce.number().int().min(1).max(100).optional();
const rawCursorSchema = z.string().min(1).max(MAX_WALLET_QUERY_CURSOR_LENGTH);
const searchSchema = z.string().trim().min(1).max(100)
  .refine((value) => !value.includes('\0'), 'Search contains NUL.');
const sortDirectionSchema = z.enum(['asc', 'desc']).default('asc');
const strictBooleanQuerySchema = z.enum(['true', 'false'])
  .transform((value) => value === 'true');
const adminStateSchema = z.enum(['OFF', 'ON', 'MAINTAIN', 'UPCOMING', 'DELISTED']);
const chainStateSchema = z.enum(['OFF', 'ON', 'MAINTAIN']);
const providerStateSchema = z.enum(['ACTIVATED', 'DISABLED', 'MAINTENANCE', 'UNAVAILABLE']);
const queryInstantSchema = z.string().datetime({ offset: false })
  .transform((value) => new Date(value).toISOString());
const providerCatalogueIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n,
    'Provider identifier exceeds signed BIGINT.');

const queryFingerprint = (query: Record<string, unknown>, keys: readonly string[]) =>
  walletQueryFingerprint(Object.fromEntries(keys.map((key) => [key, query[key]])));

export const walletAdminCurrencyPageQuerySchema = z.object({
  search: searchSchema.optional(), state: adminStateSchema.optional(),
  chainId: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
  sortBy: z.enum(['symbol', 'name', 'state']).default('symbol'),
  sortDirection: sortDirectionSchema, cursor: rawCursorSchema.optional(), limit: pageLimitSchema,
  scheduledCursor: rawCursorSchema.optional(), scheduledLimit: optionalPageLimitSchema,
  activeAlertCursor: rawCursorSchema.optional(), activeAlertLimit: optionalPageLimitSchema,
}).strict().superRefine((query, ctx) => {
  if (query.cursor !== undefined && decodeWalletQueryCursor(query.cursor, 'CURRENCY',
    queryFingerprint(query, ['search', 'state', 'chainId', 'sortBy', 'sortDirection']), 2) === null) {
    issue(ctx, ['cursor'], 'Invalid currency cursor.');
  }
  if (query.scheduledCursor !== undefined && decodeWalletQueryCursor(query.scheduledCursor,
    'CONFIGURATION', walletQueryFingerprint({ sortBy: 'effectiveAt', sortDirection: 'asc' }), 2) === null) {
    issue(ctx, ['scheduledCursor'], 'Invalid scheduled configuration cursor.');
  }
  if (query.activeAlertCursor !== undefined && decodeWalletQueryCursor(query.activeAlertCursor,
    'ALERT', walletQueryFingerprint({ sortBy: 'category,currencyId', sortDirection: 'asc' }), 3) === null) {
    issue(ctx, ['activeAlertCursor'], 'Invalid active alert cursor.');
  }
});

export const walletAdminChainPageQuerySchema = z.object({
  search: searchSchema.optional(), state: chainStateSchema.optional(),
  isEvm: strictBooleanQuerySchema.optional(),
  sortBy: z.enum(['shortName', 'name', 'state']).default('shortName'),
  sortDirection: sortDirectionSchema, cursor: rawCursorSchema.optional(), limit: pageLimitSchema,
}).strict().superRefine((query, ctx) => {
  if (query.cursor !== undefined && decodeWalletQueryCursor(query.cursor, 'CHAIN',
    queryFingerprint(query, ['search', 'state', 'isEvm', 'sortBy', 'sortDirection']), 2) === null) {
    issue(ctx, ['cursor'], 'Invalid chain cursor.');
  }
});

export const walletProviderCataloguePageQuerySchema = z.object({
  blockchainCatalogueChainId: providerCatalogueIdSchema.optional(),
  search: searchSchema.optional(), providerState: providerStateSchema.optional(),
  isBaseCurrency: strictBooleanQuerySchema.optional(), isStake: strictBooleanQuerySchema.optional(),
  sortBy: z.enum(['blockchainCatalogueChainId', 'blockchainCatalogueCoinId',
    'name', 'shortName', 'currencyName']).optional(),
  sortDirection: sortDirectionSchema, cursor: rawCursorSchema.optional(), limit: pageLimitSchema,
}).strict().transform(({ blockchainCatalogueChainId, sortBy, ...query }) => ({ ...query,
  ...(blockchainCatalogueChainId === undefined ? {} : { providerChainId: blockchainCatalogueChainId }),
  sortBy: (sortBy === undefined
    ? (blockchainCatalogueChainId === undefined ? 'providerChainId' : 'providerCoinId')
    : sortBy === 'blockchainCatalogueChainId' ? 'providerChainId'
    : sortBy === 'blockchainCatalogueCoinId' ? 'providerCoinId' : sortBy) as
      'providerChainId' | 'providerCoinId' | 'name' | 'shortName' | 'currencyName' }))
  .superRefine((query, ctx) => {
  const chainVariant = query.providerChainId === undefined;
  if (chainVariant && (query.isBaseCurrency !== undefined || query.isStake !== undefined
    || !['providerChainId', 'name', 'shortName'].includes(query.sortBy))) {
    issue(ctx, ['sortBy'], 'Invalid provider chain catalogue query.');
  }
  if (!chainVariant && !['providerCoinId', 'currencyName'].includes(query.sortBy)) {
    issue(ctx, ['sortBy'], 'Invalid provider coin catalogue query.');
  }
  if (query.cursor === undefined) return;
  const keys = chainVariant
    ? ['search', 'providerState', 'sortBy', 'sortDirection']
    : ['providerChainId', 'search', 'providerState', 'isBaseCurrency', 'isStake',
      'sortBy', 'sortDirection'];
  if (decodeWalletQueryCursor(query.cursor, chainVariant ? 'PROVIDER_CHAIN' : 'PROVIDER_COIN',
    queryFingerprint(query, keys), chainVariant ? 3 : 4) === null) {
    issue(ctx, ['cursor'], 'Invalid provider catalogue cursor.');
  }
});

export const walletProviderCatalogueCoinsPageQuerySchema = z.object({
  blockchainCatalogueChainId: providerCatalogueIdSchema.optional(), search: searchSchema.optional(),
  providerState: providerStateSchema.optional(), isBaseCurrency: strictBooleanQuerySchema.optional(),
  isStake: strictBooleanQuerySchema.optional(),
  sortBy: z.enum(['blockchainCatalogueCoinId', 'currencyName']).optional(),
  sortDirection: sortDirectionSchema, cursor: rawCursorSchema.optional(), limit: pageLimitSchema,
}).strict().transform(({ blockchainCatalogueChainId, sortBy, ...query }) => ({ ...query,
  ...(blockchainCatalogueChainId === undefined ? {} : { providerChainId: blockchainCatalogueChainId }),
  ...(sortBy === undefined ? {} : { sortBy: sortBy === 'blockchainCatalogueCoinId'
    ? 'providerCoinId' as const : sortBy }),
})).superRefine((query, ctx) => {
  const cursorContext = { ...query, sortBy: query.sortBy ?? 'providerChainId' };
  if (query.cursor !== undefined && decodeWalletQueryCursor(query.cursor, 'PROVIDER_COIN',
    queryFingerprint(cursorContext, ['providerChainId', 'search', 'providerState', 'isBaseCurrency',
      'isStake', 'sortBy', 'sortDirection']), 4) === null) {
    issue(ctx, ['cursor'], 'Invalid provider coin catalogue cursor.');
  }
});

export const walletProviderCatalogueRefreshInputSchema = z.object({
  query: z.object({}).strict(),
  body: z.object({}).strict().optional(),
}).strict();

export const walletAdminHistoryPageQuerySchema = z.object({
  eventType: z.enum(['CHAIN.STATUS_CHANGED', 'CURRENCY.STATUS_CHANGED',
    'PROVIDER_MAINTENANCE.ENTERED', 'PROVIDER_MAINTENANCE.RECOVERED',
    'PROVIDER_MAINTENANCE.PINNED', 'PROVIDER_MAINTENANCE.UNPINNED']).optional(),
  currencyId: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
  actorId: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED', 'ACTIVE', 'CLEARED',
    'SUCCESS', 'PARTIAL', 'FAILED', 'RUNNING', 'COMPLETED', 'SKIPPED']).optional(),
  from: queryInstantSchema.optional(), to: queryInstantSchema.optional(),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  cursor: rawCursorSchema.optional(), limit: pageLimitSchema,
}).strict().superRefine((query, ctx) => {
  if (query.from !== undefined && query.to !== undefined
    && Date.parse(query.from) >= Date.parse(query.to)) issue(ctx, ['to'], 'to must be after from.');
  if (query.cursor !== undefined && decodeWalletQueryCursor(query.cursor, 'HISTORY',
    queryFingerprint(query, ['eventType', 'currencyId', 'actorId', 'status', 'from', 'to',
      'sortDirection']), 2) === null) issue(ctx, ['cursor'], 'Invalid Wallet history cursor.');
});

export type ParsedWalletCorePatch = z.infer<typeof walletCorePatchSchema>;
