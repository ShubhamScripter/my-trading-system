import { Prisma } from '@prisma/client';

export type RainJobKind = 'MANUAL_SYSTEM' | 'REVERT' | 'APPROVE' | 'REJECT';

export interface RainRunListRow {
  id: string;
  kind: 'SYSTEM' | 'USER';
  status: string;
  roomId: string;
  roomName: string | null;
  initiatorId: string | null;
  initiator: string | null;
  currency: string;
  potMinor: bigint;
  feeMinor: bigint;
  distributableMinor: bigint;
  usdValueMinor: bigint | null;
  recipientCount: number;
  requestedRecipients: number | null;
  recipientRule: unknown;
  repeatCount: number | null;
  repeatGapSeconds: number | null;
  security: Record<string, unknown> | null;
  rewards: unknown;
  reverseReason: string | null;
  reverseDetail: unknown;
  reversedAt: Date | null;
  verifyExpiresAt: Date | null;
  createdAt: Date;
}

export function big(value: bigint | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

export const RUN_COLUMNS = Prisma.sql`
  r.id, r.kind, r.status, r.room_id, m.name AS room_name, r.initiator_id, u.username AS initiator, r.currency,
  r.pot_minor, r.fee_minor, r.distributable_minor, r.usd_value_minor, r.recipient_count, r.requested_recipients,
  r.recipient_rule, r.repeat_count, r.repeat_gap_seconds, r.security, r.rewards, r.reverse_reason, r.reverse_detail,
  r.reversed_at, r.verify_expires_at, r.created_at
`;

export interface RunSql {
  id: string;
  kind: 'SYSTEM' | 'USER';
  status: string;
  room_id: string;
  room_name: string | null;
  initiator_id: string | null;
  initiator: string | null;
  currency: string;
  pot_minor: bigint;
  fee_minor: bigint;
  distributable_minor: bigint;
  usd_value_minor: bigint | null;
  recipient_count: number;
  requested_recipients: number | null;
  recipient_rule: unknown;
  repeat_count: number | null;
  repeat_gap_seconds: number | null;
  security: Record<string, unknown> | null;
  rewards: unknown;
  reverse_reason: string | null;
  reverse_detail: unknown;
  reversed_at: Date | null;
  verify_expires_at: Date | null;
  createdAt?: Date;
  created_at: Date;
}

export function toRun(row: RunSql): RainRunListRow {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    roomId: row.room_id,
    roomName: row.room_name,
    initiatorId: row.initiator_id,
    initiator: row.kind === 'USER' ? row.initiator : null,
    currency: row.currency,
    potMinor: BigInt(row.pot_minor),
    feeMinor: BigInt(row.fee_minor),
    distributableMinor: BigInt(row.distributable_minor),
    usdValueMinor: big(row.usd_value_minor),
    recipientCount: row.recipient_count,
    requestedRecipients: row.requested_recipients,
    recipientRule: row.recipient_rule,
    repeatCount: row.repeat_count,
    repeatGapSeconds: row.repeat_gap_seconds,
    security: row.security,
    rewards: row.rewards,
    reverseReason: row.reverse_reason,
    reverseDetail: row.reverse_detail,
    reversedAt: row.reversed_at,
    verifyExpiresAt: row.verify_expires_at,
    createdAt: row.created_at,
  };
}

