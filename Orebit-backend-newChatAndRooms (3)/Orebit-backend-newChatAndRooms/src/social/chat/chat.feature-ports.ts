import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TwoFactorService } from '../../2fa/2fa.service';
import { TestProviders } from './chat.test-providers';
import { ChatRecordsDbOperation } from './persistence/chat.records.dboperation';
import type { PriceAdd } from './chat.features.contract';

// Decoupled ports for external features: transfers, ad charges, 2FA/PIN verification, and coupons.
export type VerificationMethod = 'TWO_FA' | 'PAYMENT_PIN';

export type TransferQuote =
  | {
      readonly ok: true;
      // Decimal strings.
      readonly usdValue: string;
      readonly feeAmount: string;
      // Transfer limits in USD, or null if unrestricted.
      readonly minUsd: string | null;
      readonly maxUsd: string | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface TransferPort {
  // Quotes transfer fees and exchange value.
  quote(input: {
    senderId: string;
    recipientId: string;
    currency: string;
    amount: string;
    kind?: string;
  }): Promise<TransferQuote>;
  // Moves the money. Reference is the gift id to prevent duplicate execution.
  transfer(input: {
    reference: string;
    senderId: string;
    recipientId: string;
    currency: string;
    amount: string;
    kind?: string;
  }): Promise<
    | { status: 'COMPLETED'; reference: string }
    | { status: 'FAILED'; reason: string }
    | { status: 'ON_HOLD'; holdId: string }
  >;
  // Available currencies and limits for the sender.
  currencies?(
    userId?: string,
  ): Promise<{ currency: string; min: string | null; max: string | null }[]>;
  // Checks status of a pending transfer reference.
  status(
    reference: string,
  ): Promise<
    | { state: 'COMPLETED'; reference: string }
    | { state: 'FAILED'; reason: string }
    | { state: 'NOT_FOUND' }
    | { state: 'UNKNOWN' }
  >;
  // Checks whether the user is restricted from initiating or receiving transfers.
  isRestricted(userId: string): Promise<boolean>;
  // Reverts transfers with optional fee refund and shortfall handling.
  revert(input: {
    reference: string;
    giftId: string;
    refundFees: boolean;
    shortfall?: 'ZERO' | 'NEGATIVE';
  }): Promise<{ ok: true; actualAmount?: string } | { ok: false; reason: string }>;
}

/** RAIN_DONE: the user who paid for a rain. RAIN_RECEIVED: each recipient (reference is `<rainId>:<userId>`). */
export type RewardKind = 'ADVERT' | 'GIFT' | 'RAIN_DONE' | 'RAIN_RECEIVED';

export interface RewardsPort {
  award(input: {
    userId: string;
    kind: RewardKind;
    reference: string;
    exp: number;
    currency: number;
  }): Promise<boolean>;
  revoke(input: {
    userId: string;
    kind: RewardKind;
    reference: string;
    exp: number;
    currency: number;
  }): Promise<boolean>;
}

// Paying for an ad and handling refunds. Calls are idempotent by reference to avoid duplicate processing.
export interface ChargePort {
  // Reference matches chat ad id.
  charge(input: {
    userId: string;
    usd: string;
    reference: string;
    memo: string;
  }): Promise<{ ok: true; reference: string } | { ok: false; reason: string }>;
  // Refunds unused ad amount with reference tracking.
  refund(input: {
    userId: string;
    usd: string;
    reference: string;
    refundReference: string;
    currency: string | null;
  }): Promise<boolean>;
  // Checks status of a charge by reference.
  status(
    reference: string,
  ): Promise<{ state: 'PAID'; reference: string } | { state: 'NOT_PAID' } | { state: 'UNKNOWN' }>;
}

export interface VerificationPort {
  // Returns verification success or null if method is unavailable.
  verify(userId: string, method: VerificationMethod, code: string): Promise<boolean | null>;
  // Checks if payment PIN is enabled.
  hasPaymentPin?(userId: string): Promise<boolean>;
}

export interface FollowPort {
  // Returns mutual follow relations between user and specified users.
  relations(
    userId: string,
    others: readonly string[],
  ): Promise<Map<string, { following: boolean; followedBy: boolean }>>;
}

// Queries user activity across configured platform features.
export interface UserHistoryPort {
  history(input: {
    userId: string;
    // null represents all available features.
    features: readonly string[] | null;
    sinceDays: number;
    limit: number;
    cursor: string | null;
  }): Promise<{
    items: { feature: string; at: string; summary: string; detail?: Record<string, unknown> }[];
    nextCursor: string | null;
  }>;
}

// Gift card metadata display representation.
export interface CouponCard {
  readonly title: string;
  readonly amount: string;
  readonly currency: string;
  readonly expiresAt: string | null;
}

export interface CouponPort {
  // Returns active coupon details for user.
  describe(userId: string, couponId: string): Promise<CouponCard | null>;
  // Transfers coupon to recipient using message id for idempotency.
  give(input: {
    reference: string;
    couponId: string;
    fromUserId: string;
    toUserId: string;
  }): Promise<{ status: 'COMPLETED' } | { status: 'FAILED'; reason: string }>;
}

export interface AdvertisingPort {
  // Checks URL against global blacklist.
  isUrlBlacklisted(url: string): Promise<boolean>;
  // Checks text against blocked word list.
  hasBlockedWord(text: string): Promise<boolean>;
  // Returns cancellation fee configuration if configured.
  cancellationFee?(): Promise<PriceAdd | null>;
}

export interface CurrencyCatalogPort {
  // Checks whether coin is enabled and valid for specific operation.
  isUsable(input: {
    userId?: string;
    currency: string;
    purpose: 'RAIN_SEND' | 'RAIN_RECEIVE' | 'AD_PAYMENT';
  }): Promise<boolean>;
}

export interface BenefitDiscountPort {
  // Computes loyalty or VIP discount applicable to ad quotation.
  discountFor(userId: string, totalUsd: string): Promise<{ percent?: number; usd?: string } | null>;
}

export interface LeaderboardPort {
  // Records ad spend or refund adjustment on leaderboard.
  recordAdSpend(input: { userId: string; usd: string; adId: string }): Promise<void>;
}

export interface PremiumPort {
  // Checks if user subscription includes ad suppression.
  hasDisableAllAds(userId: string): Promise<boolean>;
}

export const CHAT_ADVERTISING_PORT = Symbol('CHAT_ADVERTISING_PORT');
export const CHAT_CURRENCY_CATALOG_PORT = Symbol('CHAT_CURRENCY_CATALOG_PORT');
export const CHAT_BENEFIT_DISCOUNT_PORT = Symbol('CHAT_BENEFIT_DISCOUNT_PORT');
export const CHAT_LEADERBOARD_PORT = Symbol('CHAT_LEADERBOARD_PORT');
export const CHAT_PREMIUM_PORT = Symbol('CHAT_PREMIUM_PORT');
export const CHAT_COUPON_PORT = Symbol('CHAT_COUPON_PORT');
export const CHAT_USER_HISTORY_PORT = Symbol('CHAT_USER_HISTORY_PORT');
export const CHAT_TRANSFER_PORT = Symbol('CHAT_TRANSFER_PORT');
export const CHAT_CHARGE_PORT = Symbol('CHAT_CHARGE_PORT');
export const CHAT_VERIFICATION_PORT = Symbol('CHAT_VERIFICATION_PORT');
export const CHAT_FOLLOW_PORT = Symbol('CHAT_FOLLOW_PORT');
export const CHAT_REWARDS_PORT = Symbol('CHAT_REWARDS_PORT');

// Test stand-in verification code.
export const STAND_IN_CODE = '000000';

@Injectable()
export class ChatFeaturePorts {
  private readonly logger = new Logger('ChatFeaturePorts');

  constructor(
    private readonly testProviders: TestProviders,
    private readonly records: ChatRecordsDbOperation,
    private readonly twoFactor: TwoFactorService,
    @Optional()
    @Inject(CHAT_TRANSFER_PORT)
    private readonly transferPort?: TransferPort,
    @Optional()
    @Inject(CHAT_CHARGE_PORT)
    private readonly chargePort?: ChargePort,
    @Optional()
    @Inject(CHAT_VERIFICATION_PORT)
    private readonly verificationPort?: VerificationPort,
    @Optional()
    @Inject(CHAT_FOLLOW_PORT)
    private readonly followPort?: FollowPort,
    @Optional() @Inject(CHAT_REWARDS_PORT) private readonly rewardsPort?: RewardsPort,
    @Optional() @Inject(CHAT_USER_HISTORY_PORT) private readonly userHistoryPort?: UserHistoryPort,
    @Optional() @Inject(CHAT_COUPON_PORT) private readonly couponPort?: CouponPort,
    @Optional() @Inject(CHAT_ADVERTISING_PORT) private readonly advertisingPort?: AdvertisingPort,
    @Optional() @Inject(CHAT_CURRENCY_CATALOG_PORT) private readonly currencyCatalogPort?: CurrencyCatalogPort,
    @Optional() @Inject(CHAT_BENEFIT_DISCOUNT_PORT) private readonly benefitDiscountPort?: BenefitDiscountPort,
    @Optional() @Inject(CHAT_LEADERBOARD_PORT) private readonly leaderboardPort?: LeaderboardPort,
    @Optional() @Inject(CHAT_PREMIUM_PORT) private readonly premiumPort?: PremiumPort,
  ) {}

  private standIns(): Promise<boolean> {
    return this.testProviders.standInsActive();
  }

  /** The user history provider, or null while no feature module binds it. */
  userHistory(): UserHistoryPort | null {
    return this.userHistoryPort ?? null;
  }

  /** The transfer provider, a stand-in in test mode, or null. */
  async transfer(): Promise<TransferPort | null> {
    if (this.transferPort) return this.transferPort;
    if (!(await this.standIns())) return null;
    return {
      quote: async ({ amount }) => ({
        ok: true,
        usdValue: amount,
        feeAmount: '0',
        minUsd: null,
        maxUsd: null,
      }),
      transfer: async ({ reference }) => {
        this.logger.warn({ reference }, 'test stand-in completed a gift without moving money');
        return { status: 'COMPLETED', reference: `TEST-${reference}` };
      },
      status: async (reference) => ({ state: 'COMPLETED', reference: `TEST-${reference}` }),
      isRestricted: async () => false,
      currencies: async () => [
        { currency: 'USDT', min: null, max: null },
        { currency: 'BTC', min: null, max: null },
      ],
      revert: async ({ giftId, shortfall }) => {
        this.logger.warn({ giftId, shortfall }, 'test stand-in reverted a gift without moving money');
        return { ok: true };
      },
    };
  }

  /** The advertising provider, a stand-in in test mode, or null. */
  async advertising(): Promise<AdvertisingPort | null> {
    if (this.advertisingPort) return this.advertisingPort;
    if (!(await this.standIns())) return null;
    return {
      isUrlBlacklisted: async (url) => url.includes('blacklisted.example.com'),
      hasBlockedWord: async (text) => text.toUpperCase().includes('GLOBAL_BLOCKED_WORD'),
      cancellationFee: async () => null,
    };
  }

  /** The currency catalog provider, a stand-in in test mode, or null. */
  async currencyCatalog(): Promise<CurrencyCatalogPort | null> {
    if (this.currencyCatalogPort) return this.currencyCatalogPort;
    if (!(await this.standIns())) return null;
    return {
      isUsable: async ({ currency }) => currency !== 'DELISTED_COIN',
    };
  }

  /** The benefit discount provider, a stand-in in test mode, or null. */
  async benefitDiscounts(): Promise<BenefitDiscountPort | null> {
    if (this.benefitDiscountPort) return this.benefitDiscountPort;
    if (!(await this.standIns())) return null;
    return {
      discountFor: async () => null,
    };
  }

  /** The leaderboard provider, a stand-in in test mode, or null. */
  async leaderboard(): Promise<LeaderboardPort | null> {
    if (this.leaderboardPort) return this.leaderboardPort;
    if (!(await this.standIns())) return null;
    return {
      recordAdSpend: async (input) => {
        this.logger.log({ ...input }, 'test stand-in recorded ad spend');
      },
    };
  }

  /** The premium provider, a stand-in in test mode, or null. */
  async premium(): Promise<PremiumPort | null> {
    if (this.premiumPort) return this.premiumPort;
    if (!(await this.standIns())) return null;
    return {
      hasDisableAllAds: async () => false,
    };
  }

  /** The gift-card provider, a stand-in in test mode, or null. */
  async coupons(): Promise<CouponPort | null> {
    if (this.couponPort) return this.couponPort;
    if (!(await this.standIns())) return null;
    return {
      describe: async () => ({ title: 'Test gift card', amount: '5', currency: 'USDT', expiresAt: null }),
      give: async ({ reference }) => {
        this.logger.warn({ reference }, 'test stand-in gave a gift card without moving it');
        return { status: 'COMPLETED' };
      },
    };
  }

  /** The rewards provider, a logging stand-in in test mode, or null. */
  async rewards(): Promise<RewardsPort | null> {
    if (this.rewardsPort) return this.rewardsPort;
    if (!(await this.standIns())) return null;
    return {
      award: async (input) => {
        this.logger.log({ ...input }, 'test stand-in awarded chat rewards');
        return true;
      },
      revoke: async (input) => {
        this.logger.log({ ...input }, 'test stand-in revoked chat rewards');
        return true;
      },
    };
  }

  async charge(): Promise<ChargePort | null> {
    if (this.chargePort) return this.chargePort;
    if (!(await this.standIns())) return null;
    return {
      charge: async ({ reference }) => ({ ok: true, reference: `TEST-${reference}` }),
      refund: async () => true,
      status: async (reference) => ({ state: 'PAID', reference: `TEST-${reference}` }),
    };
  }

  /**
   * True / false for the code, or null when the method is not available. 2FA uses the platform's TOTP check unless a
   * provider is bound; in test mode the stand-in code is also accepted.
   */
  async verify(userId: string, method: VerificationMethod, code: string): Promise<boolean | null> {
    if (this.verificationPort) {
      const answer = await this.verificationPort.verify(userId, method, code);
      if (answer !== null) return answer;
    }
    if (await this.standIns()) return code === STAND_IN_CODE;
    if (method === 'TWO_FA') return this.twoFactor.proveTotpCode(userId, code);
    return null;
  }

  // Checks whether the user has enabled payment PIN.
  async hasPaymentPin(userId: string): Promise<boolean> {
    if (this.verificationPort?.hasPaymentPin) {
      return this.verificationPort.hasPaymentPin(userId);
    }
    if (await this.standIns()) return true;
    return false;
  }

  // Returns follow relationships between user and others.
  async follows(
    userId: string,
    others: readonly string[],
  ): Promise<Map<string, { following: boolean; followedBy: boolean }>> {
    if (others.length === 0) return new Map();
    if (this.followPort) return this.followPort.relations(userId, others);
    const out = new Map(others.map((id) => [id, { following: false, followedBy: false }]));
    if (!(await this.standIns())) return out;
    const lists = await this.records.testFollows([userId, ...others]);
    const mine = new Set(lists.get(userId) ?? []);
    for (const id of others) {
      out.set(id, { following: mine.has(id), followedBy: (lists.get(id) ?? []).includes(userId) });
    }
    return out;
  }

  // Checks mutual friendship (both users follow each other).
  async areFriends(userId: string, otherId: string): Promise<boolean> {
    const relation = (await this.follows(userId, [otherId])).get(otherId);
    return Boolean(relation?.following && relation.followedBy);
  }
}
