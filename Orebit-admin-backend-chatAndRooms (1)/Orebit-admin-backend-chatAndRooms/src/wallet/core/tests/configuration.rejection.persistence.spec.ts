import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';

import type {
  AdminAuditPort,
  WalletCoreAdminAuditInput,
} from '../../../admin-audits/index.js';
import {
  createValidatedWalletCoreTestDatabase,
  WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient,
  type WalletCorePool,
} from '../wallet-core.database.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import type { WalletCoreSystemAuditContext } from '../wallet-core.types.js';

const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const SYSTEM: WalletCoreSystemAuditContext = {
  actor: { kind: 'SYSTEM', runId: '550e8400-e29b-41d4-a716-446655440033' },
};
const LOGO_ASSETS = { async attachReferencedWithTransaction() {} };

class Client implements WalletCoreClient {
  constructor(private readonly value: pg.PoolClient) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ) {
    const result = await this.value.query(sql, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release() { this.value.release(); }
}

class Pool implements WalletCorePool {
  constructor(readonly value: pg.Pool) {}
  async connect() { return new Client(await this.value.connect()); }
  async end() { await this.value.end(); }
}

class Audit implements AdminAuditPort {
  readonly calls: WalletCoreAdminAuditInput[] = [];
  constructor(private readonly failure?: Error) {}
  async appendWithTransaction(
    _tx: unknown,
    input: WalletCoreAdminAuditInput,
  ) {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return { id: '01970000-0000-7000-8000-000000000099', replayed: false };
  }
}

async function insertInvalidSchedule(pool: pg.Pool, id: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = Number((await client.query(
      'SELECT revision FROM wallet_core_test.wallet_settings WHERE id FOR UPDATE',
    )).rows[0].revision);
    const revision = current + 1;
    await client.query(`UPDATE wallet_core_test.wallet_settings SET revision=$1 WHERE id`,
      [revision]);
    await client.query(`INSERT INTO wallet_core_test.configuration_changes
      (id,revision,status,reason,changelog,actor_id,snapshot)
      VALUES ($1,$2,'DRAFT','invalid stored','invalid stored',$1,$3)`,
    [id, revision, { config: { settings: { unexpected: true } },
      catalogue: { chains: [], currencies: [] } }]);
    await client.query(`UPDATE wallet_core_test.configuration_changes
      SET status='SCHEDULED',effective_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [id]);
    await client.query('COMMIT');
    return revision;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('Wallet Core stored schedule rejection', { skip: !LIVE }, () => {
  it('commits CONFIGURATION_INVALID once and rolls audit failure back for retry', async () => {
    const pool = new Pool(new pg.Pool({ connectionString: TEST_URL, max: 3 }));
    const repository = new WalletCoreRepository(createValidatedWalletCoreTestDatabase(
      pool, WALLET_CORE_TEST_SCHEMAS,
    ));
    try {
      const firstId = '01970000-0000-7000-8000-000000000001';
      const firstRevision = await insertInvalidSchedule(pool.value, firstId);
      const audit = new Audit();
      const result = await new WalletCoreConfigurationWriter(repository, audit, LOGO_ASSETS)
        .applyScheduledChangeAtomically(firstId, new Date(), SYSTEM);
      assert.deepEqual(result, {
        outcome: 'SCHEDULE_REJECTED', configurationId: firstId,
        revision: String(firstRevision), status: 'REJECTED',
        reasonCode: 'CONFIGURATION_INVALID',
      });
      assert.equal(audit.calls.length, 1);
      assert.equal(audit.calls[0]?.action, 'SETTINGS.SCHEDULE_REJECTED');
      assert.deepEqual(audit.calls[0]?.actor, SYSTEM.actor);

      const retryId = '01970000-0000-7000-8000-000000000002';
      await insertInvalidSchedule(pool.value, retryId);
      const failing = new Audit(new Error('audit unavailable'));
      await assert.rejects(() => new WalletCoreConfigurationWriter(repository, failing, LOGO_ASSETS)
        .applyScheduledChangeAtomically(retryId, new Date(), SYSTEM), /audit unavailable/);
      assert.equal((await pool.value.query(`SELECT status::text FROM
        wallet_core_test.configuration_changes WHERE id=$1`, [retryId])).rows[0].status,
      'SCHEDULED');
      const recovered = new Audit();
      assert.equal((await new WalletCoreConfigurationWriter(repository, recovered, LOGO_ASSETS)
        .applyScheduledChangeAtomically(retryId, new Date(), SYSTEM)).outcome,
      'SCHEDULE_REJECTED');
      assert.equal(recovered.calls.length, 1);
    } finally {
      await pool.end();
    }
  });
});
