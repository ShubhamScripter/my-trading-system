import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import {
  kycHistoryAttemptQuerySchema,
  kycHistoryQuerySchema,
  type KycHistoryAttemptPayload,
  type KycHistoryPayload,
} from './kyc-history.dto';
import { KycHistoryService } from './kyc-history.service';

/**
 * Parse, delegate, serialise. No business logic and no authorisation.
 *
 * Authorisation is declared on the route (`SuperAdminGuard`), so who may reach these
 * handlers is readable off the route table rather than buried here.
 *
 * ─── No elevation, and here the reasoning is different ─────────────────────
 *
 * The other KYC surfaces defer elevation because they WRITE and the second factor has
 * not been applied to this surface yet. These two handlers write nothing at all — there
 * is no mutating method on the service or the dboperation — so the ticket would be
 * protecting a read.
 *
 * That is not the same as saying reads are harmless: this returns KYC history for any
 * account, which is sensitive personal data. The protection chosen is the one that fits
 * a read — `SuperAdminGuard` plus an audit event naming who looked and at what filter.
 */
@Injectable()
export class KycHistoryController {
  constructor(private readonly service: KycHistoryService) {}

  async list(
    query: unknown,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<KycHistoryPayload>> {
    return ok(await this.service.list(parseDto(kycHistoryQuerySchema, query), actor, client));
  }

  async attempt(
    query: unknown,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<KycHistoryAttemptPayload>> {
    return ok(
      await this.service.attempt(parseDto(kycHistoryAttemptQuerySchema, query), actor, client),
    );
  }
}
