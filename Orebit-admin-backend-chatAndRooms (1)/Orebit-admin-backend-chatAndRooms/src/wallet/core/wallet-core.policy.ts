import type {
  NormalizedCustodyAddressLists,
  WalletDesiredState,
  WalletEffectiveState,
  WalletPriceReadiness,
  ProviderMaintenanceObservationInput,
  ProviderMaintenanceObservationResolution,
  WalletPositiveSkippedBucketCount,
  WalletProviderState,
} from './wallet-core.types.js';
import { walletPositiveSkippedBucketCount } from './wallet-core.types.js';

const THRESHOLD = /^(0|[1-9]\d*)(?:\.(\d{1,3}))?$/;
const DECIMAL = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const ADDRESS_LIMIT = 10_000;
const PROVIDER_CATCHUP_LIMIT = 288;

function truncateDecimalTowardZero(value: string, fractionalDigits: number): string {
  const match = DECIMAL.exec(value);
  if (match === null) throw new TypeError('Invalid decimal value.');
  const whole = match[2] as string;
  const fraction = (match[3] ?? '').slice(0, fractionalDigits).replace(/0+$/, '');
  const magnitude = fraction === '' ? whole : `${whole}.${fraction}`;
  return match[1] === '-' && /[1-9]/.test(magnitude) ? `-${magnitude}` : magnitude;
}

/** Formats API/view fiat values only; stored exact decimals remain unchanged. */
export const truncateApiFiat = (value: string): string => truncateDecimalTowardZero(value, 2);
/** Formats API/view cryptocurrency values only; stored exact decimals remain unchanged. */
export const truncateApiCrypto = (value: string): string => truncateDecimalTowardZero(value, 8);
/** Formats API/view percentage values only; stored exact decimals remain unchanged. */
export const truncateApiPercentage = (value: string): string => truncateDecimalTowardZero(value, 3);

export interface WalletProviderCatchupPlan {
  readonly materializedMissedBucketCount: number;
  readonly truncatedSummary: Readonly<{
    safeErrorCode: 'CATCHUP_TRUNCATED';
    skippedBucketCount: WalletPositiveSkippedBucketCount;
  }> | null;
}

export function planWalletProviderCatchup(missedBucketCount: number): WalletProviderCatchupPlan {
  if (!Number.isSafeInteger(missedBucketCount) || missedBucketCount < 0) {
    throw new TypeError('Invalid missed bucket count.');
  }
  const materializedMissedBucketCount = Math.min(missedBucketCount, PROVIDER_CATCHUP_LIMIT);
  const truncated = missedBucketCount - materializedMissedBucketCount;
  return Object.freeze({
    materializedMissedBucketCount,
    truncatedSummary: truncated === 0 ? null : Object.freeze({
      safeErrorCode: 'CATCHUP_TRUNCATED' as const,
      skippedBucketCount: walletPositiveSkippedBucketCount(truncated),
    }),
  });
}

/** Applies the three-failure maintenance rule and emits only real active/inactive transitions. */
export function resolveProviderMaintenanceObservation(
  input: ProviderMaintenanceObservationInput,
): ProviderMaintenanceObservationResolution {
  if (!Number.isSafeInteger(input.failureStreak)
    || input.failureStreak < 0 || input.failureStreak > 3) {
    throw new TypeError('Invalid provider failure streak.');
  }
  const failureStreak = input.outcome === 'FAILED' ? Math.min(3, input.failureStreak + 1) : 0;
  const providerState = input.outcome === 'FAILED'
    ? input.previousProviderState === 'ACTIVATED' && failureStreak === 3
      ? 'UNAVAILABLE' : input.previousProviderState
    : input.outcome;
  const wasActive = input.previousProviderState === 'ACTIVATED';
  const isActive = providerState === 'ACTIVATED';
  const transition = wasActive === isActive ? null : isActive ? 'RECOVERED' : 'ENTERED';
  const effectiveState = input.desiredState === 'OFF' ? 'OFF'
    : input.desiredState === 'MAINTAIN' || input.maintenancePinned || !isActive ? 'MAINTAIN' : 'ON';
  return Object.freeze({
    providerState, failureStreak, effectiveState, transition,
    outboxEvent: transition === null ? null
      : `WALLET_PROVIDER_MAINTENANCE_${transition}` as const,
  });
}

function nonNegativeDecimal(value: string): readonly [units: bigint, scale: bigint] {
  const match = DECIMAL.exec(value);
  if (match === null || match[1] === '-') throw new TypeError('Invalid decimal value.');
  const fraction = match[3] ?? '';
  return [BigInt((match[2] as string) + fraction), BigInt(fraction.length)];
}

/** Derives a view-only percentage, truncated to three places; exact inputs are never modified. */
export function formatReconciliationPercentage(
  numerator: string,
  denominator: string,
): string | null {
  const [numeratorUnits, numeratorScale] = nonNegativeDecimal(numerator);
  const [denominatorUnits, denominatorScale] = nonNegativeDecimal(denominator);
  if (denominatorUnits === 0n) return null;
  const milliPercent = numeratorUnits * 100_000n * (10n ** denominatorScale)
    / (denominatorUnits * (10n ** numeratorScale));
  const whole = milliPercent / 1000n;
  const fraction = (milliPercent % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

export interface NormalizedReconciliationThreshold {
  readonly reconciliationAlertPercent: string;
  readonly thresholdMilliPercent: number;
}

/** Canonicalizes the configured threshold and provides exact thousandths for integer comparison. */
export function normalizeReconciliationAlertPercent(
  value: string,
): NormalizedReconciliationThreshold {
  const match = THRESHOLD.exec(value);
  if (match === null) throw new TypeError('Invalid reconciliation alert threshold.');
  const whole = Number(match[1]);
  const fraction = match[2] ?? '';
  const milli = whole * 1000 + Number(fraction.padEnd(3, '0'));
  if (milli > 50_000) throw new TypeError('Invalid reconciliation alert threshold.');
  const canonicalFraction = fraction.replace(/0+$/, '');
  return {
    reconciliationAlertPercent: canonicalFraction === '' ? String(whole) : `${whole}.${canonicalFraction}`,
    thresholdMilliPercent: milli,
  };
}

export interface CustodyAddressListsInput {
  readonly isEvm: boolean;
  readonly isToken: boolean;
  readonly hotWalletAddresses: readonly string[];
  readonly coldWalletAddresses: readonly string[];
  readonly stakingWalletAddresses: readonly string[];
}

/** Normalizes address identity and prevents overlapping hot/cold custody assignments. */
export function normalizeCustodyAddressLists(
  input: CustodyAddressListsInput,
): NormalizedCustodyAddressLists {
  const normalizeList = (kind: string, values: readonly string[]) => {
    if (values.length > ADDRESS_LIMIT) throw new TypeError(`${kind} accepts at most 10,000 addresses.`);
    const normalized = values.map((value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > 256) throw new TypeError(`Invalid ${kind} address.`);
      return trimmed;
    });
    const identities = normalized.map((value) => input.isEvm ? value.toLowerCase() : value);
    if (new Set(identities).size !== identities.length) throw new TypeError(`${kind} addresses must be unique.`);
    return { normalized, identities };
  };
  const hot = normalizeList('HOT', input.hotWalletAddresses);
  const cold = normalizeList('COLD', input.coldWalletAddresses);
  const staking = normalizeList('STAKING', input.stakingWalletAddresses);
  if (input.isToken && staking.normalized.length !== 0) {
    throw new TypeError('Token bindings cannot have staking addresses.');
  }
  const hotIds = new Set(hot.identities);
  if (cold.identities.some((value) => hotIds.has(value))) {
    throw new TypeError('HOT and COLD addresses must be disjoint.');
  }
  return {
    hotWalletAddresses: hot.normalized,
    coldWalletAddresses: cold.normalized,
    stakingWalletAddresses: staking.normalized,
  };
}

/** Returns the first non-ON gate in Global -> Chain -> Currency -> Binding order. */
export function selectDesiredState(
  states: readonly [WalletDesiredState, WalletDesiredState, WalletDesiredState, WalletDesiredState],
): WalletDesiredState {
  return states.find((state) => state !== 'ON') ?? 'ON';
}

export interface EffectiveStateInput {
  readonly completedDelist: boolean;
  readonly globalDesiredState: WalletDesiredState;
  readonly chainDesiredState: WalletDesiredState;
  readonly currencyDesiredState: WalletDesiredState;
  readonly bindingDesiredState: WalletDesiredState;
  readonly listingState: 'LISTED' | 'UPCOMING_VISIBLE' | 'UPCOMING_HIDDEN';
  readonly providerState: WalletProviderState;
  readonly providerPinned: boolean;
  readonly priceReadiness: WalletPriceReadiness;
}

/** Resolves configured, listing, provider, and price gates into the state shown to operators. */
export function resolveWalletEffectiveState(input: EffectiveStateInput): WalletEffectiveState {
  if (input.completedDelist) return 'DELISTED';
  const desired = selectDesiredState([
    input.globalDesiredState, input.chainDesiredState,
    input.currencyDesiredState, input.bindingDesiredState,
  ]);
  if (desired === 'OFF') return 'OFF';
  if (input.listingState === 'UPCOMING_VISIBLE') return 'UPCOMING';
  if (input.listingState === 'UPCOMING_HIDDEN') return 'OFF';
  if (desired === 'MAINTAIN' || input.providerPinned
    || input.providerState !== 'ACTIVATED' || input.priceReadiness !== 'HEALTHY') return 'MAINTAIN';
  return 'ON';
}
