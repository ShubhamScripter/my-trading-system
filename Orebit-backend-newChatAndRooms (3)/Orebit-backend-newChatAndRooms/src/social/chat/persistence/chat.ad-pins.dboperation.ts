// Database access for the pinned-ad queue of each room (Module 5): one row per slot of one ad in one room — QUEUED, then
// ACTIVE (start and end on the database clock), then DONE; CANCELLED when the ad is cancelled first. The database allows
// one ACTIVE slot per room (a partial unique index), so two buyers or two ticks can never show two pinned ads in a room.
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import type { Db } from './chat.sql';

export interface PlacementRecord {
  readonly id: string;
  readonly adId: string;
  readonly roomId: string;
  readonly minutes: number;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

// Queues a pinned slot (used inside the transaction that activates or resumes an ad).
export async function enqueuePin(db: Db, adId: string, roomId: string, durationSeconds: number): Promise<void> {
  const safeSeconds = Math.max(1, Math.trunc(durationSeconds));
  const minutes = Math.ceil(safeSeconds / 60);
  await db.$executeRaw`
    INSERT INTO chat.chat_ad_placements (id, ad_id, room_id, minutes, duration_seconds, status)
    VALUES (${uuidv7()}::uuid, ${adId}::uuid, ${roomId}::uuid, ${minutes}, ${safeSeconds}, 'QUEUED')
  `;
}

// Minutes of pinned time an ad has already had. The pinned minutes are charged once per ad, so the ad has had as
// many minutes as its best room gave it; rooms are not added together.
export async function pinnedSecondsUsedOf(db: Db, adId: string): Promise<number> {
  const rows = await db.$queryRaw<{ used: number | null }[]>`
    SELECT COALESCE(max(room_used), 0)::int AS used FROM (
      SELECT sum(CASE
        WHEN status = 'DONE' THEN duration_seconds
        WHEN status = 'ACTIVE' THEN LEAST(duration_seconds, floor(extract(epoch FROM (now() - starts_at))))
        ELSE 0 END) AS room_used
      FROM chat.chat_ad_placements WHERE ad_id = ${adId}::uuid GROUP BY room_id
    ) per_room
  `;
  return rows[0]?.used ?? 0;
}

@Injectable()
export class ChatAdPinsDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Takes the rooms' locks (in id order, so two buyers can never wait on each other) and returns each room's queue
// length. Held until the transaction ends, so the check and the insert of a pinned ad cannot be interleaved with
// another buyer's: a refusal always happens before any money moves.
  async lockAndCount(db: Db, roomIds: readonly string[]): Promise<Map<string, number>> {
    if (roomIds.length === 0) return new Map();
    await db.$queryRaw`
      SELECT id FROM chat.rooms WHERE id = ANY(${[...roomIds]}::uuid[]) ORDER BY id FOR UPDATE
    `;
    return this.queueLengths(roomIds, db);
  }

  // Queued plus showing, per room ("Max Pin Queue: x ADS").
  async queueLengths(roomIds: readonly string[], db: Db = this.prisma): Promise<Map<string, number>> {
    if (roomIds.length === 0) return new Map();
    const rows = await db.$queryRaw<{ room_id: string; n: number }[]>`
      SELECT room_id, count(*)::int AS n FROM chat.chat_ad_placements
      WHERE room_id = ANY(${[...roomIds]}::uuid[]) AND status IN ('QUEUED', 'ACTIVE')
      GROUP BY room_id
    `;
    return new Map(rows.map((row) => [row.room_id, row.n]));
  }

  // The pinned ad showing in a room now, with its text and badge.
  async activePin(roomId: string) {
    const rows = await this.prisma.$queryRaw<
      {
        placement_id: string;
        ad_id: string;
        creator_id: string | null;
        content: string;
        badge_id: string | null;
        skin_id: string | null;
        hidden_countries: string[];
        starts_at: Date;
        ends_at: Date;
      }[]
    >`
      SELECT p.id AS placement_id, a.id AS ad_id, a.creator_id, a.content, a.badge_id, a.skin_id, a.hidden_countries,
             p.starts_at, p.ends_at
      FROM chat.chat_ad_placements p JOIN chat.chat_ads a ON a.id = p.ad_id
      WHERE p.room_id = ${roomId}::uuid AND p.status = 'ACTIVE' AND p.ends_at > now()
      ORDER BY p.starts_at DESC LIMIT 1
    `;
    return rows[0] ?? null;
  }

  // Ends every slot whose time is up; returns them.
  async endExpiredPins(): Promise<PlacementRecord[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        ad_id: string;
        room_id: string;
        minutes: number;
        starts_at: Date;
        ends_at: Date;
      }[]
    >`
      UPDATE chat.chat_ad_placements SET status = 'DONE'
      WHERE status = 'ACTIVE' AND ends_at <= now()
      RETURNING id, ad_id, room_id, minutes, starts_at, ends_at
    `;
    return rows.map((row) => ({
      id: row.id,
      adId: row.ad_id,
      roomId: row.room_id,
      minutes: row.minutes,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    }));
  }

  async cancelledActivePins(adId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ room_id: string }[]>`
      SELECT room_id FROM chat.chat_ad_placements
      WHERE ad_id = ${adId}::uuid AND status = 'CANCELLED' AND starts_at IS NOT NULL AND ends_at > now()
    `;
    return rows.map((row) => row.room_id);
  }

  // Starts the oldest queued slot of every room with nothing showing, on the database clock. Paused or cancelled ads
// are skipped. Returns the slots started.
  async startQueuedPins(): Promise<PlacementRecord[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        ad_id: string;
        room_id: string;
        minutes: number;
        duration_seconds: number;
        starts_at: Date;
        ends_at: Date;
      }[]
    >`
      WITH next AS (
        SELECT DISTINCT ON (p.room_id) p.id
        FROM chat.chat_ad_placements p JOIN chat.chat_ads a ON a.id = p.ad_id
        WHERE p.status = 'QUEUED' AND a.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM chat.chat_ad_placements q
                          WHERE q.room_id = p.room_id AND q.status = 'ACTIVE')
        ORDER BY p.room_id, p.created_at, p.id
      )
      UPDATE chat.chat_ad_placements p
      SET status = 'ACTIVE', starts_at = now(), ends_at = now() + make_interval(secs => p.duration_seconds)
      FROM next WHERE p.id = next.id
      RETURNING p.id, p.ad_id, p.room_id, p.minutes, p.duration_seconds, p.starts_at, p.ends_at
    `;
    return rows.map((row) => ({
      id: row.id,
      adId: row.ad_id,
      roomId: row.room_id,
      minutes: row.minutes,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    }));
  }

  // Exact pinned seconds this ad has already had (for prorated refunds).
  pinnedSecondsUsed(adId: string): Promise<number> {
    return pinnedSecondsUsedOf(this.prisma, adId);
  }
}
