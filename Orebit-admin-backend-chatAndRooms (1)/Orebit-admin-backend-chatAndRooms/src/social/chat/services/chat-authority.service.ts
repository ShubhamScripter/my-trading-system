import { Injectable } from '@nestjs/common';
import { AdminDbOperation } from '../../../../auth/persistence/admin.dboperation';
import { config } from '../../../config';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';

/** Enforces database-backed Super Admin role authorization on sensitive administration actions. */
@Injectable()
export class ChatAuthorityService {
  constructor(private readonly admins: AdminDbOperation) {}

  /** Throws 401 for a missing or disabled account and 403 with `detail` for anyone who is not a super admin. */
  async assertSuperAdmin(adminId: string, detail: string): Promise<void> {
    const self = await this.admins.findById(adminId);
    if (self === null || self.status !== 'ACTIVE') {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
    if (self.role !== 'SUPER_ADMIN') throw new ProblemException({ type: ERR.FORBIDDEN, detail });
  }

  // Stand-in entitlements are restricted from production environments.
  assertTestToolsAllowed(): void {
    if (config.isProduction) {
      throw new ProblemException({
        type: ERR.FORBIDDEN,
        detail: 'The test-only tools are not available in production.',
      });
    }
  }
}
