import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SYSTEM_AUTHOR_ID } from '../chat/chat.constants';
import { ChatAccessService } from '../chat/chat.access.service';
import { ChatPorts } from '../chat/chat.ports';
import { ChatModerationService } from '../chat/chat.moderation.service';
import { ChatPresenceService } from '../chat/chat.presence.service';
import { ChatRestrictionsService } from '../chat/services/chat.restrictions.service';
import type { ChatUserContext, RoomRecord } from '../chat/chat.types';
import { RainDbOperation } from './rain.dboperation';
import type { RainPerson } from './rain.math';

@Injectable()
export class RainSelectionService {
  constructor(
    private readonly db: RainDbOperation,
    private readonly presence: ChatPresenceService,
    private readonly moderation: ChatModerationService,
    private readonly access: ChatAccessService,
    private readonly restrictions: ChatRestrictionsService,
    private readonly chatPorts: ChatPorts,
  ) {}

  // Selects online room users, excluding mutes/blocks/restrictions and mutual block/mute with payer
  async eligible(room: RoomRecord, payerId: string | null, targetCount?: number): Promise<RainPerson[]> {
    const dbNow = await this.db.dbNow();
    const online = this.presence.userIdsInRoom(room.id).filter((id) => id !== payerId && id !== SYSTEM_AUTHOR_ID);
    if (online.length === 0) return [];

    const nonBlocked = online.filter((id) => !this.moderation.isBlocked(id, dbNow));
    // Shuffle candidate pool first so we only verify as many candidates as required (FR-020)
    const shuffled = targetCount != null && targetCount > 0 ? this.shuffle(nonBlocked) : nonBlocked;
    const maxNeeded = targetCount != null && targetCount > 0 ? targetCount : shuffled.length;
    const chunkSize = targetCount != null && targetCount > 0 ? Math.max(maxNeeded * 2, 50) : shuffled.length;

    const out: RainPerson[] = [];
    for (let i = 0; i < shuffled.length; i += chunkSize) {
      if (out.length >= maxNeeded) break;
      const chunk = shuffled.slice(i, i + chunkSize);
      // Batch unwanted check only for this candidate chunk, never for tens of thousands of room members at once
      const unwanted = payerId ? await this.db.unwantedBetween(payerId, chunk) : new Set<string>();

      for (const id of chunk) {
        if (out.length >= maxNeeded) break;
        if (unwanted.has(id)) continue;
        if (await this.moderation.activeBan(id, room.id, dbNow)) continue;
        const member = this.presence.member(id);
        if (!member) continue;
        const person: ChatUserContext = { id, username: member.username, publicCode: '', staffRole: null };
        const facts = await this.access.factsFor(person);
        if (await this.restrictions.find(person, facts, 'RESTRICT_RAIN_RECEIVE', room, dbNow)) continue;
        const entitled = await this.chatPorts.rainEntitlements(id);
        if (entitled && !entitled.eligible) continue;
        out.push({ id, planIds: facts.premiumPlanIds ?? [] });
      }
    }
    return out;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = randomInt(index + 1);
      const current = copy[index]!;
      copy[index] = copy[swap]!;
      copy[swap] = current;
    }
    return copy;
  }
}

