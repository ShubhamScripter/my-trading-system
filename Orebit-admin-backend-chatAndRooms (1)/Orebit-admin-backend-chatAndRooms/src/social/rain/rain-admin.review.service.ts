import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ERR } from '../../contracts';
import { ProblemException, parseDto } from '../../http';
import { ChatModerationDbOperation } from '../chat/chat-moderation.dboperation';
import {
  DEFAULT_RAIN_CONFIG,
  RainConfigSchema,
  type RainConfig,
} from './rain.contract';
import { RainAdminDbOperation, type RainRunListRow } from './rain-admin.dboperation';

const UUID = z.string().uuid();
const REASON = z.string().trim().min(1).max(500);

// Verification window for admin verification requests (24 hours)
export const ADMIN_REQUEST_TTL_SECONDS = 24 * 60 * 60;

export const ReviewSchema = z.object({ rainId: UUID, reason: REASON.optional() }).strict();

export const RequestVerificationSchema = z
  .object({
    rainId: UUID,
    questionnaire: z.boolean().default(false),
    kyc: z.boolean().default(false),
    reason: REASON.optional(),
  })
  .strict()
  .refine((r) => r.questionnaire || r.kyc, { message: 'Ask for the questionnaire, a KYC check, or both' });

@Injectable()
export class RainAdminReviewService {
  constructor(
    private readonly db: RainAdminDbOperation,
    private readonly moderation: ChatModerationDbOperation,
  ) {}

  // Lists user rains awaiting review or user response
  async reviews() {
    const [waiting, withUser] = await Promise.all([
      this.db.runs({ kind: 'USER', statuses: ['PENDING_REVIEW'], currency: null, userId: null, from: null, to: null, before: null, limit: 200 }),
      this.db.runs({ kind: 'USER', statuses: ['PENDING_VERIFICATION'], currency: null, userId: null, from: null, to: null, before: null, limit: 200 }),
    ]);
    return {
      pendingReview: waiting.map((run) => ({ ...view(run), security: run.security })),
      waitingForUser: withUser
        .filter((run) => run.security?.stage === 'ADMIN_REQUEST')
        .map((run) => ({ ...view(run), security: run.security })),
    };
  }

  // Approves a user rain waiting for manual review
  async approve(body: unknown, adminId: string) {
    const dto = parseDto(ReviewSchema, body);
    await this.requireStatus(dto.rainId, ['PENDING_REVIEW'], 'That rain is not waiting for review');
    return this.queue('APPROVE', dto.rainId, adminId, dto.reason ?? null, 'RAIN_APPROVE');
  }

  // Rejects a user rain waiting for manual review
  async reject(body: unknown, adminId: string) {
    const dto = parseDto(ReviewSchema, body);
    await this.requireStatus(dto.rainId, ['PENDING_REVIEW'], 'That rain is not waiting for review');
    return this.queue('REJECT', dto.rainId, adminId, dto.reason ?? null, 'RAIN_REJECT');
  }

  // Requests questionnaire or KYC verification from user
  async requestVerification(body: unknown, adminId: string) {
    const dto = parseDto(RequestVerificationSchema, body);
    const run = await this.requireStatus(dto.rainId, ['PENDING_REVIEW'], 'That rain is not waiting for review');
    if (run.kind !== 'USER' || !run.initiatorId) {
      throw new ProblemException({ type: ERR.FORBIDDEN, detail: 'Only a user rain can be verified' });
    }
    const cfg = await this.currentConfig();
    const vpn = cfg.security.vpnProxy;
    if (dto.questionnaire && (vpn.questionnaire === 'OFF' || cfg.security.questions.length === 0)) {
      throw new ProblemException({
        type: ERR.FORBIDDEN,
        detail: 'The questionnaire is switched off for VPN / Proxy rains, or has no questions',
      });
    }
    if (dto.kyc && vpn.kycCheck === 'OFF') {
      throw new ProblemException({ type: ERR.FORBIDDEN, detail: 'The KYC check is switched off for VPN / Proxy rains' });
    }
    const previous = run.security ?? {};
    const security = {
      tier: typeof previous.tier === 'number' ? previous.tier : 3,
      reasons: Array.isArray(previous.reasons) ? previous.reasons : [],
      twoFa: false,
      email: false,
      require: 'ONE',
      questions: dto.questionnaire ? cfg.security.questions : [],
      kycLevel: dto.kyc ? cfg.security.kycMinLevel : null,
      manual: true,
      stage: 'ADMIN_REQUEST',
      verifiedAt: null,
      requestedBy: adminId,
      requestedAt: new Date().toISOString(),
    };
    if (!(await this.db.requestFromUser(dto.rainId, security, ADMIN_REQUEST_TTL_SECONDS))) {
      throw new ProblemException({ type: ERR.FORBIDDEN, detail: 'That rain is no longer waiting for review' });
    }
    await this.record(adminId, 'RAIN_REQUEST_VERIFICATION', {
      rainId: dto.rainId,
      userId: run.initiatorId,
      reason: dto.reason ?? null,
      detail: { rainId: dto.rainId, questionnaire: dto.questionnaire, kyc: dto.kyc },
    });
    await this.moderation.notify({ kind: 'rain_request', userId: run.initiatorId, rainId: dto.rainId });
    return { rainId: dto.rainId, status: 'PENDING_VERIFICATION', questionnaire: dto.questionnaire, kyc: dto.kyc };
  }

  private async requireStatus(rainId: string, statuses: readonly string[], message: string): Promise<RainRunListRow> {
    const run = await this.db.run(rainId);
    if (!run) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Rain not found' });
    if (!statuses.includes(run.status)) throw new ProblemException({ type: ERR.FORBIDDEN, detail: message });
    return run;
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

  private async currentConfig(): Promise<RainConfig> {
    const row = await this.db.config();
    if (!row) throw notInstalled();
    const parsed = RainConfigSchema.safeParse(row.document);
    return parsed.success ? parsed.data : DEFAULT_RAIN_CONFIG;
  }
}

function alreadyQueued(): ProblemException {
  return new ProblemException({ type: ERR.FORBIDDEN, detail: 'That action is already waiting for this rain' });
}

function notInstalled(): ProblemException {
  return new ProblemException({
    type: ERR.NOT_FOUND,
    detail: 'RainPool is not installed in this database yet. Run the user backend migrations (db:migrate).',
  });
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

function view(run: RainRunListRow) {
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

