import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { describe, it } from 'node:test';
import pg from 'pg';

import { AdminAuditRepository } from '../../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../../admin-audits/admin-audit.writer.service.js';
import { uuidv7 } from '../../../utils/public.utils.js';
import {
  createValidatedWalletCoreTestDatabase,
  WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient,
  type WalletCorePool,
} from '../wallet-core.database.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';
import { resolveProviderMaintenanceObservation } from '../wallet-core.policy.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import type { WalletAuditContext, WalletCorePatch } from '../wallet-core.types.js';

const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const AUDIT_TOKEN = 'admin.append_admin_audit_event_v1';
const ADMIN_TOKEN = 'admin_test.append_admin_audit_event_v1';
const ACTOR: WalletAuditContext = { actor: {
  kind: 'ADMIN', actorId: '550e8400-e29b-41d4-a716-446655440000',
  sessionId: '550e8400-e29b-41d4-a716-446655440001',
  requestId: '550e8400-e29b-41d4-a716-446655440002', ipAddress: '127.0.0.1',
  deviceId: 'currency-chain-pin-test',
} };
const LOGO_ASSETS = { async attachReferencedWithTransaction() {} };

const rewriteAuditSql = (sql: string): string => sql.replace(AUDIT_TOKEN, ADMIN_TOKEN);

class AuditMappedClient implements WalletCoreClient {
  constructor(private readonly client: pg.PoolClient) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ) {
    const result = await this.client.query(rewriteAuditSql(sql), values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release(): void { this.client.release(); }
}

class AuditMappedPool implements WalletCorePool {
  constructor(readonly pool: pg.Pool) {}
  async connect(): Promise<WalletCoreClient> { return new AuditMappedClient(await this.pool.connect()); }
  async end(): Promise<void> { await this.pool.end(); }
}

const currentRevision = async (pool: pg.Pool): Promise<number> => Number((await pool.query(
  'SELECT revision FROM wallet_core_test.wallet_settings WHERE id',
)).rows[0].revision);

const patch = (expectedRevision: number, providerPins: unknown[]): WalletCorePatch => ({
  action: 'PUSH', expectedRevision, reason: 'currency-chain pin',
  config: { providerPins: providerPins as never },
});

async function seedBinding(pool: pg.Pool): Promise<Readonly<{ chainId: string; bindingId: string }>> {
  const chainId = uuidv7(); const bindingId = uuidv7();
  const currency = (await pool.query('SELECT id::text FROM price_conversion_test.currencies ORDER BY id LIMIT 1'))
    .rows[0]?.id;
  if (typeof currency !== 'string') throw new Error('TEST_CURRENCY_MISSING');
  const providerChainId = randomInt(8_000_000_000_000, 8_000_001_000_000);
  assert.equal(Number.isSafeInteger(Number(providerChainId)), true);
  await pool.query(`INSERT INTO wallet_core_test.chains
    (id,provider_chain_id,name,short_name,is_evm,desired_state,provider_state)
    VALUES ($1,$2,$3,$4,true,'ON','ACTIVATED')`,
  [chainId, providerChainId, 'Currency Chain Pin', `PIN${bindingId.slice(-8).toUpperCase()}`]);
  await pool.query(`INSERT INTO wallet_core_test.currencies
    (id,currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision,desired_state,provider_state)
    VALUES ($1,$2,$3,$4,false,true,18,'ON','ACTIVATED')`,
  [bindingId, currency, chainId, providerChainId + 1]);
  return { chainId, bindingId };
}

const pinEvents = async (pool: pg.Pool, table: 'state_events' | 'admin_audit_events', id: string) =>
  (await pool.query(`SELECT ${table === 'state_events' ? 'event_type' : 'action AS event_type'},
    subject_type,subject_id::text FROM ${table === 'state_events'
    ? 'wallet_core_test.state_events' : 'admin_test.admin_audit_events'}
    WHERE subject_id=$1 AND ${table === 'state_events' ? 'event_type' : 'action'}
      LIKE 'PROVIDER_MAINTENANCE.%' ORDER BY created_at,id`, [id])).rows;

describe('Wallet Core currency-chain provider pins', { skip: !LIVE }, () => {
  it('pins only one binding, records its subject, recovers through the pin, and unpins automatically', async () => {
    const raw = new pg.Pool({ connectionString: TEST_URL, max: 4 });
    const pool = new AuditMappedPool(raw);
    const writer = new WalletCoreConfigurationWriter(
      new WalletCoreRepository(createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS)),
      new AdminAuditWriterService(new AdminAuditRepository()),
      LOGO_ASSETS,
    );
    try {
      const { chainId, bindingId } = await seedBinding(raw);
      await writer.updateAtomically(patch(await currentRevision(raw), [{
        subject: 'CURRENCY_CHAIN', subjectId: bindingId, pinned: true,
      }]), ACTOR);
      assert.equal((await raw.query(`SELECT maintenance_pinned FROM wallet_core_test.currencies
        WHERE id=$1`, [bindingId])).rows[0].maintenance_pinned, true);
      const expectedPinned = [{ event_type: 'PROVIDER_MAINTENANCE.PINNED',
        subject_type: 'CURRENCY_CHAIN', subject_id: bindingId }];
      assert.deepEqual(await pinEvents(raw, 'state_events', bindingId), expectedPinned);
      assert.deepEqual(await pinEvents(raw, 'admin_audit_events', bindingId), expectedPinned);
      assert.equal(resolveProviderMaintenanceObservation({ previousProviderState: 'UNAVAILABLE',
        failureStreak: 3, desiredState: 'ON', maintenancePinned: true, outcome: 'ACTIVATED',
      }).effectiveState, 'MAINTAIN');

      await writer.updateAtomically(patch(await currentRevision(raw), [{
        subject: 'CURRENCY_CHAIN', subjectId: bindingId, pinned: false,
      }]), ACTOR);
      assert.equal((await raw.query(`SELECT maintenance_pinned FROM wallet_core_test.currencies
        WHERE id=$1`, [bindingId])).rows[0].maintenance_pinned, false);
      assert.deepEqual(await pinEvents(raw, 'state_events', bindingId), [...expectedPinned, {
        event_type: 'PROVIDER_MAINTENANCE.UNPINNED', subject_type: 'CURRENCY_CHAIN', subject_id: bindingId,
      }]);
      assert.equal(resolveProviderMaintenanceObservation({ previousProviderState: 'UNAVAILABLE',
        failureStreak: 3, desiredState: 'ON', maintenancePinned: false, outcome: 'ACTIVATED',
      }).effectiveState, 'ON');

      await writer.updateAtomically(patch(await currentRevision(raw), [{
        subject: 'CHAIN', subjectId: chainId, pinned: true,
      }]), ACTOR);
      assert.deepEqual(await pinEvents(raw, 'state_events', chainId), [{
        event_type: 'PROVIDER_MAINTENANCE.PINNED', subject_type: 'CHAIN', subject_id: chainId,
      }]);
      const eventsBeforeNoop = await pinEvents(raw, 'state_events', bindingId);
      await writer.updateAtomically(patch(await currentRevision(raw), [{
        subject: 'CURRENCY_CHAIN', subjectId: bindingId, pinned: false,
      }]), ACTOR);
      assert.deepEqual(await pinEvents(raw, 'state_events', bindingId), eventsBeforeNoop);

      const invalidRevision = await currentRevision(raw);
      await assert.rejects(() => writer.updateAtomically(patch(invalidRevision, [{
        subject: 'CURRENCY', subjectId: bindingId, pinned: true,
      }]), ACTOR), WalletConfigurationInvalid);
    } finally {
      await pool.end();
    }
  });
});
