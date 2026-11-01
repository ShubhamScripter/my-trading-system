import { Inject, Injectable } from '@nestjs/common';
import { RESTRICTION } from '../../auth/auth.constants';
import {
  SessionDbOperation,
  type SecurityHistoryDays,
} from '../../auth/persistence/session.dboperation';
import { POLICY_FOR_CLASSIFICATION, type Classification } from './restrictions.catalogue';
import type { RiskAssessment, RiskSignals, SecurityContext } from './restrictions.types';

/**
 * ═══ CLASSIFYING ONE REQUEST ═══════════════════════════════════════════════
 *
 * Turns a captured `SecurityContext` plus the account's session history into a
 * classification. It does exactly that and nothing else: it does not read policy, it
 * does not create restrictions, and it does not enforce anything. Those are three
 * other files, and keeping them apart is what makes this one testable against a
 * table of inputs with no database.
 *
 * The decision itself is the pure function `classify` below; the class exists only to
 * hold the one collaborator that needs a database — the same split
 * `RecentSecurityChangePolicy` makes over `securityCooldownRemainingSeconds`.
 */

/**
 * ═══ THE CLASSIFICATION RULE ═══════════════════════════════════════════════
 *
 *   A:  !isNewIp && !isNewDevice                      -> COMMON_IP_DEVICE
 *   B:   isNewIp && (isNewCountry || isNewDevice)     -> NEW_CONTEXT
 *   otherwise                                         -> UNCLASSIFIED
 *
 * Pure, total, and deliberately written as the three cases rather than collapsed into
 * a boolean expression, because the third case is the one a reader needs to SEE: the
 * two configured contexts are not exhaustive, and everything that falls between them
 * is recorded as unclassified and given the stricter policy.
 *
 * ─── The cases that fall through, and why that is correct ─────────────────
 *
 * With country unavailable (the state of every deployment until Cloudflare is
 * trusted), B reduces to `isNewIp && isNewDevice`, so:
 *
 *   known IP + known device  -> A
 *   known IP + NEW device    -> UNCLASSIFIED -> NEW_CONTEXT policy
 *   NEW IP   + known device  -> UNCLASSIFIED -> NEW_CONTEXT policy
 *   NEW IP   + NEW device    -> B
 *
 * The two middle rows are the interesting ones. They are not matched by either
 * configured rule, they are the majority of genuinely suspicious traffic, and giving
 * them the lenient policy because no rule named them would be the whole mechanism
 * quietly failing open. Recording them as UNCLASSIFIED rather than relabelling them
 * NEW_CONTEXT is what keeps that visible: the restriction row says the evaluator was
 * not confident, and the rate of that is measurable.
 *
 * ─── Same IP + same device + different country -> A, and that is intended ──
 *
 * Rule A does not mention country, so a familiar network and a familiar device
 * classify as common even when the country differs. That follows from the approved
 * rules as written. It is reachable in practice (a VPN or a re-homed carrier prefix)
 * and it is a deliberate product decision, not an oversight in this function.
 */
export function classify(signals: RiskSignals): Classification {
  if (!signals.isNewIp && !signals.isNewDevice) return 'COMMON_IP_DEVICE';
  if (signals.isNewIp && (signals.isNewCountry || signals.isNewDevice)) return 'NEW_CONTEXT';
  return 'UNCLASSIFIED';
}

/**
 * Turn the three day-counts into the three booleans.
 *
 * ═══ THE ASYMMETRY BETWEEN IP/DEVICE AND COUNTRY IS THE POINT ══════════════
 *
 * IP and device fail SAFE: absent evidence counts as unfamiliar. A device with no
 * history genuinely is new to this account, and `null` (no device key at all) is
 * treated the same way — a caller who presents no device identity has not shown it is
 * a familiar one.
 *
 * Country fails OPEN, and must. `isNewCountry` is true only on POSITIVE evidence —
 * a country was established for this request and the account has not been seen from
 * it on enough days. Every other case is false:
 *
 *   country null (not trusted / not reported)  -> false. "Nobody looked" is not
 *                                                 evidence of a different country.
 *   countryDays null (not asked)               -> false, same reason.
 *   no historical country at all               -> false. An account with no country
 *                                                 history has no country to differ
 *                                                 FROM, so nothing is "different".
 *
 * That last one is worth stating separately: it is the state of every account on the
 * day Cloudflare is first switched on, and reading it as "new country" would restrict
 * the entire user base at once.
 *
 * Note this means the country term only ever ADDS strictness via rule B, and can
 * never rescue a request into rule A — A does not consult it.
 */
export function signalsFrom(
  history: SecurityHistoryDays,
  observedCountry: string | null,
  minDays: number,
): RiskSignals {
  return {
    isNewIp: history.ipDays < minDays,
    // Null device evidence is unfamiliar, not unknown: presenting no device is not
    // presenting a known one.
    isNewDevice: history.deviceDays === null || history.deviceDays < minDays,
    isNewCountry:
      observedCountry !== null && history.countryDays !== null && history.countryDays < minDays,
  };
}

@Injectable()
export class SecurityRestrictionRiskEvaluator {
  constructor(@Inject(SessionDbOperation) private readonly sessions: SessionDbOperation) {}

  /**
   * Assess one captured context against the account's session history.
   *
   * Three bounded index scans, run concurrently, each stopping at the threshold —
   * see `SessionDbOperation.securityHistory`. Nothing here grows with the size of the
   * account's history, and nothing here writes.
   */
  async assess(context: SecurityContext): Promise<RiskAssessment> {
    const since = new Date(Date.now() - RESTRICTION.HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const history = await this.sessions.securityHistory({
      userId: context.userId,
      excludeSessionId: context.sessionId,
      deviceFingerprint: context.deviceFingerprint,
      ipClass: context.ipClass,
      country: context.country,
      since,
      minDays: RESTRICTION.COMMON_MIN_DAYS,
    });

    const signals = signalsFrom(history, context.country, RESTRICTION.COMMON_MIN_DAYS);
    const classification = classify(signals);

    return {
      ...signals,
      classification,
      policyContext: POLICY_FOR_CLASSIFICATION[classification],
      observedIpClass: context.ipClass,
      observedDevice: context.deviceFingerprint,
      observedCountry: context.country,
    };
  }
}
