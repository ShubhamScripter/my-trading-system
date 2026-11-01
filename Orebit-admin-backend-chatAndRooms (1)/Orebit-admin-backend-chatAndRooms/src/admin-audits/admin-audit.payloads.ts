import { isIP } from 'node:net';
import { adminAuditJsonbText, validateAdminAuditConfiguration, hasUnavailablePricingTarget } from './admin-audit.configuration.js';
import { PRICE_CONVERSION_ADMIN_AUDIT_ACTIONS, type PriceConversionAdminAuditInput, type AdminAuditJson } from './admin-audit.types.js';

import { DEPOSIT_ADMIN_AUDIT_ACTIONS, type AdminAuditActor, type DepositAdminAuditInput, WALLET_CORE_ADMIN_AUDIT_ACTIONS, type WalletCoreAdminAuditInput } from './admin-audit.types.js';

declare const preparedEvent: unique symbol;
type PreparedAdminAuditEvent = Readonly<{
  readonly domain: 'WALLET_CORE' | 'DEPOSIT' | 'PRICE_CONVERSION';
  readonly action: string;
  readonly eventKey: string;
  readonly actor: AdminAuditActor;
  readonly subject: Readonly<{ readonly type: string; readonly id: string }>;
  readonly reason: string;
  readonly before: Readonly<Record<string, AdminAuditJson>> | null;
  readonly after: Readonly<Record<string, AdminAuditJson>> | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly [preparedEvent]: true;
}>;

type Scalar = string | number | boolean | null;
type SchemaConstraints = Readonly<{
  reason?: string;
  requiredBefore?: readonly string[];
  requiredAfter?: readonly string[];
  fixedBefore?: Readonly<Record<string, Scalar>>;
  fixedAfter?: Readonly<Record<string, Scalar>>;
  equalAfter?: readonly (readonly [string, string])[];
}>;
type Schema = Readonly<{
  subject: readonly string[];
  state: readonly string[];
  required: readonly string[];
  optional: readonly string[];
  actors: readonly AdminAuditActor['kind'][];
  beforeStatuses?: readonly (string | null)[];
  afterStatuses?: readonly string[];
  constraints?: SchemaConstraints;
}>;
type ScalarValidator = Readonly<{
  family: 'integer' | 'decimal' | 'uuid' | 'boolean' | 'timestamp' | 'enum' | 'context-enum' | 'text';
  nullable: boolean;
  nullableWhen?: Readonly<{
    domain: 'WALLET_CORE' | 'DEPOSIT';
    actions: readonly string[];
    sections: readonly ('before' | 'after' | 'metadata')[];
    key: string;
    equals: Scalar;
    allowInactive?: true;
  }>;
  minimum?: number | string;
  maximum?: number;
  maxIntegerDigits?: number;
  maxFractionDigits?: number;
  maxLength?: number;
  minLength?: number;
  trim?: 'ASCII';
  normalize?: 'lowercase';
  versions?: readonly number[];
  format?: 'CANONICAL_UTC_4_DIGIT';
  fractionalDigits?: readonly number[];
  values?: readonly string[];
  valuesBySubject?: Readonly<Record<string, readonly string[]>>;
}>;
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};
const schema = (subject: readonly string[], state: readonly string[], required: readonly string[], optional: readonly string[], actors: readonly AdminAuditActor['kind'][], beforeStatuses?: readonly (string | null)[], afterStatuses?: readonly string[], constraints?: SchemaConstraints): Schema => ({
  subject,
  state,
  required,
  optional,
  actors,
  ...(beforeStatuses ? { beforeStatuses, afterStatuses } : {}),
  ...(constraints ? { constraints } : {}),
});
const add = (target: Record<string, Schema>, actions: readonly string[], value: Schema): void => {
  for (const action of actions) target[action] = value;
};

const walletSchemas: Record<string, Schema> = {};
const scheduledBusinessActions: readonly string[] = ['CHAIN.UPDATED', 'CHAIN.IMPORTED', 'CURRENCY.UPDATED', 'CURRENCY.IMPORTED', 'PROVIDER_MAINTENANCE.PINNED', 'PROVIDER_MAINTENANCE.UNPINNED'];
const settingsSchema = (before: readonly (string | null)[], after: string, actorKind: AdminAuditActor['kind']): Schema =>
  schema(['SETTINGS_REVISION'], ['revision', 'status', 'effectiveAt'], ['configurationRevision'], ['changelogId', 'safeErrorCode'], [actorKind], before, [after]);
add(walletSchemas, ['SETTINGS.SAVED'], settingsSchema([null], 'DRAFT', 'ADMIN'));
add(walletSchemas, ['SETTINGS.PUSHED'], settingsSchema(['DRAFT'], 'LIVE', 'ADMIN'));
add(walletSchemas, ['SETTINGS.SCHEDULED'], settingsSchema(['DRAFT'], 'SCHEDULED', 'ADMIN'));
add(walletSchemas, ['SETTINGS.SCHEDULE_APPLIED'], settingsSchema(['SCHEDULED'], 'LIVE', 'SYSTEM'));
add(walletSchemas, ['SETTINGS.SCHEDULE_REJECTED'], settingsSchema(['SCHEDULED'], 'REJECTED', 'SYSTEM'));
add(walletSchemas, ['LOGO.UPLOADED'], schema(['LOGO_ASSET'], ['stored', 'mediaType', 'width', 'height', 'bytes'], ['sourceFormat'], [], ['ADMIN'], undefined, undefined, {
  reason: 'wallet-logo-upload', requiredBefore: ['stored'], requiredAfter: ['stored', 'mediaType', 'width', 'height', 'bytes'],
  fixedBefore: { stored: false }, fixedAfter: { stored: true, mediaType: 'image/webp' }, equalAfter: [['width', 'height']],
}));
add(walletSchemas, ['ADMIN_TIMEZONE.UPDATED'], schema(['ADMIN'], ['timezone'], ['configurationRevision'], [], ['ADMIN']));
add(walletSchemas, ['CATALOGUE.REFRESHED'], schema(['PROVIDER_CATALOGUE'], ['revision', 'itemCount'], ['configurationRevision', 'source'], [], ['ADMIN']));
add(
  walletSchemas,
  ['CHAIN.CREATED', 'CHAIN.UPDATED', 'CHAIN.IMPORTED'],
  schema(['CHAIN'], ['name', 'shortName', 'blockchainReference', 'availableFor', 'logoObjectKey'], ['configurationRevision'], ['importCatalogueRevision'], ['ADMIN']),
);
add(
  walletSchemas,
  ['CURRENCY.CREATED', 'CURRENCY.UPDATED', 'CURRENCY.IMPORTED'],
  schema(['CURRENCY'], ['symbol', 'name', 'kind', 'pricingStatus', 'desiredState', 'logoObjectKey'], ['configurationRevision'], ['providerReferenceCount', 'chainBindingCount', 'importCatalogueRevision'], ['ADMIN']),
);
add(walletSchemas, ['PROVIDER_MAINTENANCE.PINNED', 'PROVIDER_MAINTENANCE.UNPINNED'], schema(['CHAIN', 'CURRENCY_CHAIN'], ['maintenancePinned', 'effectiveState'], ['configurationRevision'], [], ['ADMIN']));
add(walletSchemas, ['CHAIN.STATUS_CHANGED'], schema(['CHAIN'], ['desiredState', 'effectiveState', 'maintenancePinned'], ['configurationRevision'], ['scheduledChangeId'], ['ADMIN', 'SYSTEM']));
add(walletSchemas, ['CURRENCY.STATUS_CHANGED'], schema(['CURRENCY', 'CURRENCY_CHAIN'], ['desiredState', 'effectiveState', 'showBalance'], ['configurationRevision'], ['scheduledChangeId'], ['ADMIN', 'SYSTEM']));
add(walletSchemas, ['PROVIDER_MAINTENANCE.ENTERED', 'PROVIDER_MAINTENANCE.RECOVERED'], schema(['CHAIN', 'CURRENCY', 'CURRENCY_CHAIN'], ['effectiveState', 'failureStreak', 'maintenancePinned'], ['configurationRevision', 'providerReference'], [], ['SYSTEM']));
add(walletSchemas, ['PRICE_MAINTENANCE.ENTERED', 'PRICE_MAINTENANCE.RECOVERED'], schema(['CHAIN', 'CURRENCY'], ['effectiveState', 'failureStreak', 'maintenancePinned'], ['configurationRevision', 'providerReference'], [], ['SYSTEM']));
add(walletSchemas, ['RECONCILIATION.COMPLETED'], schema(['RECONCILIATION_RUN'], ['status', 'partial'], ['currencyCount', 'warningCount'], [], ['SYSTEM']));
add(walletSchemas, ['RECONCILIATION.WARNING_RAISED', 'RECONCILIATION.WARNING_CLEARED'], schema(['CURRENCY'], ['active', 'partial', 'shortfallPercent'], ['reconciliationRunId'], [], ['SYSTEM']));
add(walletSchemas, ['DELISTING.FORFEITURE_POSTED'], schema(['LEDGER_JOURNAL'], ['balance'], ['currencyId', 'ownerType', 'ownerId', 'amount'], [], ['SYSTEM']));
for (const action of scheduledBusinessActions) {
  const definition = walletSchemas[action]!;
  walletSchemas[action] = { ...definition, actors: ['ADMIN', 'SYSTEM'], optional: [...definition.optional, 'scheduledChangeId'] };
}

const depositSchemas: Record<string, Schema> = {};
add(depositSchemas, ['SETTINGS.SAVED'], settingsSchema([null], 'DRAFT', 'ADMIN'));
add(depositSchemas, ['SETTINGS.PUSHED'], settingsSchema(['DRAFT'], 'LIVE', 'ADMIN'));
add(depositSchemas, ['SETTINGS.SCHEDULED'], settingsSchema(['DRAFT'], 'SCHEDULED', 'ADMIN'));
add(depositSchemas, ['SETTINGS.SCHEDULE_APPLIED'], settingsSchema(['SCHEDULED'], 'LIVE', 'SYSTEM'));
add(depositSchemas, ['SETTINGS.SCHEDULE_REJECTED'], settingsSchema(['SCHEDULED'], 'REJECTED', 'SYSTEM'));
add(
  depositSchemas,
  ['DEPOSIT.RELEASED', 'DEPOSIT.REJECTED', 'DEPOSIT.CANCELLED', 'DEPOSIT.MAINTENANCE_CANCELLED'],
  schema(['DEPOSIT'], ['status', 'bucket', 'visible'], ['currencyId', 'grossAmount'], ['feeAmount', 'ledgerJournalId', 'priceResolutionId', 'priceSnapshotId', 'priceBasis'], ['ADMIN', 'SYSTEM']),
);
add(depositSchemas, ['DEPOSIT.REVERIFICATION_HELD'], schema(['DEPOSIT'], ['status', 'bucket', 'visible'], ['currencyId', 'grossAmount', 'ledgerJournalId', 'blockerId'], [], ['ADMIN', 'SYSTEM']));
add(
  depositSchemas,
  ['DEPOSIT.CLAWBACK_TO_ZERO_POSTED', 'DEPOSIT.CLAWBACK_NEGATIVE_POSTED'],
  schema(['DEPOSIT'], ['status', 'bucket', 'visible'], ['currencyId', 'ledgerJournalId', 'clawbackAmount'], ['shortfallAmount'], ['ADMIN', 'SYSTEM']),
);
add(depositSchemas, ['DEPOSIT.ACCOUNTING_REVERSAL_POSTED'], schema(['DEPOSIT'], ['status', 'bucket', 'visible'], ['currencyId', 'originalJournalId', 'reversalJournalId'], [], ['ADMIN', 'SYSTEM']));
add(depositSchemas, ['DEPOSIT.STATUS_CHANGED'], schema(['DEPOSIT'], ['status', 'bucket', 'visible'], ['currencyId'], ['ledgerJournalId'], ['ADMIN', 'SYSTEM']));
add(depositSchemas, ['BLOCKER.WAIVED'], schema(['DEPOSIT_BLOCKER'], ['status'], ['depositId', 'blockerKind'], [], ['ADMIN']));
add(
  depositSchemas,
  ['QUARANTINE.RETRIED', 'QUARANTINE.ASSIGNED', 'QUARANTINE.CREDIT_REQUESTED', 'QUARANTINE.RETAINED'],
  schema(['QUARANTINE'], ['status', 'assignedUserId'], ['currencyId', 'grossAmount'], ['depositId', 'ledgerJournalId', 'priceResolutionId', 'priceSnapshotId', 'priceBasis'], ['ADMIN', 'SYSTEM']),
);
add(depositSchemas, ['KILL_SWITCH.ACTIVATED', 'KILL_SWITCH.CLEARED'], schema(['FEATURE_STATE'], ['killed'], ['configurationRevision'], [], ['ADMIN']));
add(depositSchemas, ['BULK_JOB.CREATED', 'BULK_JOB.RESUMED'], schema(['BULK_JOB'], ['status'], ['actionKind', 'totalItems', 'attemptedCount', 'succeededCount', 'failedCount'], ['batchNumber', 'safeErrorCode'], ['ADMIN']));
add(
  depositSchemas,
  ['BULK_JOB.STARTED', 'BULK_JOB.PAUSED', 'BULK_JOB.COMPLETED', 'BULK_JOB.COMPLETED_WITH_FAILURES', 'BULK_JOB.FAILED'],
  schema(['BULK_JOB'], ['status'], ['actionKind', 'totalItems', 'attemptedCount', 'succeededCount', 'failedCount'], ['batchNumber', 'safeErrorCode'], ['SYSTEM']),
);
add(depositSchemas, ['BULK_JOB.ITEM_SUCCEEDED', 'BULK_JOB.ITEM_FAILED'], schema(['BULK_JOB_ITEM'], ['status'], ['bulkJobId', 'depositId', 'attempt'], ['ledgerJournalId', 'safeErrorCode'], ['SYSTEM']));

const priceSchemas: Record<string, Schema> = {};
for (const action of PRICE_CONVERSION_ADMIN_AUDIT_ACTIONS) {
  const base = walletSchemas[action]!;
  priceSchemas[action] = { ...base, optional: ['configChangeId', 'changelog', 'safeErrorCode'],
    beforeStatuses: action === 'SETTINGS.SAVED' ? [null, 'DRAFT', 'LIVE']
      : action === 'SETTINGS.PUSHED' ? ['DRAFT', 'LIVE']
      : action === 'SETTINGS.SCHEDULED' ? ['DRAFT', 'LIVE', 'SCHEDULED'] : base.beforeStatuses };
}

const fail = (): never => {
  throw new Error('ADMIN_AUDIT_INPUT_INVALID');
};
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const asciiTrim = (value: string): string => value.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
const codePoints = (value: string): number => Array.from(value).length;
const nonBlank = (value: unknown, max = 500, min = 1): string => {
  if (typeof value !== 'string' || value.includes('\0')) return fail();
  const trimmed = asciiTrim(value);
  const length = codePoints(trimmed);
  return length >= min && length <= max ? trimmed : fail();
};
const uuid = (value: unknown, v7 = false, versions: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8]): string => {
  const text = nonBlank(value, 36).toLowerCase();
  const version = v7 ? '7' : `[${versions.join('')}]`;
  return new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-${version}[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(text) ? text : fail();
};
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fail();
const decimal = (value: unknown, maxIntegerDigits = 128, maxFractionDigits = 18, minimum = '0'): string =>
  minimum === '0' && typeof value === 'string'
    && new RegExp(`^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${maxFractionDigits}})?$`).test(value)
    && (value.split('.')[0] ?? '').length <= maxIntegerDigits
    ? value
    : fail();
const oneOf = (value: unknown, allowed: readonly string[]): string => (typeof value === 'string' && allowed.includes(value) ? value : fail());
const timestamp = (
  value: unknown,
  format: ScalarValidator['format'] = 'CANONICAL_UTC_4_DIGIT',
  fractionalDigits: readonly number[] = [0, 3],
): string | null => {
  if (value === null) return null;
  if (format !== 'CANONICAL_UTC_4_DIGIT' || fractionalDigits.length !== 2 || fractionalDigits[0] !== 0 || fractionalDigits[1] !== 3) return fail();
  const text = typeof value === 'string' ? value : fail();
  const parsed = new Date(text);
  if (text.startsWith('0000-') || Number.isNaN(parsed.valueOf()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) fail();
  return text === parsed.toISOString() || text === parsed.toISOString().replace('.000', '') ? text : fail();
};
const idKeyList: readonly string[] = [
  'currencyId',
  'ownerId',
  'ledgerJournalId',
  'priceResolutionId',
  'priceSnapshotId',
  'blockerId',
  'originalJournalId',
  'reversalJournalId',
  'depositId',
  'reconciliationRunId',
  'bulkJobId',
  'scheduledChangeId',
  'changelogId',
  'assignedUserId',
];
const intKeyList: readonly string[] = [
  'revision',
  'configurationRevision',
  'importCatalogueRevision',
  'failureStreak',
  'providerReferenceCount',
  'chainBindingCount',
  'itemCount',
  'currencyCount',
  'warningCount',
  'batchNumber',
  'totalItems',
  'attemptedCount',
  'succeededCount',
  'failedCount',
  'attempt',
  'width', 'height', 'bytes',
];
const decimalKeyList: readonly string[] = ['amount', 'balance', 'grossAmount', 'feeAmount', 'clawbackAmount', 'shortfallAmount', 'shortfallPercent'];
const booleanKeyList: readonly string[] = ['maintenancePinned', 'showBalance', 'active', 'partial', 'visible', 'killed', 'stored'];
const scalarValidators: Record<string, ScalarValidator> = {};
const register = (keys: readonly string[], validator: ScalarValidator): void => {
  for (const key of keys) scalarValidators[key] = validator;
};
register(intKeyList.filter((key) => !['width', 'height', 'bytes'].includes(key)), { family: 'integer', nullable: false, minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
register(['width', 'height'], { family: 'integer', nullable: false, minimum: 1, maximum: 500 });
register(['bytes'], { family: 'integer', nullable: false, minimum: 1, maximum: 1_048_576 });
register(decimalKeyList.filter((key) => key !== 'shortfallPercent'), { family: 'decimal', nullable: false, minimum: '0', maxIntegerDigits: 128, maxFractionDigits: 18 });
register(['shortfallPercent'], {
  family: 'decimal', nullable: true, minimum: '0', maxIntegerDigits: 128, maxFractionDigits: 18,
  nullableWhen: {
    domain: 'WALLET_CORE',
    actions: ['RECONCILIATION.WARNING_RAISED', 'RECONCILIATION.WARNING_CLEARED'],
    sections: ['before', 'after'],
    key: 'partial',
    equals: true,
    allowInactive: true,
  },
});
register(idKeyList.filter((key) => key !== 'assignedUserId'), {
  family: 'uuid', nullable: false, versions: [1, 2, 3, 4, 5, 6, 7, 8], trim: 'ASCII', normalize: 'lowercase',
});
register(['assignedUserId'], {
  family: 'uuid', nullable: true, versions: [1, 2, 3, 4, 5, 6, 7, 8], trim: 'ASCII', normalize: 'lowercase',
});
register(['configChangeId'], { family: 'uuid', nullable: false, versions: [1,2,3,4,5,6,7,8], trim: 'ASCII', normalize: 'lowercase' });
register(['changelog'], { family: 'text', nullable: false, minLength: 1, maxLength: 1000, trim: 'ASCII' });
register(booleanKeyList, { family: 'boolean', nullable: false });
register(['effectiveAt'], {
  family: 'timestamp', nullable: true, format: 'CANONICAL_UTC_4_DIGIT', fractionalDigits: [0, 3],
});
register(['status'], {
  family: 'context-enum',
  nullable: false,
  valuesBySubject: {
    SETTINGS_REVISION: ['DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED'],
    DEPOSIT: ['PENDING', 'HELD', 'SUCCESS', 'FAILED', 'REJECTED', 'CANCELLED', 'QUARANTINED', 'RETRY_PENDING'],
    DEPOSIT_BLOCKER: ['PENDING', 'RESOLVED', 'WAIVED'],
    QUARANTINE: ['OPEN', 'RETRY_PENDING', 'ASSIGNED', 'RETAINED', 'SETTLED'],
    BULK_JOB: ['PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED'],
    BULK_JOB_ITEM: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'],
    RECONCILIATION_RUN: ['SUCCESS', 'PARTIAL', 'FAILED'],
  },
});
register(['desiredState', 'effectiveState'], {
  family: 'enum', nullable: false, values: ['ON', 'OFF', 'MAINTAIN', 'UPCOMING'],
});
register(['bucket'], {
  family: 'enum', nullable: false, values: ['AVAILABLE', 'HOLD', 'OREBIT_TREASURY', 'OREBIT_COLLECTION'],
});
register(['ownerType'], { family: 'enum', nullable: false, values: ['USER', 'MERCHANT'] });
register(['priceBasis'], { family: 'enum', nullable: false, values: ['WEBHOOK_TIME', 'ADMIN_CREDIT_TIME'] });
register(['kind'], { family: 'enum', nullable: false, values: ['CRYPTO', 'FIAT'] });
register(['pricingStatus'], { family: 'enum', nullable: false, values: ['ACTIVE', 'DISABLED'] });
register(['availableFor'], { family: 'enum', nullable: false, values: ['USER', 'MERCHANT', 'BOTH'] });
register(['source'], { family: 'enum', nullable: false, values: ['BLOCKCHAIN'] });
register(['sourceFormat'], { family: 'enum', nullable: false, values: ['PNG', 'JPEG', 'WEBP', 'AVIF'] });
register(['mediaType'], { family: 'enum', nullable: false, values: ['image/webp'] });
register(['actionKind'], {
  family: 'enum',
  nullable: false,
  values: ['RELEASE', 'REJECT', 'MAINTENANCE_RELEASE', 'MAINTENANCE_CANCEL', 'REVERIFICATION_HOLD', 'CLAWBACK_TO_ZERO', 'CLAWBACK_NEGATIVE', 'WAIT_FOR_SETTLEMENT', 'SCHEDULED_STATE_TRANSITION'],
});
for (const [key, maxLength] of Object.entries({
  name: 128,
  shortName: 64,
  blockchainReference: 160,
  logoObjectKey: 255,
  timezone: 64,
  symbol: 32,
  providerReference: 160,
  blockerKind: 64,
  safeErrorCode: 64,
})) register([key], { family: 'text', nullable: false, minLength: 1, maxLength, trim: 'ASCII' });
deepFreeze(scalarValidators);

function valueFor(key: string, value: unknown, subject: string): Scalar {
  const validator = scalarValidators[key] ?? fail();
  if (value === null) return validator.nullable ? null : fail();
  if (typeof value === 'string' && value.includes('\0')) return fail();
  switch (validator.family) {
    case 'integer':
      return integer(value, Number(validator.minimum), validator.maximum);
    case 'decimal':
      return decimal(value, validator.maxIntegerDigits, validator.maxFractionDigits, String(validator.minimum));
    case 'uuid':
      return uuid(value, false, validator.versions);
    case 'boolean':
      return typeof value === 'boolean' ? value : fail();
    case 'timestamp':
      return timestamp(value, validator.format, validator.fractionalDigits);
    case 'enum':
      return oneOf(value, validator.values ?? []);
    case 'context-enum':
      return oneOf(value, validator.valuesBySubject?.[subject] ?? []);
    case 'text':
      return nonBlank(value, validator.maxLength, validator.minLength);
    default:
      return fail();
  }
}

const jsonbTextBytes = (value: Readonly<Record<string, unknown>>): number => Buffer.byteLength(adminAuditJsonbText(value), 'utf8');

type ValidationContext = Readonly<{
  unavailableTarget?: boolean;
  domain: 'WALLET_CORE' | 'DEPOSIT' | 'PRICE_CONVERSION';
  action: string;
  section: 'before' | 'after' | 'metadata';
}>;
function object(value: unknown, allowed: readonly string[], required: readonly string[], subject: string, context: ValidationContext, metadata = false): Readonly<Record<string, AdminAuditJson>> {
  if (!plain(value)) fail();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const configuration = !metadata && (context.domain === 'PRICE_CONVERSION' ||
    (context.domain === 'WALLET_CORE' && /^(SETTINGS\.|CHAIN\.(CREATED|UPDATED|IMPORTED)$|CURRENCY\.(CREATED|UPDATED|IMPORTED)$)/.test(context.action)));
  const budget = configuration && context.domain === 'WALLET_CORE' && Object.hasOwn(record, 'config') ? 33554432 : 65536;
  // Validate structure before serialization: cycles, getters and arbitrary nested payloads are never serialized.
  if (keys.some((key) => !(configuration && key === 'config') && !allowed.includes(key)) || required.some((key) => !Object.hasOwn(record, key)) || (metadata && keys.some((key) => record[key] === null || record[key] === undefined))) fail();
  if (context.domain === 'PRICE_CONVERSION' && !metadata && !Object.hasOwn(record, 'config')) fail();
  const copy: Record<string, AdminAuditJson> = {};
  for (const key of keys) {
    if (key === 'config' && configuration) { copy[key] = context.unavailableTarget && record[key] === null ? null : validateAdminAuditConfiguration(record[key], context.domain, subject); continue; }
    if (record[key] === undefined) fail();
    const nullableWhen = scalarValidators[key]?.nullableWhen;
    if (record[key] === null && nullableWhen && (
      context.domain !== nullableWhen.domain
      || !nullableWhen.actions.includes(context.action)
      || !nullableWhen.sections.includes(context.section)
      || (record[nullableWhen.key] !== nullableWhen.equals
        && !(nullableWhen.allowInactive && record.active === false))
    )) fail();
    copy[key] = valueFor(key, record[key], subject);
  }
  if (jsonbTextBytes(record) > budget || jsonbTextBytes(copy) > budget) fail();
  return Object.freeze(copy);
}
function actor(value: unknown, allowed: readonly AdminAuditActor['kind'][]): AdminAuditActor {
  if (!plain(value)) fail();
  const record = value as Record<string, unknown>;
  if ((record.kind !== 'ADMIN' && record.kind !== 'SYSTEM') || !allowed.includes(record.kind)) fail();
  if (record.kind === 'SYSTEM') {
    if (Object.keys(record).length !== 2) fail();
    return Object.freeze({ kind: 'SYSTEM' as const, runId: uuid(record.runId) });
  }
  const ipAddress = record.ipAddress;
  if (Object.keys(record).length !== 6 || typeof ipAddress !== 'string' || !isIP(ipAddress) || ipAddress !== ipAddress.trim()) fail();
  return Object.freeze({
    kind: 'ADMIN' as const,
    actorId: uuid(record.actorId),
    sessionId: uuid(record.sessionId),
    requestId: uuid(record.requestId),
    ipAddress: ipAddress as string,
    deviceId: nonBlank(record.deviceId, 128),
  });
}
function ensureParity(actions: readonly string[], schemas: Record<string, Schema>): void {
  if (
    actions.length !== Object.keys(schemas).length
    || actions.some((action) => !(action in schemas))
    || Object.values(schemas).some((entry) =>
      [...entry.state, ...entry.required, ...entry.optional].some((key) => !(key in scalarValidators)))
  ) throw new Error('ADMIN_AUDIT_SCHEMA_PARITY_INVALID');
}
ensureParity(WALLET_CORE_ADMIN_AUDIT_ACTIONS, walletSchemas);
ensureParity(DEPOSIT_ADMIN_AUDIT_ACTIONS, depositSchemas);
ensureParity(PRICE_CONVERSION_ADMIN_AUDIT_ACTIONS, priceSchemas);
const detachedSchema = (source: Record<string, Schema>): Readonly<Record<string, Schema>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(source).map(([action, entry]) => [
        action,
        Object.freeze({
          subject: Object.freeze([...entry.subject]),
          state: Object.freeze([...entry.state]),
          required: Object.freeze([...entry.required]),
          optional: Object.freeze([...entry.optional]),
          actors: Object.freeze([...entry.actors]),
          ...(entry.beforeStatuses ? {
            beforeStatuses: Object.freeze([...entry.beforeStatuses]),
            afterStatuses: Object.freeze([...(entry.afterStatuses ?? [])]),
          } : {}),
          ...(entry.constraints ? { constraints: deepFreeze(structuredClone(entry.constraints)) } : {}),
        }),
      ]),
    ),
  );
export const ADMIN_AUDIT_SCHEMA_DESCRIPTOR = Object.freeze({
  WALLET_CORE: detachedSchema(walletSchemas),
  DEPOSIT: detachedSchema(depositSchemas),
  PRICE_CONVERSION: detachedSchema(priceSchemas),
});
export const ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR: Readonly<Record<string, ScalarValidator>> =
  deepFreeze(structuredClone(scalarValidators));
export const ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES = Object.freeze({
  integer: Object.freeze([...intKeyList]),
  decimal: Object.freeze([...decimalKeyList]),
  uuid: Object.freeze([...idKeyList]),
  boolean: Object.freeze([...booleanKeyList]),
  null: Object.freeze(
    Object.entries(scalarValidators)
      .filter(([, validator]) => validator.nullable)
      .map(([key]) => key),
  ),
});

function build(input: unknown, domain: 'WALLET_CORE' | 'DEPOSIT' | 'PRICE_CONVERSION', schemas: Record<string, Schema>): PreparedAdminAuditEvent {
  if (!plain(input)) fail();
  const record = input as Record<string, unknown>;
  const inputKeys = ['domain', 'action', 'eventKey', 'actor', 'subject', 'reason', 'before', 'after', 'metadata'];
  if (Object.keys(record).some((key) => !inputKeys.includes(key)) || inputKeys.some((key) => !(key in record))) fail();
  const action = record.action;
  if (record.domain !== domain || typeof action !== 'string') fail();
  const actionName = action as string;
  const selectedDefinition = Object.hasOwn(schemas, actionName) ? schemas[actionName] : undefined;
  if (!selectedDefinition) fail();
  const definition = selectedDefinition as Schema;
  const eventKey = nonBlank(record.eventKey, 200);
  const reason = nonBlank(record.reason, 500);
  if (!plain(record.subject)) fail();
  const subject = record.subject as Record<string, unknown>;
  if (Object.keys(subject).length !== 2 || !definition.subject.includes(String(subject.type))) fail();
  const subjectType = typeof subject.type === 'string' ? subject.type : fail();
  const subjectId =
    subjectType === 'SETTINGS_REVISION'
      ? /^(0|[1-9][0-9]*)$/.test(nonBlank(subject.id, 128))
        ? asciiTrim(String(subject.id))
        : fail()
      : subjectType === 'LOGO_ASSET'
        ? /^[0-9a-f]{64}\.webp$/.test(nonBlank(subject.id, 128))
          ? asciiTrim(String(subject.id))
          : fail()
      : subjectType === 'PROVIDER_CATALOGUE'
        ? nonBlank(subject.id, 128) === 'BLOCKCHAIN'
          ? 'BLOCKCHAIN'
          : fail()
        : uuid(subject.id, subjectType !== 'CURRENCY' && subjectType !== 'CURRENCY_CHAIN');
  const unavailableTarget = hasUnavailablePricingTarget(domain,actionName,record.before,record.after,record.metadata);
  const before = record.before === null ? null : object(
    record.before, definition.constraints?.requiredBefore ?? definition.state, definition.constraints?.requiredBefore ?? [], subjectType, { domain, action: actionName, section: 'before', unavailableTarget },
  );
  const after = record.after === null ? null : object(
    record.after, definition.constraints?.requiredAfter ?? definition.state, definition.constraints?.requiredAfter ?? [], subjectType, { domain, action: actionName, section: 'after', unavailableTarget },
  );
  if (definition.beforeStatuses && !definition.beforeStatuses.some((status) => status === (before === null ? null : before.status))) fail();
  if (definition.afterStatuses && !definition.afterStatuses.some((status) => status === after?.status)) fail();
  const constraints = definition.constraints;
  if (constraints?.reason !== undefined && reason !== constraints.reason) fail();
  if ((constraints?.requiredBefore && before === null) || (constraints?.requiredAfter && after === null)) fail();
  for (const [key, value] of Object.entries(constraints?.fixedBefore ?? {})) if (before?.[key] !== value) fail();
  for (const [key, value] of Object.entries(constraints?.fixedAfter ?? {})) if (after?.[key] !== value) fail();
  for (const [left, right] of constraints?.equalAfter ?? []) if (after?.[left] !== after?.[right]) fail();
  const metadata = object(
    record.metadata,
    [...definition.required, ...definition.optional],
    definition.required,
    subjectType,
    { domain, action: actionName, section: 'metadata' },
    true,
  );
  const priceKeys = ['priceBasis', 'priceResolutionId', 'priceSnapshotId'];
  const present = priceKeys.filter((key) => key in metadata);
  if (present.length !== 0 && present.length !== 3) fail();
  const eventActor = actor(record.actor, definition.actors);
  if (domain === 'WALLET_CORE' && scheduledBusinessActions.includes(actionName)
    && eventActor.kind === 'SYSTEM' && !Object.hasOwn(metadata, 'scheduledChangeId')) fail();
  return Object.freeze({
    domain,
    action: actionName,
    eventKey,
    actor: eventActor,
    subject: Object.freeze({ type: subjectType, id: subjectId }),
    reason,
    before,
    after,
    metadata,
  }) as PreparedAdminAuditEvent;
}

export const buildWalletCoreAdminAuditEvent = (input: WalletCoreAdminAuditInput): PreparedAdminAuditEvent => build(input, 'WALLET_CORE', walletSchemas);
export const buildDepositAdminAuditEvent = (input: DepositAdminAuditInput): PreparedAdminAuditEvent => build(input, 'DEPOSIT', depositSchemas);
export const buildPriceConversionAdminAuditEvent = (input: PriceConversionAdminAuditInput): PreparedAdminAuditEvent => build(input, 'PRICE_CONVERSION', priceSchemas);
