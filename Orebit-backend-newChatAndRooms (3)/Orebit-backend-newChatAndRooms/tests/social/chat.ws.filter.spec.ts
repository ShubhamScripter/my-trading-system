import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { ChatWsExceptionFilter } from '../../src/social/chat/chat.ws.filter';

function host(args: unknown[]): ArgumentsHost {
  return {
    switchToWs: () => ({ getClient: () => args[0] }),
    getArgs: () => args,
  } as unknown as ArgumentsHost;
}

describe('ChatWsExceptionFilter', () => {
  it('answers a pipe refusal on the ack with the standard failure', () => {
    const socket = { id: 's', data: {}, emit: vi.fn() };
    const ack = vi.fn();
    const refusal = new ProblemException({
      type: ERR.VALIDATION_FAILED,
      errors: [{ path: 'content', message: 'required' }],
    });
    new ChatWsExceptionFilter().catch(refusal, host([socket, {}, ack]));
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({
        type: 'validation_failed',
        errors: [{ path: 'content', message: 'required' }],
      }),
    });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('emits on exception when the client sent no ack', () => {
    const socket = { id: 's', data: {}, emit: vi.fn() };
    new ChatWsExceptionFilter().catch(
      new ProblemException({ type: ERR.UNAUTHENTICATED }),
      host([socket, {}]),
    );
    expect(socket.emit).toHaveBeenCalledWith('exception', {
      ok: false,
      error: expect.objectContaining({ type: 'unauthenticated' }),
    });
  });
});
