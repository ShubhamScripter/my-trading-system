import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ChatAccessService } from '../chat.access.service';
import { ChatAuthHelper } from '../chat.auth.helper';
import { ChatBus } from './chat.bus';
import { SERVER_EVENTS, TIMERS } from '../chat.constants';
import { ChatPresenceService } from '../chat.presence.service';
import type { ChatSocket } from '../chat.types';

/**
 * Keeps open connections honest after the handshake:
 *  - every 5 s, the auth's revocation flags for every connected session (MGET in chunks): a logout reaches chat within
 *    about 5 seconds;
 *  - every 30 s, a database backstop over the session families (one statement per 1,000) and a reload of the rooms,
 *    re-checking open sockets only in rooms that changed.
 * A database or Redis error disconnects nobody; a sweep never starts while the previous one is running.
 */
@Injectable()
export class ChatSessionWatch implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ChatSessionWatch');
  private readonly timers: NodeJS.Timeout[] = [];
  private revocationRunning = false;
  private backstopRunning = false;

  constructor(
    private readonly presence: ChatPresenceService,
    private readonly auth: ChatAuthHelper,
    private readonly access: ChatAccessService,
    private readonly bus: ChatBus,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    const every = (ms: number, run: () => Promise<void>): void => {
      const timer = setInterval(() => void run(), ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(TIMERS.REVOCATION_CHECK_MS, () => this.revocationSweep());
    every(TIMERS.SESSION_BACKSTOP_MS, () => this.backstop());
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  private endSession(socket: ChatSocket): void {
    socket.emit(SERVER_EVENTS.SESSION_ENDED, { reason: ERR.SESSION_REVOKED });
    socket.disconnect(true);
  }

  async revocationSweep(): Promise<void> {
    if (this.revocationRunning) return;
    this.revocationRunning = true;
    try {
      const sockets = this.presence.allSockets();
      if (sockets.length === 0) return;
      const revoked = await this.auth.revokedSessions([
        ...new Set(sockets.map((s) => s.data.sessionId)),
      ]);
      for (const socket of sockets) if (revoked.has(socket.data.sessionId)) this.endSession(socket);
    } catch (err: unknown) {
      this.logger.warn(
        { component: 'ChatSessionWatch', err },
        'revocation check failed; keeping every socket',
      );
    } finally {
      this.revocationRunning = false;
    }
  }

  async backstop(): Promise<void> {
    if (this.backstopRunning) return;
    this.backstopRunning = true;
    try {
      const sockets = this.presence.allSockets();
      if (sockets.length > 0) {
        const dead = await this.auth.deadFamilies([
          ...new Set(sockets.map((s) => s.data.familyId)),
        ]);
        for (const socket of sockets) if (dead.has(socket.data.familyId)) this.endSession(socket);
      }
      const changed = await this.access.reloadRooms();
      const occupied = new Set(this.presence.roomsWithMembers());
      for (const roomId of changed)
        if (occupied.has(roomId)) this.bus.publish({ kind: 'room', roomId });
    } catch (err: unknown) {
      this.logger.warn(
        { component: 'ChatSessionWatch', err },
        'session backstop failed; keeping every socket',
      );
    } finally {
      this.backstopRunning = false;
    }
  }
}
