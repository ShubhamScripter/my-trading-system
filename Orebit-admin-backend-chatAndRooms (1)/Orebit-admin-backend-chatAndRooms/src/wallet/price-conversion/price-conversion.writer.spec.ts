import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PriceConfigurationValidationError } from './price-conversion.errors.js';
import { parsePersistedPriceConfiguration } from './price-conversion.policy.js';
import { PriceConversionConfigurationWriter } from './price-conversion.configuration-writer.js';
import type { PersistedPriceConfiguration, PriceConversionAuditContext } from './price-conversion.types.js';

const AUDIT: PriceConversionAuditContext = {
  actorId: '01920000-0000-7000-8000-000000000010',
  sessionId: 'session-11',
  requestId: '01920000-0000-7000-8000-000000000012',
  ipAddress: '203.0.113.8',
  deviceId: 'device-13',
};
const GLOBAL_AUDIT = { appendWithTransaction: async () => ({
  id: '01920000-0000-7000-8000-000000000701', replayed: false,
}) };

describe('configuration writer trust-boundary handling', () => {
  for (const input of [
    {
      action: 'PUSH' as const,
      expectedRevision: 5,
      reason: 'No effective change.',
      changelog: 'No effective change.',
    },
    {
      action: 'SAVE_DRAFT' as const,
      expectedRevision: 5,
      reason: 'No effective change.',
      changelog: 'No effective change.',
    },
    {
      action: 'SCHEDULE' as const,
      expectedRevision: 5,
      reason: 'No effective change.',
      changelog: 'No effective change.',
      effectiveAt: '2999-09-10T00:00:00.000Z',
    },
  ]) {
    it(`rejects unchanged ${input.action} before configuration or audit writes`, async () => {
      const client = new UnchangedClient();
      const writer = new PriceConversionConfigurationWriter({
        priceConversionSchema: 'price_conversion_test',
        connect: async () => client,
      } as never, GLOBAL_AUDIT);

      await assert.rejects(
        () => writer.updateAtomically(input, AUDIT),
        (error: unknown) => error instanceof PriceConfigurationValidationError
          && error.message === 'Price configuration is unchanged',
      );
      assert.equal(client.calls.some((sql) => /^\s*(?:INSERT|UPDATE)\b/.test(sql)), false);
      assert.equal(client.calls.at(-1), 'ROLLBACK');
      assert.equal(client.released, true);
    });
  }

  for (const action of ['SAVE_DRAFT', 'SCHEDULE'] as const) {
    it(`rejects ${action} when it duplicates the existing timeline target`, async () => {
      const target = {
        settings: { divergenceThresholdBps: 333, visibleFiatCodes: ['USD'] as const },
        providers: {
          COINGECKO: { enabled: true, sensitiveRole: 'PRIMARY' as const, viewEnabled: true, refreshIntervalSeconds: 60 },
          ALCHEMY: { enabled: true, sensitiveRole: 'COMPARISON' as const, viewEnabled: false, refreshIntervalSeconds: 60 },
          COINMARKETCAP: { enabled: true, sensitiveRole: 'FALLBACK' as const, viewEnabled: false, refreshIntervalSeconds: 300 },
        },
      };
      const client = new UnchangedClient(target);
      const writer = new PriceConversionConfigurationWriter({
        priceConversionSchema: 'price_conversion_test', connect: async () => client,
      } as never, GLOBAL_AUDIT);
      await assert.rejects(() => writer.updateAtomically({
        action,
        expectedRevision: 5,
        reason: 'Duplicate target.',
        changelog: 'Duplicate target.',
        divergenceThresholdBps: 333,
        visibleFiatCodes: ['USD'],
        ...(action === 'SCHEDULE' ? { effectiveAt: '2999-09-10T00:00:00.000Z' } : {}),
      }, AUDIT), (error: unknown) => error instanceof PriceConfigurationValidationError
        && error.message === 'Price configuration is unchanged');
      assert.equal(client.calls.some((sql) => /^\s*(?:INSERT|UPDATE)\b/.test(sql)), false);
    });
  }

  it('rolls back the configuration and local audit when global audit append fails', async () => {
    const client = new UnchangedClient();
    const auditFailure = new Error('global audit unavailable');
    const writer = new PriceConversionConfigurationWriter({
      priceConversionSchema: 'price_conversion_test', connect: async () => client,
    } as never, { appendWithTransaction: async () => { throw auditFailure; } });

    await assert.rejects(() => writer.updateAtomically({
      action: 'PUSH', expectedRevision: 5, reason: 'Change threshold.',
      changelog: 'Threshold changed.', divergenceThresholdBps: 333,
    }, AUDIT), (error: unknown) => error === auditFailure);
    assert.equal(client.calls.some((sql) => sql.includes('price_admin_audit')), true);
    assert.equal(client.calls.at(-1), 'ROLLBACK');
    assert.equal(client.calls.includes('COMMIT'), false);
  });

  it('parses only provider settings from stored drafts', () => {
    const valid = draftConfiguration();
    assert.deepEqual(parsePersistedPriceConfiguration(valid), valid);
    const invalid: unknown[] = [
      { ...valid, unexpected: true },
      { ...valid, currencyUpserts: [] },
      { ...valid, currencies: [] },
      { ...valid, providerRefs: [] },
      { ...valid, walletPolicy: { desiredState: 'ON' } },
      { ...valid, binanceReference: 'BTCUSDT' },
      { ...valid, settings: { ...valid.settings, visibleFiatCodes: ['USD', 'USD'] } },
      { ...valid, providers: { ...valid.providers,
        COINGECKO: { ...valid.providers.COINGECKO, providerRefs: [] } } },
    ];

    for (const [index, candidate] of invalid.entries()) {
      assert.throws(
        () => parsePersistedPriceConfiguration(candidate),
        (error: unknown) => error instanceof PriceConfigurationValidationError && error.status === 400,
        `candidate ${index} keys: ${Object.keys(candidate as Record<string, unknown>).join(',')}`,
      );
    }
  });

  it('maps expected PostgreSQL configuration constraints to a stable local 400', async () => {
    for (const code of ['23503', '23505', '23514'] as const) {
      const client = new ConstraintClient(code);
      const writer = new PriceConversionConfigurationWriter({
        priceConversionSchema: 'price_conversion_test',
        connect: async () => client,
      } as never, GLOBAL_AUDIT);

      await assert.rejects(() => writer.updateAtomically({
        action: 'PUSH',
        expectedRevision: 5,
        reason: 'Exercise configuration constraint mapping.',
        changelog: 'Constraint mapping.',
      }, AUDIT), (error: unknown) =>
        error instanceof PriceConfigurationValidationError
          && error.status === 400
          && !error.message.includes('database detail'),
      );
      assert.equal(client.released, true);
      assert.equal(client.calls.at(-1), 'ROLLBACK');
    }
  });
});

function draftConfiguration(): PersistedPriceConfiguration {
  return {
    settings: { divergenceThresholdBps: 125 },
    providers: {
      COINGECKO: { enabled: true, sensitiveRole: 'PRIMARY', viewEnabled: true },
      ALCHEMY: { enabled: true, sensitiveRole: 'COMPARISON', viewEnabled: false },
      COINMARKETCAP: { enabled: true, sensitiveRole: 'FALLBACK', viewEnabled: false },
    },
  };
}

class ConstraintClient {
  readonly calls: string[] = [];
  released = false;

  constructor(private readonly code: string) {}

  async query(sql: string): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push(sql);
    if (sql.includes('FROM price_conversion_test.price_settings')) {
      return { rows: [{ liveRevision: 5, divergenceThresholdBps: 500 }] };
    }
    if (sql.includes('FROM price_conversion_test.price_config_changes')) return { rows: [{ revision: 5 }] };
    if (sql.includes('FROM price_conversion_test.price_providers ORDER BY')) {
      return { rows: [
        { code: 'ALCHEMY', enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
        { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
        { code: 'COINMARKETCAP', enabled: true, role: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
      ] };
    }
    if (sql.includes('INSERT INTO price_conversion_test.price_config_changes')) {
      throw Object.assign(new Error('sensitive database detail'), { code: this.code });
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

class UnchangedClient {
  readonly calls: string[] = [];
  released = false;

  constructor(private readonly target?: PersistedPriceConfiguration) {}

  async query(sql: string): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push(sql);
    if (sql.includes('FROM price_conversion_test.price_settings')) {
      return { rows: [{ liveRevision: 5, divergenceThresholdBps: 125 }] };
    }
    if (sql.includes('FROM price_conversion_test.price_config_changes') && sql.includes('MAX(revision)')) {
      return { rows: [{ revision: 5 }] };
    }
    if (sql.includes('FROM price_conversion_test.price_config_changes')) {
      return { rows: this.target === undefined ? [] : [{
        revision: 5,
        effectiveAt: sql.includes("status = 'SCHEDULED'") ? '2999-01-01T00:00:00.000Z' : null,
        config: this.target,
      }] };
    }
    if (sql.includes('FROM price_conversion_test.price_providers ORDER BY')) {
      return { rows: [
        { code: 'ALCHEMY', enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
        { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
        { code: 'COINMARKETCAP', enabled: true, role: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
      ] };
    }
    if (sql.includes('FROM price_conversion_test.price_view_fiats')) {
      return { rows: [{ code: 'USD' }] };
    }
    if (sql.includes('INSERT INTO price_conversion_test.price_config_changes')) {
      return { rows: [{ id: '01920000-0000-7000-8000-000000000601' }] };
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}
