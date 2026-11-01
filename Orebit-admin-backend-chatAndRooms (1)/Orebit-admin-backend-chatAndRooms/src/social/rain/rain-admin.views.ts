import { z } from 'zod';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import type { RainRunListRow, RainAdminDbOperation } from './rain-admin.dboperation';

export const UUID = z.string().uuid();
export const LIMIT = z.coerce.number().int().min(1).max(200).default(50);
export const REASON = z.string().trim().min(1).max(500);
export const ISO = z.string().datetime({ offset: true });
export const HANDLE = z.string().trim().min(1).max(64);
export const RUN_STATUSES = [
  'PENDING_VERIFICATION',
  'PENDING_REVIEW',
  'COMPLETED',
  'PARTIALLY_REVERSED',
  'REVERSED',
  'REJECTED',
  'EXPIRED',
] as const;

export const SaveRainSettingsSchema = z
  .object({
    config: z.unknown(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

export const ScheduleStatusSchema = z
  .object({ applyAt: ISO, patch: z.unknown() })
  .strict();

export const ScheduledQuerySchema = z
  .object({ state: z.enum(['PENDING', 'APPLIED', 'CANCELLED', 'FAILED']).optional(), limit: LIMIT })
  .strict();

export const CancelScheduleSchema = z.object({ id: UUID }).strict();

export const RunsQuerySchema = z
  .object({
    kind: z.enum(['SYSTEM', 'USER']).optional(),
    status: z.enum(RUN_STATUSES).optional(),
    currency: z.string().trim().min(1).max(12).optional(),
    user: HANDLE.optional(),
    from: ISO.optional(),
    to: ISO.optional(),
    before: UUID.optional(),
    limit: LIMIT,
  })
  .strict();

export const RainIdSchema = z.object({ rainId: UUID }).strict();

const UNIT = 100_000_000n;

export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const value = negative ? -minor : minor;
  const frac = (value % UNIT).toString().padStart(8, '0').replace(/0+$/, '');
  const text = frac ? `${value / UNIT}.${frac}` : `${value / UNIT}`;
  return negative ? `-${text}` : text;
}

export function trimDecimal(text: string): string {
  const [whole, frac = ''] = text.split('.');
  const kept = frac.replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole!;
}

export function notInstalled(): ProblemException {
  return new ProblemException({
    type: ERR.NOT_FOUND,
    detail: 'RainPool is not installed in this database yet. Run the user backend migrations (db:migrate).',
  });
}

export function alreadyQueued(): ProblemException {
  return new ProblemException({ type: ERR.FORBIDDEN, detail: 'That action is already waiting for this rain' });
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function view(run: RainRunListRow) {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    roomId: run.roomId,
    roomName: run.roomName,
    userId: run.initiatorId,
    username: run.initiator,
    currency: run.currency,
    pot: formatMinor(run.potMinor),
    fee: formatMinor(run.feeMinor),
    distributed: formatMinor(run.distributableMinor),
    usd: run.usdValueMinor === null ? null : formatMinor(run.usdValueMinor),
    recipients: run.recipientCount || run.requestedRecipients || 0,
    recipientRule: run.recipientRule,
    repeat: run.repeatCount ? { count: run.repeatCount, gapSeconds: run.repeatGapSeconds } : null,
    reverseReason: run.reverseReason,
    reversedAt: run.reversedAt?.toISOString() ?? null,
    verifyExpiresAt: run.verifyExpiresAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

export function jobView(job: Awaited<ReturnType<RainAdminDbOperation['jobs']>>[number]) {
  return {
    id: job.id,
    kind: job.kind,
    rainId: job.rain_id,
    adminId: job.actor_id,
    reason: job.reason,
    status: job.status,
    error: job.error,
    payerRefund: job.payer_refund,
    shortfall: job.shortfall,
    filter: job.filter,
    progress: job.progress,
    createdAt: job.created_at.toISOString(),
    startedAt: job.started_at?.toISOString() ?? null,
    finishedAt: job.finished_at?.toISOString() ?? null,
  };
}

export function auditView(entry: Awaited<ReturnType<RainAdminDbOperation['auditLog']>>[number]) {
  return {
    id: entry.id,
    actorType: entry.actor_type,
    actorId: entry.actor_id,
    action: entry.action,
    rainId: entry.rain_id,
    reason: entry.reason,
    detail: entry.detail,
    createdAt: entry.created_at.toISOString(),
  };
}

