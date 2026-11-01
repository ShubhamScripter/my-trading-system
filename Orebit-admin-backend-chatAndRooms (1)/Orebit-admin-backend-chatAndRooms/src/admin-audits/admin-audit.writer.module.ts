import { Module } from '@nestjs/common';

import { AdminAuditRepository } from './admin-audit.repository.js';
import {
  ADMIN_AUDIT_PORT,
  AdminAuditWriterService,
} from './admin-audit.writer.service.js';

@Module({
  providers: [
    AdminAuditRepository,
    AdminAuditWriterService,
    { provide: ADMIN_AUDIT_PORT, useExisting: AdminAuditWriterService },
  ],
  exports: [ADMIN_AUDIT_PORT],
})
export class AdminAuditWriterModule {}
