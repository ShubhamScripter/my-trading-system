import type { RainConfig, RainQuestion } from './rain.contract';
import { parseMinor } from './rain.math';

/**
 * The user rain security policy ("RainPool Settings → Security Verifications"), pure. The
 * service gathers the facts and acts on the answer.
 *
 * The facts come from the platform's login history (the restrictions evaluator): whether this
 * IP and this country were seen on the account before, and whether the connection is a VPN /
 * proxy (the edge's Tor flag, or a connected detection provider). Each rule is "[Can be set ON /
 * OFF]" and also applies when the rain is worth more than its "amount above x USD". The highest
 * rule that applies wins:
 *
 *   3 vpnProxy          VPN / proxy, or amount → EMAIL + 2FA, MANUAL admin verification
 *   2 newCountry        new IP in a new country, or amount → EMAIL + 2FA, AUTO questionnaire / KYC
 *   1 newIpSameCountry  new IP in a known country, or amount → EMAIL and/or 2FA
 *   0 commonIp          a common login IP → nothing (when switched off, tier 1 applies instead)
 */

export type VerifyReason = 'NEW_IP' | 'NEW_COUNTRY' | 'VPN_PROXY' | 'AMOUNT' | 'COMMON_IP_CHECK';

export interface RiskFacts {
  readonly isNewIp: boolean;
  /** True only when a country was established for the request and the account was not seen there. */
  readonly isNewCountry: boolean;
  /** A VPN, proxy or anonymising network. */
  readonly anonymised: boolean;
}

export interface VerificationNeed {
  readonly tier: 1 | 2 | 3;
  readonly reasons: readonly VerifyReason[];
  readonly twoFa: boolean;
  readonly email: boolean;
  /** ONE: either code is enough. BOTH: both codes. */
  readonly require: 'ONE' | 'BOTH';
  /** Asked with the codes ("Auto Trigger"). */
  readonly questionnaire: boolean;
  readonly kyc: boolean;
  /** An admin approves or rejects after the codes (tier 3). */
  readonly manual: boolean;
}

/** Whether a switched-on rule has an "amount above x USD": then the rain's USD value must be known. */
export function needsUsdValue(cfg: RainConfig): boolean {
  const s = cfg.security;
  return (
    (s.vpnProxy.enabled && s.vpnProxy.amountAboveUsd !== null) ||
    (s.newCountry.enabled && s.newCountry.amountAboveUsd !== null) ||
    (s.newIpSameCountry.enabled && s.newIpSameCountry.amountAboveUsd !== null)
  );
}

function above(limit: string | null, usd: bigint | null): boolean {
  if (limit === null || usd === null) return false;
  const value = parseMinor(limit);
  return value !== null && usd > value;
}

/** `usd` is the rain's USD value (null when no price is known; the caller refuses when one is needed). */
export function verificationNeed(cfg: RainConfig, usd: bigint | null, risk: RiskFacts): VerificationNeed | null {
  const s = cfg.security;

  if (s.vpnProxy.enabled) {
    const byAmount = above(s.vpnProxy.amountAboveUsd, usd);
    if (risk.anonymised || byAmount) {
      return {
        tier: 3,
        reasons: [...(risk.anonymised ? (['VPN_PROXY'] as const) : []), ...(byAmount ? (['AMOUNT'] as const) : [])],
        twoFa: true,
        email: true,
        require: 'BOTH',
        questionnaire: s.vpnProxy.questionnaire === 'AUTO' && s.questions.length > 0,
        kyc: s.vpnProxy.kycCheck === 'AUTO',
        manual: true,
      };
    }
  }

  if (s.newCountry.enabled) {
    const byContext = risk.isNewIp && risk.isNewCountry;
    const byAmount = above(s.newCountry.amountAboveUsd, usd);
    if (byContext || byAmount) {
      return {
        tier: 2,
        reasons: [...(byContext ? (['NEW_COUNTRY'] as const) : []), ...(byAmount ? (['AMOUNT'] as const) : [])],
        twoFa: true,
        email: true,
        require: 'BOTH',
        questionnaire: s.newCountry.questionnaire && s.questions.length > 0,
        kyc: s.newCountry.kycCheck,
        manual: false,
      };
    }
  }

  const tierOne = (reasons: VerifyReason[]): VerificationNeed => ({
    tier: 1,
    reasons,
    twoFa: true,
    email: true,
    require: s.newIpSameCountry.require,
    questionnaire: false,
    kyc: false,
    manual: false,
  });

  if (s.newIpSameCountry.enabled) {
    const byContext = risk.isNewIp && !risk.isNewCountry;
    const byAmount = above(s.newIpSameCountry.amountAboveUsd, usd);
    if (byContext || byAmount) {
      return tierOne([...(byContext ? (['NEW_IP'] as const) : []), ...(byAmount ? (['AMOUNT'] as const) : [])]);
    }
  }

  // A common login IP needs nothing while that rule is ON; switched OFF it gets the tier 1 checks.
  if (!risk.isNewIp && !s.commonIp.enabled) return tierOne(['COMMON_IP_CHECK']);
  return null;
}

/** Null when the KYC level is enough. A missing KYC module counts as level 0. */
export function kycShortfall(minLevel: number, kycLevel: number | null): string | null {
  if ((kycLevel ?? 0) >= minLevel) return null;
  return `Complete KYC (level ${minLevel}) to continue. Yours is ${kycLevel ?? 0}.`;
}

/** Every question answered with an option the admin marked OK. */
export function questionnairePassed(questions: readonly RainQuestion[], answers: readonly number[] | undefined): boolean {
  if (questions.length === 0) return true;
  if (!answers || answers.length !== questions.length) return false;
  return questions.every((question, i) => question.okOptions.includes(answers[i]!));
}

/** "Require one": either proof is enough. "Require both": every asked proof. */
export function codesSatisfied(
  need: { twoFa: boolean; email: boolean; require: 'ONE' | 'BOTH' },
  proved: { twoFa: boolean; email: boolean },
): boolean {
  const asked = [need.twoFa ? proved.twoFa : null, need.email ? proved.email : null].filter((v) => v !== null);
  if (asked.length === 0) return true;
  return need.require === 'ONE' ? asked.some(Boolean) : asked.every(Boolean);
}
