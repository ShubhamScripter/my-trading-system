// The reading side of chat: room history (newest first, or catching up after a message), pinned messages, the
// "where I was tagged" feed and a user's own warnings.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { ChatAccessService } from '../chat.access.service';
import { PAGE, TIMERS } from '../chat.constants';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatHistoryDbOperation } from '../persistence/chat.history.dboperation';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import type { ChatUserContext, Page, PublicMessage, RoomRecord, Viewer } from '../chat.types';
import * as utility from '../chat.utility';
import { assertPublicChatOpen } from './chat.availability';
import { canAct } from './chat.permissions';
import { ChatRelationsService, HIDEABLE_TYPES } from './chat.relations.service';
import { restrictionTargets } from './chat.restrictions.service';

@Injectable()
export class ChatReadService {
  constructor(
    private readonly lists: ChatHistoryDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly access: ChatAccessService,
    private readonly relations: ChatRelationsService,
    private readonly chatDb: ChatDbOperation,
  ) { }

  // Staff with "See Deleted Messages" read retracted content and anonymous authors (Module 4).
  private async viewer(user: ChatUserContext): Promise<Viewer> {
    if (!user.staffRole) return { userId: user.id, isStaff: false };
    const settings = await this.access.settingsFor(user);
    return {
      userId: user.id,
      isStaff: canAct(settings, user.staffRole, 'SEE_DELETED'),
    };
  }

  async history(
    user: ChatUserContext,
    ref: string,
    query: { limit?: number; cursor?: string; after?: string },
  ): Promise<Page<PublicMessage> & { hasMore: boolean }> {
    if (query.after && query.cursor) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'after', message: 'Use after or cursor, not both' }],
      });
    }
    assertPublicChatOpen(await this.access.settingsFor(user), false);
    const { room, access } = await this.access.assertCanView(user, ref);
    const onlyAlerts = !access.receivesUserMessages;
    const hidden = [...(await this.relations.hiddenAuthors(user.id))];
    const viewer = await this.viewer(user);
    const country = (await this.access.factsFor(user)).country;
    const limit = query.limit ?? PAGE.DEFAULT;

    if (query.after) {
      const rows = await this.lists.historyAfter(
        room.id,
        query.after,
        TIMERS.CATCH_UP_OVERLAP_MS,
        Math.min(limit, PAGE.MAX),
        onlyAlerts,
        hidden,
        country,
      );
      if (rows === null)
        throw new ProblemException({
          type: ERR.NOT_FOUND,
          detail: 'Message not found in this room',
        });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const hasMore = rows.length > limit;
      return {
        items: page.map((row) => utility.toPublicMessage(row, viewer)),
        nextCursor: hasMore && last ? last.id : null,
        hasMore,
      };
    }

    const cursor: utility.Cursor | null = query.cursor ? utility.decodeCursor(query.cursor) : null;
    const rows = await this.lists.history(room.id, limit, cursor, onlyAlerts, hidden, country);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const hasMore = rows.length > limit;
    return {
      items: page.map((row) => utility.toPublicMessage(row, viewer)),
      nextCursor:
        hasMore && last
          ? utility.encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
      hasMore,
    };
  }

  async pinned(
    user: ChatUserContext,
    ref: string,
    query: { limit?: number; cursor?: string },
  ): Promise<Page<PublicMessage>> {
    const { room, access } = await this.access.assertCanView(user, ref);
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.lists.pinned(
      room.id,
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
      !access.receivesUserMessages,
      (await this.access.factsFor(user)).country,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const viewer = await this.viewer(user);
    return {
      items: page.map((row) => utility.toPublicMessage(row, viewer)),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.pinnedAtText, id: last.id })
          : null,
    };
  }

  // The "messages where I was tagged" feed, only from rooms the reader may view now.
  async tags(user: ChatUserContext, query: { limit?: number; cursor?: string }) {
    const limit = query.limit ?? PAGE.DEFAULT;
    const { rows, scanned } = await this.lists.tagFeed(
      user.id,
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    const hasMore = scanned.length > limit;
    const scannedPage = scanned.slice(0, limit);
    const inPage = new Set(scannedPage.map((key) => key.messageId));
    const viewer = await this.viewer(user);
    const verdicts = new Map<string, { room: RoomRecord; ok: boolean }>();
    const hidden = await this.relations.hiddenAuthors(user.id);
    const items: {
      room: { id: string; slug: string; name: string };
      message: PublicMessage;
    }[] = [];
    for (const row of rows) {
      if (!inPage.has(row.id)) continue;
      if (hidden.has(row.userId) && HIDEABLE_TYPES.includes(row.type)) continue;
      let verdict = verdicts.get(row.roomId);
      if (!verdict) {
        const room = await this.access.findRoom(row.roomId);
        const access = room ? await this.access.evaluate(user, room) : null;
        verdict = room
          ? {
            room,
            ok: Boolean(access?.isEligibleToView && access.receivesUserMessages),
          }
          : undefined;
        if (verdict) verdicts.set(row.roomId, verdict);
      }
      if (!verdict?.ok) continue;
      items.push({
        room: {
          id: verdict.room.id,
          slug: verdict.room.slug,
          name: verdict.room.name,
        },
        message: utility.toPublicMessage(row, viewer),
      });
    }
    const last = scannedPage.at(-1);
    return {
      items,
      // From the last SCANNED row, so filtered rows leave no gap.
      nextCursor:
        hasMore && last
          ? utility.encodeCursor({
            createdAt: last.createdAtText,
            id: last.messageId,
          })
          : null,
      hasMore,
    };
  }

  // The user's warnings: their own, and the group warnings (Premium, KYC, level) that name them, checked here against
  // their facts. One list, newest first, one cursor.
  async warnings(user: ChatUserContext, query: { limit?: number; cursor?: string }) {
    const limit = query.limit ?? PAGE.DEFAULT;
    const cursor = query.cursor ? utility.decodeCursor(query.cursor) : null;
    const own = await this.records.warnings(user.id, limit, cursor);
    const facts = await this.access.factsFor(user);
    const now = await this.chatDb.dbNow();
    const groups = (await this.records.groupWarnings())
      .filter((rule) => restrictionTargets({ targetType: rule.target_type, targetValue: rule.target_value }, user, facts, now))
      .filter((rule) => !cursor || rule.created_at_text < cursor.createdAt || (rule.created_at_text === cursor.createdAt && rule.id < cursor.id))
      .map((rule) => ({ id: rule.id, room_id: rule.room_id, user_reason: rule.user_reason, created_at: rule.created_at, created_at_text: rule.created_at_text }));
    const rows = [...own, ...groups]
      .sort((a, b) => (a.created_at_text === b.created_at_text ? (a.id < b.id ? 1 : -1) : a.created_at_text < b.created_at_text ? 1 : -1))
      .slice(0, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      // Explicit fields; never who issued it.
      items: page.map((row) => ({
        id: row.id,
        roomId: row.room_id,
        // Only the reason meant for the user; null when the staff member gave none.
        reason: row.user_reason,
        createdAt: row.created_at.toISOString(),
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
