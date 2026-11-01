import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';

import type { AdminAuditPort, WalletCoreAdminAuditInput } from '../../../admin-audits/index.js';
import { AdminAuditRepository } from '../../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../../admin-audits/admin-audit.writer.service.js';
import {
  createValidatedWalletCoreTestDatabase, WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient, type WalletCorePool,
} from '../wallet-core.database.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import type { WalletAuditContext } from '../wallet-core.types.js';

const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const ACTOR: WalletAuditContext = { actor: { kind: 'ADMIN',
  actorId: '550e8400-e29b-41d4-a716-446655440200',
  sessionId: '550e8400-e29b-41d4-a716-446655440201',
  requestId: '550e8400-e29b-41d4-a716-446655440202', ipAddress: '127.0.0.1',
  deviceId: 'task4-atomicity' } };
const LOGO_ASSETS = { async attachReferencedWithTransaction() {} };

class Client implements WalletCoreClient {
  count = 0;
  constructor(private readonly value: pg.PoolClient, private readonly failAt: number | null,
    readonly sql: string[]) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ) {
    this.count += 1; this.sql.push(sql);
    if (this.count === this.failAt) throw new Error(`DB_FAIL_${this.count}`);
    const mapped = sql.replace(
      'admin.append_admin_audit_event_v1', 'admin_test.append_admin_audit_event_v1',
    );
    const result = await this.value.query(mapped, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release() { this.value.release(); }
}
class Pool implements WalletCorePool {
  releases = 0; readonly sql: string[] = [];
  constructor(readonly value: pg.Pool, private readonly failAt: number | null = null) {}
  async connect() {
    const client = new Client(await this.value.connect(), this.failAt, this.sql);
    const release = client.release.bind(client);
    client.release = () => { this.releases += 1; release(); };
    return client;
  }
  async end() { await this.value.end(); }
}
class Audit implements AdminAuditPort {
  readonly calls: WalletCoreAdminAuditInput[] = [];
  constructor(private readonly mode: 'THROW' | 'REPLAY', private readonly at: number) {}
  async appendWithTransaction(_tx: unknown, input: WalletCoreAdminAuditInput) {
    this.calls.push(input);
    if (this.calls.length === this.at && this.mode === 'THROW') throw new Error('AUDIT_THROW');
    return { id: '01990000-0000-7000-8000-000000000099',
      replayed: this.calls.length === this.at && this.mode === 'REPLAY' };
  }
}
function entity(prefix: 'A' | 'B') {
  const base = prefix === 'A' ? '01990000-0000' : '01990001-0000';
  const providerChainId = prefix === 'A' ? 990001 : 991001;
  const providerCoinId = providerChainId + 1;
  const chain = `${base}-7000-8000-000000000001`;
  const currency = `${base}-7000-8000-000000000002`;
  const binding = `${base}-7000-8000-000000000003`;
  return { ids: { chain, currency, binding }, providerChainId, providerCoinId, config: {
    chains: [{ id: chain, providerChainId, blockchainReference: `${prefix} Atomic Chain`,
      name: `${prefix} Atomic Chain`, shortName: `${prefix}ATOMIC`,
      isEvm: true, availableFor: 'BOTH' as const, desiredState: 'ON' as const }],
    currencies: [{ id: currency, symbol: `${prefix}ATOM`, name: `${prefix} Atomic Coin`, providerRefs: [
        { provider: 'COINGECKO' as const, providerAssetId: `${prefix}-atomic-gecko`, providerSymbol: `${prefix}ATOM` },
        { provider: 'ALCHEMY' as const, providerAssetId: `${prefix}-atomic-alchemy`, providerSymbol: `${prefix}ATOM` },
        { provider: 'COINMARKETCAP' as const, providerAssetId: `${prefix}-atomic-cmc`, providerSymbol: `${prefix}ATOM` },
      ], viewEnabled: true, geoCountryDeny: [], geoContinentDeny: [], accessLevel: 'ALL' as const,
      availableFor: 'BOTH' as const, listingKind: 'PERMANENT' as const,
      showBeforeListing: false, premiumOperations: [], soOperations: [],
      postDelistOperations: [], desiredState: 'ON' as const, maintenanceAudiences: [],
      showBalanceInMaintenance: { USER: true, SO: true }, bindings: [{ id: binding, chainId: chain,
        providerCoinId, blockchainReference: `${prefix} Atomic Coin`, isToken: false,
        blockchainPrecision: 18, desiredState: 'ON' as const,
        hotWalletAddresses: [], coldWalletAddresses: [], stakingWalletAddresses: [] }],
    }],
  } };
}
async function seed(pool: pg.Pool, value: ReturnType<typeof entity>) {
  await pool.query(`INSERT INTO wallet_core_test.provider_catalogue_chains
    (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at)
    VALUES ($1,$2,$3,true,'ACTIVATED',91,now())`,
  [value.providerChainId, `${value.config.chains[0]!.name}`, value.config.chains[0]!.shortName]);
  await pool.query(`INSERT INTO wallet_core_test.provider_catalogue_currencies
    (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,
     is_stake,blockchain_precision,provider_state,revision,refreshed_at)
    VALUES ($1,$2,$3,NULL,true,true,18,'ACTIVATED',92,now())`,
  [value.providerChainId, value.providerCoinId, value.config.currencies[0]!.name]);
}
async function revision(pool: pg.Pool) {
  return Number((await pool.query('SELECT revision FROM wallet_core_test.wallet_settings WHERE id'))
    .rows[0].revision);
}
async function fingerprint(pool: pg.Pool, ids: ReturnType<typeof entity>['ids']) {
  return (await pool.query(`SELECT
    (SELECT revision FROM wallet_core_test.wallet_settings WHERE id)::text revision,
    (SELECT count(*) FROM wallet_core_test.configuration_changes)::text changes,
    (SELECT count(*) FROM wallet_core_test.state_events)::text events,
    (SELECT count(*) FROM admin_test.admin_audit_events)::text audits,
    (SELECT count(*) FROM wallet_core_test.chains WHERE id=$1)::text chains,
    (SELECT count(*) FROM price_conversion_test.currencies WHERE id=$2)::text currencies`,
  [ids.chain, ids.currency])).rows[0];
}
function writer(pool: Pool, audit: AdminAuditPort) {
  return new WalletCoreConfigurationWriter(new WalletCoreRepository(
    createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS)), audit, LOGO_ASSETS);
}

describe('Wallet Core Task 4 failure-position atomicity', { skip: !LIVE }, () => {
  it('rolls back and releases exactly once at every database query position', async () => {
    const raw = new pg.Pool({ connectionString: TEST_URL, max: 5 });
    const baseline = entity('A'); const target = entity('B');
    try {
      await seed(raw, baseline); await seed(raw, target);
      const counted = new Pool(raw);
      await writer(counted, new AdminAuditWriterService(new AdminAuditRepository()))
        .updateAtomically({ action: 'PUSH', expectedRevision: await revision(raw),
          reason: 'count database positions',
          config: baseline.config }, ACTOR);
      const positions = counted.sql.length;
      const before = await fingerprint(raw, target.ids);
      for (let at = 1; at <= positions; at += 1) {
        const failing = new Pool(raw, at);
        await assert.rejects(() => writer(failing,
          new AdminAuditWriterService(new AdminAuditRepository())).updateAtomically({
          action: 'PUSH', expectedRevision: Number(before.revision), reason: 'database failure',
          config: target.config,
        }, ACTOR), new RegExp(`DB_FAIL_${at}`));
        assert.equal(failing.releases, 1, `release at query ${at}`);
        assert.deepEqual(await fingerprint(raw, target.ids), before, `rollback at query ${at}`);
      }
      assert.ok(positions > 20, `expected full entity path, received ${positions}`);
    } finally { await raw.end(); }
  });

  it('rolls back every ordered audit throw and replay position', async () => {
    const raw = new pg.Pool({ connectionString: TEST_URL, max: 4 });
    const target = entity('B');
    try {
      const before = await fingerprint(raw, target.ids);
      for (const mode of ['THROW', 'REPLAY'] as const) for (const at of [1, 2, 3]) {
        const pool = new Pool(raw); const audit = new Audit(mode, at);
        await assert.rejects(() => writer(pool, audit).updateAtomically({ action: 'PUSH',
          expectedRevision: Number(before.revision), reason: 'audit failure',
          config: target.config }, ACTOR),
        mode === 'THROW' ? /AUDIT_THROW/ : /replay/i);
        assert.deepEqual(audit.calls.map((call) => call.action),
          ['SETTINGS.PUSHED', 'CHAIN.IMPORTED', 'CURRENCY.IMPORTED'].slice(0, at));
        assert.equal(pool.releases, 1, `${mode} release ${at}`);
        assert.deepEqual(await fingerprint(raw, target.ids), before, `${mode} rollback ${at}`);
      }
    } finally { await raw.end(); }
  });
});
