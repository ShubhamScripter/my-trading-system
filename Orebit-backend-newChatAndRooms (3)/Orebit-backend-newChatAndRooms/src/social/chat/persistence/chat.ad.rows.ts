/**
 * Row types and mappers for chat ads (Module 5). Extracted from chat.ad.dboperation.ts to keep every file under 500
 * lines (Rule C.2).
 */
import { Prisma } from '@prisma/client';
import { usdStored } from '../platform/money';
import { TIME_TEXT } from './chat.sql';

/** PENDING_PAYMENT: saved, the charge is not settled yet. FAILED: the charge was refused or never came. */
export type AdStatus =
  | 'PENDING_PAYMENT'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'FAILED';

export interface AdRecord {
  readonly id: string;
  readonly creatorId: string | null;
  readonly creatorAdminId: string | null;
  readonly content: string;
  readonly roomIds: readonly string[];
  readonly allRooms: boolean;
  readonly pinMinutes: number | null;
  readonly repeatCount: number;
  readonly repeatGapMin: number | null;
  readonly postedCount: number;
  readonly nextPostAt: Date | null;
  readonly hiddenCountries: readonly string[];
  readonly badgeId: string | null;
  readonly skinId: string | null;
  readonly rewards: { exp?: number; currency?: number; awarded?: boolean };
  readonly revertRewards: boolean;
  readonly rewardsRevokedAt: Date | null;
  readonly priceUsd: string;
  readonly breakdown: unknown;
  readonly chargeReference: string | null;
  readonly status: AdStatus;
  readonly createdAt: Date;
  readonly createdAtText: string;
  readonly endedAt: Date | null;
  readonly refundUsd: string | null;
  readonly refundedAt: Date | null;
  readonly idempotencyKey: string | null;
  readonly requestFingerprint: string | null;
  readonly failureReason: string | null;
  readonly refundCurrency: string | null;
  readonly kind?: string;
  readonly is18Plus?: boolean;
  readonly planId?: string | null;
  readonly discountUsd?: string | null;
}

export interface AdSqlRow {
  id: string;
  creator_id: string | null;
  creator_admin_id: string | null;
  content: string;
  room_ids: string[];
  all_rooms: boolean;
  pin_minutes: number | null;
  repeat_count: number;
  repeat_gap_min: number | null;
  posted_count: number;
  next_post_at: Date | null;
  hidden_countries: string[];
  badge_id: string | null;
  skin_id: string | null;
  rewards: { exp?: number; currency?: number; awarded?: boolean } | null;
  revert_rewards: boolean;
  rewards_revoked_at: Date | null;
  price_usd: Prisma.Decimal;
  breakdown: unknown;
  charge_reference: string | null;
  status: AdStatus;
  created_at: Date;
  created_at_text: string;
  ended_at: Date | null;
  refund_usd: Prisma.Decimal | null;
  refunded_at: Date | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  failure_reason: string | null;
  refund_currency: string | null;
  kind?: string;
  is_18_plus?: boolean;
  plan_id?: string | null;
  discount_usd?: Prisma.Decimal | null;
}

export const AD_SELECT = Prisma.sql`
  SELECT id, creator_id, creator_admin_id, content, room_ids, all_rooms, pin_minutes, repeat_count, repeat_gap_min,
         posted_count, next_post_at, hidden_countries, badge_id, skin_id, rewards, revert_rewards, rewards_revoked_at,
         price_usd, breakdown, charge_reference, status,
         created_at, ${TIME_TEXT('created_at')} AS created_at_text, ended_at, refund_usd, refunded_at,
         idempotency_key, request_fingerprint, failure_reason, refund_currency,
         kind, is_18_plus, plan_id, discount_usd
  FROM chat.chat_ads
`;

export const toAd = (row: AdSqlRow): AdRecord => ({
  id: row.id,
  creatorId: row.creator_id,
  creatorAdminId: row.creator_admin_id,
  content: row.content,
  roomIds: row.room_ids ?? [],
  allRooms: row.all_rooms,
  pinMinutes: row.pin_minutes,
  repeatCount: row.repeat_count,
  repeatGapMin: row.repeat_gap_min,
  postedCount: row.posted_count,
  nextPostAt: row.next_post_at,
  hiddenCountries: row.hidden_countries ?? [],
  badgeId: row.badge_id,
  skinId: row.skin_id,
  rewards: row.rewards ?? {},
  revertRewards: row.revert_rewards,
  rewardsRevokedAt: row.rewards_revoked_at,
  priceUsd: usdStored(row.price_usd),
  breakdown: row.breakdown,
  chargeReference: row.charge_reference,
  status: row.status,
  createdAt: row.created_at,
  createdAtText: row.created_at_text,
  endedAt: row.ended_at,
  refundUsd: row.refund_usd === null ? null : usdStored(row.refund_usd),
  refundedAt: row.refunded_at,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  failureReason: row.failure_reason,
  refundCurrency: row.refund_currency,
  kind: row.kind,
  is18Plus: row.is_18_plus,
  planId: row.plan_id,
  discountUsd: row.discount_usd ? usdStored(row.discount_usd) : null,
});

