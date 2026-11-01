/**
 * Chat SETTINGS "MODERATION Actions: Revert ALL Transfers / Advertisements … [Can be done for specific users / group of
 * users]": the reverts an admin queued for a group (Premium, KYC or Level). Only the chat server knows who is in a
 * group, so it picks the gifts and ads here; reverting them then follows the usual paths (gift reverts, ad refunds).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { claimBatch } from '../platform/jobs';
import { TIME_TEXT } from './chat.sql';

export interface MoneyRevertFilter {
  from: string;
  to: string;
  userIds: string[];
  minUsd: string | null;
  maxUsd: string | null;
  group: { targetType: 'PREMIUM' | 'KYC' | 'LEVEL'; value: string };
  note: string | null;
  /** Gifts. */
  currencies?: string[];
  refundFees?: boolean;
  /** Ads. */
  adIds?: string[];
  pinnedOnly?: boolean;
}

/** Where a long job stopped: the keyset after the last row done, and what it has counted so far. */
export interface MoneyRevertProgress {
  after: { createdAt: string; id: string } | null;
  totals: Record<string, number>;
}

export interface MoneyRevertJob {
  id: string;
  kind: 'GIFTS' | 'ADS';
  filter: MoneyRevertFilter;
  createdBy: string;
  progress: MoneyRevertProgress | null;
}

/** One candidate row with the text of its time, so the keyset keeps every microsecond. */
export interface RevertCursorRow {
  createdAt: string;
  id: string;
}

@Injectable()
export class ChatMoneyRevertDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The next job to work on, claimed so two workers never run the same one. A RUNNING job whose claim is older than
   * `staleSeconds` was left by a crashed worker and is taken over, carrying on from its saved progress.
   */
  async claim(staleSeconds: number): Promise<MoneyRevertJob | null> {
    const ids = await claimBatch(this.prisma, {
      table: 'money_revert_jobs',
      due: Prisma.sql`status IN ('PENDING', 'RUNNING')`,
      orderBy: 'created_at',
      limit: 1,
      staleSeconds,
    });
    if (ids.length === 0) return null;
    const rows = await this.prisma.$queryRaw<
      { id: string; kind: 'GIFTS' | 'ADS'; filter: MoneyRevertFilter; created_by: string; progress: MoneyRevertProgress | null }[]
    >`
      UPDATE chat.money_revert_jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now())
      WHERE id = ${ids[0]}::uuid
      RETURNING id, kind, filter, created_by, progress
    `;
    const row = rows[0];
    return row ? { id: row.id, kind: row.kind, filter: row.filter, createdBy: row.created_by, progress: row.progress } : null;
  }

  /** The job ran out of time: where it stopped is kept and its claim given back, so the next pass carries on. */
  async saveProgress(id: string, progress: MoneyRevertProgress): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.money_revert_jobs SET progress = ${JSON.stringify(progress)}::jsonb, claimed_at = NULL
      WHERE id = ${id}::uuid
    `;
  }

  async finish(id: string, status: 'DONE' | 'FAILED', result: Record<string, unknown> | null, error: string | null) {
    await this.prisma.$executeRaw`
      UPDATE chat.money_revert_jobs
      SET status = ${status}, result = ${result ? JSON.stringify(result) : null}::jsonb, error = ${error},
          finished_at = now(), claimed_at = NULL
      WHERE id = ${id}::uuid
    `;
  }

  /** Completed gifts in the filter, with both people (the group is checked on either side, like the users). */
  async giftCandidates(
    f: MoneyRevertFilter,
    after: RevertCursorRow | null,
    limit: number,
  ): Promise<(RevertCursorRow & { senderId: string; recipientId: string })[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; sender_id: string; recipient_id: string; created_at_text: string }[]>`
      SELECT g.id, g.sender_id, g.recipient_id, ${TIME_TEXT('g.created_at')} AS created_at_text FROM chat.gift_transfers g
      WHERE g.status = 'COMPLETED' AND g.created_at >= ${f.from}::timestamptz AND g.created_at < ${f.to}::timestamptz
        ${after ? Prisma.sql`AND (g.created_at, g.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
        ${f.userIds.length ? Prisma.sql`AND (g.sender_id = ANY(${f.userIds}::uuid[]) OR g.recipient_id = ANY(${f.userIds}::uuid[]))` : Prisma.empty}
        ${f.currencies?.length ? Prisma.sql`AND g.currency = ANY(${f.currencies}::text[])` : Prisma.empty}
        ${f.minUsd !== null ? Prisma.sql`AND g.usd_value >= ${f.minUsd}::numeric` : Prisma.empty}
        ${f.maxUsd !== null ? Prisma.sql`AND g.usd_value <= ${f.maxUsd}::numeric` : Prisma.empty}
      ORDER BY g.created_at, g.id
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at_text, senderId: row.sender_id, recipientId: row.recipient_id }));
  }

  /** Marks gifts REVERT_PENDING; the chat server's gift revert step moves each back. */
  async markGifts(ids: readonly string[], refundFees: boolean, adminId: string): Promise<number> {
    if (ids.length === 0) return 0;
    return this.prisma.$executeRaw`
      UPDATE chat.gift_transfers
      SET status = 'REVERT_PENDING', revert_refund_fees = ${refundFees},
          revert_requested_by = ${adminId}::uuid, revert_requested_at = now()
      WHERE id = ANY(${[...ids]}::uuid[]) AND status = 'COMPLETED'
    `;
  }

  async adCandidates(
    f: MoneyRevertFilter,
    after: RevertCursorRow | null,
    limit: number,
  ): Promise<(RevertCursorRow & { creatorId: string | null; status: string })[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; creator_id: string | null; status: string; created_at_text: string }[]>`
      SELECT a.id, a.creator_id, a.status, ${TIME_TEXT('a.created_at')} AS created_at_text FROM chat.chat_ads a
      WHERE a.created_at >= ${f.from}::timestamptz AND a.created_at < ${f.to}::timestamptz
        ${after ? Prisma.sql`AND (a.created_at, a.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
        ${f.userIds.length ? Prisma.sql`AND a.creator_id = ANY(${f.userIds}::uuid[])` : Prisma.empty}
        ${f.adIds?.length ? Prisma.sql`AND a.id = ANY(${f.adIds}::uuid[])` : Prisma.empty}
        ${f.minUsd !== null ? Prisma.sql`AND a.price_usd >= ${f.minUsd}::numeric` : Prisma.empty}
        ${f.maxUsd !== null ? Prisma.sql`AND a.price_usd <= ${f.maxUsd}::numeric` : Prisma.empty}
        ${f.pinnedOnly ? Prisma.sql`AND a.pin_minutes IS NOT NULL` : Prisma.empty}
        AND a.status IN ('ACTIVE', 'PAUSED', 'COMPLETED')
      ORDER BY a.created_at, a.id
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at_text, creatorId: row.creator_id, status: row.status }));
  }

  /** "Reverting will also revert EXP and Stars Earned". */
  async markAdRewardsRevert(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.prisma.$executeRaw`
      UPDATE chat.chat_ads SET revert_rewards = true
      WHERE id = ANY(${[...ids]}::uuid[]) AND creator_id IS NOT NULL AND NOT revert_rewards
    `;
  }
}
