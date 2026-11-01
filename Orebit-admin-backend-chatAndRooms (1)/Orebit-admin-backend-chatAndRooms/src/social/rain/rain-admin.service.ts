import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { config as appConfig } from '../../config';
import { ERR } from '../../contracts';
import { ProblemException, parseDto } from '../../http';
import { ChatModerationDbOperation } from '../chat/chat-moderation.dboperation';
import {
  DEFAULT_RAIN_CONFIG,
  RAIN_CONTRACT_VERSION,
  RainConfigSchema,
  RainStatusPatchSchema,
  effectiveStatus,
  type RainConfig,
} from './rain.contract';
import { RainAdminDbOperation } from './rain-admin.dboperation';
import {
  RainAdminReviewService,
  ReviewSchema,
  RequestVerificationSchema,
} from './rain-admin.review.service';
import {
  RainAdminRevertService,
  RevertOneSchema,
  RevertBulkSchema,
} from './rain-admin.revert.service';
import {
  UUID,
  LIMIT,
  REASON,
  HANDLE,
  SaveRainSettingsSchema,
  ScheduleStatusSchema,
  ScheduledQuerySchema,
  CancelScheduleSchema,
  RunsQuerySchema,
  RainIdSchema,
  formatMinor,
  trimDecimal,
  notInstalled,
  alreadyQueued,
  isObject,
  view,
  jobView,
  auditView,
} from './rain-admin.views';

export {
  ReviewSchema,
  RequestVerificationSchema,
  RevertOneSchema,
  RevertBulkSchema,
  SaveRainSettingsSchema,
  ScheduleStatusSchema,
  ScheduledQuerySchema,
  CancelScheduleSchema,
  RunsQuerySchema,
  RainIdSchema,
  formatMinor,
};

export const JobsQuerySchema = z
  .object({ status: z.enum(['PENDING', 'RUNNING', 'DONE', 'FAILED']).optional(), limit: LIMIT })
  .strict();

export const RepeatsQuerySchema = z
  .object({ status: z.enum(['SCHEDULED', 'RUNNING', 'FINISHED', 'FAILED', 'CANCELLED']).optional(), user: HANDLE.optional(), limit: LIMIT })
  .strict();

export const AuditQuerySchema = z
  .object({
    rainId: UUID.optional(),
    actorType: z.enum(['ADMIN', 'STAFF', 'USER', 'SYSTEM']).optional(),
    before: UUID.optional(),
    limit: LIMIT,
  })
  .strict();

export const DevPricesSchema = z
  .object({
    prices: z
      .array(
        z.object({
          currency: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9]{2,10}$/, 'A currency code')),
          usdPrice: z.string().trim().regex(/^\d+(\.\d{1,8})?$/).nullable(),
        }).strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

@Injectable()
export class RainAdminService {
  private readonly reviewService: RainAdminReviewService;
  private readonly revertService: RainAdminRevertService;

  constructor(
    private readonly db: RainAdminDbOperation,
    private readonly moderation: ChatModerationDbOperation,
    @Optional() reviewService?: RainAdminReviewService,
    @Optional() revertService?: RainAdminRevertService,
  ) {
    this.reviewService = reviewService ?? new RainAdminReviewService(db, moderation);
    this.revertService = revertService ?? new RainAdminRevertService(db, moderation);
  }

  // Returns current settings document and metadata
  async settings() {
    const row = await this.db.config();
    const config = row ? RainConfigSchema.parse(row.document) : DEFAULT_RAIN_CONFIG;
    return {
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? new Date().toISOString(),
      contractVersion: RAIN_CONTRACT_VERSION,
      config,
    };
  }

  // Saves updated settings document
  async saveSettings(body: unknown, adminId: string) {
    const dto = parseDto(SaveRainSettingsSchema, body);
    const result = RainConfigSchema.safeParse(dto.config);
    if (!result.success) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: result.error.issues.map((i) => ({ path: ['config', ...i.path].join('.'), message: i.message })),
      });
    }
    const next = result.data;
    const current = await this.db.config();
    if (!current) throw notInstalled();
    const before = RainConfigSchema.safeParse(current.document);
    const version = await this.db.saveConfig(next, dto.expectedVersion ?? null);
    if (version === null) {
      throw new ProblemException({
        type: ERR.FORBIDDEN,
        detail: 'Another admin saved the RainPool settings in the meantime. Reload them and try again.',
      });
    }
    if (!before.success || JSON.stringify(before.data.system) !== JSON.stringify(next.system)) {
      await this.db.clearSchedule();
    }
    await this.record(adminId, 'RAIN_SETTINGS', {
      detail: { version, before: before.success ? before.data : current.document, after: next },
    });
    await this.moderation.notify({ kind: 'rain' });
    return this.settings();
  }

  // Returns current operational state and queue metrics
  async state() {
    const row = await this.db.config();
    if (!row) throw notInstalled();
    const parsed = RainConfigSchema.safeParse(row.document);
    const cfg = parsed.success ? parsed.data : DEFAULT_RAIN_CONFIG;
    const [schedule, counts] = await Promise.all([this.db.schedule(), this.db.counts()]);
    return {
      status: {
        ...cfg.status,
        effective: { system: effectiveStatus(cfg, 'system'), user: effectiveStatus(cfg, 'user') },
      },
      next: {
        at: schedule.nextRainAt?.toISOString() ?? null,
        scheduledAt: schedule.scheduledAt?.toISOString() ?? null,
        currency: schedule.currency,
        pot: schedule.potMinor === null ? null : formatMinor(schedule.potMinor),
        potUsd: schedule.potUsdMinor === null ? null : formatMinor(schedule.potUsdMinor),
      },
      ...counts,
    };
  }

  // Applies status patch immediately
  async setStatus(body: unknown, adminId: string) {
    const patch = parseDto(RainStatusPatchSchema, body);
    const { before, after } = await this.db.patchStatus(patch);
    await this.record(adminId, 'RAIN_STATUS_CHANGE', { detail: { before, after } });
    if (patch.system !== undefined) await this.db.clearSchedule();
    await this.moderation.notify({ kind: 'rain' });
    return { status: after };
  }

  // Lists scheduled future status changes
  async scheduledStatus(query: unknown) {
    const q = parseDto(ScheduledQuerySchema, query);
    const rows = await this.db.scheduledStatus(q.state ?? null, q.limit);
    return {
      changes: rows.map((r) => ({
        id: r.id,
        applyAt: r.apply_at.toISOString(),
        patch: r.patch,
        state: r.state,
        createdBy: r.created_by,
        createdAt: r.created_at.toISOString(),
        appliedAt: r.applied_at?.toISOString() ?? null,
        error: r.error,
      })),
    };
  }

  // Schedules future status change
  async scheduleStatus(body: unknown, adminId: string) {
    const dto = parseDto(ScheduleStatusSchema, body);
    const patch = parseDto(RainStatusPatchSchema, dto.patch);
    if (await this.db.isPast(dto.applyAt)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'applyAt', message: 'The scheduled time must be in the future' }],
      });
    }
    const id = await this.db.scheduleStatus(dto.applyAt, patch, adminId);
    await this.record(adminId, 'RAIN_STATUS_SCHEDULE', { detail: { id, applyAt: dto.applyAt, patch } });
    return { id, scheduled: true };
  }

  // Cancels pending scheduled status change
  async cancelScheduledStatus(body: unknown, adminId: string) {
    const { id } = parseDto(CancelScheduleSchema, body);
    const cancelled = await this.db.cancelScheduledStatus(id);
    if (!cancelled) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No pending scheduled change with that id' });
    }
    await this.record(adminId, 'RAIN_STATUS_SCHEDULE_CANCEL', { detail: { id } });
    return { id, cancelled: true };
  }

  // Lists historical rain runs
  async rains(query: unknown) {
    const q = parseDto(RunsQuerySchema, query);
    const rows = await this.db.runs({
      kind: q.kind ?? null,
      statuses: q.status ? [q.status] : [],
      currency: q.currency ?? null,
      userId: q.user ? await this.userId(q.user) : null,
      from: q.from ?? null,
      to: q.to ?? null,
      before: q.before ?? null,
      limit: q.limit,
    });
    return { rains: rows.map(view), next: rows.length === q.limit ? (rows[rows.length - 1]?.id ?? null) : null };
  }

  // Gets detail for a single rain run
  async rain(query: unknown) {
    const { rainId } = parseDto(RainIdSchema, query);
    const run = await this.db.run(rainId);
    if (!run) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Rain not found' });
    const recipients = await this.db.recipients(rainId);
    return {
      rain: {
        ...view(run),
        security: run.security,
        rewards: run.rewards,
        reverseDetail: run.reverseDetail,
        recipients: recipients.map((r) => ({
          userId: r.userId,
          username: r.username,
          amount: formatMinor(r.amountMinor),
          tier: r.tier,
          reversedAt: r.reversedAt?.toISOString() ?? null,
          reclaimed: r.reclaimedMinor !== null ? formatMinor(r.reclaimedMinor) : null,
        })),
      },
    };
  }

  // Reviews and approvals delegated to review service
  async reviews() {
    return this.reviewService.reviews();
  }

  async approve(body: unknown, adminId: string) {
    return this.reviewService.approve(body, adminId);
  }

  async reject(body: unknown, adminId: string) {
    return this.reviewService.reject(body, adminId);
  }

  async requestVerification(body: unknown, adminId: string) {
    return this.reviewService.requestVerification(body, adminId);
  }

  // Reverts delegated to revert service
  async revert(body: unknown, adminId: string) {
    return this.revertService.revert(body, adminId);
  }

  async revertBulk(body: unknown, adminId: string) {
    return this.revertService.revertBulk(body, adminId);
  }

  // Triggers one-off system rain
  async trigger(adminId: string) {
    const cfg = await this.currentConfig();
    if (effectiveStatus(cfg, 'system') !== 'ON') {
      throw new ProblemException({ type: ERR.FORBIDDEN, detail: 'Rainpool (system rains) is not ON' });
    }
    if (await this.db.openJob('MANUAL_SYSTEM')) {
      throw new ProblemException({ type: ERR.FORBIDDEN, detail: 'A Rainpool trigger is already waiting' });
    }
    return this.queue('MANUAL_SYSTEM', null, adminId, null, 'RAIN_TRIGGER');
  }

  // Queries background jobs
  async jobs(query: unknown) {
    const q = parseDto(JobsQuerySchema, query);
    return { jobs: (await this.db.jobs(q.status ?? null, q.limit)).map(jobView) };
  }

  // Lists auto-repeat series
  async repeats(query: unknown) {
    const q = parseDto(RepeatsQuerySchema, query);
    const rows = await this.db.repeats(q.status ?? null, q.user ? await this.userId(q.user) : null, q.limit);
    return {
      repeats: rows.map((row) => ({
        id: row.id,
        userId: row.initiator_id,
        username: row.username,
        roomId: row.room_id,
        currency: row.currency,
        pot: formatMinor(BigInt(row.pot_minor)),
        recipients: row.recipient_rule ?? { mode: 'SPECIFIC', count: row.recipient_count },
        remaining: row.remaining,
        gapSeconds: row.gap_seconds,
        nextRunAt: row.next_run_at.toISOString(),
        status: row.status,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  // Cancels an active auto-repeat series
  async cancelRepeat(body: unknown, adminId: string) {
    const { repeatId, reason } = parseDto(z.object({ repeatId: UUID, reason: REASON.optional() }).strict(), body);
    const cancelled = await this.db.cancelRepeat(repeatId);
    if (!cancelled) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No upcoming auto-repeat with that id' });
    }
    await this.record(adminId, 'RAIN_REPEAT_CANCEL', {
      userId: cancelled.initiatorId,
      reason: reason ?? null,
      detail: { repeatId },
    });
    return { repeatId, cancelled: true };
  }

  // Lists audit log entries
  async auditLog(query: unknown) {
    const q = parseDto(AuditQuerySchema, query);
    const rows = await this.db.auditLog({
      rainId: q.rainId ?? null,
      actorType: q.actorType ?? null,
      before: q.before ?? null,
      limit: q.limit,
    });
    return { entries: rows.map(auditView), next: rows.length === q.limit ? (rows[rows.length - 1]?.id ?? null) : null };
  }

  // Returns dev price rates
  async devPrices() {
    return {
      development: appConfig.NODE_ENV !== 'production',
      prices: (await this.db.devPrices()).map((p) => ({
        currency: p.currency,
        usdPrice: trimDecimal(p.usdPrice),
        updatedAt: p.updatedAt.toISOString(),
      })),
    };
  }

  // Sets dev crypto prices for testing
  async setDevPrices(body: unknown, adminId: string) {
    if (appConfig.NODE_ENV === 'production') {
      throw new ProblemException({
        type: ERR.FORBIDDEN,
        detail: 'Development USD rates cannot be set in production. Connect the price module instead.',
      });
    }
    const dto = parseDto(DevPricesSchema, body);
    for (const price of dto.prices) {
      if (price.usdPrice !== null && /^0+(\.0+)?$/.test(price.usdPrice)) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          errors: [{ path: 'prices', message: `${price.currency}: the price must be above zero` }],
        });
      }
      await this.db.setDevPrice(price.currency, price.usdPrice);
    }
    await this.record(adminId, 'RAIN_DEV_PRICES', { detail: { prices: dto.prices } });
    await this.moderation.notify({ kind: 'rain' });
    return this.devPrices();
  }

  async currentConfig(): Promise<RainConfig> {
    const row = await this.db.config();
    if (!row) throw notInstalled();
    const parsed = RainConfigSchema.safeParse(row.document);
    return parsed.success ? parsed.data : DEFAULT_RAIN_CONFIG;
  }

  private async queue(
    kind: 'MANUAL_SYSTEM' | 'APPROVE' | 'REJECT',
    rainId: string | null,
    adminId: string,
    reason: string | null,
    action: string,
  ) {
    const jobId = await this.db.enqueue({ kind, rainId, adminId, reason });
    if (!jobId) throw alreadyQueued();
    await this.record(adminId, action, { rainId, reason, detail: { jobId } });
    return { queued: true, jobId };
  }

  private async record(
    adminId: string,
    action: string,
    entry: { rainId?: string | null; userId?: string | null; reason?: string | null; detail?: unknown },
  ): Promise<void> {
    await this.db.audit({
      adminId,
      action,
      rainId: entry.rainId ?? null,
      reason: entry.reason ?? null,
      detail: entry.detail,
    });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action,
      targetUserId: entry.userId ?? null,
      newValue: { ...(entry.rainId ? { rainId: entry.rainId } : {}), ...(isObject(entry.detail) ? entry.detail : {}) },
      note: entry.reason ?? null,
    });
  }

  private async userId(handle: string): Promise<string> {
    const id = await this.moderation.resolveUserId(handle);
    if (!id) throw new ProblemException({ type: ERR.NOT_FOUND, detail: `User '${handle}' not found` });
    return id;
  }
}

