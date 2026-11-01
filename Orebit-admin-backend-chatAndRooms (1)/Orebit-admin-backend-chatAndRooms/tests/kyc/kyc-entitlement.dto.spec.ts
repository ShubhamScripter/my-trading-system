import { describe, expect, it } from 'vitest';
import { kycEntitlementRequestSchema } from '../../src/kyc/kyc-entitlement.dto';
import { KYC_ENTITLEMENT_LEVELS } from '../../src/kyc/kyc.types';
import { VALID_ENTITLEMENTS, VALID_UPGRADE } from './kyc.cases';

/**
 * ═══ THE BOUNDARY IN FRONT OF SEVENTY-ONE COLUMNS ══════════════════════════
 *
 * Every rule asserted here also exists as a CHECK constraint in ../Orebit-backend's
 * `db/sql/identity.sql`. The duplication is deliberate and the division of labour is
 * the same one `kyc-policy.dto.spec.ts` states: the constraint is the AUTHORITY,
 * because rows get hand-edited in psql during incidents and a DTO in this service is
 * not a constraint on that one; the DTO exists so an operator gets a 400 naming the
 * field instead of a 500 carrying a Postgres constraint name.
 *
 * ─── What a body this large needs most ────────────────────────────────────
 *
 * A typo in a key. `.strict()` on every nested object is what turns that from a
 * silently dropped field into a refusal, and it is the first thing asserted below —
 * because on a full-state write, a dropped field does not mean "unchanged", it means
 * the schema rejected the whole body or wrote a default.
 */

/** A valid body with one path overridden, so each case differs by exactly one thing. */
function withFeature(path: readonly string[], value: unknown): unknown {
  const body = structuredClone(VALID_ENTITLEMENTS) as Record<string, unknown>;
  let cursor = body;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1] as string] = value;
  return body;
}

function parse(body: unknown) {
  return kycEntitlementRequestSchema.safeParse(body);
}

const FEATURES = VALID_ENTITLEMENTS.features;

/** The `path` of the first issue, joined — what an operator sees pointed at. */
function firstIssuePath(body: unknown): string {
  const result = parse(body);
  if (result.success) throw new Error('expected the body to be refused');
  return (result.error.issues[0]?.path ?? []).join('.');
}

describe('the valid bodies parse', () => {
  it('accepts a fully specified entitlements write', () => {
    const result = parse(VALID_ENTITLEMENTS);
    expect(result.success).toBe(true);
  });

  it('accepts an upgrade write', () => {
    const result = parse(VALID_UPGRADE);
    expect(result.success).toBe(true);
  });

  it('accepts an entitlements write that grants nothing', () => {
    // Every switch false and every ceiling null is a LEGITIMATE configuration — it is
    // how an operator says "this level grants nothing" — and it must not be mistaken
    // for an incomplete body.
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.limits = { currency: null, withdrawal: null, exchange: null, balance: null };
    body.features.withdraw = {
      enabled: false,
      maxPerTransaction: null,
      amountLimit: null,
      countLimit: null,
      limitWindowSeconds: null,
      minimumGapSeconds: null,
      securityThreshold: null,
    };
    body.features.exchange = {
      enabled: false,
      minAmount: null,
      maxAmount: null,
      maxPerExchange: null,
      smallExchangeEnabled: false,
      multiCoinExchangeEnabled: false,
      availableCoins: [],
    };
    body.features.transfer = {
      enabled: false,
      minAmount: null,
      maxAmount: null,
      maxPerTransfer: null,
      maxTransferPerUser: null,
    };
    body.features.bankroll = { enabled: false, maxInvestment: null };

    expect(parse(body).success).toBe(true);
  });
});

describe('unknown fields are refused, never dropped', () => {
  it('refuses an unknown top-level field', () => {
    expect(parse({ ...VALID_ENTITLEMENTS, wat: true }).success).toBe(false);
  });

  it('refuses an unknown field inside a feature group', () => {
    // The failure this guards is a typo in a key on a full-state write: silently
    // dropping it would leave the operator believing they had set something.
    // Built by spreading rather than by mutating a clone, so the malformed shape is
    // visible in the test rather than assembled by index access the type system has to
    // be argued out of.
    expect(
      parse({
        ...VALID_ENTITLEMENTS,
        features: {
          ...FEATURES,
          withdraw: { ...FEATURES.withdraw, maxPerTxn: '1' },
        },
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown field inside a nested sub-feature', () => {
    expect(
      parse({
        ...VALID_ENTITLEMENTS,
        features: {
          ...FEATURES,
          tools: {
            ...FEATURES.tools,
            tipBox: { ...FEATURES.tools.tipBox, maxBoxes: 4 },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('refuses a missing feature group — this is a full-state write', () => {
    const { faucet: _dropped, ...withoutFaucet } = FEATURES;
    expect(parse({ ...VALID_ENTITLEMENTS, features: withoutFaucet }).success).toBe(false);
  });
});

describe('the level vocabulary', () => {
  it.each(KYC_ENTITLEMENT_LEVELS)('accepts %s', (level) => {
    // NONE included, and that is the point: this is the one surface in the service
    // where it is a destination rather than a state.
    expect(parse({ ...VALID_ENTITLEMENTS, level }).success).toBe(true);
  });

  it('refuses a level the vocabulary does not have', () => {
    expect(parse({ ...VALID_ENTITLEMENTS, level: 'L3' }).success).toBe(false);
  });

  it('refuses NONE as an upgrade TARGET', () => {
    // Nobody upgrades to holding nothing. `ck_kyc_upgrade_requirements_level` refuses
    // it at the database too.
    expect(parse({ ...VALID_UPGRADE, targetLevel: 'NONE' }).success).toBe(false);
  });
});

describe('amounts are exact decimal strings', () => {
  it.each([
    ['a JSON number', 1000],
    ['an exponential string', '1e4'],
    ['a signed string', '-1000'],
    ['a leading-zero string', '01000'],
    ['more than 18 decimal places', '1.0000000000000000001'],
    ['more than 20 integer digits', '123456789012345678901'],
    ['an empty string', ''],
    ['a string with a space', '1 000'],
  ])('refuses %s', (_what, value) => {
    // A JSON number is the one that matters most: `10000.000000000000000001` parsed as
    // a number is 10000, and the comparison the ceiling exists for would be wrong at
    // exactly the boundary it turns on.
    expect(firstIssuePath(withFeature(['limits', 'withdrawal'], value))).toContain('withdrawal');
  });

  it('refuses zero — null is how you say "no ceiling"', () => {
    // A stored zero would be a total prohibition wearing the costume of a limit.
    expect(parse(withFeature(['limits', 'withdrawal'], '0')).success).toBe(false);
    expect(parse(withFeature(['limits', 'withdrawal'], '0.000000000000000000')).success).toBe(
      false,
    );
  });

  it('accepts 18 decimal places and 20 integer digits', () => {
    expect(
      parse(withFeature(['limits', 'withdrawal'], '12345678901234567890.000000000000000001'))
        .success,
    ).toBe(true);
  });
});

describe('counts and durations are positive integers', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '5'],
  ])('refuses %s for a count ceiling', (_what, value) => {
    expect(parse(withFeature(['features', 'tools', 'tipBox', 'maxTipBoxes'], value)).success).toBe(
      false,
    );
  });

  it('accepts null for a count ceiling', () => {
    expect(parse(withFeature(['features', 'tools', 'tipBox', 'maxTipBoxes'], null)).success).toBe(
      true,
    );
  });
});

describe('a currency is required exactly when an amount is set', () => {
  it('refuses an amount with no denomination', () => {
    // `ck_kyc_level_entitlements_currency`. With no FX service reachable, an amount with
    // no denomination either never applies or applies to the wrong currency.
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.limits.currency = null;
    expect(firstIssuePath(body)).toBe('limits.currency');
  });

  it('refuses a denomination with nothing to denominate', () => {
    // Stricter than the database, deliberately: a currency with no amount is
    // configuration that does nothing and will read as if it did the day somebody sets
    // a threshold.
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.limits = { currency: 'USDT', withdrawal: null, exchange: null, balance: null };
    body.features.withdraw = {
      enabled: false,
      maxPerTransaction: null,
      amountLimit: null,
      countLimit: null,
      limitWindowSeconds: null,
      minimumGapSeconds: null,
      securityThreshold: null,
    };
    body.features.exchange = {
      enabled: false,
      minAmount: null,
      maxAmount: null,
      maxPerExchange: null,
      smallExchangeEnabled: false,
      multiCoinExchangeEnabled: false,
      availableCoins: [],
    };
    body.features.transfer = {
      enabled: false,
      minAmount: null,
      maxAmount: null,
      maxPerTransfer: null,
      maxTransferPerUser: null,
    };
    body.features.bankroll = { enabled: false, maxInvestment: null };

    expect(firstIssuePath(body)).toBe('limits.currency');
  });

  it('notices an amount buried in a feature group, not just in limits', () => {
    // Fourteen amounts across five groups. The rule is collected from a list precisely
    // so that a new amount cannot be added without appearing in it — and this asserts
    // the list reaches past `limits`.
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.limits = { currency: null, withdrawal: null, exchange: null, balance: null };
    body.features.transfer.maxPerTransfer = '50';
    expect(firstIssuePath(body)).toBe('limits.currency');
  });

  it('normalises a currency to uppercase', () => {
    const result = parse(withFeature(['limits', 'currency'], 'usdt'));
    expect(result.success).toBe(true);
    if (!result.success || result.data.action !== 'entitlements') return;
    // The constraint demands `= upper(btrim(x))`, so normalising here is what keeps a
    // lowercase form from being refused by the database instead of accepted here.
    expect(result.data.limits.currency).toBe('USDT');
  });

  it('refuses a currency with an inner space', () => {
    // `btrim` would let this through; the character class is what stops it.
    expect(parse(withFeature(['limits', 'currency'], 'US D')).success).toBe(false);
  });
});

describe('the withdrawal window is required exactly when a ceiling uses it', () => {
  it('refuses an amount ceiling with no window', () => {
    expect(
      firstIssuePath(withFeature(['features', 'withdraw', 'limitWindowSeconds'], null)),
    ).toBe('features.withdraw.limitWindowSeconds');
  });

  it('refuses a count ceiling with no window', () => {
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.features.withdraw.amountLimit = null;
    body.features.withdraw.limitWindowSeconds = null;
    expect(firstIssuePath(body)).toBe('features.withdraw.limitWindowSeconds');
  });

  it('refuses a window with neither ceiling', () => {
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.features.withdraw.amountLimit = null;
    body.features.withdraw.countLimit = null;
    expect(firstIssuePath(body)).toBe('features.withdraw.limitWindowSeconds');
  });

  it('accepts a window with only the count ceiling', () => {
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.features.withdraw.amountLimit = null;
    expect(parse(body).success).toBe(true);
  });
});

describe('a minimum above a maximum is refused', () => {
  it.each([['exchange'], ['transfer']] as const)('%s', (area) => {
    // Dead configuration that reads as though it worked: no amount satisfies both, so
    // the feature is closed while appearing bounded.
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.features[area].minAmount = '1000';
    body.features[area].maxAmount = '999';
    expect(firstIssuePath(body)).toBe(`features.${area}.minAmount`);
  });

  it('accepts a minimum EQUAL to the maximum', () => {
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.features.exchange.minAmount = '1000';
    body.features.exchange.maxAmount = '1000';
    expect(parse(body).success).toBe(true);
  });

  it('compares by value rather than lexically', () => {
    // '9' > '1000' lexically and is smaller numerically. A string comparison here would
    // refuse a perfectly ordinary configuration.
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.features.exchange.minAmount = '9';
    body.features.exchange.maxAmount = '1000';
    expect(parse(body).success).toBe(true);
  });

  it('compares fractional parts of differing widths', () => {
    const body = structuredClone(VALID_ENTITLEMENTS);
    body.features.exchange.minAmount = '1.5';
    body.features.exchange.maxAmount = '1.25';
    expect(parse(body).success).toBe(false);
  });
});

describe('allow-lists are canonicalised', () => {
  it('deduplicates and sorts', () => {
    const result = parse(
      withFeature(['features', 'exchange', 'availableCoins'], ['ETH', 'BTC', 'ETH']),
    );
    expect(result.success).toBe(true);
    if (!result.success || result.data.action !== 'entitlements') return;
    // Canonical storage: two writes of the same set in a different order produce the
    // same row, so a diff of two versions shows a real change.
    expect(result.data.features.exchange.availableCoins).toEqual(['BTC', 'ETH']);
  });

  it('refuses an empty entry', () => {
    expect(parse(withFeature(['features', 'exchange', 'availableCoins'], [''])).success).toBe(
      false,
    );
  });

  it('accepts an empty list', () => {
    expect(parse(withFeature(['features', 'exchange', 'availableCoins'], [])).success).toBe(true);
  });
});

describe('the compare-and-swap token', () => {
  it('refuses 0 for an entitlements write — every level always has a row', () => {
    // The asymmetry with `upgrade` below. Accepting 0 here would mean silently matching
    // nothing and reporting a lost swap for a request that could never have succeeded.
    expect(firstIssuePath({ ...VALID_ENTITLEMENTS, expectedVersion: 0 })).toBe(
      'expectedVersion',
    );
  });

  it('accepts 0 for an upgrade write — those rows are not seeded', () => {
    expect(parse({ ...VALID_UPGRADE, expectedVersion: 0 }).success).toBe(true);
  });

  it('refuses a negative or fractional version', () => {
    expect(parse({ ...VALID_ENTITLEMENTS, expectedVersion: -1 }).success).toBe(false);
    expect(parse({ ...VALID_ENTITLEMENTS, expectedVersion: 1.5 }).success).toBe(false);
  });
});

describe('a reason is required on every write', () => {
  it.each([
    ['entitlements', VALID_ENTITLEMENTS],
    ['upgrade', VALID_UPGRADE],
  ] as const)('%s refuses a missing reason', (_action, body) => {
    const { reason: _dropped, ...rest } = body;
    expect(parse(rest).success).toBe(false);
  });

  it('refuses a whitespace-only reason', () => {
    expect(parse({ ...VALID_ENTITLEMENTS, reason: '   ' }).success).toBe(false);
  });
});

describe('the upgrade deposit route is two facts or none', () => {
  it('refuses a threshold with no window', () => {
    expect(firstIssuePath({ ...VALID_UPGRADE, depositWindowDays: null })).toBe(
      'depositWindowDays',
    );
  });

  it('refuses a window with no threshold', () => {
    expect(firstIssuePath({ ...VALID_UPGRADE, depositThreshold: null })).toBe(
      'depositWindowDays',
    );
  });

  it('accepts neither — the deposit route simply is not offered', () => {
    expect(
      parse({ ...VALID_UPGRADE, depositThreshold: null, depositWindowDays: null }).success,
    ).toBe(true);
  });

  it('accepts a balance-only route', () => {
    expect(
      parse({
        ...VALID_UPGRADE,
        depositThreshold: null,
        depositWindowDays: null,
        minimumBalance: '5000',
      }).success,
    ).toBe(true);
  });

  it('accepts no route at all — withdrawing both is a legitimate configuration', () => {
    expect(
      parse({
        ...VALID_UPGRADE,
        minimumBalance: null,
        depositThreshold: null,
        depositWindowDays: null,
        thresholdCurrency: null,
      }).success,
    ).toBe(true);
  });

  it('refuses a threshold of zero — every account would be instantly eligible', () => {
    expect(parse({ ...VALID_UPGRADE, minimumBalance: '0' }).success).toBe(false);
  });

  it('refuses a currency with no threshold to denominate', () => {
    expect(
      firstIssuePath({
        ...VALID_UPGRADE,
        minimumBalance: null,
        depositThreshold: null,
        depositWindowDays: null,
        thresholdCurrency: 'USDT',
      }),
    ).toBe('thresholdCurrency');
  });

  it('refuses a threshold with no currency', () => {
    expect(firstIssuePath({ ...VALID_UPGRADE, thresholdCurrency: null })).toBe(
      'thresholdCurrency',
    );
  });
});

describe('there is no userId anywhere on this surface', () => {
  it('refuses a body that names an account', () => {
    // This surface targets a RULE. A `userId` reaching it would be the first step
    // towards a per-account entitlement override, which is what exemptions are for.
    expect(
      parse({ ...VALID_ENTITLEMENTS, userId: '0195f0a0-bbbb-7000-8000-000000000002' }).success,
    ).toBe(false);
  });
});
