/**
 * Database access for gifts (Module 5): /send, /gift and the DM gift button. Chat records each gift from start to
 * finish; the money moves in the transfer module, keyed by the gift id so a retry never pays twice.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import { claimBatch, releaseClaim } from '../platform/jobs';
import { PLACES, cut } from '../platform/money';

export type GiftStatus =
  | 'PENDING_VERIFICATION'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'HELD';

export interface GiftRecord {
  readonly id: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly currency: string;
  readonly amount: string;
  readonly usdValue: string | null;
  readonly feeAmount: string | null;
  readonly roomId: string | null;
  readonly conversationId: string | null;
  readonly verification: 'PAYMENT_PIN' | 'TWO_FA';
  readonly status: GiftStatus;
  readonly transferReference: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** The gift's window has passed on the database clock. */
  readonly expired: boolean;
}

/** Decimal text without trailing zeros: `10.500000` → `10.5`. */
const plain = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : cut(value, PLACES.cryptoStored).toFixed();

@Injectable()
export class ChatGiftDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  async insert(data: {
    id: string;
    senderId: string;
    recipientId: string;
    currency: string;
    amount: string;
    usdValue: string;
    feeAmount: string;
    roomId: string | null;
    conversationId: string | null;
    verification: 'PAYMENT_PIN' | 'TWO_FA';
    minutes: number;
  }): Promise<{ expiresAt: Date }> {
    const rows = await this.prisma.$queryRaw<{ expires_at: Date }[]>`
      INSERT INTO chat.gift_transfers (id, sender_id, recipient_id, currency, amount, usd_value, fee_amount, room_id,
        conversation_id, verification, expires_at)
      VALUES (${data.id}::uuid, ${data.senderId}::uuid, ${data.recipientId}::uuid, ${data.currency},
        ${data.amount}::numeric, ${data.usdValue}::numeric, ${data.feeAmount}::numeric, ${data.roomId}::uuid,
        ${data.conversationId}::uuid, ${data.verification}, now() + make_interval(mins => ${data.minutes}::int))
      RETURNING expires_at
    `;
    return { expiresAt: rows[0]!.expires_at };
  }

  async byId(id: string): Promise<GiftRecord | null> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        sender_id: string;
        recipient_id: string;
        currency: string;
        amount: Prisma.Decimal;
        usd_value: Prisma.Decimal | null;
        fee_amount: Prisma.Decimal | null;
        room_id: string | null;
        conversation_id: string | null;
        verification: 'PAYMENT_PIN' | 'TWO_FA';
        status: GiftStatus;
        transfer_reference: string | null;
        created_at: Date;
        expires_at: Date;
        expired: boolean;
      }[]
    >`
      SELECT id, sender_id, recipient_id, currency, amount, usd_value, fee_amount, room_id, conversation_id,
             verification, status, transfer_reference, created_at, expires_at, expires_at <= now() AS expired
      FROM chat.gift_transfers WHERE id = ${id}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      currency: row.currency,
      amount: plain(row.amount)!,
      usdValue: plain(row.usd_value),
      feeAmount: plain(row.fee_amount),
      roomId: row.room_id,
      conversationId: row.conversation_id,
      verification: row.verification,
      status: row.status,
      transferReference: row.transfer_reference,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      expired: row.expired,
    };
  }

  /** PENDING_VERIFICATION → PROCESSING, only while the window is open; false when someone else took it. */
  async claim(id: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.gift_transfers SET status = 'PROCESSING', processing_at = now()
      WHERE id = ${id}::uuid AND status = 'PENDING_VERIFICATION' AND expires_at > now()
    `;
    return changed > 0;
  }

  /**
   * Settles a gift that is PROCESSING, once: the move is conditional on that state, so a second answer (the sweeper and
   * the request that was waiting for the transfer) changes nothing. False when it was already settled.
   */
  async finish(
    id: string,
    status: 'COMPLETED' | 'FAILED' | 'HELD',
    reference: string | null,
    reason: string | null,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.gift_transfers
      SET status = ${status}, transfer_reference = ${reference}, failure_reason = ${reason}, claimed_at = NULL,
          completed_at = CASE WHEN ${status} = 'COMPLETED' THEN now() ELSE completed_at END
      WHERE id = ${id}::uuid AND (status = 'PROCESSING' OR status = 'HELD')
    `;
    return changed > 0;
  }

  /** Gifts PROCESSING for `minutes` (the transfer call was made, no answer came), claimed for a status check. */
  async claimStaleProcessing(minutes: number, limit: number, staleSeconds: number): Promise<string[]> {
    return claimBatch(this.prisma, {
      table: 'gift_transfers',
      due: Prisma.sql`status = 'PROCESSING' AND processing_at < now() - make_interval(mins => ${minutes}::int)`,
      orderBy: 'processing_at',
      limit,
      staleSeconds,
    });
  }

  /** A claimed gift goes back so the next pass asks again (the transfer module could not answer). */
  release(id: string): Promise<void> {
    return releaseClaim(this.prisma, 'gift_transfers', id);
  }

  /** The EXP and universal currency a completed gift earned the sender. */
  async setRewards(id: string, rewards: Record<string, unknown>): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.gift_transfers SET rewards = ${JSON.stringify(rewards)}::jsonb WHERE id = ${id}::uuid
    `;
  }

  /**
   * Gifts an admin asked to revert ("Revert ALL Transfers for a Specific Time Frame"), oldest first, claimed so two
   * passes never revert the same gift; a claim older than `staleSeconds` is taken over.
   */
  async claimReverts(limit: number, staleSeconds: number) {
    const ids = await claimBatch(this.prisma, {
      table: 'gift_transfers',
      due: Prisma.sql`status = 'REVERT_PENDING'`,
      orderBy: 'revert_requested_at, id',
      limit,
      staleSeconds,
    });
    if (ids.length === 0) return [];
    return this.prisma.$queryRaw<
      {
        id: string;
        sender_id: string;
        recipient_id: string;
        currency: string;
        amount: Prisma.Decimal;
        transfer_reference: string | null;
        revert_refund_fees: boolean;
        rewards: { exp?: number; currency?: number; awarded?: boolean } | null;
        rewards_revoked_at: Date | null;
      }[]
    >`
      SELECT id, sender_id, recipient_id, currency, amount, transfer_reference, revert_refund_fees, rewards,
             rewards_revoked_at
      FROM chat.gift_transfers WHERE id = ANY(${ids}::uuid[]) ORDER BY revert_requested_at, id
    `;
  }

  async finishRevert(id: string, ok: boolean, reason: string | null): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.gift_transfers
      SET status = ${ok ? 'REVERTED' : 'REVERT_FAILED'}, reverted_at = CASE WHEN ${ok} THEN now() END,
          failure_reason = ${reason}, claimed_at = NULL
      WHERE id = ${id}::uuid AND status = 'REVERT_PENDING'
    `;
    return changed > 0;
  }

  async markRewardsRevoked(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE chat.gift_transfers SET rewards_revoked_at = now() WHERE id = ${id}::uuid
    `;
  }

  /** The sender cancels a gift still waiting for verification. */
  async cancel(id: string, senderId: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.gift_transfers SET status = 'CANCELLED'
      WHERE id = ${id}::uuid AND sender_id = ${senderId}::uuid AND status = 'PENDING_VERIFICATION'
    `;
    return changed > 0;
  }
}
