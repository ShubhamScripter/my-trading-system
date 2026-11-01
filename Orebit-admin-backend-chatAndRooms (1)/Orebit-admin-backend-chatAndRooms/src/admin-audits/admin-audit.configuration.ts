import type { AdminAuditJson } from './admin-audit.types.js';

type Rule = Readonly<{ type: 'object' | 'array' | 'string' | 'number' | 'boolean'; fields?: Readonly<Record<string, Rule>>; required?: readonly string[]; items?: Rule; max?: number; min?: number; values?: readonly string[]; pattern?: string; nullable?: boolean }>;
const text = (max: number, pattern?: string): Rule => ({ type: 'string', min: 1, max, ...(pattern ? { pattern } : {}) });
const enumeration = (...values: string[]): Rule => ({ type: 'string', values });
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): Rule => ({ type: 'number', min, max });
const boolean: Rule = { type: 'boolean' };
const array = (items: Rule, max: number): Rule => ({ type: 'array', items, max });
const object = (fields: Record<string, Rule>, required: readonly string[] = []): Rule => ({ type: 'object', fields, required });
const uuid = text(36, '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
const state = enumeration('OFF', 'ON', 'MAINTAIN');
const availability = enumeration('USER', 'MERCHANT', 'BOTH');
const provider = enumeration('COINGECKO', 'ALCHEMY', 'COINMARKETCAP');
const operations = array(enumeration('DEPOSIT', 'WITHDRAW', 'EXCHANGE', 'USER_TRANSFER', 'SEND_API', 'STAKE', 'BANKROLL'), 7);
// Match Wallet's UTC DTO grammar without rounding its accepted fractional precision.
// The existing configuration byte budget bounds long fractions; timestamps remain exact strings.
const instant = text(33554432, "^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-8])))T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]+)?)?Z$");
const addresses = array(text(256), 10000);
const binding = object({ id: uuid, chainId: uuid, providerCoinId: integer(1), blockchainReference: text(160), isToken: boolean, tokenContractAddress: text(256), blockchainPrecision: integer(0, 18), desiredState: state, hotWalletAddresses: addresses, coldWalletAddresses: addresses, stakingWalletAddresses: addresses }, ['chainId','providerCoinId','blockchainReference','isToken','blockchainPrecision','desiredState','hotWalletAddresses','coldWalletAddresses','stakingWalletAddresses']);
const chain = object({ id: uuid, providerChainId: integer(1), blockchainReference: text(160), name: text(128), shortName: text(32), isEvm: boolean, logoObjectKey: text(255), availableFor: availability, desiredState: state }, ['providerChainId','blockchainReference','name','shortName','isEvm','availableFor']);
const currency = object({
  id: uuid, symbol: text(32), name: text(128),
  providerRefs: array(object({ provider, providerAssetId: text(160), providerSymbol: text(32), network: text(64), address: text(256) }, ['provider','providerAssetId','providerSymbol']), 3),
  binanceReference: text(64), logoObjectKey: text(255), viewEnabled: boolean,
  geoCountryDeny: array(text(2, '^[A-Z]{2}$'), 249), geoContinentDeny: array(enumeration('AF','AN','AS','EU','NA','OC','SA'), 7),
  accessLevel: enumeration('ALL','KYC_L1','KYC_L2'), availableFor: availability, listingKind: enumeration('PERMANENT','TIME_LIMITED'),
  listingStartsAt: instant, showBeforeListing: boolean, premiumEarlyAccessAt: instant, premiumOperations: operations, soEarlyAccessAt: instant, soOperations: operations,
  delistAt: instant, afterDelistMode: enumeration('AUTO_EXCHANGE','LEAVE'), autoExchangeToCurrencyId: uuid, autoExchangeFeeBps: integer(0,10000), leaveDays: integer(1),
  afterLeaveMode: enumeration('LOSS','AUTO_EXCHANGE'), afterLeaveAutoExchangeToCurrencyId: uuid, afterLeaveAutoExchangeFeeBps: integer(0,10000),
  postDelistOperations: array(enumeration('WITHDRAW','EXCHANGE'),2), desiredState: state, maintenanceAudiences: array(enumeration('USER','SO'),2),
  showBalanceInMaintenance: object({ USER: boolean, SO: boolean }, ['USER','SO']), bindings: array(binding,100),
}, ['symbol','name','providerRefs','viewEnabled','geoCountryDeny','geoContinentDeny','accessLevel','availableFor','listingKind','showBeforeListing','premiumOperations','soOperations','postDelistOperations','desiredState','maintenanceAudiences','showBalanceInMaintenance','bindings']);
const wallet = object({
  settings: object({ globalDesiredState: state, catalogueMode: enumeration('ALL','RELEVANT'), reconciliationIncludeTreasury: boolean, reconciliationIncludeCollection: boolean, reconciliationAlertPercent: text(148, '^(0|[1-9][0-9]*)(\\.[0-9]{1,18})?$'), reconciliationAlertBasis: enumeration('SIGNED','POSITIVE_ONLY'), defaultCurrencyIds: array(uuid,10) }, ['globalDesiredState','catalogueMode','reconciliationIncludeTreasury','reconciliationIncludeCollection','reconciliationAlertPercent','defaultCurrencyIds']),
  chains: array(chain,100), currencies: array(currency,10000),
  providerPins: array(object({ subject: enumeration('CHAIN','CURRENCY_CHAIN'), subjectId: uuid, pinned: boolean }, ['subject','subjectId','pinned']),10000),
});
const priceProvider = object({ enabled: boolean, role: { ...enumeration('PRIMARY','COMPARISON','FALLBACK'), nullable: true }, viewEnabled: boolean, refreshIntervalSeconds: integer(1,2147483647) }, ['enabled','role','viewEnabled','refreshIntervalSeconds']);
const price = object({
  divergenceThresholdBps: integer(0,10000),
  visibleFiatCodes: array(enumeration('AED','ARS','AUD','BDT','BHD','BMD','BRL','CAD','CHF','CLP','CNY','CZK','DKK','EUR','GBP','GEL','HKD','HUF','IDR','ILS','INR','JPY','KRW','KWD','LKR','MMK','MXN','MYR','NGN','NOK','NZD','PHP','PKR','PLN','RUB','SAR','SEK','SGD','THB','TRY','TWD','UAH','USD','VND','ZAR'),45),
  providers: object({ COINGECKO: priceProvider, ALCHEMY: priceProvider, COINMARKETCAP: priceProvider }, ['COINGECKO','ALCHEMY','COINMARKETCAP']),
}, ['divergenceThresholdBps','visibleFiatCodes','providers']);

/** Only these business projections may contain nested values; this is not a request-payload logger. */
export const ADMIN_AUDIT_CONFIGURATION_RULES = { WALLET_CORE: { SETTINGS_REVISION: wallet, CHAIN: chain, CURRENCY: currency }, PRICE_CONVERSION: { SETTINGS_REVISION: price } } as const;
const invalid = (): never => { throw new Error('ADMIN_AUDIT_INPUT_INVALID'); };

/** A corrupt scheduled target is identified explicitly, never replaced with unrelated live settings. */
export function hasUnavailablePricingTarget(domain: unknown, action: unknown, before: unknown, after: unknown, metadata: unknown): boolean {
  if (domain !== 'PRICE_CONVERSION' || action !== 'SETTINGS.SCHEDULE_REJECTED') return false;
  const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const meta = record(metadata);
  return record(before).config === null && record(after).config === null
    && meta.safeErrorCode === 'CONFIGURATION_INVALID'
    && typeof meta.configChangeId === 'string' && new RegExp(uuid.pattern!).test(meta.configChangeId.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '').toLowerCase());
}

function validate(value: unknown, rule: Rule, depth = 0): AdminAuditJson {
  if (depth > 8) return invalid();
  if (value === null) return rule.nullable ? null : invalid();
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length > rule.max!) return invalid();
    return Object.freeze(value.map((entry) => validate(entry, rule.items!, depth + 1)));
  }
  if (rule.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid();
    const record = value as Record<string, unknown>;
    if (Object.values(Object.getOwnPropertyDescriptors(record)).some((property) => !Object.hasOwn(property, 'value'))) return invalid();
    if (Object.keys(record).some((key) => !Object.hasOwn(rule.fields!, key)) || rule.required!.some((key) => !Object.hasOwn(record, key))) return invalid();
    return Object.freeze(Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, validate(entry, rule.fields![key]!, depth + 1)])));
  }
  if (typeof value !== rule.type) return invalid();
  if (typeof value === 'string' && (/[\u0000-\u001f\u007f]/.test(value) || (rule.min !== undefined && Array.from(value).length < rule.min) || (rule.max !== undefined && Array.from(value).length > rule.max) || (rule.pattern && !new RegExp(rule.pattern).test(value)) || (rule.values && !rule.values.includes(value)))) return invalid();
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < rule.min! || value > rule.max!)) return invalid();
  return value as string | number | boolean;
}

export function validateAdminAuditConfiguration(value: unknown, domain: string, subject: string): AdminAuditJson {
  const domains = ADMIN_AUDIT_CONFIGURATION_RULES as Readonly<Record<string, Readonly<Record<string, Rule>>>>;
  const rule = domains[domain]?.[subject];
  return rule ? validate(value, rule) : invalid();
}

/** PostgreSQL jsonb text includes a space after every object colon and item separator. */
export function adminAuditJsonbText(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(adminAuditJsonbText).join(', ') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).map(([key, entry]) => JSON.stringify(key) + ': ' + adminAuditJsonbText(entry)).join(', ') + '}';
  const result = JSON.stringify(value);
  if (result === undefined) return invalid();
  return result;
}
