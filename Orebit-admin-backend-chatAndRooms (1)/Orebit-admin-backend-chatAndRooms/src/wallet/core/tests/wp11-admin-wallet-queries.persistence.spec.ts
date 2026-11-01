import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';

import { uuidv7 } from '../../../utils/public.utils.js';
import { ProviderCatalogueRepository } from '../provider-catalogue.repository.js';
import { WalletCoreBootstrapRepository } from '../wallet-core.bootstrap-repository.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';
import { WalletCoreHistoryRepository } from '../wallet-core.history-repository.js';
import { walletProviderCatalogueCoinsPageQuerySchema } from '../wallet-core.dto.js';

const ENV = 'WP11_ADMIN_WALLET_QUERY_DATABASE_URL';
const DATABASE = 'orebit_wallet_pricing_fixes_20260910';
const OWNER = 'orebit_wallet_pricing_fixes_owner';
const enabled = process.env[ENV] !== undefined;
const logo = { publicUrl: (key: string) => `https://assets.test.invalid/${key}` };
const audit = { appendWithTransaction: async () => ({ id: uuidv7(), replayed: false }) };
const identity = { nextUuidV7: uuidv7 };

test('WP11 Admin Wallet persists complete filtered pages on the isolated database',
  { skip: !enabled }, async () => {
    const url = new URL(process.env[ENV]!);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55441');
    assert.equal(url.pathname, `/${DATABASE}`); assert.equal(url.username, OWNER);
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    try {
      const server = (await client.query(`SELECT current_database() database,current_user,
        current_setting('cluster_name') cluster,inet_server_port() port`)).rows[0];
      assert.deepEqual(server, { database: DATABASE, current_user: OWNER,
        cluster: DATABASE, port: 5432 });
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const calls: string[] = [];
      const database = { schemas: { wallet: 'wallet_core', price: 'price_conversion' },
        async transaction<T>(work: (tx: { query<Row extends Record<string, unknown>>(
          sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }> }) => Promise<T>) {
          await client.query('SAVEPOINT admin_wallet_query_repo');
          try {
            const result = await work({ query: async <Row extends Record<string, unknown>>(
              sql: string, values?: readonly unknown[],
            ) => {
              calls.push(sql);
              if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') {
                return { rows: [] as Row[], rowCount: 0 };
              }
              const queried = await client.query(sql, values as unknown[] | undefined);
              return { rows: queried.rows as Row[], rowCount: queried.rowCount ?? 0 };
            } });
            await client.query('RELEASE SAVEPOINT admin_wallet_query_repo');
            return result;
          } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT admin_wallet_query_repo');
            throw error;
          }
        } };
      const ids = { viewer: uuidv7(), actor: uuidv7(), chainA: uuidv7(), chainB: uuidv7(),
        literal: uuidv7(), ...Object.fromEntries(Array.from({ length: 3 }, (_, index) =>
          [`currency${index}`, uuidv7()])), ...Object.fromEntries(Array.from({ length: 3 }, (_, index) =>
          [`binding${index}`, uuidv7()])), ...Object.fromEntries(Array.from({ length: 3 }, (_, index) =>
          [`event${index}`, uuidv7()])), ...Object.fromEntries(Array.from({ length: 3 }, (_, index) =>
          [`configuration${index}`, uuidv7()])), ...Object.fromEntries(Array.from({ length: 3 }, (_, index) =>
          [`alert${index}`, uuidv7()])), } as Record<string, string>;
      const providerChainA = '9100000001'; const providerChainB = '9100000002';
      const mixedChainSmall = '920000002'; const mixedChainLarge = '9100000010';
      const defaultChainA = '930000001'; const defaultChainB = '930000002';
      await client.query(`UPDATE wallet_core.wallet_settings SET global_desired_state='ON',
        provider_catalogue_revision=777 WHERE id`);
      await client.query(`INSERT INTO wallet_core.chains
        (id,provider_chain_id,blockchain_reference,short_name,name,is_evm,available_for,
         desired_state,provider_state) VALUES
        ($1,$3,'wp11-a','WQTA','WP11 Chain Tie',false,'BOTH','ON','ACTIVATED'),
        ($2,$4,'wp11-b','WQTB','WP11 Chain Tie',true,'BOTH','ON','ACTIVATED')`,
      [ids.chainA, ids.chainB, providerChainA, providerChainB]);
      const currencyIds = [ids.currency0!, ids.currency1!, ids.currency2!];
      for (const [index, currencyId] of currencyIds.entries()) {
        await client.query(`INSERT INTO price_conversion.currencies
          (id,symbol,name,decimals,kind,pricing_status,auto_disabled)
          VALUES ($1,$2,'WP11 Query Tie',18,'CRYPTO','ACTIVE',false)`,
        [currencyId, `WQT${index}`]);
        await client.query(`INSERT INTO wallet_core.currency_settings
          (currency_id,desired_state,price_readiness) VALUES ($1,'ON','HEALTHY')`, [currencyId]);
        await client.query(`INSERT INTO wallet_core.currencies
          (id,currency_id,chain_id,provider_coin_id,blockchain_reference,is_token,is_native,
           token_contract_address,blockchain_precision,desired_state,provider_state)
          VALUES ($1,$2,$3,$4,$5,true,false,$6,18,'ON','ACTIVATED')`,
        [ids[`binding${index}`], currencyId, index < 2 ? ids.chainA : ids.chainB,
          9100000100 + index, `wp11-coin-${index}`, `0xwp11query${index}`]);
      }
      await client.query(`INSERT INTO price_conversion.currencies
        (id,symbol,name,decimals,kind,pricing_status,auto_disabled)
        VALUES ($1,'WQL','WP11 %_ Literal',18,'CRYPTO','ACTIVE',false)`, [ids.literal]);
      await client.query(`INSERT INTO wallet_core.currency_settings
        (currency_id,desired_state,price_readiness) VALUES ($1,'ON','HEALTHY')`, [ids.literal]);

      await client.query(`INSERT INTO wallet_core.provider_catalogue_chains
        (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at) VALUES
        ($1,'WP11 %_ Provider','WPA',false,'DISABLED',777,clock_timestamp()),
        ($2,'WP11 Other Provider','WPB',true,'ACTIVATED',777,clock_timestamp()),
        ($3,'WP11 Mixed Tie','WMS',false,'ACTIVATED',777,clock_timestamp()),
        ($4,'WP11 Mixed Tie','WML',false,'ACTIVATED',777,clock_timestamp()),
        ($5,'WP11 Default A','WDA',false,'ACTIVATED',777,clock_timestamp()),
        ($6,'WP11 Default B','WDB',false,'ACTIVATED',777,clock_timestamp())`,
      [providerChainA, providerChainB, mixedChainSmall, mixedChainLarge,
        defaultChainA, defaultChainB]);
      await client.query(`INSERT INTO wallet_core.provider_catalogue_currencies
        (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,is_stake,
         blockchain_precision,provider_state,revision,refreshed_at) VALUES
        ($1,9100000201,'WP11COIN',NULL,true,true,18,'ACTIVATED',777,clock_timestamp()),
        ($1,9100000202,'WP11COIN','0xwp11cataloguetoken',false,false,8,'DISABLED',777,clock_timestamp()),
        ($2,9100000203,'WP11COIN',NULL,true,false,6,'MAINTENANCE',777,clock_timestamp()),
        ($3,2,'WP11MIXCOIN','mix-2',false,false,6,'ACTIVATED',777,clock_timestamp()),
        ($3,10,'WP11MIXCOIN','mix-10',false,false,6,'ACTIVATED',777,clock_timestamp()),
        ($4,3,'WP11MIXCOIN','mix-3',false,false,6,'ACTIVATED',777,clock_timestamp()),
        ($5,20,'WP11DEFAULT',NULL,true,false,8,'ACTIVATED',777,clock_timestamp()),
        ($6,10,'WP11DEFAULT',NULL,true,false,8,'ACTIVATED',777,clock_timestamp())`,
      [providerChainA, providerChainB, mixedChainSmall, mixedChainLarge,
        defaultChainA, defaultChainB]);

      const revision = Number((await client.query(`SELECT COALESCE(max(revision),0)+1000 value
        FROM wallet_core.configuration_changes`)).rows[0]!.value);
      for (let index = 0; index < 3; index += 1) {
        const effectiveAt = `2098-01-0${index + 1}T00:00:00.000Z`;
        await client.query(`INSERT INTO wallet_core.configuration_changes
          (id,revision,status,reason,actor_id,snapshot,created_at)
          VALUES ($1,$2,'DRAFT','WP11 query schedule',$3,'{}',$4)`,
        [ids[`configuration${index}`], revision + index, ids.actor, effectiveAt]);
        await client.query(`UPDATE wallet_core.configuration_changes
          SET status='SCHEDULED',effective_at=$2 WHERE id=$1`,
        [ids[`configuration${index}`], effectiveAt]);
        const openedAt = `2097-01-0${index + 1}T00:00:00.000Z`;
        await client.query(`INSERT INTO wallet_core.wallet_alerts
          (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
          VALUES ($1,$2,'CATALOGUE_REFRESH_FAILED','ACTIVE',NULL,$3,$4,$4)`,
        [ids[`alert${index}`], `wp11-query-alert-${ids[`alert${index}`]}`,
          { safeErrorCode: 'TIMEOUT', failedAt: openedAt }, openedAt]);
      }

      const bootstrap = new WalletCoreBootstrapRepository(database as never, logo);
      const first = await bootstrap.bootstrap({ search: 'WP11 Query Tie', sortBy: 'name',
        sortDirection: 'asc', limit: 2, scheduledLimit: 1, activeAlertLimit: 1 },
      { adminId: ids.viewer! });
      assert.equal(first.currencies.items.length, 2); assert.ok(first.currencies.nextCursor);
      assert.ok(first.configuration.scheduled.total >= 3);
      assert.ok(first.configuration.scheduled.nextCursor);
      assert.ok(first.activeAlerts.total >= 3); assert.ok(first.activeAlerts.nextCursor);
      const second = await bootstrap.bootstrap({ search: 'WP11 Query Tie', sortBy: 'name',
        sortDirection: 'asc', limit: 2, cursor: first.currencies.nextCursor!,
        scheduledLimit: 1, activeAlertLimit: 1 }, { adminId: ids.viewer! });
      assert.equal(second.currencies.items.length, 1);
      assert.equal(new Set([...first.currencies.items, ...second.currencies.items]
        .map((item) => item.id)).size, 3);
      const literal = await bootstrap.bootstrap({ search: '%_', limit: 10,
        scheduledLimit: 1, activeAlertLimit: 1 }, { adminId: ids.viewer! });
      assert.deepEqual(literal.currencies.items.map((item) => item.id), [ids.literal]);
      const chainFiltered = await bootstrap.bootstrap({ search: 'WP11 Query Tie', state: 'ON',
        chainId: ids.chainA!, limit: 10, scheduledLimit: 1, activeAlertLimit: 1 },
      { adminId: ids.viewer! });
      assert.deepEqual(chainFiltered.currencies.items.map((item) => item.id).sort(),
        currencyIds.slice(0, 2).sort());
      await assert.rejects(() => bootstrap.bootstrap({ search: 'changed', sortBy: 'name',
        sortDirection: 'asc', limit: 2, cursor: first.currencies.nextCursor ?? undefined },
      { adminId: ids.viewer! }), WalletConfigurationInvalid);

      const chainFirst = await bootstrap.chainPage({ search: 'WP11 Chain Tie', sortBy: 'name',
        sortDirection: 'desc', limit: 1 });
      const chainSecond = await bootstrap.chainPage({ search: 'WP11 Chain Tie', sortBy: 'name',
        sortDirection: 'desc', limit: 1, cursor: chainFirst.nextCursor! });
      assert.equal(new Set([...chainFirst.items, ...chainSecond.items].map((item) => item.id)).size, 2);
      assert.deepEqual((await bootstrap.chainPage({ search: 'WP11 Chain Tie', isEvm: false,
        state: 'ON', limit: 10 })).items.map((item) => item.id), [ids.chainA]);

      const provider = new ProviderCatalogueRepository(database as never, audit as never, identity);
      assert.deepEqual((await provider.chains({ search: '%_', providerState: 'DISABLED',
        sortBy: 'name', sortDirection: 'asc', limit: 10 })).items.map((item) => item.providerChainId),
      [providerChainA]);
      const coinFirst = await provider.allCoins({ search: 'WP11COIN', sortBy: 'currencyName',
        sortDirection: 'asc', limit: 1 });
      const coinSecond = await provider.allCoins({ search: 'WP11COIN', sortBy: 'currencyName',
        sortDirection: 'asc', limit: 1, cursor: coinFirst.nextCursor! });
      assert.notEqual(coinFirst.items[0]?.providerCoinId, coinSecond.items[0]?.providerCoinId);
      assert.equal((await provider.coins(providerChainA, { search: 'WP11COIN',
        isBaseCurrency: true, isStake: true, limit: 10 })).items.length, 1);
      assert.equal((await provider.allCoins({ search: 'WP11COIN', providerChainId: providerChainB,
        providerState: 'MAINTENANCE', limit: 10 })).items.length, 1);

      const traverse = async <T>(fetch: (cursor?: string) => Promise<{
        items: readonly T[]; nextCursor: string | null }>) => {
        const items: T[] = []; let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          const result = await fetch(cursor); items.push(...result.items);
          if (result.nextCursor === null) return items;
          assert.notEqual(result.nextCursor, cursor); cursor = result.nextCursor;
        }
        assert.fail('provider traversal did not terminate');
      };
      const chainAsc = await traverse((cursor) => provider.chains({ search: 'WP11 Mixed Tie',
        sortBy: 'name', sortDirection: 'asc', limit: 1, cursor }));
      const chainDesc = await traverse((cursor) => provider.chains({ search: 'WP11 Mixed Tie',
        sortBy: 'name', sortDirection: 'desc', limit: 1, cursor }));
      assert.deepEqual(chainAsc.map((item) => item.providerChainId),
        [mixedChainSmall, mixedChainLarge]);
      assert.deepEqual(chainDesc.map((item) => item.providerChainId),
        [mixedChainLarge, mixedChainSmall]);
      const coinAsc = await traverse((cursor) => provider.coins(mixedChainSmall, {
        search: 'WP11MIXCOIN', sortBy: 'currencyName', sortDirection: 'asc', limit: 1, cursor }));
      const coinDesc = await traverse((cursor) => provider.coins(mixedChainSmall, {
        search: 'WP11MIXCOIN', sortBy: 'currencyName', sortDirection: 'desc', limit: 1, cursor }));
      assert.deepEqual(coinAsc.map((item) => item.providerCoinId), ['2', '10']);
      assert.deepEqual(coinDesc.map((item) => item.providerCoinId), ['10', '2']);

      const transportedDefault = walletProviderCatalogueCoinsPageQuerySchema.parse({
        search: 'WP11DEFAULT', limit: '1',
      });
      assert.equal('sortBy' in transportedDefault, false);
      const defaultCoins = await traverse((cursor) => provider.allCoins({
        ...transportedDefault, cursor }));
      assert.deepEqual(defaultCoins.map((item) =>
        `${item.chain.providerChainId}:${item.providerCoinId}`),
      [`${defaultChainA}:20`, `${defaultChainB}:10`]);
      const explicitCoinSort = await traverse((cursor) => provider.allCoins({
        search: 'WP11DEFAULT', sortBy: 'providerCoinId', sortDirection: 'asc', limit: 1, cursor }));
      assert.deepEqual(explicitCoinSort.map((item) =>
        `${item.chain.providerChainId}:${item.providerCoinId}`),
      [`${defaultChainB}:10`, `${defaultChainA}:20`]);

      const tiedAt = '2096-09-10T10:00:00.123456Z';
      for (let index = 0; index < 3; index += 1) await client.query(`INSERT INTO wallet_core.state_events
        (id,event_type,subject_type,subject_id,actor_id,payload,created_at)
        VALUES ($1,'CURRENCY.STATUS_CHANGED','CURRENCY',$2,$3,$4,$5)`,
      [ids[`event${index}`], currencyIds[index], ids.actor,
        { before: { desiredState: 'OFF' }, after: { desiredState: 'ON' }, metadata: {} }, tiedAt]);
      const history = new WalletCoreHistoryRepository(database as never);
      const historyFirst = await history.history({ eventType: 'CURRENCY.STATUS_CHANGED',
        actorId: ids.actor, from: '2096-09-10T00:00:00.000Z',
        to: '2096-09-11T00:00:00.000Z', sortDirection: 'asc', limit: 2 });
      const historySecond = await history.history({ eventType: 'CURRENCY.STATUS_CHANGED',
        actorId: ids.actor, from: '2096-09-10T00:00:00.000Z',
        to: '2096-09-11T00:00:00.000Z', sortDirection: 'asc', limit: 2,
        cursor: historyFirst.nextCursor! });
      assert.equal(new Set([...historyFirst.items, ...historySecond.items].map((item) => item.id)).size, 3);
      assert.equal((await history.history({ eventType: 'CURRENCY.STATUS_CHANGED',
        currencyId: currencyIds[0], sortDirection: 'desc', limit: 10 })).items.length, 1);
      assert.deepEqual((await history.history({ eventType: 'CURRENCY.STATUS_CHANGED',
        status: 'ACTIVE', limit: 10 })).items, []);
      assert.ok(calls.some((sql) => sql.includes('WITH history AS')));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
