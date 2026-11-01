import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';

function testDatabaseUrl(): string {
  const value = process.env.PRICE_TEST_DATABASE_URL;
  if (value === undefined) throw new Error('PRICE_TEST_DATABASE_URL is required');
  return value;
}

describe('price-conversion test database safety', () => {
  it('requires explicit reset opt-in and an isolated test database/schema', async () => {
    const provisioning = createRequire(resolve(featureDirectory, 'price-conversion.spec.js'))(
      resolve(featureDirectory, 'provision-test-database.cjs'),
    ) as { validatePriceTestDatabaseEnvironment?: (env: Record<string, string>) => { databaseName: string } };
    assert.ok(provisioning?.validatePriceTestDatabaseEnvironment);
    const validate = provisioning.validatePriceTestDatabaseEnvironment;

    assert.throws(() => validate({}), /PRICE_TEST_DATABASE_URL/);
    assert.throws(() => validate({
      PRICE_TEST_DATABASE_URL: 'postgresql://orebit:test@localhost/orebit?schema=price_conversion_test',
      PRICE_TEST_ALLOW_RESET: 'true',
    }), /exact disposable target/);
    assert.throws(() => validate({
      PRICE_TEST_DATABASE_URL: 'postgresql://orebit:test@localhost/orebit_price_test?schema=price_conversion',
      PRICE_TEST_ALLOW_RESET: 'true',
    }), /exact disposable target/);
    assert.throws(() => validate({
      PRICE_TEST_DATABASE_URL: testDatabaseUrl(),
    }), /PRICE_TEST_ALLOW_RESET/);
    assert.equal(validate({
      PRICE_TEST_DATABASE_URL: testDatabaseUrl(),
      PRICE_TEST_ALLOW_RESET: 'true',
    }).databaseName, 'orebit_price_test');
    assert.throws(() => validate({
      PRICE_TEST_DATABASE_URL: 'postgresql://orebit:test@localhost/another_price_test?schema=price_conversion_test',
      PRICE_TEST_ALLOW_RESET: 'true',
    }), /exact disposable target/);
  });

  it('allows the isolated SQL schema only under explicit test reset opt-in', async () => {
    const operation = await load<typeof import('./price-conversion.dboperation.js')>('./price-conversion.dboperation.js');
    assert.ok(operation?.priceConversionSchemaFromUrl);
    assert.equal(operation.priceConversionSchemaFromUrl(
      'postgresql://orebit:test@localhost/orebit?schema=price_conversion', {},
    ), 'price_conversion');
    assert.equal(operation.priceConversionSchemaFromUrl(
      'postgresql://orebit:test@localhost/orebit_price_test?schema=price_conversion_test',
      { NODE_ENV: 'test', PRICE_TEST_ALLOW_RESET: 'true' },
    ), 'price_conversion_test');
    assert.throws(() => operation.priceConversionSchemaFromUrl(
      'postgresql://orebit:test@localhost/orebit_price_test?schema=price_conversion_test',
      { NODE_ENV: 'production', PRICE_TEST_ALLOW_RESET: 'true' },
    ), /schema=price_conversion/);
  });
});

async function load<T>(path: string): Promise<T | undefined> {
  return import(path).catch(() => undefined) as Promise<T | undefined>;
}

const featureDirectory = process.cwd();
const canonicalDirectory = resolve(
  featureDirectory,
  '../../../../orebit-backend/src/wallet/price-conversion',
);

async function contentOrEmpty(path: string): Promise<Buffer> {
  return readFile(path).catch(() => Buffer.alloc(0));
}

function checksum(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('canonical price-conversion schema mirror', () => {
  it('matches the user service schema and migration byte-for-byte', async () => {
    const schema = 'schema.prisma';
    const migrations = [
      'migrations/20260831000000_canonical_price_conversion/migration.sql',
      'migrations/20260831000001_seed_price_configuration/migration.sql',
      'migrations/20260831000002_review_hardening/migration.sql',
      'migrations/20260831000003_governance_audit/migration.sql',
      'migrations/20260831000004_complete_price_hardening/migration.sql',
      'migrations/20260901000005_final_review_hardening/migration.sql',
      'migrations/20260901000006_final_isolation_and_dlq/migration.sql',
      'migrations/20260901000007_per_currency_view_and_ledger_read/migration.sql',
      'migrations/20260901000008_wall_clock_and_lifecycle_guards/migration.sql',
      'migrations/20260901000009_future_timestamp_guard/migration.sql',
      'migrations/20260901000010_strict_lifecycle_invariants/migration.sql',
      'migrations/20260901000011_sensitive_crypto_only/migration.sql',
      'migrations/20260901000012_revision_and_view_cadence/migration.sql',
      'migrations/20260901000013_reference_mutation_guard/migration.sql',
    ];

    for (const relativePath of [schema, ...migrations]) {
      assert.equal(
        checksum(await contentOrEmpty(resolve(featureDirectory, relativePath))),
        checksum(await contentOrEmpty(resolve(canonicalDirectory, relativePath))),
        relativePath,
      );
    }
  });
});

describe('canonical PostgreSQL schema', () => {
  it('exists on the disposable PostgreSQL instance and rejects invalid singleton settings', async () => {
    const client = new pg.Client({
      connectionString: testDatabaseUrl(),
    });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'price_conversion_test' AND table_name <> '_prisma_migrations'
        ORDER BY table_name`);
      assert.deepEqual(tables.rows.map((row) => row.table_name), [
        'currencies',
        'currency_provider_refs',
        'price_admin_audit',
        'price_admin_notifications',
        'price_config_changes',
        'price_fetch_runs',
        'price_notification_dlq',
        'price_provider_call_stats',
        'price_provider_health',
        'price_providers',
        'price_resolutions',
        'price_settings',
        'price_snapshots',
        'price_view_fetch_buckets',
        'price_view_fiats',
        'price_view_provider_health',
        'price_view_resolutions',
        'price_view_snapshots',
      ]);
      const enums = await client.query<{ enum_name: string; labels: string[] }>(`
        SELECT t.typname AS enum_name, json_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'price_conversion_test'
          AND t.typname IN ('PriceViewResolutionReason', 'PriceViewResolutionStatus')
        GROUP BY t.typname ORDER BY t.typname`);
      assert.deepEqual(enums.rows, [
        {
          enum_name: 'PriceViewResolutionReason',
          labels: [
            'CONFIGURED_PROVIDER', 'SENSITIVE_FALLBACK_PROVIDER', 'ALCHEMY_FALLBACK_SECONDARY',
            'VIEW_FAILURE_SECONDARY', 'SECONDARY_UNAVAILABLE',
          ],
        },
        { enum_name: 'PriceViewResolutionStatus', labels: ['AVAILABLE', 'UNAVAILABLE'] },
      ]);
      const ledgerFunction = await client.query<{ function_name: string | null; public_execute: boolean }>(`
        SELECT to_regprocedure(
          'price_conversion_test.resolve_money_batch_for_ledger(uuid[])'
        )::text AS function_name,
        has_function_privilege(
          'public', 'price_conversion_test.resolve_money_batch_for_ledger(uuid[])', 'EXECUTE'
        ) AS public_execute`);
      assert.deepEqual(ledgerFunction.rows[0], {
        function_name: 'price_conversion_test.resolve_money_batch_for_ledger(uuid[])',
        public_execute: false,
      });
      await client.query('BEGIN');
      await assert.rejects(() => client.query('INSERT INTO price_conversion_test.price_settings (id) VALUES (false)'));
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});

describe('price-conversion DTOs', () => {
  it('accepts a strict atomic provider/settings batch with integer basis points', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');

    const result = dto?.priceConversionPatchSchema.safeParse({
      action: 'PUSH',
      expectedRevision: 7,
      reason: 'Rotate provider roles after the quarterly review.',
      changelog: 'Updated price provider roles.',
      divergenceThresholdBps: 125,
      visibleFiatCodes: ['USD', 'EUR'],
      providers: [
        { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
        { code: 'ALCHEMY', enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
        { code: 'COINMARKETCAP', enabled: true, role: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
      ],
    });

    assert.equal(result?.success, true);
  });

  it('bounds provider cadence to a positive PostgreSQL integer and fiat visibility to the canonical set', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');
    assert.ok(dto);
    const base = {
      action: 'SAVE_DRAFT', expectedRevision: 0, reason: 'Validate cadence.', changelog: 'Draft.',
    };
    const provider = (refreshIntervalSeconds: number) => ({
      code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds,
    });
    assert.equal(dto.priceConversionPatchSchema.safeParse({ ...base, providers: [provider(1)] }).success, true);
    assert.equal(dto.priceConversionPatchSchema.safeParse({ ...base, providers: [provider(0)] }).success, false);
    assert.equal(dto.priceConversionPatchSchema.safeParse({ ...base, providers: [provider(2_147_483_648)] }).success, false);
    assert.equal(dto.priceConversionPatchSchema.safeParse({ ...base, visibleFiatCodes: ['USD', 'EUR'] }).success, true);
    assert.equal(dto.priceConversionPatchSchema.safeParse({ ...base, visibleFiatCodes: ['USD', 'USD'] }).success, false);
    assert.equal(dto.priceConversionPatchSchema.safeParse({ ...base, visibleFiatCodes: ['VEF'] }).success, false);
  });

  it('rejects a non-integer basis point threshold and an unrecognised field', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');

    const result = dto?.priceConversionPatchSchema.safeParse({
      action: 'PUSH',
      expectedRevision: 0,
      reason: 'Reject malformed threshold.',
      changelog: 'Invalid test change.',
      divergenceThresholdBps: 12.5,
      unexpected: 'rejected',
    });

    assert.equal(result?.success, false);
  });

  it('bounds history cursors and page sizes before they reach the database', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');

    assert.equal(dto?.priceConversionHistoryQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.equal(
      dto?.priceConversionHistoryQuerySchema.safeParse({ cursor: 'x'.repeat(513) }).success,
      false,
    );
  });

  it('rejects duplicate providers and every Wallet-owned configuration field', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');
    const duplicateProvider = dto?.priceConversionPatchSchema.safeParse({
      action: 'PUSH', expectedRevision: 0, reason: 'Duplicate provider.', changelog: 'Duplicate.',
      providers: [
        { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true },
        { code: 'COINGECKO', enabled: true, role: 'COMPARISON', viewEnabled: false },
      ],
    });
    assert.equal(duplicateProvider?.success, false);
    const base = {
      action: 'SAVE_DRAFT', expectedRevision: 0, reason: 'Price providers only.', changelog: 'Draft.',
    };
    for (const [field, value] of [
      ['currencies', []], ['currencyUpserts', []], ['providerRefs', []],
      ['walletPolicy', { desiredState: 'ON' }], ['binanceReference', 'BTCUSDT'],
    ] as const) {
      assert.equal(dto?.priceConversionPatchSchema.safeParse({ ...base, [field]: value }).success,
        false, field);
    }
  });

  it('enforces lifecycle action, reason, changelog, and scheduled effective time', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');

    assert.equal(dto?.priceConversionPatchSchema.safeParse({ expectedRevision: 0 }).success, false);
    assert.equal(dto?.priceConversionPatchSchema.safeParse({
      action: 'SCHEDULE', expectedRevision: 0, reason: 'Schedule later.', changelog: 'Scheduled.',
    }).success, false);
    assert.equal(dto?.priceConversionPatchSchema.safeParse({
      action: 'PUSH', expectedRevision: 0, reason: 'Push now.', changelog: 'Pushed.',
      effectiveAt: '2026-09-01T00:00:00.000Z',
    }).success, false);
    assert.equal(dto?.priceConversionPatchSchema.safeParse({
      action: 'SCHEDULE', expectedRevision: 0, reason: 'Schedule later.', changelog: 'Scheduled.',
      effectiveAt: '2026-09-01T00:00:00.000Z',
    }).success, true);
  });

  it('requires a clean PUSH body when consuming an explicit draftId', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');
    const draftId = '01920000-0000-7000-8000-000000000099';
    const base = {
      action: 'PUSH', expectedRevision: 1, reason: 'Consume draft.', changelog: 'Push draft.', draftId,
    };
    assert.equal(dto?.priceConversionPatchSchema.safeParse(base).success, true);
    assert.equal(dto?.priceConversionPatchSchema.safeParse({ ...base, divergenceThresholdBps: 999 }).success, false);
    assert.equal(dto?.priceConversionPatchSchema.safeParse({ ...base, action: 'SAVE_DRAFT' }).success, false);
    assert.equal(dto?.priceConversionPatchSchema.safeParse({ ...base, draftId: 'not-a-uuid' }).success, false);
  });

  it('accepts provider-only configuration and rejects catalogue-shaped nested fields', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');
    const base = {
      action: 'SAVE_DRAFT', expectedRevision: 0, reason: 'Validate providers.', changelog: 'Draft.',
    };
    assert.equal(dto?.priceConversionPatchSchema.safeParse({ ...base,
      providers: [{ code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 }],
    }).success, true);
    assert.equal(dto?.priceConversionPatchSchema.safeParse({ ...base,
      providers: [{ code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60,
        providerRefs: [] }],
    }).success, false);
  });

  it('accepts only bounded scheduled-page controls on bootstrap', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');

    assert.ok(dto?.priceConversionBootstrapQuerySchema);
    assert.deepEqual(dto.priceConversionBootstrapQuerySchema.parse({}), { scheduledLimit: 50 });
    assert.equal(dto.priceConversionBootstrapQuerySchema.safeParse({ scheduledLimit: 100 }).success, true);
    assert.equal(dto.priceConversionBootstrapQuerySchema.safeParse({ scheduledLimit: 101 }).success, false);
    assert.equal(dto.priceConversionBootstrapQuerySchema.safeParse({ limit: 2 }).success, false);
  });

  it('accepts only canonical opaque tuple cursors for history', async () => {
    const dto = await load<typeof import('./price-conversion.dto.js')>('./price-conversion.dto.js');
    const historyCursor = Buffer.from(JSON.stringify([
      '2026-08-31T00:00:00.000000Z',
      '01920000-0000-7000-8000-000000000001',
      '["history",null,null,null,null,null,null,"timestamp","desc"]',
    ])).toString('base64url');

    assert.ok(dto?.priceConversionHistoryQuerySchema);
    assert.equal(dto?.priceConversionHistoryQuerySchema.safeParse({ limit: 2, cursor: historyCursor }).success, true);
    assert.equal(dto?.priceConversionHistoryQuerySchema.safeParse({ cursor: '01920000-0000-7000-8000-000000000001' }).success, false);
  });

});

describe('persisted price configuration', () => {
  it('serializes exactly the shared settings and keyed provider contract', async () => {
    const operation = await load<typeof import('./price-conversion.dboperation.js')>('./price-conversion.dboperation.js');
    assert.ok(operation?.serializePriceConfiguration);
    const providers = [
      { code: 'ALCHEMY' as const, enabled: true, role: 'COMPARISON' as const, viewEnabled: false, refreshIntervalSeconds: 60 },
      { code: 'COINGECKO' as const, enabled: true, role: 'PRIMARY' as const, viewEnabled: true, refreshIntervalSeconds: 60 },
      { code: 'COINMARKETCAP' as const, enabled: true, role: 'FALLBACK' as const, viewEnabled: false, refreshIntervalSeconds: 300 },
    ];

    assert.deepEqual(operation.serializePriceConfiguration(125, providers, ['USD', 'EUR']), {
      settings: { divergenceThresholdBps: 125, visibleFiatCodes: ['EUR', 'USD'] },
      providers: {
        COINGECKO: { enabled: true, sensitiveRole: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
        ALCHEMY: { enabled: true, sensitiveRole: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
        COINMARKETCAP: { enabled: true, sensitiveRole: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
      },
    });
  });

  it('reports HEALTHY only with all enabled sensitive roles and DEGRADED otherwise', async () => {
    const operation = await load<typeof import('./price-conversion.dboperation.js')>('./price-conversion.dboperation.js');
    assert.ok(operation?.priceRoleConfigurationStatus);
    const healthy = [
      { code: 'COINGECKO' as const, enabled: true, role: 'PRIMARY' as const, viewEnabled: true },
      { code: 'ALCHEMY' as const, enabled: true, role: 'COMPARISON' as const, viewEnabled: false },
      { code: 'COINMARKETCAP' as const, enabled: true, role: 'FALLBACK' as const, viewEnabled: false },
    ];
    assert.equal(operation.priceRoleConfigurationStatus(healthy), 'HEALTHY');
    assert.equal(operation.priceRoleConfigurationStatus([
      healthy[0]!,
      { ...healthy[1], enabled: false, role: null },
      { ...healthy[2], enabled: false, role: null },
    ]), 'DEGRADED');
  });
});

describe('per-currency view resolution contracts', () => {
  it('exports the frozen reason and status values without adding an endpoint', async () => {
    const types = await load<Record<string, unknown>>('./price-conversion.types.js');

    assert.deepEqual(types?.PRICE_VIEW_RESOLUTION_STATUSES, ['AVAILABLE', 'UNAVAILABLE']);
    assert.deepEqual(types?.PRICE_VIEW_RESOLUTION_REASONS, [
      'CONFIGURED_PROVIDER',
      'SENSITIVE_FALLBACK_PROVIDER',
      'ALCHEMY_FALLBACK_SECONDARY',
      'VIEW_FAILURE_SECONDARY',
      'SECONDARY_UNAVAILABLE',
    ]);
  });
});
