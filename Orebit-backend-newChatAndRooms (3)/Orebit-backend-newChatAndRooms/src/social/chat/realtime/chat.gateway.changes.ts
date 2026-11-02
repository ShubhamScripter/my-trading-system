// What the gateway does when an admin, staff member or the settings change something: tell open sockets, and re-check who may still be in which room.
import { Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { ERR } from '../../../contracts';
import { ChatAccessService } from '../chat.access.service';
import type { ChatChange } from './chat.bus';
import { SERVER_EVENTS, socketRoom } from '../chat.constants';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatDelivery, countryRoom, promoRoom } from './chat.delivery';
import { ChatPresenceService } from '../chat.presence.service';
import type { ChatSocket, RoomAccessEvaluation, RoomRecord } from '../chat.types';

// What the handler needs from the gateway: the server to emit on, and a way to reload the limits.
export interface ChangeHooks {
  server: Server;
  refreshLimits: () => void;
}

export class ChatChangeHandler {
  private readonly logger = new Logger('ChatGateway');

  constructor(
    private readonly presence: ChatPresenceService,
    private readonly access: ChatAccessService,
    private readonly db: ChatDbOperation,
    private readonly delivery: ChatDelivery,
    private readonly rooms: ChatSocketRooms,
  ) {}

  handle(change: ChatChange, hooks: ChangeHooks): void | Promise<void> {
    switch (change.kind) {
      case 'alert':
        return this.deliverAlerts(change.messageIds);
      case 'retract':
        this.delivery.publishRetracted({
          messageId: change.messageId,
          roomId: change.roomId,
          retractedAt: change.retractedAt,
        });
        return;
      case 'pin':
        this.delivery.publishPin({
          messageId: change.messageId,
          roomId: change.roomId,
          pinned: change.pinned,
        });
        return;
      case 'notice':
        this.delivery.notice(change.userId, change.notice);
        return;
      case 'support':
        this.delivery.toUser(change.userId, SERVER_EVENTS.SUPPORT_UPDATED, {
          ticketId: change.ticketId,
          status: change.status,
        });
        return;
      case 'preferences':
        for (const socket of this.presence.socketsOf(change.userId)) {
          socket.data.hideIdentity = change.hideIdentity;
          socket.data.activeSkinId = change.activeSkinId;
        }
        return;
      case 'room':
        // Every list may change (a new, renamed, hidden or reopened room), not only the room's members.
        hooks.server.emit(SERVER_EVENTS.ROOMS_CHANGED, {});
        return this.reevaluateRooms([change.roomId]);
      case 'settings':
        hooks.refreshLimits();
        hooks.server.emit(SERVER_EVENTS.ROOMS_CHANGED, {});
        return this.reevaluateRooms(this.presence.roomsWithMembers());
      case 'user':
        return this.reevaluateUser(change.userId);
      case 'rain':
        hooks.server.emit(SERVER_EVENTS.RAIN_CONFIG_CHANGED, {});
        return;
      case 'rain_request':
        this.delivery.toUser(change.userId, SERVER_EVENTS.RAIN_VERIFICATION_REQUESTED, { rainId: change.rainId });
        return;
      default:
        return;
    }
  }

  private async deliverAlerts(messageIds: readonly string[]): Promise<void> {
    for (const row of await this.db.messagesByIds(messageIds)) this.delivery.publish(row);
  }

  // Re-checks the open sockets of the given rooms; sockets that may no longer view a room leave it.
  private async reevaluateRooms(roomIds: readonly string[]): Promise<void> {
    if (roomIds.length === 0) return;
    const wanted = new Set(roomIds);
    for (const socket of this.presence.allSockets()) {
      if (socket.data.roomId && wanted.has(socket.data.roomId)) await this.reevaluate(socket);
    }
  }

  private async reevaluateUser(userId: string): Promise<void> {
    this.access.forgetUser(userId);
    const fresh = await this.db.findChatUser(userId);
    for (const socket of this.presence.socketsOf(userId)) {
      if (!fresh) {
        socket.emit(SERVER_EVENTS.SESSION_ENDED, { reason: ERR.SESSION_REVOKED });
        socket.disconnect(true);
        continue;
      }
      socket.data.user = fresh;
      await this.reevaluate(socket);
      // Role or eligibility facts changed (e.g. on the casino, premium): every room's access may differ.
      socket.emit(SERVER_EVENTS.ROOMS_CHANGED, {});
    }
  }

  private async reevaluate(socket: ChatSocket): Promise<void> {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      const room = await this.access.findRoom(roomId);
      const access = room ? await this.access.evaluate(socket.data.user, room) : null;
      if (!room || !access?.isEligibleToView) {
        await this.rooms.leave(socket);
        socket.emit(SERVER_EVENTS.ROOM_ACCESS, {
          status: 'removed',
          roomId,
          ...(access ? { access } : {}),
        });
        return;
      }
      const before = socket.data.access;
      if (before?.receivesUserMessages !== access.receivesUserMessages)
        await this.rooms.enter(socket, room, access);
      socket.data.access = access;
      if (JSON.stringify(before) !== JSON.stringify(access)) {
        socket.emit(SERVER_EVENTS.ROOM_ACCESS, { status: 'updated', roomId, access });
      }
    } catch (err: unknown) {
      this.logger.error(
        { component: 'ChatGateway', err, socketId: socket.id, roomId },
        're-evaluating a socket failed',
      );
    }
  }
}

// Moving a socket between rooms

// Moves one socket in and out of a chat room: the socket.io channel it listens on, the presence count and the
// user's remembered last room. Used by the gateway and by the change handler.

export class ChatSocketRooms {
  private readonly chains = new WeakMap<ChatSocket, Promise<unknown>>();

  constructor(
    private readonly presence: ChatPresenceService,
    private readonly delivery: ChatDelivery,
  ) {}

  async enter(socket: ChatSocket, room: RoomRecord, access: RoomAccessEvaluation): Promise<void> {
    await this.serialize(socket, () => this.enterNow(socket, room, access));
  }

  private async enterNow(socket: ChatSocket, room: RoomRecord, access: RoomAccessEvaluation): Promise<void> {
    const userId = socket.data.user.id;
    const previousRoomId = socket.data.roomId;
    const isSameRoom = previousRoomId === room.id;

    if (previousRoomId && !isSameRoom) {
      await this.leaveNow(socket);
    }

    if (isSameRoom) {
      // Already counted as present; drop both channels so the new access decides which one applies.
      await socket.leave(socketRoom(room.id));
      await socket.leave(promoRoom(room.id));
      if (socket.data.country) await socket.leave(countryRoom(room.id, socket.data.country));
    } else {
      this.presence.joinRoom(room.id, userId);
    }

    // A user who may not receive other users' messages only listens to the room's promo channel.
    const channel = access.receivesUserMessages ? socketRoom(room.id) : promoRoom(room.id);
    await socket.join(channel);
    // The channel an ad hidden from this country skips.
    if (socket.data.country) await socket.join(countryRoom(room.id, socket.data.country));

    socket.data.roomId = room.id;
    socket.data.access = access;

    this.presence.rememberRoom(userId, room.id);
    this.delivery.scheduleCount(room.id);
  }

  // Takes the socket out of its current room, if it is in one, and forgets its access to it.
  leave(socket: ChatSocket): Promise<void> {
    return this.serialize(socket, () => this.leaveNow(socket));
  }

  private async leaveNow(socket: ChatSocket): Promise<void> {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    await Promise.all([
      socket.leave(socketRoom(roomId)),
      socket.leave(promoRoom(roomId)),
      ...(socket.data.country ? [socket.leave(countryRoom(roomId, socket.data.country))] : []),
    ]);
    this.presence.leaveRoom(roomId, socket.data.user.id);

    socket.data.roomId = null;
    socket.data.access = null;
    this.delivery.scheduleCount(roomId);
  }

  private serialize<T>(socket: ChatSocket, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(socket) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.chains.set(socket, current);
    return current;
  }
}
