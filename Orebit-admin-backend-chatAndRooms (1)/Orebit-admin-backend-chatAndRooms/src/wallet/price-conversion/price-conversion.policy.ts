import { PriceConfigurationValidationError } from './price-conversion.errors.js';
import { persistedPriceConfigurationSchema } from './price-conversion.dto.js';
import {
  PROVIDER_CODES,
  PROVIDER_ROLES,
  FIAT_CODES,
  type FiatCode,
  type ProviderCode,
  type ProviderPatch,
  type ProviderRole,
} from './price-conversion.types.js';
import type { PersistedPriceConfiguration } from './price-conversion.types.js';

/** Stored provider state used to validate one complete configuration revision. */
export interface ProviderState {
  readonly code: ProviderCode;
  readonly enabled: boolean;
  readonly role: ProviderRole | null;
  readonly viewEnabled: boolean;
  readonly refreshIntervalSeconds: number;
}

/** Applies a batch's explicit provider changes without accepting read-time overrides. */
export function mergeProviderStates(
  current: readonly ProviderState[],
  patches: readonly ProviderPatch[],
): ProviderState[] {
  const patchByCode = new Map(patches.map((provider) => [provider.code, provider]));
  return current.map((provider) => {
    const patch = patchByCode.get(provider.code);
    return patch === undefined ? provider : {
      code: patch.code,
      enabled: patch.enabled,
      role: patch.role,
      viewEnabled: patch.viewEnabled,
      refreshIntervalSeconds: patch.refreshIntervalSeconds,
    };
  });
}

/** Rejects unsafe final role/view combinations before the configuration transaction writes them. */
export function validateFinalProviders(providers: readonly ProviderState[]): void {
  if (providers.some((provider) => !Number.isInteger(provider.refreshIntervalSeconds)
    || provider.refreshIntervalSeconds < 1 || provider.refreshIntervalSeconds > 2_147_483_647)) {
    throw new PriceConfigurationValidationError('Provider refresh interval is invalid');
  }
  if (providers.filter((provider) => provider.enabled && provider.role === 'PRIMARY').length !== 1) {
    throw new PriceConfigurationValidationError('Exactly one enabled PRIMARY role is required');
  }
  const assignedRoles = providers
    .filter((provider) => provider.enabled && provider.role !== null)
    .map((provider) => provider.role);
  if (new Set(assignedRoles).size !== assignedRoles.length) {
    throw new PriceConfigurationValidationError('Sensitive roles cannot be assigned more than once');
  }
  if (providers.some((provider) => !provider.enabled && provider.role !== null)) {
    throw new PriceConfigurationValidationError('Disabled providers cannot hold a sensitive role');
  }
  const views = providers.filter((provider) => provider.enabled && provider.viewEnabled);
  if (views.length !== 1) throw new PriceConfigurationValidationError('Exactly one enabled view provider is required');
  const view = views[0];
  if (view === undefined || !['COINGECKO', 'COINMARKETCAP'].includes(view.code)) {
    throw new PriceConfigurationValidationError('View provider must be an enabled view-eligible provider');
  }
  const primary = providers.find((provider) => provider.enabled && provider.role === 'PRIMARY');
  const comparison = providers.find((provider) => provider.enabled && provider.role === 'COMPARISON');
  if (primary !== undefined && comparison !== undefined
    && primary.refreshIntervalSeconds !== comparison.refreshIntervalSeconds) {
    throw new PriceConfigurationValidationError('PRIMARY and COMPARISON refresh intervals must match');
  }
}

/** Reports degraded provider security whenever a sensitive role is absent or duplicated. */
export function priceRoleConfigurationStatus(
  providers: readonly Pick<ProviderState, 'enabled' | 'role'>[],
): 'HEALTHY' | 'DEGRADED' {
  return PROVIDER_ROLES.every((role) =>
    providers.filter((provider) => provider.enabled && provider.role === role).length === 1,
  ) ? 'HEALTHY' : 'DEGRADED';
}

/** Serializes the complete audited configuration payload for drafts, PUSH, and SCHEDULE. */
export function serializePriceConfiguration(
  divergenceThresholdBps: number,
  providers: readonly ProviderState[],
  visibleFiatCodes: readonly FiatCode[],
): PersistedPriceConfiguration {
  const byCode = new Map(providers.map((provider) => [provider.code, provider]));
  const provider = (code: ProviderCode) => {
    const value = byCode.get(code);
    if (value === undefined) throw new PriceConfigurationValidationError(`Missing ${code} provider configuration`);
    return {
      enabled: value.enabled,
      sensitiveRole: value.role,
      viewEnabled: value.viewEnabled,
      refreshIntervalSeconds: value.refreshIntervalSeconds,
    };
  };
  return {
    settings: {
      divergenceThresholdBps,
      visibleFiatCodes: FIAT_CODES.filter((code) => visibleFiatCodes.includes(code)),
    },
    providers: {
      COINGECKO: provider('COINGECKO'),
      ALCHEMY: provider('ALCHEMY'),
      COINMARKETCAP: provider('COINMARKETCAP'),
    },
  };
}

/** Restores stored draft provider rows so the writer can revalidate them before applying. */
export function persistedProviderStates(
  config: PersistedPriceConfiguration,
  current: readonly ProviderState[],
): ProviderState[] {
  const currentByCode = new Map(current.map((provider) => [provider.code, provider]));
  return PROVIDER_CODES.map((code) => ({
    code,
    enabled: config.providers[code].enabled,
    role: config.providers[code].sensitiveRole,
    viewEnabled: config.providers[code].viewEnabled,
    refreshIntervalSeconds: config.providers[code].refreshIntervalSeconds
      ?? currentByCode.get(code)?.refreshIntervalSeconds
      ?? (() => { throw new PriceConfigurationValidationError(`Missing ${code} refresh interval`); })(),
  }));
}

/** Validates persisted JSON before it can drive an elevated configuration write. */
export function parsePersistedPriceConfiguration(value: unknown): PersistedPriceConfiguration {
  const parsed = persistedPriceConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new PriceConfigurationValidationError('Stored draft configuration is invalid');
  return parsed.data;
}
