/** Database operations for admin ad management, gift history, and bulk transaction reverts. */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { ChatUtility } from '../chat.utility';

const iso = (value: Date | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

/** At most this many ads or gifts per revert call; the admin runs it again for the rest. */
export const REVERT_MAX = 5000;

/** "for a Specific Time Frame", "for specific users", "for a specific amount range" (USD). */
export interface RevertFilter {
  readonly from: string;
  readonly to: string;
  readonly userIds: string[];
  readonly minUsd: string | null;
  readonly maxUsd: string | null;
}

@Injectable()
export class ChatMoneyDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Ads (Module 5)
  async ads(status: string, limit: number) {
    const filter = status === 'ALL' ? Prisma.empty : Prisma.sql`AND a.status = ${status}`;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        creator_id: string | null;
        creator_username: string | null;
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
        revert_rewards: boolean;
        price_usd: Prisma.Decimal;
        breakdown: unknown;
        status: string;
        created_at: Date;
        ended_at: Date | null;
        cancel_note: string | null;
        refund_usd: Prisma.Decimal | null;
        refunded_at: Date | null;
      }[]
    >`
      SELECT a.id, a.creator_id, u.username AS creator_username, a.creator_admin_id, a.content, a.room_ids,
             a.all_rooms, a.pin_minutes, a.repeat_count, a.repeat_gap_min, a.posted_count, a.next_post_at,
             a.hidden_countries, a.badge_id, a.skin_id, a.revert_rewards, a.price_usd, a.breakdown, a.status, a.created_at, a.ended_at,
             a.cancel_note, a.refund_usd, a.refunded_at
      FROM chat.chat_ads a
      LEFT JOIN identity.users u ON u.id = a.creator_id
      WHERE true ${filter}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit}
    `;
    return rows.map((a) => ({
      id: a.id,
      advertiser: a.creator_admin_id ? 'ADMIN_PANEL' : (a.creator_username ?? a.creator_id),
      content: a.content,
      roomIds: a.room_ids,
      allRooms: a.all_rooms,
      pinMinutes: a.pin_minutes,
      repeatCount: a.repeat_count,
      repeatGapMinutes: a.repeat_gap_min,
      postedCount: a.posted_count,
      nextPostAt: iso(a.next_post_at),
      hiddenCountries: a.hidden_countries,
      badgeId: a.badge_id,
      skinId: a.skin_id,
      rewardsReverted: a.revert_rewards,
      priceUsd: a.price_usd.toFixed(2),
      breakdown: a.breakdown,
      status: a.status,
      createdAt: iso(a.created_at),
      endedAt: iso(a.ended_at),
      cancelNote: a.cancel_note,
      refundUsd: a.refund_usd === null ? null : a.refund_usd.toFixed(2),
      refundedAt: iso(a.refunded_at),
    }));
  }

  /** The ads a revert covers: placed in the time frame, by these users, in this price range, or these ads. */
  async adsForRevert(filter: RevertFilter & { adIds: string[]; pinnedOnly: boolean }) {
    const rows = await this.prisma.$queryRaw<
      { id: string; status: string; creator_id: string | null }[]
    >`
      SELECT a.id, a.status, a.creator_id FROM chat.chat_ads a
      WHERE a.created_at >= ${filter.from}::timestamptz AND a.created_at < ${filter.to}::timestamptz
        ${filter.userIds.length ? Prisma.sql`AND a.creator_id = ANY(${filter.userIds}::uuid[])` : Prisma.empty}
        ${filter.adIds.length ? Prisma.sql`AND a.id = ANY(${filter.adIds}::uuid[])` : Prisma.empty}
        ${filter.minUsd !== null ? Prisma.sql`AND a.price_usd >= ${filter.minUsd}::numeric` : Prisma.empty}
        ${filter.maxUsd !== null ? Prisma.sql`AND a.price_usd <= ${filter.maxUsd}::numeric` : Prisma.empty}
        ${filter.pinnedOnly ? Prisma.sql`AND a.pin_minutes IS NOT NULL` : Prisma.empty}
        AND a.status IN ('ACTIVE', 'PAUSED', 'COMPLETED')
      ORDER BY a.created_at
      LIMIT ${REVERT_MAX}
    `;
    return rows;
  }

  /**
   * "Revert … [group of users]": queued for the chat server, which knows who is Premium, KYC-verified or of a level
   * (chat.money_revert_jobs). Returns the job id.
   */
  async queueGroupRevert(
    kind: 'GIFTS' | 'ADS',
    adminId: string,
    filter: RevertFilter & {
      group: { targetType: 'PREMIUM' | 'KYC' | 'LEVEL'; value: string };
      note: string | null;
      currencies?: string[];
      refundFees?: boolean;
      adIds?: string[];
      pinnedOnly?: boolean;
    },
  ): Promise<string> {
    const id = ChatUtility.generateUuid();
    await this.prisma.$executeRaw`
      INSERT INTO chat.money_revert_jobs (id, kind, filter, created_by)
      VALUES (${id}::uuid, ${kind}, ${JSON.stringify(filter)}::jsonb, ${adminId}::uuid)
    `;
    return id;
  }

  async revertJobs(limit: number) {
    const rows = await this.prisma.$queryRaw<{
      id: string; kind: string; status: string; result: unknown; error: string | null; created_by: string;
      created_at: Date; started_at: Date | null; finished_at: Date | null; progress: unknown;
    }[]>`
      SELECT id, kind, status, result, error, created_by, created_at, started_at, finished_at, progress
      FROM chat.money_revert_jobs ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id, kind: row.kind, status: row.status, result: row.result, error: row.error,
      createdBy: row.created_by, createdAt: iso(row.created_at), startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at), progress: row.progress,
    }));
  }

  async revertJob(id: string) {
    const rows = await this.prisma.$queryRaw<{
      id: string; kind: string; status: string; filter: unknown; result: unknown; error: string | null;
      created_by: string; created_at: Date; started_at: Date | null; finished_at: Date | null; progress: unknown;
    }[]>`
      SELECT id, kind, status, filter, result, error, created_by, created_at, started_at, finished_at, progress
      FROM chat.money_revert_jobs WHERE id = ${id}::uuid
    `;
    const row = rows[0];
    return row ? {
      id: row.id, kind: row.kind, status: row.status, filter: row.filter, result: row.result, error: row.error,
      createdBy: row.created_by, createdAt: iso(row.created_at), startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at), progress: row.progress,
    } : null;
  }

  /** "Reverting will also revert EXP and Stars Earned": the chat server takes them back. */
  async markAdRewardsRevert(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.prisma.$executeRaw`
      UPDATE chat.chat_ads SET revert_rewards = true
      WHERE id = ANY(${ids}::uuid[]) AND creator_id IS NOT NULL AND NOT revert_rewards
    `;
  }

  /**
   * "Revert ALL Transfers for a Specific Time Frame": completed gifts become REVERT_PENDING; the chat server asks the
   * transfer module to move each back (or records why not) and takes back the rewards. `dryRun` only counts.
   */
  async revertGifts(
    filter: RevertFilter & {
      currencies: string[];
      refundFees: boolean;
      adminId: string;
      dryRun: boolean;
      shortfall?: 'ZERO' | 'NEGATIVE';
      reason?: string | null;
    },
  ): Promise<{ count: number; usd: string }> {
    const where = Prisma.sql`
      g.status = 'COMPLETED' AND g.created_at >= ${filter.from}::timestamptz AND g.created_at < ${filter.to}::timestamptz
      ${filter.userIds.length ? Prisma.sql`AND (g.sender_id = ANY(${filter.userIds}::uuid[]) OR g.recipient_id = ANY(${filter.userIds}::uuid[]))` : Prisma.empty}
      ${filter.currencies.length ? Prisma.sql`AND g.currency = ANY(${filter.currencies}::text[])` : Prisma.empty}
      ${filter.minUsd !== null ? Prisma.sql`AND g.usd_value >= ${filter.minUsd}::numeric` : Prisma.empty}
      ${filter.maxUsd !== null ? Prisma.sql`AND g.usd_value <= ${filter.maxUsd}::numeric` : Prisma.empty}
    `;
    const rows = filter.dryRun
      ? await this.prisma.$queryRaw<{ count: number; usd: Prisma.Decimal | null }[]>`
          SELECT count(*)::int AS count, sum(g.usd_value) AS usd FROM chat.gift_transfers g WHERE ${where}
        `
      : await this.prisma.$queryRaw<{ count: number; usd: Prisma.Decimal | null }[]>`
          WITH picked AS (
            SELECT g.id FROM chat.gift_transfers g WHERE ${where} ORDER BY g.created_at LIMIT ${REVERT_MAX}
          ), marked AS (
            UPDATE chat.gift_transfers t
            SET status = 'REVERT_PENDING', revert_refund_fees = ${filter.refundFees},
                revert_requested_by = ${filter.adminId}::uuid, revert_requested_at = now(),
                revert_shortfall = ${filter.shortfall ?? 'ZERO'}
            FROM picked WHERE t.id = picked.id AND t.status = 'COMPLETED'
            RETURNING t.usd_value
          )
          SELECT count(*)::int AS count, sum(usd_value) AS usd FROM marked
        `;
    return { count: rows[0]?.count ?? 0, usd: (rows[0]?.usd ?? new Prisma.Decimal(0)).toFixed(2) };
  }

  /** An ad from the admin panel: free, posted by the chat server's next tick (next_post_at = now). */
  async createAdminAd(data: {
    adminId: string;
    content: string;
    roomIds: string[];
    allRooms: boolean;
    pinMinutes: number | null;
    repeatCount: number;
    repeatGapMin: number | null;
    badgeId: string | null;
    hiddenCountries: string[];
  }): Promise<string> {
    const id = ChatUtility.generateUuid();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO chat.chat_ads (id, creator_admin_id, content, room_ids, all_rooms, pin_minutes, repeat_count,
          repeat_gap_min, hidden_countries, badge_id, price_usd, breakdown, status, next_post_at, kind)
        VALUES (${id}::uuid, ${data.adminId}::uuid, ${data.content}, ${data.roomIds}::uuid[], ${data.allRooms},
          ${data.pinMinutes}::int, ${data.repeatCount}::int, ${data.repeatGapMin}::int, ${data.hiddenCountries}::text[],
          ${data.badgeId}, 0, ${JSON.stringify([{ label: 'Admin ad', usd: '0.00000000' }])}::jsonb, 'ACTIVE', now(), 'INTERNAL')
      `;
      if (data.pinMinutes) {
        for (const roomId of data.roomIds) {
          await tx.$executeRaw`
            INSERT INTO chat.chat_ad_placements (id, ad_id, room_id, minutes, status)
            VALUES (${ChatUtility.generateUuid()}::uuid, ${id}::uuid, ${roomId}::uuid, ${data.pinMinutes}::int, 'QUEUED')
          `;
        }
      }
    });
    return id;
  }

  /**
   * Cancels an ACTIVE or PAUSED ad and works out its refund INSIDE the transaction, with the ad row locked, so a post
   * that lands between "read" and "cancel" is never missed. The share is exact decimal arithmetic in the database and
   * cut (never rounded) to 8 places: price × unused / units, where units are the posts plus the pinned minutes, and the
   * pinned minutes count once per ad (not per room) — the same rule as the chat server. NONE and FULL need no share.
   */
  async cancelAd(
    id: string,
    adminId: string,
    note: string | null,
    refund: 'NONE' | 'UNUSED' | 'FULL',
  ): Promise<{ cancelled: boolean; refundUsd: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { price_usd: Prisma.Decimal; repeat_count: number; posted_count: number; pin_minutes: number | null; charge_reference: string | null }[]
      >`
        SELECT price_usd, repeat_count, posted_count, pin_minutes, charge_reference
        FROM chat.chat_ads WHERE id = ${id}::uuid AND status IN ('ACTIVE', 'PAUSED') FOR UPDATE
      `;
      const ad = rows[0];
      if (!ad) return { cancelled: false, refundUsd: null };
      let refundUsd: string | null = null;
      if (refund !== 'NONE' && ad.charge_reference && !ad.price_usd.isZero()) {
        if (refund === 'FULL') {
          refundUsd = ad.price_usd.toFixed(8);
        } else {
          const used = await tx.$queryRaw<{ used: number }[]>`
            SELECT COALESCE(max(room_used), 0)::int AS used FROM (
              SELECT sum(CASE WHEN status = 'DONE' THEN minutes
                              WHEN status = 'ACTIVE' THEN LEAST(minutes, ceil(extract(epoch FROM (now() - starts_at)) / 60))
                              ELSE 0 END) AS room_used
              FROM chat.chat_ad_placements WHERE ad_id = ${id}::uuid GROUP BY room_id
            ) per_room
          `;
          const totalPosts = ad.repeat_count + 1;
          const pinned = ad.pin_minutes ?? 0;
          const units = totalPosts + pinned;
          const unused = Math.max(0, totalPosts - ad.posted_count) + Math.max(0, pinned - (used[0]?.used ?? 0));
          const share = await tx.$queryRaw<{ refund: string }[]>`
            SELECT trunc(${ad.price_usd.toFixed(8)}::numeric * ${unused}::numeric / ${units}::numeric, 8)::text AS refund
          `;
          refundUsd = share[0]!.refund;
        }
      }
      await tx.$executeRaw`
        UPDATE chat.chat_ads
        SET status = 'CANCELLED', ended_at = now(), next_post_at = NULL, claimed_at = NULL, cancelled_by = ${adminId}::uuid,
            cancel_note = ${note}, refund_usd = ${refundUsd}::numeric
        WHERE id = ${id}::uuid
      `;
      await tx.$executeRaw`
        UPDATE chat.chat_ad_placements SET status = 'CANCELLED'
        WHERE ad_id = ${id}::uuid AND status IN ('QUEUED', 'ACTIVE')
      `;
      return { cancelled: true, refundUsd };
    });
  }

  // Gifts and the command log (Module 5)
  async gifts(status: string, userId: string | null, limit: number) {
    const filter = status === 'ALL' ? Prisma.empty : Prisma.sql`AND g.status = ${status}`;
    const user = userId
      ? Prisma.sql`AND (g.sender_id = ${userId}::uuid OR g.recipient_id = ${userId}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        sender: string | null;
        recipient: string | null;
        currency: string;
        amount: Prisma.Decimal;
        usd_value: Prisma.Decimal | null;
        fee_amount: Prisma.Decimal | null;
        room_id: string | null;
        conversation_id: string | null;
        verification: string;
        status: string;
        transfer_reference: string | null;
        failure_reason: string | null;
        created_at: Date;
        completed_at: Date | null;
        revert_requested_at: Date | null;
        reverted_at: Date | null;
      }[]
    >`
      SELECT g.id, s.username AS sender, r.username AS recipient, g.currency, g.amount, g.usd_value, g.fee_amount,
             g.room_id, g.conversation_id, g.verification, g.status, g.transfer_reference, g.failure_reason,
             g.created_at, g.completed_at, g.revert_requested_at, g.reverted_at
      FROM chat.gift_transfers g
      LEFT JOIN identity.users s ON s.id = g.sender_id
      LEFT JOIN identity.users r ON r.id = g.recipient_id
      WHERE true ${filter} ${user}
      ORDER BY g.created_at DESC, g.id DESC
      LIMIT ${limit}
    `;
    return rows.map((g) => ({
      id: g.id,
      sender: g.sender,
      recipient: g.recipient,
      currency: g.currency,
      amount: g.amount.toFixed(),
      usdValue: g.usd_value?.toFixed(2) ?? null,
      feeAmount: g.fee_amount?.toFixed() ?? null,
      roomId: g.room_id,
      conversationId: g.conversation_id,
      verification: g.verification,
      status: g.status,
      transferReference: g.transfer_reference,
      failureReason: g.failure_reason,
      createdAt: iso(g.created_at),
      completedAt: iso(g.completed_at),
      revertRequestedAt: iso(g.revert_requested_at),
      revertedAt: iso(g.reverted_at),
    }));
  }

  async commandLog(userId: string | null, limit: number) {
    const user = userId ? Prisma.sql`AND c.user_id = ${userId}::uuid` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        username: string | null;
        room_id: string | null;
        command: string;
        args: unknown;
        result: string;
        reason: string | null;
        created_at: Date;
      }[]
    >`
      SELECT c.id, u.username, c.room_id, c.command, c.args, c.result, c.reason, c.created_at
      FROM chat.chat_commands c LEFT JOIN identity.users u ON u.id = c.user_id
      WHERE true ${user}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${limit}
    `;
    return rows.map((c) => ({
      id: c.id,
      username: c.username,
      roomId: c.room_id,
      command: c.command,
      args: c.args,
      result: c.result,
      reason: c.reason,
      createdAt: iso(c.created_at),
    }));
  }
}
