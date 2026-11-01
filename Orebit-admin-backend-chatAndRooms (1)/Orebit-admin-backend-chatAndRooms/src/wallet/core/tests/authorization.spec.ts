import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Principal } from '../../../../auth/auth.types.js';
import { DatabaseBackedWalletAuthorization } from '../wallet-core.authorization.js';
import { WalletAuthorizationUnavailable } from '../wallet-core.errors.js';
import { WALLET_ADMIN_PERMISSIONS } from '../wallet-core.types.js';

const SUPER_ADMIN = {
  adminId: '01920000-0000-7000-8000-000000000010',
  sessionId: '01920000-0000-7000-8000-000000000011',
  role: 'SUPER_ADMIN',
} satisfies Principal;
const REGULAR_ADMIN = { ...SUPER_ADMIN, role: 'ADMIN' } satisfies Principal;

function fixture(current: Readonly<{ status: string; role: string }> | null | Error) {
  const calls: string[] = [];
  const admins = { async findById(adminId: string) {
    calls.push(adminId);
    if (current instanceof Error) throw current;
    return current;
  } };
  return {
    calls,
    authorization: new DatabaseBackedWalletAuthorization(admins as never),
  };
}

const rejected = (operation: Promise<void>) => assert.rejects(
  () => operation,
  (error: unknown) => error instanceof WalletAuthorizationUnavailable
    && error.code === 'wallet_authorization_unavailable' && error.status === 403,
);

describe('Wallet Core current-database authorization', () => {
  it('permits every closed permission only when the current row is active SUPER_ADMIN', async () => {
    const { authorization, calls } = fixture({ status: 'ACTIVE', role: 'SUPER_ADMIN' });
    for (const permission of WALLET_ADMIN_PERMISSIONS) {
      await authorization.require(REGULAR_ADMIN, permission);
    }
    assert.deepEqual(calls, WALLET_ADMIN_PERMISSIONS.map(() => SUPER_ADMIN.adminId));
  });

  it('rejects a stale SUPER_ADMIN token after demotion, disable, deletion, or read failure', async () => {
    for (const current of [
      { status: 'ACTIVE', role: 'ADMIN' },
      { status: 'DISABLED', role: 'SUPER_ADMIN' },
      null,
      new Error('DATABASE_DOWN'),
    ]) {
      const { authorization } = fixture(current);
      await rejected(authorization.require(SUPER_ADMIN, 'WALLET_CORE_READ'));
    }
  });

  it('rejects an invalid runtime permission before reading the Admin row', async () => {
    const { authorization, calls } = fixture({ status: 'ACTIVE', role: 'SUPER_ADMIN' });
    await rejected(authorization.require(SUPER_ADMIN, 'WALLET_UNKNOWN' as never));
    assert.deepEqual(calls, []);
  });
});
