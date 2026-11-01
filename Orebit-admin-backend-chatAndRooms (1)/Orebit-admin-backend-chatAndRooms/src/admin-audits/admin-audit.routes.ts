import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { requirePrincipal } from '../../auth/security/guards.js';
import { ERR } from '../contracts.js';
import { ok, parseDto, ProblemException, type SuccessEnvelope } from '../http.js';
import { adminAuditHistoryQuerySchema } from './admin-audit.dto.js';
import { AdminAuditHistoryService } from './admin-audit.history.service.js';
import type {
  AdminAuditHistoryPage,
  AdminAuditHistoryQuery,
} from './admin-audit.types.js';

@Injectable()
export class AdminAuditSuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const principal = requirePrincipal(context.switchToHttp().getRequest<FastifyRequest>());
    if (principal.role !== 'SUPER_ADMIN') {
      throw new ProblemException({ type: ERR.FORBIDDEN });
    }
    return true;
  }
}

@Controller('v1/admin/audits')
export class AdminAuditRoutes {
  constructor(private readonly service: AdminAuditHistoryService) {}

  @Get()
  @UseGuards(AdminAuditSuperAdminGuard)
  async history(@Query() query: unknown): Promise<SuccessEnvelope<AdminAuditHistoryPage>> {
    return ok(await this.service.history(
      parseDto(adminAuditHistoryQuerySchema, query) as AdminAuditHistoryQuery,
    ));
  }
}
