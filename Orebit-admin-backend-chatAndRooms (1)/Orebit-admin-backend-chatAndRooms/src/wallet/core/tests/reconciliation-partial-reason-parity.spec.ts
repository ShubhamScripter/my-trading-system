import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { WalletCoreBootstrapPages } from '../wallet-core.bootstrap-pages.js';
import { WALLET_PARTIAL_DATA_REASONS } from '../wallet-core.types.js';

const require = createRequire(__filename);
const userReconciliation = require(resolve(__dirname,
  '../../../../../orebit-backend/src/wallet/core/reconciliation-math.ts')) as {
  RECONCILIATION_PARTIAL_REASONS: readonly string[];
  deriveReconciliationItem(input: Record<string, unknown>): {
    partialReasons: readonly string[]; shortfallSuppressed: boolean;
  };
};
const ID = { alert: '01980000-0000-7000-8000-000000000001',
  run: '01980000-0000-7000-8000-000000000002',
  item: '01980000-0000-7000-8000-000000000003',
  currency: '01980000-0000-7000-8000-000000000004' } as const;
const instant = '2026-09-10T00:00:00.000000Z';

function pagesFor(partialReasons: readonly string[], shortfallSuppressed: boolean) {
  const pages = new WalletCoreBootstrapPages({
    schemas: { wallet: 'wallet_core_test' },
  } as never, { publicUrl: (key: string) => key });
  const client = { async query() { return { rows: [{ id: ID.alert,
    category: 'PARTIAL_DATA', currency_id: ID.currency, opened_at: instant,
    updated_at: instant, total: 1, payload: { runId: ID.run, itemId: ID.item,
      currencyId: ID.currency, partialReasons: [...partialReasons], shortfallSuppressed } }],
  rowCount: 1 }; } };
  return pages.activeAlerts(client as never, undefined, 50);
}

describe('User reconciliation to Admin alert reason parity', () => {
  it('accepts the real no-custody payload emitted by User reconciliation', async () => {
    const produced = userReconciliation.deriveReconciliationItem({ hotCold: '0', staking: '0',
      binance: '0', liabilities: { userMerchant: '1', userMerchantPositive: '1',
        treasury: '0', collection: '0' }, alertBasis: 'SIGNED', includeTreasury: false,
      includeCollection: false, threshold: '5', reasons: [], priced: true,
      componentCount: 0 });
    assert.deepEqual(produced.partialReasons, ['CUSTODY_NOT_CONFIGURED']);

    const result = await pagesFor(produced.partialReasons, produced.shortfallSuppressed);

    assert.deepEqual((result.items[0] as any).payload.partialReasons,
      ['CUSTODY_NOT_CONFIGURED']);
    assert.equal((result.items[0] as any).payload.shortfallSuppressed, true);
  });

  it('keeps the complete User/Admin reason sets equal and rejects unknown reasons', async () => {
    assert.deepEqual([...WALLET_PARTIAL_DATA_REASONS].sort(),
      [...userReconciliation.RECONCILIATION_PARTIAL_REASONS].sort());
    await assert.rejects(() => pagesFor(['UNKNOWN_PARTIAL_REASON'], true),
      /WALLET_BOOTSTRAP_ROW_INVALID|WALLET_ALERT_ROW_INVALID/);
  });
});
