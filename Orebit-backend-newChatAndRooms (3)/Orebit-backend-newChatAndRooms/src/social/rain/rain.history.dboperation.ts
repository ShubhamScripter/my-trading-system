import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../db/client';
import type { RainHistoryRow } from './rain.types';

interface HistorySql {
  id: string;
  kind: string;
  status: string;
  room_id: string;
  initiator: string | null;
  currency: string;
  pot_minor: bigint;
  fee_minor: bigint;
  usd_value_minor: bigint | null;
  recipient_count: number;
  message_id: string | null;
  created_at: Date;
}

function big(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : BigInt(value).toString();
}

function toHistory(row: HistorySql): RainHistoryRow {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    roomId: row.room_id,
    initiator: row.initiator,
    currency: row.currency,
    potMinor: BigInt(row.pot_minor).toString(),
    feeMinor: BigInt(row.fee_minor).toString(),
    usdValueMinor: big(row.usd_value_minor),
    recipientCount: row.recipient_count,
    messageId: row.message_id,
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class RainHistoryDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  async recent(limit: number): Promise<
    { id: string; kind: string; status: string; currency: string; potMinor: string; createdAt: string }[]
  > {
    const rows = await this.prisma.$queryRaw<
      { id: string; kind: string; status: string; currency: string; pot_minor: bigint; created_at: Date }[]
    >`
      SELECT id, kind, status, currency, pot_minor, created_at
      FROM rain.runs
      WHERE status IN ('COMPLETED', 'PARTIALLY_REVERSED', 'REVERSED')
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      currency: row.currency,
      potMinor: BigInt(row.pot_minor).toString(),
      createdAt: row.created_at.toISOString(),
    }));
  }

  async publicHistory(limit: number): Promise<RainHistoryRow[]> {
    const rows = await this.prisma.$queryRaw<HistorySql[]>`
      SELECT r.id, r.kind, r.status, r.room_id, u.username AS initiator, r.currency, r.pot_minor,
             r.fee_minor, r.usd_value_minor, r.recipient_count, r.message_id, r.created_at
      FROM rain.runs r
      LEFT JOIN identity.users u ON u.id = r.initiator_id AND r.kind = 'USER'
      WHERE r.status IN ('COMPLETED', 'PARTIALLY_REVERSED', 'REVERSED')
      ORDER BY r.created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toHistory);
  }

  async sentBy(userId: string, limit: number): Promise<RainHistoryRow[]> {
    const rows = await this.prisma.$queryRaw<HistorySql[]>`
      SELECT r.id, r.kind, r.status, r.room_id, NULL::text AS initiator, r.currency, r.pot_minor,
             r.fee_minor, r.usd_value_minor, r.recipient_count, r.message_id, r.created_at
      FROM rain.runs r
      WHERE r.initiator_id = ${userId}::uuid AND r.kind = 'USER'
      ORDER BY r.created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toHistory);
  }

  async receivedBy(
    userId: string,
    limit: number,
  ): Promise<
    {
      rainId: string;
      kind: string;
      status: string;
      currency: string;
      amountMinor: string;
      reversed: boolean;
      from: string | null;
      createdAt: string;
    }[]
  > {
    const rows = await this.prisma.$queryRaw<
      {
        rain_id: string;
        kind: string;
        status: string;
        currency: string;
        amount_minor: bigint;
        reversed_at: Date | null;
        initiator: string | null;
        created_at: Date;
      }[]
    >`
      SELECT r.id AS rain_id, r.kind, r.status, r.currency, p.amount_minor, p.reversed_at, u.username AS initiator,
             r.created_at
      FROM rain.recipients p
      JOIN rain.runs r ON r.id = p.rain_id
      LEFT JOIN identity.users u ON u.id = r.initiator_id AND r.kind = 'USER'
      WHERE p.user_id = ${userId}::uuid AND r.status IN ('COMPLETED', 'PARTIALLY_REVERSED', 'REVERSED')
      ORDER BY r.created_at DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      rainId: row.rain_id,
      kind: row.kind,
      status: row.status,
      currency: row.currency,
      amountMinor: BigInt(row.amount_minor).toString(),
      reversed: row.reversed_at !== null,
      from: row.initiator,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

