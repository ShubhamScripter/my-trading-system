import { Module } from '@nestjs/common';

import { AdminAuditDatabase } from './admin-audit.database.js';
import { AdminAuditHistoryRepository } from './admin-audit.history-repository.js';
import { AdminAuditHistoryService } from './admin-audit.history.service.js';
import { AdminAuditRoutes, AdminAuditSuperAdminGuard } from './admin-audit.routes.js';

@Module({
  controllers: [AdminAuditRoutes],
  providers: [
    AdminAuditDatabase,
    AdminAuditHistoryRepository,
    AdminAuditHistoryService,
    AdminAuditSuperAdminGuard,
  ],
})
export class AdminAuditHistoryModule {}
