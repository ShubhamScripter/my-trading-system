import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../db/client';
import {
  applyStatusPatch,
  DEFAULT_RAIN_CONFIG,
  RainConfigSchema,
  type RainConfig,
  type RainRevertFilter,
  type RainStatusPatch,
} from './rain.contract';
import type { RecipientRule } from './rain.math';
import { RainHistoryDbOperation } from './rain.history.dboperation';
import { RainJobsDbOperation } from './rain.jobs.dboperation';
import { RainRevertDbOperation } from './rain.revert.dboperation';
import type {
  Db,
  NextRain,
  RainRewardsRecord,
  RainRunRow,
  RainSchedule,
  RainSecurityRecord,
  RainShareRow,
  RainStatus,
} from './rain.types';

export * from './rain.types';

const RUN_COLUMNS = Prisma.sql`
  id, kind, status, room_id, initiator_id, currency, pot_minor, fee_minor,
  distributable_minor, idempotency_key, message_id, requested_recipients, recipient_rule, repeat_count,
  repeat_gap_seconds, usd_price_minor, usd_value_minor, security, rewards, rewards_revoked_at, verify_expires_at,
  created_at
`;

interface RunSql {
  id: string;
  kind: 'SYSTEM' | 'USER';
  status: RainStatus;
  room_id: string;
  initiator_id: string | null;
  currency: string;
  pot_minor: bigint;
  fee_minor: bigint;
  distributable_minor: bigint;
  idempotency_key: string;
  message_id: string | null;
  requested_recipients: number | null;
  recipient_rule: RecipientRule | null;
  repeat_count: number | null;
  repeat_gap_seconds: number | null;
  usd_price_minor: bigint | null;
  usd_value_minor: bigint | null;
  security: RainSecurityRecord | null;
  rewards: (RainRewardsRecord & { claimed?: boolean }) | null;
  rewards_revoked_at: Date | null;
  verify_expires_at: Date | null;
  created_at: Date;
}

function big(value: bigint | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

function toRun(row: RunSql): RainRunRow {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    roomId: row.room_id,
    initiatorId: row.initiator_id,
    currency: row.currency,
    potMinor: BigInt(row.pot_minor),
    feeMinor: BigInt(row.fee_minor),
    distributableMinor: BigInt(row.distributable_minor),
    idempotencyKey: row.idempotency_key,
    messageId: row.message_id,
    requestedRecipients: row.requested_recipients,
    recipientRule: row.recipient_rule,
    repeatCount: row.repeat_count,
    repeatGapSeconds: row.repeat_gap_seconds,
    usdPriceMinor: big(row.usd_price_minor),
    usdValueMinor: big(row.usd_value_minor),
    security: row.security,
    rewards: row.rewards && 'done' in row.rewards ? row.rewards : null,
    rewardsRevokedAt: row.rewards_revoked_at,
    verifyExpiresAt: row.verify_expires_at,
    createdAt: row.created_at,
  };
}

@Injectable()
export class RainDbOperation {
  private readonly historyDb: RainHistoryDbOperation;
  private readonly jobsDb: RainJobsDbOperation;
  private readonly revertDb: RainRevertDbOperation;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() historyDb?: RainHistoryDbOperation,
    @Optional() jobsDb?: RainJobsDbOperation,
    @Optional() revertDb?: RainRevertDbOperation,
  ) {
    this.historyDb = historyDb ?? new RainHistoryDbOperation(prisma);
    this.jobsDb = jobsDb ?? new RainJobsDbOperation(prisma);
    this.revertDb = revertDb ?? new RainRevertDbOperation(prisma);
  }

  async tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  async dbNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]!.now;
  }

  async config(): Promise<RainConfig> {
    const rows = await this.prisma.$queryRaw<{ config: unknown }[]>`
      SELECT config FROM rain.config WHERE id = 1
    `;
    if (!rows[0]) return DEFAULT_RAIN_CONFIG;
    const parsed = RainConfigSchema.safeParse(rows[0].config);
    return parsed.success ? parsed.data : DEFAULT_RAIN_CONFIG;
  }

  async patchStatus(patch: RainStatusPatch): Promise<{ before: RainConfig['status']; after: RainConfig['status'] }> {
    const before = (await this.config()).status;
    const current = await this.config();
    const updated = applyStatusPatch(current, patch);
    await this.prisma.$executeRaw`
      INSERT INTO rain.config (id, config, version)
      VALUES (1, ${JSON.stringify(updated)}::jsonb, 1)
      ON CONFLICT (id) DO UPDATE SET config = ${JSON.stringify(updated)}::jsonb, version = rain.config.version + 1
    `;
    return { before, after: updated.status };
  }

  async nextRainAt(): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<{ next_rain_at: Date | null }[]>`
      SELECT next_rain_at FROM rain.schedule WHERE id = 1
    `;
    return rows[0]?.next_rain_at ?? null;
  }

  async schedule(): Promise<RainSchedule> {
    const rows = await this.prisma.$queryRaw<
      {
        next_rain_at: Date | null;
        currency: string | null;
        pot_minor: bigint | null;
        pot_usd_minor: bigint | null;
        scheduled_at: Date | null;
      }[]
    >`
      SELECT next_rain_at, currency, pot_minor, pot_usd_minor, scheduled_at FROM rain.schedule WHERE id = 1
    `;
    const row = rows[0];
    if (!row) return { nextRainAt: null, currency: null, potMinor: null, potUsdMinor: null, scheduledAt: null };
    return {
      nextRainAt: row.next_rain_at,
      currency: row.currency,
      potMinor: big(row.pot_minor),
      potUsdMinor: big(row.pot_usd_minor),
      scheduledAt: row.scheduled_at,
    };
  }

  async claimSystemLock(owner: string): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<{ next_rain_at: Date | null }[]>`
      UPDATE rain.schedule
      SET locked_by = ${owner}, locked_at = now()
      WHERE id = 1
        AND next_rain_at IS NOT NULL
        AND next_rain_at <= now()
        AND (locked_by IS NULL OR locked_at < now() - interval '2 minutes')
      RETURNING next_rain_at
    `;
    return rows[0]?.next_rain_at ?? null;
  }

  async advanceSchedule(owner: string, next: NextRain): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.schedule
      SET next_rain_at = ${next.at},
          currency = ${next.currency},
          pot_minor = ${next.potMinor?.toString() ?? null}::bigint,
          pot_usd_minor = ${next.potUsdMinor?.toString() ?? null}::bigint,
          scheduled_at = now(),
          locked_by = NULL,
          locked_at = NULL
      WHERE id = 1 AND locked_by = ${owner}
    `;
  }

  async releaseLock(owner: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.schedule SET locked_by = NULL, locked_at = NULL WHERE id = 1 AND locked_by = ${owner}
    `;
  }

  async setNextIfEmpty(next: NextRain): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE rain.schedule
      SET next_rain_at = ${next.at},
          currency = ${next.currency},
          pot_minor = ${next.potMinor?.toString() ?? null}::bigint,
          pot_usd_minor = ${next.potUsdMinor?.toString() ?? null}::bigint,
          scheduled_at = now()
      WHERE id = 1 AND (next_rain_at IS NULL OR next_rain_at < now() - interval '1 hour')
    `;
    return count > 0;
  }

  async clearSchedule(): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.schedule
      SET next_rain_at = NULL, currency = NULL, pot_minor = NULL, pot_usd_minor = NULL, scheduled_at = NULL,
          locked_by = NULL, locked_at = NULL
      WHERE id = 1
    `;
  }

  async unwantedBetween(userId: string, others: readonly string[]): Promise<Set<string>> {
    if (others.length === 0) return new Set();
    const ids = [...others];
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT target_id AS id FROM chat.user_blocks WHERE user_id = ${userId}::uuid AND removed_at IS NULL AND target_id = ANY(${ids}::uuid[])
      UNION SELECT user_id FROM chat.user_blocks WHERE target_id = ${userId}::uuid AND removed_at IS NULL AND user_id = ANY(${ids}::uuid[])
      UNION SELECT target_id FROM chat.user_mutes WHERE user_id = ${userId}::uuid AND removed_at IS NULL AND target_id = ANY(${ids}::uuid[])
      UNION SELECT user_id FROM chat.user_mutes WHERE target_id = ${userId}::uuid AND removed_at IS NULL AND user_id = ANY(${ids}::uuid[])
    `;
    return new Set(rows.map((row) => row.id));
  }

  async usernames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ id: string; username: string }[]>`
      SELECT id, username FROM identity.users WHERE id = ANY(${[...ids]}::uuid[])
    `;
    return new Map(rows.map((row) => [row.id, row.username]));
  }

  async findByKey(key: string): Promise<RainRunRow | null> {
    const rows = await this.prisma.$queryRaw<RunSql[]>`
      SELECT ${RUN_COLUMNS} FROM rain.runs WHERE idempotency_key = ${key}
    `;
    return rows[0] ? toRun(rows[0]) : null;
  }

  async findById(id: string, db: Db = this.prisma): Promise<RainRunRow | null> {
    const rows = await db.$queryRaw<RunSql[]>`
      SELECT ${RUN_COLUMNS} FROM rain.runs WHERE id = ${id}::uuid
    `;
    return rows[0] ? toRun(rows[0]) : null;
  }

  async lockRun(tx: Db, id: string): Promise<RainRunRow | null> {
    const rows = await tx.$queryRaw<RunSql[]>`
      SELECT ${RUN_COLUMNS} FROM rain.runs WHERE id = ${id}::uuid FOR UPDATE
    `;
    return rows[0] ? toRun(rows[0]) : null;
  }

  async sharesOf(rainId: string, db: Db = this.prisma): Promise<RainShareRow[]> {
    const rows = await db.$queryRaw<
      { user_id: string; amount_minor: bigint; tier: 'NORMAL' | 'PREMIUM'; reversed_at: Date | null }[]
    >`
      SELECT user_id, amount_minor, tier, reversed_at FROM rain.recipients WHERE rain_id = ${rainId}::uuid
    `;
    return rows.map((row) => ({
      userId: row.user_id,
      amount: BigInt(row.amount_minor),
      tier: row.tier,
      reversedAt: row.reversed_at,
    }));
  }

  async insertRun(
    tx: Db,
    row: {
      id: string;
      kind: 'SYSTEM' | 'USER';
      status: RainStatus;
      roomId: string;
      initiatorId: string | null;
      currency: string;
      potMinor: bigint;
      feeMinor: bigint;
      distributableMinor: bigint;
      idempotencyKey: string;
      requestedRecipients?: number | null;
      recipientRule?: RecipientRule | null;
      repeatCount?: number | null;
      repeatGapSeconds?: number | null;
      usdPriceMinor?: bigint | null;
      usdValueMinor?: bigint | null;
      security?: RainSecurityRecord | null;
      verifyExpiresAt?: Date | null;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO rain.runs (
        id, kind, status, room_id, initiator_id, currency, pot_minor, fee_minor, distributable_minor,
        idempotency_key, requested_recipients, recipient_rule, repeat_count, repeat_gap_seconds,
        usd_price_minor, usd_value_minor, security, verify_expires_at
      ) VALUES (
        ${row.id}::uuid, ${row.kind}, ${row.status}, ${row.roomId}::uuid, ${row.initiatorId ?? null}::uuid,
        ${row.currency}, ${row.potMinor.toString()}::bigint, ${row.feeMinor.toString()}::bigint,
        ${row.distributableMinor.toString()}::bigint, ${row.idempotencyKey},
        ${row.requestedRecipients ?? null}, ${row.recipientRule ? JSON.stringify(row.recipientRule) : null}::jsonb,
        ${row.repeatCount ?? null}, ${row.repeatGapSeconds ?? null},
        ${row.usdPriceMinor != null ? row.usdPriceMinor.toString() : null}::bigint,
        ${row.usdValueMinor != null ? row.usdValueMinor.toString() : null}::bigint,
        ${row.security ? JSON.stringify(row.security) : null}::jsonb,
        ${row.verifyExpiresAt ?? null}
      )
    `;
  }

  async insertShares(
    tx: Db,
    rainId: string,
    shares: readonly { userId: string; amount: bigint; tier: 'NORMAL' | 'PREMIUM' }[],
  ): Promise<void> {
    if (shares.length === 0) return;
    const sorted = [...shares].sort((a, b) => a.userId.localeCompare(b.userId));
    const userIds = sorted.map((s) => s.userId);
    const amounts = sorted.map((s) => s.amount.toString());
    const tiers = sorted.map((s) => s.tier);
    await tx.$executeRaw`
      INSERT INTO rain.recipients (rain_id, user_id, amount_minor, tier)
      SELECT ${rainId}::uuid, u::uuid, a::bigint, t::text
      FROM unnest(${userIds}::uuid[], ${amounts}::bigint[], ${tiers}::text[]) AS v(u, a, t)
      ON CONFLICT (rain_id, user_id) DO NOTHING
    `;
  }

  async settleVerified(
    tx: Db,
    id: string,
    initiatorId: string,
    currency: string,
    distributableMinor: bigint,
    shares: readonly { userId: string; amount: bigint; tier: 'NORMAL' | 'PREMIUM' }[],
    security: RainSecurityRecord,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE rain.runs
      SET status = 'COMPLETED',
          security = ${JSON.stringify(security)}::jsonb,
          verify_expires_at = NULL
      WHERE id = ${id}::uuid AND status = 'PENDING_VERIFICATION'
    `;
    await this.insertShares(tx, id, shares);
  }

  async returnToReview(tx: Db, id: string, security: RainSecurityRecord): Promise<void> {
    await tx.$executeRaw`
      UPDATE rain.runs
      SET status = 'PENDING_REVIEW', security = ${JSON.stringify(security)}::jsonb, verify_expires_at = NULL
      WHERE id = ${id}::uuid AND status = 'PENDING_VERIFICATION'
    `;
  }

  async rejectVerification(id: string, reason: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.runs
      SET status = 'REJECTED', reverse_reason = ${reason}, verify_expires_at = NULL
      WHERE id = ${id}::uuid AND status IN ('PENDING_VERIFICATION', 'PENDING_REVIEW')
    `;
  }

  async expireVerifications(): Promise<{ id: string; initiatorId: string | null }[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; initiator_id: string | null }[]>`
      UPDATE rain.runs
      SET status = 'EXPIRED', verify_expires_at = NULL
      WHERE status = 'PENDING_VERIFICATION' AND verify_expires_at <= now()
      RETURNING id, initiator_id
    `;
    return rows.map((row) => ({ id: row.id, initiatorId: row.initiator_id }));
  }

  async expireOne(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.runs SET status = 'EXPIRED', verify_expires_at = NULL WHERE id = ${id}::uuid AND status = 'PENDING_VERIFICATION'
    `;
  }

  async setMessage(id: string, messageId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rain.runs SET message_id = ${messageId}::uuid WHERE id = ${id}::uuid
    `;
  }

  async rejectReview(id: string, reason: string | null, actorId: string | null): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE rain.runs
      SET status = 'REJECTED', reverse_reason = ${reason}, reverse_detail = jsonb_build_object('rejectedBy', ${actorId}::uuid)
      WHERE id = ${id}::uuid AND status = 'PENDING_REVIEW'
    `;
    return count > 0;
  }

  takeShares(tx: Db, rainId: string, userIds: readonly string[]) {
    return this.revertDb.takeShares(tx, rainId, userIds);
  }
  setReclaimed(tx: Db, rainId: string, reclaimed: ReadonlyMap<string, bigint>) {
    return this.revertDb.setReclaimed(tx, rainId, reclaimed);
  }
  openShareCount(tx: Db, rainId: string) {
    return this.revertDb.openShareCount(tx, rainId);
  }
  markReverted(tx: Db, id: string, status: 'PARTIALLY_REVERSED' | 'REVERSED', reason: string | null, detail: Record<string, unknown>) {
    return this.revertDb.markReverted(tx, id, status, reason, detail);
  }
  rainsMatching(filter: RainRevertFilter, afterId: string | null, limit: number) {
    return this.revertDb.rainsMatching(filter, afterId, limit);
  }
  claimRewards(id: string) {
    return this.jobsDb.claimRewards(id);
  }
  setRewards(id: string, rewards: RainRewardsRecord) {
    return this.jobsDb.setRewards(id, rewards);
  }
  markRewardsRevoked(id: string) {
    return this.jobsDb.markRewardsRevoked(id);
  }
  claimJob() {
    return this.jobsDb.claimJob();
  }
  jobProgress(id: string, progress: Record<string, unknown>) {
    return this.jobsDb.jobProgress(id, progress);
  }
  finishJob(id: string, status: 'DONE' | 'FAILED', error: string | null) {
    return this.jobsDb.finishJob(id, status, error);
  }
  recoverStaleJobs() {
    return this.jobsDb.recoverStaleJobs();
  }
  claimDueStatusChange() {
    return this.jobsDb.claimDueStatusChange();
  }
  failStatusChange(id: string, error: string) {
    return this.jobsDb.failStatusChange(id, error);
  }
  claimRepeat() {
    return this.jobsDb.claimRepeat();
  }
  scheduleRepeat(input: Parameters<RainJobsDbOperation['scheduleRepeat']>[0]) {
    return this.jobsDb.scheduleRepeat(input);
  }
  finishRepeat(id: string, remaining: number, nextRunAt: Date | null) {
    return this.jobsDb.finishRepeat(id, remaining, nextRunAt);
  }
  failRepeat(id: string) {
    return this.jobsDb.failRepeat(id);
  }
  repeatsOf(userId: string) {
    return this.jobsDb.repeatsOf(userId);
  }
  cancelRepeat(id: string, userId: string) {
    return this.jobsDb.cancelRepeat(id, userId);
  }
  audit(entry: Parameters<RainJobsDbOperation['audit']>[0]) {
    return this.jobsDb.audit(entry);
  }
  botLog(entries: Parameters<RainJobsDbOperation['botLog']>[0]) {
    return this.jobsDb.botLog(entries);
  }
  recent(limit: number) {
    return this.historyDb.recent(limit);
  }
  publicHistory(limit: number) {
    return this.historyDb.publicHistory(limit);
  }
  sentBy(userId: string, limit: number) {
    return this.historyDb.sentBy(userId, limit);
  }
  receivedBy(userId: string, limit: number) {
    return this.historyDb.receivedBy(userId, limit);
  }
}
