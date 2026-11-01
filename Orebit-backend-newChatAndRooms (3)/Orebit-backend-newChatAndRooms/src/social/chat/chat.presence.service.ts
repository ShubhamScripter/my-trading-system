import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../../redis';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { PAGE, TIMERS } from './chat.constants';
import { CHAT_REDIS_KEYS } from './chat.keys';
import { ChatDbOperation } from './chat.dboperation';
import type { ChatSocket, OnlineMember, Page } from './chat.types';

/**
 * Who is online and in which room.
 *
 * ─── One registry, in memory ──────────────────────────
 *
 * Version 1 runs exactly one chat server, so the exact answer to "who is connected" is the set of live
 * sockets in this process. This service holds it: sockets by user (the connection cap, the logout checks and
 * "online" all read it) and users by room (counts and member lists). A user goes offline only when their LAST socket
 * closes, and every user is counted once however many tabs they have.
 *
 * The Redis marker `chat:presence:<id>` exists for other readers; the maintenance tick refreshes it every minute with
 * a 150-second TTL, so after a crash every marker is gone within 2.5 minutes — no ghosts. "Last online" is the
 * database time of the last disconnect.
 */
@Injectable()
export class ChatPresenceService {
  private readonly logger = new Logger('ChatPresenceService');
  private readonly byUser = new Map<string, { sockets: Set<ChatSocket>; member: OnlineMember }>();
  private readonly byRoom = new Map<string, Map<string, number>>();
  // Caches each room's first page for 2 s to protect event loop under heavy concurrent opens (CH-021)
  private readonly firstPageCache = new Map<string, { page: Page<OnlineMember> & { count: number }; expiresAt: number }>();

  constructor(
    private readonly redis: RedisService,
    private readonly db: ChatDbOperation,
  ) {}

  // Registry
  /** Registers a socket; returns the user's sockets in connection order (oldest first). */
  add(socket: ChatSocket, member: OnlineMember): ChatSocket[] {
    const entry = this.byUser.get(member.id);
    if (entry) {
      entry.sockets.add(socket);
      entry.member = member;
      return [...entry.sockets];
    }
    this.byUser.set(member.id, { sockets: new Set([socket]), member });
    this.markOnline(member.id);
    return [socket];
  }

  /** Unregisters a socket; true when it was the user's last one (the user is now offline). */
  remove(socket: ChatSocket): boolean {
    const userId = socket.data?.user?.id;
    if (!userId) return false;
    const entry = this.byUser.get(userId);
    if (!entry || !entry.sockets.delete(socket)) return false;
    if (entry.sockets.size > 0) return false;
    this.byUser.delete(userId);
    this.markOffline(userId);
    return true;
  }

  socketsOf(userId: string): ChatSocket[] {
    return [...(this.byUser.get(userId)?.sockets ?? [])];
  }

  allSockets(): ChatSocket[] {
    const out: ChatSocket[] = [];
    for (const entry of this.byUser.values()) out.push(...entry.sockets);
    return out;
  }

  isOnline(userId: string): boolean {
    return this.byUser.has(userId);
  }

  onlineUsers(): number {
    return this.byUser.size;
  }

  socketCount(): number {
    let total = 0;
    for (const entry of this.byUser.values()) total += entry.sockets.size;
    return total;
  }

  // Rooms
  joinRoom(roomId: string, userId: string): void {
    let members = this.byRoom.get(roomId);
    if (!members) {
      members = new Map();
      this.byRoom.set(roomId, members);
    }
    members.set(userId, (members.get(userId) ?? 0) + 1);
  }

  leaveRoom(roomId: string, userId: string): void {
    const members = this.byRoom.get(roomId);
    if (!members) return;
    const count = (members.get(userId) ?? 0) - 1;
    if (count > 0) members.set(userId, count);
    else members.delete(userId);
    if (members.size === 0) this.byRoom.delete(roomId);
  }

  /** Users in the room, each counted once. */
  count(roomId: string): number {
    return this.byRoom.get(roomId)?.size ?? 0;
  }

  /** Everyone currently in the room, each once. Used by rain to pick recipients. */
  userIdsInRoom(roomId: string): string[] {
    return [...(this.byRoom.get(roomId)?.keys() ?? [])];
  }

  member(userId: string): OnlineMember | undefined {
    return this.byUser.get(userId)?.member;
  }

  roomsWithMembers(): string[] {
    return [...this.byRoom.keys()];
  }

  /**
   * One page of a room's members: sorted by username, `limit` (default 50, at most 100), an optional
   * username prefix, and an opaque cursor. Never the whole list pushed to everyone.
   */
  members(
    roomId: string,
    limit: number = PAGE.DEFAULT,
    cursor: string | null = null,
    prefix: string | null = null,
  ): Page<OnlineMember> & { count: number } {
    const isDefaultFirstPage = cursor === null && (prefix === null || prefix === '');
    if (isDefaultFirstPage && limit === PAGE.DEFAULT) {
      const cached = this.firstPageCache.get(roomId);
      if (cached && Date.now() < cached.expiresAt) return cached.page;
    }

    const ids = [...(this.byRoom.get(roomId)?.keys() ?? [])];
    const needle = prefix?.trim().toLowerCase() ?? '';
    let after: { name: string; id: string } | null = null;
    if (cursor) {
      const [name, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      if (name === undefined || !id) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          errors: [{ path: 'cursor', message: 'Not a cursor this API returned' }],
        });
      }
      after = { name, id };
    }
    const all = ids
      .map((id) => this.byUser.get(id)?.member)
      .filter((member): member is OnlineMember => member !== undefined)
      .filter((member) => needle === '' || member.username.toLowerCase().startsWith(needle))
      .sort(
        (a, b) =>
          a.username.toLowerCase().localeCompare(b.username.toLowerCase()) ||
          a.id.localeCompare(b.id),
      );
    const start = after
      ? all.findIndex((m) => {
          const name = m.username.toLowerCase();
          return name > after!.name || (name === after!.name && m.id > after!.id);
        })
      : 0;
    const page = start < 0 ? [] : all.slice(start, start + limit);
    const last = page.at(-1);
    const more = start >= 0 && start + limit < all.length;
    const result = {
      count: this.count(roomId),
      items: page,
      nextCursor:
        more && last
          ? Buffer.from(`${last.username.toLowerCase()}|${last.id}`, 'utf8').toString('base64url')
          : null,
    };
    if (isDefaultFirstPage && limit === PAGE.DEFAULT) {
      this.firstPageCache.set(roomId, { page: result, expiresAt: Date.now() + 2_000 });
    }
    return result;
  }

  // Markers and "last online"
  private markOnline(userId: string): void {
    this.redis
      .set(CHAT_REDIS_KEYS.presence(userId), '1', 'EX', TIMERS.PRESENCE_TTL_SECONDS)
      .catch(() => undefined);
    this.db.touchLastSeen(userId).catch((err: unknown) => {
      this.logger.warn(
        { component: 'ChatPresenceService', err, userId },
        'could not record last seen on connect',
      );
    });
  }

  private markOffline(userId: string): void {
    this.redis.del(CHAT_REDIS_KEYS.presence(userId)).catch(() => undefined);
    this.db.touchLastSeen(userId).catch((err: unknown) => {
      this.logger.warn(
        { component: 'ChatPresenceService', err, userId },
        'could not record last seen on disconnect',
      );
    });
  }

  // Last opened room
  /**
   * Remembers the room the user opened, in the database, so a reconnect from any device returns there.
   * Fire and forget: a failed write only means the next visit opens the admin's default room.
   */
  rememberRoom(userId: string, roomId: string): void {
    this.db.rememberLastRoom(userId, roomId).catch((err: unknown) => {
      this.logger.warn(
        { component: 'ChatPresenceService', err, userId, roomId },
        'could not save the last opened room',
      );
    });
  }

  /** The room the user last opened, or null (never stored, or the room was deleted). */
  async lastRoom(userId: string): Promise<string | null> {
    try {
      return await this.db.lastOpenedRoom(userId);
    } catch {
      return null;
    }
  }

  /** Called by the maintenance tick: one pipelined refresh of every online user's marker. */
  async refreshMarkers(): Promise<void> {
    const ids = [...this.byUser.keys()];
    for (let i = 0; i < ids.length; i += 1000) {
      const pipeline = this.redis.pipeline();
      for (const id of ids.slice(i, i + 1000)) {
        pipeline.set(CHAT_REDIS_KEYS.presence(id), '1', 'EX', TIMERS.PRESENCE_TTL_SECONDS);
      }
      await pipeline.exec();
    }
  }
}
