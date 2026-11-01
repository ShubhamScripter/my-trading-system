import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Server } from 'socket.io';
import { SERVER_EVENTS, TIMERS, personalRoom, socketRoom } from '../chat.constants';
import { ChatPresenceService } from '../chat.presence.service';
import { broadcastView } from '../chat.utility';
import type { MessageRow, PublicMessage } from '../chat.types';
import { ChatRelationsService, HIDEABLE_TYPES } from '../services/chat.relations.service';

// The channel a promo-only viewer is in: alerts only, never user messages.
export const promoRoom = (roomId: string): string => `${socketRoom(roomId)}:promo`;

// The channel of the sockets in one room whose country is `country`. An ad hidden from a country is sent to the
// room's channels EXCEPT that country's channel, so delivery costs one emit however many sockets are connected, not a
// pass over every socket per ad.
export const countryRoom = (roomId: string, country: string): string =>
  `${socketRoom(roomId)}:country:${country}`;

interface QueuedMessage {
  view: PublicMessage;
  hiders: readonly string[];
}

interface RoomTraffic {
  times: number[];
  queue: QueuedMessage[];
  timer: NodeJS.Timeout | null;
}

// The one way anything reaches open chats: the gateway, the HTTP controller and alerts all publish here.
// - Always to the resolved room id; user messages only to full viewers, alerts to promo-only viewers too.
// - A room receiving more than 10 messages a second switches to `new_messages` frames every 100 ms or at 50.
// - Online counts go to a room at most once a second, as a volatile emit, never the member list.
// - Tags and moderation notes go only to the user concerned, on their own channel.
// - A user's message skips everyone online who muted or blocked its author (Module 5); ads and alerts never do.
// - Ads reach promo-only viewers too, and skip viewers in the ad's hidden countries.
@Injectable()
export class ChatDelivery implements OnModuleDestroy {
  private server: Server | null = null;
  private readonly traffic = new Map<string, RoomTraffic>();
  private readonly countTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly presence: ChatPresenceService,
    private readonly relations: ChatRelationsService,
  ) { }

  // Called by the gateway once Socket.IO is up.
  attach(server: Server): void {
    this.server = server;
  }

  onModuleDestroy(): void {
    for (const timer of this.countTimers.values()) clearTimeout(timer);
    for (const room of this.traffic.values()) if (room.timer) clearTimeout(room.timer);
  }

  publish(row: MessageRow): void {
    const server = this.server;
    if (!server) return;
    const view = broadcastView(row);
    if (row.type === 'AD') {
      this.publishAd(row, view);
      return;
    }
    const isAlert = row.type === 'SYSTEM_ALERT' || row.type === 'ADMIN_ALERT';
    if (isAlert) server.to(promoRoom(row.roomId)).emit(SERVER_EVENTS.NEW_MESSAGE, view);

    // Muted or blocked by someone online: tagged and queued without bypassing grouping (FR-010)
    const hiders = HIDEABLE_TYPES.includes(row.type) ? this.relations.hidersOf(row.userId) : [];
    const item: QueuedMessage = { view, hiders };

    const now = Date.now();
    let traffic = this.traffic.get(row.roomId);
    if (!traffic) {
      traffic = { times: [], queue: [], timer: null };
      this.traffic.set(row.roomId, traffic);
    }
    traffic.times = traffic.times.filter((t) => now - t < 1000);
    traffic.times.push(now);

    if (traffic.queue.length === 0 && traffic.times.length <= TIMERS.BUSY_ROOM_PER_SECOND) {
      if (hiders.length > 0) {
        server
          .to(socketRoom(row.roomId))
          .except(hiders.map(personalRoom))
          .emit(SERVER_EVENTS.NEW_MESSAGE, view);
      } else {
        server.to(socketRoom(row.roomId)).emit(SERVER_EVENTS.NEW_MESSAGE, view);
      }
      return;
    }
    traffic.queue.push(item);
    if (traffic.queue.length >= TIMERS.GROUP_MAX_MESSAGES) this.flush(row.roomId);
    else if (!traffic.timer) {
      traffic.timer = setTimeout(() => this.flush(row.roomId), TIMERS.GROUP_FLUSH_MS);
      traffic.timer.unref();
    }
  }

  private flush(roomId: string): void {
    const traffic = this.traffic.get(roomId);
    if (!traffic) return;
    if (traffic.timer) clearTimeout(traffic.timer);
    traffic.timer = null;
    const batch = traffic.queue;
    traffic.queue = [];
    if (batch.length === 0 || !this.server) return;

    // Group queued messages by distinct hider sets to preserve ordering and batching (FR-010)
    const groups = new Map<string, { hiders: readonly string[]; views: PublicMessage[] }>();
    for (const item of batch) {
      const key = item.hiders.length > 0 ? [...item.hiders].sort().join(',') : '';
      let group = groups.get(key);
      if (!group) {
        group = { hiders: item.hiders, views: [] };
        groups.set(key, group);
      }
      group.views.push(item.view);
    }

    for (const group of groups.values()) {
      if (group.hiders.length > 0) {
        this.server
          .to(socketRoom(roomId))
          .except(group.hiders.map(personalRoom))
          .emit(SERVER_EVENTS.NEW_MESSAGES, group.views);
      } else {
        this.server.to(socketRoom(roomId)).emit(SERVER_EVENTS.NEW_MESSAGES, group.views);
      }
    }
  }

  // An ad: every viewer of the room, promo-only ones included, except those in its hidden countries.
  private publishAd(row: MessageRow, view: PublicMessage): void {
    const hidden = row.metadata.ad?.hiddenCountries ?? [];
    if (hidden.length === 0) {
      this.server
        ?.to([socketRoom(row.roomId), promoRoom(row.roomId)])
        .emit(SERVER_EVENTS.NEW_MESSAGE, view);
      return;
    }
    this.server
      ?.to([socketRoom(row.roomId), promoRoom(row.roomId)])
      .except(hidden.map((country) => countryRoom(row.roomId, country)))
      .emit(SERVER_EVENTS.NEW_MESSAGE, view);
  }

  notifyTagged(row: MessageRow, userIds: readonly string[]): void {
    if (userIds.length === 0) return;
    const hiders = new Set(this.relations.hidersOf(row.userId));
    const targets = userIds.filter((id) => !hiders.has(id));
    if (targets.length === 0) return;
    this.server?.to(targets.map(personalRoom)).emit(SERVER_EVENTS.USER_TAGGED, {
      roomId: row.roomId,
      messageId: row.id,
      message: broadcastView(row),
    });
  }

  // The room event of a retraction carries no actor and no note.
  publishRetracted(payload: { messageId: string; roomId: string; retractedAt: string }): void {
    this.server
      ?.to([socketRoom(payload.roomId), promoRoom(payload.roomId)])
      .emit(SERVER_EVENTS.MESSAGE_RETRACTED, payload);
  }

  publishPin(payload: { messageId: string; roomId: string; pinned: boolean }): void {
    this.server
      ?.to([socketRoom(payload.roomId), promoRoom(payload.roomId)])
      .emit(payload.pinned ? SERVER_EVENTS.MESSAGE_PINNED : SERVER_EVENTS.MESSAGE_UNPINNED, {
        messageId: payload.messageId,
        roomId: payload.roomId,
      });
  }

  // Any event to one user's sockets (gifts, DMs, staff requests).
  toUser(userIds: string | readonly string[], event: string, payload: unknown): void {
    const ids = typeof userIds === 'string' ? [userIds] : userIds;
    if (ids.length === 0) return;
    this.server?.to(ids.map(personalRoom)).emit(event, payload);
  }

  // Any event to a room's viewers, promo-only included (pinned ads).
  toRoom(roomId: string, event: string, payload: unknown): void {
    this.server?.to([socketRoom(roomId), promoRoom(roomId)]).emit(event, payload);
  }

  // Any event to every connected socket of the namespace (the next system rain).
  toAll(event: string, payload: unknown): void {
    this.server?.emit(event, payload);
  }

  // The users who are online right now.
  isOnline(userId: string): boolean {
    return this.presence.isOnline(userId);
  }

  notice(userId: string, notice: unknown): void {
    this.server?.to(personalRoom(userId)).emit(SERVER_EVENTS.MODERATION_NOTICE, notice);
  }

  scheduleCount(roomId: string): void {
    if (this.countTimers.has(roomId)) return;
    const timer = setTimeout(() => {
      this.countTimers.delete(roomId);
      const payload = { roomId, count: this.presence.count(roomId) };
      this.server?.volatile
        .to([socketRoom(roomId), promoRoom(roomId)])
        .emit(SERVER_EVENTS.ONLINE_COUNT_UPDATED, payload);
    }, TIMERS.COUNT_EMIT_MS);
    timer.unref();
    this.countTimers.set(roomId, timer);
  }
}
