import { Injectable } from '@nestjs/common';

import {
  buildDepositAdminAuditEvent,
  buildPriceConversionAdminAuditEvent,
  buildWalletCoreAdminAuditEvent,
} from './admin-audit.payloads.js';
import { AdminAuditRepository } from './admin-audit.repository.js';
import type {
  AdminAuditAppendResult,
  AdminAuditPort,
  AdminAuditTransaction,
  DepositAdminAuditInput,
  PriceConversionAdminAuditInput,
  WalletCoreAdminAuditInput,
} from './admin-audit.types.js';

export const ADMIN_AUDIT_PORT = Symbol('ADMIN_AUDIT_PORT');

@Injectable()
export class AdminAuditWriterService implements AdminAuditPort {
  constructor(private readonly repository: AdminAuditRepository) {}

  appendWithTransaction(
    tx: AdminAuditTransaction,
    input: WalletCoreAdminAuditInput | DepositAdminAuditInput | PriceConversionAdminAuditInput,
  ): Promise<AdminAuditAppendResult> {
    const event = input.domain === 'WALLET_CORE'
      ? buildWalletCoreAdminAuditEvent(input)
      : input.domain === 'PRICE_CONVERSION'
        ? buildPriceConversionAdminAuditEvent(input)
        : buildDepositAdminAuditEvent(input);
    return this.repository.appendPreparedWithTransaction(tx, event);
  }
}
