import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../db/client';
import { uuidv7 } from '../../utils/public.utils';
import {
  applyStatusPatch,
  RainConfigSchema,
  type RainConfig,
  type RainRevertFilter,
  type RainStatusPatch,
} from './rain.contract';
import { RainAdminRevertDbOperation } from './rain-admin.revert.dboperation';
import {
  RUN_COLUMNS,
  toRun,
  big,
  type RainJobKind,
  type RainRunListRow,
  type RunSql,
} from './rain-admin.db-types';

export type { RainJobKind, RainRunListRow };

@Injectable()
export class RainAdminDbOperation {
  private readonly revertDb: RainAdminRevertDbOperation;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() revertDb?: RainAdminRevertDbOperation,
  ) {
    this.revertDb = revertDb ?? new RainAdminRevertDbOperation(prisma);
  }

  // Returns current stored rain configuration document
  async config(): Promise<{ document: unknown; version: number; updatedAt: Date } | null> {
    const rows = await this.prisma.$queryRaw<{ document: unknown; version: number; updated_at: Date }[]>`
      SELECT document, version, updated_at FROM rain.config WHERE id = 1
    `;
    const row = rows[0];
    return row ? { document: row.document, version: row.version, updatedAt: row.updated_at } : null;
  }

  // Saves entire config document with optimistic concurrency check
  async saveConfig(document: RainConfig, expectedVersion: number | null): Promise<number | null> {
    const guard = expectedVersion === null ? Prisma.empty : Prisma.sql`AND version = ${expectedVersion}`;
    const rows = await this.prisma.$queryRaw<{ version: number }[]>`
      UPDATE rain.config
      SET document = ${JSON.stringify(document)}::jsonb, version = version + 1, updated_at = now()
      WHERE id = 1 ${guard}
      RETURNING version
    `;
    return rows[0]?.version ?? null;
  }

  // Applies status patch atomically under row lock
  async patchStatus(patch: RainStatusPatch): Promise<{ before: RainConfig['status']; after: RainConfig['status'] }> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ document: unknown }[]>`
        SELECT document FROM rain.config WHERE id = 1 FOR UPDATE
      `;
      if (!rows[0]) throw new Error('rain.config is missing; run the user backend migrations');
      const current = RainConfigSchema.parse(rows[0].document);
      const next = applyStatusPatch(current, patch);
      await tx.$executeRaw`
        UPDATE rain.config
        SET document = ${JSON.stringify(next)}::jsonb, version = version + 1, updated_at = now()
        WHERE id = 1
      `;
      return { before: current.status, after: next.status };
    });
  }

  // Resets announced next rain so scheduler re-evaluates
  async clearSchedule(): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.schedule
      SET next_rain_at = NULL, next_currency = NULL, next_pot_minor = NULL, next_pot_usd_minor = NULL, scheduled_at = NULL
      WHERE id = 1 AND (lock_until IS NULL OR lock_until < now())
    `;
  }

  // Returns next rain schedule metadata
  async schedule(): Promise<{
    nextRainAt: Date | null;
    scheduledAt: Date | null;
    currency: string | null;
    potMinor: bigint | null;
    potUsdMinor: bigint | null;
  }> {
    const rows = await this.prisma.$queryRaw<
      {
        next_rain_at: Date | null;
        scheduled_at: Date | null;
        next_currency: string | null;
        next_pot_minor: bigint | null;
        next_pot_usd_minor: bigint | null;
      }[]
    >`
      SELECT next_rain_at, scheduled_at, next_currency, next_pot_minor, next_pot_usd_minor FROM rain.schedule WHERE id = 1
    `;
    const row = rows[0];
    return {
      nextRainAt: row?.next_rain_at ?? null,
      scheduledAt: row?.scheduled_at ?? null,
      currency: row?.next_currency ?? null,
      potMinor: big(row?.next_pot_minor),
      potUsdMinor: big(row?.next_pot_usd_minor),
    };
  }

  // Returns count of pending reviews, waiting users, open jobs, and active repeats
  async counts(): Promise<{ pendingReview: number; waitingForUser: number; openJobs: number; activeRepeats: number }> {
    const rows = await this.prisma.$queryRaw<
      { pending_review: number; waiting: number; open_jobs: number; repeats: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM rain.runs WHERE status = 'PENDING_REVIEW') AS pending_review,
        (SELECT count(*)::int FROM rain.runs
           WHERE status = 'PENDING_VERIFICATION' AND security->>'stage' = 'ADMIN_REQUEST') AS waiting,
        (SELECT count(*)::int FROM rain.jobs WHERE status IN ('PENDING', 'RUNNING')) AS open_jobs,
        (SELECT count(*)::int FROM rain.repeats WHERE status IN ('SCHEDULED', 'RUNNING')) AS repeats
    `;
    const row = rows[0];
    return {
      pendingReview: row?.pending_review ?? 0,
      waitingForUser: row?.waiting ?? 0,
      openJobs: row?.open_jobs ?? 0,
      activeRepeats: row?.repeats ?? 0,
    };
  }

  // Schedules future status update
  async scheduleStatus(applyAt: string, patch: RainStatusPatch, adminId: string): Promise<string> {
    const id = uuidv7();
    await this.prisma.$executeRaw`
      INSERT INTO rain.scheduled_changes (id, apply_at, patch, created_by)
      VALUES (${id}::uuid, ${applyAt}::timestamptz, ${JSON.stringify(patch)}::jsonb, ${adminId}::uuid)
    `;
    return id;
  }

  // Cancels pending scheduled status update
  async cancelScheduledStatus(id: string): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE rain.scheduled_changes SET state = 'CANCELLED' WHERE id = ${id}::uuid AND state = 'PENDING'
    `;
    return count === 1;
  }

  // Lists scheduled status changes
  async scheduledStatus(state: string | null, limit: number) {
    const where = state ? Prisma.sql`WHERE state = ${state}` : Prisma.empty;
    return this.prisma.$queryRaw<
      {
        id: string;
        apply_at: Date;
        patch: unknown;
        state: string;
        created_by: string | null;
        created_at: Date;
        applied_at: Date | null;
        error: string | null;
      }[]
    >`
      SELECT id, apply_at, patch, state, created_by, created_at, applied_at, error
      FROM rain.scheduled_changes ${where}
      ORDER BY apply_at DESC
      LIMIT ${limit}
    `;
  }

  // Checks whether a timestamp is in the past
  async isPast(at: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ past: boolean }[]>`SELECT ${at}::timestamptz <= now() AS past`;
    return rows[0]?.past ?? true;
  }

  // Queries rain history with filters
  async runs(filter: {
    kind: 'SYSTEM' | 'USER' | null;
    statuses: string[];
    currency: string | null;
    userId: string | null;
    from: string | null;
    to: string | null;
    before: string | null;
    limit: number;
  }): Promise<RainRunListRow[]> {
    const parts: Prisma.Sql[] = [];
    if (filter.kind) parts.push(Prisma.sql`r.kind = ${filter.kind}`);
    if (filter.statuses.length > 0) parts.push(Prisma.sql`r.status = ANY(${filter.statuses}::text[])`);
    if (filter.currency) parts.push(Prisma.sql`r.currency = ${filter.currency}`);
    if (filter.userId) {
      parts.push(Prisma.sql`(r.initiator_id = ${filter.userId}::uuid OR EXISTS (
        SELECT 1 FROM rain.recipients p WHERE p.rain_id = r.id AND p.user_id = ${filter.userId}::uuid))`);
    }
    if (filter.from) parts.push(Prisma.sql`r.created_at >= ${filter.from}::timestamptz`);
    if (filter.to) parts.push(Prisma.sql`r.created_at <= ${filter.to}::timestamptz`);
    if (filter.before) parts.push(Prisma.sql`r.id < ${filter.before}::uuid`);
    const where = parts.length > 0 ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<RunSql[]>`
      SELECT ${RUN_COLUMNS}
      FROM rain.runs r
      LEFT JOIN identity.users u ON u.id = r.initiator_id
      LEFT JOIN chat.rooms m ON m.id = r.room_id
      ${where}
      ORDER BY r.id DESC
      LIMIT ${filter.limit}
    `;
    return rows.map(toRun);
  }

  // Finds a single rain run by ID
  async run(id: string): Promise<RainRunListRow | null> {
    const rows = await this.prisma.$queryRaw<RunSql[]>`
      SELECT ${RUN_COLUMNS}
      FROM rain.runs r
      LEFT JOIN identity.users u ON u.id = r.initiator_id
      LEFT JOIN chat.rooms m ON m.id = r.room_id
      WHERE r.id = ${id}::uuid
    `;
    return rows[0] ? toRun(rows[0]) : null;
  }

  // Lists recipient shares of a rain
  async recipients(rainId: string, limit: number, before: { amountMinor: string; userId: string } | null) {
    const rows = await this.prisma.$queryRaw<
      {
        user_id: string;
        username: string | null;
        amount_minor: bigint;
        tier: string;
        reversed_at: Date | null;
        reclaimed_minor: bigint | null;
      }[]
    >`
      SELECT p.user_id, u.username, p.amount_minor, p.tier, p.reversed_at, p.reclaimed_minor
      FROM rain.recipients p
      LEFT JOIN identity.users u ON u.id = p.user_id
      WHERE p.rain_id = ${rainId}::uuid
        AND (${before?.amountMinor ?? null}::numeric IS NULL OR p.amount_minor < ${before?.amountMinor ?? null}::numeric
             OR (p.amount_minor = ${before?.amountMinor ?? null}::numeric AND p.user_id > ${before?.userId ?? null}::uuid))
      ORDER BY p.amount_minor DESC, p.user_id
      LIMIT ${limit + 1}
    `;
    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      amountMinor: BigInt(row.amount_minor),
      tier: row.tier,
      reversedAt: row.reversed_at,
      reclaimedMinor: big(row.reclaimed_minor),
    }));
  }

  // Updates rain to request questionnaire or KYC verification from user
  async requestFromUser(rainId: string, security: Record<string, unknown>, ttlSeconds: number): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE rain.runs
      SET status = 'PENDING_VERIFICATION', security = ${JSON.stringify(security)}::jsonb,
          verify_expires_at = now() + make_interval(secs => ${ttlSeconds})
      WHERE id = ${rainId}::uuid AND status = 'PENDING_REVIEW'
    `;
    return count === 1;
  }

  // Queues background job for the chat worker
  async enqueue(input: {
    kind: RainJobKind;
    rainId: string | null;
    adminId: string;
    reason: string | null;
    payerRefund?: 'REFUND' | 'NONE';
    shortfall?: 'ZERO' | 'NEGATIVE';
    filter?: RainRevertFilter | null;
    manualSystem?: { currency: string; usdAmount: string; roomId: string; recipients: number } | null;
  }): Promise<string | null> {
    const id = uuidv7();
    const count = await this.prisma.$executeRaw`
      INSERT INTO rain.jobs (id, kind, rain_id, actor_id, reason, status, payer_refund, shortfall, filter)
      VALUES (
        ${id}::uuid, ${input.kind}, ${input.rainId}::uuid, ${input.adminId}::uuid, ${input.reason}, 'PENDING',
        ${input.payerRefund ?? 'REFUND'}, ${input.shortfall ?? 'ZERO'},
        ${input.manualSystem ? JSON.stringify(input.manualSystem) : input.filter ? JSON.stringify(input.filter) : null}::jsonb
      )
      ON CONFLICT DO NOTHING
    `;
    return count === 1 ? id : null;
  }

  // Checks whether a job of given kind is currently pending or running
  async openJob(kind: RainJobKind): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM rain.jobs WHERE kind = ${kind} AND status IN ('PENDING', 'RUNNING') LIMIT 1
    `;
    return rows.length > 0;
  }

  // Queries background rain jobs
  async jobs(status: string | null, limit: number) {
    const where = status ? Prisma.sql`WHERE j.status = ${status}` : Prisma.empty;
    return this.prisma.$queryRaw<
      {
        id: string;
        kind: string;
        rain_id: string | null;
        actor_id: string | null;
        reason: string | null;
        status: string;
        error: string | null;
        payer_refund: string;
        shortfall: string;
        filter: unknown;
        progress: unknown;
        created_at: Date;
        started_at: Date | null;
        finished_at: Date | null;
      }[]
    >`
      SELECT j.id, j.kind, j.rain_id, j.actor_id, j.reason, j.status, j.error, j.payer_refund, j.shortfall,
             j.filter, j.progress, j.created_at, j.started_at, j.finished_at
      FROM rain.jobs j ${where}
      ORDER BY j.created_at DESC
      LIMIT ${limit}
    `;
  }

  // Delegates countMatching to revert db operation
  async countMatching(filter: RainRevertFilter): Promise<{ rains: number; potMinorByCurrency: Record<string, string> }> {
    return this.revertDb.countMatching(filter);
  }

  // Queries auto-repeat series
  async repeats(status: string | null, userId: string | null, limit: number) {
    const parts: Prisma.Sql[] = [];
    if (status) parts.push(Prisma.sql`r.status = ${status}`);
    if (userId) parts.push(Prisma.sql`r.initiator_id = ${userId}::uuid`);
    const where = parts.length > 0 ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
    return this.prisma.$queryRaw<
      {
        id: string;
        initiator_id: string;
        username: string | null;
        room_id: string;
        currency: string;
        pot_minor: bigint;
        recipient_count: number;
        recipient_rule: unknown;
        remaining: number;
        gap_seconds: number;
        next_run_at: Date;
        status: string;
        created_at: Date;
      }[]
    >`
      SELECT r.id, r.initiator_id, u.username, r.room_id, r.currency, r.pot_minor, r.recipient_count, r.recipient_rule,
             r.remaining, r.gap_seconds, r.next_run_at, r.status, r.created_at
      FROM rain.repeats r
      LEFT JOIN identity.users u ON u.id = r.initiator_id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ${limit}
    `;
  }

  // Cancels scheduled repeat series
  async cancelRepeat(id: string): Promise<{ initiatorId: string } | null> {
    const rows = await this.prisma.$queryRaw<{ initiator_id: string }[]>`
      UPDATE rain.repeats SET status = 'CANCELLED' WHERE id = ${id}::uuid AND status = 'SCHEDULED'
      RETURNING initiator_id
    `;
    return rows[0] ? { initiatorId: rows[0].initiator_id } : null;
  }

  // Inserts admin audit record
  async audit(entry: {
    adminId: string;
    action: string;
    rainId?: string | null;
    reason?: string | null;
    detail?: unknown;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO rain.audit_log (id, actor_type, actor_id, action, rain_id, reason, detail)
      VALUES (
        ${uuidv7()}::uuid, 'ADMIN', ${entry.adminId}::uuid, ${entry.action}, ${entry.rainId ?? null}::uuid,
        ${entry.reason ?? null}, ${entry.detail === undefined ? null : JSON.stringify(entry.detail)}::jsonb
      )
    `;
  }

  // Lists rain audit log entries
  async auditLog(filter: { rainId: string | null; actorType: string | null; before: string | null; limit: number }) {
    const parts: Prisma.Sql[] = [];
    if (filter.rainId) parts.push(Prisma.sql`a.rain_id = ${filter.rainId}::uuid`);
    if (filter.actorType) parts.push(Prisma.sql`a.actor_type = ${filter.actorType}`);
    if (filter.before) parts.push(Prisma.sql`a.id < ${filter.before}::uuid`);
    const where = parts.length > 0 ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
    return this.prisma.$queryRaw<
      {
        id: string;
        actor_type: string;
        actor_id: string | null;
        action: string;
        rain_id: string | null;
        reason: string | null;
        detail: unknown;
        created_at: Date;
      }[]
    >`
      SELECT a.id, a.actor_type, a.actor_id, a.action, a.rain_id, a.reason, a.detail, a.created_at
      FROM rain.audit_log a ${where}
      ORDER BY a.id DESC
      LIMIT ${filter.limit}
    `;
  }

  // Reads development crypto rates
  async devPrices(): Promise<{ currency: string; usdPrice: string; updatedAt: Date }[]> {
    const rows = await this.prisma.$queryRaw<{ currency: string; usd_price: string; updated_at: Date }[]>`
      SELECT currency, usd_price::text AS usd_price, updated_at FROM rain.dev_prices ORDER BY currency
    `;
    return rows.map((row) => ({ currency: row.currency, usdPrice: row.usd_price, updatedAt: row.updated_at }));
  }

  // Sets or clears development crypto rate
  async setDevPrice(currency: string, usdPrice: string | null): Promise<void> {
    if (usdPrice === null) {
      await this.prisma.$executeRaw`DELETE FROM rain.dev_prices WHERE currency = ${currency}`;
      return;
    }
    await this.prisma.$executeRaw`
      INSERT INTO rain.dev_prices (currency, usd_price, updated_at)
      VALUES (${currency}, ${usdPrice}::numeric, now())
      ON CONFLICT (currency) DO UPDATE SET usd_price = EXCLUDED.usd_price, updated_at = now()
    `;
  }
}

