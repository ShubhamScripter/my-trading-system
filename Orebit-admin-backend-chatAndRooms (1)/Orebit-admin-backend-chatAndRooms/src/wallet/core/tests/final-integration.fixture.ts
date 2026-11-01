import assert from 'node:assert/strict';
import pg from 'pg';
import { AdminAuditRepository } from '../../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../../admin-audits/admin-audit.writer.service.js';
import { uuidv7 } from '../../../utils/public.utils.js';
import { WalletCoreDatabase, WALLET_CORE_TEST_SCHEMAS, type WalletCorePool } from '../wallet-core.database.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { WalletLogoAssetRepository } from '../logo-asset.repository.js';
import type { CurrencyUpsert } from '../wallet-core.types.js';

export const enabled = !!process.env.WP11_SCHEMA_DATABASE_URL;
export async function integration(work: (fixture: {
  client: pg.Client; pool: WalletCorePool; writer: WalletCoreConfigurationWriter;
  custodyWrites: string[];
  currency: CurrencyUpsert; push: (currency: CurrencyUpsert) => Promise<unknown>;
  actor: { actor: { kind: 'ADMIN'; actorId: string; sessionId: string; requestId: string; ipAddress: string; deviceId: string } };
}) => Promise<void>) {
  const url = new URL(process.env.WP11_SCHEMA_DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55441');
  assert.equal(url.pathname, '/orebit_wallet_pricing_fixes_20260910');
  assert.equal(url.username, 'orebit_wallet_pricing_fixes_owner');
  const client = new pg.Client({ connectionString: url.href }); await client.connect();
  try {
    assert.deepEqual((await client.query(`SELECT current_database() name,current_user owner,
      current_setting('cluster_name') cluster,inet_server_port() port`)).rows[0], {
      name: 'orebit_wallet_pricing_fixes_20260910', owner: 'orebit_wallet_pricing_fixes_owner',
      cluster: 'orebit_wallet_pricing_fixes_20260910', port: 5432 });
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const custodyWrites: string[] = [];
    const pool: WalletCorePool = { async end() {}, async connect() { return { release() {},
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        if (sql.startsWith('BEGIN')) sql = 'SAVEPOINT final_integration';
        else if (sql === 'COMMIT') sql = 'RELEASE SAVEPOINT final_integration';
        else if (sql === 'ROLLBACK') sql = 'ROLLBACK TO SAVEPOINT final_integration';
        else if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') return { rows: [] as Row[], rowCount: 0 };
        sql = sql.replaceAll('wallet_core_test.', 'wallet_core.').replaceAll('price_conversion_test.', 'price_conversion.')
          .replaceAll('admin_test.', 'admin.');
        if (/^(UPDATE|INSERT INTO) wallet_core\.custody_addresses/.test(sql)) custodyWrites.push(sql);
        // Explicit test-only collation seam: real query, rows, constraints and writes remain PostgreSQL-owned.
        if (sql.includes('SELECT kind::text,wallet_address FROM wallet_core.custody_addresses'))
          sql = sql.replace('ORDER BY kind,wallet_address', 'ORDER BY kind,wallet_address COLLATE "C"');
        const result = await client.query(sql, values as unknown[] | undefined);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      } }; } };
    const database = WalletCoreDatabase.validatedTest(pool, WALLET_CORE_TEST_SCHEMAS);
    const repository = new WalletCoreRepository(database);
    const writer = new WalletCoreConfigurationWriter(repository,
      new AdminAuditWriterService(new AdminAuditRepository()), new WalletLogoAssetRepository(database));
    const actor = { actor: { kind: 'ADMIN' as const, actorId: uuidv7(), sessionId: uuidv7(),
      requestId: uuidv7(), ipAddress: '127.0.0.1', deviceId: 'final-integration' } };
    const chainId = uuidv7(), currencyId = uuidv7(), bindingId = uuidv7();
    const provider = Number((await client.query(`SELECT GREATEST(
      COALESCE((SELECT max(provider_chain_id) FROM wallet_core.provider_catalogue_chains),0),
      COALESCE((SELECT max(provider_chain_id) FROM wallet_core.chains),0))+1 id`)).rows[0].id);
    await client.query(`INSERT INTO wallet_core.provider_catalogue_chains
      (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at)
      VALUES($1,'Integration chain','FINALCHAIN',false,'ACTIVATED',1,clock_timestamp())`, [provider]);
    await client.query(`INSERT INTO wallet_core.provider_catalogue_currencies
      (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,is_stake,
       blockchain_precision,provider_state,revision,refreshed_at)
      VALUES($1,1,'Integration asset',NULL,true,true,18,'ACTIVATED',1,clock_timestamp())`, [provider]);
    const currency: CurrencyUpsert = { id: currencyId, symbol: 'FINALCOIN', name: 'Integration coin',
      providerRefs: (['COINGECKO','ALCHEMY','COINMARKETCAP'] as const).map(provider => ({
        provider, providerAssetId: `final-${provider}-${currencyId}`, providerSymbol: 'FINALCOIN' })),
      viewEnabled: true, geoCountryDeny: [], geoContinentDeny: [], accessLevel: 'ALL', availableFor: 'BOTH',
      listingKind: 'PERMANENT', showBeforeListing: false, premiumOperations: [], soOperations: [],
      postDelistOperations: [], desiredState: 'ON', maintenanceAudiences: [],
      showBalanceInMaintenance: { USER: true, SO: true }, bindings: [{ id: bindingId, chainId,
        providerCoinId: 1, blockchainReference: 'Integration asset', isToken: false, blockchainPrecision: 18,
        desiredState: 'ON', hotWalletAddresses: ['ZebraAddress','appleAddress'],
        coldWalletAddresses: [], stakingWalletAddresses: [] }] };
    const revision = () => client.query('SELECT revision FROM wallet_core.wallet_settings WHERE id').then(r => Number(r.rows[0].revision));
    await writer.updateAtomically({ action: 'PUSH', expectedRevision: await revision(), reason: 'Seed final integration',
      config: { chains: [{ id: chainId, providerChainId: provider, blockchainReference: 'final-chain',
        name: 'Integration chain', shortName: 'FINALCHAIN', isEvm: false, availableFor: 'BOTH', desiredState: 'ON' }],
      currencies: [currency] } }, actor);
    const push = async (next: CurrencyUpsert) => writer.updateAtomically({ action: 'PUSH',
      expectedRevision: await revision(), reason: 'Change integration denomination flag', config: { currencies: [next] } },
    { actor: { ...actor.actor, requestId: uuidv7() } });
    await work({ client, pool, writer, currency, push, actor, custodyWrites });
  } finally { await client.query('ROLLBACK').catch(() => undefined); await client.end(); }
}
