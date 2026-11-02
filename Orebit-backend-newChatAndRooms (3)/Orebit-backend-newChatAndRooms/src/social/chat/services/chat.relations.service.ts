/**
 * Mute and block (Module 5): the lists, their effects, and an in-memory index that lets one broadcast skip the
 * people who do not want to see its author.
 *
 * For every ONLINE user the service holds the authors they hide (muted or blocked by them), and the reverse: for each
 * author, the online users hiding them. The gateway loads a user when their first socket connects and drops them
 * when the last one closes, so the index is exactly the connected users' lists. HTTP readers that are not connected
 * read their list through a 30-second cache.
 *
 * Ads are never hidden this way ("Ads won't be hidden even if the advertiser is blocked / muted"), nor are system
 * and admin alerts: only TEXT, MEDIA and GIFT rows are filtered.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, TIMERS } from '../chat.constants';
import { ChatBus } from '../realtime/chat.bus';
import { ChatDbOperation } from '../chat.dboperation';
import { refuse } from '../chat.moderation.service';
import { ChatSettingsService } from '../chat.settings';
import {
  ChatMuteBlockDbOperation,
  type Relation,
  type RelationList,
} from '../persistence/chat.mute-block.dboperation';
import type { ChatUserContext, MessageType, Page } from '../chat.types';
import * as utility from '../chat.utility';

/** Message types a mute or block hides. */
export const HIDEABLE_TYPES: readonly MessageType[] = ['TEXT', 'MEDIA', 'GIFT'];

@Injectable()
export class ChatRelationsService {
  private readonly logger = new Logger('ChatRelationsService');
  /** viewer → authors they hide (online viewers). */
  private readonly hidden = new Map<string, Set<string>>();
  /** author → online viewers hiding them. */
  private readonly hiders = new Map<string, Set<string>>();
  /** Offline readers (HTTP only), 30 seconds. */
  private readonly cold = new Map<string, { ids: Set<string>; at: number }>();

  constructor(
    private readonly db: ChatMuteBlockDbOperation,
    private readonly chatDb: ChatDbOperation,
    private readonly bus: ChatBus,
    private readonly settings: ChatSettingsService,
  ) {
    this.bus.subscribe((change) => {
      if (change.kind === 'relations') void this.refresh(change.userId);
    });
  }

  // The index
  /** Called when the user's first socket connects. */
  async load(userId: string): Promise<void> {
    try {
      this.index(userId, new Set(await this.db.hiddenAuthorIds(userId)));
    } catch (err: unknown) {
      this.logger.warn(
        { component: 'ChatRelationsService', err, userId },
        'could not load mute list',
      );
    }
  }

  /** Called when the user's last socket closes. */
  unload(userId: string): void {
    for (const author of this.hidden.get(userId) ?? []) {
      const viewers = this.hiders.get(author);
      viewers?.delete(userId);
      if (viewers?.size === 0) this.hiders.delete(author);
    }
    this.hidden.delete(userId);
  }

  private index(userId: string, ids: Set<string>): void {
    this.unload(userId);
    this.hidden.set(userId, ids);
    for (const author of ids) {
      let set = this.hiders.get(author);
      if (!set) {
        set = new Set();
        this.hiders.set(author, set);
      }
      set.add(userId);
    }
  }

  private async refresh(userId: string): Promise<void> {
    this.cold.delete(userId);
    if (this.hidden.has(userId)) await this.load(userId);
  }

  /** Online users who must not receive this author's public message. */
  hidersOf(authorId: string): string[] {
    return [...(this.hiders.get(authorId) ?? [])];
  }

  /** The authors this user hides, for history and the tag feed. */
  async hiddenAuthors(userId: string): Promise<ReadonlySet<string>> {
    const online = this.hidden.get(userId);
    if (online) return online;
    const cached = this.cold.get(userId);
    if (cached && Date.now() - cached.at < TIMERS.CACHE_SECONDS * 1000) return cached.ids;
    const ids = new Set(await this.db.hiddenAuthorIds(userId));
    this.cold.set(userId, { ids, at: Date.now() });
    if (this.cold.size > 10_000) this.cold.clear();
    return ids;
  }

  // Commands and HTTP
  private async target(
    user: ChatUserContext,
    handle: string,
  ): Promise<{ id: string; username: string }> {
    const id = await this.chatDb.resolvePublicUsername(handle);
    const target = id ? await this.chatDb.findChatUser(id) : null;
    if (!target)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'User not found',
      });
    if (target.id === user.id) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'userId', message: 'You cannot do this to yourself' }],
      });
    }
    return { id: target.id, username: target.username };
  }

  /** /mute, /unmute, /block, /unblock. Idempotent: `changed` says whether anything changed. */
  async set(
    user: ChatUserContext,
    handle: string,
    list: RelationList,
    on: boolean,
  ): Promise<{
    userId: string;
    username: string;
    muted?: boolean;
    blocked?: boolean;
    changed: boolean;
  }> {
    const target = await this.target(user, handle);
    let changed: boolean;
    if (on) {
      const commands = (await this.settings.global()).commands;
      const max = list === 'mutes' ? commands.maxMutes : commands.maxBlocks;
      const added = await this.db.add(list, user.id, target.id, max);
      if (added === 'FULL') {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.LIMIT_REACHED,
          `Your ${list === 'mutes' ? 'mute' : 'block'} list is full (${max}); remove someone first`,
          { list, max },
        );
      }
      changed = added === 'ADDED';
    } else {
      changed = await this.db.remove(list, user.id, target.id);
    }
    if (changed) this.bus.publish({ kind: 'relations', userId: user.id });
    return {
      userId: target.id,
      username: target.username,
      ...(list === 'mutes' ? { muted: on } : { blocked: on }),
      changed,
    };
  }

  /** /mutelist and /blocklist. */
  async list(
    user: ChatUserContext,
    list: RelationList,
    query: { limit?: number; cursor?: string },
  ): Promise<Page<{ userId: string; username: string; createdAt: string }>> {
    const limit = query.limit ?? 50;
    const rows = await this.db.list(
      list,
      user.id,
      limit,
      query.cursor ? utility.decodeCursor(query.cursor) : null,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        userId: row.userId,
        username: row.username,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? utility.encodeCursor({
              createdAt: last.createdAtText,
              id: last.userId,
            })
          : null,
    };
  }

  relation(userId: string, otherId: string): Promise<Relation> {
    return this.db.relation(userId, otherId);
  }

  blockedEitherWay(userId: string, others: readonly string[]): Promise<Set<string>> {
    return this.db.blockedEitherWay(userId, others);
  }

  /** Refuses when either user blocked the other ("they cannot DM either"). */
  async assertNotBlocked(userId: string, otherId: string, detail: string): Promise<Relation> {
    const relation = await this.db.relation(userId, otherId);
    if (relation.iBlocked || relation.blockedMe) {
      throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.BLOCKED, detail, {
        youBlocked: relation.iBlocked,
      });
    }
    return relation;
  }
}
