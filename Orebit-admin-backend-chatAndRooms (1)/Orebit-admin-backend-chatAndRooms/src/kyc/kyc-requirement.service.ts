import { Injectable, Logger } from '@nestjs/common';
import { AUTH_EVENT, AuthEventDbOperation } from '../../auth/auth.dboperation';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import {
  KycRequirementDbOperation,
  type KycRequirementRow,
} from './kyc-requirement.dboperation';
import type {
  KycRequirementQuery,
  KycRequirementRequireRequest,
  KycRequirementWaiveRequest,
  KycRequirementsPayload,
} from './kyc-requirement.dto';
import {
  ADMIN_TRIGGER_KIND,
  KYC_POLICY_LEVELS,
  adminTriggerKey,
  type KycRequirementView,
} from './kyc.types';

/**
 * ═══ IMPOSING AND DISCHARGING A KYC OBLIGATION ═════════════════════════════
 *
 * The administrative half of the requirement lifecycle. The other half — raising an
 * obligation because of something the account DID, and closing one because a provider
 * approved a verification — belongs to ../Orebit-backend and is untouched by this
 * surface.
 *
 * ─── What this service records, and what it refuses to decide ──────────────
 *
 * It records that an account owes a verification at a level. It does NOT decide
 * whether that obligation currently bites, and nothing here reads
 * `kyc_level_states`, `kyc_exemptions` or `kyc_renewal_settings`.
 *
 * That is not squeamishness, it is the single-authority rule. Answering "does this
 * account already hold the level" requires `effectiveLevel`: provider-attested
 * credentials folded with a live exemption, each level's own renewal clock, the L1→L2
 * ladder and the supersession flag. All of it lives in the consumer's
 * `kyc.validity.ts` and `kyc.profile.ts`, all of it changes when an admin edits the
 * global renewal periods, and a copy here would be a second answer waiting to
 * disagree with the evaluator actually gating the user.
 *
 * So the row goes in unconditionally and `evaluate` over there filters open
 * requirements by `!satisfiesLevel(heldLevel, requiredLevel)`. A requirement imposed
 * on an account whose credential already satisfies it stays open, contributes nothing,
 * and becomes effective by itself the day that credential lapses. Nothing has to
 * remember to revisit it.
 *
 * ─── The audit event is not the record of the mutation ─────────────────────
 *
 * `AuthEventDbOperation.record` swallows its own failures by design — an admin action
 * must not fail because the audit table would not take a row. So the DATABASE WRITE IS
 * AUTHORITATIVE and the event is observability. Every write below therefore commits
 * first and audits afterwards, and the response reports what the database did.
 */
@Injectable()
export class KycRequirementService {
  private readonly logger = new Logger('KycRequirement');

  constructor(
    private readonly requirements: KycRequirementDbOperation,
    private readonly events: AuthEventDbOperation,
  ) {}

  /** One account's obligations, open and closed. A pure read — it audits nothing,
   *  matching `kyc-policies` and `kyc-exemptions`; the sensitive read on this module
   *  is KYC HISTORY, which audits because it returns provider decisions. */
  async list(query: KycRequirementQuery): Promise<KycRequirementsPayload> {
    const rows = await this.requirements.listForUser(query.userId, query.limit);
    return { requirements: rows.map(toView), levels: [...KYC_POLICY_LEVELS] };
  }

  /**
   * Impose an obligation.
   *
   * ─── `created: false` is a success ────────────────────────────────────────
   *
   * Idempotency, not a conflict. The admin asked for this account to owe this case,
   * and it does — whether this call is what made it so is an audit detail, not an
   * error. Answering 409 would make a retried request look like a failure and invite a
   * client to "fix" it by inventing a second reference.
   */
  async require(
    input: KycRequirementRequireRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycRequirementsPayload> {
    // Throws only on a reference the DTO would already have refused — see
    // `adminTriggerKey`. Built here rather than in the dboperation so the SQL layer
    // receives a finished key and owns no grammar.
    const triggerKey = adminTriggerKey(input.reference);

    const outcome = await this.requirements.require({
      userId: input.userId,
      requiredLevel: input.requiredLevel,
      triggerKind: ADMIN_TRIGGER_KIND,
      triggerKey,
    });

    if (!outcome.ok) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No such account.' });
    }

    // WARN rather than log: this places a permanent obligation on a named account that
    // nothing but an approved verification or an explicit waiver will lift.
    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        userId: input.userId,
        requirementId: outcome.row.id,
        requiredLevel: input.requiredLevel,
        triggerKey,
        created: outcome.created,
      },
      outcome.created ? 'kyc requirement imposed by admin' : 'kyc requirement already stood',
    );

    await this.events.record({
      eventType: AUTH_EVENT.KYC_REQUIREMENT_RAISED,
      // The ACTOR, never the subject. The subject is in `metadata.userId`.
      adminId: actor.adminId,
      client,
      metadata: {
        userId: input.userId,
        requirementId: outcome.row.id,
        requiredLevel: input.requiredLevel,
        triggerKey,
        reference: input.reference,
        created: outcome.created,
        reason: input.reason,
      },
    });

    return this.list({ userId: input.userId, limit: 50 });
  }

  /**
   * Discharge an obligation.
   *
   * ─── Two refusals, two instructions ──────────────────────────────────────
   *
   * `not_found` covers both "no such requirement" and "it belongs to another account",
   * deliberately: telling them apart would confirm that an id exists and make this an
   * oracle for enumeration. `KycExemptionService.revoke` draws the line identically.
   *
   * `already_closed` is a STALE PAYLOAD rather than a missing row — the operator is
   * looking at an old screen and the remedy is to re-read — so it is reported as a 400
   * on `requirementId`, the shape `KycPolicyService.assertWritten` uses for a lost
   * compare-and-swap. Not 409: nothing about waiting changes the answer.
   *
   * The two closed states are named in the message, because they call for different
   * follow-ups: an obligation the USER discharged by verifying needs no waiver, while
   * one another admin already waived means the work is done.
   */
  async waive(
    input: KycRequirementWaiveRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycRequirementsPayload> {
    const outcome = await this.requirements.waive({
      userId: input.userId,
      requirementId: input.requirementId,
      actorAdminId: actor.adminId,
    });

    if (!outcome.ok) {
      if (outcome.reason === 'not_found') {
        throw new ProblemException({
          type: ERR.NOT_FOUND,
          detail: 'No such requirement for this account.',
        });
      }

      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'requirementId',
            message:
              outcome.satisfiedAt !== null
                ? 'This requirement was already discharged by an approved verification, ' +
                  'so there is nothing to waive. Re-read the requirements.'
                : 'This requirement has already been waived. Re-read the requirements.',
          },
        ],
      });
    }

    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        userId: input.userId,
        requirementId: input.requirementId,
        requiredLevel: outcome.row.required_level,
        triggerKey: outcome.row.trigger_key,
      },
      'kyc requirement waived by admin',
    );

    await this.events.record({
      eventType: AUTH_EVENT.KYC_REQUIREMENT_WAIVED,
      adminId: actor.adminId,
      client,
      metadata: {
        userId: input.userId,
        requirementId: input.requirementId,
        requiredLevel: outcome.row.required_level,
        triggerKey: outcome.row.trigger_key,
        outcome: 'waived',
        reason: input.reason,
      },
    });

    return this.list({ userId: input.userId, limit: 50 });
  }
}

/** A stored row, as a screen reads it. Instants are ISO strings at the boundary. */
function toView(row: KycRequirementRow): KycRequirementView {
  const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

  return {
    id: row.id,
    userId: row.user_id,
    requiredLevel: row.required_level,
    triggerKind: row.trigger_kind,
    triggerKey: row.trigger_key,
    satisfiedAt: iso(row.satisfied_at),
    satisfiedByVerificationId: row.satisfied_by_verification_id,
    waivedAt: iso(row.waived_at),
    waivedBy: row.waived_by,
    policyRegion: row.policy_region,
    policyVersion: row.policy_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    open: row.open,
  };
}
