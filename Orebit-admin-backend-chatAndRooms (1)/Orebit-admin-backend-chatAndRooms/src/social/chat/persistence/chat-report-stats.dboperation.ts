import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../db/client';

export interface ReportStats {
  // Aggregated report metrics breakdown by outcome within date range.
  readonly totals: { readonly correct: number; readonly falseReports: number; readonly reviewed: number; readonly pending: number };
  readonly byReason: { reportType: 'MESSAGE' | 'USER'; reason: string; total: number; correct: number; falseReports: number }[];
  readonly topReporters: { userId: string; username: string | null; total: number; correct: number; falseReports: number }[];
  readonly mostReported: { userId: string; username: string | null; total: number }[];
}

/**
 * The chat report statistics (Admin_Stats "Reports"): outcomes, by reason, top reporters and most reported users, read as
 * aggregates inside a date range on the created time (indexed), never by scanning rows into the server.
 */
@Injectable()
export class ChatReportStatsDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  async stats(opts: { from: string | null; to: string | null; top: number }): Promise<ReportStats> {
    const range = Prisma.sql`(${opts.from}::timestamptz IS NULL OR r.created_at >= ${opts.from}::timestamptz)
      AND (${opts.to}::timestamptz IS NULL OR r.created_at < ${opts.to}::timestamptz)`;
    const [totals] = await this.prisma.$queryRaw<{ correct: number; false_reports: number; reviewed: number; pending: number }[]>`
      SELECT count(*) FILTER (WHERE r.status = 'ACTIONED')::int AS correct,
             count(*) FILTER (WHERE r.status = 'DISMISSED')::int AS false_reports,
             count(*) FILTER (WHERE r.status = 'REVIEWED')::int AS reviewed,
             count(*) FILTER (WHERE r.status = 'PENDING')::int AS pending
      FROM chat.chat_message_reports r WHERE ${range}
    `;
    const byReason = await this.prisma.$queryRaw<{ report_type: 'MESSAGE' | 'USER'; reason: string; total: number; correct: number; false_reports: number }[]>`
      SELECT r.report_type, r.reason, count(*)::int AS total,
             count(*) FILTER (WHERE r.status = 'ACTIONED')::int AS correct,
             count(*) FILTER (WHERE r.status = 'DISMISSED')::int AS false_reports
      FROM chat.chat_message_reports r WHERE ${range}
      GROUP BY r.report_type, r.reason ORDER BY total DESC, r.report_type, r.reason LIMIT ${opts.top}
    `;
    const reporters = await this.prisma.$queryRaw<
      { user_id: string; username: string | null; total: number; correct: number; false_reports: number }[]
    >`
      SELECT r.reporter_id AS user_id, u.username, count(*)::int AS total,
             count(*) FILTER (WHERE r.status = 'ACTIONED')::int AS correct,
             count(*) FILTER (WHERE r.status = 'DISMISSED')::int AS false_reports
      FROM chat.chat_message_reports r LEFT JOIN identity.users u ON u.id = r.reporter_id
      WHERE ${range}
      GROUP BY r.reporter_id, u.username ORDER BY total DESC, r.reporter_id LIMIT ${opts.top}
    `;
    const reported = await this.prisma.$queryRaw<{ user_id: string; username: string | null; total: number }[]>`
      SELECT r.reported_user_id AS user_id, u.username, count(*)::int AS total
      FROM chat.chat_message_reports r LEFT JOIN identity.users u ON u.id = r.reported_user_id
      WHERE ${range}
      GROUP BY r.reported_user_id, u.username ORDER BY total DESC, r.reported_user_id LIMIT ${opts.top}
    `;
    return {
      totals: { correct: totals!.correct, falseReports: totals!.false_reports, reviewed: totals!.reviewed, pending: totals!.pending },
      byReason: byReason.map((row) => ({ reportType: row.report_type, reason: row.reason, total: row.total, correct: row.correct, falseReports: row.false_reports })),
      topReporters: reporters.map((row) => ({ userId: row.user_id, username: row.username, total: row.total, correct: row.correct, falseReports: row.false_reports })),
      mostReported: reported.map((row) => ({ userId: row.user_id, username: row.username, total: row.total })),
    };
  }
}
