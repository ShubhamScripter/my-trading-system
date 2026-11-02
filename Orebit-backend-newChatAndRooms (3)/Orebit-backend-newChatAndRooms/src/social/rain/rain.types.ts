import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../db/client';
import { type ManualSystemRain, type RainRevertFilter } from './rain.contract';
import type { RecipientRule } from './rain.math';

export type Db = Prisma.TransactionClient | PrismaService;

export type RainStatus =
  | 'PENDING_VERIFICATION'
  | 'PENDING_REVIEW'
  | 'COMPLETED'
  | 'PARTIALLY_REVERSED'
  | 'REVERSED'
  | 'REJECTED'
  | 'EXPIRED';

// Verification time window in seconds
export const VERIFY_TTL_SECONDS = 600;

export interface RainRunRow {
  id: string;
  kind: 'SYSTEM' | 'USER';
  status: RainStatus;
  roomId: string;
  initiatorId: string | null;
  currency: string;
  potMinor: bigint;
  feeMinor: bigint;
  distributableMinor: bigint;
  idempotencyKey: string;
  messageId: string | null;
  requestedRecipients?: number | null;
  recipientRule?: RecipientRule | null;
  repeatCount?: number | null;
  repeatGapSeconds?: number | null;
  usdPriceMinor?: bigint | null;
  usdValueMinor?: bigint | null;
  security?: RainSecurityRecord | null;
  rewards?: RainRewardsRecord | null;
  rewardsRevokedAt?: Date | null;
  verifyExpiresAt?: Date | null;
  createdAt?: Date;
}

export interface RainSecurityRecord {
  tier: 1 | 2 | 3;
  reasons: string[];
  twoFa: boolean;
  email: boolean;
  require: 'ONE' | 'BOTH';
  questions: { text: string; options: string[]; okOptions: number[] }[];
  kycLevel: number | null;
  manual: boolean;
  stage: 'INITIAL' | 'ADMIN_REQUEST';
  verifiedAt: string | null;
}

export interface NextRain {
  at: Date;
  currency: string | null;
  potMinor: bigint | null;
  potUsdMinor: bigint | null;
}

export interface RainSchedule {
  nextRainAt: Date | null;
  currency: string | null;
  potMinor: bigint | null;
  potUsdMinor: bigint | null;
  scheduledAt: Date | null;
}

export interface RainRewardsRecord {
  done: { exp: number; stars: number; awarded: boolean };
  received: { exp: number; stars: number; awarded: number; total: number };
  perRecipient?: Record<string, { exp: number; stars: number; awarded: boolean }>;
}

export interface RainJobRow {
  id: string;
  kind: 'MANUAL_SYSTEM' | 'REVERT' | 'APPROVE' | 'REJECT';
  rainId: string | null;
  actorId: string | null;
  reason: string | null;
  payerRefund: 'REFUND' | 'NONE';
  shortfall: 'ZERO' | 'NEGATIVE';
  filter: RainRevertFilter | null;
  manualSystem: ManualSystemRain | null;
}

export interface RainRepeatRow {
  id: string;
  initiatorId: string;
  roomId: string;
  currency: string;
  potMinor: bigint;
  recipientCount: number;
  recipientRule: RecipientRule | null;
  remaining: number;
  gapSeconds: number;
}

export interface RainShareRow {
  userId: string;
  amount: bigint;
  tier: 'NORMAL' | 'PREMIUM';
  reversedAt: Date | null;
}

export interface RainHistoryRow {
  id: string;
  kind: string;
  status: string;
  roomId: string;
  initiator: string | null;
  currency: string;
  potMinor: string;
  feeMinor: string;
  usdValueMinor: string | null;
  recipientCount: number;
  messageId: string | null;
  createdAt: string;
}

