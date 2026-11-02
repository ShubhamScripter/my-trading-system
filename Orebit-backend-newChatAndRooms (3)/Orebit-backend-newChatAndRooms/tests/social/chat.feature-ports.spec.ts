import { describe, expect, it, vi } from 'vitest';
import { ChatFeaturePorts } from '../../src/social/chat/chat.feature-ports';

describe('ChatFeaturePorts payment PIN availability', () => {
  it('fails closed when the real verification provider and test stand-ins are unavailable', async () => {
    const ports = new ChatFeaturePorts(
      { standInsActive: vi.fn(async () => false) } as never,
      {} as never,
      {} as never,
    );

    await expect(ports.hasPaymentPin('user-1')).rejects.toMatchObject({
      extra: { reason: 'feature_unavailable' },
    });
  });

  it('permits the test PIN only when the stand-in provider is active', async () => {
    const ports = new ChatFeaturePorts(
      { standInsActive: vi.fn(async () => true) } as never,
      {} as never,
      {} as never,
    );

    await expect(ports.hasPaymentPin('user-1')).resolves.toBe(true);
  });
});
