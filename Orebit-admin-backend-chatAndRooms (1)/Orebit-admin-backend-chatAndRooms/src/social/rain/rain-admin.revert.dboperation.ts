import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../db/client';
import type { RainRevertFilter } from './rain.contract';

@Injectable()
export class RainAdminRevertDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Counts how many paid rains match a revert filter
  async countMatching(filter: RainRevertFilter): Promise<{ rains: number; potMinorByCurrency: Record<string, string> }> {
    const parts: Prisma.Sql[] = [Prisma.sql`r.status IN ('COMPLETED', 'PARTIALLY_REVERSED')`];
    if (filter.kind !== 'ALL') parts.push(Prisma.sql`r.kind = ${filter.kind}`);
    if (filter.from) parts.push(Prisma.sql`r.created_at >= ${filter.from}::timestamptz`);
    if (filter.to) parts.push(Prisma.sql`r.created_at <= ${filter.to}::timestamptz`);
    if (filter.currencies.length > 0) parts.push(Prisma.sql`r.currency = ANY(${filter.currencies}::text[])`);
    if (filter.who?.role === 'RAINER') parts.push(Prisma.sql`r.kind = 'USER'`);
    if (filter.who && filter.who.userIds.length > 0 && filter.who.group === null) {
      parts.push(
        filter.who.role === 'RAINER'
          ? Prisma.sql`r.initiator_id = ANY(${filter.who.userIds}::uuid[])`
          : Prisma.sql`EXISTS (SELECT 1 FROM rain.recipients p WHERE p.rain_id = r.id AND p.reversed_at IS NULL
              AND p.user_id = ANY(${filter.who.userIds}::uuid[]))`,
      );
    }
    const rows = await this.prisma.$queryRaw<{ currency: string; n: number; pot: string }[]>`
      SELECT r.currency, count(*)::int AS n, sum(r.pot_minor)::text AS pot
      FROM rain.runs r
      WHERE ${Prisma.join(parts, ' AND ')}
      GROUP BY r.currency
    `;
    return {
      rains: rows.reduce((total, row) => total + row.n, 0),
      potMinorByCurrency: Object.fromEntries(rows.map((row) => [row.currency, row.pot])),
    };
  }
}

