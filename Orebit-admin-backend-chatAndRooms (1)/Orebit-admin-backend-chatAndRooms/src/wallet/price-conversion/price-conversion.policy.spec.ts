import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function policyModule(): Promise<Record<string, unknown> | undefined> {
  const path = './price-conversion.policy.js';
  return import(path).catch(() => undefined) as Promise<Record<string, unknown> | undefined>;
}

describe('price-conversion provider policy', () => {
  it('marks a disabled sensitive provider as DEGRADED without request-scoped overrides', async () => {
    const policy = await policyModule();
    assert.ok(policy?.priceRoleConfigurationStatus);
    const status = (policy.priceRoleConfigurationStatus as (providers: readonly unknown[]) => string)([
      { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true },
      { code: 'ALCHEMY', enabled: false, role: null, viewEnabled: false },
      { code: 'COINMARKETCAP', enabled: false, role: null, viewEnabled: false },
    ]);
    assert.equal(status, 'DEGRADED');
  });

  it('serializes the complete stored configuration instead of accepting a provider override at read time', async () => {
    const policy = await policyModule();
    assert.ok(policy?.serializePriceConfiguration);
    const serialize = policy.serializePriceConfiguration as (
      threshold: number,
      providers: readonly unknown[],
      visibleFiatCodes: readonly string[],
    ) => unknown;
    assert.deepEqual(serialize(125, [
      { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
      { code: 'ALCHEMY', enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
      { code: 'COINMARKETCAP', enabled: true, role: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
    ], ['USD']), {
      settings: { divergenceThresholdBps: 125, visibleFiatCodes: ['USD'] },
      providers: {
        COINGECKO: { enabled: true, sensitiveRole: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
        ALCHEMY: { enabled: true, sensitiveRole: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
        COINMARKETCAP: { enabled: true, sensitiveRole: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
      },
    });
  });
});
