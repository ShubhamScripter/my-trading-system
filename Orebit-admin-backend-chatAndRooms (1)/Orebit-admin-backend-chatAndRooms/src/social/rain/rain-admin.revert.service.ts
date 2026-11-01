import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ERR } from '../../contracts';
import { ProblemException, parseDto } from '../../http';
import { ChatModerationDbOperation } from '../chat/chat-moderation.dboperation';
import {
  RainRevertFilterSchema,
  RainRevertPolicySchema,
  type RainRevertFilter,
} from './rain.contract';
import { RainAdminDbOperation, type RainRunListRow } from './rain-admin.dboperation';

const UUID = z.string().uuid();
const REASON = z.string().trim().min(3, 'A written reason of at least 3 characters is required').max(500);
const ISO = z.string().datetime({ offset: true });
const HANDLE = z.string().trim().min(1).max(64);

export const RevertOneSchema = z
  .object({ rainId: UUID, reason: REASON })
  .merge(RainRevertPolicySchema)
  .strict();

export const RevertBulkSchema = z
  .object({
    kind: z.enum(['ALL', 'SYSTEM', 'USER']).default('ALL'),
    from: ISO.nullable().default(null),
    to: ISO.nullable().default(null),
    currencies: z.array(z.string()).max(50).default([]),
    who: z
      .object({
        role: z.enum(['RAINER', 'RECIPIENT']),
        users: z.array(HANDLE).max(1000).default([]),
        group: z
          .object({ targetType: z.enum(['PREMIUM', 'KYC', 'LEVEL']), value: z.string().trim().max(16).default('') })
          .strict()
          .nullable()
          .default(null),
      })
      .strict()
      .nullable()
      .default(null),
    payerRefund: z.enum(['REFUND', 'NONE']),
    shortfall: z.enum(['ZERO', 'NEGATIVE']),
    reason: REASON,
    dryRun: z.boolean().default(false),
  })
  .strict();

@Injectable()
export class RainAdminRevertService {
  constructor(
    private readonly db: RainAdminDbOperation,
    private readonly moderation: ChatModerationDbOperation,
  ) {}

  // Reverts a specific completed rain
  async revert(body: unknown, adminId: string) {
    const dto = parseDto(RevertOneSchema, body);
    await this.requireStatus(dto.rainId, ['COMPLETED', 'PARTIALLY_REVERSED'], 'Only a paid rain can be reverted');
    const jobId = await this.db.enqueue({
      kind: 'REVERT',
      rainId: dto.rainId,
      adminId,
      reason: dto.reason ?? null,
      payerRefund: dto.payerRefund,
      shortfall: dto.shortfall,
    });
    if (!jobId) throw alreadyQueued();
    await this.record(adminId, 'RAIN_REVERT', {
      rainId: dto.rainId,
      reason: dto.reason ?? null,
      detail: { jobId, payerRefund: dto.payerRefund, shortfall: dto.shortfall },
    });
    return { queued: true, jobId };
  }

  // Reverts rains matching criteria in bulk
  async revertBulk(body: unknown, adminId: string) {
    const dto = parseDto(RevertBulkSchema, body);
    const filter: RainRevertFilter = parseDto(RainRevertFilterSchema, {
      kind: dto.kind,
      from: dto.from,
      to: dto.to,
      currencies: dto.currencies,
      who: dto.who
        ? { role: dto.who.role, userIds: await this.userIds(dto.who.users), group: dto.who.group }
        : null,
    });
    const match = await this.db.countMatching(filter);
    const covered = {
      rains: match.rains,
      potByCurrency: Object.fromEntries(
        Object.entries(match.potMinorByCurrency).map(([code, pot]) => [code, formatMinor(BigInt(pot))]),
      ),
      groupCheckedLater: filter.who?.group !== null && filter.who?.group !== undefined,
    };
    if (dto.dryRun) return { dryRun: true, filter, ...covered };
    if (match.rains === 0) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No paid rain matches this filter' });
    }
    const jobId = await this.db.enqueue({
      kind: 'REVERT',
      rainId: null,
      adminId,
      reason: dto.reason ?? null,
      payerRefund: dto.payerRefund,
      shortfall: dto.shortfall,
      filter,
    });
    if (!jobId) throw alreadyQueued();
    await this.record(adminId, 'RAIN_REVERT_BULK', {
      reason: dto.reason ?? null,
      detail: { jobId, filter, payerRefund: dto.payerRefund, shortfall: dto.shortfall, ...covered },
    });
    return { dryRun: false, queued: true, jobId, filter, ...covered };
  }

  private async requireStatus(rainId: string, statuses: readonly string[], message: string): Promise<RainRunListRow> {
    const run = await this.db.run(rainId);
    if (!run) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Rain not found' });
    if (!statuses.includes(run.status)) throw new ProblemException({ type: ERR.FORBIDDEN, detail: message });
    return run;
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

  private async userIds(handles: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const handle of handles) ids.push(await this.userId(handle));
    return [...new Set(ids)];
  }
}

function alreadyQueued(): ProblemException {
  return new ProblemException({ type: ERR.FORBIDDEN, detail: 'That action is already waiting for this rain' });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UNIT = 100_000_000n;

function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const value = negative ? -minor : minor;
  const frac = (value % UNIT).toString().padStart(8, '0').replace(/0+$/, '');
  const text = frac ? `${value / UNIT}.${frac}` : `${value / UNIT}`;
  return negative ? `-${text}` : text;
}

