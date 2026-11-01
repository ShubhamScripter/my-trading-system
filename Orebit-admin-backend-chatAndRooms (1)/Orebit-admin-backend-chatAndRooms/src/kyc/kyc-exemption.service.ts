import { Injectable, Logger } from '@nestjs/common';
import { AUTH_EVENT, AuthEventDbOperation } from '../../auth/auth.dboperation';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import {
  KycExemptionDbOperation,
  type KycExemptionRow,
} from './kyc-exemption.dboperation';
import type {
  KycExemptionGrantRequest,
  KycExemptionQuery,
  KycExemptionRevokeRequest,
  KycExemptionsPayload,
} from './kyc-exemption.dto';
import { KYC_POLICY_LEVELS, type KycExemptionView } from './kyc.types';

/**
 * ═══ ADMINISTRATIVE RELIEF FROM A KYC OBLIGATION ═══════════════════════════
 *
 * An exemption grants an EFFECTIVE level. It does NOT write a verification and does
 * NOT move `kyc_profiles.current_level`, so nothing in the database ever claims a
 * provider verified somebody it did not — "verified" and "exempted" stay separable in
 * every export, which is the property a regulator asks about. The consumer merges the
 * two on read, every time, and leaves no trace saying otherwise.
 *
 * Every write here is elevated per action and audited. The reason it deserves more
 * care than a policy edit: a policy misconfiguration over-obligates people, which is
 * loud, while an exemption quietly raises one account's standing platform-wide.
 */
@Injectable()
export class KycExemptionService {
  private readonly logger = new Logger('KycExemption');

  constructor(
    private readonly exemptions: KycExemptionDbOperation,
    private readonly events: AuthEventDbOperation,
  ) {}

  /** One account's history, or every account currently holding relief. */
  async list(query: KycExemptionQuery): Promise<KycExemptionsPayload> {
    const rows =
      query.userId === undefined
        ? await this.exemptions.listLive(query.limit)
        : await this.exemptions.listForUser(query.userId, query.limit);

    return { exemptions: rows.map(toView), levels: [...KYC_POLICY_LEVELS] };
  }

  /**
   * Grant an exemption.
   *
   * The refusal to know about: an account that already holds a LIVE exemption is
   * refused rather than silently replaced. See `ERR.KYC_EXEMPTION_ACTIVE`.
   *
   * An account whose exemption merely EXPIRED is not refused — the persistence layer
   * closes the lapsed row first, because it occupies the account's one slot while
   * granting nothing. Without that, a lapsed exemption would be a permanent bar to
   * ever granting another.
   */
  async grant(
    input: KycExemptionGrantRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycExemptionsPayload> {
    const outcome = await this.exemptions.grant({
      userId: input.userId,
      effectiveLevel: input.effectiveLevel,
      reason: input.reason,
      expiresAt: input.expiresAt,
      actorAdminId: actor.adminId,
    });

    if (!outcome.ok) {
      if (outcome.reason === 'unknown_user') {
        throw new ProblemException({
          type: ERR.NOT_FOUND,
          detail: 'No such account.',
        });
      }
      throw new ProblemException({
        type: ERR.KYC_EXEMPTION_ACTIVE,
        detail:
          'This account already holds a live exemption. Revoke it first, then grant the ' +
          'replacement — so the record shows which grant was in force when.',
      });
    }

    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        userId: input.userId,
        exemptionId: outcome.id,
        effectiveLevel: input.effectiveLevel,
        permanent: input.expiresAt === null,
        supersededExpired: outcome.supersededExpired,
      },
      'kyc exemption granted',
    );

    await this.events.record({
      eventType: AUTH_EVENT.KYC_EXEMPTION_GRANTED,
      // The ACTOR, never the subject. The subject is in `metadata.userId`.
      adminId: actor.adminId,
      client,
      metadata: {
        userId: input.userId,
        exemptionId: outcome.id,
        effectiveLevel: input.effectiveLevel,
        expiresAt: input.expiresAt,
        supersededExpired: outcome.supersededExpired,
      },
    });

    return this.list({ userId: input.userId, limit: 50 });
  }

  /**
   * Withdraw an exemption.
   *
   * A row that does not exist, and a row belonging to another account, answer the SAME
   * `not_found` — confirming existence would make this an oracle for enumerating
   * exemption ids. A row that is already revoked is a stale payload rather than a
   * missing one, so it says so on `exemptionId`, matching how a lost compare-and-swap
   * is reported.
   */
  async revoke(
    input: KycExemptionRevokeRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycExemptionsPayload> {
    const outcome = await this.exemptions.revoke({
      userId: input.userId,
      exemptionId: input.exemptionId,
      reason: input.reason,
      actorAdminId: actor.adminId,
    });

    if (!outcome.ok) {
      if (outcome.reason === 'not_found') {
        throw new ProblemException({
          type: ERR.NOT_FOUND,
          detail: 'No such exemption for this account.',
        });
      }
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'exemptionId',
            message: `This exemption was already revoked at ${outcome.revokedAt.toISOString()}.`,
          },
        ],
      });
    }

    this.logger.warn(
      { actorAdminId: actor.adminId, userId: input.userId, exemptionId: input.exemptionId },
      'kyc exemption revoked',
    );

    await this.events.record({
      eventType: AUTH_EVENT.KYC_EXEMPTION_REVOKED,
      adminId: actor.adminId,
      client,
      metadata: { userId: input.userId, exemptionId: input.exemptionId },
    });

    return this.list({ userId: input.userId, limit: 50 });
  }
}

function toView(row: KycExemptionRow): KycExemptionView {
  return {
    id: row.id,
    userId: row.user_id,
    effectiveLevel: row.effective_level,
    reason: row.reason,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
    live: row.live,
  };
}
