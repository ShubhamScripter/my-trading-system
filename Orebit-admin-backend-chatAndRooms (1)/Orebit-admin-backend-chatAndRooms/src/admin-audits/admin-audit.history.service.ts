import { Injectable } from '@nestjs/common';

import { AdminAuditHistoryRepository } from './admin-audit.history-repository.js';
import type {
  AdminAuditHistoryPage,
  AdminAuditHistoryQuery,
} from './admin-audit.types.js';

@Injectable()
export class AdminAuditHistoryService {
  constructor(private readonly repository: AdminAuditHistoryRepository) {}

  history(query: AdminAuditHistoryQuery): Promise<AdminAuditHistoryPage> {
    return this.repository.history(query);
  }
}
