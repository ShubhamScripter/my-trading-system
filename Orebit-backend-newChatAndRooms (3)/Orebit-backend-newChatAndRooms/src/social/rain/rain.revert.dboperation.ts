import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../db/client';
import type { RainRevertFilter } from './rain.contract';
import type { Db, RainRewardsRecord, RainRunRow } from './rain.types';

const RUN_COLUMNS_R = Prisma.sql`
  r.id, r.kind, r.status, r.room_id, r.initiator_id, r.currency, r.pot_minor, r.fee_minor,
  r.distributable_minor, r.idempotency_key, r.message_id, r.requested_recipients, r.recipient_rule, r.repeat_count,
  r.repeat_gap_seconds, r.usd_price_minor, r.usd_value_minor, r.security, r.rewards, r.rewards_revoked_at,
  r.verify_expires_at, r.created_at
`;

interface RawRunSqlRow {
  id: string;
  kind: 'SYSTEM' | 'USER';
  status: RainRunRow['status'];
  room_id: string;
  initiator_id: string | null;
  currency: string;
  pot_minor: string | bigint | number;
  fee_minor: string | bigint | number;
  distributable_minor: string | bigint | number;
  idempotency_key: string;
  message_id: string | null;
  requested_recipients: number | null;
  recipient_rule: RainRunRow['recipientRule'];
  repeat_count: number | null;
  repeat_gap_seconds: number | null;
  usd_price_minor: string | bigint | number | null;
  usd_value_minor: string | bigint | number | null;
  security: RainRunRow['security'];
  rewards: RainRewardsRecord | null;
  rewards_revoked_at: Date | null;
  verify_expires_at: Date | null;
  created_at: Date;
}

@Injectable()
export class RainRevertDbOperation {
  constructor(private readonly prisma: PrismaService) { }

  // Takes recipient shares during a revert operation
  async takeShares(
    tx: Db,
    rainId: string,
    userIds: readonly string[] | null,
  ): Promise<{ userId: string; amount: bigint; previouslyReversed: boolean }[]> {
    const selectedUsers = userIds === null ? Prisma.empty : Prisma.sql`AND user_id = ANY(${[...userIds]}::uuid[])`;
    const rows = await tx.$queryRaw<{ user_id: string; amount_minor: bigint; reversed_at: Date | null }[]>`
      SELECT user_id, amount_minor, reversed_at FROM rain.recipients
      WHERE rain_id = ${rainId}::uuid AND reversed_at IS NULL ${selectedUsers}
      FOR UPDATE
    `;
    return rows.map((row) => ({
      userId: row.user_id,
      amount: BigInt(row.amount_minor),
      previouslyReversed: row.reversed_at !== null,
    }));
  }

  async setReclaimed(tx: Db, rainId: string, reclaimed: ReadonlyMap<string, bigint>, jobId: string): Promise<void> {
    for (const [userId, amount] of reclaimed) {
      await tx.$executeRaw`
        UPDATE rain.recipients
        SET reclaimed_minor = ${amount.toString()}::bigint, reversed_at = now(), reversed_job_id = ${jobId}::uuid
        WHERE rain_id = ${rainId}::uuid AND user_id = ${userId}::uuid AND reversed_at IS NULL
      `;
    }
  }

  async openShareCount(tx: Db, rainId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM rain.recipients WHERE rain_id = ${rainId}::uuid AND reversed_at IS NULL
    `;
    return Number(rows[0]?.count ?? 0n);
  }

  async markReverted(
    tx: Db,
    id: string,
    status: 'PARTIALLY_REVERSED' | 'REVERSED',
    reason: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE rain.runs
      SET status = ${status},
          reversed_at = now(),
          reverse_reason = ${reason},
          reverse_detail = ${JSON.stringify(detail)}::jsonb,
          rewards_revoked_at = CASE
            WHEN ${status} = 'REVERSED' THEN coalesce(rewards_revoked_at, now())
            ELSE rewards_revoked_at
          END
      WHERE id = ${id}::uuid
    `;
  }

  // One page of rains a revert filter covers, oldest first after afterId
  async rainsMatching(filter: RainRevertFilter, afterId: string | null, limit: number): Promise<RainRunRow[]> {
    const kind =
      filter.kind === 'ALL' ? Prisma.empty : Prisma.sql`AND r.kind = ${filter.kind}`;
    const from = filter.from ? Prisma.sql`AND r.created_at >= ${filter.from}::timestamptz` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND r.created_at <= ${filter.to}::timestamptz` : Prisma.empty;
    const coins =
      filter.currencies.length > 0 ? Prisma.sql`AND r.currency = ANY(${filter.currencies}::text[])` : Prisma.empty;
    const after = afterId ? Prisma.sql`AND r.id > ${afterId}::uuid` : Prisma.empty;
    let who = Prisma.empty;
    if (filter.who && filter.who.userIds.length > 0 && filter.who.group === null) {
      who =
        filter.who.role === 'RAINER'
          ? Prisma.sql`AND r.kind = 'USER' AND r.initiator_id = ANY(${filter.who.userIds}::uuid[])`
          : Prisma.sql`AND EXISTS (
              SELECT 1 FROM rain.recipients p
              WHERE p.rain_id = r.id AND p.reversed_at IS NULL AND p.user_id = ANY(${filter.who.userIds}::uuid[])
            )`;
    } else if (filter.who?.role === 'RAINER') {
      who = Prisma.sql`AND r.kind = 'USER'`;
    }
    const rows = await this.prisma.$queryRaw<RawRunSqlRow[]>`
      SELECT ${RUN_COLUMNS_R} FROM rain.runs r
      WHERE r.status IN ('COMPLETED', 'PARTIALLY_REVERSED') ${kind} ${from} ${to} ${coins} ${who} ${after}
      ORDER BY r.id
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      roomId: row.room_id,
      initiatorId: row.initiator_id,
      currency: row.currency,
      potMinor: BigInt(row.pot_minor),
      feeMinor: BigInt(row.fee_minor),
      distributableMinor: BigInt(row.distributable_minor),
      idempotencyKey: row.idempotency_key,
      messageId: row.message_id,
      requestedRecipients: row.requested_recipients,
      recipientRule: row.recipient_rule,
      repeatCount: row.repeat_count,
      repeatGapSeconds: row.repeat_gap_seconds,
      usdPriceMinor: row.usd_price_minor ? BigInt(row.usd_price_minor) : null,
      usdValueMinor: row.usd_value_minor ? BigInt(row.usd_value_minor) : null,
      security: row.security,
      rewards: row.rewards && 'done' in row.rewards ? row.rewards : null,
      rewardsRevokedAt: row.rewards_revoked_at,
      verifyExpiresAt: row.verify_expires_at,
      createdAt: row.created_at,
    }));
  }
}

