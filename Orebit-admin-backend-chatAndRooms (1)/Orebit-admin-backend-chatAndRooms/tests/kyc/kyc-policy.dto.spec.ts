import { describe, expect, it } from 'vitest';
import {
  kycExemptionQuerySchema,
  kycExemptionRequestSchema,
} from '../../src/kyc/kyc-exemption.dto';
import {
  kycPolicyHistoryQuerySchema,
  kycPolicyRequestSchema,
} from '../../src/kyc/kyc-policy.dto';
import { CHECK_CASES, VALID_POLICY } from './kyc.cases';

/**
 * The validation boundary.
 *
 * ═══ WHY THIS SUITE CARRIES THE WEIGHT OF THE PHASE ════════════════════════
 *
 * Everything below the DTO is a faithful write: the persistence layer stores what it
 * is given, and the consumer enforces what it finds. So a rule that is not here is a
 * rule nowhere — either a 500 from a database constraint, or, worse, a row the
 * consumer silently discards while an admin screen shows it as configured.
 */

/**
 * `safeParse`, reduced to the field names an operator would be pointed at.
 *
 * Two zod shapes need flattening before a field name falls out:
 *
 *   · an issue inside an array reports `features.0`, because the offending ELEMENT is
 *     what failed. The containing field is what a form highlights, so both are
 *     returned.
 *   · `unrecognized_keys` reports the path of the OBJECT (the root, `''`) and carries
 *     the offending names in `keys` — which is the whole point of `.strict()`, so
 *     those names are lifted into the list.
 */
function issuesOf(schema: { safeParse: (v: unknown) => unknown }, body: unknown): string[] {
  const result = schema.safeParse(body) as
    | { success: true }
    | {
        success: false;
        error: { issues: Array<{ path: Array<string | number>; keys?: string[] }> };
      };
  if (result.success) return [];

  return result.error.issues.flatMap((issue) => {
    const path = issue.path.join('.');
    const container = issue.path.length > 1 ? [String(issue.path[0])] : [];
    return [path, ...container, ...(issue.keys ?? [])];
  });
}

describe('a valid policy is accepted', () => {
  it('parses the baseline', () => {
    const parsed = kycPolicyRequestSchema.safeParse(VALID_POLICY);
    expect(parsed.success, JSON.stringify(issuesOf(kycPolicyRequestSchema, VALID_POLICY))).toBe(
      true,
    );
  });

  it('accepts the global region', () => {
    expect(kycPolicyRequestSchema.safeParse({ ...VALID_POLICY, region: '*' }).success).toBe(true);
  });

  it('accepts either level', () => {
    for (const level of ['L1', 'L2']) {
      expect(kycPolicyRequestSchema.safeParse({ ...VALID_POLICY, level }).success).toBe(true);
    }
  });

  it('normalises a lowercase region, so a row the consumer could not read is unwritable', () => {
    // `narrowPolicy` uppercases on read, but `ck_kyc_policies_region` would refuse a
    // lowercase value outright — so normalising here is what makes `in` a working
    // request rather than a 500.
    const parsed = kycPolicyRequestSchema.parse({ ...VALID_POLICY, region: 'in' });
    expect(parsed).toMatchObject({ region: 'IN' });
  });

  it('normalises a lowercase threshold currency', () => {
    const parsed = kycPolicyRequestSchema.parse({
      ...VALID_POLICY,
      balanceThreshold: '10000',
      thresholdCurrency: 'usdt',
    });
    expect(parsed).toMatchObject({ thresholdCurrency: 'USDT' });
  });

  it('accepts a complete rolling window', () => {
    expect(
      kycPolicyRequestSchema.safeParse({
        ...VALID_POLICY,
        rollingWindowAmount: '1000',
        rollingWindowSeconds: 86_400,
        rollingWindowOperation: 'WITHDRAWAL',
        thresholdCurrency: 'USD',
      }).success,
    ).toBe(true);
  });

  it('accepts a zero grace period, which the constraint permits', () => {
    expect(
      kycPolicyRequestSchema.safeParse({
        ...VALID_POLICY,
      }).success,
    ).toBe(true);
  });

  it('accepts a threshold at the full precision the column holds', () => {
    // 20 integer digits and 18 decimals is exactly numeric(38,18). A float64 could not
    // carry this, which is why the field is a string.
    expect(
      kycPolicyRequestSchema.safeParse({
        ...VALID_POLICY,
        balanceThreshold: '12345678901234567890.123456789012345678',
        thresholdCurrency: 'USD',
      }).success,
    ).toBe(true);
  });

  it('accepts triggersOnly when there IS something to trigger on', () => {
    expect(
      kycPolicyRequestSchema.safeParse({
        ...VALID_POLICY,
        triggersOnly: true,
        required: false,
        balanceThreshold: '10000',
        thresholdCurrency: 'USD',
      }).success,
    ).toBe(true);
  });

  it('accepts triggersOnly with NOTHING to trigger on — an admin requirement is the trigger', () => {
    // ═══ THE RULE THIS REPLACES, AND WHY IT WAS WRONG ══════════════════════
    //
    // The DTO used to refuse this, on the reasoning that verification in such a region
    // would be permanently unreachable. `/kyc-requirements` made that false: the
    // consumer's `mayStart` opens verification on ANY open requirement, whatever the
    // policy triggers on, and its own integration suite carries a case named "opens
    // verification in a triggersOnly region, and closes it again on waiver".
    //
    // ⚠ And the rule was backwards in practice. Of the six trigger kinds, only `ADMIN`
    //   can fire today — the four threshold kinds need `KYC_THRESHOLD_DATA_PORT`, which
    //   is bound to `null`, and `FEATURE_ATTEMPT` needs `PLATFORM_FEATURES`, which is
    //   `{}`. So the old rule refused the only triggersOnly configuration that works,
    //   while accepting one that names a feature and then resolves to zero targets.
    expect(
      kycPolicyRequestSchema.safeParse({
        ...VALID_POLICY,
        triggersOnly: true,
        required: false,
        balanceThreshold: null,
        thresholdCurrency: null,
        features: [],
        subFeatures: [],
      }).success,
    ).toBe(true);
  });

  it('still refuses an enabled policy that demands nothing and triggers on nothing', () => {
    // The OTHER guard, deliberately kept: its reasoning is untouched by the change
    // above. Such a row is indistinguishable from having none, except that it takes
    // precedence over the global `*` rule and so silently suppresses it.
    const result = kycPolicyRequestSchema.safeParse({
      ...VALID_POLICY,
      required: false,
      triggersOnly: false,
      balanceThreshold: null,
      thresholdCurrency: null,
      features: [],
      subFeatures: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts required together with triggersOnly', () => {
    // NOT a contradiction: the consumer's evaluator zeroes the generic obligation when
    // `triggersOnly` is set, regardless of `required`. Refusing the combination here
    // would reject a policy the enforcer treats as meaningful.
    expect(
      kycPolicyRequestSchema.safeParse({
        ...VALID_POLICY,
        required: true,
        triggersOnly: true,
        balanceThreshold: '10000',
        thresholdCurrency: 'USD',
      }).success,
    ).toBe(true);
  });
});

describe('every database CHECK and DTO-only rule is mirrored', () => {
  it.each(CHECK_CASES.map((c) => [c.name, c] as const))('rejects %s', (_name, testCase) => {
    const body = { ...VALID_POLICY, ...testCase.patch };
    const paths = issuesOf(kycPolicyRequestSchema, body);

    expect(paths.length, `expected a rejection for: ${testCase.name}`).toBeGreaterThan(0);
    expect(paths, `expected an issue on "${testCase.path}"`).toContain(testCase.path);
  });
});

describe('the account is never taken from the body', () => {
  it('refuses a body carrying a userId outright, rather than ignoring it', () => {
    // `.strict()`. Silently dropping it would mean a client that believed it was
    // targeting somebody got a 200 and a write against a different subject.
    const paths = issuesOf(kycPolicyRequestSchema, { ...VALID_POLICY, userId: 'x' });
    expect(paths).toContain('userId');
  });
});

describe('a partial body cannot silently clear a live policy', () => {
  it('requires every nullable field to be stated', () => {
    // No `.optional()` and no `.default()` anywhere in the upsert: this write stores
    // every column, so an omitted threshold would WIPE a threshold currently in force.
    // An explicit null is the difference between "no limit" and "I forgot the field".
    const { balanceThreshold: _omitted, ...partial } = VALID_POLICY;
    expect(kycPolicyRequestSchema.safeParse(partial).success).toBe(false);
  });
});

describe('delete', () => {
  const remove = {
    action: 'delete' as const,
    region: 'IN',
    level: 'L1',
    reason: 'India now follows the global rule.',
    expectedVersion: 1,
  };

  it('accepts a well-formed removal', () => {
    expect(kycPolicyRequestSchema.safeParse(remove).success).toBe(true);
  });

  it('refuses expectedVersion 0 — there would be nothing to remove', () => {
    expect(issuesOf(kycPolicyRequestSchema, { ...remove, expectedVersion: 0 })).toContain(
      'expectedVersion',
    );
  });

  it('requires a reason, so the tombstone records why', () => {
    expect(issuesOf(kycPolicyRequestSchema, { ...remove, reason: '' })).toContain('reason');
  });

  it('refuses policy fields on a removal', () => {
    expect(issuesOf(kycPolicyRequestSchema, { ...remove, enabled: true })).toContain('enabled');
  });
});

describe('history query', () => {
  it('coerces limit from a query string', () => {
    // Query values always arrive as text; without `z.coerce` every request would fail.
    expect(kycPolicyHistoryQuerySchema.parse({ region: 'IN', level: 'L1', limit: '10' })).toEqual({
      region: 'IN',
      level: 'L1',
      limit: 10,
    });
  });

  it('defaults the limit', () => {
    expect(kycPolicyHistoryQuerySchema.parse({ region: 'IN', level: 'L1' }).limit).toBe(50);
  });

  it('caps the limit', () => {
    expect(
      issuesOf(kycPolicyHistoryQuerySchema, { region: 'IN', level: 'L1', limit: '5000' }),
    ).toContain('limit');
  });

  it('requires a target', () => {
    expect(issuesOf(kycPolicyHistoryQuerySchema, { level: 'L1' })).toContain('region');
  });
});

describe('exemptions', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();

  const grant = {
    action: 'grant' as const,
    userId: '0195f0a0-1111-7000-8000-000000000001',
    effectiveLevel: 'L1',
    reason: 'Sanctioned onboarding exception, ticket OPS-4182.',
    expiresAt: future,
  };

  it('accepts a well-formed grant', () => {
    expect(kycExemptionRequestSchema.safeParse(grant).success).toBe(true);
  });

  it('accepts a permanent grant when it is stated explicitly', () => {
    expect(kycExemptionRequestSchema.safeParse({ ...grant, expiresAt: null }).success).toBe(true);
  });

  it('refuses a grant with expiresAt omitted', () => {
    // Nullable but never optional: a field that defaults to permanent is how an
    // accidental permanent exemption happens. Permanence has to be typed out.
    const { expiresAt: _omitted, ...partial } = grant;
    expect(kycExemptionRequestSchema.safeParse(partial).success).toBe(false);
  });

  it('refuses an expiry in the past', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(issuesOf(kycExemptionRequestSchema, { ...grant, expiresAt: past })).toContain(
      'expiresAt',
    );
  });

  it('refuses an expiry too close to now for clock skew to be safe', () => {
    // A row that lands already expired grants nothing AND occupies the account's one
    // live slot, so it can neither be used nor replaced. A minute of headroom puts
    // that state out of reach.
    const barely = new Date(Date.now() + 5_000).toISOString();
    expect(issuesOf(kycExemptionRequestSchema, { ...grant, expiresAt: barely })).toContain(
      'expiresAt',
    );
  });

  it('requires a non-empty reason, matching the NOT NULL column and its btrim CHECK', () => {
    expect(issuesOf(kycExemptionRequestSchema, { ...grant, reason: '   ' })).toContain('reason');
  });

  it('refuses a level outside L1/L2', () => {
    expect(issuesOf(kycExemptionRequestSchema, { ...grant, effectiveLevel: 'NONE' })).toContain(
      'effectiveLevel',
    );
  });

  it('refuses a malformed account id', () => {
    expect(issuesOf(kycExemptionRequestSchema, { ...grant, userId: 'not-a-uuid' })).toContain(
      'userId',
    );
  });

  it('refuses unknown fields', () => {
    expect(issuesOf(kycExemptionRequestSchema, { ...grant, sneak: 1 })).toContain('sneak');
  });

  const revoke = {
    action: 'revoke' as const,
    userId: '0195f0a0-1111-7000-8000-000000000001',
    exemptionId: '0195f0a0-2222-7000-8000-000000000002',
    reason: 'Exception withdrawn.',
  };

  it('accepts a well-formed revoke', () => {
    expect(kycExemptionRequestSchema.safeParse(revoke).success).toBe(true);
  });

  it('requires both the account and the exemption on a revoke', () => {
    // The id alone would identify the row; the pair is what stops a console that has
    // paired a displayed user with a stale row id from revoking somebody else's relief.
    const { userId: _omitted, ...partial } = revoke;
    expect(kycExemptionRequestSchema.safeParse(partial).success).toBe(false);
  });

  it('refuses grant fields on a revoke', () => {
    expect(issuesOf(kycExemptionRequestSchema, { ...revoke, expiresAt: null })).toContain(
      'expiresAt',
    );
  });

  it('coerces and caps the list limit', () => {
    expect(kycExemptionQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(kycExemptionQuerySchema.parse({}).limit).toBe(50);
    expect(kycExemptionQuerySchema.safeParse({ limit: '5000' }).success).toBe(false);
  });

  it('allows the account filter to be omitted, which lists everyone holding relief', () => {
    expect(kycExemptionQuerySchema.safeParse({}).success).toBe(true);
  });
});
