import { describe, expect, it } from 'vitest';
import { DEFAULT_RAIN_CONFIG, RainConfigSchema, effectiveStatus } from '../src/social/rain/rain.contract';
import {
  applyFee,
  desiredRecipientCount,
  distribute,
  formatMinor,
  groupOf,
  minorToUsd,
  parseMinor,
  percentToBps,
  rainReward,
  reversalPlan,
  splitEqual,
  usdToMinor,
  userRecipientCount,
} from '../src/social/rain/rain.math';
import { parseCommand } from '../src/social/chat/services/chat.commands.parser';

const sum = (values: readonly bigint[]) => values.reduce((a, b) => a + b, 0n);
const units = (text: string) => parseMinor(text)!;

describe('rain amounts', () => {
  it('splits a pot equally after the fee: /rain BTC 100 10 is 100 in total, not 100 each', () => {
    const pot = units('100');
    const priced = applyFee(pot, percentToBps(2));
    expect(priced.fee).toBe(units('2'));
    expect(priced.distributable).toBe(units('98'));
    const shares = splitEqual(priced.distributable, 10);
    expect(shares).toHaveLength(10);
    expect(shares.every((share) => share === units('9.8'))).toBe(true);
    expect(sum(shares)).toBe(priced.distributable);
  });

  it('keeps the fee remainder in the distributable amount', () => {
    const priced = applyFee(10n, 3333);
    expect(priced.fee + priced.distributable).toBe(10n);
    expect(priced.fee).toBe(3n);
    expect(percentToBps(2.5)).toBe(250);
    expect(percentToBps(0.01)).toBe(1);
    expect(percentToBps(2.55)).toBe(255);
  });

  it('formats and parses minor units', () => {
    expect(parseMinor('1.123456789')).toBeNull();
    expect(formatMinor(100_000_000n)).toBe('1');
    expect(formatMinor(1n)).toBe('0.00000001');
  });

  it('accepts the default config, which rains nothing', () => {
    const config = RainConfigSchema.parse(DEFAULT_RAIN_CONFIG);
    expect(effectiveStatus(config, 'system')).toBe('OFF');
    expect(effectiveStatus(config, 'user')).toBe('OFF');
  });
});

describe('USD conversion', () => {
  const btc = units('60000');

  it('turns a USD amount into the currency and back', () => {
    expect(usdToMinor(units('600'), btc, 'down')).toBe(units('0.01'));
    expect(minorToUsd(units('0.01'), btc)).toBe(units('600'));
  });

  it('rounds a minimum up and a maximum down, so neither crosses the USD limit', () => {
    const price = units('3');
    expect(usdToMinor(units('1'), price, 'down')).toBe(33_333_333n);
    expect(usdToMinor(units('1'), price, 'up')).toBe(33_333_334n);
    expect(usdToMinor(units('1'), 0n, 'up')).toBeNull();
  });
});

describe('EXP and Stars: Fixed / X for every y$', () => {
  it('gives a fixed reward every time', () => {
    expect(rainReward({ mode: 'FIXED', amount: 5, everyUsd: '1' }, null)).toBe(5);
    expect(rainReward({ mode: 'FIXED', amount: 0, everyUsd: '1' }, units('100'))).toBe(0);
  });

  it('gives X for every y$, at least 1, and nothing without a USD value', () => {
    const rule = { mode: 'DYNAMIC' as const, amount: 2, everyUsd: '10' };
    expect(rainReward(rule, units('35'))).toBe(6);
    expect(rainReward(rule, units('3'))).toBe(1);
    expect(rainReward(rule, null)).toBe(0);
  });
});

describe('Rainpool recipients: Specific Number / All Active users / x% and the threshold', () => {
  it('rains on a specific number, everyone when fewer are online', () => {
    expect(desiredRecipientCount('SPECIFIC', 5000, 1000, 100, null)).toBe(1000);
    expect(desiredRecipientCount('SPECIFIC', 12, 1000, 100, null)).toBe(12);
    expect(desiredRecipientCount('SPECIFIC', 0, 1000, 100, null)).toBe(0);
  });

  it('rains on all or x% of active users', () => {
    expect(desiredRecipientCount('ALL', 7, 1, 1, null)).toBe(7);
    expect(desiredRecipientCount('PERCENT', 10, 1, 25, null)).toBe(3);
  });

  it('picks a random <threshold> when more are online', () => {
    expect(desiredRecipientCount('ALL', 5000, 1, 1, 1000)).toBe(1000);
    expect(desiredRecipientCount('PERCENT', 5000, 1, 50, 1000)).toBe(1000);
    expect(desiredRecipientCount('ALL', 300, 1, 1, 1000)).toBe(300);
  });
});

describe('user rain recipients', () => {
  const limits = { min: 2, max: 20 };

  it('takes a specific number inside the limits when that many are online', () => {
    expect(userRecipientCount({ mode: 'SPECIFIC', count: 5 }, 10, limits)).toBe(5);
    expect(userRecipientCount({ mode: 'SPECIFIC', count: 25 }, 30, limits)).toMatch(/between 2 and 20/);
    expect(userRecipientCount({ mode: 'SPECIFIC', count: 5 }, 3, limits)).toMatch(/Only 3/);
  });

  it('caps "all" and "x%" at the maximum and refuses below the minimum', () => {
    expect(userRecipientCount({ mode: 'ALL' }, 50, limits)).toBe(20);
    expect(userRecipientCount({ mode: 'ALL' }, 7, limits)).toBe(7);
    expect(userRecipientCount({ mode: 'PERCENT', percent: 10 }, 50, limits)).toBe(5);
    expect(typeof userRecipientCount({ mode: 'PERCENT', percent: 10 }, 5, limits)).toBe('string');
    expect(typeof userRecipientCount({ mode: 'ALL' }, 1, limits)).toBe('string');
  });
});

describe('/rain command', () => {
  it('reads a number, "all" and "x%" as the users to rain on', () => {
    expect(parseCommand('/rain btc 0.01 5')).toMatchObject({
      kind: 'rain',
      currency: 'BTC',
      pot: '0.01',
      recipients: { mode: 'SPECIFIC', count: 5 },
    });
    expect(parseCommand('/rain ETH 1 all')).toMatchObject({ recipients: { mode: 'ALL' } });
    expect(parseCommand('/rain ETH 1 10%')).toMatchObject({ recipients: { mode: 'PERCENT', percent: 10 } });
    expect(parseCommand('/rain ETH 1 0')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/rain ETH 1 101%')).toMatchObject({ kind: 'invalid' });
  });

  it('reads the auto-repeat gap in seconds, minutes or hours', () => {
    expect(parseCommand('/rain BTC 0.01 5 repeat 3 60')).toMatchObject({ repeatCount: 3, repeatGapSeconds: 60 });
    expect(parseCommand('/rain BTC 0.01 5 repeat 3 5m')).toMatchObject({ repeatGapSeconds: 300 });
    expect(parseCommand('/rain BTC 0.01 5 repeat 3 1h')).toMatchObject({ repeatGapSeconds: 3600 });
    expect(parseCommand('/rain BTC 0.01 5 repeat 3 1d')).toMatchObject({ kind: 'invalid' });
  });
});

describe('plan-wise allocation', () => {
  const allocation = { normalPercent: 40, plans: [{ planId: 'gold', percent: 40 }, { planId: '*', percent: 20 }] };

  it('puts each person in the group of their first listed plan, else any-plan, else normal', () => {
    expect(groupOf({ id: 'a', planIds: [] }, allocation)).toBe('NORMAL');
    expect(groupOf({ id: 'b', planIds: ['gold'] }, allocation)).toBe('gold');
    expect(groupOf({ id: 'c', planIds: ['silver'] }, allocation)).toBe('*');
    expect(groupOf({ id: 'd', planIds: ['silver'] }, { normalPercent: 100, plans: [] })).toBe('NORMAL');
  });

  it('splits by percentages, equally inside a group, and uses the whole pot', () => {
    const people = [
      { id: 'n1', planIds: [] },
      { id: 'n2', planIds: [] },
      { id: 'g1', planIds: ['gold'] },
      { id: 's1', planIds: ['silver'] },
    ];
    const shares = distribute(1000n, people, allocation);
    const of = (id: string) => shares.find((s) => s.userId === id)!.amount;
    expect(of('n1')).toBe(200n);
    expect(of('n2')).toBe(200n);
    expect(of('g1')).toBe(400n);
    expect(of('s1')).toBe(200n);
    expect(shares.find((s) => s.userId === 'g1')!.tier).toBe('PREMIUM');
    expect(sum(shares.map((s) => s.amount))).toBe(1000n);
  });

  it("spreads an empty group's share over the groups that have people", () => {
    const shares = distribute(1000n, [{ id: 'n1', planIds: [] }, { id: 'g1', planIds: ['gold'] }], allocation);
    // normal 40 : gold 40 → half each; nobody on another plan.
    expect(shares.map((s) => s.amount)).toEqual([500n, 500n]);
  });

  it('shares equally when every populated group is at 0%', () => {
    const shares = distribute(10n, [{ id: 'a', planIds: [] }, { id: 'b', planIds: [] }], { normalPercent: 0, plans: [{ planId: '*', percent: 100 }] });
    expect(sum(shares.map((s) => s.amount))).toBe(10n);
    expect(shares).toHaveLength(2);
  });
});

describe('reversal policies', () => {
  const base = {
    rainId: 'r',
    batchId: 'job1',
    kind: 'USER' as const,
    payerId: 'payer',
    platformAccountId: 'platform',
    shares: [
      { userId: 'a', amount: 30n },
      { userId: 'b', amount: 30n },
    ],
  };

  it('refunds the person who rained, never the fee, when everyone still holds their share', () => {
    const plan = reversalPlan({ ...base, held: new Map([['a', 50n], ['b', 30n]]), payerRefund: 'REFUND', shortfall: 'ZERO' });
    expect(plan.reclaimed).toBe(60n);
    expect(plan.missing).toBe(0n);
    expect(plan.creditedTo).toBe('payer');
    expect(sum(plan.legs.map((l) => l.delta))).toBe(0n);
  });

  it('"do nothing" moves no money and records the uncollected value', () => {
    const plan = reversalPlan({ ...base, held: new Map([['a', 30n], ['b', 30n]]), payerRefund: 'NONE', shortfall: 'ZERO' });
    expect(plan.creditedTo).toBe('none');
    expect(plan.legs).toEqual([]);
    expect(plan.reclaimed).toBe(0n);
    expect(plan.missing).toBe(60n);
  });

  it('"refund till 0" takes only what a recipient still holds', () => {
    const plan = reversalPlan({ ...base, held: new Map([['a', 10n]]), payerRefund: 'REFUND', shortfall: 'ZERO' });
    expect(plan.reclaimed).toBe(10n);
    expect(plan.missing).toBe(50n);
    expect(plan.legs.find((l) => l.userId === 'a')!.delta).toBe(-10n);
    expect(plan.legs.some((l) => l.userId === 'b')).toBe(false);
    expect(sum(plan.legs.map((l) => l.delta))).toBe(0n);
  });

  it('"negative balance" takes every share in full', () => {
    const plan = reversalPlan({ ...base, held: new Map(), payerRefund: 'REFUND', shortfall: 'NEGATIVE' });
    expect(plan.reclaimed).toBe(60n);
    expect(plan.missing).toBe(0n);
  });

  it('returns a System Rain to the system account whatever the payer policy', () => {
    const plan = reversalPlan({ ...base, kind: 'SYSTEM', payerId: 'system', held: new Map([['a', 30n], ['b', 30n]]), payerRefund: 'NONE', shortfall: 'ZERO' });
    expect(plan.creditedTo).toBe('system');
  });

  it('keys a reversal differently from the payment, so both can exist and neither twice', () => {
    // RainPayoutService.legsOf uses these keys for a completed payment.
    const paid = ['r:debit', 'r:a', 'r:b'];
    const back = reversalPlan({ ...base, held: new Map(), payerRefund: 'REFUND', shortfall: 'NEGATIVE' }).legs.map((l) => l.key);
    expect(paid.some((key) => back.includes(key))).toBe(false);
    expect(new Set(back).size).toBe(back.length);
  });

  it('lets two partial reverts of one rain credit the payer separately, and never take a share twice', () => {
    const first = reversalPlan({ ...base, shares: [base.shares[0]!], held: new Map(), payerRefund: 'REFUND', shortfall: 'NEGATIVE' });
    const second = reversalPlan({ ...base, batchId: 'job2', shares: [base.shares[1]!], held: new Map(), payerRefund: 'REFUND', shortfall: 'NEGATIVE' });
    const keys = [...first.legs, ...second.legs].map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    const again = reversalPlan({ ...base, batchId: 'job3', shares: [base.shares[0]!], held: new Map(), payerRefund: 'REFUND', shortfall: 'NEGATIVE' });
    // The same recipient's debit key repeats, so the ledger refuses a second take-back of one share.
    expect(again.legs.find((l) => l.userId === 'a')!.key).toBe(first.legs.find((l) => l.userId === 'a')!.key);
  });
});
