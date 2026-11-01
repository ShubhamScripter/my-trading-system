import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { ipClassOf } from '../../../auth/auth.utility';
import { config } from '../../config';
import { ERR } from '../../contracts';
import { cloudflareCountry } from '../../geo/cloudflare';
import { cloudflareAnonymised } from './chat.edge';
import { ProblemException } from '../../http';
import { ackError, ackOk, toAck, type Ack } from './chat.ack';
import { ChatAccessService } from './chat.access.service';
import { ChatAuthHelper } from './chat.auth.helper';
import { ChatBus } from './realtime/chat.bus';
import { ChatDelivery } from './realtime/chat.delivery';
import { ChatChangeHandler, ChatSocketRooms } from './realtime/chat.gateway.changes';
import * as constants from './chat.constants';
import type { ChatSettings } from './chat.settings.contract';
import { ChatDbOperation } from './chat.dboperation';
import * as dto from './chat.dto';
import { ChatGatewayGuard } from './chat.gateway.guard';
import {
  readLastRoomHint,
  takeToken,
  toSendInput,
  type Bucket,
} from './realtime/chat.gateway.helpers';
import { ChatWsExceptionFilter } from './chat.ws.filter';
import { WsValidationPipe } from './chat.ws.pipe';
import { ChatModerationService } from './chat.moderation.service';
import { ChatPresenceService } from './chat.presence.service';
import { allowedOrigins, HandshakeRefusal } from './chat.session.adapter';
import { ChatService } from './chat.service';
import { ChatSettingsService } from './chat.settings';
import type { ChatSocket, ChatSocketData, RoomAccessEvaluation } from './chat.types';
import { clientIp, isChatStaff } from './chat.utility';
import { ChatAdsService } from './services/chat.ads.service';
import { ChatCommandsService } from './services/chat.commands.service';
import { ChatRelationsService } from './services/chat.relations.service';
import { isRequested } from './services/chat.staff.gate';

/** What a send answers with: the stored message's id and time, or a command's result (Module 5). */
type SendAck = Ack<
  { messageId: string; createdAt: string } | { command: string; roomId: string; result: unknown }
>;

@UseFilters(ChatWsExceptionFilter)
@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: allowedOrigins(), credentials: true },
  // A packet over this closes the connection before any handler sees it.
  maxHttpBufferSize: constants.LIMITS.SOCKET_PACKET_BYTES,
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('ChatGateway');
  private pendingHandshakes = 0;
  private readonly buckets = new WeakMap<Socket, Bucket>();
  private readonly sendChains = new WeakMap<Socket, Promise<unknown>>();
  private readonly lastSearch = new WeakMap<Socket, number>();
  private readonly refusals = new Map<string, number>();
  private limits: ChatSettings['limits'] | null = null;
  private limitsTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly rooms: ChatSocketRooms;
  private readonly changes: ChatChangeHandler;

  constructor(
    private readonly chat: ChatService,
    private readonly access: ChatAccessService,
    private readonly presence: ChatPresenceService,
    private readonly moderation: ChatModerationService,
    private readonly auth: ChatAuthHelper,
    private readonly settings: ChatSettingsService,
    private readonly db: ChatDbOperation,
    private readonly bus: ChatBus,
    private readonly delivery: ChatDelivery,
    private readonly commands: ChatCommandsService,
    private readonly relations: ChatRelationsService,
    private readonly ads: ChatAdsService,
  ) {
    this.rooms = new ChatSocketRooms(presence, delivery);
    this.changes = new ChatChangeHandler(presence, access, db, delivery, this.rooms);
  }

  // Lifecycle
  afterInit(server: Server): void {
    this.delivery.attach(server);
    server.use((socket, next) => {
      void this.handshake(socket, next);
    });
    this.unsubscribe = this.bus.subscribe((change) =>
      this.changes.handle(change, {
        server: this.server,
        refreshLimits: () => void this.refreshLimits(),
      }),
    );
    void this.refreshLimits();

    // Limit values follow the settings; a change signal refreshes them at once, this keeps them fresh regardless.
    this.limitsTimer = setInterval(
      () => void this.refreshLimits(),
      constants.TIMERS.CACHE_SECONDS * 1000,
    );
    this.limitsTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.limitsTimer) clearInterval(this.limitsTimer);
    this.unsubscribe?.();
  }

  private async refreshLimits(): Promise<void> {
    try {
      this.limits = (await this.settings.global()).limits;
    } catch (err: unknown) {
      this.logger.warn(
        { component: 'ChatGateway', err },
        'could not read chat limits; keeping the previous values',
      );
    }
  }

  /** Authenticates socket connections via session cookie with overload protection. */
  private async handshake(socket: Socket, next: (err?: Error) => void): Promise<void> {
    if (this.pendingHandshakes >= constants.TIMERS.MAX_PENDING_HANDSHAKES) {
      next(new Error(constants.HANDSHAKE_REFUSALS.SERVER_BUSY));
      return;
    }
    this.pendingHandshakes += 1;
    try {
      const { user, sessionId, familyId } = await this.auth.authenticateHandshake(
        socket.handshake.headers,
      );
      const [prefs, serverLastRoom] = await Promise.all([
        this.db.preferences(user.id),
        this.presence.lastRoom(user.id),
      ]);
      const data: ChatSocketData = {
        user,
        sessionId,
        familyId,
        ip: clientIp(
          socket.handshake.headers['x-forwarded-for'],
          socket.handshake.address,
          config.trustedProxies,
        ),
        roomId: null,
        access: null,
        hideIdentity: prefs.hideIdentity,
        activeSkinId: prefs.activeSkinId,
        country: null,
        // The last room is kept on the server; the browser's hint is only a fallback.
        lastRoomHint: readLastRoomHint(serverLastRoom, socket.handshake.auth),
      };
      socket.data = data;
      next();
    } catch (err: unknown) {
      const reason =
        err instanceof HandshakeRefusal ? err.reason : constants.HANDSHAKE_REFUSALS.UNAUTHENTICATED;
      if (!(err instanceof HandshakeRefusal))
        this.logger.error({ component: 'ChatGateway', err }, 'chat handshake failed');
      this.logger.debug(
        { component: 'ChatGateway', socketId: socket.id, reason },
        'chat handshake refused',
      );
      next(new Error(reason));
    } finally {
      this.pendingHandshakes -= 1;
    }
  }

  async handleConnection(socket: ChatSocket): Promise<void> {
    const user = socket.data?.user;
    if (!user) return;

    // The flood bucket covers every event and is registered before any await.
    this.buckets.set(socket, {
      tokens: this.limits?.eventsBurst ?? 20,
      at: Date.now(),
    });
    socket.use((packet, next) => this.bucket(socket, packet, next));

    const sockets = this.presence.add(socket, {
      id: user.id,
      username: user.username,
      country: null,
      isStaff: isChatStaff(user.staffRole),
    });
    const cap = this.limits?.connectionsPerAccount ?? 5;
    if (sockets.length > cap) {
      const oldest = sockets[0]!;
      oldest.emit(constants.SERVER_EVENTS.SESSION_REPLACED, {
        reason: constants.CHAT_REFUSAL_REASONS.SESSION_REPLACED,
      });
      oldest.disconnect(true);
    }

    void socket.join(constants.personalRoom(user.id));
    // The first socket of a user loads their mute and block lists, so broadcasts can skip the authors they hide.
    if (sockets.length === 1) await this.relations.load(user.id);

    try {
      socket.data.country = (await this.access.factsFor(user)).country;
      if (socket.disconnected) return;
      const { room, access } = await this.access.effectiveRoom(user, socket.data.lastRoomHint);
      if (socket.disconnected) return;
      await this.rooms.enter(socket, room, access);
      if (socket.disconnected) {
        this.presence.leaveRoom(room.id, user.id);
        return;
      }
      socket.emit(constants.SERVER_EVENTS.ROOM_ACCESS, {
        status: 'joined',
        roomId: room.id,
        access,
        pinnedAd: await this.pinnedAd(room.id, socket),
      });
    } catch (err: unknown) {
      this.logger.error(
        { component: 'ChatGateway', err, userId: user.id, socketId: socket.id },
        'could not place socket in a room',
      );
    }
  }

  handleDisconnect(socket: ChatSocket): void {
    const user = socket.data?.user;
    if (!user) return;
    const roomId = socket.data.roomId;
    if (roomId) {
      this.presence.leaveRoom(roomId, user.id);
      this.delivery.scheduleCount(roomId);
    }
    if (this.presence.remove(socket)) this.relations.unload(user.id);
  }

  /** The pinned ad showing in a room for this viewer (Module 5); never fails a join. */
  private async pinnedAd(roomId: string, socket: ChatSocket): Promise<unknown> {
    try {
      return await this.ads.activePin(roomId, socket.data.country ?? null, socket.data.user?.id ?? null);
    } catch {
      return null;
    }
  }

  // Flood bucket
  private bucket(socket: Socket, packet: unknown[], next: (err?: Error) => void): void {
    const state = this.buckets.get(socket);
    if (!state) {
      next();
      return;
    }

    const rate = this.limits?.eventsPerSecond ?? 10;
    const burst = this.limits?.eventsBurst ?? 20;
    const remainingSeconds = takeToken(state, rate, burst, Date.now());
    if (remainingSeconds === 0) {
      next();
      return;
    }

    // The ack is the last argument of the packet, when the client sent one.
    const ack = packet[packet.length - 1];
    if (typeof ack === 'function') {
      const refusal = ackError(
        ERR.RATE_LIMITED,
        'Too many events',
        { reason: 'flood', remainingSeconds },
        remainingSeconds,
      );
      (ack as (reply: unknown) => void)(refusal);
    }

    const data = socket.data as Partial<ChatSocketData>;
    if (data.user) this.moderation.noteFlood(data.user.id, data.ip ?? '');
    this.countRefusal('flood');
  }

  // Refusal counting and failure replies
  private countRefusal(reason: string): void {
    this.refusals.set(reason, (this.refusals.get(reason) ?? 0) + 1);
  }

  /** Counts the refusal and turns the error into the failure ack every handler returns. */
  private fail(err: unknown, event: string, socket: ChatSocket): Ack<never> {
    if (err instanceof ProblemException) this.countRefusal(String(err.extra?.reason ?? err.type));
    return toAck(err, this.logger, event, socket.data?.user?.id, {
      socketId: socket.id,
      roomId: socket.data?.roomId ?? null,
    });
  }

  /** Refusal counts since the last call, for the one-a-minute stats line. */
  takeRefusalCounts(): Record<string, number> {
    const out = Object.fromEntries(this.refusals);
    this.refusals.clear();
    return out;
  }

  // Client events
  @UseGuards(ChatGatewayGuard)
  @UsePipes(WsValidationPipe)
  @SubscribeMessage('send_message')
  handleSendMessage(
    @MessageBody() payload: dto.SendMessageDto,
    @ConnectedSocket() socket: ChatSocket,
  ): Promise<SendAck> {
    // One send at a time per socket, so messages are stored and broadcast in the order they were sent.
    const previous = this.sendChains.get(socket) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.send(payload, socket));
    this.sendChains.set(socket, run);
    return run;
  }

  /** Stores the message, then broadcasts it (unless it repeats an earlier send) and tells the tagged users. */
  private async send(payload: dto.SendMessageDto, socket: ChatSocket): Promise<SendAck> {
    const { user, roomId, ip, hideIdentity, activeSkinId } = socket.data;
    try {
      // "/mute @bob", "/dm @bob hi"…: a command runs instead of being posted (Module 5).
      if (payload.mediaUrl === undefined && ChatCommandsService.isCommandText(payload.content)) {
        return ackOk(
          await this.commands.run(user, {
            roomRef: payload.roomId ?? roomId ?? undefined,
            text: payload.content!,
            ip,
            clientMessageId: payload.clientMessageId,
            // For /rain's security tiers: which session, network and country this socket is on.
            context: {
              sessionId: socket.data.sessionId,
              ipClass: ipClassOf(ip),
              country: cloudflareCountry(socket.handshake.headers),
              anonymised: cloudflareAnonymised(socket.handshake.headers),
            },
          }),
        );
      }
      const result = await this.chat.sendMessage(user, toSendInput(payload, roomId), {
        ip,
        hideIdentity,
        activeSkinId,
      });
      if (!result.duplicate) {
        this.delivery.publish(result.row);
        this.delivery.notifyTagged(result.row, result.taggedUserIds);
      }
      return ackOk({
        messageId: result.row.id,
        createdAt: result.row.createdAt.toISOString(),
      });
    } catch (err: unknown) {
      if (err instanceof ProblemException && err.type === ERR.RATE_LIMITED) {
        socket.emit(constants.SERVER_EVENTS.RATE_LIMIT_COOLDOWN, {
          remainingSeconds: err.extra?.remainingSeconds,
          reason: err.extra?.reason,
        });
      }
      return this.fail(err, 'send_message', socket);
    }
  }

  @UseGuards(ChatGatewayGuard)
  @UsePipes(WsValidationPipe)
  @SubscribeMessage('retract_message')
  async handleRetractMessage(
    @MessageBody() payload: dto.RetractMessageDto,
    @ConnectedSocket() socket: ChatSocket,
  ): Promise<Ack<unknown>> {
    try {
      const result = await this.chat.retract(
        socket.data.user,
        payload.messageId,
        payload.note ?? null,
      );
      // A REPORT-mode staff retract is only a request to a higher role (Module 4).
      if (!isRequested(result)) this.delivery.publishRetracted(result);
      return ackOk(result);
    } catch (err: unknown) {
      return this.fail(err, 'retract_message', socket);
    }
  }

  /** Access first; only once every step succeeded does the socket leave its current room. */
  @UseGuards(ChatGatewayGuard)
  @UsePipes(WsValidationPipe)
  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @MessageBody() payload: dto.JoinRoomDto,
    @ConnectedSocket() socket: ChatSocket,
  ): Promise<
    Ack<{ roomId: string; access: RoomAccessEvaluation; onlineCount: number; pinnedAd: unknown }>
  > {
    const { user } = socket.data;
    try {
      const room = await this.access.requireRoom(payload.roomId);
      const access = await this.access.evaluate(user, room);
      if (!access.isEligibleToView) {
        socket.emit(constants.SERVER_EVENTS.ROOM_ACCESS, {
          status: 'forbidden',
          roomId: room.id,
          access,
        });
        throw new ProblemException({
          type: ERR.FORBIDDEN,
          detail: access.reason ?? 'You cannot view this room',
          extra: {
            reason: constants.CHAT_REFUSAL_REASONS.ROOM_HIDDEN,
            roomId: room.id,
            ...(access.requirement ? { requirement: access.requirement } : {}),
          },
        });
      }
      await this.rooms.enter(socket, room, access);
      const pinnedAd = await this.pinnedAd(room.id, socket);
      socket.emit(constants.SERVER_EVENTS.ROOM_ACCESS, {
        status: 'joined',
        roomId: room.id,
        access,
        pinnedAd,
      });
      return ackOk({
        roomId: room.id,
        access,
        onlineCount: this.presence.count(room.id),
        pinnedAd,
      });
    } catch (err: unknown) {
      return this.fail(err, 'join_room', socket);
    }
  }

  @UseGuards(ChatGatewayGuard)
  @UsePipes(WsValidationPipe)
  @SubscribeMessage('leave_room')
  async handleLeaveRoom(
    @MessageBody() _payload: dto.LeaveRoomDto,
    @ConnectedSocket() socket: ChatSocket,
  ): Promise<Ack<{ roomId: string | null }>> {
    const roomId = socket.data.roomId;
    this.rooms.leave(socket);
    socket.emit(constants.SERVER_EVENTS.ROOM_LEFT, { roomId });
    return ackOk({ roomId });
  }

  /** Member list on request only: count, a page of 50, a cursor and a username-prefix search. */
  @UseGuards(ChatGatewayGuard)
  @UsePipes(WsValidationPipe)
  @SubscribeMessage('get_online_users')
  async handleGetOnlineUsers(
    @MessageBody() payload: dto.OnlineUsersDto,
    @ConnectedSocket() socket: ChatSocket,
  ): Promise<Ack<unknown>> {
    try {
      const now = Date.now();
      if (now - (this.lastSearch.get(socket) ?? 0) < constants.TIMERS.MEMBER_SEARCH_MS) {
        throw new ProblemException({
          type: ERR.RATE_LIMITED,
          detail: 'One member search per second',
          extra: { reason: 'member_search', remainingSeconds: 1 },
          retryAfterSeconds: 1,
        });
      }
      this.lastSearch.set(socket, now);
      const roomRef = payload.roomId ?? socket.data.roomId;
      if (!roomRef)
        throw new ProblemException({
          type: ERR.NOT_FOUND,
          detail: 'Not in a room',
        });
      const result = await this.chat.members(socket.data.user, roomRef, payload);
      socket.emit(constants.SERVER_EVENTS.ONLINE_USERS, result);
      return ackOk(result);
    } catch (err: unknown) {
      return this.fail(err, 'get_online_users', socket);
    }
  }
}
