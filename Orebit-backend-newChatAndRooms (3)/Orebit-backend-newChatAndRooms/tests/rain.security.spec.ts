import { describe, expect, it } from 'vitest';
import {
  applyStatusPatch,
  DEFAULT_RAIN_CONFIG,
  effectiveStatus,
  RainConfigSchema,
  RainRevertFilterSchema,
  RainStatusPatchSchema,
  type RainConfig,
} from '../src/social/rain/rain.contract';
import { parseMinor } from '../src/social/rain/rain.math';
import {
  codesSatisfied,
  kycShortfall,
  needsUsdValue,
  questionnairePassed,
  verificationNeed,
} from '../src/social/rain/rain.security';

const USD = (text: string) => parseMinor(text)!;

function config(patch: (c: RainConfig) => void): RainConfig {
  const c = structuredClone(DEFAULT_RAIN_CONFIG);
  patch(c);
  return RainConfigSchema.parse(c);
}

const known = { isNewIp: false, isNewCountry: false, anonymised: false };
const newIp = { isNewIp: true, isNewCountry: false, anonymised: false };
const newCountry = { isNewIp: true, isNewCountry: true, anonymised: false };
const vpn = { isNewIp: true, isNewCountry: false, anonymised: true };

const QUESTION = { text: 'Are you raining your own money?', options: ['Yes', 'No'], okOptions: [0] };

describe('rain contract version 4', () => {
  it('refuses Normal and Premium percentages that do not add up to 100', () => {
    const doc = structuredClone(DEFAULT_RAIN_CONFIG);
    doc.system.allocation = { normalPercent: 60, plans: [{ planId: '*', percent: 50 }] };
    expect(RainConfigSchema.safeParse(doc).success).toBe(false);
    const user = structuredClone(DEFAULT_RAIN_CONFIG);
    user.user.allocation = { normalPercent: 70, plans: [{ planId: 'gold', percent: 20 }] };
    expect(RainConfigSchema.safeParse(user).success).toBe(false);
  });

  it('refuses a switched-on questionnaire with no questions, and an OK answer that is not an option', () => {
    const empty = structuredClone(DEFAULT_RAIN_CONFIG);
    empty.security.newCountry = { enabled: true, amountAboveUsd: null, questionnaire: true, kycCheck: false };
    expect(RainConfigSchema.safeParse(empty).success).toBe(false);
    const bad = structuredClone(DEFAULT_RAIN_CONFIG);
    bad.security.questions = [{ text: 'Pick one please', options: ['A', 'B'], okOptions: [3] }];
    expect(RainConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('keeps "Rain Amount" in USD with the maximum at least the minimum', () => {
    const doc = structuredClone(DEFAULT_RAIN_CONFIG);
    doc.system.amountUsd = { min: '10', max: '5' };
    expect(RainConfigSchema.safeParse(doc).success).toBe(false);
    doc.system.amountUsd = { min: '5', max: '5' };
    expect(RainConfigSchema.safeParse(doc).success).toBe(true);
  });

  it('reads "Rain Happens Every" in minutes or hours, at least 30 seconds and min ≤ max', () => {
    const doc = structuredClone(DEFAULT_RAIN_CONFIG);
    doc.system.interval = { min: { value: 2, unit: 'HOURS' }, max: { value: 30, unit: 'MINUTES' } };
    expect(RainConfigSchema.safeParse(doc).success).toBe(false);
    doc.system.interval = { min: { value: 10, unit: 'SECONDS' }, max: { value: 1, unit: 'MINUTES' } };
    expect(RainConfigSchema.safeParse(doc).success).toBe(false);
    doc.system.interval = { min: { value: 30, unit: 'MINUTES' }, max: { value: 2, unit: 'HOURS' } };
    expect(RainConfigSchema.safeParse(doc).success).toBe(true);
  });

  it('accepts the /rain limits in USD (same for all) or per currency', () => {
    const doc = structuredClone(DEFAULT_RAIN_CONFIG);
    doc.user.minAmount = { mode: 'PER_CURRENCY', usd: '1', perCurrency: [{ code: 'btc', amount: '0.001' }] };
    doc.user.maxAmount = { mode: 'PER_CURRENCY', usd: '1', perCurrency: [{ code: 'BTC', amount: '0.0001' }] };
    expect(RainConfigSchema.safeParse(doc).success).toBe(false);
    doc.user.maxAmount.perCurrency = [{ code: 'BTC', amount: '1' }];
    const parsed = RainConfigSchema.parse(doc);
    expect(parsed.user.minAmount.perCurrency[0]!.code).toBe('BTC');
  });

  it('refuses a fee with more than two decimals and a DYNAMIC reward with no y$', () => {
    const fee = structuredClone(DEFAULT_RAIN_CONFIG);
    fee.user.feePercent = 2.555;
    expect(RainConfigSchema.safeParse(fee).success).toBe(false);
    const reward = structuredClone(DEFAULT_RAIN_CONFIG);
    reward.rewards.perRainDone.exp = { mode: 'DYNAMIC', amount: 5, everyUsd: '0' };
    expect(RainConfigSchema.safeParse(reward).success).toBe(false);
  });
});

describe('ON / OFF / MAINTAIN', () => {
  it('"Disable Overall Rains" stops both sides; overall maintenance covers the sides that are not off', () => {
    const on = config((c) => {
      c.status = { overall: 'ON', system: 'ON', user: 'OFF', note: null };
    });
    expect(effectiveStatus(on, 'system')).toBe('ON');
    expect(effectiveStatus(on, 'user')).toBe('OFF');
    const off = applyStatusPatch(on, { overall: 'OFF' });
    expect(effectiveStatus(off, 'system')).toBe('OFF');
    const maintain = applyStatusPatch(on, { overall: 'MAINTENANCE', note: 'Back soon' });
    expect(effectiveStatus(maintain, 'system')).toBe('MAINTENANCE');
    expect(effectiveStatus(maintain, 'user')).toBe('OFF');
    expect(maintain.status.note).toBe('Back soon');
  });

  it('refuses an empty scheduled change', () => {
    expect(RainStatusPatchSchema.safeParse({}).success).toBe(false);
    expect(RainStatusPatchSchema.safeParse({ user: 'MAINTENANCE' }).success).toBe(true);
  });
});

describe('revert filters', () => {
  it('takes a time frame, coins and users or a group', () => {
    const filter = RainRevertFilterSchema.parse({
      kind: 'USER',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-02T00:00:00Z',
      currencies: ['btc'],
      who: { role: 'RECIPIENT', userIds: [], group: { targetType: 'PREMIUM' } },
    });
    expect(filter.currencies).toEqual(['BTC']);
    expect(RainRevertFilterSchema.safeParse({ ...filter, who: { role: 'RAINER', userIds: [], group: null } }).success).toBe(false);
    expect(
      RainRevertFilterSchema.safeParse({ ...filter, from: '2026-10-03T00:00:00Z' }).success,
    ).toBe(false);
  });
});

describe('security rules', () => {
  const tiers = config((c) => {
    c.security.newIpSameCountry = { enabled: true, amountAboveUsd: '100', require: 'ONE' };
    c.security.newCountry = { enabled: true, amountAboveUsd: '500', questionnaire: true, kycCheck: true };
    c.security.vpnProxy = { enabled: true, amountAboveUsd: '1000', questionnaire: 'MANUAL', kycCheck: 'AUTO' };
    c.security.questions = [QUESTION];
    c.security.kycMinLevel = 2;
  });

  it('asks nothing from a common login IP below every amount', () => {
    expect(verificationNeed(tiers, USD('50'), known)).toBeNull();
  });

  it('new IP, same country: one of the two codes ("Require One")', () => {
    expect(verificationNeed(tiers, USD('50'), newIp)).toMatchObject({ tier: 1, require: 'ONE', reasons: ['NEW_IP'] });
  });

  it('"amount above x USD" alone, from a common IP; exactly x is not above it', () => {
    expect(verificationNeed(tiers, USD('100.01'), known)).toMatchObject({ tier: 1, reasons: ['AMOUNT'] });
    expect(verificationNeed(tiers, USD('100'), known)).toBeNull();
  });

  it('new country: both codes, the questionnaire and the KYC check, no admin', () => {
    expect(verificationNeed(tiers, USD('50'), newCountry)).toMatchObject({
      tier: 2,
      require: 'BOTH',
      questionnaire: true,
      kyc: true,
      manual: false,
      reasons: ['NEW_COUNTRY'],
    });
  });

  it('VPN / proxy or a large amount: manual admin verification; a MANUAL questionnaire waits for the admin', () => {
    expect(verificationNeed(tiers, USD('50'), vpn)).toMatchObject({ tier: 3, manual: true, questionnaire: false, kyc: true, reasons: ['VPN_PROXY'] });
    expect(verificationNeed(tiers, USD('1001'), known)).toMatchObject({ tier: 3, reasons: ['AMOUNT'] });
  });

  it('the highest rule wins', () => {
    expect(verificationNeed(tiers, USD('501'), newIp)?.tier).toBe(2);
  });

  it('a switched-off rule is skipped, and without a USD value no amount rule applies', () => {
    const off = config((c) => (c.security.newIpSameCountry.enabled = false));
    expect(verificationNeed(off, USD('50'), newIp)).toBeNull();
    expect(verificationNeed(tiers, null, known)).toBeNull();
  });

  it('says when a USD value is needed', () => {
    expect(needsUsdValue(tiers)).toBe(true);
    expect(needsUsdValue(DEFAULT_RAIN_CONFIG)).toBe(false);
  });

  it('with the common-IP rule OFF, a common IP gets the new-IP checks', () => {
    const strict = config((c) => (c.security.commonIp.enabled = false));
    expect(verificationNeed(strict, USD('50'), known)).toMatchObject({ tier: 1, reasons: ['COMMON_IP_CHECK'] });
  });
});

describe('proofs', () => {
  it('require one: either code; require both: every asked code', () => {
    const one = { twoFa: true, email: true, require: 'ONE' as const };
    const both = { ...one, require: 'BOTH' as const };
    expect(codesSatisfied(one, { twoFa: false, email: true })).toBe(true);
    expect(codesSatisfied(one, { twoFa: false, email: false })).toBe(false);
    expect(codesSatisfied(both, { twoFa: true, email: false })).toBe(false);
    expect(codesSatisfied(both, { twoFa: true, email: true })).toBe(true);
    expect(codesSatisfied({ twoFa: false, email: false, require: 'BOTH' }, { twoFa: false, email: false })).toBe(true);
  });

  it('passes the questionnaire only on answers the admin marked OK', () => {
    expect(questionnairePassed([], undefined)).toBe(true);
    expect(questionnairePassed([QUESTION], [0])).toBe(true);
    expect(questionnairePassed([QUESTION], [1])).toBe(false);
    expect(questionnairePassed([QUESTION], [])).toBe(false);
  });

  it('refuses below the KYC level and counts a missing KYC module as level 0', () => {
    expect(kycShortfall(2, 2)).toBeNull();
    expect(kycShortfall(2, 1)).toMatch(/level 2/);
    expect(kycShortfall(1, null)).toMatch(/Yours is 0/);
  });
});
