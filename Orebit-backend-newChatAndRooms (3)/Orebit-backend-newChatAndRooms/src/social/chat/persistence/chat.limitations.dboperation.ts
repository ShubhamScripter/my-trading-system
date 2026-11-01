import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';
import type { Cursor } from '../chat.utility';

// One thing that limits the caller: a ban, a restriction, a refused or cancelled ad, a reverted gift.
export interface LimitationRow {
  readonly id: string;
  readonly kind: string;
  readonly room_id: string | null;
  readonly starts_at: Date;
  readonly starts_at_text: string;
  readonly ends_at: Date | null;
  readonly status: string;
  readonly user_reason: string | null;
}

const LIVE = Prisma.sql`now()`;

// The caller's own limitations, read from the tables that hold them. Explicit columns only: never who issued
// a record and never the internal reason. Time is the database's.
@Injectable()
export class ChatLimitationsDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    opts: { limit: number; cursor: Cursor | null; from: string | null; to: string | null },
  ): Promise<LimitationRow[]> {
    const after = opts.cursor
      ? Prisma.sql`AND (starts_at, id) < (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`
      : Prisma.empty;
    const from = opts.from ? Prisma.sql`AND starts_at >= ${opts.from}::timestamptz` : Prisma.empty;
    const to = opts.to ? Prisma.sql`AND starts_at < ${opts.to}::timestamptz` : Prisma.empty;
    return this.prisma.$queryRaw<LimitationRow[]>`
      SELECT id, kind, room_id, starts_at, to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at_text,
             ends_at, status, user_reason
      FROM (
        SELECT id, 'BAN' AS kind, room_id, banned_at AS starts_at, expires_at AS ends_at,
               CASE WHEN is_active AND (expires_at IS NULL OR expires_at > ${LIVE}) THEN 'ACTIVE'
                    WHEN lifted_at IS NOT NULL THEN 'LIFTED' ELSE 'ENDED' END AS status, user_reason
        FROM chat.user_bans WHERE user_id = ${userId}::uuid
        UNION ALL
        SELECT id, kind, room_id, created_at, expires_at,
               CASE WHEN lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ${LIVE}) THEN 'ACTIVE'
                    WHEN lifted_at IS NOT NULL THEN 'LIFTED' ELSE 'ENDED' END, user_reason
        FROM chat.user_restrictions WHERE target_type = 'USER' AND target_value = ${userId}
        UNION ALL
        SELECT id, 'AD_' || status, NULL::uuid, created_at, NULL::timestamptz, status, NULL::text
        FROM chat.chat_ads WHERE creator_id = ${userId}::uuid AND status IN ('FAILED', 'CANCELLED', 'REFUNDED')
        UNION ALL
        SELECT id, 'GIFT_REVERTED', room_id, reverted_at, NULL::timestamptz, 'REVERTED', NULL::text
        FROM chat.gift_transfers WHERE sender_id = ${userId}::uuid AND status = 'REVERTED' AND reverted_at IS NOT NULL
      ) t
      WHERE true ${after} ${from} ${to}
      ORDER BY starts_at DESC, id DESC
      LIMIT ${opts.limit + 1}
    `;
  }
}
