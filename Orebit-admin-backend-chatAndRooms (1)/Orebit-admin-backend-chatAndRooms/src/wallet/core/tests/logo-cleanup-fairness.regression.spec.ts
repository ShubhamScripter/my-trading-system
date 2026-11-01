import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WalletLogoAssetRepository } from '../logo-asset.repository.js';

const key = (value: number) => `${value.toString(16).padStart(64, '0')}.webp`;

test('a never-attempted expired logo is not starved by one hundred older poison rows', async () => {
  const poison = Array.from({ length: 100 }, (_, index) => ({
    objectKey: key(index + 1), attempts: 1, expiresAt: index,
  }));
  const good = { objectKey: key(10_000), attempts: 0, expiresAt: 101 };
  const database = {
    schemas: { wallet: 'wallet_core_test' },
    async transaction<T>(work: (client: unknown) => Promise<T>) {
      return work({
        async query(sql: string) {
          const fair = /ORDER BY asset\.delete_attempt_count,asset\.expires_at,asset\.object_key/
            .test(sql.replace(/\s+/g, ' '));
          const rows = [...poison, good].sort((left, right) => fair
            ? left.attempts - right.attempts || left.expiresAt - right.expiresAt
            : left.expiresAt - right.expiresAt);
          return { rows: rows.slice(0, 100).map((row) => ({ object_key: row.objectKey })) };
        },
      });
    },
  };

  const claimed = await new WalletLogoAssetRepository(database as never).claimExpired();

  assert.equal(claimed.objectKeys.length, 100);
  assert.equal(claimed.objectKeys.includes(good.objectKey), true);
});
