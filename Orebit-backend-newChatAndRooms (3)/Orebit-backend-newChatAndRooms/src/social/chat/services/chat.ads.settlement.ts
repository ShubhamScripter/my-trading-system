// The money side of ads after they are posted (Module 5): refunds owed for unused posts and pinned minutes, the EXP and
// universal currency an advert earns ("Universal Currency and EXP … Per Advert"), and taking those rewards back when
// an admin reverts the ad ("Reverting will also revert EXP and Stars Earned"). Run by the ads tick.
import { Injectable, Logger } from '@nestjs/common';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { ChatSettingsService } from '../chat.settings';
import { ChatAdDbOperation } from '../persistence/chat.ad.dboperation';
import type { MoneyJobConfig } from './chat.money-config';
import { rewardsFor, type StoredReward } from './chat.rewards';

@Injectable()
export class ChatAdsSettlementService {
  private readonly logger = new Logger('ChatAdsSettlementService');

  constructor(
    private readonly ads: ChatAdDbOperation,
    private readonly ports: ChatFeaturePorts,
    private readonly settings: ChatSettingsService,
  ) {}

  // Rewards for a paid ad, recorded on the ad whether or not the rewards module took them.
  async award(adId: string, userId: string, usd: string): Promise<StoredReward | null> {
    try {
      const reward = rewardsFor((await this.settings.global()).rewards.advert, usd);
      if (reward.exp === 0 && reward.currency === 0) {
        const stored: StoredReward = { ...reward, awarded: true };
        await this.ads.setRewards(adId, { ...stored });
        return stored;
      }
      const port = await this.ports.rewards();
      const awarded = port
        ? await port.award({
            userId,
            kind: 'ADVERT',
            reference: adId,
            ...reward,
          })
        : false;
      const stored: StoredReward = { ...reward, awarded };
      await this.ads.setRewards(adId, { ...stored });
      return stored;
    } catch (err: unknown) {
      this.logger.warn(
        { component: 'ChatAdsSettlementService', err, adId },
        'could not award ad rewards',
      );
      return null;
    }
  }

  // Rewards completed ads whose rewards have not yet been evaluated/awarded.
  async awardCompletedAds(): Promise<void> {
    const completed = await this.ads.completedWithoutRewards();
    for (const ad of completed) {
      if (ad.creatorId && ad.priceUsd) {
        await this.award(ad.id, ad.creatorId, ad.priceUsd);
      }
    }
  }

  // Refunds owed and rewards to take back; failures stay owed and are retried on the next pass.
  async settle(config: MoneyJobConfig, until: number): Promise<void> {
    await this.awardCompletedAds();
    await this.payRefunds(config, until);
    await this.revokeRewards();
  }

  // Pays the refunds owed, a page at a time, each row claimed by this worker alone. The Charge port is called with the
// ad id as the refund reference, so even if two workers ever met the money would move once.
  private async payRefunds(config: MoneyJobConfig, until: number): Promise<void> {
    while (Date.now() < until) {
      const owed = await this.ads.claimRefundsDue(config.pageSize, config.staleSeconds);
      if (owed.length === 0) return;
      const charge = await this.ports.charge();
      if (!charge) {
        for (const ad of owed) await this.ads.releaseAd(ad.id);
        return;
      }
      let paid = 0;
      for (const ad of owed) {
        try {
          const done = await charge.refund({
            userId: ad.creatorId!,
            usd: ad.refundUsd!,
            reference: ad.chargeReference!,
            refundReference: ad.id,
            currency: ad.refundCurrency,
          });
          if (done && (await this.ads.markRefunded(ad.id))) paid += 1;
          else if (!done) await this.ads.releaseAd(ad.id);
        } catch (err: unknown) {
          this.logger.warn({ component: 'ChatAdsSettlementService', err, adId: ad.id }, 'ad refund failed; will retry');
          await this.ads.releaseAd(ad.id);
        }
      }
      // A page the port refused is not offered again in this pass.
      if (paid === 0 || owed.length < config.pageSize) return;
    }
  }

  private async revokeRewards(): Promise<void> {
    const due = await this.ads.rewardsToRevoke();
    if (due.length === 0) return;
    const port = await this.ports.rewards();
    for (const ad of due) {
      try {
        // Nothing awarded means nothing to take back.
        const done =
          !ad.rewards.awarded ||
          (port !== null &&
            (await port.revoke({
              userId: ad.creatorId!,
              kind: 'ADVERT',
              reference: ad.id,
              exp: ad.rewards.exp ?? 0,
              currency: ad.rewards.currency ?? 0,
            })));
        if (done) await this.ads.markRewardsRevoked(ad.id);
      } catch (err: unknown) {
        this.logger.warn(
          { component: 'ChatAdsSettlementService', err, adId: ad.id },
          'reward revoke failed; will retry',
        );
      }
    }
  }
}
