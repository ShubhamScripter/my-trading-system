import { describe, expect, it, vi } from 'vitest';
import { RainPayoutService } from '../../src/social/rain/rain.payout.service';

describe('RainPayoutService public result', () => {
  it('tags recipients in the chat feed without returning internal ids or premium tier', async () => {
    const sharesOf = vi.fn(async () => [{ userId: 'private-user-id', amount: 500_000_000n, tier: 'PREMIUM' as const }]);
    const postSystemAlert = vi.fn(async () => ({ id: 'message-id' }));
    const db = {
      sharesOf,
      usernamesByIds: vi.fn(async () => new Map([['private-user-id', 'public-name']])),
      setMessage: vi.fn(async () => undefined),
      config: vi.fn(async () => ({ rewards: { perRainDone: { exp: { amount: 0 }, stars: { amount: 0 }, }, perRainReceived: { exp: { amount: 0 }, stars: { amount: 0 } } } })),
    };
    const delivery = { toRoom: vi.fn(), toUser: vi.fn() };
    const service = new RainPayoutService(
      db as never,
      {} as never,
      { postSystemAlert } as never,
      delivery as never,
      { rewards: vi.fn(async () => null) } as never,
    );
    const result = await service.afterPaid({
      id: 'rain-id', kind: 'USER', status: 'COMPLETED', roomId: 'room-id', initiatorId: 'sender-id',
      currency: 'ORE', potMinor: 500n, feeMinor: 0n, distributableMinor: 500n, usdValueMinor: null,
      usdPriceMinor: null, messageId: null,
    } as never);

    expect(postSystemAlert).toHaveBeenCalledWith('RAIN', expect.any(String), 'room-id', ['private-user-id']);
    expect(result.shares).toEqual([{ username: 'public-name', amount: '5' }]);
    expect(JSON.stringify(result)).not.toContain('private-user-id');
    expect(JSON.stringify(result)).not.toContain('PREMIUM');
  });
});
