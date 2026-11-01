import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { WalletCoreDatabase } from '../wallet-core.database.js';

// A real production PgPool/PgClient wrapper with only the native pg acquisition replaced.
for (const method of ['transaction'] as const) {
  for (const stage of ['BEGIN', 'WORK', 'COMMIT'] as const) {
    for (const rollbackFails of [false, true]) {
      test(`${method} ${stage} failure discards only when rollback fails=${rollbackFails}`, async t => {
        const original = new Error('ORIGINAL_FAILURE');
        const queries: string[] = [];
        const releases: (boolean | undefined)[] = [];
        let transactionOpen = false;
        const native = {
          async query(sql: string) {
            queries.push(sql);
            if (sql.startsWith('BEGIN')) {
              transactionOpen = true; // BEGIN may reach the server before its response is lost.
              if (stage === 'BEGIN') throw original;
            }
            if (sql === 'COMMIT' && stage === 'COMMIT') throw original;
            if (sql === 'ROLLBACK') {
              if (rollbackFails) throw new Error('ROLLBACK_FAILED');
              transactionOpen = false;
            }
            return { rows: [], rowCount: 0 };
          },
          release(discard?: boolean) { releases.push(discard); },
        };
        t.mock.method(pg.Pool.prototype, 'connect', async () => native as never);
        const database = WalletCoreDatabase.production('postgresql://unused:unused@127.0.0.1:1/wallet_runtime?schema=wallet_core');
        try {
          await assert.rejects(() => database[method](async () => {
            assert.notEqual(stage, 'BEGIN', 'work must not execute after failed BEGIN');
            if (stage === 'WORK') throw original;
            return 42;
          }), error => error === original);
          assert.deepEqual(releases, [rollbackFails ? true : undefined]);
          assert.equal(queries.filter(sql => sql === 'ROLLBACK').length, 1);
          assert.equal(transactionOpen && releases[0] !== true, false, 'uncertain transaction must never return for reuse');
        } finally { await database.close(); }
      });
    }
    test(`${method} preserves ${stage} failure even if rollback and discard release both throw`, async t => {
      const original = new Error('ORIGINAL_FAILURE');
      const releases: (boolean | undefined)[] = [];
      const native = {
        async query(sql: string) {
          if (sql.startsWith('BEGIN') && stage === 'BEGIN' || sql === 'COMMIT' && stage === 'COMMIT') throw original;
          if (sql === 'ROLLBACK') throw new Error('ROLLBACK_FAILED');
          return { rows: [], rowCount: 0 };
        },
        release(discard?: boolean) { releases.push(discard); throw new Error('RELEASE_FAILED'); },
      };
      t.mock.method(pg.Pool.prototype, 'connect', async () => native as never);
      const database = WalletCoreDatabase.production('postgresql://unused:unused@127.0.0.1:1/wallet_runtime?schema=wallet_core');
      try {
        await assert.rejects(() => database[method](async () => {
          if (stage === 'WORK') throw original;
          return 42;
        }), error => error === original);
        assert.deepEqual(releases, [true]);
      } finally { await database.close(); }
    });
  }
  test(`${method} commits successful work and normally releases its native client exactly once`, async t => {
    const queries: string[] = [];
    const releases: (boolean | undefined)[] = [];
    const native = { async query(sql: string) { queries.push(sql); return { rows: [], rowCount: 0 }; },
      release(discard?: boolean) { releases.push(discard); } };
    t.mock.method(pg.Pool.prototype, 'connect', async () => native as never);
    const database = WalletCoreDatabase.production('postgresql://unused:unused@127.0.0.1:1/wallet_runtime?schema=wallet_core');
    try {
      assert.equal(await database[method](async () => 42), 42);
      assert.equal(queries.at(-1), 'COMMIT');
      assert.deepEqual(releases, [undefined]);
    } finally { await database.close(); }
  });
  test(`${method} does not silently discard a release failure after successful commit`, async t => {
    const original = new Error('RELEASE_FAILED');
    let releases = 0;
    const native = { async query() { return { rows: [], rowCount: 0 }; },
      release() { releases++; throw original; } };
    t.mock.method(pg.Pool.prototype, 'connect', async () => native as never);
    const database = WalletCoreDatabase.production('postgresql://unused:unused@127.0.0.1:1/wallet_runtime?schema=wallet_core');
    try {
      await assert.rejects(() => database[method](async () => 42), error => error === original);
      assert.equal(releases, 1);
    } finally { await database.close(); }
  });
}
