import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ipClassOf } from '../../auth/auth.utility';
import { SessionDbOperation } from '../../auth/persistence/session.dboperation';
import type { Principal } from '../../auth/auth.types';
import { cloudflareCountry } from '../geo/cloudflare';
import type { TriggerAction } from './restrictions.catalogue';
import { SecurityRestrictionRiskEvaluator } from './restrictions.evaluator';
import { RestrictionPolicySnapshotService } from './restrictions.snapshot';
import {
  emptyPlan,
  type RequestFacts,
  type RestrictionPlan,
  type SecurityContext,
} from './restrictions.types';

/**
 * Everything the raw request carries that no later layer can recover.
 *
 * Pure and synchronous, so a `*.routes.ts` file can call it without becoming the
 * place that does I/O — the same role `clientContextOf` plays in auth/auth.routes.ts
 * and `ipClassOf` plays in every settings route today.
 *
 * It REPLACES the bare `ipClassOf(req.ip)` those routes already pass, rather than
 * being added beside it: the notification email and the restriction row must describe
 * the same request, and two parameters carrying the same value are two chances to
 * drift.
 */
export function requestFactsOf(req: FastifyRequest): RequestFacts {
  return {
    ipClass: ipClassOf(req.ip),
    country: cloudflareCountry(req.headers),
    requestId: typeof req.id === 'string' ? req.id : null,
  };
}

/**
 * ═══ THE ONE PLACE A RESTRICTION IS DECIDED ════════════════════════════════
 *
 * Two methods, and the split between them is the whole design:
 *
 *   capture(req, principal)   at request entry, before anything is proved
 *   planFor(action, context)  after the proof, BEFORE the transaction opens
 *
 * Neither writes. The write is `stampRestrictionsLocked`, called from inside the
 * mutation's own transaction with the plan this produced — see that file for why it
 * cannot be anywhere else.
 *
 * ─── Why the sensitive services hold none of this ─────────────────────────
 *
 * `PasswordSettingsService`, `EmailChangeService`, `SettingsService` and
 * `PaymentPinService` each make exactly one call to `planFor` and pass the result
 * down. None of them knows what a classification is, what the history window is, or
 * which features a policy names. Putting any of that in even one of them would make
 * the answer depend on which door the user came through.
 */
@Injectable()
export class SecurityRestrictionService {
  private readonly logger = new Logger('SecurityRestriction');

  constructor(
    private readonly evaluator: SecurityRestrictionRiskEvaluator,
    private readonly snapshot: RestrictionPolicySnapshotService,
    private readonly sessions: SessionDbOperation,
  ) {}

  /**
   * Capture everything about this request that will stop being available.
   *
   * ═══ CALLED AT REQUEST ENTRY, AND THAT IS NOT NEGOTIABLE ══════════════════
   *
   * Two things expire:
   *
   * The REQUEST. `req.ip`, `req.id` and the Cloudflare header exist only at the route
   * layer; a service reaching for them later has nothing to reach for.
   *
   * The SESSION. Six of the eight triggers revoke sessions as part of succeeding, and
   * `EmailChangeService.commitChange` revokes every session including the caller's. A
   * device fingerprint read after the mutation would be read from a row that had just
   * been revoked.
   *
   * ─── Where the device identity comes from ─────────────────────────────────
   *
   * `sessions.deviceFingerprint`, by primary key on the session the guard already
   * authenticated. NOT the `orebit_device` cookie: that cookie is scoped to `/auth`
   * and is never sent to `/settings/*`, so reading it here would be null every time —
   * and inventing a second device identity to work around that is exactly what must
   * not happen. The peppered key on the session row is the canonical one.
   */
  async contextFrom(
    userId: string,
    /** The acting session, which the evaluator excludes from its own history. */
    sessionId: string,
    facts: RequestFacts,
  ): Promise<SecurityContext> {
    const session = await this.sessions.findById(sessionId);

    return {
      userId,
      sessionId,
      // Null only if the row vanished between the guard and here. Treated as
      // unfamiliar by the evaluator, which is the safe reading.
      deviceFingerprint: session?.deviceFingerprint ?? null,
      ipClass: facts.ipClass,
      country: facts.country,
      requestId: facts.requestId,
    };
  }

  /**
   * Decide what this successful action should cost, as a plain value.
   *
   * ═══ EVERY QUERY HAPPENS HERE, SO NONE HAPPENS IN THE TRANSACTION ═════════
   *
   * The history scan (three bounded index reads) and the policy lookup (a map read)
   * both run before the caller opens its `$transaction`. What crosses into the
   * transaction is a resolved list of targets and a duration.
   *
   * ─── Where to call it ─────────────────────────────────────────────────────
   *
   * After the action is fully authorised — after the emailed code is spent and the
   * factor proved — and before the mutation begins. Calling it earlier would spend
   * three queries on requests that are about to be refused.
   *
   * ─── Every "no restriction" path lands here ───────────────────────────────
   *
   * No policy row, policy disabled, zero duration, no valid targets: all of them come
   * back as an empty plan rather than as an error or a null. One shape for the caller
   * to pass on, and `stampRestrictionsLocked` returns early on it.
   */
  async planFor(action: TriggerAction, context: SecurityContext): Promise<RestrictionPlan> {
    const assessment = await this.evaluator.assess(context);

    // The classification is what the evaluator concluded; the policy is looked up
    // under what that RESOLVES to — so UNCLASSIFIED is served the NEW_CONTEXT policy
    // while still being recorded as unclassified on the row.
    const policy = this.snapshot.policyFor(action, assessment.policyContext);

    if (policy === null) {
      this.logger.debug(
        { action, classification: assessment.classification },
        'no active restriction policy for this action and context',
      );
      return emptyPlan(action, assessment);
    }

    return {
      action,
      assessment,
      policyVersion: policy.version,
      durationSeconds: policy.durationSeconds,
      targets: policy.targets,
    };
  }

  /**
   * The observability seam.
   *
   * This service has no audit table — the User backend has none at all, and inventing
   * one for this feature was ruled out. The restriction ROW is the durable record: it
   * carries the trigger, both context columns, the policy version, the observed
   * signals and the request id, which is everything an investigation needs.
   *
   * This adds the line for the cases that write no row, which would otherwise leave no
   * trace at all — an unclassified request under a policy that restricts nothing still
   * says something worth knowing about the classifier.
   *
   * Nothing sensitive: no codes, no tokens, no session handle, no raw IP. `ipClass` is
   * a /24 or /48 and the device value is a peppered hash, both of which already appear
   * in this shape on `sessions`.
   */
  record(plan: RestrictionPlan, context: SecurityContext, written: number): void {
    this.logger.log(
      {
        userId: context.userId,
        action: plan.action,
        classification: plan.assessment.classification,
        policyContext: plan.assessment.policyContext,
        isNewIp: plan.assessment.isNewIp,
        isNewDevice: plan.assessment.isNewDevice,
        isNewCountry: plan.assessment.isNewCountry,
        policyVersion: plan.policyVersion,
        targets: plan.targets.length,
        written,
        requestId: context.requestId,
      },
      written > 0 ? 'security restrictions applied' : 'no security restriction applied',
    );
  }
}
