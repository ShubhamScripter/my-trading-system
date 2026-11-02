import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../db/client';
import { uuidv7 } from '../../utils/public.utils';
import {
  RainRevertFilterSchema,
  ManualSystemRainSchema,
  RainStatusPatchSchema,
  type RainStatusPatch,
} from './rain.contract';
import type { RecipientRule } from './rain.math';
import type {
  RainJobRow,
  RainRepeatRow,
  RainRewardsRecord,
} from './rain.types';

@Injectable()
export class RainJobsDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Claims the right to award a rain rewards once.
  async claimRewards(id: string): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE rain.runs SET rewards = '{"claimed":true}'::jsonb
      WHERE id = ${id}::uuid AND rewards IS NULL
    `;
    return count === 1;
  }

  async setRewards(id: string, rewards: RainRewardsRecord): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.runs SET rewards = ${JSON.stringify(rewards)}::jsonb WHERE id = ${id}::uuid
    `;
  }

  async markRewardsRevoked(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.runs SET rewards_revoked_at = now() WHERE id = ${id}::uuid AND rewards_revoked_at IS NULL
    `;
  }

  // Jobs
  async claimJob(): Promise<RainJobRow | null> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        kind: RainJobRow['kind'];
        rain_id: string | null;
        actor_id: string | null;
        reason: string | null;
        payer_refund: 'REFUND' | 'NONE';
        shortfall: 'ZERO' | 'NEGATIVE';
        filter: unknown;
      }[]
    >`
      UPDATE rain.jobs
      SET status = 'RUNNING', started_at = now()
      WHERE id = (
        SELECT id FROM rain.jobs
        WHERE status = 'PENDING'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, kind, rain_id, actor_id, reason, payer_refund, shortfall, filter
    `;
    const row = rows[0];
    if (!row) return null;
    const filter = row.filter === null ? null : RainRevertFilterSchema.safeParse(row.filter);
    const manualSystem = row.kind === 'MANUAL_SYSTEM' ? ManualSystemRainSchema.safeParse(row.filter) : null;
    return {
      id: row.id,
      kind: row.kind,
      rainId: row.rain_id,
      actorId: row.actor_id,
      reason: row.reason,
      payerRefund: row.payer_refund,
      shortfall: row.shortfall,
      filter: filter === null ? null : filter.success ? filter.data : null,
      manualSystem: manualSystem && manualSystem.success ? manualSystem.data : null,
    };
  }

  // Updates job progress to prevent it from being seen as stale
  async jobProgress(id: string, progress: Record<string, unknown>): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.jobs SET started_at = now(), progress = ${JSON.stringify(progress)}::jsonb
      WHERE id = ${id}::uuid AND status = 'RUNNING'
    `;
  }

  async finishJob(id: string, status: 'DONE' | 'FAILED', error: string | null): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.jobs
      SET status = ${status}, error = ${error}, finished_at = now()
      WHERE id = ${id}::uuid
    `;
  }

  async recoverStaleJobs(): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.jobs
      SET status = 'PENDING', started_at = NULL
      WHERE status = 'RUNNING' AND started_at < now() - interval '2 minutes'
    `;
  }

  // Scheduled status changes
  async claimDueStatusChange(): Promise<{ id: string; patch: RainStatusPatch | null; createdBy: string | null } | null> {
    const rows = await this.prisma.$queryRaw<{ id: string; patch: unknown; created_by: string | null }[]>`
      UPDATE rain.scheduled_changes
      SET state = 'APPLIED', applied_at = now()
      WHERE id = (
        SELECT id FROM rain.scheduled_changes
        WHERE state = 'PENDING' AND apply_at <= now()
        ORDER BY apply_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, patch, created_by
    `;
    const row = rows[0];
    if (!row) return null;
    const parsed = RainStatusPatchSchema.safeParse(row.patch);
    return { id: row.id, patch: parsed.success ? parsed.data : null, createdBy: row.created_by };
  }

  async failStatusChange(id: string, error: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.scheduled_changes SET state = 'FAILED', error = ${error} WHERE id = ${id}::uuid
    `;
  }

  // Repeats
  async claimRepeat(): Promise<RainRepeatRow | null> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        initiator_id: string;
        room_id: string;
        currency: string;
        pot_minor: bigint;
        recipient_count: number;
        recipient_rule: RecipientRule | null;
        remaining: number;
        gap_seconds: number;
      }[]
    >`
      UPDATE rain.repeats
      SET status = 'RUNNING'
      WHERE id = (
        SELECT id FROM rain.repeats
        WHERE status = 'SCHEDULED' AND next_run_at <= now()
        ORDER BY next_run_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, initiator_id, room_id, currency, pot_minor, recipient_count, recipient_rule, remaining, gap_seconds
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      initiatorId: row.initiator_id,
      roomId: row.room_id,
      currency: row.currency,
      potMinor: BigInt(row.pot_minor),
      recipientCount: row.recipient_count,
      recipientRule: row.recipient_rule,
      remaining: row.remaining,
      gapSeconds: row.gap_seconds,
    };
  }

  async scheduleRepeat(input: {
    id: string;
    initiatorId: string;
    roomId: string;
    currency: string;
    potMinor: bigint;
    recipientCount: number;
    recipientRule: RecipientRule | null;
    remaining: number;
    gapSeconds: number;
    nextRunAt: Date;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO rain.repeats (
        id, initiator_id, room_id, currency, pot_minor, recipient_count, recipient_rule, remaining,
        gap_seconds, next_run_at, status
      ) VALUES (
        ${input.id}::uuid, ${input.initiatorId}::uuid, ${input.roomId}::uuid, ${input.currency},
        ${input.potMinor.toString()}::bigint, ${input.recipientCount},
        ${input.recipientRule ? JSON.stringify(input.recipientRule) : null}::jsonb, ${input.remaining},
        ${input.gapSeconds}, ${input.nextRunAt}, 'SCHEDULED'
      )
    `;
  }

  async finishRepeat(id: string, remaining: number, nextRunAt: Date | null): Promise<void> {
    if (remaining > 0 && nextRunAt) {
      await this.prisma.$executeRaw`
        UPDATE rain.repeats
        SET status = 'SCHEDULED', remaining = ${remaining}, next_run_at = ${nextRunAt}
        WHERE id = ${id}::uuid AND status = 'RUNNING'
      `;
      return;
    }
    await this.prisma.$executeRaw`
      UPDATE rain.repeats SET status = 'DONE', remaining = 0 WHERE id = ${id}::uuid AND status = 'RUNNING'
    `;
  }

  async failRepeat(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.repeats SET status = 'FAILED' WHERE id = ${id}::uuid AND status = 'RUNNING'
    `;
  }

  async repeatsOf(userId: string): Promise<
    { id: string; currency: string; potMinor: string; remaining: number; gapSeconds: number; nextRunAt: string }[]
  > {
    const rows = await this.prisma.$queryRaw<
      { id: string; currency: string; pot_minor: bigint; remaining: number; gap_seconds: number; next_run_at: Date }[]
    >`
      SELECT id, currency, pot_minor, remaining, gap_seconds, next_run_at FROM rain.repeats
      WHERE initiator_id = ${userId}::uuid AND status IN ('SCHEDULED', 'RUNNING')
      ORDER BY next_run_at
    `;
    return rows.map((row) => ({
      id: row.id,
      currency: row.currency,
      potMinor: BigInt(row.pot_minor).toString(),
      remaining: row.remaining,
      gapSeconds: row.gap_seconds,
      nextRunAt: row.next_run_at.toISOString(),
    }));
  }

  async cancelRepeat(id: string, userId: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE rain.repeats SET status = 'CANCELLED'
      WHERE id = ${id}::uuid AND initiator_id = ${userId}::uuid AND status = 'SCHEDULED'
    `;
  }

  // Audit logging
  async audit(entry: {
    actorType: 'ADMIN' | 'STAFF' | 'USER' | 'SYSTEM';
    actorId: string | null;
    action: string;
    rainId?: string | null;
    reason?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO rain.audit_log (id, actor_type, actor_id, action, rain_id, reason, detail)
      VALUES (
        ${uuidv7()}::uuid, ${entry.actorType}, ${entry.actorId}::uuid, ${entry.action},
        ${entry.rainId ?? null}::uuid, ${entry.reason ?? null},
        ${entry.detail ? JSON.stringify(entry.detail) : null}::jsonb
      )
    `;
  }

  // System bot log records
  async botLog(
    entries: readonly { action: string; userId: string; roomId: string | null; detail: Record<string, unknown>; note?: string | null }[],
  ): Promise<void> {
    for (const entry of entries) {
      await this.prisma.$executeRaw`
        INSERT INTO chat.moderation_actions (id, actor_type, actor_id, action, target_user_id, target_room_id, new_value, note)
        VALUES (
          ${uuidv7()}::uuid, 'SYSTEM', NULL, ${entry.action}, ${entry.userId}::uuid, ${entry.roomId}::uuid,
          ${JSON.stringify(entry.detail)}::jsonb, ${entry.note ?? null}
        )
      `;
    }
  }
}

