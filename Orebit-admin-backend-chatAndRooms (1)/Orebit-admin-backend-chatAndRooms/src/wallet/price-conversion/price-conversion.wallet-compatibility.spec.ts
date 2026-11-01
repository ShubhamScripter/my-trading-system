import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';

const ROOT = process.cwd();
const WORKSPACE = resolve(ROOT, '../../../..');
const TEST_URL = process.env.PRICE_TEST_DATABASE_URL ?? '';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.PRICE_TEST_ALLOW_RESET === 'true'
  && (() => {
    try {
      const url = new URL(TEST_URL);
      return url.hostname === '127.0.0.1' && url.port === '55433'
        && decodeURIComponent(url.pathname.slice(1)) === 'orebit_price_test'
        && url.searchParams.get('schema') === 'price_conversion_test';
    } catch { return false; }
  })();

const resolver = (sql: string): string => {
  const body = /CREATE OR REPLACE FUNCTION price_conversion\.resolve_money_batch_for_ledger\(currency_ids UUID\[\]\)[\s\S]*?REVOKE ALL ON FUNCTION price_conversion\.resolve_money_batch_for_ledger\(UUID\[\]\) FROM PUBLIC;/.exec(sql)?.[0];
  if (!body) throw new Error('LEDGER_PRICE_RESOLVER_MISSING');
  return body;
};

describe('standalone Price Wallet compatibility overlay', () => {
  it('keeps ownership and compatibility proofs in both default package gates', async () => {
    const adminPackage = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Readonly<Record<string, string>>;
    };
    const userPackage = JSON.parse(await readFile(resolve(WORKSPACE,
      'orebit-backend/src/wallet/price-conversion/package.json'), 'utf8')) as {
      scripts?: Readonly<Record<string, string>>;
    };
    assert.match(adminPackage.scripts?.test ?? '', /price-conversion\.ownership\.spec\.js/);
    assert.match(adminPackage.scripts?.test ?? '', /price-conversion\.wallet-compatibility\.spec\.js/);
    assert.match(userPackage.scripts?.test ?? '', /^npm run test:overlay &&/);
    assert.match(userPackage.scripts?.test ?? '', /tests\/ownership\.test\.ts/);
  });

  it('keeps overlays and Wallet migrations byte-identical with only the 00012 status adaptation',
    async () => {
      const paths = {
        adminOverlay: resolve(ROOT, 'test-wallet-compatibility-overlay.sql'),
        userOverlay: resolve(WORKSPACE,
          'orebit-backend/src/wallet/price-conversion/test-wallet-compatibility-overlay.sql'),
        adminWallet: resolve(WORKSPACE,
          'admin-backend/src/wallet/core/migrations/20260903000000_wallet_core_expand/migration.sql'),
        userWallet: resolve(WORKSPACE,
          'orebit-backend/src/wallet/core/migrations/20260903000000_wallet_core_expand/migration.sql'),
        price00012: resolve(ROOT,
          'migrations/20260901000012_revision_and_view_cadence/migration.sql'),
      };
      const [adminOverlay, userOverlay, adminWallet, userWallet, price00012] = await Promise.all(
        Object.values(paths).map((path) => readFile(path, 'utf8')),
      );
      assert.ok(adminOverlay && userOverlay && adminWallet && userWallet && price00012);
      assert.equal(adminOverlay, userOverlay);
      assert.equal(adminWallet, userWallet);
      const expected = resolver(price00012).replaceAll('c.status', 'c.pricing_status');
      assert.equal(resolver(adminOverlay), expected);
      assert.equal(resolver(adminWallet), expected);
      assert.match(expected, /c\.pricing_status = 'DISABLED'/);
      assert.match(expected, /c\.pricing_status = 'ACTIVE'/);
      assert.doesNotMatch(expected, /\bc\.status\b/);
    });

  it('executes the overlaid Ledger resolver in both dedicated Price schemas', { skip: !LIVE },
    async () => {
      const client = new pg.Client({ connectionString: TEST_URL });
      await client.connect();
      try {
        for (const schema of ['price_conversion_test', 'price_conversion'] as const) {
          const definition = String((await client.query(`SELECT pg_get_functiondef(
            to_regprocedure('${schema}.resolve_money_batch_for_ledger(uuid[])')) definition`)
          ).rows[0]?.definition);
          assert.match(definition, /c\.pricing_status = 'DISABLED'/);
          assert.match(definition, /c\.pricing_status = 'ACTIVE'/);
          assert.doesNotMatch(definition, /\bc\.status\b/);
          assert.deepEqual((await client.query(`SELECT * FROM
            ${schema}.resolve_money_batch_for_ledger(ARRAY[]::uuid[])`)).rows, []);
          assert.equal((await client.query(`SELECT has_function_privilege('public',
            '${schema}.resolve_money_batch_for_ledger(uuid[])','EXECUTE') allowed`)
          ).rows[0]?.allowed, false);
        }
      } finally {
        await client.end();
      }
    });
});
