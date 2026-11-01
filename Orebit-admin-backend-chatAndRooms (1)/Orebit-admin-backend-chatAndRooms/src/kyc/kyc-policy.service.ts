import { Injectable, Logger } from '@nestjs/common';
import { AUTH_EVENT, AuthEventDbOperation } from '../../auth/auth.dboperation';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import {
  KycPolicyDbOperation,
  type KycPolicyRow,
  type KycPolicyVersionRow,
  type KycPolicyWriteOutcome,
} from './kyc-policy.dboperation';
import type {
  KycPoliciesPayload,
  KycPolicyDeleteRequest,
  KycPolicyHistoryPayload,
  KycPolicyHistoryQuery,
  KycPolicyUpsertRequest,
} from './kyc-policy.dto';
import {
  enforcementRejectionOf,
  KYC_GLOBAL_REGION,
  KYC_POLICY_CREATE_VERSION,
  KYC_POLICY_LEVELS,
  ROLLING_WINDOW_OPERATIONS,
  type KycPolicyView,
  type KycPolicyVersionView,
} from './kyc.types';

/**
 * ═══ CONFIGURING KYC POLICY ════════════════════════════════════════════════
 *
 * Admin configures POLICY. THIS service never creates a user's requirement rows: a
 * policy-derived obligation is written by the consumer backend when a trigger actually
 * fires, inside the transaction of whatever caused it, and nothing here can reach
 * `kyc_requirements`.
 *
 * That is a boundary about CAUSE, not about which service may write the table.
 * `/kyc-requirements` in this same module does write it — an obligation imposed by a
 * named human against a case reference, which is the "different feature with different
 * rules" this comment used to anticipate. A policy edit must not be able to mint one
 * as a side effect, which is why the two live in different files with different verbs
 * and different audit events.
 *
 * It also never touches `kyc_verifications` or `kyc_level_states`. What an account has
 * actually PROVED is the provider's word, arriving over a signed webhook; no admin
 * surface may edit it. See the boundary note on `KycModule`.
 */
@Injectable()
export class KycPolicyService {
  private readonly logger = new Logger('KycPolicy');

  constructor(
    private readonly policies: KycPolicyDbOperation,
    private readonly events: AuthEventDbOperation,
  ) {}

  /**
   * Every configured policy, plus what a form needs to render one.
   *
   * Reads the TABLE rather than any cached view: an operator who has just written a
   * row must see their own write.
   */
  async state(): Promise<KycPoliciesPayload> {
    const rows = await this.policies.list();

    return {
      policies: rows.map(toView),
      levels: [...KYC_POLICY_LEVELS],
      rollingWindowOperations: [...ROLLING_WINDOW_OPERATIONS],
      globalRegion: KYC_GLOBAL_REGION,
      createVersion: KYC_POLICY_CREATE_VERSION,
    };
  }

  /** The version history for one target, newest first. */
  async history(query: KycPolicyHistoryQuery): Promise<KycPolicyHistoryPayload> {
    const rows = await this.policies.history(query.region, query.level, query.limit);
    return { region: query.region, level: query.level, versions: rows.map(toVersionView) };
  }

  /**
   * Create or update a policy.
   *
   * Returns the whole table, so a screen never has to follow a write with a read —
   * the precedent's shape, and it also means an operator sees the version their next
   * edit has to send.
   */
  async upsert(
    input: KycPolicyUpsertRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycPoliciesPayload> {
    const outcome = await this.policies.upsert({
      region: input.region,
      level: input.level,
      enabled: input.enabled,
      required: input.required,
      triggersOnly: input.triggersOnly,
      workflowId: input.workflowId,
      renewalWorkflowId: input.renewalWorkflowId,
      balanceThreshold: input.balanceThreshold,
      lifetimeDepositThreshold: input.lifetimeDepositThreshold,
      lifetimeWithdrawalThreshold: input.lifetimeWithdrawalThreshold,
      rollingWindowAmount: input.rollingWindowAmount,
      rollingWindowSeconds: input.rollingWindowSeconds,
      rollingWindowOperation: input.rollingWindowOperation,
      thresholdCurrency: input.thresholdCurrency,
      features: input.features,
      // The pair is joined here, at the persistence boundary, to the `feature/subFeature`
      // spelling the column holds and the consumer's `parseQualifiedSubFeature` splits.
      // The DTO takes a structured pair so neither half can contain the delimiter.
      subFeatures: input.subFeatures.map((pair) => `${pair.feature}/${pair.subFeature}`),
      reason: input.reason,
      actorAdminId: actor.adminId,
      expectedVersion: input.expectedVersion,
    });

    this.assertWritten(outcome, input.expectedVersion);

    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        region: input.region,
        level: input.level,
        enabled: input.enabled,
        required: input.required,
        triggersOnly: input.triggersOnly,
        version: outcome.version,
      },
      'kyc policy updated',
    );

    await this.events.record({
      eventType: AUTH_EVENT.KYC_POLICY_UPDATED,
      adminId: actor.adminId,
      client,
      metadata: {
        region: input.region,
        level: input.level,
        enabled: input.enabled,
        required: input.required,
        triggersOnly: input.triggersOnly,
        fromVersion: input.expectedVersion,
        toVersion: outcome.version,
        removed: false,
      },
    });

    return this.state();
  }

  /**
   * Remove a policy so its region falls back to the global rule.
   *
   * See `KycPolicyDbOperation.remove` for why this is a distinct operation from
   * disabling and not a redundant one.
   */
  async remove(
    input: KycPolicyDeleteRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycPoliciesPayload> {
    const outcome = await this.policies.remove({
      region: input.region,
      level: input.level,
      reason: input.reason,
      actorAdminId: actor.adminId,
      expectedVersion: input.expectedVersion,
    });

    this.assertWritten(outcome, input.expectedVersion);

    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        region: input.region,
        level: input.level,
        version: outcome.version,
      },
      'kyc policy removed; this region now falls back to the global rule',
    );

    await this.events.record({
      eventType: AUTH_EVENT.KYC_POLICY_UPDATED,
      adminId: actor.adminId,
      client,
      metadata: {
        region: input.region,
        level: input.level,
        enabled: false,
        required: false,
        triggersOnly: false,
        fromVersion: input.expectedVersion,
        toVersion: outcome.version,
        removed: true,
      },
    });

    return this.state();
  }

  /**
   * Turn a lost compare-and-swap into the caller's answer.
   *
   * ═══ 400, NOT 409 ══════════════════════════════════════════════════════════
   *
   * The precedent's explicit choice, followed here: from the caller's side this is a
   * STALE PAYLOAD, and the remedy is to re-read and re-present rather than to retry.
   * Reporting it on `expectedVersion` points at the field that is wrong.
   *
   * ─── The two cases are not the same instruction ────────────────────────────
   *
   * `currentVersion: 0` means there is no row at all — which the precedent reports as
   * "it is now at version 0", a version nothing ever had and an instruction nobody can
   * act on. A caller who sent `expectedVersion: 3` for a policy that does not exist
   * needs to be told to create it, not to re-read a version that is not there.
   */
  private assertWritten(
    outcome: KycPolicyWriteOutcome,
    expectedVersion: number,
  ): asserts outcome is { ok: true; version: number } {
    if (outcome.ok) return;

    const message =
      outcome.currentVersion === 0
        ? 'No policy exists for this region and level. Send `expectedVersion: 0` to create one.'
        : `This policy has changed since you read it (it is now at version ` +
          `${outcome.currentVersion}, you sent ${expectedVersion}) — another super admin ` +
          `may have edited it. Re-read the policies and try again.`;

    throw new ProblemException({
      type: ERR.VALIDATION_FAILED,
      errors: [{ path: 'expectedVersion', message }],
    });
  }
}

/** A stored row, as a screen reads it. */
function toView(row: KycPolicyRow): KycPolicyView {
  return { ...shared(row), updatedAt: row.updated_at.toISOString(), ...rejection(row) };
}

function toVersionView(row: KycPolicyVersionRow): KycPolicyVersionView {
  return { ...shared(row), recordedAt: row.recorded_at.toISOString() };
}

/** What a live row and a historical one both carry. */
function shared(row: Omit<KycPolicyRow, 'updated_at'>): Omit<
  KycPolicyView,
  'updatedAt' | 'enforcementRejection'
> {
  return {
    region: row.region,
    level: row.level,
    enabled: row.enabled,
    required: row.required,
    triggersOnly: row.triggers_only,
    workflowId: row.workflow_id,
    renewalWorkflowId: row.renewal_workflow_id,
    balanceThreshold: row.balance_threshold,
    lifetimeDepositThreshold: row.lifetime_deposit_threshold,
    lifetimeWithdrawalThreshold: row.lifetime_withdrawal_threshold,
    rollingWindowAmount: row.rolling_window_amount,
    rollingWindowSeconds: row.rolling_window_seconds,
    rollingWindowOperation: row.rolling_window_operation,
    thresholdCurrency: row.threshold_currency,
    features: row.features,
    subFeatures: row.sub_features,
    version: row.version,
    updatedByAdminId: row.updated_by_admin_id,
    reason: row.reason,
  };
}

/**
 * Would the consumer act on this row, or silently discard it?
 *
 * Expected to be null for every row: the same four conditions are blocked by CHECK
 * constraints on the table, so neither this API nor a hand-written INSERT can store
 * one. It is reported anyway as a canary — a non-null value means the constraints and
 * the consumer's rules have diverged, which is otherwise invisible from this side.
 * See `enforcementRejectionOf`.
 */
function rejection(row: KycPolicyRow): Pick<KycPolicyView, 'enforcementRejection'> {
  return {
    enforcementRejection: enforcementRejectionOf({
      region: row.region,
      level: row.level,
      balanceThreshold: row.balance_threshold,
      lifetimeDepositThreshold: row.lifetime_deposit_threshold,
      lifetimeWithdrawalThreshold: row.lifetime_withdrawal_threshold,
      rollingWindowAmount: row.rolling_window_amount,
      rollingWindowSeconds: row.rolling_window_seconds,
      rollingWindowOperation: row.rolling_window_operation,
      thresholdCurrency: row.threshold_currency,
    }),
  };
}
