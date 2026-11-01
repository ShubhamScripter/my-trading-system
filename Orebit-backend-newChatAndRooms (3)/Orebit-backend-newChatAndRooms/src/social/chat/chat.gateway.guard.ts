import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import type { ChatSocketData } from './chat.types';

/** WebSocket guard that verifies the connection has completed authenticated handshake. */
@Injectable()
export class ChatGatewayGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    const data = client.data as Partial<ChatSocketData> | undefined;

    if (!data?.user || !data.sessionId) {
      throw new ProblemException({
        type: ERR.UNAUTHENTICATED,
        detail: 'This socket is not authenticated',
      });
    }

    return true;
  }
}
