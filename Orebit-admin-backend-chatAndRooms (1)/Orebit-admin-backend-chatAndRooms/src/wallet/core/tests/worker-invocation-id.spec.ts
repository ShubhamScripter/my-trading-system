import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { walletWorkerInvocationId } from '../worker-invocation-id.js';

describe('Wallet worker invocation identity', () => {
  it('keeps the host identity and gives each invocation a fresh bounded owner ID', () => {
    const first = walletWorkerInvocationId('wallet-host-01');
    const second = walletWorkerInvocationId('wallet-host-01');

    assert.match(first, /^wallet-host-01:[0-9a-f]{24}$/);
    assert.match(second, /^wallet-host-01:[0-9a-f]{24}$/);
    assert.notEqual(first, second);
    assert.ok(first.length <= 128);
  });

  it('normalizes valid host input and rejects malformed or overlong identities consistently', () => {
    assert.match(walletWorkerInvocationId('  wallet-host-01  '), /^wallet-host-01:/);
    for (const value of ['', '   ', 'host\nname', 'x'.repeat(104)]) {
      assert.throws(() => walletWorkerInvocationId(value), /WALLET_WORKER_INSTANCE_ID_INVALID/);
    }
  });
});
