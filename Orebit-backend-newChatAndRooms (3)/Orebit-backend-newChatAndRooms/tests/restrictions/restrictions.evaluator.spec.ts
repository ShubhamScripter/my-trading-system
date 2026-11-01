import { describe, expect, it, vi } from 'vitest';
import { RESTRICTION } from '../../auth/auth.constants';
import type { SecurityHistoryDays } from '../../auth/persistence/session.dboperation';
import {
  SecurityRestrictionRiskEvaluator,
  classify,
  signalsFrom,
} from '../../src/restrictions/restrictions.evaluator';
import { POLICY_FOR_CLASSIFICATION } from '../../src/restrictions/restrictions.catalogue';
import type { RiskSignals, SecurityContext } from '../../src/restrictions/restrictions.types';

/**
 * ═══ THE CLASSIFIER IS A TRUTH TABLE, SO IT IS TESTED AS ONE ═══════════════
 *
 * `classify` and `signalsFrom` are pure, so the interesting cases are enumerated
 * rather than chosen. Two properties are worth more than any individual case:
 *
 *   TOTALITY — every combination of three booleans resolves to exactly one
 *   classification, and every classification resolves to a configurable policy. A
 *   request that matched no rule and got no policy would be a silent hole.
 *
 *   THE FAIL-SAFE DIRECTION — everything that is not confidently familiar ends up
 *   under `NEW_CONTEXT`'s policy. That is the property an inverted comparison would
 *   break while leaving every happy-path assertion green.
 *
 * Pure, so none of this needs a container, a database or a Redis.
 */

const MIN = RESTRICTION.COMMON_MIN_DAYS;

function signals(over: Partial<RiskSignals> = {}): RiskSignals {
  return { isNewIp: false, isNewDevice: false, isNewCountry: false, ...over };
}

// ─── the rule itself ────────────────────────────────────────────────────────

describe('classify — the approved V1 rule', () => {
  /** All eight combinations, and the expected verdict for each. */
  const TABLE: ReadonlyArray<readonly [boolean, boolean, boolean, string]> = [
    // isNewIp, isNewDevice, isNewCountry, expected
    [false, false, false, 'COMMON_IP_DEVICE'], // 1. common IP + common device
    [false, false, true, 'COMMON_IP_DEVICE'], // 7. same IP + same device + different country
    [false, true, false, 'UNCLASSIFIED'], // 6. same IP + new device
    [false, true, true, 'UNCLASSIFIED'], // known IP, new device, new country
    [true, false, false, 'UNCLASSIFIED'], // 5. new IP + known country + same device
    [true, false, true, 'NEW_CONTEXT'], // 3. new IP + different country
    [true, true, false, 'NEW_CONTEXT'], // 2/4. new IP + new device
    [true, true, true, 'NEW_CONTEXT'], // everything unfamiliar
  ];

  it.each(TABLE)(
    'isNewIp=%s isNewDevice=%s isNewCountry=%s -> %s',
    (isNewIp, isNewDevice, isNewCountry, expected) => {
      expect(classify({ isNewIp, isNewDevice, isNewCountry })).toBe(expected);
    },
  );

  it('is total — every combination resolves', () => {
    expect(TABLE).toHaveLength(8);
    for (const [a, b, c] of TABLE) {
      expect(classify({ isNewIp: a, isNewDevice: b, isNewCountry: c })).toBeTypeOf('string');
    }
  });

  /**
   * Case 7 from the brief, asserted on its own because it is the one row that looks
   * wrong at a glance. Rule A does not consult country, so a familiar network AND a
   * familiar device classify as common even when the country differs. That follows
   * from the approved rules as written and is a product decision, not an oversight —
   * if it is ever revisited, this test is what should fail first.
   */
  it('treats a familiar IP and device as common even when the country differs', () => {
    expect(classify(signals({ isNewCountry: true }))).toBe('COMMON_IP_DEVICE');
  });

  /**
   * Cases 5 and 6 — the two that match NEITHER configured rule. They are the majority
   * of genuinely suspicious traffic while country is unavailable, and the whole
   * mechanism would fail open if they took the lenient policy.
   */
  it.each([
    ['new IP, known device, no country signal', signals({ isNewIp: true })],
    ['known IP, new device', signals({ isNewDevice: true })],
  ])('records %s as UNCLASSIFIED and applies the STRICTER policy', (_name, s) => {
    const verdict = classify(s);
    expect(verdict).toBe('UNCLASSIFIED');
    expect(POLICY_FOR_CLASSIFICATION[verdict]).toBe('NEW_CONTEXT');
  });
});

// ─── turning day-counts into signals ────────────────────────────────────────

function history(over: Partial<SecurityHistoryDays> = {}): SecurityHistoryDays {
  return { deviceDays: MIN, ipDays: MIN, countryDays: MIN, ...over };
}

describe('signalsFrom — evidence, and the absence of it', () => {
  it('treats a value seen on at least the threshold number of days as familiar', () => {
    const s = signalsFrom(history(), 'NL', MIN);
    expect(s).toEqual({ isNewIp: false, isNewDevice: false, isNewCountry: false });
  });

  /**
   * Case 12: one appearance is not "commonly used". The threshold is the whole
   * defence against a device vouching for itself on the day it first appears.
   */
  it('does NOT treat a single day as commonly used', () => {
    expect(MIN).toBeGreaterThan(1);
    const s = signalsFrom(history({ deviceDays: 1, ipDays: 1 }), null, MIN);
    expect(s.isNewIp).toBe(true);
    expect(s.isNewDevice).toBe(true);
  });

  /**
   * Case 13 is enforced by the QUERY's window rather than here — an observation older
   * than the window never reaches this function. Asserted at the boundary instead: a
   * zero count is what an out-of-window history looks like from here.
   */
  it('treats no in-window observation as unfamiliar', () => {
    const s = signalsFrom(history({ deviceDays: 0, ipDays: 0 }), null, MIN);
    expect(s.isNewIp).toBe(true);
    expect(s.isNewDevice).toBe(true);
  });

  /** Cases 10 and 11: indeterminate IP/device evidence fails SAFE. */
  it('treats a request with no device key at all as a new device', () => {
    expect(signalsFrom(history({ deviceDays: null }), null, MIN).isNewDevice).toBe(true);
  });

  // ─── country: the asymmetry ───────────────────────────────────────────────

  /**
   * Case 8. The single most dangerous confusion in this file: if "unknown country"
   * became "new country", `isNewCountry` would be true for every request on every
   * deployment that is not behind Cloudflare — turning the country term from off into
   * permanently on, and pushing traffic into `NEW_CONTEXT` that nothing established
   * anything about.
   */
  it('does NOT treat an unknown current country as a new country', () => {
    expect(signalsFrom(history({ countryDays: null }), null, MIN).isNewCountry).toBe(false);
    expect(signalsFrom(history({ countryDays: 0 }), null, MIN).isNewCountry).toBe(false);
  });

  /**
   * Case 9. An account with no country history has no country to DIFFER from. This is
   * the state of every account on the day a geo provider is first switched on, and
   * reading it as "new country" would restrict the entire user base at once.
   */
  it('does NOT treat a first-ever observed country as new when there is no history', () => {
    // A country was established for this request, but the account has never been seen
    // from one — `countryDays: null` is "not asked", 0 would be "asked, never seen".
    expect(signalsFrom(history({ countryDays: null }), 'IN', MIN).isNewCountry).toBe(false);
  });

  it('DOES treat a known-different country as new, on positive evidence', () => {
    expect(signalsFrom(history({ countryDays: 0 }), 'IN', MIN).isNewCountry).toBe(true);
  });

  it('never lets country rescue a request into the common bucket', () => {
    // Country is consulted only by rule B, which cannot produce COMMON_IP_DEVICE.
    const s = signalsFrom(history({ deviceDays: 0, ipDays: 0, countryDays: MIN }), 'NL', MIN);
    expect(classify(s)).not.toBe('COMMON_IP_DEVICE');
  });
});

// ─── the evaluator, over a fake history ─────────────────────────────────────

describe('SecurityRestrictionRiskEvaluator.assess', () => {
  const CONTEXT: SecurityContext = {
    userId: 'user-1',
    sessionId: 'session-current',
    deviceFingerprint: 'd'.repeat(64),
    ipClass: '203.0.113.0/24',
    country: null,
    requestId: 'req-1',
  };

  function evaluator(days: SecurityHistoryDays) {
    const sessions = { securityHistory: vi.fn(async () => days) };
    return {
      sessions,
      evaluator: new SecurityRestrictionRiskEvaluator(sessions as never),
    };
  }

  it('excludes the ACTING session from its own history', async () => {
    const { sessions, evaluator: e } = evaluator(history());
    await e.assess(CONTEXT);

    expect(sessions.securityHistory).toHaveBeenCalledWith(
      expect.objectContaining({ excludeSessionId: 'session-current', userId: 'user-1' }),
    );
  });

  it('asks over the configured window and threshold, not ad-hoc numbers', async () => {
    const { sessions, evaluator: e } = evaluator(history());
    const before = Date.now();
    await e.assess(CONTEXT);

    const [arg] = sessions.securityHistory.mock.calls[0] as unknown as [
      { since: Date; minDays: number },
    ];
    expect(arg.minDays).toBe(RESTRICTION.COMMON_MIN_DAYS);
    const windowMs = RESTRICTION.HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    expect(before - arg.since.getTime()).toBeGreaterThanOrEqual(windowMs - 5_000);
    expect(before - arg.since.getTime()).toBeLessThanOrEqual(windowMs + 5_000);
  });

  it('reports the observed context alongside the verdict', async () => {
    const { evaluator: e } = evaluator(history());
    const a = await e.assess({ ...CONTEXT, country: 'NL' });

    expect(a.observedIpClass).toBe('203.0.113.0/24');
    expect(a.observedDevice).toBe('d'.repeat(64));
    expect(a.observedCountry).toBe('NL');
  });

  it('resolves the policy context through the fail-safe table', async () => {
    const { evaluator: e } = evaluator(history({ deviceDays: 0 }));
    const a = await e.assess(CONTEXT);

    expect(a.classification).toBe('UNCLASSIFIED');
    expect(a.policyContext).toBe('NEW_CONTEXT');
  });

  it('classifies a fully familiar request as common', async () => {
    const { evaluator: e } = evaluator(history());
    const a = await e.assess(CONTEXT);

    expect(a.classification).toBe('COMMON_IP_DEVICE');
    expect(a.policyContext).toBe('COMMON_IP_DEVICE');
  });

  it('classifies a wholly unfamiliar request as the new context', async () => {
    const { evaluator: e } = evaluator(history({ deviceDays: 0, ipDays: 0 }));
    const a = await e.assess(CONTEXT);

    expect(a.classification).toBe('NEW_CONTEXT');
  });

  it('does not query country history when the request carried no country', async () => {
    const { sessions, evaluator: e } = evaluator(history({ countryDays: null }));
    await e.assess(CONTEXT);

    expect(sessions.securityHistory).toHaveBeenCalledWith(
      expect.objectContaining({ country: null }),
    );
  });
});
