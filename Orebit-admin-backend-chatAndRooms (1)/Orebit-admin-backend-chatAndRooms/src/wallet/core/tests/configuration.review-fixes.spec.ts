import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';

import { AdminAuditRepository } from '../../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../../admin-audits/admin-audit.writer.service.js';
import {
  createValidatedWalletCoreTestDatabase,
  WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient,
  type WalletCorePool,
} from '../wallet-core.database.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import type {
  WalletAuditContext,
  WalletCoreConfigurationPatch,
  WalletCoreSystemAuditContext,
} from '../wallet-core.types.js';

const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const ACTOR: WalletAuditContext = { actor: {
  kind: 'ADMIN', actorId: '550e8400-e29b-41d4-a716-446655440100',
  sessionId: '550e8400-e29b-41d4-a716-446655440101',
  requestId: '550e8400-e29b-41d4-a716-446655440102', ipAddress: '127.0.0.1',
  deviceId: 'task4-review',
} };
const SYSTEM: WalletCoreSystemAuditContext = {
  actor: { kind: 'SYSTEM', runId: '550e8400-e29b-41d4-a716-446655440103' },
};
const LOGO_ASSETS = { async attachReferencedWithTransaction() {} };

class Client implements WalletCoreClient {
  constructor(private readonly value: pg.PoolClient) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ) {
    const mapped = sql.replace(
      'admin.append_admin_audit_event_v1', 'admin_test.append_admin_audit_event_v1',
    );
    const result = await this.value.query(mapped, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release() { this.value.release(); }
}
class Pool implements WalletCorePool {
  constructor(readonly value: pg.Pool) {}
  async connect() { return new Client(await this.value.connect()); }
  async end() { await this.value.end(); }
}

const IDS = {
  chain: '01980000-0000-7000-8000-000000000001',
  currency: '01980000-0000-7000-8000-000000000002',
  binding: '01980000-0000-7000-8000-000000000003',
} as const;
function config(ids = IDS, providerChainId = 980001, providerCoinId = 980002) {
  return {
    chains: [{ id: ids.chain, providerChainId, blockchainReference: 'review-chain',
      name: 'Review Chain', shortName: 'REVIEW',
      isEvm: true, availableFor: 'BOTH' as const, desiredState: 'ON' as const }],
    currencies: [{ id: ids.currency, symbol: 'REVIEW', name: 'Review Coin', providerRefs: [
        { provider: 'COINGECKO' as const, providerAssetId: 'review-gecko', providerSymbol: 'REVIEW' },
        { provider: 'ALCHEMY' as const, providerAssetId: 'review-alchemy', providerSymbol: 'REVIEW' },
        { provider: 'COINMARKETCAP' as const, providerAssetId: 'review-cmc', providerSymbol: 'REVIEW' },
      ], viewEnabled: true, geoCountryDeny: [], geoContinentDeny: [],
      accessLevel: 'ALL' as const, availableFor: 'BOTH' as const,
      listingKind: 'PERMANENT' as const, showBeforeListing: false,
      premiumOperations: [], soOperations: [], postDelistOperations: [],
      desiredState: 'ON' as const, maintenanceAudiences: [],
      showBalanceInMaintenance: { USER: true, SO: true }, bindings: [{
        id: ids.binding, chainId: ids.chain, providerCoinId,
        blockchainReference: 'Review Coin', isToken: false,
        blockchainPrecision: 18, desiredState: 'ON' as const,
        hotWalletAddresses: [], coldWalletAddresses: [], stakingWalletAddresses: [],
      }],
    }],
  };
}
async function current(pool: pg.Pool): Promise<number> {
  return Number((await pool.query(
    'SELECT revision FROM wallet_core_test.wallet_settings WHERE id',
  )).rows[0].revision);
}
async function seed(pool: pg.Pool, chain = 980001, coin = 980002): Promise<void> {
  await pool.query(`INSERT INTO wallet_core_test.provider_catalogue_chains
    (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at)
    VALUES ($1,'Review Chain','REVIEW',true,'ACTIVATED',81,now())
    ON CONFLICT (provider_chain_id) DO UPDATE SET name=EXCLUDED.name,
      short_name=EXCLUDED.short_name,is_evm=EXCLUDED.is_evm,
      provider_state=EXCLUDED.provider_state,revision=EXCLUDED.revision`, [chain]);
  await pool.query(`INSERT INTO wallet_core_test.provider_catalogue_currencies
    (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,
     is_stake,blockchain_precision,provider_state,revision,refreshed_at)
    VALUES ($1,$2,'Review Coin',NULL,true,true,18,'ACTIVATED',82,now())
    ON CONFLICT (provider_chain_id,provider_coin_id) DO UPDATE SET
      currency_name=EXCLUDED.currency_name,token_address=EXCLUDED.token_address,
      is_base_currency=EXCLUDED.is_base_currency,is_stake=EXCLUDED.is_stake,
      blockchain_precision=EXCLUDED.blockchain_precision,
      provider_state=EXCLUDED.provider_state,revision=EXCLUDED.revision`, [chain, coin]);
}

describe('Wallet Core Task 4 review contracts', () => {
  it('validates custody identities against an existing chain omitted from a partial patch', async () => {
    const repository = new WalletCoreRepository({
      schemas: WALLET_CORE_TEST_SCHEMAS,
    } as ConstructorParameters<typeof WalletCoreRepository>[0]);
    const partial = config();
    delete (partial as Partial<typeof partial>).chains;
    Object.assign(partial.currencies[0]!.bindings[0]!, {
      hotWalletAddresses: ['0xAbC'], coldWalletAddresses: ['0xaBc'],
    });
    let usedSetBasedChainRead = false;
    const client = { async query(sql: string) {
      if (sql.includes('FROM wallet_core_test.chains')) {
        usedSetBasedChainRead = sql.includes('=ANY($1::uuid[])');
        return { rows: [{ id: IDS.chain, is_evm: true }], rowCount: 1 };
      }
      if (sql.includes('FROM price_conversion_test.currencies')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: sql.includes('INSERT INTO') ? 1 : 0 };
    }, release() {} } as WalletCoreClient;

    await assert.rejects(() => repository.applyConfiguration(
      client, partial as WalletCoreConfigurationPatch, 1,
      { chains: [], currencies: [{ providerChainId: 980001, providerCoinId: 980002,
        currencyName: 'Review Coin', tokenAddress: null, isBaseCurrency: true, isStake: true,
        blockchainPrecision: 18, providerState: 'ACTIVATED', revision: 82 }] },
    ), WalletConfigurationInvalid);
    assert.equal(usedSetBasedChainRead, true);
  });

  it('loads two authoritative binding chain kinds in one bounded query', async () => {
    const repository = new WalletCoreRepository({
      schemas: WALLET_CORE_TEST_SCHEMAS,
    } as ConstructorParameters<typeof WalletCoreRepository>[0]);
    const partial = config(); const secondChain = '01980000-0000-7000-8000-000000000004';
    const secondBinding = { ...partial.currencies[0]!.bindings[0]!,
      id: '01980000-0000-7000-8000-000000000005', chainId: secondChain,
      providerCoinId: 980003 };
    (partial.currencies[0]!.bindings as unknown as Array<Record<string, unknown>>)
      .push(secondBinding);
    delete (partial as Partial<typeof partial>).chains;
    let chainReads = 0; let selectedIds: readonly unknown[] = [];
    const client = { async query(sql: string, values: readonly unknown[] = []) {
      if (sql.includes('FROM wallet_core_test.chains')) {
        chainReads += 1;
        if (sql.includes('=ANY($1::uuid[])')) {
          selectedIds = values[0] as readonly unknown[];
          return { rows: selectedIds.map((id) => ({ id, is_evm: true })), rowCount: 2 };
        }
        return { rows: [{ is_evm: true }], rowCount: 1 };
      }
      if (sql.includes('FROM price_conversion_test.currencies')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: sql.includes('INSERT INTO') ? 1 : 0 };
    }, release() {} } as WalletCoreClient;

    await repository.applyConfiguration(client, partial as WalletCoreConfigurationPatch, 1,
      { chains: [], currencies: [
        { providerChainId: 980001, providerCoinId: 980002, currencyName: 'Review Coin',
          tokenAddress: null, isBaseCurrency: true, isStake: true, blockchainPrecision: 18,
          providerState: 'ACTIVATED', revision: 82 },
        { providerChainId: 980004, providerCoinId: 980003, currencyName: 'Review Coin',
          tokenAddress: null, isBaseCurrency: true, isStake: true, blockchainPrecision: 18,
          providerState: 'ACTIVATED', revision: 82 },
      ] });
    assert.equal(chainReads, 1);
    assert.deepEqual(new Set(selectedIds), new Set([IDS.chain, secondChain]));
  });

  it('captures and revalidates every normalized provider-owned field', async () => {
    const chain = { name: 'Review Chain', short_name: 'REVIEW', is_evm: true,
      provider_state: 'ACTIVATED', revision: 81 };
    const coin = { currency_name: 'Review Coin', token_address: null,
      is_base_currency: true, is_stake: true, blockchain_precision: 18,
      provider_state: 'ACTIVATED', revision: 82 };
    const client = { async query(sql: string) {
      return { rows: [sql.includes('provider_catalogue_chains') ? chain : coin], rowCount: 1 };
    }, release() {} } as WalletCoreClient;
    const repository = new WalletCoreRepository({
      schemas: WALLET_CORE_TEST_SCHEMAS,
    } as ConstructorParameters<typeof WalletCoreRepository>[0]);
    const evidence = await repository.captureCatalogue(
      client, config() as WalletCoreConfigurationPatch,
    );
    assert.deepEqual(evidence, { chains: [{ providerChainId: 980001, name: 'Review Chain',
      shortName: 'REVIEW', isEvm: true, providerState: 'ACTIVATED', revision: 81 }],
    currencies: [{ providerChainId: 980001, providerCoinId: 980002,
      currencyName: 'Review Coin', tokenAddress: null, isBaseCurrency: true,
      isStake: true, blockchainPrecision: 18, providerState: 'ACTIVATED', revision: 82 }] });
    assert.equal(await repository.validateCatalogue(client, evidence), null);
    for (const [field, value] of [['name', 'Drift'], ['short_name', 'DRIFT'],
      ['is_evm', false], ['provider_state', 'MAINTENANCE'], ['revision', 83]] as const) {
      const prior = chain[field]; Object.assign(chain, { [field]: value });
      assert.equal(await repository.validateCatalogue(client, evidence),
        'CATALOGUE_REVISION_CHANGED', field);
      Object.assign(chain, { [field]: prior });
    }
    for (const [field, value] of [['currency_name', 'Drift'], ['token_address', '0x1'],
      ['is_base_currency', false], ['is_stake', false], ['blockchain_precision', 8],
      ['provider_state', 'MAINTENANCE'], ['revision', 83]] as const) {
      const prior = coin[field]; Object.assign(coin, { [field]: value });
      assert.equal(await repository.validateCatalogue(client, evidence),
        'CATALOGUE_REVISION_CHANGED', field);
      Object.assign(coin, { [field]: prior });
    }
  });

  it('keeps website labels separate from provider catalogue and blockchain identities', async () => {
    const client = { async query(sql: string) {
      return sql.includes('provider_catalogue_chains')
        ? { rows: [{ name: 'Provider Chain', short_name: 'PROVIDER', is_evm: true,
          provider_state: 'ACTIVATED', revision: 81 }], rowCount: 1 }
        : { rows: [{ currency_name: 'Provider Coin', token_address: null,
          is_base_currency: true, is_stake: true, blockchain_precision: 18,
          provider_state: 'ACTIVATED', revision: 82 }], rowCount: 1 };
    }, release() {} } as WalletCoreClient;
    const repository = new WalletCoreRepository({
      schemas: WALLET_CORE_TEST_SCHEMAS,
    } as ConstructorParameters<typeof WalletCoreRepository>[0]);

    const evidence = await repository.captureCatalogue(
      client, config() as WalletCoreConfigurationPatch,
    );

    assert.equal(evidence.chains[0]?.name, 'Provider Chain');
    assert.equal(evidence.currencies[0]?.currencyName, 'Provider Coin');
  });

  it('rejects a live chain identity edit before any mutation', async () => {
    let mutated = false;
    const client = { async query(sql: string) {
      if (sql.includes('SELECT provider_chain_id,blockchain_reference')) return { rows: [{
        provider_chain_id: 980001, blockchain_reference: 'old-chain', name: 'Review Chain',
        short_name: 'REVIEW', is_evm: true, available_for: 'BOTH', desired_state: 'ON',
        provider_state: 'ACTIVATED', logo_object_key: null,
      }], rowCount: 1 };
      if (sql.includes('INSERT INTO wallet_core_test.chains')) mutated = true;
      return { rows: [], rowCount: 1 };
    }, release() {} } as WalletCoreClient;
    const repository = new WalletCoreRepository({
      schemas: WALLET_CORE_TEST_SCHEMAS,
    } as ConstructorParameters<typeof WalletCoreRepository>[0]);
    const chain = { ...config().chains[0]!, blockchainReference: 'new-chain' };

    await assert.rejects(() => repository.applyConfiguration(client, { chains: [chain] }, 1, {
      chains: [{ providerChainId: chain.providerChainId, name: chain.name,
        shortName: chain.shortName, isEvm: chain.isEvm, providerState: 'ACTIVATED', revision: 1 }],
      currencies: [],
    }), WalletConfigurationInvalid);
    assert.equal(mutated, false);
  });
  it('applies verified evidence without recapturing the catalogue', async () => {
    const source = await readFile(resolve(__dirname, '../wallet-core.repository.ts'), 'utf8');
    const body = source.slice(source.indexOf('async applyConfiguration('),
      source.indexOf('private async applyCurrency('));
    assert.doesNotMatch(body, /captureCatalogue/);
  });
  it('maps every direct catalogue drift or unavailable result to configuration invalid', async () => {
    const settings = { globalDesiredState: 'ON' as const, catalogueMode: 'ALL' as const,
      reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
      reconciliationAlertPercent: '5', defaultCurrencyIds: [] };
    for (const failure of ['CATALOGUE_REVISION_CHANGED', 'CATALOGUE_REFERENCE_UNAVAILABLE',
      'CAPTURE_UNAVAILABLE', 'CAPTURE_MISMATCH'] as const) {
      const repository = {
        transaction: async (work: (client: WalletCoreClient) => Promise<unknown>) => work({} as WalletCoreClient),
        lockSettings: async () => ({ revision: 0 }),
        captureCatalogue: async () => {
          if (failure === 'CAPTURE_UNAVAILABLE') throw new Error('CATALOGUE_REFERENCE_UNAVAILABLE');
          if (failure === 'CAPTURE_MISMATCH') throw new Error('CATALOGUE_CONFIGURATION_MISMATCH');
          return { chains: [], currencies: [] };
        },
        validateCatalogue: async () => failure.startsWith('CATALOGUE_') ? failure : null,
      } as unknown as WalletCoreRepository;
      const writer = new WalletCoreConfigurationWriter(repository, {
        async appendWithTransaction() { throw new Error('audit must not run'); },
      }, LOGO_ASSETS);
      await assert.rejects(() => writer.updateAtomically({ action: 'PUSH',
        expectedRevision: 0, reason: 'catalogue drift',
        config: { settings } }, ACTOR), WalletConfigurationInvalid, failure);
    }
  });
});

describe('Wallet Core Task 4 review persistence', { skip: !LIVE }, () => {
  it('preserves microsecond effectiveAt and writes canonical local subjects/details', async () => {
    const pool = new Pool(new pg.Pool({ connectionString: TEST_URL, max: 4 }));
    const writer = new WalletCoreConfigurationWriter(new WalletCoreRepository(
      createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS)),
    new AdminAuditWriterService(new AdminAuditRepository()), LOGO_ASSETS);
    try {
      await seed(pool.value);
      const effectiveAt = `${new Date(Date.now() + 60_000).toISOString().slice(0, -1)}456Z`;
      const scheduled = await writer.updateAtomically({ action: 'SCHEDULE',
        expectedRevision: await current(pool.value), reason: 'precise schedule',
        effectiveAt, config: config() }, ACTOR);
      assert.equal(scheduled.outcome, 'SCHEDULED');
      assert.equal(scheduled.outcome === 'SCHEDULED' ? scheduled.effectiveAt : '', effectiveAt);
      const applied = await writer.applyScheduledChangeAtomically(
        scheduled.configurationId, new Date(Date.parse(effectiveAt) + 1), SYSTEM,
      );
      assert.equal(applied.outcome, 'SCHEDULE_APPLIED');
      const events = await pool.value.query(`SELECT event_type,subject_id::text,payload
        FROM wallet_core_test.state_events WHERE payload->>'eventKey' LIKE $1
        ORDER BY created_at,id`, [`wallet:${scheduled.configurationId}:%`]);
      assert.deepEqual(events.rows.map((row) => [row.event_type, row.subject_id])
        .sort(([left], [right]) => String(left).localeCompare(String(right))), [
        ['CHAIN.IMPORTED', IDS.chain], ['CURRENCY.IMPORTED', IDS.currency],
        ['SETTINGS.SCHEDULE_APPLIED', scheduled.configurationId],
        ['SETTINGS.SCHEDULED', scheduled.configurationId],
      ]);
      assert.ok(events.rows.filter((row) => ['SETTINGS.SCHEDULED',
        'SETTINGS.SCHEDULE_APPLIED'].includes(String(row.event_type)))
        .every((row) => JSON.stringify(row.payload).includes(effectiveAt)));
      const canonical = await pool.value.query(`SELECT action FROM admin_test.admin_audit_events
        WHERE event_key LIKE $1 ORDER BY created_at,id`, [`wallet:${scheduled.configurationId}:%`]);
      assert.deepEqual(canonical.rows.map((row) => row.action), ['SETTINGS.SCHEDULED',
        'SETTINGS.SCHEDULE_APPLIED']);
      assert.equal((await pool.value.query(`SELECT pricing_status::text FROM
        price_conversion_test.currencies WHERE id=$1`, [IDS.currency])).rows[0].pricing_status,
      'ACTIVE');
    } finally { await pool.end(); }
  });

  it('rejects binding identity drift and persists allowed binding state updates', async () => {
    const pool = new Pool(new pg.Pool({ connectionString: TEST_URL, max: 4 }));
    const writer = new WalletCoreConfigurationWriter(new WalletCoreRepository(
      createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS)),
    new AdminAuditWriterService(new AdminAuditRepository()), LOGO_ASSETS);
    try {
      await seed(pool.value);
      await writer.updateAtomically({ action: 'PUSH',
        expectedRevision: await current(pool.value), reason: 'initial binding',
        config: config() }, ACTOR);
      const changedIdentity = config(IDS, 980001, 980003);
      await seed(pool.value, 980001, 980003);
      const identityRevision = await current(pool.value);
      await assert.rejects(() => writer.updateAtomically({ action: 'PUSH',
        expectedRevision: identityRevision,
        reason: 'identity drift', config: changedIdentity,
      }, ACTOR), WalletConfigurationInvalid);
      await pool.value.query(`UPDATE wallet_core_test.provider_catalogue_currencies SET
        blockchain_precision=8,provider_state='MAINTENANCE',revision=revision+1
        WHERE provider_chain_id=980001 AND provider_coin_id=980002`);
      const base = config();
      const next = { ...base, currencies: [{ ...base.currencies[0]!, bindings: [{
        ...base.currencies[0]!.bindings[0]!, blockchainPrecision: 8,
        desiredState: 'MAINTAIN' as const,
      }] }] };
      const result = await writer.updateAtomically({ action: 'PUSH',
        expectedRevision: await current(pool.value), reason: 'state update',
        config: next }, ACTOR);
      const row = (await pool.value.query(`SELECT blockchain_precision,
        desired_state::text,provider_state::text FROM wallet_core_test.currencies WHERE id=$1`,
      [IDS.binding])).rows[0];
      assert.deepEqual(row, { blockchain_precision: 8, desired_state: 'MAINTAIN',
        provider_state: 'MAINTENANCE' });
      const audit = await pool.value.query(`SELECT action,subject_id::text FROM
        admin_test.admin_audit_events WHERE event_key LIKE $1 AND action='CURRENCY.STATUS_CHANGED'`,
      [`wallet:${result.configurationId}:%`]);
      assert.deepEqual(audit.rows, [{ action: 'CURRENCY.STATUS_CHANGED', subject_id: IDS.binding }]);
    } finally { await pool.end(); }
  });
});
