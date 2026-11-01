// Restrictions on users and groups of users (Chat SETTINGS "Restrict a Specific User / Group of Users [Premium, Lvl,
// KYC OR Select Users]"), from two places:
// - the room config's `userRestrictions` (set by an admin per room), and
// - chat.user_restrictions (chat-wide or one room; set by staff from the app or by an admin).
// The table's live rows are few, so they are held in memory: reloaded every 30 seconds and at once when a
// `restrictions` change is published (a staff action here, or the admin signal). A send never queries for them.
import { Injectable, Logger } from '@nestjs/common';
import { ChatBus } from '../realtime/chat.bus';
import { TIMERS } from '../chat.constants';
import type { RestrictionKind, RestrictionTarget } from '../chat.contract';
import {
  ChatStaffDbOperation,
  type RestrictionRecord,
} from '../persistence/chat.staff.dboperation';
import type { ChatUserContext, EligibilityFacts, RoomRecord } from '../chat.types';

// Said to a refused user when the restriction carries no reason of its own for them (the internal one never leaves).
export const RESTRICTED_FOR_YOU = 'This action is restricted for you';

// What a matching restriction tells the refused user.
export interface ActiveRestriction {
  readonly kind: RestrictionKind;
  // The reason meant for the user: the restriction's user reason, or a plain sentence. Never the internal reason.
  readonly reason: string;
  readonly expiresAt: string | null;
  readonly source: 'ROOM' | 'CHAT';
  readonly id: string | null;
}

interface RestrictionLike {
  readonly targetType: RestrictionTarget;
  readonly targetValue: string;
  readonly expiresAt?: string | Date | null;
}

// Whether a restriction targets this user at the database time `dbNow`. Pure.
export function restrictionTargets(
  restriction: RestrictionLike,
  user: ChatUserContext,
  facts: EligibilityFacts,
  dbNow: Date,
): boolean {
  const expiresAt = restriction.expiresAt ? new Date(restriction.expiresAt).getTime() : null;
  if (expiresAt !== null && expiresAt <= dbNow.getTime()) return false;
  switch (restriction.targetType) {
    case 'USER': {
      // By id only: a name or a login code is resolved to the id when the restriction is saved, so a rename never moves
      // a restriction to the next person who takes the name.
      return restriction.targetValue.trim().toLowerCase() === user.id;
    }
    case 'PREMIUM':
      return (facts.premiumPlanIds?.length ?? 0) > 0;
    case 'KYC':
      return (facts.kycLevel ?? 0) >= 1;
    case 'LEVEL': {
      const min = Number(restriction.targetValue);
      return Number.isFinite(min) && facts.level !== null && facts.level >= min;
    }
    default:
      return false;
  }
}

// RESTRICT_COMMANDS with no list takes every command away.
function coversCommand(
  commands: readonly string[] | undefined,
  command: string | undefined,
): boolean {
  if (command === undefined) return true;
  return !commands || commands.length === 0 || commands.includes(command);
}

// Live rows by the user they name, and the rows that name a group: a check looks at those two, never at every row.
function indexOf(rows: readonly RestrictionRecord[]): { byUser: Map<string, RestrictionRecord[]>; groups: RestrictionRecord[] } {
  const byUser = new Map<string, RestrictionRecord[]>();
  const groups: RestrictionRecord[] = [];
  for (const r of rows) {
    if (r.targetType !== 'USER') {
      groups.push(r);
      continue;
    }
    const key = r.targetValue.trim().toLowerCase();
    const list = byUser.get(key);
    if (list) list.push(r);
    else byUser.set(key, [r]);
  }
  return { byUser, groups };
}

@Injectable()
export class ChatRestrictionsService {
  private readonly logger = new Logger('ChatRestrictionsService');
  private cache: { rows: RestrictionRecord[]; byUser: Map<string, RestrictionRecord[]>; groups: RestrictionRecord[]; at: number } | null = null;
  private loading: Promise<RestrictionRecord[]> | null = null;

  constructor(
    private readonly db: ChatStaffDbOperation,
    private readonly bus: ChatBus,
  ) {
    this.bus.subscribe((change) => {
      if (change.kind === 'restrictions') this.cache = null;
    });
  }

  // The rows that can touch one user: the ones naming them, and the group rows (Premium, KYC, level).
  private async candidates(userId: string): Promise<RestrictionRecord[]> {
    await this.rows();
    const c = this.cache;
    if (!c) return [];
    return [...(c.byUser.get(userId) ?? []), ...c.groups];
  }

  private async rows(): Promise<RestrictionRecord[]> {
    if (this.cache && Date.now() - this.cache.at < TIMERS.CACHE_SECONDS * 1000)
      return this.cache.rows;
    if (!this.loading) {
      this.loading = this.db
        .activeRestrictions()
        .then((rows) => {
          this.cache = { rows, ...indexOf(rows), at: Date.now() };
          return rows;
        })
        .catch((err: unknown) => {
          // Keep the last known list rather than lifting every restriction on a database hiccup.
          this.logger.warn(
            { component: 'ChatRestrictionsService', err },
            'could not reload restrictions',
          );
          return this.cache?.rows ?? [];
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  // The first restriction of `kind` on this user: the room's own list, then chat-wide and room rows from the table.
// `room` null = outside public rooms (DMs, gifts in DMs): only chat-wide rows apply.
  async find(
    user: ChatUserContext,
    facts: EligibilityFacts,
    kind: RestrictionKind,
    room: RoomRecord | null,
    dbNow: Date,
    command?: string,
  ): Promise<ActiveRestriction | null> {
    if (room) {
      for (const r of room.config.userRestrictions) {
        if (r.restriction !== kind) continue;
        if (kind === 'RESTRICT_COMMANDS' && !coversCommand(r.commands, command)) continue;
        if (restrictionTargets(r, user, facts, dbNow)) {
          return {
            kind,
            reason: r.userReason ?? RESTRICTED_FOR_YOU,
            expiresAt: r.expiresAt ?? null,
            source: 'ROOM',
            id: null,
          };
        }
      }
    }
    for (const r of await this.candidates(user.id)) {
      if (r.kind !== kind) continue;
      if (r.roomId !== null && r.roomId !== room?.id) continue;
      if (kind === 'RESTRICT_COMMANDS' && !coversCommand(r.commands, command)) continue;
      if (restrictionTargets(r, user, facts, dbNow)) {
        return {
          kind,
          reason: r.userReason ?? RESTRICTED_FOR_YOU,
          expiresAt: r.expiresAt?.toISOString() ?? null,
          source: 'CHAT',
          id: r.id,
        };
      }
    }
    return null;
  }

  // Live chat-wide and room rows naming this user (for the staff penalties view).
  async forUser(userId: string): Promise<RestrictionRecord[]> {
    await this.rows();
    return this.cache?.byUser.get(userId) ?? [];
  }

  // Every live row, for the staff penalties view.
  async all(): Promise<RestrictionRecord[]> {
    return this.rows();
  }

  invalidate(): void {
    this.cache = null;
  }
}
