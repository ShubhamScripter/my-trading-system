import { Inject, Injectable, Optional } from '@nestjs/common';
import { ChatDbOperation } from './chat.dboperation';
import { TestProviders } from './chat.test-providers';

// Decoupled ports for external user facts: country, premium plans, KYC, site ownership, and casino play.
export interface CountryPort {
  // The user's effective country (Settings [Security] #49), ISO-2, or null.
  effectiveCountry(userId: string): Promise<string | null>;
}
export interface PremiumPort {
  // Ids of the user's ACTIVE premium plans ([] = none), or null when not connected.
  activePlanIds(userId: string): Promise<string[] | null>;
  // Whether the user's subscription disables chat ads.
  hasDisableAllAds(userId: string): Promise<boolean>;
}
export interface KycPort {
  // The user's KYC level (0 = none), or null when not connected.
  kycLevel(userId: string): Promise<number | null>;
  // RainPool "Request KYC Check": the KYC just completed matches the account's original KYC ("it should match with
// original account KYC"). Null when the KYC module cannot tell.
  matchesOriginalKyc?(userId: string): Promise<boolean | null>;
}
export interface FeatureAccessPort {
  // The KYC per-level chat entitlements: may use public chat, and which rooms (null = all). Null when not connected.
  chatEntitlements(
    userId: string,
  ): Promise<{ publicChat: boolean; roomIds: string[] | null } | null>;
  // The KYC per-level Rainpool entitlements: may receive rains, may rain. Null when not connected.
  rainEntitlements?(userId: string): Promise<{ eligible: boolean; canRain: boolean } | null>;
}
export interface MerchantPort {
  // The EARNED site-owner status, or null when not connected.
  isSiteOwner(userId: string): Promise<boolean | null>;
  // Chat MAIN "SO / Merchants: … sorted separately by apps": the merchant's apps, or null when the merchant module
// cannot tell.
  apps?(userId: string): Promise<{ id: string; name: string }[] | null>;
}
export interface CasinoPort {
  // Whether the user is on OREBiT Play right now, or null when not connected.
  isOnCasino(userId: string): Promise<boolean | null>;
  // The user's wager over the last `lastDays` days in USD (decimal string, 8 decimals), or null.
  wagerUsd(userId: string, lastDays: number): Promise<string | null>;
}
export interface LevelPort {
  level(userId: string): Promise<number | null>;
}
export interface TimeZonePort {
  // The IANA time zone of the user's account (Auth / User settings, ), or null when not set.
  timeZones(userIds: readonly string[]): Promise<Map<string, string | null>>;
}

export const CHAT_COUNTRY_PORT = Symbol('CHAT_COUNTRY_PORT');
export const CHAT_PREMIUM_PORT = Symbol('CHAT_PREMIUM_PORT');
export const CHAT_KYC_PORT = Symbol('CHAT_KYC_PORT');
export const CHAT_FEATURE_ACCESS_PORT = Symbol('CHAT_FEATURE_ACCESS_PORT');
export const CHAT_MERCHANT_PORT = Symbol('CHAT_MERCHANT_PORT');
export const CHAT_CASINO_PORT = Symbol('CHAT_CASINO_PORT');
export const CHAT_LEVEL_PORT = Symbol('CHAT_LEVEL_PORT');
export const CHAT_TIMEZONE_PORT = Symbol('CHAT_TIMEZONE_PORT');

// The interim country provider: the registration country, read-only from identity.users, until the Auth/User
// module provides the effective country. Binding CHAT_COUNTRY_PORT replaces it with no other change.
@Injectable()
export class RegistrationCountryProvider implements CountryPort {
  constructor(private readonly db: ChatDbOperation) {}

  effectiveCountry(userId: string): Promise<string | null> {
    return this.db.registrationCountry(userId);
  }
}

// Everything a port can tell chat about one user, fetched together.
export interface PortFacts {
  country: string | null;
  premiumPlanIds: string[] | null;
  kycLevel: number | null;
  kycEntitlements: { publicChat: boolean; roomIds: string[] | null } | null;
  isSiteOwner: boolean | null;
  level: number | null;
}

@Injectable()
export class ChatPorts {
  private readonly zoneCache = new Map<string, { value: string | null; at: number }>();
  constructor(
    private readonly testProviders: TestProviders,
    private readonly registrationCountry: RegistrationCountryProvider,
    @Optional() @Inject(CHAT_COUNTRY_PORT) private readonly country?: CountryPort,
    @Optional() @Inject(CHAT_PREMIUM_PORT) private readonly premium?: PremiumPort,
    @Optional() @Inject(CHAT_KYC_PORT) private readonly kyc?: KycPort,
    @Optional()
    @Inject(CHAT_FEATURE_ACCESS_PORT)
    private readonly featureAccess?: FeatureAccessPort,
    @Optional() @Inject(CHAT_MERCHANT_PORT) private readonly merchant?: MerchantPort,
    @Optional() @Inject(CHAT_CASINO_PORT) private readonly casino?: CasinoPort,
    @Optional() @Inject(CHAT_LEVEL_PORT) private readonly levels?: LevelPort,
    @Optional() @Inject(CHAT_TIMEZONE_PORT) private readonly zones?: TimeZonePort,
  ) {}

  // The account time zone of each user, null where it is unknown or the Auth / User module is not connected. Quiet
// hours apply only to users with a zone: there is no UTC fallback.
  async accountTimeZones(userIds: readonly string[]): Promise<Map<string, string | null>> {
    const now = Date.now();
    const out = new Map<string, string | null>();
    const missing: string[] = [];
    for (const id of userIds) {
      const hit = this.zoneCache.get(id);
      if (hit && now - hit.at < 60_000) out.set(id, hit.value);
      else missing.push(id);
    }
    if (!this.zones) {
      for (const id of missing) out.set(id, null);
      return out;
    }
    const zones = this.zones;
    if (missing.length > 0) {
      const batch = await zones.timeZones(missing).catch(() => new Map<string, string | null>());
      for (const id of missing) {
        const value = batch.get(id) ?? null;
        out.set(id, value);
        this.zoneCache.set(id, { value, at: now });
      }
    }
    if (this.zoneCache.size > 50_000) this.zoneCache.clear();
    return out;
  }

  // Every non-casino fact for one user. Casino facts are asked separately, and only for casino rooms.
  async facts(userId: string): Promise<PortFacts> {
    const [country, stand] = await Promise.all([
      (this.country ?? this.registrationCountry).effectiveCountry(userId),
      this.testProviders
        .standInsActive()
        .then((on) => (on ? this.testProviders.standIn(userId) : null)),
    ]);

    if (stand) {
      return {
        country,
        premiumPlanIds: stand.premiumPlanIds,
        kycLevel: stand.kycLevel,
        // The stand-in KYC level opens KYC rooms; per-level entitlements are the KYC module's and stay unconnected.
        kycEntitlements: null,
        isSiteOwner: stand.isSiteOwner,
        level: stand.level,
      };
    }

    const [premiumPlanIds, kycLevel, kycEntitlements, isSiteOwner, level] = await Promise.all([
      this.premium ? this.premium.activePlanIds(userId) : Promise.resolve(null),
      this.kyc ? this.kyc.kycLevel(userId) : Promise.resolve(null),
      this.featureAccess ? this.featureAccess.chatEntitlements(userId) : Promise.resolve(null),
      this.merchant ? this.merchant.isSiteOwner(userId) : Promise.resolve(null),
      this.levels ? this.levels.level(userId) : Promise.resolve(null),
    ]);
    return { country, premiumPlanIds, kycLevel, kycEntitlements, isSiteOwner, level };
  }

  async casinoFacts(
    userId: string,
    windowDays: number,
  ): Promise<{ onCasino: boolean; wagerUsd: string } | null> {
    if (await this.testProviders.standInsActive()) {
      const stand = await this.testProviders.standIn(userId);
      return stand ? { onCasino: stand.onCasino, wagerUsd: stand.wagerUsd } : null;
    }
    if (!this.casino) return null;
    const [onCasino, wagerUsd] = await Promise.all([
      this.casino.isOnCasino(userId),
      this.casino.wagerUsd(userId, windowDays),
    ]);
    if (onCasino === null) return null;
    return { onCasino, wagerUsd: wagerUsd ?? '0' };
  }

  // A merchant's apps (id and name); null when the merchant module does not tell.
  async merchantApps(userId: string): Promise<{ id: string; name: string }[] | null> {
    if (!this.merchant?.apps) return null;
    return this.merchant.apps(userId);
  }

  // Rainpool entitlements of the user's KYC level; null when the KYC module does not tell (then nothing is limited).
  async rainEntitlements(userId: string): Promise<{ eligible: boolean; canRain: boolean } | null> {
    if (!this.featureAccess?.rainEntitlements) return null;
    return this.featureAccess.rainEntitlements(userId);
  }

  // Whether the user's KYC matches the account's original KYC; null when the KYC module cannot tell.
  async kycMatchesOriginal(userId: string): Promise<boolean | null> {
    if (!this.kyc?.matchesOriginalKyc) return null;
    return this.kyc.matchesOriginalKyc(userId);
  }

  // Whether a real Premium provider is bound (the admin may bind rooms to plans only then, or with stand-ins).
  premiumConnected(): boolean {
    return this.premium !== undefined;
  }
}
