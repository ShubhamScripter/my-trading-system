import { describe, expect, it } from 'vitest';
import {
  kycRequirementQuerySchema,
  kycRequirementRequestSchema,
} from '../../src/kyc/kyc-requirement.dto';
import { adminTriggerKey } from '../../src/kyc/kyc.types';

/**
 * The wire contract for manual KYC obligations.
 *
 * ═══ THE DTO IS WHERE THE TRIGGER-KEY GRAMMAR IS ENFORCED ══════════════════
 *
 * `adminTriggerKey` throws on a malformed reference, and a throw out of a service is a
 * 500. So the schema has to refuse exactly what that function would reject — and the
 * cases below are chosen to pin the boundary rather than to sample it, because a
 * reference this service accepts and the consumer would spell differently does not
 * error: it occupies a different slot in `ux_kyc_requirements_open` and records one
 * administrative decision twice.
 */

const USER = '0195f0a0-bbbb-7000-8000-000000000002';
const REQUIREMENT = '0195f0a0-cccc-7000-8000-000000000003';

const REQUIRE = {
  action: 'require',
  userId: USER,
  requiredLevel: 'L1',
  reference: 'CASE-4182',
  reason: 'Sanctions review pending, ticket OPS-4182.',
};

const WAIVE = {
  action: 'waive',
  userId: USER,
  requirementId: REQUIREMENT,
  reason: 'Compliance case resolved.',
};

describe('require', () => {
  it('accepts a well-formed request', () => {
    const parsed = kycRequirementRequestSchema.parse(REQUIRE);
    expect(parsed).toMatchObject({ action: 'require', requiredLevel: 'L1', reference: 'CASE-4182' });
  });

  it('UPPERCASES the reference, so one case cannot become two rows', () => {
    // `case-123` and `CASE-123` are the same obligation. Normalising at the edge is
    // what stops them occupying two slots in the partial unique index.
    const parsed = kycRequirementRequestSchema.parse({ ...REQUIRE, reference: 'case-4182' });
    expect(parsed).toMatchObject({ reference: 'CASE-4182' });
  });

  it('trims the reference before validating it', () => {
    const parsed = kycRequirementRequestSchema.parse({ ...REQUIRE, reference: '  CASE-1  ' });
    expect(parsed).toMatchObject({ reference: 'CASE-1' });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('REFUSES a %s reference', (_label, reference) => {
    // ═══ THE COLLISION THIS PREVENTS ═════════════════════════════════════════
    //
    // The consumer's `adminTrigger(reference?)` permits omitting it, which yields the
    // bare key `ADMIN` — and then every manual requirement for one account collides
    // with the first and the index silently drops it.
    expect(kycRequirementRequestSchema.safeParse({ ...REQUIRE, reference }).success).toBe(false);
  });

  it.each([
    ['a colon, which is the key delimiter', 'CASE:1'],
    ['a leading hyphen', '-CASE'],
    ['a space inside', 'CASE 1'],
    ['a slash', 'CASE/1'],
    ['non-ascii', 'CASÉ'],
    ['over 63 characters', 'C'.repeat(64)],
  ])('REFUSES %s', (_label, reference) => {
    expect(kycRequirementRequestSchema.safeParse({ ...REQUIRE, reference }).success).toBe(false);
  });

  it('accepts exactly 63 characters, the segment ceiling', () => {
    const reference = `C${'1'.repeat(62)}`;
    expect(kycRequirementRequestSchema.safeParse({ ...REQUIRE, reference }).success).toBe(true);
  });

  it('refuses every reference the key builder would throw on', () => {
    // The two layers must agree: anything the DTO lets through must be something
    // `adminTriggerKey` can build, or a service throw becomes a 500.
    for (const reference of ['CASE:1', '-CASE', 'CASE 1', '', '   ', 'C'.repeat(64)]) {
      const accepted = kycRequirementRequestSchema.safeParse({ ...REQUIRE, reference }).success;
      let builds = true;
      try {
        adminTriggerKey(reference);
      } catch {
        builds = false;
      }
      expect(accepted, `reference ${JSON.stringify(reference)}`).toBe(builds);
    }
  });

  it('refuses a level outside L1/L2', () => {
    expect(
      kycRequirementRequestSchema.safeParse({ ...REQUIRE, requiredLevel: 'NONE' }).success,
    ).toBe(false);
    expect(
      kycRequirementRequestSchema.safeParse({ ...REQUIRE, requiredLevel: 'L3' }).success,
    ).toBe(false);
  });

  it('demands a reason, trimmed and bounded', () => {
    expect(kycRequirementRequestSchema.safeParse({ ...REQUIRE, reason: '' }).success).toBe(false);
    expect(kycRequirementRequestSchema.safeParse({ ...REQUIRE, reason: '  ' }).success).toBe(false);
    expect(
      kycRequirementRequestSchema.safeParse({ ...REQUIRE, reason: 'x'.repeat(257) }).success,
    ).toBe(false);
  });

  it('refuses an unknown field rather than ignoring it', () => {
    expect(
      kycRequirementRequestSchema.safeParse({ ...REQUIRE, requirementId: REQUIREMENT }).success,
    ).toBe(false);
  });

  it.each(['expiresAt', 'policyRegion', 'policyVersion', 'satisfiedAt', 'waivedAt', 'triggerKey'])(
    'refuses `%s`, which is not the operator to supply',
    (field) => {
      // `triggerKey` in particular: it is DERIVED from the reference. Accepting one
      // would let a caller write a key the consumer cannot interpret.
      expect(kycRequirementRequestSchema.safeParse({ ...REQUIRE, [field]: 'x' }).success).toBe(
        false,
      );
    },
  );
});

describe('waive', () => {
  it('accepts a well-formed request', () => {
    expect(kycRequirementRequestSchema.parse(WAIVE)).toMatchObject({ action: 'waive' });
  });

  it('demands a uuid requirementId', () => {
    expect(
      kycRequirementRequestSchema.safeParse({ ...WAIVE, requirementId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('demands a reason — the ONLY place a waiver reason is retained', () => {
    // `kyc_requirements` has no reason column and no migration was added for one, so
    // `ADMIN_KYC_REQUIREMENT_WAIVED` is the sole record of why.
    expect(kycRequirementRequestSchema.safeParse({ ...WAIVE, reason: '' }).success).toBe(false);
  });

  it('takes no reference or level — it names an existing row', () => {
    expect(
      kycRequirementRequestSchema.safeParse({ ...WAIVE, reference: 'CASE-1' }).success,
    ).toBe(false);
    expect(
      kycRequirementRequestSchema.safeParse({ ...WAIVE, requiredLevel: 'L1' }).success,
    ).toBe(false);
  });

  it('refuses an unknown action', () => {
    expect(kycRequirementRequestSchema.safeParse({ ...WAIVE, action: 'delete' }).success).toBe(
      false,
    );
  });
});

describe('the list filter', () => {
  it('REQUIRES userId, unlike the exemption listing', () => {
    // Requirements have no one-per-account ceiling and closed rows are kept forever, so
    // an unfiltered listing would be an unbounded scan.
    expect(kycRequirementQuerySchema.safeParse({}).success).toBe(false);
    expect(kycRequirementQuerySchema.safeParse({ userId: USER }).success).toBe(true);
  });

  it('defaults and bounds the limit', () => {
    expect(kycRequirementQuerySchema.parse({ userId: USER })).toMatchObject({ limit: 50 });
    // Query values arrive as text.
    expect(kycRequirementQuerySchema.parse({ userId: USER, limit: '10' })).toMatchObject({
      limit: 10,
    });
    expect(kycRequirementQuerySchema.safeParse({ userId: USER, limit: 0 }).success).toBe(false);
    expect(kycRequirementQuerySchema.safeParse({ userId: USER, limit: 201 }).success).toBe(false);
  });
});

describe('the trigger key builder', () => {
  it('produces the consumer spelling', () => {
    expect(adminTriggerKey('CASE-4182')).toBe('ADMIN:CASE-4182');
    expect(adminTriggerKey('  case-4182 ')).toBe('ADMIN:CASE-4182');
  });

  it('throws rather than emitting a key the consumer cannot read', () => {
    expect(() => adminTriggerKey('CASE:1')).toThrow();
    expect(() => adminTriggerKey('')).toThrow();
  });
});
