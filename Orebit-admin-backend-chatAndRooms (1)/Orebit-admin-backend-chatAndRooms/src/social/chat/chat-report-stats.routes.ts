import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { z } from 'zod';
import { ok, parseDto, type SuccessEnvelope } from '../../http';
import { ChatReportStatsDbOperation, type ReportStats } from './persistence/chat-report-stats.dboperation';

const ReportStatsQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    /** How many reasons, reporters and reported users to list. */
    top: z.coerce.number().int().min(1).max(100).default(10),
  })
  .strict();

// Returns aggregated moderation report statistics: actioned, dismissed, top reporters, and frequent reasons.
@Injectable()
@Controller('social/chat')
export class ChatReportStatsRoutes {
  constructor(private readonly stats: ChatReportStatsDbOperation) {}

  @Get('report-stats')
  async reportStats(@Query() query: unknown): Promise<SuccessEnvelope<ReportStats & { thankYouSent: number | null }>> {
    const input = parseDto(ReportStatsQuerySchema, query);
    const stats = await this.stats.stats({ from: input.from ?? null, to: input.to ?? null, top: input.top });
    return ok({ ...stats, thankYouSent: null });
  }
}
