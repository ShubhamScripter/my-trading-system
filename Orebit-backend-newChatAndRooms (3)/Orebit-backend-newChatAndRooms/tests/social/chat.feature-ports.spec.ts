import { describe, expect, it, vi } from 'vitest';
import {
  ChatFeaturePorts,
  type AdvertisingPort,
  type BenefitDiscountPort,
  type CurrencyCatalogPort,
  type LeaderboardPort,
} from '../../src/social/chat/chat.feature-ports';
import type { PremiumPort } from '../../src/social/chat/chat.ports';

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

  it('resolves every ad feature through its single bound provider', async () => {
    const advertising: AdvertisingPort = {
      isUrlBlacklisted: vi.fn(async (url) => url === 'blocked.example'),
      hasBlockedWord: vi.fn(async (text) => text.includes('blocked')),
      cancellationFee: vi.fn(async () => ({ kind: 'USD' as const, value: '1' })),
    };
    const catalog: CurrencyCatalogPort = { isUsable: vi.fn(async ({ currency }) => currency !== 'DELISTED') };
    const discounts: BenefitDiscountPort = { discountFor: vi.fn(async (userId) => userId === 'user-1' ? { usd: '2' } : null) };
    const leaderboard: LeaderboardPort = { recordAdSpend: vi.fn(async () => undefined) };
    const premium: PremiumPort = {
      activePlanIds: vi.fn(async () => ['plan-1']),
      hasDisableAllAds: vi.fn(async (userId) => userId === 'user-1'),
    };
    const ports = new ChatFeaturePorts(
      { standInsActive: vi.fn(async () => false) } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      advertising,
      catalog,
      discounts,
      leaderboard,
      premium,
    );

    expect(await (await ports.advertising())!.isUrlBlacklisted('blocked.example')).toBe(true);
    expect(await (await ports.advertising())!.hasBlockedWord('blocked word')).toBe(true);
    expect(await (await ports.advertising())!.cancellationFee!()).toEqual({ kind: 'USD', value: '1' });
    expect(await (await ports.currencyCatalog())!.isUsable({ currency: 'DELISTED', purpose: 'AD_PAYMENT' })).toBe(false);
    expect(await (await ports.benefitDiscounts())!.discountFor('user-1', '10')).toEqual({ usd: '2' });
    await (await ports.leaderboard())!.recordAdSpend({ userId: 'user-1', usd: '10', adId: 'ad-1' });
    expect(await (await ports.premium())!.hasDisableAllAds('user-1')).toBe(true);
    expect(advertising.isUrlBlacklisted).toHaveBeenCalledWith('blocked.example');
    expect(catalog.isUsable).toHaveBeenCalledWith({ currency: 'DELISTED', purpose: 'AD_PAYMENT' });
    expect(discounts.discountFor).toHaveBeenCalledWith('user-1', '10');
    expect(leaderboard.recordAdSpend).toHaveBeenCalledOnce();
    expect(premium.hasDisableAllAds).toHaveBeenCalledWith('user-1');
  });
});
