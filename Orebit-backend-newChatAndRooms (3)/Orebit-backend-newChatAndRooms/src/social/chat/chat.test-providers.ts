/**
 * The test-only stand-ins (NEW-2) for the Premium, KYC, Merchant and Casino ports. They answer from
 * chat.test_entitlements, and only when all three hold: the chat setting `testProviders.enabled` is on,
 * CHAT_ALLOW_TEST_PROVIDERS is `true`, and NODE_ENV is not `production`. Otherwise chat behaves as if the real
 * modules were not connected.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ChatRecordsDbOperation } from './persistence/chat.records.dboperation';
import { ChatSettingsService } from './chat.settings';
import { usdStored } from './platform/money';

export interface StandIn {
  premiumPlanIds: string[];
  kycLevel: number | null;
  isSiteOwner: boolean;
  level: number | null;
  onCasino: boolean;
  wagerUsd: string;
}

@Injectable()
export class TestProviders {
  private readonly logger = new Logger('TestProviders');
  private ignoredWarned = false;

  constructor(
    private readonly records: ChatRecordsDbOperation,
    private readonly settings: ChatSettingsService,
  ) {}

  /**
   * Whether the test-only stand-ins answer right now. All three conditions, re-read through the 30-second settings
   * cache, so switching the setting off returns every room to the Null behaviour within 30 seconds.
   */
  async standInsActive(): Promise<boolean> {
    const settingOn = (await this.settings.global()).testProviders.enabled;
    if (!settingOn) return false;
    const allowed =
      process.env.CHAT_ALLOW_TEST_PROVIDERS === 'true' && process.env.NODE_ENV !== 'production';
    if (!allowed && !this.ignoredWarned) {
      this.ignoredWarned = true;
      this.logger.error(
        {
          nodeEnv: process.env.NODE_ENV,
          allowTestProviders: process.env.CHAT_ALLOW_TEST_PROVIDERS,
        },
        'chat setting testProviders.enabled is on but ignored: stand-ins need CHAT_ALLOW_TEST_PROVIDERS=true outside production',
      );
    }
    return allowed;
  }

  async standIn(userId: string): Promise<StandIn | null> {
    const row = await this.records.testEntitlement(userId);
    if (!row) {
      return {
        premiumPlanIds: [],
        kycLevel: 0,
        isSiteOwner: false,
        level: 0,
        onCasino: false,
        wagerUsd: '0',
      };
    }
    return {
      premiumPlanIds: row.premiumPlanIds,
      kycLevel: row.kycLevel ?? 0,
      isSiteOwner: row.isSiteOwner,
      level: row.level ?? 0,
      onCasino: row.onCasino,
      wagerUsd: usdStored(row.wagerUsd),
    };
  }
}
