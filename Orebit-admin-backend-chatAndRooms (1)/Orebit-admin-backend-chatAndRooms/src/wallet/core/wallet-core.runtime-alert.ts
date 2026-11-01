import type { AdminWalletAlert } from './wallet-core.admin-view.types.js';

export const DELISTING_SAFE_REASONS = ['PRICE_UNAVAILABLE','EXCHANGE_ADAPTER_UNAVAILABLE',
  'ACCOUNT_REVIEW_REQUIRED','BALANCE_REMAINS','LEDGER_ERROR','AUDIT_ERROR','UNEXPECTED_ERROR','TIMEOUT'] as const;
export type RuntimeAlertPayload =
  | { readonly category: 'PRICE_MAINTENANCE'; readonly currencyId: string;
      readonly observedAt: string; readonly priceReadiness: 'HEALTHY' | 'UNAVAILABLE' }
  | { readonly category: 'DELISTING_PENDING'; readonly executionId: string;
      readonly observedAt: string; readonly safeErrorCode: typeof DELISTING_SAFE_REASONS[number] }
  | { readonly category: 'DELISTING_ACCOUNT_REVIEW'; readonly executionId: string;
      readonly accountId: string; readonly ownerId: string; readonly ownerType: 'USER' | 'MERCHANT';
      readonly bucket: 'AVAILABLE' | 'HOLD' | 'STAKED_FLEXIBLE' | 'STAKED_LOCKED' | 'BANKROLL';
      readonly accountStatus: 'FROZEN' | 'CLOSED'; readonly observedAt: string };
const categories = ['PRICE_MAINTENANCE','DELISTING_PENDING','DELISTING_ACCOUNT_REVIEW','PROVIDER_MAINTENANCE'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/;

/** Bounded runtime evidence is projected explicitly; arbitrary persisted keys never reach Admin. */
export function mapRuntimeAlert(row: Record<string, unknown>): AdminWalletAlert | null {
  if (!categories.includes(String(row.category))) return null;
  const reject = () => { throw new Error('WALLET_ALERT_ROW_INVALID'); };
  const text = (value: unknown): string => typeof value === 'string' ? value : reject();
  const id = (value: unknown) => uuid.test(text(value)) ? text(value) : reject();
  const instant = (value: unknown) => utc.test(text(value)) && Number.isFinite(Date.parse(text(value))) ? text(value) : reject();
  const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
    values.includes(text(value) as T) ? value as T : reject();
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) return reject();
  const payload = row.payload as Record<string, unknown>;
  const keys = (expected: string[]) => {
    if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expected.sort())) reject();
  };
  const common = {id:id(row.id),status:'ACTIVE' as const,
    openedAt:instant(row.opened_at),updatedAt:instant(row.updated_at)};
  const observedAt = instant(payload.observedAt);
  if (row.category === 'PROVIDER_MAINTENANCE') {
    keys(['subjectType','subjectId','providerReference','providerState','failureStreak',
      'maintenancePinned','effectiveState','observedAt']);
    const subjectType = oneOf(payload.subjectType,['CHAIN','CURRENCY_CHAIN']);
    const reference = text(payload.providerReference);
    const pattern = subjectType === 'CHAIN' ? /^CHAIN:([1-9][0-9]{0,18})$/
      : /^CURRENCY_CHAIN:([1-9][0-9]{0,18}):([1-9][0-9]{0,18})$/;
    const match = pattern.exec(reference);
    if (!match || match.slice(1).some(value => BigInt(value) > 9223372036854775807n)
      || typeof payload.failureStreak !== 'number' || ![0,1,2,3].includes(payload.failureStreak)
      || typeof payload.maintenancePinned !== 'boolean') return reject();
    const currencyId = subjectType === 'CHAIN' ? (row.currency_id === null ? null : reject()) : id(row.currency_id);
    return {...common,currencyId,category:'PROVIDER_MAINTENANCE',payload:{subjectType,
      subjectId:id(payload.subjectId),providerReference:reference,observedAt,
      providerState:oneOf(payload.providerState,['ACTIVATED','DISABLED','MAINTENANCE','UNAVAILABLE']),
      failureStreak:payload.failureStreak,maintenancePinned:payload.maintenancePinned,
      effectiveState:oneOf(payload.effectiveState,['OFF','ON','MAINTAIN'])}} as AdminWalletAlert;
  }
  const base = {...common,currencyId:id(row.currency_id)};
  if (row.category === 'PRICE_MAINTENANCE') {
    keys(['currencyId','observedAt','priceReadiness']);
    if (id(payload.currencyId) !== base.currencyId) reject();
    return {...base,category:'PRICE_MAINTENANCE',payload:{currencyId:base.currencyId,observedAt,
      priceReadiness:oneOf(payload.priceReadiness,['HEALTHY','UNAVAILABLE'])}};
  }
  const executionId = id(payload.executionId);
  if (row.category === 'DELISTING_PENDING') {
    keys(['executionId','observedAt','safeErrorCode']);
    return {...base,category:'DELISTING_PENDING',payload:{executionId,observedAt,
      safeErrorCode:oneOf(payload.safeErrorCode,DELISTING_SAFE_REASONS)}};
  }
  keys(['executionId','observedAt','accountId','ownerId','ownerType','bucket','accountStatus']);
  return {...base,category:'DELISTING_ACCOUNT_REVIEW',payload:{executionId,observedAt,
    accountId:id(payload.accountId),ownerId:id(payload.ownerId),ownerType:oneOf(payload.ownerType,['USER','MERCHANT']),
    bucket:oneOf(payload.bucket,['AVAILABLE','HOLD','STAKED_FLEXIBLE','STAKED_LOCKED','BANKROLL']),
    accountStatus:oneOf(payload.accountStatus,['FROZEN','CLOSED'])}};
}
