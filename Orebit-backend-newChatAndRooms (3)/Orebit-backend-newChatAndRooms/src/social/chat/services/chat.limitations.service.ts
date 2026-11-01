import { Injectable } from '@nestjs/common';
import { PAGE } from '../chat.constants';
import type { ChatUserContext } from '../chat.types';
import * as utility from '../chat.utility';
import { ChatLimitationsDbOperation } from '../persistence/chat.limitations.dboperation';

// what limits a user, read by that user (their Limitations page) and by Support to pre-fill an appeal. A banned
// user can read it. Only the caller's own records; never who issued one; only the user reason.
@Injectable()
export class ChatLimitationsService {
  constructor(private readonly db: ChatLimitationsDbOperation) {}

  async list(
    user: ChatUserContext,
    query: { limit?: number; cursor?: string; from?: string; to?: string },
  ) {
    const limit = query.limit ?? PAGE.DEFAULT;
    const rows = await this.db.list(user.id, {
      limit,
      cursor: query.cursor ? utility.decodeCursor(query.cursor) : null,
      from: query.from ?? null,
      to: query.to ?? null,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        roomId: row.room_id,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at?.toISOString() ?? null,
        status: row.status,
        reason: row.user_reason,
      })),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({ createdAt: last.starts_at_text, id: last.id })
          : null,
    };
  }
}
