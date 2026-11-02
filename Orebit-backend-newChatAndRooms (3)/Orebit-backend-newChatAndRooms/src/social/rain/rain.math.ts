import type { RainRewardRule, RecipientMode } from './rain.contract';

/**
 * Rain amounts are integer minor units: 8 decimal places, never floats. USD values use the same scale.
 *
 * - `/rain BTC 100 10` is a total pot of 100 BTC split across 10 recipients, not 100 each.
 * - Shares follow the normal / Premium plan percentages, then are equal inside each group. An empty group's share
 *   is spread over the groups that have people, in proportion to their percentages.
 * - A user rain with fewer eligible people than asked for fails and moves no money.
 * - System rain recipients: "Specific Number / All Active users / x% of active users", then the threshold: above it
 *   a random subset is chosen. With nobody eligible the rain is skipped.
 * - The fee is a percentage of the crypto pot in the same currency. Fee rounding keeps the remainder in the
 *   distributable amount, so the fee is never rounded up.
 * - USD conversions use a USD price per whole unit of the currency (8 decimals).
 */

const SCALE = 8;
const UNIT = 10n ** BigInt(SCALE);

const AMOUNT = /^\d{1,10}(\.\d{1,8})?$/;

export function parseMinor(input: string): bigint | null {
  const text = input.trim();
  if (!AMOUNT.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const padded = `${frac}${'0'.repeat(SCALE)}`.slice(0, SCALE);
  return BigInt(whole!) * UNIT + BigInt(padded);
}

export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const value = negative ? -minor : minor;
  const whole = value / UNIT;
  const frac = (value % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const text = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${text}` : text;
}

/** "Fess on Rains done by users (%)" in basis points: 2.5% → 250. */
export function percentToBps(percent: number): number {
  const minor = parseMinor(String(percent));
  if (minor === null || minor % 1_000_000n !== 0n) throw new Error('fee percent must have at most two decimal places');
  const bps = Number(minor / 1_000_000n);
  if (bps < 0 || bps > 10_000) throw new Error('fee percent out of range');
  return bps;
}

/** Fee rounds down. The remainder stays distributable, so fee + distributable === pot. */
export function applyFee(pot: bigint, feeBps: number): { fee: bigint; distributable: bigint } {
  if (feeBps < 0 || feeBps > 10_000) throw new Error('fee bps out of range');
  const fee = (pot * BigInt(feeBps)) / 10_000n;
  return { fee, distributable: pot - fee };
}

// ─── USD ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The USD value of an amount, rounded down. `price` is the USD price of one whole unit, in minor units. */
export function minorToUsd(amount: bigint, price: bigint): bigint {
  return (amount * price) / UNIT;
}

/**
 * The crypto amount worth `usd`. `up` rounds a minimum up (never below the USD limit), otherwise it rounds down
 * (never above it). Null when the price is not above zero.
 */
export function usdToMinor(usd: bigint, price: bigint, round: 'up' | 'down'): bigint | null {
  if (price <= 0n) return null;
  const scaled = usd * UNIT;
  const amount = scaled / price;
  return round === 'up' && scaled % price !== 0n ? amount + 1n : amount;
}

/**
 * "EXP and Stars … Fixed / X for every y$ worth of rain". DYNAMIC gives `amount` for every `everyUsd`, at least 1
 * when `amount` is above 0. Without a USD value (no price) a DYNAMIC rule gives nothing.
 */
export function rainReward(rule: RainRewardRule, usd: bigint | null): number {
  if (rule.amount === 0) return 0;
  if (rule.mode === 'FIXED') return rule.amount;
  if (usd === null) return 0;
  const every = parseMinor(rule.everyUsd);
  if (every === null || every <= 0n) return rule.amount;
  const steps = Number(usd / every);
  return Math.max(1, steps * rule.amount);
}

// ─── Splitting ───────────────────────────────────────────────────────────────────────────────────────────────────

export function splitEqual(total: bigint, count: number): bigint[] {
  if (count < 1) return [];
  if (total < 0n) throw new Error('negative amount');
  const n = BigInt(count);
  const base = total / n;
  let remainder = total % n;
  const shares: bigint[] = [];
  for (let i = 0; i < count; i += 1) {
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    shares.push(base + extra);
  }
  return shares;
}

export interface RainPerson {
  readonly id: string;
  /** Active Premium plan ids; empty for a normal user. */
  readonly planIds: readonly string[];
}

export interface RainShare {
  readonly userId: string;
  readonly amount: bigint;
  readonly tier: 'PREMIUM' | 'NORMAL';
}

export interface RainAllocation {
  readonly normalPercent: number;
  readonly plans: readonly { readonly planId: string; readonly percent: number }[];
}

const NORMAL = 'NORMAL';

/**
 * The group a person's share comes from: the first listed plan they hold, else `*` when listed
 * and they hold any plan, else the normal group (a plan nobody listed earns no Premium share).
 */
export function groupOf(person: RainPerson, allocation: RainAllocation): string {
  if (person.planIds.length === 0) return NORMAL;
  const listed = allocation.plans.find((p) => p.planId !== '*' && person.planIds.includes(p.planId));
  if (listed) return listed.planId;
  if (allocation.plans.some((p) => p.planId === '*')) return '*';
  return NORMAL;
}

/**
 * Splits the pot between the groups by their percentages, then equally inside each group.
 * Only groups with people count, so the whole pot is always used; when every populated group
 * is at 0%, everyone shares equally. Rounding remainders go to the last populated group.
 */
export function distribute(total: bigint, people: readonly RainPerson[], allocation: RainAllocation): RainShare[] {
  const percentOf = new Map<string, number>([[NORMAL, allocation.normalPercent]]);
  for (const plan of allocation.plans) percentOf.set(plan.planId, plan.percent);
  const groups = new Map<string, RainPerson[]>();
  for (const person of people) {
    const key = groupOf(person, allocation);
    groups.set(key, [...(groups.get(key) ?? []), person]);
  }
  const populated = [...groups.entries()];
  if (populated.length === 0) return [];
  let weights = populated.map(([key]) => BigInt(percentOf.get(key) ?? 0));
  if (weights.every((w) => w === 0n)) weights = populated.map(() => 1n);
  const weightSum = weights.reduce((a, b) => a + b, 0n);

  const shares: RainShare[] = [];
  let left = total;
  populated.forEach(([key, members], index) => {
    const pool = index === populated.length - 1 ? left : (total * weights[index]!) / weightSum;
    left -= pool;
    splitEqual(pool, members.length).forEach((amount, i) => {
      if (amount > 0n) shares.push({ userId: members[i]!.id, amount, tier: key === NORMAL ? 'NORMAL' : 'PREMIUM' });
    });
  });
  return shares;
}

/**
 * System rain: how many of the `eligible` online users receive. SPECIFIC is "a specific number" (everyone when
 * fewer are online), ALL is every one, PERCENT is that share (at least 1). The threshold then caps it: "if online
 * users are above the threshold, random <threshold> will be selected".
 */
export function desiredRecipientCount(
  mode: RecipientMode,
  eligible: number,
  count: number,
  percent: number,
  threshold: number | null,
): number {
  if (eligible < 1) return 0;
  let wanted = eligible;
  if (mode === 'SPECIFIC') wanted = Math.min(eligible, count);
  if (mode === 'PERCENT') wanted = Math.min(eligible, Math.max(1, Math.ceil((eligible * percent) / 100)));
  return threshold === null ? wanted : Math.min(wanted, threshold);
}

/** What a user typed for "Number of users to Rain": `5`, `all` or `10%`. */
export type RecipientRule =
  | { readonly mode: 'SPECIFIC'; readonly count: number }
  | { readonly mode: 'ALL' }
  | { readonly mode: 'PERCENT'; readonly percent: number };

/**
 * User rain: how many of the `eligible` online users receive, within "Minimum / Maximum Amount of Users that can be
 * rained on in a single Rain". SPECIFIC must fit the limits and needs that many online; ALL and PERCENT take a random
 * `max` when more qualify. A string is the reason it cannot rain.
 */
export function userRecipientCount(
  rule: RecipientRule,
  eligible: number,
  limits: { min: number; max: number },
): number | string {
  if (rule.mode === 'SPECIFIC') {
    if (rule.count < limits.min || rule.count > limits.max) {
      return `Recipients must be between ${limits.min} and ${limits.max}`;
    }
    if (eligible < rule.count) return `Only ${eligible} eligible people are online here`;
    return rule.count;
  }
  const wanted =
    rule.mode === 'ALL' ? eligible : Math.ceil((eligible * rule.percent) / 100);
  const count = Math.min(wanted, limits.max);
  if (count < limits.min) {
    return `Only ${eligible} eligible people are online here, so ${rule.mode === 'ALL' ? 'all' : `${rule.percent}%`} is below the minimum of ${limits.min}`;
  }
  return count;
}

/** Inclusive. Slight modulo bias is acceptable for a rain amount, not for a key. */
export function randomMinor(min: bigint, max: bigint, randomByte: () => number): bigint {
  if (max < min) throw new Error('empty range');
  if (max === min) return min;
  const span = max - min + 1n;
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) + BigInt(randomByte());
  return min + (value % span);
}

// ─── Ledger legs ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface LedgerLeg {
  readonly userId: string;
  readonly delta: bigint;
  readonly key: string;
}

/**
 * "Revert Specific Rains", for the shares being taken back now (all of a rain, or only some recipients'):
 *  - payerRefund REFUND: what is taken back goes to the person who rained. The fee is never
 *    refunded ("does not include fee cut by us"). NONE ("do nothing"): it goes to the platform.
 *    A System Rain always goes back to the system account.
 *  - shortfall ZERO ("refund till 0"): a recipient who spent their share gives what they hold.
 *    NEGATIVE: the whole share is taken and their balance may go below zero.
 * `held` is each recipient's balance read under lock in the same transaction. Deltas sum to zero.
 * A share is taken back once (its debit key is per rain and recipient); `batchId` keys the credit of each reversal.
 */
export function reversalPlan(input: {
  rainId: string;
  batchId: string;
  kind: 'SYSTEM' | 'USER';
  payerId: string;
  platformAccountId: string;
  shares: readonly { userId: string; amount: bigint }[];
  held: ReadonlyMap<string, bigint>;
  payerRefund: 'REFUND' | 'NONE';
  shortfall: 'ZERO' | 'NEGATIVE';
}): { legs: LedgerLeg[]; reclaimed: bigint; missing: bigint; creditedTo: string } {
  if (input.kind === 'USER' && input.payerRefund === 'NONE') {
    return {
      legs: [],
      reclaimed: 0n,
      missing: input.shares.reduce((sum, share) => sum + share.amount, 0n),
      creditedTo: 'none',
    };
  }
  const creditedTo =
    input.kind === 'SYSTEM' || input.payerRefund === 'REFUND' ? input.payerId : input.platformAccountId;
  const debits: LedgerLeg[] = [];
  let reclaimed = 0n;
  let missing = 0n;
  for (const share of input.shares) {
    const holds = input.held.get(share.userId) ?? 0n;
    const take =
      input.shortfall === 'NEGATIVE' ? share.amount : share.amount < holds ? share.amount : holds > 0n ? holds : 0n;
    missing += share.amount - take;
    if (take === 0n) continue;
    reclaimed += take;
    debits.push({ userId: share.userId, delta: -take, key: `revert:${input.rainId}:debit:${share.userId}` });
  }
  const legs =
    reclaimed > 0n
      ? [
          { userId: creditedTo, delta: reclaimed, key: `revert:${input.rainId}:${input.batchId}:credit:${creditedTo}` },
          ...debits,
        ]
      : [];
  const sum = legs.reduce((total, leg) => total + leg.delta, 0n);
  if (sum !== 0n) throw new Error('reversal legs do not balance');
  return { legs, reclaimed, missing, creditedTo };
}
