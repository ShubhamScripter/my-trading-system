// "Typing…" and read receipts of personal chat (Module 8, , , , , , , ).
// Who is told: the other active members who have the one typing/read switch on, only when the sender has it on too,
// never across a block, and in a group only while it is below the admin-set size. Membership is checked first (from the
// cached member list), then the pace; no database call is made per signal in steady state.
import { Injectable } from '@nestjs/common';
import { SERVER_EVENTS } from '../chat.constants';
import type { ChatUserContext } from '../chat.types';
import { ChatDelivery } from '../realtime/chat.delivery';
import { ChatRelationsService } from '../services/chat.relations.service';
import { DmDbOperation, type MemberRow } from './dm.dboperation';
import { DmInboxDbOperation } from './dm.inbox.dboperation';
import { requireLimit } from './dm.limits';
import { DmMessagesDbOperation } from './dm.messages.dboperation';
import { DmService } from './dm.service';

const TYPING_KEEP_MAX = 50_000;
// How long a "these two blocked each other" answer is reused by typing and read signals.
const BLOCK_KEEP_MS = 5_000;

@Injectable()
export class DmSignalsService {
  // user:conversation -> steady-clock time of the last "typing" that went out (deleted when they stop).
  private readonly typingSince = new Map<string, number>();
  private readonly blockKept = new Map<string, { blocked: boolean; at: number }>();

  constructor(
    private readonly dm: DmDbOperation,
    private readonly messagesDb: DmMessagesDbOperation,
    private readonly inbox: DmInboxDbOperation,
    private readonly relations: ChatRelationsService,
    private readonly delivery: ChatDelivery,
    private readonly messages: DmService,
  ) {}

  // Who may be told that `user` is typing or has read: the other ACTIVE members who have the switch on, never across
// a block, and nobody at all when the user turned the switch off themselves.
  private async signalRecipients(user: ChatUserContext, me: MemberRow): Promise<string[]> {
    const others = (await this.dm.members(me.conversationId, ['ACTIVE'])).filter(
      (m) => m.userId !== user.id,
    );
    if (others.length === 0) return [];
    // per-person typing and read receipts only in groups below the admin-set size; above it (or while the
    // size is unset) nobody is told.
    if (me.kind === 'GROUP') {
      const size = (await this.messages.settings()).groups.receiptGroupSize;
      if (size === null || others.length + 1 >= size) return [];
    }
    const switches = await this.inbox.receiptSwitches([user.id, ...others.map((m) => m.userId)]);
    if (!switches.get(user.id)) return [];
    const wanting = others.filter((m) => switches.get(m.userId));
    if (me.kind === 'DIRECT' && wanting[0] && (await this.pairBlocked(user.id, wanting[0].userId))) {
      return [];
    }
    return wanting.map((m) => m.userId);
  }

  // Whether either of two users blocked the other; kept a few seconds because typing asks it on every signal.
  private async pairBlocked(a: string, b: string): Promise<boolean> {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const hit = this.blockKept.get(key);
    if (hit && performance.now() - hit.at < BLOCK_KEEP_MS) return hit.blocked;
    const blocked = (await this.relations.blockedEitherWay(a, [b])).has(b);
    if (this.blockKept.size > 10_000) this.blockKept.clear();
    this.blockKept.set(key, { blocked, at: performance.now() });
    return blocked;
  }

  // "Read Receipts": the reader's position moves forward and the other members are told.
  async markRead(user: ChatUserContext, conversationId: string, messageId: string) {
    await this.messages.guard(true);
    const me = await this.messages.requireMember(user.id, conversationId);
    const readAt = await this.messagesDb.markRead(conversationId, user.id, messageId);
    if (readAt) {
      const payload = {
        conversationId,
        username: user.username,
        messageId,
        readAt: readAt.toISOString(),
      };
      this.delivery.toUser(await this.signalRecipients(user, me), SERVER_EVENTS.DM_READ, payload);
      // The reader's other devices clear their badge too.
      this.delivery.toUser(user.id, SERVER_EVENTS.DM_READ, payload);
    }
    return { conversationId, messageId, kind: me.kind, updated: readAt !== null };
  }

  // The "Typing…" indicator, to the other active members only. Membership is checked first (from the cached member
// list), and only then the 2-second limit, so random conversation ids cost nothing and fill no memory. "Stopped
// typing" is sent only after a "typing" that went out. Returns whether a signal was sent.
  async typing(user: ChatUserContext, conversationId: string, typing: boolean): Promise<boolean> {
    const settings = await this.messages.guard(true);
    const me = await this.messages.requireMember(user.id, conversationId, ['ACTIVE']);
    const key = `${user.id}:${conversationId}`;
    const last = this.typingSince.get(key);
    const now = performance.now();
    if (typing) {
      // the pace is the admin's setting, not a number in code.
      const everyMs = requireLimit(settings.dm.typingEverySeconds, 'dm.typingEverySeconds') * 1000;
      if (last !== undefined && now - last < everyMs) return false;
      if (this.typingSince.size >= TYPING_KEEP_MAX) {
        const oldest = this.typingSince.keys().next().value;
        if (oldest !== undefined) this.typingSince.delete(oldest);
      }
      this.typingSince.delete(key);
      this.typingSince.set(key, now);
    } else {
      if (last === undefined) return false;
      this.typingSince.delete(key);
    }
    const recipients = await this.signalRecipients(user, me);
    this.delivery.toUser(recipients, SERVER_EVENTS.DM_TYPING, {
      conversationId,
      username: user.username,
      typing,
    });
    return true;
  }
}
