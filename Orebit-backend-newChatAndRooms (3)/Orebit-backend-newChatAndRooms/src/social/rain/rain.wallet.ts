import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../db/client';
import { rainDevWallet } from './rain.dev';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { uuidv7 } from '../../utils/public.utils';
import type { LedgerLeg } from './rain.math';

/**
 * The seam the wallet ledger will occupy.
 *
 * Production refuses every rain that would move money until that ledger is connected.
 * `RAIN_DEV_WALLET` (development only; boot fails if it is set in production) keeps a
 * separate dev balance table so the rain flow can be exercised locally.
 */
export const DEV_STARTING_MINOR = 1_000n * 100_000_000n;

@Injectable()
export class RainWallet {
  available(): boolean {
    return rainDevWallet();
  }

  /**
   * In the development wallet the system account is a test pool: System Rain may draw it below
   * zero, so trying out large rains never stalls on a dev balance. A real ledger decides this
   * from the platform treasury instead.
   */
  systemPoolUnlimited(): boolean {
    return this.available();
  }

  refuseIfUnavailable(): void {
    if (this.available()) return;
    throw new ProblemException({
      type: ERR.FORBIDDEN,
      detail:
        'Rain cannot move money yet. The wallet ledger is not connected. Local development can set RAIN_DEV_WALLET=true.',
    });
  }

  /**
   * `allowNegative` is the reversal's "negative balance" policy: a debit then never refuses.
   * Everything else refuses a debit the balance cannot cover, and nothing in the transaction moves.
   */
  async apply(
    tx: Prisma.TransactionClient,
    legs: readonly LedgerLeg[],
    currency: string,
    options: { allowNegative?: boolean } = {},
  ): Promise<void> {
    this.refuseIfUnavailable();
    if (legs.length === 0) return;

    // Process payout legs in a fixed order (sorted by user id) to prevent circular deadlocks
    const sorted = [...legs].sort((a, b) => a.userId.localeCompare(b.userId));
    const debitLegs = sorted.filter((leg) => leg.delta < 0n);
    const creditLegs = sorted.filter((leg) => leg.delta > 0n);

    for (const leg of debitLegs) {
      if (options.allowNegative) await this.credit(tx, leg, currency);
      else await this.debit(tx, leg, currency);
    }

    if (creditLegs.length > 0) {
      const userIds = creditLegs.map((l) => l.userId);
      const startingMinors = creditLegs.map((l) => (DEV_STARTING_MINOR + l.delta).toString());
      await tx.$executeRaw`
        INSERT INTO rain.dev_balances (user_id, currency, balance_minor)
        SELECT u::uuid, ${currency}, initial::bigint
        FROM unnest(${userIds}::uuid[], ${startingMinors}::bigint[]) AS v(u, initial)
        ON CONFLICT (user_id, currency)
        DO UPDATE SET balance_minor = rain.dev_balances.balance_minor + EXCLUDED.balance_minor - ${DEV_STARTING_MINOR.toString()}::bigint
      `;
    }

    const nonZero = sorted.filter((l) => l.delta !== 0n);
    if (nonZero.length > 0) {
      const ids = nonZero.map(() => uuidv7());
      const keys = nonZero.map((l) => l.key);
      const userIds = nonZero.map((l) => l.userId);
      const deltas = nonZero.map((l) => l.delta.toString());
      await tx.$executeRaw`
        INSERT INTO rain.ledger_entries (id, idempotency_key, user_id, currency, delta_minor)
        SELECT i::uuid, k::text, u::uuid, ${currency}, d::bigint
        FROM unnest(${ids}::uuid[], ${keys}::text[], ${userIds}::uuid[], ${deltas}::bigint[]) AS v(i, k, u, d)
      `;
    }
  }

  /**
   * What the payer could spend right now, for an early "not enough balance" answer before any
   * verification is asked for. The debit itself re-checks atomically; this is never the guard.
   */
  async spendable(db: Prisma.TransactionClient | PrismaService, userId: string, currency: string): Promise<bigint> {
    this.refuseIfUnavailable();
    const rows = await db.$queryRaw<{ balance_minor: bigint }[]>`
      SELECT balance_minor FROM rain.dev_balances WHERE user_id = ${userId}::uuid AND currency = ${currency}
    `;
    return rows[0] ? BigInt(rows[0].balance_minor) : DEV_STARTING_MINOR;
  }

  /** Balances of these users, locked until the transaction ends, for a "refund till 0" reversal. */
  async heldForUpdate(
    tx: Prisma.TransactionClient,
    userIds: readonly string[],
    currency: string,
  ): Promise<Map<string, bigint>> {
    this.refuseIfUnavailable();
    if (userIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ user_id: string; balance_minor: bigint }[]>`
      SELECT user_id, balance_minor FROM rain.dev_balances
      WHERE currency = ${currency} AND user_id = ANY(${[...userIds]}::uuid[])
      ORDER BY user_id
      FOR UPDATE
    `;
    return new Map(rows.map((row) => [row.user_id, BigInt(row.balance_minor)]));
  }

  /** Every dev balance of one user. Empty when the dev wallet is off. */
  async balances(db: PrismaService, userId: string): Promise<{ currency: string; balanceMinor: bigint }[]> {
    if (!this.available()) return [];
    const rows = await db.$queryRaw<{ currency: string; balance_minor: bigint }[]>`
      SELECT currency, balance_minor FROM rain.dev_balances WHERE user_id = ${userId}::uuid ORDER BY currency
    `;
    return rows.map((row) => ({ currency: row.currency, balanceMinor: BigInt(row.balance_minor) }));
  }

  /** Gives a payer a starting dev balance the first time they are asked to pay. Never runs in production. */
  async ensurePayer(tx: Prisma.TransactionClient, userId: string, currency: string): Promise<void> {
    this.refuseIfUnavailable();
    await tx.$executeRaw`
      INSERT INTO rain.dev_balances (user_id, currency, balance_minor)
      VALUES (${userId}::uuid, ${currency}, ${DEV_STARTING_MINOR.toString()}::bigint)
      ON CONFLICT (user_id, currency) DO NOTHING
    `;
  }

  private async debit(
    tx: Prisma.TransactionClient,
    leg: LedgerLeg,
    currency: string,
  ): Promise<void> {
    const amount = (-leg.delta).toString();
    const count = await tx.$executeRaw`
      UPDATE rain.dev_balances
      SET balance_minor = balance_minor - ${amount}::bigint
      WHERE user_id = ${leg.userId}::uuid
        AND currency = ${currency}
        AND balance_minor >= ${amount}::bigint
    `;
    if (count !== 1) {
      throw new ProblemException({
        type: ERR.FORBIDDEN,
        detail: 'Not enough balance for this rain. Nothing was moved.',
      });
    }
  }

  private async credit(
    tx: Prisma.TransactionClient,
    leg: LedgerLeg,
    currency: string,
  ): Promise<void> {
    // A user with no row yet holds the starting dev balance (see `spendable`), so their first
    // credit lands on top of it; otherwise their wallet would drop from 1000 to just the share.
    await tx.$executeRaw`
      INSERT INTO rain.dev_balances (user_id, currency, balance_minor)
      VALUES (${leg.userId}::uuid, ${currency}, ${(DEV_STARTING_MINOR + leg.delta).toString()}::bigint)
      ON CONFLICT (user_id, currency)
      DO UPDATE SET balance_minor = rain.dev_balances.balance_minor + ${leg.delta.toString()}::bigint
    `;
  }
}
