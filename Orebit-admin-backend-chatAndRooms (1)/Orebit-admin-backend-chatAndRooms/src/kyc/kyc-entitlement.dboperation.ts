import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/client';

/**
 * ═══ WRITES OF WHAT A KYC LEVEL GRANTS ══════════════════════════════════════
 *
 * `identity.kyc_level_entitlements` and `identity.kyc_upgrade_requirements` belong to
 * ../Orebit-backend, which READS them on every KYC status request. This service
 * configures them and never reads them for a decision.
 *
 * Raw, schema-qualified SQL, and neither table is modelled in this repository's
 * `db/schema.prisma` — that datasource is `schemas = ["admin"]` on purpose.
 * `KycPolicyDbOperation`'s reasoning applies unchanged: two Prisma clients modelling one
 * table is two sources of truth, and whichever migrates second wins. The consequence is
 * the same too — a column renamed over there breaks this writer and neither
 * repository's type system will say so. `tests/kyc/kyc.drift.spec.ts` is the only guard.
 *
 * ═══ WHAT THIS FILE CANNOT REACH, BY CONSTRUCTION ═══════════════════════════
 *
 * Three tables and nothing else. There is no statement here naming
 * `kyc_verifications`, `kyc_level_states`, `kyc_verification_devices`,
 * `kyc_provider_events`, `kyc_requirements`, `kyc_exemptions`, `kyc_policies`,
 * `kyc_renewal_settings` or `users`, and `tests/kyc/kyc.postgres.spec.ts` asserts it
 * structurally rather than trusting it.
 *
 * ⚠ `kyc_upgrade_achievements` IS READ but NEVER WRITTEN, and that is the sharpest line
 *   on this surface. An achievement is an OBSERVATION of a balance — only the consumer,
 *   which holds the account-data port, can make one. An admin able to grant one could
 *   open an upgrade route nobody earned, and unlike an exemption it would carry no
 *   reason, no expiry and no revocation path. The read exists so an operator lowering a
 *   threshold can see how many accounts already cleared the old one; there is no INSERT,
 *   UPDATE or DELETE against that table anywhere in this repository.
 *
 * ═══ TWO TABLES, TWO WRITE SHAPES, AND THE ASYMMETRY IS DELIBERATE ══════════
 *
 *   kyc_level_entitlements     seeded by the consumer's migration, one row per level,
 *                              so every write is an UPDATE with compare-and-swap and
 *                              there is no create path at all
 *   kyc_upgrade_requirements   NOT seeded, because an absent row means "this route is
 *                              not offered" — a real answer rather than a gap — so
 *                              `expectedVersion: 0` creates
 *
 * Neither has a companion versions table. The consumer's schema states why: the
 * entitlement matrix is seventy-one columns, and mirroring them into a history table
 * would double every migration and create seventy-one places for the live row and its
 * log to drift. `KYC_ENTITLEMENTS_UPDATED` in the admin audit log is the history, which
 * is the same trade `kyc_renewal_settings` already makes.
 */

/** One entitlement row as the database returns it. Amounts come back as strings —
 *  `::text` on every numeric, so `Prisma.Decimal` never enters this service. */
export interface KycEntitlementRow {
  readonly level: string;
  readonly configured: boolean;
  readonly version: number;

  readonly withdrawal_limit: string | null;
  readonly exchange_limit: string | null;
  readonly balance_limit: string | null;
  readonly limit_currency: string | null;

  readonly profile_links_enabled: boolean;

  readonly wallet_disabled_currencies: string[];

  readonly deposit_on_ramp_enabled: boolean;
  readonly deposit_off_ramp_enabled: boolean;

  readonly withdraw_enabled: boolean;
  readonly withdraw_max_per_transaction: string | null;
  readonly withdraw_amount_limit: string | null;
  readonly withdraw_count_limit: number | null;
  readonly withdraw_limit_window_seconds: number | null;
  readonly withdraw_minimum_gap_seconds: number | null;
  readonly withdraw_security_threshold: string | null;

  readonly exchange_enabled: boolean;
  readonly exchange_min_amount: string | null;
  readonly exchange_max_amount: string | null;
  readonly exchange_max_per_exchange: string | null;
  readonly exchange_small_enabled: boolean;
  readonly exchange_multi_coin_enabled: boolean;
  readonly exchange_available_coins: string[];

  readonly transfer_enabled: boolean;
  readonly transfer_min_amount: string | null;
  readonly transfer_max_amount: string | null;
  readonly transfer_max_per_transfer: string | null;
  readonly transfer_max_per_user: string | null;

  readonly staking_enabled: boolean;
  readonly staking_available_coins: string[];
  readonly staking_flexible_enabled: boolean;
  readonly staking_locked_enabled: boolean;

  readonly merchant_enabled: boolean;
  readonly merchant_max_websites_or_apps: number | null;

  readonly tools_bulk_payment_enabled: boolean;
  readonly tools_tip_box_enabled: boolean;
  readonly tools_max_tip_boxes: number | null;
  readonly tools_invoice_generator_enabled: boolean;
  readonly tools_max_active_invoices: number | null;

  readonly referral_enabled: boolean;
  readonly referral_allowed_divisions: string[];
  readonly referral_allowed_tiers: string[];
  readonly referral_max_active_links: number | null;

  readonly rainpool_eligible: boolean;
  readonly rainpool_can_rain: boolean;

  readonly ptc_can_view_ads: boolean;
  readonly ptc_can_advertise: boolean;

  readonly tasks_can_participate: boolean;
  readonly tasks_can_advertise: boolean;
  readonly tasks_allowed_providers: string[];

  readonly premium_can_purchase: boolean;
  readonly premium_can_gift: boolean;

  readonly short_link_enabled: boolean;

  readonly advertising_enabled: boolean;

  readonly coupons_can_create: boolean;
  readonly coupons_can_redeem: boolean;
  readonly coupons_can_purchase_third_party: boolean;

  readonly loyalty_enabled: boolean;

  readonly chat_can_access_public_chat: boolean;
  readonly chat_can_advertise: boolean;
  readonly chat_can_send_money: boolean;
  readonly chat_allowed_rooms: string[];

  readonly ad_exchange_enabled: boolean;

  readonly leaderboard_can_receive_rewards: boolean;

  readonly faucet_enabled: boolean;
  readonly faucet_auto_enabled: boolean;
  readonly faucet_offline_enabled: boolean;

  readonly bankroll_enabled: boolean;
  readonly bankroll_max_investment: string | null;

  readonly updated_by_admin_id: string | null;
  readonly reason: string | null;
  readonly updated_at: Date;
}

export interface KycUpgradeRequirementRow {
  readonly target_level: string;
  readonly version: number;
  readonly minimum_balance: string | null;
  readonly deposit_threshold: string | null;
  readonly deposit_window_days: number | null;
  readonly threshold_currency: string | null;
  readonly updated_by_admin_id: string | null;
  readonly reason: string | null;
  readonly updated_at: Date;
}

/** The flat write input. Flat rather than nested, so the SQL below is a straight
 *  column-to-parameter mapping — the service owns the un-nesting. */
export interface KycEntitlementWriteInput {
  readonly level: string;
  readonly reason: string;
  readonly actorAdminId: string;
  readonly expectedVersion: number;
  readonly values: KycEntitlementValues;
}

/** Every configurable column, in table order. */
export interface KycEntitlementValues {
  readonly withdrawalLimit: string | null;
  readonly exchangeLimit: string | null;
  readonly balanceLimit: string | null;
  readonly limitCurrency: string | null;
  readonly profileLinksEnabled: boolean;
  readonly walletDisabledCurrencies: readonly string[];
  readonly depositOnRampEnabled: boolean;
  readonly depositOffRampEnabled: boolean;
  readonly withdrawEnabled: boolean;
  readonly withdrawMaxPerTransaction: string | null;
  readonly withdrawAmountLimit: string | null;
  readonly withdrawCountLimit: number | null;
  readonly withdrawLimitWindowSeconds: number | null;
  readonly withdrawMinimumGapSeconds: number | null;
  readonly withdrawSecurityThreshold: string | null;
  readonly exchangeEnabled: boolean;
  readonly exchangeMinAmount: string | null;
  readonly exchangeMaxAmount: string | null;
  readonly exchangeMaxPerExchange: string | null;
  readonly exchangeSmallEnabled: boolean;
  readonly exchangeMultiCoinEnabled: boolean;
  readonly exchangeAvailableCoins: readonly string[];
  readonly transferEnabled: boolean;
  readonly transferMinAmount: string | null;
  readonly transferMaxAmount: string | null;
  readonly transferMaxPerTransfer: string | null;
  readonly transferMaxPerUser: string | null;
  readonly stakingEnabled: boolean;
  readonly stakingAvailableCoins: readonly string[];
  readonly stakingFlexibleEnabled: boolean;
  readonly stakingLockedEnabled: boolean;
  readonly merchantEnabled: boolean;
  readonly merchantMaxWebsitesOrApps: number | null;
  readonly toolsBulkPaymentEnabled: boolean;
  readonly toolsTipBoxEnabled: boolean;
  readonly toolsMaxTipBoxes: number | null;
  readonly toolsInvoiceGeneratorEnabled: boolean;
  readonly toolsMaxActiveInvoices: number | null;
  readonly referralEnabled: boolean;
  readonly referralAllowedDivisions: readonly string[];
  readonly referralAllowedTiers: readonly string[];
  readonly referralMaxActiveLinks: number | null;
  readonly rainpoolEligible: boolean;
  readonly rainpoolCanRain: boolean;
  readonly ptcCanViewAds: boolean;
  readonly ptcCanAdvertise: boolean;
  readonly tasksCanParticipate: boolean;
  readonly tasksCanAdvertise: boolean;
  readonly tasksAllowedProviders: readonly string[];
  readonly premiumCanPurchase: boolean;
  readonly premiumCanGift: boolean;
  readonly shortLinkEnabled: boolean;
  readonly advertisingEnabled: boolean;
  readonly couponsCanCreate: boolean;
  readonly couponsCanRedeem: boolean;
  readonly couponsCanPurchaseThirdParty: boolean;
  readonly loyaltyEnabled: boolean;
  readonly chatCanAccessPublicChat: boolean;
  readonly chatCanAdvertise: boolean;
  readonly chatCanSendMoney: boolean;
  readonly chatAllowedRooms: readonly string[];
  readonly adExchangeEnabled: boolean;
  readonly leaderboardCanReceiveRewards: boolean;
  readonly faucetEnabled: boolean;
  readonly faucetAutoEnabled: boolean;
  readonly faucetOfflineEnabled: boolean;
  readonly bankrollEnabled: boolean;
  readonly bankrollMaxInvestment: string | null;
}

export interface KycUpgradeWriteInput {
  readonly targetLevel: string;
  readonly minimumBalance: string | null;
  readonly depositThreshold: string | null;
  readonly depositWindowDays: number | null;
  readonly thresholdCurrency: string | null;
  readonly reason: string;
  readonly actorAdminId: string;
  readonly expectedVersion: number;
}

/**
 * The outcome of a compare-and-swap write.
 *
 * `written: false` is a LOST SWAP, not a failure: somebody else changed the row since
 * the caller read it. The service turns it into a 400 telling the operator to re-read,
 * which is the shape `KycPolicyService.assertWritten` uses.
 */
export interface KycEntitlementWriteOutcome {
  readonly written: boolean;
}

/**
 * How many accounts already cleared a minimum balance for one target.
 *
 * A pure READ, and the only thing this service ever asks of
 * `kyc_upgrade_achievements`. It answers the one operational question a threshold change
 * raises — "who is already through" — and it answers it narrowly: a count, never the
 * rows, because copying account identifiers into an audit payload would duplicate the
 * data the audit exists to govern.
 *
 * ⚠ Lowering a threshold does NOT retroactively create achievements, and raising one
 *   does not remove them. This count is the population that already holds a row, which
 *   is exactly the population a change cannot affect.
 */
export interface KycUpgradeAchievementImpact {
  readonly accountsAlreadyAchieved: number;
}

@Injectable()
export class KycEntitlementDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every entitlement row, in rank order.
   *
   * `::text` on every numeric column, so an exact decimal reaches this service as a
   * STRING and `Prisma.Decimal` never exists here. The ledger already hands out
   * `balance::text` for the same reason, and the consumer projects with `.toFixed()`
   * from the other side.
   *
   * Ordered by the level ladder rather than alphabetically — `L1`, `L2`, `NONE` sorts
   * wrong, and a config screen renders least-privileged first.
   */
  async listEntitlements(): Promise<KycEntitlementRow[]> {
    return this.prisma.$queryRaw<KycEntitlementRow[]>`
      SELECT "level", "configured", "version",
             "withdrawal_limit"::text, "exchange_limit"::text, "balance_limit"::text,
             "limit_currency",
             "profile_links_enabled",
             "wallet_disabled_currencies",
             "deposit_on_ramp_enabled", "deposit_off_ramp_enabled",
             "withdraw_enabled",
             "withdraw_max_per_transaction"::text, "withdraw_amount_limit"::text,
             "withdraw_count_limit", "withdraw_limit_window_seconds",
             "withdraw_minimum_gap_seconds", "withdraw_security_threshold"::text,
             "exchange_enabled",
             "exchange_min_amount"::text, "exchange_max_amount"::text,
             "exchange_max_per_exchange"::text,
             "exchange_small_enabled", "exchange_multi_coin_enabled",
             "exchange_available_coins",
             "transfer_enabled",
             "transfer_min_amount"::text, "transfer_max_amount"::text,
             "transfer_max_per_transfer"::text, "transfer_max_per_user"::text,
             "staking_enabled", "staking_available_coins",
             "staking_flexible_enabled", "staking_locked_enabled",
             "merchant_enabled", "merchant_max_websites_or_apps",
             "tools_bulk_payment_enabled",
             "tools_tip_box_enabled", "tools_max_tip_boxes",
             "tools_invoice_generator_enabled", "tools_max_active_invoices",
             "referral_enabled", "referral_allowed_divisions",
             "referral_allowed_tiers", "referral_max_active_links",
             "rainpool_eligible", "rainpool_can_rain",
             "ptc_can_view_ads", "ptc_can_advertise",
             "tasks_can_participate", "tasks_can_advertise", "tasks_allowed_providers",
             "premium_can_purchase", "premium_can_gift",
             "short_link_enabled",
             "advertising_enabled",
             "coupons_can_create", "coupons_can_redeem",
             "coupons_can_purchase_third_party",
             "loyalty_enabled",
             "chat_can_access_public_chat", "chat_can_advertise",
             "chat_can_send_money", "chat_allowed_rooms",
             "ad_exchange_enabled",
             "leaderboard_can_receive_rewards",
             "faucet_enabled", "faucet_auto_enabled", "faucet_offline_enabled",
             "bankroll_enabled", "bankroll_max_investment"::text,
             "updated_by_admin_id", "reason", "updated_at"
        FROM "identity"."kyc_level_entitlements"
       ORDER BY CASE "level" WHEN 'NONE' THEN 0 WHEN 'L1' THEN 1 ELSE 2 END`;
  }

  /** Every CONFIGURED upgrade route. An absent target means "no route offered". */
  async listUpgradeRequirements(): Promise<KycUpgradeRequirementRow[]> {
    return this.prisma.$queryRaw<KycUpgradeRequirementRow[]>`
      SELECT "target_level", "version",
             "minimum_balance"::text, "deposit_threshold"::text,
             "deposit_window_days", "threshold_currency",
             "updated_by_admin_id", "reason", "updated_at"
        FROM "identity"."kyc_upgrade_requirements"
       ORDER BY "target_level"`;
  }

  /**
   * The live version of one level's row, or null if it is absent.
   *
   * Used only to tell a LOST SWAP from a MISSING ROW when a write matches nothing. The
   * two deserve different messages: the first says "re-read and try again", the second
   * says "this deployment has not run the entitlements migration".
   */
  async findEntitlementVersion(level: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ version: number }>>`
      SELECT "version" FROM "identity"."kyc_level_entitlements" WHERE "level" = ${level}`;
    return rows[0]?.version ?? null;
  }

  async findUpgradeVersion(targetLevel: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ version: number }>>`
      SELECT "version" FROM "identity"."kyc_upgrade_requirements"
       WHERE "target_level" = ${targetLevel}`;
    return rows[0]?.version ?? null;
  }

  /**
   * How many accounts already hold a minimum-balance achievement for one target.
   *
   * See `KycUpgradeAchievementImpact`. Read-only, and the only statement in this
   * repository that names `kyc_upgrade_achievements`.
   */
  async achievementImpact(targetLevel: string): Promise<KycUpgradeAchievementImpact> {
    const rows = await this.prisma.$queryRaw<Array<{ accounts: bigint }>>`
      SELECT count(*) AS "accounts"
        FROM "identity"."kyc_upgrade_achievements"
       WHERE "target_level" = ${targetLevel}`;
    // `count()` is bigint over the wire and serialises to a BigInt, which
    // JSON.stringify refuses outright. Narrowed here so no caller has to know.
    return { accountsAlreadyAchieved: Number(rows[0]?.accounts ?? 0n) };
  }

  /**
   * Write one level's entitlements, with compare-and-swap.
   *
   * ═══ UPDATE ONLY. THERE IS NO CREATE PATH, BY DESIGN ═══════════════════════
   *
   * The consumer's migration seeds one row per level, and
   * `ck_kyc_level_entitlements_level` admits exactly three — so a level row always
   * exists. An INSERT branch here would be unreachable code guarding an invariant the
   * database already holds, and the DTO refuses `expectedVersion: 0` for the same
   * reason.
   *
   * `WHERE "level" = X AND "version" = expected` IS the swap. A concurrent write moves
   * the version, this matches nothing, and the caller is told to re-read rather than
   * having its seventy-one fields silently overwrite somebody else's.
   *
   * `configured = true` is set unconditionally: a deliberate write is exactly what the
   * flag records, and there is no path that sets it back — "an operator once configured
   * this level" does not stop being true.
   *
   * ─── Why one statement and no transaction ────────────────────────────────
   *
   * There is nothing to keep in step with: no versions table, no second row, no
   * derived state. `KycRenewalDbOperation.write` makes the same call for the same
   * reason. The compare-and-swap is atomic because it is one UPDATE.
   */
  async writeEntitlements(
    input: KycEntitlementWriteInput,
  ): Promise<KycEntitlementWriteOutcome> {
    const v = input.values;

    const written = await this.prisma.$executeRaw`
      UPDATE "identity"."kyc_level_entitlements"
         SET "configured" = true,
             "withdrawal_limit" = ${v.withdrawalLimit}::numeric,
             "exchange_limit" = ${v.exchangeLimit}::numeric,
             "balance_limit" = ${v.balanceLimit}::numeric,
             "limit_currency" = ${v.limitCurrency},
             "profile_links_enabled" = ${v.profileLinksEnabled},
             "wallet_disabled_currencies" = ${v.walletDisabledCurrencies as string[]},
             "deposit_on_ramp_enabled" = ${v.depositOnRampEnabled},
             "deposit_off_ramp_enabled" = ${v.depositOffRampEnabled},
             "withdraw_enabled" = ${v.withdrawEnabled},
             "withdraw_max_per_transaction" = ${v.withdrawMaxPerTransaction}::numeric,
             "withdraw_amount_limit" = ${v.withdrawAmountLimit}::numeric,
             "withdraw_count_limit" = ${v.withdrawCountLimit},
             "withdraw_limit_window_seconds" = ${v.withdrawLimitWindowSeconds},
             "withdraw_minimum_gap_seconds" = ${v.withdrawMinimumGapSeconds},
             "withdraw_security_threshold" = ${v.withdrawSecurityThreshold}::numeric,
             "exchange_enabled" = ${v.exchangeEnabled},
             "exchange_min_amount" = ${v.exchangeMinAmount}::numeric,
             "exchange_max_amount" = ${v.exchangeMaxAmount}::numeric,
             "exchange_max_per_exchange" = ${v.exchangeMaxPerExchange}::numeric,
             "exchange_small_enabled" = ${v.exchangeSmallEnabled},
             "exchange_multi_coin_enabled" = ${v.exchangeMultiCoinEnabled},
             "exchange_available_coins" = ${v.exchangeAvailableCoins as string[]},
             "transfer_enabled" = ${v.transferEnabled},
             "transfer_min_amount" = ${v.transferMinAmount}::numeric,
             "transfer_max_amount" = ${v.transferMaxAmount}::numeric,
             "transfer_max_per_transfer" = ${v.transferMaxPerTransfer}::numeric,
             "transfer_max_per_user" = ${v.transferMaxPerUser}::numeric,
             "staking_enabled" = ${v.stakingEnabled},
             "staking_available_coins" = ${v.stakingAvailableCoins as string[]},
             "staking_flexible_enabled" = ${v.stakingFlexibleEnabled},
             "staking_locked_enabled" = ${v.stakingLockedEnabled},
             "merchant_enabled" = ${v.merchantEnabled},
             "merchant_max_websites_or_apps" = ${v.merchantMaxWebsitesOrApps},
             "tools_bulk_payment_enabled" = ${v.toolsBulkPaymentEnabled},
             "tools_tip_box_enabled" = ${v.toolsTipBoxEnabled},
             "tools_max_tip_boxes" = ${v.toolsMaxTipBoxes},
             "tools_invoice_generator_enabled" = ${v.toolsInvoiceGeneratorEnabled},
             "tools_max_active_invoices" = ${v.toolsMaxActiveInvoices},
             "referral_enabled" = ${v.referralEnabled},
             "referral_allowed_divisions" = ${v.referralAllowedDivisions as string[]},
             "referral_allowed_tiers" = ${v.referralAllowedTiers as string[]},
             "referral_max_active_links" = ${v.referralMaxActiveLinks},
             "rainpool_eligible" = ${v.rainpoolEligible},
             "rainpool_can_rain" = ${v.rainpoolCanRain},
             "ptc_can_view_ads" = ${v.ptcCanViewAds},
             "ptc_can_advertise" = ${v.ptcCanAdvertise},
             "tasks_can_participate" = ${v.tasksCanParticipate},
             "tasks_can_advertise" = ${v.tasksCanAdvertise},
             "tasks_allowed_providers" = ${v.tasksAllowedProviders as string[]},
             "premium_can_purchase" = ${v.premiumCanPurchase},
             "premium_can_gift" = ${v.premiumCanGift},
             "short_link_enabled" = ${v.shortLinkEnabled},
             "advertising_enabled" = ${v.advertisingEnabled},
             "coupons_can_create" = ${v.couponsCanCreate},
             "coupons_can_redeem" = ${v.couponsCanRedeem},
             "coupons_can_purchase_third_party" = ${v.couponsCanPurchaseThirdParty},
             "loyalty_enabled" = ${v.loyaltyEnabled},
             "chat_can_access_public_chat" = ${v.chatCanAccessPublicChat},
             "chat_can_advertise" = ${v.chatCanAdvertise},
             "chat_can_send_money" = ${v.chatCanSendMoney},
             "chat_allowed_rooms" = ${v.chatAllowedRooms as string[]},
             "ad_exchange_enabled" = ${v.adExchangeEnabled},
             "leaderboard_can_receive_rewards" = ${v.leaderboardCanReceiveRewards},
             "faucet_enabled" = ${v.faucetEnabled},
             "faucet_auto_enabled" = ${v.faucetAutoEnabled},
             "faucet_offline_enabled" = ${v.faucetOfflineEnabled},
             "bankroll_enabled" = ${v.bankrollEnabled},
             "bankroll_max_investment" = ${v.bankrollMaxInvestment}::numeric,
             "version" = ${input.expectedVersion + 1},
             "updated_by_admin_id" = ${input.actorAdminId}::uuid,
             "reason" = ${input.reason},
             "updated_at" = now()
       WHERE "level" = ${input.level}
         AND "version" = ${input.expectedVersion}`;

    return { written: written === 1 };
  }

  /**
   * Write one target level's upgrade routes, with compare-and-swap.
   *
   * ═══ THIS ONE HAS A CREATE PATH ════════════════════════════════════════════
   *
   * `expectedVersion: 0` inserts. These rows are deliberately not seeded — an absent
   * row means "no route to this level is offered", which is a real answer, so there is
   * nothing to seed it WITH that would not look configured.
   *
   * Versions always start at 1 and there is no history table to collide with, so this
   * needs none of `KycPolicyDbOperation.upsert`'s version-resumption logic: a re-created
   * target starts over at 1, and the audit stream is what says it existed before.
   *
   * `ON CONFLICT DO NOTHING` rather than a merge: a create racing a create means the
   * loser's `expectedVersion: 0` was wrong by the time it ran, and reporting a lost swap
   * is the honest answer.
   *
   * ⚠ NOTHING HERE TOUCHES `kyc_upgrade_achievements`. Withdrawing a route, or raising
   *   its threshold, leaves every earned achievement exactly where it is — an account
   *   that cleared the old line stays eligible. That is the permanence rule, and it is
   *   held by the absence of a statement rather than by a condition.
   */
  async writeUpgradeRequirement(
    input: KycUpgradeWriteInput,
  ): Promise<KycEntitlementWriteOutcome> {
    const written =
      input.expectedVersion === 0
        ? await this.prisma.$executeRaw`
            INSERT INTO "identity"."kyc_upgrade_requirements"
              ("id", "target_level", "minimum_balance", "deposit_threshold",
               "deposit_window_days", "threshold_currency",
               "version", "updated_by_admin_id", "reason", "created_at", "updated_at")
            VALUES (gen_random_uuid(), ${input.targetLevel},
                    ${input.minimumBalance}::numeric, ${input.depositThreshold}::numeric,
                    ${input.depositWindowDays}, ${input.thresholdCurrency},
                    1, ${input.actorAdminId}::uuid, ${input.reason}, now(), now())
            ON CONFLICT ("target_level") DO NOTHING`
        : await this.prisma.$executeRaw`
            UPDATE "identity"."kyc_upgrade_requirements"
               SET "minimum_balance" = ${input.minimumBalance}::numeric,
                   "deposit_threshold" = ${input.depositThreshold}::numeric,
                   "deposit_window_days" = ${input.depositWindowDays},
                   "threshold_currency" = ${input.thresholdCurrency},
                   "version" = ${input.expectedVersion + 1},
                   "updated_by_admin_id" = ${input.actorAdminId}::uuid,
                   "reason" = ${input.reason},
                   "updated_at" = now()
             WHERE "target_level" = ${input.targetLevel}
               AND "version" = ${input.expectedVersion}`;

    return { written: written === 1 };
  }
}
