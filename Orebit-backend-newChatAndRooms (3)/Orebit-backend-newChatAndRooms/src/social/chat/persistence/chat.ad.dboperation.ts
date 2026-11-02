// Database access for chat ads (Module 5): the ads, their repeats, and the pinned-ad queue of each room.
// Ads are never deleted: a finished, cancelled or refunded ad keeps its row for billing and audit. Every time —
// when a pinned slot starts and ends, when the next repeat is due — is the database clock.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { claimBatch, releaseClaim } from '../platform/jobs';
import { enqueuePin, pinnedSecondsUsedOf } from './chat.ad-pins.dboperation';
import { type Db } from './chat.sql';
import type { Cursor } from '../chat.utility';
import {
  type AdStatus,
  type AdRecord,
  type AdSqlRow,
  AD_SELECT,
  toAd,
} from './chat.ad.rows';

export type { AdStatus, AdRecord, AdSqlRow };

@Injectable()
export class ChatAdDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async insertAd(
    db: Db,
    data: {
      id: string;
      creatorId: string;
      content: string;
      roomIds: readonly string[];
      allRooms: boolean;
      pinMinutes: number | null;
      repeatCount: number;
      repeatGapMin: number | null;
      hiddenCountries: readonly string[];
      badgeId: string | null;
      skinId: string | null;
      priceUsd: string;
      breakdown: unknown;
      chargeReference: string | null;
      // PENDING_PAYMENT before the charge; ACTIVE for a free ad.
      status: 'PENDING_PAYMENT' | 'ACTIVE';
      idempotencyKey: string;
      requestFingerprint: string;
      kind?: string;
      is18Plus?: boolean;
      planId?: string | null;
      discountUsd?: string | null;
    },
  ): Promise<void> {
    await db.$executeRaw`
      INSERT INTO chat.chat_ads (id, creator_id, content, room_ids, all_rooms, pin_minutes, repeat_count,
        repeat_gap_min, hidden_countries, badge_id, skin_id, price_usd, breakdown, charge_reference, status,
        idempotency_key, request_fingerprint, kind, is_18_plus, plan_id, discount_usd)
      VALUES (${data.id}::uuid, ${data.creatorId}::uuid, ${data.content}, ${[...data.roomIds]}::uuid[],
        ${data.allRooms}, ${data.pinMinutes}, ${data.repeatCount}, ${data.repeatGapMin},
        ${[...data.hiddenCountries]}::text[], ${data.badgeId}, ${data.skinId}, ${data.priceUsd}::numeric,
        ${JSON.stringify(data.breakdown)}::jsonb, ${data.chargeReference}, ${data.status},
        ${data.idempotencyKey}, ${data.requestFingerprint},
        ${data.kind ?? 'COMMERCIAL'}, ${data.is18Plus ?? false}, ${data.planId ?? null},
        ${data.discountUsd ? Prisma.sql`${data.discountUsd}::numeric` : Prisma.sql`NULL`})
    `;
    // A free ad is ACTIVE now: its first post is due now, and the claim loop picks it up if the request that made it dies.
    await db.$executeRaw`
      UPDATE chat.chat_ads SET next_post_at = now() WHERE id = ${data.id}::uuid AND status = 'ACTIVE'
    `;
  }

  // The advertiser's ad for this key, if any (the unique index makes it at most one).
  async adByKey(userId: string, key: string): Promise<AdRecord | null> {
    const rows = await this.prisma.$queryRaw<AdSqlRow[]>`
      ${AD_SELECT} WHERE creator_id = ${userId}::uuid AND idempotency_key = ${key}
    `;
    return rows[0] ? toAd(rows[0]) : null;
  }

  // PENDING_PAYMENT → ACTIVE with the charge reference. The pinned slots were queued when the ad was saved (they wait
// for ACTIVE). False when the ad is no longer waiting for payment (another worker settled it first).
  async activate(adId: string, chargeReference: string | null): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.chat_ads SET status = 'ACTIVE', charge_reference = ${chargeReference}, claimed_at = NULL, next_post_at = now()
      WHERE id = ${adId}::uuid AND status = 'PENDING_PAYMENT'
    `;
    return changed > 0;
  }

  // PENDING_PAYMENT → FAILED: the charge was refused, or the Charge port says it never happened. Its queued pinned
// slots are given up in the same transaction, so a failed ad never holds a place in a room's queue.
  async fail(adId: string, reason: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`
        UPDATE chat.chat_ads SET status = 'FAILED', failure_reason = ${reason.slice(0, 300)}, ended_at = now(), claimed_at = NULL
        WHERE id = ${adId}::uuid AND status = 'PENDING_PAYMENT'
      `;
      if (changed === 0) return false;
      await tx.$executeRaw`
        UPDATE chat.chat_ad_placements SET status = 'CANCELLED' WHERE ad_id = ${adId}::uuid AND status = 'QUEUED'
      `;
      return true;
    });
  }

  // A charge provider answered PAID after the pending row had already timed out to FAILED. Convert it into the
  // normal refund queue atomically so the existing idempotent refund worker can return the money.
  async recordLateChargeRefund(adId: string, chargeReference: string, amountUsd: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.chat_ads
      SET status = 'CANCELLED', charge_reference = ${chargeReference}, refund_usd = ${amountUsd}::numeric,
          refund_currency = NULL, ended_at = COALESCE(ended_at, now()), cancel_note = 'Late payment for failed ad'
      WHERE id = ${adId}::uuid AND status = 'FAILED' AND charge_reference IS NULL
    `;
    return changed > 0;
  }

  // Ads left PENDING_PAYMENT for `minutes`, claimed for the payment check (a crashed checker's claim is taken over).
  async claimPendingPayments(minutes: number, limit: number, staleSeconds: number): Promise<AdRecord[]> {
    const ids = await claimBatch(this.prisma, {
      table: 'chat_ads',
      due: Prisma.sql`status = 'PENDING_PAYMENT' AND created_at < now() - make_interval(mins => ${minutes}::int)`,
      orderBy: 'created_at',
      limit,
      staleSeconds,
    });
    return this.byIds(ids);
  }

  // The claim goes back so the next pass tries again (a payment check that could not answer).
  releaseAd(adId: string): Promise<void> {
    return releaseClaim(this.prisma, 'chat_ads', adId);
  }

  async deferPost(adId: string, seconds = 30): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.chat_ads SET claimed_at = NULL, next_post_at = now() + make_interval(secs => ${seconds}::int)
      WHERE id = ${adId}::uuid AND status = 'ACTIVE'
    `;
  }

  private async byIds(ids: readonly string[]): Promise<AdRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.$queryRaw<AdSqlRow[]>`${AD_SELECT} WHERE id = ANY(${[...ids]}::uuid[]) ORDER BY created_at`;
    return rows.map(toAd);
  }

  async adById(id: string): Promise<AdRecord | null> {
    const rows = await this.prisma.$queryRaw<AdSqlRow[]>`${AD_SELECT} WHERE id = ${id}::uuid`;
    return rows[0] ? toAd(rows[0]) : null;
  }

  async adsByCreator(userId: string, limit: number, cursor: Cursor | null): Promise<AdRecord[]> {
    const after = cursor
      ? Prisma.sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<AdSqlRow[]>`
      ${AD_SELECT} WHERE creator_id = ${userId}::uuid ${after}
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}
    `;
    return rows.map(toAd);
  }

  // "Separate Advertisement Tab": running ads, newest first.
  async activeAds(limit: number, cursor: Cursor | null, country: string | null = null): Promise<AdRecord[]> {
    const after = cursor
      ? Prisma.sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<AdSqlRow[]>`
      ${AD_SELECT} WHERE status = 'ACTIVE' ${after}
        ${country === null ? Prisma.empty : Prisma.sql`AND NOT (${country}::text = ANY(hidden_countries))`}
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}
    `;
    return rows.map(toAd);
  }

  // One more post made, counted only if the ad is still ACTIVE and still at `expected` posts, so a repeat can never be
// counted twice; the next repeat is due after the gap, or nothing is left. Releases the worker's claim. False when
// the count had already moved (nothing changes).
  async recordPosted(adId: string, expected: number): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.chat_ads
      SET posted_count = posted_count + 1, claimed_at = NULL,
          next_post_at = CASE WHEN posted_count + 1 <= repeat_count AND repeat_gap_min IS NOT NULL
                              THEN now() + make_interval(mins => repeat_gap_min) ELSE NULL END
      WHERE id = ${adId}::uuid AND status = 'ACTIVE' AND posted_count = ${expected}
    `;
    return changed > 0;
  }

  // ACTIVE ads whose next repeat is due, claimed so two workers never post the same repeat. A claim older than
// `staleSeconds` belongs to a worker that died and is taken over.
  async claimDueRepeats(limit: number, staleSeconds: number, onlyId: string | null = null): Promise<AdRecord[]> {
    const ids = await claimBatch(this.prisma, {
      table: 'chat_ads',
      due: Prisma.sql`status = 'ACTIVE' AND next_post_at IS NOT NULL AND next_post_at <= now()
        ${onlyId ? Prisma.sql`AND id = ${onlyId}::uuid` : Prisma.empty}`,
      orderBy: 'next_post_at',
      limit,
      staleSeconds,
    });
    return this.byIds(ids);
  }

  // ACTIVE ads with nothing left to post or pin become COMPLETED.
  async completeFinished(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE chat.chat_ads a SET status = 'COMPLETED', ended_at = now()
      WHERE a.status = 'ACTIVE' AND a.next_post_at IS NULL AND a.posted_count > a.repeat_count
        AND NOT EXISTS (SELECT 1 FROM chat.chat_ad_placements p
                        WHERE p.ad_id = a.id AND p.status IN ('QUEUED', 'ACTIVE'))
    `;
  }

  // Completed ads whose rewards have not yet been evaluated/awarded.
  async completedWithoutRewards(): Promise<{ id: string; creatorId: string | null; priceUsd: string }[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; creator_id: string | null; price_usd: Prisma.Decimal }[]>`
      SELECT id, creator_id, price_usd FROM chat.chat_ads
      WHERE status = 'COMPLETED' AND creator_id IS NOT NULL
        AND (rewards = '{}'::jsonb OR rewards->>'awarded' = 'false')
      ORDER BY created_at, id
      LIMIT 50
    `;
    return rows.map((r) => ({ id: r.id, creatorId: r.creator_id, priceUsd: r.price_usd.toString() }));
  }

  // Cancels an ACTIVE or PAUSED ad and its open slots. The ad row is locked first and the refund is worked out from
// what it holds at that moment (`refundOf` gets the ad and the pinned minutes shown), so a post that lands between
// "read" and "cancel" is never missed. Returns the rooms whose showing slot ended and the refund decided.
  async cancel(
    adId: string,
    by: string | null,
    note: string | null,
    refundOf: (ad: AdRecord, pinnedSecondsUsed: number) => string | null,
    refundCurrency: string | null = null,
    preserveActivePins = false,
  ): Promise<{ cancelled: boolean; unpinnedRoomIds: string[]; refundUsd: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<AdSqlRow[]>`
        ${AD_SELECT} WHERE id = ${adId}::uuid AND status IN ('ACTIVE', 'PAUSED') FOR UPDATE
      `;
      if (!rows[0]) return { cancelled: false, unpinnedRoomIds: [], refundUsd: null };
      const ad = toAd(rows[0]);
      const shown = (ad.pinMinutes ?? 0) > 0 ? await pinnedSecondsUsedOf(tx, adId) : 0;
      const refundUsd = refundOf(ad, shown);
      await tx.$executeRaw`
        UPDATE chat.chat_ads
        SET status = 'CANCELLED', ended_at = now(), next_post_at = NULL, claimed_at = NULL, cancelled_by = ${by}::uuid,
            cancel_note = ${note}, refund_usd = ${refundUsd}::numeric, refund_currency = ${refundCurrency},
            revert_rewards = true
        WHERE id = ${adId}::uuid
      `;
      const ended = await tx.$queryRaw<{ room_id: string; was_active: boolean }[]>`
        UPDATE chat.chat_ad_placements SET status = 'CANCELLED'
        WHERE ad_id = ${adId}::uuid AND status IN ('QUEUED', 'ACTIVE')
          ${preserveActivePins ? Prisma.sql`AND status = 'QUEUED'` : Prisma.empty}
        RETURNING room_id, (starts_at IS NOT NULL) AS was_active
      `;
      return {
        cancelled: true,
        refundUsd,
        unpinnedRoomIds: ended.filter((row) => row.was_active).map((row) => row.room_id),
      };
    });
  }

  async setRewards(adId: string, rewards: Record<string, unknown>): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.chat_ads SET rewards = ${JSON.stringify(rewards)}::jsonb WHERE id = ${adId}::uuid
    `;
  }

  // Ads an admin reverted whose rewards are still to be taken back ("Reverting will also revert EXP").
  async rewardsToRevoke(): Promise<AdRecord[]> {
    const rows = await this.prisma.$queryRaw<AdSqlRow[]>`
      ${AD_SELECT} WHERE revert_rewards AND rewards_revoked_at IS NULL AND creator_id IS NOT NULL LIMIT 50
    `;
    return rows.map(toAd);
  }

  async markRewardsRevoked(adId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.chat_ads SET rewards_revoked_at = now() WHERE id = ${adId}::uuid
    `;
  }

  // Ads with a refund to pay that has not been paid yet, claimed so the minute pass, an admin signal and a user's
// cancel never pay the same refund twice. A claim older than `staleSeconds` is taken over.
  async claimRefundsDue(limit: number, staleSeconds: number): Promise<AdRecord[]> {
    const ids = await claimBatch(this.prisma, {
      table: 'chat_ads',
      due: Prisma.sql`refund_usd IS NOT NULL AND refund_usd > 0 AND refunded_at IS NULL AND status = 'CANCELLED'
        AND charge_reference IS NOT NULL AND creator_id IS NOT NULL`,
      orderBy: 'ended_at',
      limit,
      staleSeconds,
    });
    return this.byIds(ids);
  }

  // Paid: only while the refund is still owed, so a second answer changes nothing.
  async markRefunded(adId: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.chat_ads SET refunded_at = now(), status = 'REFUNDED', claimed_at = NULL
      WHERE id = ${adId}::uuid AND refunded_at IS NULL AND status = 'CANCELLED'
    `;
    return changed > 0;
  }

  // ON / OFF / MAINTENANCE of ads
  // The ads status (settings.maintenance.ads) the chat server last acted on.
  async appliedAdsStatus(): Promise<'ACTIVE' | 'MAINTENANCE' | 'DISABLED'> {
    const rows = await this.prisma.$queryRaw<{ applied_status: 'ACTIVE' | 'MAINTENANCE' | 'DISABLED' }[]>`
      SELECT applied_status FROM chat.ads_state WHERE id = 1
    `;
    return rows[0]?.applied_status ?? 'ACTIVE';
  }

  async setAppliedAdsStatus(status: 'ACTIVE' | 'MAINTENANCE' | 'DISABLED'): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.ads_state (id, applied_status, updated_at) VALUES (1, ${status}, now())
      ON CONFLICT (id) DO UPDATE SET applied_status = EXCLUDED.applied_status, updated_at = now()
    `;
  }

  async adsWithStatus(statuses: readonly AdStatus[], afterId: string | null, limit: number): Promise<AdRecord[]> {
    const rows = await this.prisma.$queryRaw<AdSqlRow[]>`
      ${AD_SELECT}
      WHERE status = ANY(${[...statuses]}::text[])
        AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
      ORDER BY id
      LIMIT ${limit}
    `;
    return rows.map(toAd);
  }

  // "Pause Existing Ads": every ACTIVE ad becomes PAUSED. A pinned slot showing now ends with the minutes it had, and
// the rest of its time waits in the queue for the resume. Returns the rooms whose pinned ad came down.
  async pauseActive(onlyAdIds?: readonly string[]): Promise<{ paused: number; unpinned: { roomId: string; adId: string }[] }> {
    return this.prisma.$transaction(async (tx) => {
      const paused = await tx.$queryRaw<{ id: string }[]>`
        UPDATE chat.chat_ads SET status = 'PAUSED' WHERE status = 'ACTIVE'
          ${onlyAdIds ? Prisma.sql`AND id = ANY(${[...onlyAdIds]}::uuid[])` : Prisma.empty}
        RETURNING id
      `;
      if (paused.length === 0) return { paused: 0, unpinned: [] };
      const ids = paused.map((row) => row.id);
      const showing = await tx.$queryRaw<{ id: string; ad_id: string; room_id: string; minutes: number; duration_seconds: number; used: number }[]>`
        SELECT id, ad_id, room_id, minutes, duration_seconds,
               LEAST(duration_seconds, floor(extract(epoch FROM (now() - starts_at))))::int AS used
        FROM chat.chat_ad_placements
        WHERE ad_id = ANY(${ids}::uuid[]) AND status = 'ACTIVE'
        FOR UPDATE
      `;
      for (const slot of showing) {
        if (slot.used <= 0) {
          await tx.$executeRaw`
            UPDATE chat.chat_ad_placements SET status = 'QUEUED', starts_at = NULL, ends_at = NULL
            WHERE id = ${slot.id}::uuid
          `;
          continue;
        }
        await tx.$executeRaw`
          UPDATE chat.chat_ad_placements SET status = 'DONE', duration_seconds = ${slot.used},
            minutes = ceil(${slot.used}::numeric / 60)::int, ends_at = now()
          WHERE id = ${slot.id}::uuid
        `;
        if (slot.duration_seconds > slot.used) {
          await enqueuePin(tx, slot.ad_id, slot.room_id, slot.duration_seconds - slot.used);
        }
      }
      return {
        paused: paused.length,
        unpinned: showing.map((slot) => ({ roomId: slot.room_id, adId: slot.ad_id })),
      };
    });
  }

  // After maintenance: PAUSED ads run again. `reset` is "Reset Views and Resume the ad": the ad starts over, every post
// again and its full pinned time in every room.
  async resumePaused(reset: boolean): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const resumed = await tx.$queryRaw<{ id: string; room_ids: string[]; pin_minutes: number | null }[]>`
        UPDATE chat.chat_ads
        SET status = 'ACTIVE',
            posted_count = CASE WHEN ${reset} THEN 0 ELSE posted_count END,
            next_post_at = CASE WHEN ${reset} THEN now() ELSE next_post_at END
        WHERE status = 'PAUSED'
        RETURNING id, room_ids, pin_minutes
      `;
      if (reset) {
        for (const ad of resumed) {
          await tx.$executeRaw`
            UPDATE chat.chat_ad_placements SET status = 'CANCELLED'
            WHERE ad_id = ${ad.id}::uuid AND status IN ('QUEUED', 'DONE')
          `;
          if (ad.pin_minutes) {
            for (const roomId of ad.room_ids ?? []) await enqueuePin(tx, ad.id, roomId, ad.pin_minutes * 60);
          }
        }
      }
      return resumed.length;
    });
  }
}
