/**
 * Chat SETTINGS "Universal Currency and EXP [Set separately] (could be 0)": what an advert or a gift earns. Pure.
 *
 *  - FIXED: `amount` every time.
 *  - DYNAMIC (min 1): `amount` for every `everyUsd` spent, rounded down, and at least 1 when `amount` is above 0.
 */
import { Prisma } from '@prisma/client';
import type { RewardRule } from '../chat.features.contract';

export interface Reward {
  readonly exp: number;
  readonly currency: number;
}

export function rewardFor(rule: RewardRule, usd: string): number {
  if (rule.amount === 0) return 0;
  if (rule.mode === 'FIXED') return rule.amount;
  const every = new Prisma.Decimal(rule.everyUsd);
  if (every.lte(0)) return 0;
  const steps = new Prisma.Decimal(usd).div(every).floor().toNumber();
  return steps * rule.amount;
}

export function rewardsFor(pair: { exp: RewardRule; currency: RewardRule }, usd: string): Reward {
  return {
    exp: rewardFor(pair.exp, usd),
    currency: 0,
  };
}

/** What a row stores: the reward and whether the rewards module confirmed it. */
export interface StoredReward extends Reward {
  readonly awarded: boolean;
}
