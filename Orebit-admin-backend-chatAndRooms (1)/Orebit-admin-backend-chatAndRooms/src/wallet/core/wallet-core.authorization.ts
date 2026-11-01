import type { Principal } from '../../../auth/auth.types.js';
import type { AdminDbOperation } from '../../../auth/auth.dboperation.js';
import { WalletAuthorizationUnavailable } from './wallet-core.errors.js';
import type {
  WalletAdminAuthorizationPort,
  WalletAdminPermission,
} from './wallet-core.types.js';
import { WALLET_ADMIN_PERMISSIONS } from './wallet-core.types.js';

/** Rechecks current Admin state so a stale access-token role cannot retain or delay authority. */
export class DatabaseBackedWalletAuthorization implements WalletAdminAuthorizationPort {
  constructor(private readonly admins: Pick<AdminDbOperation, 'findById'>) {}

  async require(principal: Principal, permission: WalletAdminPermission): Promise<void> {
    if (!WALLET_ADMIN_PERMISSIONS.includes(permission)) throw new WalletAuthorizationUnavailable();
    let current;
    try { current = await this.admins.findById(principal.adminId); }
    catch { throw new WalletAuthorizationUnavailable(); }
    if (current?.status !== 'ACTIVE' || current.role !== 'SUPER_ADMIN') {
      throw new WalletAuthorizationUnavailable();
    }
  }
}

/** Fail-closed adapter for isolated tests; production rechecks the current SuperAdmin record. */
export class SuperAdminOnlyWalletAuthorization implements WalletAdminAuthorizationPort {
  async require(principal: Principal, _permission: WalletAdminPermission): Promise<void> {
    if (principal.role !== 'SUPER_ADMIN') throw new WalletAuthorizationUnavailable();
  }
}
