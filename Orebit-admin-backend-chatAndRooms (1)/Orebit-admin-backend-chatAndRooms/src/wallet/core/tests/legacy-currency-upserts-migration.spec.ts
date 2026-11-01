import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const moduleRoot = resolve(__dirname, '..');
const workspace = resolve(moduleRoot, '../../../..');
const canonicalMigration = resolve(moduleRoot,
  'migrations/20260903000000_wallet_core_expand/migration.sql');
const userMigration = resolve(workspace,
  'orebit-backend/src/wallet/core/migrations/20260903000000_wallet_core_expand/migration.sql');
const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const START = '-- TASK 8 LEGACY CURRENCY UPSERTS START';
const END = '-- TASK 8 LEGACY CURRENCY UPSERTS END';

const fragment = async () => {
  const source = await readFile(canonicalMigration, 'utf8');
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  assert.ok(start >= 0 && end > start, 'Task 8 migration fragment markers are required');
  return source.slice(start + START.length, end)
    .replaceAll('price_conversion.', 'price_conversion_test.');
};

describe('Wallet Core Task 8 legacy currency upserts migration', () => {
  it('owns an identical, marked transaction fragment that restores only the Price lifecycle guard', async () => {
    const [canonical, user, sql] = await Promise.all([
      readFile(canonicalMigration), readFile(userMigration), fragment(),
    ]);
    assert.deepEqual(canonical, user);
    assert.match(sql, /DISABLE TRIGGER price_config_changes_update_guard/i);
    assert.match(sql, /ENABLE TRIGGER price_config_changes_update_guard/i);
    assert.match(sql, /status IN \('DRAFT', 'SCHEDULED'\)/i);
    assert.match(sql, /jsonb_typeof\(config->'currencyUpserts'\) = 'array'/i);
    assert.match(sql, /jsonb_array_length\(config->'currencyUpserts'\) = 0/i);
    assert.equal((sql.match(/CASE\s+WHEN\s+jsonb_typeof\(config->'currencyUpserts'\)\s*=\s*'array'\s+THEN\s+jsonb_array_length\(config->'currencyUpserts'\)\s*=\s*0\s+ELSE false END/gi) ?? []).length, 2);
    assert.match(sql, /config - 'currencyUpserts'/i);
    assert.match(sql, /SET status = 'REJECTED'/i);
  });
});

describe('Wallet Core Task 8 legacy currency upserts migration live', { skip: !LIVE }, () => {
  let pool: pg.Pool;
  before(async () => {
    const guard = await import(pathToFileURL(resolve(
      __dirname, '../provision-test-database.cjs',
    )).href) as { assertSafeWalletCoreTestDatabase(): Promise<pg.Pool> };
    pool = await guard.assertSafeWalletCoreTestDatabase();
  });
  after(async () => { if (pool) await pool.end(); });

  it('normalizes only empty DRAFT and SCHEDULED arrays, rejects invalid values, and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const actorId = randomUUID();
      const draftEmpty = { settings: { depth: { keep: 'draft' } },
        providers: { COINGECKO: { enabled: true, retry: { limit: 3 } } },
        retained: { draft: ['a', 'b'] }, currencyUpserts: [] };
      const scheduledEmpty = { settings: { depth: { keep: 'scheduled' } },
        providers: { ALCHEMY: { enabled: false, retry: { limit: 4 } } },
        retained: { scheduled: ['c', 'd'] }, currencyUpserts: [] };
      const fixtures = [
        ['DRAFT', 'DRAFT-EMPTY', null, draftEmpty],
        ['SCHEDULED', 'SCHEDULED-EMPTY', '2040-01-01T00:00:00.000Z', scheduledEmpty],
        ['DRAFT', 'DRAFT-NONEMPTY', null, { settings: { keep: true }, providers: {},
          retained: { nested: { nonempty: true } }, currencyUpserts: [{ symbol: 'BTC' }] }],
        ['SCHEDULED', 'MALFORMED-OBJECT', '2040-01-02T00:00:00.000Z',
          { settings: { keep: 'object' }, providers: {}, currencyUpserts: {} }],
        ['SCHEDULED', 'MALFORMED-STRING', '2040-01-03T00:00:00.000Z',
          { settings: { keep: 'string' }, providers: {}, currencyUpserts: 'legacy' }],
        ['SCHEDULED', 'MALFORMED-NUMBER', '2040-01-04T00:00:00.000Z',
          { settings: { keep: 'number' }, providers: {}, currencyUpserts: 1 }],
        ['SCHEDULED', 'MALFORMED-BOOLEAN', '2040-01-05T00:00:00.000Z',
          { settings: { keep: 'boolean' }, providers: {}, currencyUpserts: true }],
        ['SCHEDULED', 'MALFORMED-NULL', '2040-01-06T00:00:00.000Z',
          { settings: { keep: 'null' }, providers: {}, currencyUpserts: null }],
        ['ARCHIVED', 'ARCHIVED', null, { settings: { history: 'archived' }, providers: {},
          retained: { archived: true }, currencyUpserts: [] }],
        ['REJECTED', 'REJECTED', null, { settings: { history: 'rejected' }, providers: {},
          retained: { rejected: true }, currencyUpserts: [{ symbol: 'ETH' }] }],
      ] as const;
      const ids = new Map<string, string>();
      for (const [status, scope, effectiveAt, config] of fixtures) {
        const id = randomUUID();
        ids.set(scope, id);
        await client.query(`INSERT INTO price_conversion_test.price_config_changes
          (id,revision,status,scope_key,effective_at,changelog,actor_id,config)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [id,
          9000000000000 + ids.size, status, `TASK8-${scope}`, effectiveAt,
          `Task 8 ${scope}`, actorId, JSON.stringify(config)]);
      }
      const liveId = (await client.query(`SELECT id::text FROM price_conversion_test.price_config_changes
        WHERE status='LIVE'`)).rows[0].id;
      await client.query(`ALTER TABLE price_conversion_test.price_config_changes
        DISABLE TRIGGER price_config_changes_update_guard`);
      await client.query(`UPDATE price_conversion_test.price_config_changes
        SET changelog=$2,config = config || jsonb_build_object('retained',
          '{"live":true}'::jsonb,'currencyUpserts','[]'::jsonb) WHERE id=$1`,
      [liveId, `Task 8 LIVE ${liveId}`]);
      await client.query(`ALTER TABLE price_conversion_test.price_config_changes
        ENABLE TRIGGER price_config_changes_update_guard`);
      ids.set('LIVE', liveId);
      const readRows = async () => (await client.query(`SELECT id::text,revision::text,
        status::text,effective_at::text AS effective_at,changelog,actor_id::text AS actor_id,
        config::text AS config,created_at::text AS created_at,applied_at::text AS applied_at
        FROM price_conversion_test.price_config_changes WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[...ids.values()]])).rows;
      const beforeRows = await readRows();
      const before = new Map(beforeRows.map((row) => [row.id, row]));
      const sql = await fragment();
      await client.query(sql);
      const afterRows = await readRows();
      const after = new Map(afterRows.map((row) => [row.id, row]));
      const row = (source: Map<string, any>, scope: string) => source.get(ids.get(scope)!);
      for (const [scope, expected] of [['DRAFT-EMPTY', draftEmpty], ['SCHEDULED-EMPTY', scheduledEmpty]] as const) {
        const row = after.get(ids.get(scope)!);
        const prior = before.get(ids.get(scope)!);
        assert.ok(row && prior);
        assert.deepEqual({ ...row, config: undefined }, { ...prior, config: undefined });
        const { currencyUpserts: ignored, ...withoutLegacy } = expected;
        assert.deepEqual(JSON.parse(row.config), withoutLegacy);
      }
      for (const scope of ['DRAFT-NONEMPTY', 'MALFORMED-OBJECT', 'MALFORMED-STRING',
        'MALFORMED-NUMBER', 'MALFORMED-BOOLEAN', 'MALFORMED-NULL']) {
        const row = after.get(ids.get(scope)!);
        const prior = before.get(ids.get(scope)!);
        assert.ok(row && prior);
        assert.deepEqual({ ...row, status: undefined }, { ...prior, status: undefined });
        assert.equal(row.status, 'REJECTED');
      }
      for (const scope of ['LIVE', 'ARCHIVED', 'REJECTED']) {
        const current = row(after, scope);
        const prior = row(before, scope);
        assert.ok(current && prior, `missing exact historical fixture ${scope}`);
        assert.deepEqual(current, prior);
      }
      await client.query(sql);
      assert.deepEqual(await readRows(), afterRows);
      assert.deepEqual((await client.query(`SELECT tgenabled FROM pg_trigger
        WHERE tgrelid='price_conversion_test.price_config_changes'::regclass
          AND tgname='price_config_changes_update_guard'`)).rows, [{ tgenabled: 'O' }]);
      const guardedId = randomUUID();
      await client.query(`INSERT INTO price_conversion_test.price_config_changes
        (id,revision,status,scope_key,changelog,actor_id,config)
        VALUES ($1,9000000000100,'DRAFT','TASK8-GUARD','Task 8 guard',$2,'{}')`,
      [guardedId, actorId]);
      await assert.rejects(() => client.query(`UPDATE price_conversion_test.price_config_changes
        SET config='{"changed":true}' WHERE id=$1`, [guardedId]),
      /identity and payload are immutable/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
