import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { ProblemException } from '../../http';
import { SERVER_EVENTS } from './chat.constants';
import { toAck } from './chat.ack';

/**
 * Turns a refusal raised before a socket handler runs — the input pipe or the sign-in guard — into the standard
 * failure reply. Without it the client got no ack and waited for its own timeout, and every refusal was
 * logged as a server error.
 *
 * The event's ack callback is the last argument of the packet when the client passed one; otherwise the same shape
 * is emitted on `exception`. Anything that is not a ProblemException is a bug and goes to Nest's base filter, which
 * logs it as an error.
 */
@Catch()
export class ChatWsExceptionFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger('ChatWsExceptionFilter');

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof ProblemException)) {
      super.catch(exception, host);
      return;
    }
    const ws = host.switchToWs();
    const socket = ws.getClient<Socket>();
    const args = host.getArgs();
    const ack = args.find((arg, index) => index > 0 && typeof arg === 'function') as
      ((reply: unknown) => void) | undefined;
    const reply = toAck(
      exception,
      this.logger,
      'guard_or_pipe',
      (socket.data as { user?: { id?: string } } | undefined)?.user?.id,
    );
    this.logger.debug(
      { component: 'ChatWsExceptionFilter', socketId: socket.id, type: exception.type },
      'socket event refused before its handler',
    );
    if (ack) ack(reply);
    else socket.emit(SERVER_EVENTS.EXCEPTION, reply);
  }
}
