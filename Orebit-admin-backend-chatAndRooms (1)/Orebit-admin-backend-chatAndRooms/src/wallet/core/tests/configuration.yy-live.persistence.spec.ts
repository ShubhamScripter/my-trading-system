import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';

import type { AdminAuditPort, WalletCoreAdminAuditInput } from '../../../admin-audits/index.js';
import { createValidatedWalletCoreTestDatabase, WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient, type WalletCorePool } from '../wallet-core.database.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { WalletConfigurationConflict } from '../wallet-core.errors.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import type { WalletAuditContext, WalletCoreSystemAuditContext } from '../wallet-core.types.js';

const URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test' && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === URL;
const ACTOR: WalletAuditContext = { actor: { kind: 'ADMIN',
  actorId: '550e8400-e29b-41d4-a716-446655440300',
  sessionId: '550e8400-e29b-41d4-a716-446655440301',
  requestId: '550e8400-e29b-41d4-a716-446655440302', ipAddress: '127.0.0.1',
  deviceId: 'task4-live' } };
const SYSTEM: WalletCoreSystemAuditContext = {
  actor: { kind: 'SYSTEM', runId: '550e8400-e29b-41d4-a716-446655440303' },
};
const LOGO_ASSETS = { async attachReferencedWithTransaction() {} };
class Client implements WalletCoreClient {
  constructor(private readonly client: pg.PoolClient, private readonly released: () => void) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ) { const result = await this.client.query(sql, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount }; }
  release() { this.released(); this.client.release(); }
}
class Pool implements WalletCorePool {
  releases = 0;
  constructor(readonly pool: pg.Pool) {}
  async connect() { return new Client(await this.pool.connect(), () => { this.releases += 1; }); }
  async end() { await this.pool.end(); }
}
class Audit implements AdminAuditPort {
  readonly calls: WalletCoreAdminAuditInput[] = [];
  constructor(private readonly fail = false) {}
  async appendWithTransaction(_tx: unknown, input: WalletCoreAdminAuditInput) {
    this.calls.push(input);
    if (this.fail) throw new Error('AUDIT_AFTER_ARCHIVE');
    return { id: '019e0000-0000-7000-8000-000000000099', replayed: false };
  }
}
const settings = (value: string) => ({ globalDesiredState: 'ON' as const,
  catalogueMode: 'ALL' as const, reconciliationIncludeTreasury: true,
  reconciliationIncludeCollection: false, reconciliationAlertPercent: value,
  defaultCurrencyIds: [] });
async function revision(pool: pg.Pool) { return Number((await pool.query(
  'SELECT revision FROM wallet_core_test.wallet_settings WHERE id')).rows[0].revision); }
async function liveId(pool: pg.Pool): Promise<string | null> { return (await pool.query(`SELECT
  id::text FROM wallet_core_test.configuration_changes WHERE status='LIVE'`)).rows[0]?.id ?? null; }
function writer(pool: Pool, audit: AdminAuditPort) { return new WalletCoreConfigurationWriter(
  new WalletCoreRepository(createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS)),
  audit, LOGO_ASSETS); }

describe('Wallet Core Task 4 one-LIVE writer', { skip: !LIVE }, () => {
  it('archives prior LIVE atomically with local-only history and restores it on failure', async () => {
    const pool = new Pool(new pg.Pool({ connectionString: URL, max: 4 }));
    try {
      const previous = await liveId(pool.pool); const audit = new Audit();
      const pushed = await writer(pool, audit).updateAtomically({ action: 'PUSH',
        expectedRevision: await revision(pool.pool), reason: 'replace live',
        config: { settings: settings('31') } }, ACTOR);
      assert.equal(await liveId(pool.pool), pushed.configurationId);
      if (previous) {
        assert.equal((await pool.pool.query(`SELECT status::text FROM
          wallet_core_test.configuration_changes WHERE id=$1`, [previous])).rows[0].status,
        'ARCHIVED');
      }
      assert.deepEqual(audit.calls.map((call) => call.action), ['SETTINGS.PUSHED']);
      const beforeRevision = await revision(pool.pool); const beforeChanges = Number((await pool.pool.query(
        'SELECT count(*) FROM wallet_core_test.configuration_changes')).rows[0].count);
      await assert.rejects(() => writer(pool, new Audit(true)).updateAtomically({ action: 'PUSH',
        expectedRevision: beforeRevision, reason: 'rollback live',
        config: { settings: settings('32') } }, ACTOR), /AUDIT_AFTER_ARCHIVE/);
      assert.equal(await liveId(pool.pool), pushed.configurationId);
      assert.equal(await revision(pool.pool), beforeRevision);
      assert.equal(Number((await pool.pool.query(
        'SELECT count(*) FROM wallet_core_test.configuration_changes')).rows[0].count), beforeChanges);
      assert.ok(pool.releases >= 2);
    } finally { await pool.end(); }
  });

  it('serializes concurrent pushes and scheduled claims to one LIVE row', async () => {
    const pool = new Pool(new pg.Pool({ connectionString: URL, max: 6 }));
    try {
      const current = await revision(pool.pool);
      const pushes = await Promise.allSettled(['33', '34'].map((threshold) =>
        writer(pool, new Audit()).updateAtomically({ action: 'PUSH', expectedRevision: current,
          reason: 'concurrent live',
          config: { settings: settings(threshold) } }, ACTOR)));
      assert.equal(pushes.filter((entry) => entry.status === 'fulfilled').length, 1);
      assert.equal(pushes.filter((entry) => entry.status === 'rejected'
        && entry.reason instanceof WalletConfigurationConflict).length, 1);
      assert.equal(Number((await pool.pool.query(`SELECT count(*) FROM
        wallet_core_test.configuration_changes WHERE status='LIVE'`)).rows[0].count), 1);
      const due = new Date(Date.now() + 60_000);
      const scheduled = await writer(pool, new Audit()).updateAtomically({ action: 'SCHEDULE',
        expectedRevision: await revision(pool.pool), reason: 'scheduled live',
        effectiveAt: due.toISOString(),
        config: { settings: settings('35') } }, ACTOR);
      const claims = await Promise.all([1, 2].map(() => writer(pool, new Audit())
        .applyScheduledChangeAtomically(scheduled.configurationId,
          new Date(due.getTime() + 1), SYSTEM)));
      assert.deepEqual(claims.map((entry) => entry.outcome).sort(),
        ['ALREADY_PROCESSED', 'SCHEDULE_APPLIED']);
      assert.equal(Number((await pool.pool.query(`SELECT count(*) FROM
        wallet_core_test.configuration_changes WHERE status='LIVE'`)).rows[0].count), 1);
    } finally { await pool.end(); }
  });
});
