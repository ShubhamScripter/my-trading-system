import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMoneyLoop } from '../../src/social/chat/chat.money-loop';

afterEach(() => vi.restoreAllMocks());

describe('ChatMoneyLoop database failures', () => {
  it('logs a failed settings read and allows the next pass to run', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const settings = {
      global: vi.fn()
        .mockRejectedValueOnce(new Error('temporary database error'))
        .mockResolvedValue({
          ads: { pendingPaymentMinutes: null, jobStaleMinutes: null, jobPageSize: null, jobBudgetSeconds: null },
          gifts: { processingStaleMinutes: null },
        }),
    };
    const loop = new ChatMoneyLoop(settings as never, {} as never, {} as never, {} as never, {} as never);

    await expect(loop.kick()).resolves.toBeUndefined();
    await expect(loop.kick()).resolves.toBeUndefined();
    expect(settings.global).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'money loop pass failed');
  });
});
