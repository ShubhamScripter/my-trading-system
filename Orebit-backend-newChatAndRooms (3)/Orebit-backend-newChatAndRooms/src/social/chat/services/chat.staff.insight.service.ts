/**
 * What staff may learn about one user (Module 4): "See User Stats [even if they are private]" limited to the stats
 * the role was given, and "Check Bot Log of a User" limited to the role's history days.
 */
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { CHAT_REFUSAL_REASONS, PAGE } from '../chat.constants';
import type { StaffRole } from '../chat.contract';
import type { UserStat } from '../chat.features.contract';
import { refuse } from '../chat.moderation.service';
import { ChatStaffQueueDbOperation } from '../persistence/chat.staff-queue.dboperation';
import type { ChatUserContext } from '../chat.types';
import * as utility from '../chat.utility';
import { historyDaysFor, rolePermissions } from './chat.permissions';
import { ChatStaffGate } from './chat.staff.gate';
import { ChatFeaturePorts } from '../chat.feature-ports';

@Injectable()
export class ChatStaffInsightService {
  constructor(
    private readonly gate: ChatStaffGate,
    private readonly queueDb: ChatStaffQueueDbOperation,
    private readonly ports: ChatFeaturePorts,
  ) {}

  /**
   * Chat SETTINGS "View User History: Select: All Features OR Faucet, SL… — Max Time Period History Accessible: Last x
   * Days". The history itself belongs to those features (UserHistoryPort); chat checks who may see which feature and
   * how far back.
   */
  async userHistory(
    user: ChatUserContext,
    userId: string,
    query: { feature?: string; limit?: number; cursor?: string },
  ) {
    const role = this.staffOnly(user);
    const settings = await this.gate.requireAct(user, 'VIEW_USER_HISTORY');
    const allowed = rolePermissions(settings, role)?.userHistoryFeatures ?? [];
    if (query.feature && allowed.length > 0 && !allowed.includes(query.feature)) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.PERMISSION_DENIED, 'Your chat role may not see this feature', {
        feature: query.feature,
      });
    }
    const port = this.ports.userHistory();
    if (!port) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_UNAVAILABLE,
        'User history is not available yet: no feature module provides it',
      );
    }
    const days = historyDaysFor(settings, role, 'USER_HISTORY');
    const limit = query.limit ?? PAGE.DEFAULT;
    const page = await port.history({
      userId,
      features: query.feature ? [query.feature] : allowed.length > 0 ? allowed : null,
      sinceDays: days,
      limit,
      cursor: query.cursor ?? null,
    });
    return { userId, days, features: allowed.length > 0 ? allowed : 'ALL', ...page };
  }

  private staffOnly(user: ChatUserContext): StaffRole {
    if (!user.staffRole)
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.STAFF_ONLY, 'Chat staff only');
    return user.staffRole;
  }

  /** "See User Stats [even if they are private]: Select Stats they can see". */
  async userStats(user: ChatUserContext, userId: string) {
    const role = this.staffOnly(user);
    const settings = await this.gate.requireAct(user, 'SEE_USER_STATS');
    const visible = new Set(rolePermissions(settings, role)?.visibleStats ?? []);
    const row = await this.queueDb.userStats(userId);
    const usd = (value: { toString(): string } | null) => utility.toDisplayUsd(value ?? '0');
    const all = {
      MESSAGES: { total: row.messages, last30Days: row.messages_30d },
      WARNINGS: { total: row.warnings },
      BANS: { total: row.bans, active: row.active_bans },
      REPORTS: { against: row.reports_against, made: row.reports_made },
      RESTRICTIONS: { active: row.restrictions },
      GIFTS: {
        sent: row.gifts_sent,
        received: row.gifts_received,
        sentUsd: usd(row.gifts_sent_usd),
      },
      ADS: { total: row.ads, spentUsd: usd(row.ads_usd) },
    };
    return {
      userId,
      stats: Object.fromEntries(
        Object.entries(all).filter(([key]) => visible.has(key as UserStat)),
      ),
    };
  }

  /** "Check Bot Log of a User": what auto-moderation did to them, within the role's history days. */
  async botLog(user: ChatUserContext, userId: string, query: { limit?: number; cursor?: string }) {
    const role = this.staffOnly(user);
    const settings = await this.gate.requireAct(user, 'BOT_LOG');
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.queueDb.botLog(
      userId,
      historyDaysFor(settings, role),
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      userId,
      items: page.map((r) => ({
        id: r.id,
        action: r.action,
        roomId: r.target_room_id,
        detail: r.new_value,
        note: r.note,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({
              createdAt: last.created_at_text,
              id: last.id,
            })
          : null,
    };
  }
}
