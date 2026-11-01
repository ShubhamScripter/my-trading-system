import { describe, expect, it } from 'vitest';
import * as renewalDto from '../../src/kyc/kyc-renewal.dto';
import { kycRenewalRequestSchema } from '../../src/kyc/kyc-renewal.dto';

/**
 * The renewal request schema.
 *
 * ═══ THIS IS THE LAST PLACE A BAD PERIOD CAN BE STOPPED CHEAPLY ════════════
 *
 * `ck_kyc_renewal_settings_periods` and `ck_kyc_renewal_settings_ordering` in the
 * consumer's `db/sql/identity.sql` catch the same two mistakes, but they catch them as
 * a 500 from a constraint violation. Catching them here makes them a field error an
 * operator can act on — and two of the rules below are STRICTER than the database on
 * purpose, because the database has no opinion about configuration that is merely
 * useless.
 *
 * ═══ AND IT IS EXACTLY TWO FIELDS ══════════════════════════════════════════
 *
 * The contract is `{ mandatoryPeriodDays, voluntaryPeriodDays }`. The suite at the
 * bottom pins that shut from the other side: `version`, `expectedVersion`, `reason`,
 * `renewalEnabled` and `dryRun` are not merely unused, they are REFUSED, because
 * `.strict()` is what stops a field creeping back in as "harmless, it gets ignored".
 */

const VALID = {
  mandatoryPeriodDays: 365,
  voluntaryPeriodDays: 330,
};

function parse(overrides: Record<string, unknown> = {}) {
  return kycRenewalRequestSchema.safeParse({ ...VALID, ...overrides });
}

/** The `path` of the first issue, for asserting WHICH field was blamed. */
function firstIssuePath(result: ReturnType<typeof parse>): string | undefined {
  return result.success ? undefined : result.error.issues[0]?.path.join('.');
}

describe('the happy shapes', () => {
  it('accepts a configured pair, and parses to exactly two fields', () => {
    const result = parse();
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      mandatoryPeriodDays: 365,
      voluntaryPeriodDays: 330,
    });
  });

  it('accepts both periods null — renewal switched off', () => {
    // The shipped state, and a legitimate thing to write back to. Turning renewal OFF
    // must be as expressible as turning it on.
    const result = parse({ mandatoryPeriodDays: null, voluntaryPeriodDays: null });
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      mandatoryPeriodDays: null,
      voluntaryPeriodDays: null,
    });
  });

  it('accepts a mandatory period with no voluntary window', () => {
    // X without Y: verifications expire, and nobody may redo one early.
    expect(parse({ voluntaryPeriodDays: null }).success).toBe(true);
  });

  it('needs nothing beyond the two periods — no reason, no version', () => {
    // The whole point of this change: a bare two-field body is a complete, valid write.
    expect(
      kycRenewalRequestSchema.safeParse({
        mandatoryPeriodDays: 90,
        voluntaryPeriodDays: 30,
      }).success,
    ).toBe(true);
  });
});

describe('the ordering rule', () => {
  it('refuses a voluntary window at or after the mandatory deadline', () => {
    // Y >= X is dead configuration that reads as though it worked: the window would
    // never open on a credential that was still valid.
    for (const voluntaryPeriodDays of [365, 400]) {
      const result = parse({ voluntaryPeriodDays });
      expect(result.success, `Y=${voluntaryPeriodDays}`).toBe(false);
      expect(firstIssuePath(result)).toBe('voluntaryPeriodDays');
    }
  });

  it('accepts one day of separation', () => {
    expect(parse({ mandatoryPeriodDays: 365, voluntaryPeriodDays: 364 }).success).toBe(true);
  });

  it('refuses a voluntary window with no mandatory deadline in front of it', () => {
    // Stricter than the database. A window before a deadline that does not exist does
    // nothing, and will read as if it did the day somebody sets X.
    const result = parse({ mandatoryPeriodDays: null, voluntaryPeriodDays: 30 });
    expect(result.success).toBe(false);
    expect(firstIssuePath(result)).toBe('voluntaryPeriodDays');
  });
});

describe('the period grammar', () => {
  it('refuses zero and negative periods', () => {
    // Zero would invalidate the entire user base the instant it was written — every
    // account's verification is at least zero days old.
    for (const days of [0, -1]) {
      expect(parse({ mandatoryPeriodDays: days, voluntaryPeriodDays: null }).success).toBe(false);
    }
  });

  it('refuses a fractional period', () => {
    // The column is int4 seconds; a fraction of a day is not expressible and rounding
    // it silently would store something the operator did not type. This is also what
    // makes the read side safe to report a fraction when the column holds one — the
    // number it prints cannot be submitted back.
    expect(parse({ mandatoryPeriodDays: 30.5, voluntaryPeriodDays: null }).success).toBe(false);
  });

  it('refuses a period long enough to be a typo', () => {
    expect(parse({ mandatoryPeriodDays: 36_501, voluntaryPeriodDays: null }).success).toBe(false);
  });

  it('requires both fields — there is no partial update', () => {
    // A full-state write. Omitting a field cannot mean "leave it alone", because that
    // would make turning half of renewal off indistinguishable from forgetting to.
    expect(kycRenewalRequestSchema.safeParse({ mandatoryPeriodDays: 365 }).success).toBe(false);
    expect(kycRenewalRequestSchema.safeParse({ voluntaryPeriodDays: 30 }).success).toBe(false);
  });
});

describe('the fields that are NOT part of this contract', () => {
  // `.strict()`, and each of these is a field the first cut of this feature had. A
  // regression would not be a crash; it would be a body that silently carried something
  // nothing persists. Refusing it is how that stays visible.
  it.each([
    ['expectedVersion', 1],
    ['version', 1],
    ['reason', 'Annual re-verification policy.'],
    ['renewalEnabled', true],
    ['dryRun', true],
  ])('refuses `%s`', (field, value) => {
    expect(parse({ [field]: value }).success).toBe(false);
  });

  it('refuses a per-region or per-level period — these numbers are global', () => {
    // A caller trying to narrow the scope should fail loudly, not have it silently
    // dropped and believe it was applied.
    expect(parse({ region: 'IN' }).success).toBe(false);
    expect(parse({ level: 'L1' }).success).toBe(false);
  });
});

describe('the history query schema', () => {
  it('does not exist — the renewal configuration keeps no history of itself', () => {
    // `GET /kyc-renewal/history` and `kycRenewalHistoryQuerySchema` were removed with
    // the versions table behind them. Who changed the periods is
    // KYC_RENEWAL_SETTINGS_UPDATED in the admin audit log, which is separate
    // infrastructure read through a separate surface.
    //
    // Asserted on the whole module rather than on one name, because a history schema
    // reappearing under any spelling is the regression worth catching.
    expect(Object.keys(renewalDto)).toEqual(['kycRenewalRequestSchema']);
  });
});
