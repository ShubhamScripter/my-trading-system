/**
 * The personal-chat socket events (Modules 8–9) on the same `/chat` namespace as public chat: the handshake, the
 * flood bucket and the personal channel come from ChatGateway; this class only adds handlers.
 *
 *  - `dm_send`   { conversationId, content?, mediaUrl?, mediaType?, thumbnailUrl?, clientMessageId? }
 *  - `dm_typing` { conversationId, typing }     — "Typing…": membership first, then at most one every 2 seconds
 *  - `dm_read`   { conversationId, messageId }  — read receipts
 * Every handler answers with the same ack shape as public chat.
 */
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Logger, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { ackOk, toAck, type Ack } from '../chat.ack';
import { LIMITS } from '../chat.constants';
import { ChatGatewayGuard } from '../chat.gateway.guard';
import { allowedOrigins } from '../chat.session.adapter';
import type { ChatSocket } from '../chat.types';
import { ChatWsExceptionFilter } from '../chat.ws.filter';
import { WsValidationPipe } from '../chat.ws.pipe';
import { toDmInput } from './dm.controller';
import { DmReadDto, DmSocketSendDto, DmTypingDto } from './dm.dto';
import { DmService } from './dm.service';
import { DmSignalsService } from './dm.signals.service';

@UseFilters(ChatWsExceptionFilter)
@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: allowedOrigins(), credentials: true },
  maxHttpBufferSize: LIMITS.SOCKET_PACKET_BYTES,
})
export class DmGateway {
  private readonly logger = new Logger('DmGateway');
  private readonly sendChains = new WeakMap<ChatSocket, Promise<unknown>>();

  constructor(
    private readonly dm: DmService,
    private readonly signals: DmSignalsService,
  ) {}

  private fail(err: unknown, event: string, socket: ChatSocket): Ack<never> {
    return toAck(err, this.logger, event, socket.data?.user?.id, { socketId: socket.id });
  }

  @UseGuards(ChatGatewayGuard)
  @UsePipes(WsValidationPipe)
  @SubscribeMessage('dm_send')
  handleSend(
    @MessageBody() payload: DmSocketSendDto,
    @ConnectedSocket() socket: ChatSocket,
  ): Promise<Ack<unknown>> {
    // One send at a time per socket, so a conversation's messages keep the order they were sent in.
    const previous = this.sendChains.get(socket) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          const { conversationId, ...body } = payload;
          const result = await this.dm.send(
            socket.data.user,
            conversationId,
            toDmInput(body),
            socket.data.ip,
          );
          return ackOk({ conversationId, message: result.message, duplicate: result.duplicate });
        } catch (err: unknown) {
          return this.fail(err, 'dm_send', socket);
        }
      });
    this.sendChains.set(socket, run);
    return run;
  }

  @UseGuards(ChatGatewayGuard)
  @UsePipes(WsValidationPipe)
  @SubscribeMessage('dm_typing')
  async handleTyping(
    @MessageBody() payload: DmTypingDto,
    @ConnectedSocket() socket: ChatSocket,
  ): Promise<Ack<unknown>> {
    try {
      // The service checks membership before it limits, and sends "stopped typing" only after a "typing".
      const sent = await this.signals.typing(socket.data.user, payload.conversationId, payload.typing);
      return ackOk({ sent });
    } catch (err: unknown) {
      return this.fail(err, 'dm_typing', socket);
    }
  }

  @UseGuards(ChatGatewayGuard)
  @UsePipes(WsValidationPipe)
  @SubscribeMessage('dm_read')
  async handleRead(
    @MessageBody() payload: DmReadDto,
    @ConnectedSocket() socket: ChatSocket,
  ): Promise<Ack<unknown>> {
    try {
      return ackOk(
        await this.signals.markRead(socket.data.user, payload.conversationId, payload.messageId),
      );
    } catch (err: unknown) {
      return this.fail(err, 'dm_read', socket);
    }
  }
}
