import { describe, expect, it, vi } from 'vitest';
import { ChatAdsPlanner } from '../../src/social/chat/services/chat.ads.plan';
import { ChatSettingsDocumentSchema, effectiveSettings } from '../../src/social/chat/chat.settings.contract';
import { READY } from './chat.e2e.harness';

describe('ChatAdsPlanner advertiser benefits', () => {
  it('asks the benefit provider for the actual advertiser when quoting a price', async () => {
    const document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: false },
        limits: { messagesPerWindow: 100, messageWindowSeconds: 1, cooldownSeconds: 1, mediaCooldownSeconds: 0 },
        ...READY,
      },
    });
    const discountFor = vi.fn(async (userId: string) => userId === 'advertiser-id' ? { usd: '2' } : null);
    const global = effectiveSettings(document, null);
    const planner = new ChatAdsPlanner(
      { global: async () => global } as never,
      {
        requireRoom: async () => ({
          id: 'room-id', slug: 'room', name: 'Room', description: null, type: 'GLOBAL', createdAt: new Date(),
          config: { status: 'ACTIVE', contentControls: { allowAds: true }, controlsMaintenance: [], bannedWords: [] },
          access: { allowedPlanIds: [] }, regionCountries: null, fingerprint: 'room-v1',
        }),
      } as never,
      {} as never,
      {
        advertising: async () => null,
        currencyCatalog: async () => null,
        benefitDiscounts: async () => ({ discountFor }),
      } as never,
    );

    const planned = await planner.plan({ content: 'Hello', roomIds: ['room-id'] }, 'advertiser-id');
    expect(discountFor).toHaveBeenCalledWith('advertiser-id', global.ads.basePriceUsd);
    expect(planned.price.lines.some((line) => line.label === 'Benefit discount' && line.usd === '-2.00000000')).toBe(true);
  });
});
