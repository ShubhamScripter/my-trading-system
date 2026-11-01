import { Injectable, Logger } from '@nestjs/common';
import { AUTH_EVENT, AuthEventDbOperation } from '../../auth/auth.dboperation';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import {
  KycEntitlementDbOperation,
  type KycEntitlementRow,
  type KycEntitlementValues,
  type KycUpgradeRequirementRow,
} from './kyc-entitlement.dboperation';
import type {
  KycEntitlementLevelView,
  KycEntitlementsPayload,
  KycEntitlementsWriteRequest,
  KycUpgradeRequirementView,
  KycUpgradeWriteRequest,
} from './kyc-entitlement.dto';
import { KYC_ENTITLEMENT_LEVELS, KYC_POLICY_LEVELS } from './kyc.types';

/**
 * ═══ CONFIGURING WHAT A KYC LEVEL GRANTS ════════════════════════════════════
 *
 * Two resources, one prefix. The entitlement matrix (what holding a level grants) and
 * the upgrade routes (what reaching one takes).
 *
 * ─── What this service decides, and the three things it does not ──────────
 *
 * It decides what a level is WORTH. It does not decide:
 *
 *   what level an account holds     `effectiveLevel` in the consumer — credentials
 *                                   folded with an exemption under the renewal clocks.
 *                                   Nothing here reads `kyc_level_states`,
 *                                   `kyc_exemptions` or `kyc_renewal_settings`.
 *   whether a rule BITES            the consumer's resolver. This writes configuration;
 *                                   applying it to one account is not this service's
 *                                   question and the calculation exists in exactly one
 *                                   place.
 *   whether an account has EARNED   `kyc_upgrade_achievements` is an observation of a
 *   an upgrade route                balance, and only the service holding the
 *                                   account-data port can make one. This service reads
 *                                   a COUNT of them and has no statement that writes
 *                                   one.
 *
 * ─── The audit event is not the record of the mutation ────────────────────
 *
 * `AuthEventDbOperation.record` swallows its own failures by design — an admin action
 * must not fail because the audit table would not take a row. So the DATABASE WRITE IS
 * AUTHORITATIVE and the event is observability. Every write below commits first and
 * audits afterwards, and the response reports what the database did.
 *
 * ⚠ For THIS surface the audit event is also the only history. Neither table has a
 *   companion versions table — the consumer's schema explains why, and it is the same
 *   trade `kyc_renewal_settings` makes — so `metadata` carries the FIELDS THAT CHANGED
 *   and their new values rather than just a level and a version. "What could an L1
 *   account do in March" is answerable only from this event stream.
 */
@Injectable()
export class KycEntitlementService {
  private readonly logger = new Logger('KycEntitlement');

  constructor(
    private readonly entitlements: KycEntitlementDbOperation,
    private readonly events: AuthEventDbOperation,
  ) {}

  /**
   * The whole configuration, in one read.
   *
   * A pure read — it audits nothing, matching `kyc-policies`, `kyc-renewal` and
   * `kyc-exemptions`. The sensitive read on this module is KYC HISTORY, which audits
   * because it returns provider decisions about a person; this returns rules.
   *
   * ⚠ If the entitlement rows are missing entirely, this reports it rather than
   *   returning an empty list. An empty matrix and an unmigrated database look identical
   *   to a screen, and the second is a deployment fault an operator needs told about —
   *   silently rendering "no levels configured" would have them configure nothing and
   *   wonder why.
   */
  async read(): Promise<KycEntitlementsPayload> {
    const [rows, upgrades] = await Promise.all([
      this.entitlements.listEntitlements(),
      this.entitlements.listUpgradeRequirements(),
    ]);

    if (rows.length === 0) {
      this.logger.error(
        {},
        'identity.kyc_level_entitlements is empty — the entitlements migration has not run',
      );
      throw new ProblemException({
        type: ERR.INTERNAL_ERROR,
        detail: 'KYC entitlements are not initialised in this environment.',
      });
    }

    return {
      entitlements: rows.map(toLevelView),
      upgradeRequirements: upgrades.map(toUpgradeView),
      levels: [...KYC_ENTITLEMENT_LEVELS],
      targetLevels: [...KYC_POLICY_LEVELS],
      versionToCreate: 0,
    };
  }

  /**
   * Write one level's entitlements.
   *
   * ─── The write is un-nested here, not in the SQL layer ───────────────────
   *
   * The DTO takes the nested shape a screen renders and the table is flat, so something
   * has to flatten. It happens here rather than in the dboperation because the SQL layer
   * should be a straight column-to-parameter mapping — a layer that also restructured
   * would be a second place the two shapes have to agree.
   */
  async writeEntitlements(
    input: KycEntitlementsWriteRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycEntitlementsPayload> {
    const values = toValues(input);

    const outcome = await this.entitlements.writeEntitlements({
      level: input.level,
      reason: input.reason,
      actorAdminId: actor.adminId,
      expectedVersion: input.expectedVersion,
      values,
    });

    if (!outcome.written) {
      await this.refuseLostSwap({
        expectedVersion: input.expectedVersion,
        live: await this.entitlements.findEntitlementVersion(input.level),
        target: input.level,
        what: 'level',
      });
    }

    // WARN rather than log: this changes what every account at this level may do, on
    // every deployment, from the next request onwards. There is no rollout and no
    // grace period.
    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        level: input.level,
        version: input.expectedVersion + 1,
      },
      'kyc level entitlements updated',
    );

    await this.events.record({
      eventType: AUTH_EVENT.KYC_ENTITLEMENTS_UPDATED,
      adminId: actor.adminId,
      client,
      metadata: {
        level: input.level,
        version: input.expectedVersion + 1,
        reason: input.reason,
        // ⚠ THE WHOLE CONFIGURATION, because this event IS the history — there is no
        // versions table behind this row. A metadata payload carrying only the level
        // and the version would make "what could an L1 account do in March"
        // unanswerable.
        //
        // Serialised into two JSON strings because `metadata` is
        // `Record<string, string | number | boolean | null>` — scalars only, which is
        // what keeps the audit column queryable. Two fields rather than one, so an
        // operator reading a row can see the limits without parsing the whole matrix.
        //
        // `JSON.stringify` is safe on both: they are the PARSED DTO, so every value is
        // a string, a number, a boolean, a null or an array of strings. There is no
        // Date, no Decimal and no cycle to trip over — amounts are already exact
        // decimal strings by the time they reach here.
        limits: JSON.stringify(input.limits),
        features: JSON.stringify(input.features),
      },
    });

    return this.read();
  }

  /**
   * Write one target level's upgrade routes.
   *
   * ─── The achievement count goes on the audit row, not the response ───────
   *
   * `accountsAlreadyAchieved` is measured immediately BEFORE the write, so the event
   * records the population as it stood when the operator acted —
   * `KycRenewalDbOperation.impactOf` takes the same position for the same reason.
   *
   * ⚠ It is NOT the blast radius, and the distinction matters. Those accounts are
   *   precisely the ones this change CANNOT affect: an achievement is permanent, so
   *   raising a threshold does not revoke one and lowering it does not retroactively
   *   create any. The number is on the row so a later review can see how many accounts
   *   were already through the old line, not because they are about to move.
   */
  async writeUpgradeRequirement(
    input: KycUpgradeWriteRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycEntitlementsPayload> {
    const impact = await this.entitlements.achievementImpact(input.targetLevel);

    const outcome = await this.entitlements.writeUpgradeRequirement({
      targetLevel: input.targetLevel,
      minimumBalance: input.minimumBalance,
      depositThreshold: input.depositThreshold,
      depositWindowDays: input.depositWindowDays,
      thresholdCurrency: input.thresholdCurrency,
      reason: input.reason,
      actorAdminId: actor.adminId,
      expectedVersion: input.expectedVersion,
    });

    if (!outcome.written) {
      await this.refuseLostSwap({
        expectedVersion: input.expectedVersion,
        live: await this.entitlements.findUpgradeVersion(input.targetLevel),
        target: input.targetLevel,
        what: 'targetLevel',
      });
    }

    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        targetLevel: input.targetLevel,
        version: input.expectedVersion === 0 ? 1 : input.expectedVersion + 1,
        accountsAlreadyAchieved: impact.accountsAlreadyAchieved,
      },
      'kyc upgrade requirements updated',
    );

    await this.events.record({
      eventType: AUTH_EVENT.KYC_UPGRADE_REQUIREMENTS_UPDATED,
      adminId: actor.adminId,
      client,
      metadata: {
        targetLevel: input.targetLevel,
        version: input.expectedVersion === 0 ? 1 : input.expectedVersion + 1,
        reason: input.reason,
        minimumBalance: input.minimumBalance,
        depositThreshold: input.depositThreshold,
        depositWindowDays: input.depositWindowDays,
        thresholdCurrency: input.thresholdCurrency,
        // See the note above: the population already through the old line, which this
        // change cannot move.
        accountsAlreadyAchieved: impact.accountsAlreadyAchieved,
      },
    });

    return this.read();
  }

  /**
   * Turn a write that matched nothing into the right refusal.
   *
   * ═══ A LOST SWAP AND A MISSING ROW NEED DIFFERENT ANSWERS ══════════════════
   *
   * Both make the UPDATE match zero rows, and telling them apart is the difference
   * between "somebody edited this while you had it open" and "this environment has not
   * run the migration". An operator can act on the first and can do nothing about the
   * second except escalate.
   *
   * The lost swap is a 400 on the version field rather than a 409, matching
   * `KycPolicyService.assertWritten`: nothing about waiting changes the answer, and the
   * remedy is to re-read. A create that lost to a concurrent create lands here too, and
   * correctly — its `expectedVersion: 0` was wrong by the time it ran.
   */
  private async refuseLostSwap(input: {
    readonly expectedVersion: number;
    readonly live: number | null;
    readonly target: string;
    readonly what: 'level' | 'targetLevel';
  }): Promise<never> {
    if (input.live === null && input.expectedVersion !== 0) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: input.what,
            message:
              input.what === 'level'
                ? 'No entitlement row exists for this level. This environment has not ' +
                  'run the KYC entitlements migration.'
                : 'No upgrade requirement exists for this target yet. Send ' +
                  'expectedVersion: 0 to create one.',
          },
        ],
      });
    }

    throw new ProblemException({
      type: ERR.VALIDATION_FAILED,
      errors: [
        {
          path: 'expectedVersion',
          message:
            input.live === null
              ? 'A concurrent write created this row. Re-read the configuration and try again.'
              : `Stale version — the stored version is now ${input.live}. Re-read the ` +
                'configuration and try again.',
        },
      ],
    });
  }
}

/** The nested write body, flattened into the columns the SQL layer takes. */
function toValues(input: KycEntitlementsWriteRequest): KycEntitlementValues {
  const f = input.features;

  return {
    withdrawalLimit: input.limits.withdrawal,
    exchangeLimit: input.limits.exchange,
    balanceLimit: input.limits.balance,
    limitCurrency: input.limits.currency,

    profileLinksEnabled: f.profile.links,

    walletDisabledCurrencies: f.wallet.disabledCurrencies,

    depositOnRampEnabled: f.deposits.onRamp,
    depositOffRampEnabled: f.deposits.offRamp,

    withdrawEnabled: f.withdraw.enabled,
    withdrawMaxPerTransaction: f.withdraw.maxPerTransaction,
    withdrawAmountLimit: f.withdraw.amountLimit,
    withdrawCountLimit: f.withdraw.countLimit,
    withdrawLimitWindowSeconds: f.withdraw.limitWindowSeconds,
    withdrawMinimumGapSeconds: f.withdraw.minimumGapSeconds,
    withdrawSecurityThreshold: f.withdraw.securityThreshold,

    exchangeEnabled: f.exchange.enabled,
    exchangeMinAmount: f.exchange.minAmount,
    exchangeMaxAmount: f.exchange.maxAmount,
    exchangeMaxPerExchange: f.exchange.maxPerExchange,
    exchangeSmallEnabled: f.exchange.smallExchangeEnabled,
    exchangeMultiCoinEnabled: f.exchange.multiCoinExchangeEnabled,
    exchangeAvailableCoins: f.exchange.availableCoins,

    transferEnabled: f.transfer.enabled,
    transferMinAmount: f.transfer.minAmount,
    transferMaxAmount: f.transfer.maxAmount,
    transferMaxPerTransfer: f.transfer.maxPerTransfer,
    transferMaxPerUser: f.transfer.maxTransferPerUser,

    stakingEnabled: f.staking.enabled,
    stakingAvailableCoins: f.staking.availableCoins,
    stakingFlexibleEnabled: f.staking.types.flexible,
    stakingLockedEnabled: f.staking.types.locked,

    merchantEnabled: f.merchant.enabled,
    merchantMaxWebsitesOrApps: f.merchant.maxWebsitesOrApps,

    toolsBulkPaymentEnabled: f.tools.bulkPayment.enabled,
    toolsTipBoxEnabled: f.tools.tipBox.enabled,
    toolsMaxTipBoxes: f.tools.tipBox.maxTipBoxes,
    toolsInvoiceGeneratorEnabled: f.tools.invoiceGenerator.enabled,
    toolsMaxActiveInvoices: f.tools.invoiceGenerator.maxActiveInvoices,

    referralEnabled: f.referral.enabled,
    referralAllowedDivisions: f.referral.allowedDivisions,
    referralAllowedTiers: f.referral.allowedTiers,
    referralMaxActiveLinks: f.referral.maxActiveReferralLinks,

    rainpoolEligible: f.rainpool.eligible,
    rainpoolCanRain: f.rainpool.canRain,

    ptcCanViewAds: f.ptc.canViewAds,
    ptcCanAdvertise: f.ptc.canAdvertise,

    tasksCanParticipate: f.tasks.canParticipate,
    tasksCanAdvertise: f.tasks.canAdvertise,
    tasksAllowedProviders: f.tasks.allowedProviders,

    premiumCanPurchase: f.premium.canPurchase,
    premiumCanGift: f.premium.canGift,

    shortLinkEnabled: f.shortLink.enabled,

    advertisingEnabled: f.advertising.enabled,

    couponsCanCreate: f.coupons.canCreate,
    couponsCanRedeem: f.coupons.canRedeem,
    couponsCanPurchaseThirdParty: f.coupons.canPurchaseThirdParty,

    loyaltyEnabled: f.loyalty.enabled,

    chatCanAccessPublicChat: f.chat.canAccessPublicChat,
    chatCanAdvertise: f.chat.canAdvertiseInChat,
    chatCanSendMoney: f.chat.canSendMoney,
    chatAllowedRooms: f.chat.allowedRooms,

    adExchangeEnabled: f.adExchange.enabled,

    leaderboardCanReceiveRewards: f.leaderboard.canReceiveRewards,

    faucetEnabled: f.faucet.enabled,
    faucetAutoEnabled: f.faucet.autoEnabled,
    faucetOfflineEnabled: f.faucet.offlineEnabled,

    bankrollEnabled: f.bankroll.enabled,
    bankrollMaxInvestment: f.bankroll.maxInvestment,
  };
}

/**
 * A stored row, as a screen reads it.
 *
 * The nested half is field-for-field what `POST` accepts, so a screen reads, edits and
 * writes back one object. Instants are ISO strings at the boundary, matching every other
 * payload in this service.
 */
function toLevelView(row: KycEntitlementRow): KycEntitlementLevelView {
  return {
    level: row.level,
    configured: row.configured,
    version: row.version,
    limits: {
      currency: row.limit_currency,
      withdrawal: row.withdrawal_limit,
      exchange: row.exchange_limit,
      balance: row.balance_limit,
    },
    features: {
      profile: { links: row.profile_links_enabled },
      wallet: { disabledCurrencies: row.wallet_disabled_currencies },
      deposits: {
        onRamp: row.deposit_on_ramp_enabled,
        offRamp: row.deposit_off_ramp_enabled,
      },
      withdraw: {
        enabled: row.withdraw_enabled,
        maxPerTransaction: row.withdraw_max_per_transaction,
        amountLimit: row.withdraw_amount_limit,
        countLimit: row.withdraw_count_limit,
        limitWindowSeconds: row.withdraw_limit_window_seconds,
        minimumGapSeconds: row.withdraw_minimum_gap_seconds,
        securityThreshold: row.withdraw_security_threshold,
      },
      exchange: {
        enabled: row.exchange_enabled,
        minAmount: row.exchange_min_amount,
        maxAmount: row.exchange_max_amount,
        maxPerExchange: row.exchange_max_per_exchange,
        smallExchangeEnabled: row.exchange_small_enabled,
        multiCoinExchangeEnabled: row.exchange_multi_coin_enabled,
        availableCoins: row.exchange_available_coins,
      },
      transfer: {
        enabled: row.transfer_enabled,
        minAmount: row.transfer_min_amount,
        maxAmount: row.transfer_max_amount,
        maxPerTransfer: row.transfer_max_per_transfer,
        maxTransferPerUser: row.transfer_max_per_user,
      },
      staking: {
        enabled: row.staking_enabled,
        availableCoins: row.staking_available_coins,
        types: {
          flexible: row.staking_flexible_enabled,
          locked: row.staking_locked_enabled,
        },
      },
      merchant: {
        enabled: row.merchant_enabled,
        maxWebsitesOrApps: row.merchant_max_websites_or_apps,
      },
      tools: {
        bulkPayment: { enabled: row.tools_bulk_payment_enabled },
        tipBox: {
          enabled: row.tools_tip_box_enabled,
          maxTipBoxes: row.tools_max_tip_boxes,
        },
        invoiceGenerator: {
          enabled: row.tools_invoice_generator_enabled,
          maxActiveInvoices: row.tools_max_active_invoices,
        },
      },
      referral: {
        enabled: row.referral_enabled,
        allowedDivisions: row.referral_allowed_divisions,
        allowedTiers: row.referral_allowed_tiers,
        maxActiveReferralLinks: row.referral_max_active_links,
      },
      rainpool: { eligible: row.rainpool_eligible, canRain: row.rainpool_can_rain },
      ptc: { canViewAds: row.ptc_can_view_ads, canAdvertise: row.ptc_can_advertise },
      tasks: {
        canParticipate: row.tasks_can_participate,
        canAdvertise: row.tasks_can_advertise,
        allowedProviders: row.tasks_allowed_providers,
      },
      premium: {
        canPurchase: row.premium_can_purchase,
        canGift: row.premium_can_gift,
      },
      shortLink: { enabled: row.short_link_enabled },
      advertising: { enabled: row.advertising_enabled },
      coupons: {
        canCreate: row.coupons_can_create,
        canRedeem: row.coupons_can_redeem,
        canPurchaseThirdParty: row.coupons_can_purchase_third_party,
      },
      loyalty: { enabled: row.loyalty_enabled },
      chat: {
        canAccessPublicChat: row.chat_can_access_public_chat,
        canAdvertiseInChat: row.chat_can_advertise,
        canSendMoney: row.chat_can_send_money,
        allowedRooms: row.chat_allowed_rooms,
      },
      adExchange: { enabled: row.ad_exchange_enabled },
      leaderboard: { canReceiveRewards: row.leaderboard_can_receive_rewards },
      faucet: {
        enabled: row.faucet_enabled,
        autoEnabled: row.faucet_auto_enabled,
        offlineEnabled: row.faucet_offline_enabled,
      },
      bankroll: {
        enabled: row.bankroll_enabled,
        maxInvestment: row.bankroll_max_investment,
      },
    },
    updatedByAdminId: row.updated_by_admin_id,
    reason: row.reason,
    updatedAt: row.updated_at.toISOString(),
  };
}

function toUpgradeView(row: KycUpgradeRequirementRow): KycUpgradeRequirementView {
  return {
    targetLevel: row.target_level,
    version: row.version,
    minimumBalance: row.minimum_balance,
    depositThreshold: row.deposit_threshold,
    depositWindowDays: row.deposit_window_days,
    thresholdCurrency: row.threshold_currency,
    updatedByAdminId: row.updated_by_admin_id,
    reason: row.reason,
    updatedAt: row.updated_at.toISOString(),
  };
}
