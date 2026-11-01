import { z } from 'zod';
import { KYC_ENTITLEMENT_LEVELS, KYC_POLICY_LEVELS } from './kyc.types';

/**
 * ═══ THE WIRE SHAPE FOR WHAT A KYC LEVEL GRANTS ═════════════════════════════
 *
 * Two resources on one prefix, discriminated on `action`:
 *
 *   entitlements   what holding a level GRANTS   keyed by the level HELD (incl. NONE)
 *   upgrade        what reaching a level TAKES   keyed by the level TARGETED (L1, L2)
 *
 * They share a prefix because they answer one operator question — "what does this
 * level mean" — and a config screen reads both in one GET. They stay separate ACTIONS
 * because they are keyed on opposite things, and a single body that could carry either
 * key would let an operator configure `NONE`'s upgrade route, which is meaningless.
 *
 * ═══ FULL-STATE WRITES, NOT PATCHES ════════════════════════════════════════
 *
 * Every field on `entitlements` is REQUIRED, and a field sent as `null` sets that
 * ceiling to "unconfigured" — it does not mean "leave unchanged". `kyc-renewal` takes
 * the same position for the same reason, stated there: there is no partial update, so
 * there is no way to change one ceiling while being vague about another.
 *
 * It matters more here than anywhere else on this surface, because this body has
 * seventy-one fields. A patch shape would mean an operator could never tell, from the
 * request they were about to send, what the resulting configuration would be — and the
 * fields they omitted are exactly the ones nobody would check.
 *
 * The cost is a verbose body. The GET returns the same shape, so a screen reads, edits
 * and writes back one object with no field to add or strip in between.
 *
 * ═══ AMOUNTS ARE EXACT DECIMAL STRINGS, NEVER NUMBERS ══════════════════════
 *
 * `kyc-policy.dto.ts` states the whole argument and this file reuses its grammar
 * verbatim: `numeric(38,18)` carries more precision than a float64 mantissa holds, so
 * `10000.000000000000000001` parsed as a JS number is `10000` and a comparison at the
 * boundary is silently wrong.
 *
 * ═══ NULL MEANS UNCONFIGURED. ZERO IS REFUSED. ═════════════════════════════
 *
 * Every amount and every count must be strictly positive or null, mirroring
 * `ck_kyc_level_entitlements_amounts_positive` and `..._counts_positive`. A stored zero
 * would be a total prohibition wearing the costume of a limit: an operator who meant
 * "no ceiling" and typed `0` would silently forbid the feature outright. `null` is the
 * way to say "no ceiling" and it is the only way.
 */

/** `int4`. Anything larger is SQLSTATE 22003 rather than a validation error. */
const INT4_MAX = 2_147_483_647;

/**
 * An exact decimal amount, as a STRING.
 *
 * Copied from `kyc-policy.dto.ts` rather than shared, because a helper imported across
 * two DTOs is a helper somebody later "simplifies" — the same call
 * `KycRequirementDbOperation` makes about its `clamp`. `tests/kyc/kyc.drift.spec.ts`
 * compares the grammar against the consumer's parser.
 */
const DECIMAL = /^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/;

const amountSchema = z
  .string()
  .trim()
  .regex(DECIMAL, 'must be an exact decimal with at most 20 integer and 18 decimal places')
  // The grammar admits no sign, so any nonzero digit proves the value is positive.
  .refine((value) => /[1-9]/.test(value), 'must be greater than zero')
  .nullable();

/** A positive count or whole-second duration, or null for "no ceiling". */
const countSchema = z.number().int().positive().max(INT4_MAX).nullable();

/**
 * The denomination every amount on one entitlement row is expressed in.
 *
 * `ck_kyc_level_entitlements_currency` demands `= upper(btrim(x)) AND x <> ''`.
 * Uppercasing satisfies it; the character class additionally refuses `'US D'`, which
 * `btrim` would let through.
 */
const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9]{1,16}$/.test(value), 'must be 1-16 uppercase letters or digits')
  .nullable();

/**
 * One entry in an allow-list or deny-list — a currency, a coin, a provider, a tier, a
 * division, a chat room.
 *
 * Shape only. This service has no registry for any of these vocabularies, and inventing
 * one would be a second registry to keep in step with whichever module actually owns it
 * — the position `kyc-policy.dto.ts` takes on feature ids. The consumer carries these
 * through without validating them either, which is stated on
 * `KycReferralEntitlement`.
 *
 * Deduplicated and sorted so what is stored is canonical: two writes of the same set in
 * a different order produce the same row, and a diff of two versions shows a real change
 * rather than a reordering.
 */
const tokenSchema = z.string().trim().min(1).max(64);

const tokenListSchema = z
  .array(tokenSchema)
  .max(256)
  .transform((values) => [...new Set(values)].sort());

/** Why this change was made. Required on EVERY write, as on every other KYC surface. */
const reasonSchema = z.string().trim().min(1).max(256);

/** `expectedVersion: 0` means "I expect no row yet"; the stored version starts at 1. */
const expectedVersionSchema = z.number().int().min(0).max(INT4_MAX - 1);

const entitlementLevelSchema = z.enum(
  KYC_ENTITLEMENT_LEVELS as unknown as [string, ...string[]],
);
const targetLevelSchema = z.enum(KYC_POLICY_LEVELS as unknown as [string, ...string[]]);

// ─── the feature matrix, by product area ────────────────────────────────────
//
// One nested object per area, matching the shape the consumer resolves and the shape a
// screen renders. `.strict()` on every one of them, so a field this service does not
// know is REFUSED rather than silently dropped — on a body this large, a typo in a key
// would otherwise look exactly like a successful write.

const profileSchema = z.object({ links: z.boolean() }).strict();

const walletSchema = z
  .object({
    /** A DENY-list, uniquely in this body. See `KycWalletEntitlement`. */
    disabledCurrencies: tokenListSchema,
  })
  .strict();

const depositsSchema = z
  .object({ onRamp: z.boolean(), offRamp: z.boolean() })
  .strict();

const withdrawSchema = z
  .object({
    enabled: z.boolean(),
    maxPerTransaction: amountSchema,
    amountLimit: amountSchema,
    countLimit: countSchema,
    /** The period the two ceilings above are measured over, in whole seconds.
     *  Required whenever either is set — see the refinement at the foot of this file. */
    limitWindowSeconds: countSchema,
    minimumGapSeconds: countSchema,
    securityThreshold: amountSchema,
  })
  .strict();

const exchangeSchema = z
  .object({
    enabled: z.boolean(),
    minAmount: amountSchema,
    maxAmount: amountSchema,
    maxPerExchange: amountSchema,
    smallExchangeEnabled: z.boolean(),
    multiCoinExchangeEnabled: z.boolean(),
    availableCoins: tokenListSchema,
  })
  .strict();

const transferSchema = z
  .object({
    enabled: z.boolean(),
    minAmount: amountSchema,
    maxAmount: amountSchema,
    maxPerTransfer: amountSchema,
    maxTransferPerUser: amountSchema,
  })
  .strict();

const stakingSchema = z
  .object({
    enabled: z.boolean(),
    availableCoins: tokenListSchema,
    /** A closed pair rather than a list of names — a list would admit a third type
     *  nothing implements and it would read as configuration. */
    types: z.object({ flexible: z.boolean(), locked: z.boolean() }).strict(),
  })
  .strict();

const merchantSchema = z
  .object({ enabled: z.boolean(), maxWebsitesOrApps: countSchema })
  .strict();

const toolsSchema = z
  .object({
    bulkPayment: z.object({ enabled: z.boolean() }).strict(),
    tipBox: z.object({ enabled: z.boolean(), maxTipBoxes: countSchema }).strict(),
    invoiceGenerator: z
      .object({ enabled: z.boolean(), maxActiveInvoices: countSchema })
      .strict(),
  })
  .strict();

const referralSchema = z
  .object({
    enabled: z.boolean(),
    allowedDivisions: tokenListSchema,
    allowedTiers: tokenListSchema,
    maxActiveReferralLinks: countSchema,
  })
  .strict();

const rainpoolSchema = z
  .object({
    /** May RECEIVE rains. */
    eligible: z.boolean(),
    /** May SEND rains. Separate, so "may receive but not send" is expressible. */
    canRain: z.boolean(),
  })
  .strict();

const ptcSchema = z
  .object({ canViewAds: z.boolean(), canAdvertise: z.boolean() })
  .strict();

const tasksSchema = z
  .object({
    canParticipate: z.boolean(),
    canAdvertise: z.boolean(),
    allowedProviders: tokenListSchema,
  })
  .strict();

const premiumSchema = z
  .object({ canPurchase: z.boolean(), canGift: z.boolean() })
  .strict();

const toggleSchema = z.object({ enabled: z.boolean() }).strict();

const couponsSchema = z
  .object({
    canCreate: z.boolean(),
    canRedeem: z.boolean(),
    canPurchaseThirdParty: z.boolean(),
  })
  .strict();

const chatSchema = z
  .object({
    canAccessPublicChat: z.boolean(),
    canAdvertiseInChat: z.boolean(),
    canSendMoney: z.boolean(),
    allowedRooms: tokenListSchema,
  })
  .strict();

const leaderboardSchema = z.object({ canReceiveRewards: z.boolean() }).strict();

const faucetSchema = z
  .object({
    enabled: z.boolean(),
    autoEnabled: z.boolean(),
    offlineEnabled: z.boolean(),
  })
  .strict();

const bankrollSchema = z
  .object({ enabled: z.boolean(), maxInvestment: amountSchema })
  .strict();

const featuresSchema = z
  .object({
    profile: profileSchema,
    wallet: walletSchema,
    deposits: depositsSchema,
    withdraw: withdrawSchema,
    exchange: exchangeSchema,
    transfer: transferSchema,
    staking: stakingSchema,
    merchant: merchantSchema,
    tools: toolsSchema,
    referral: referralSchema,
    rainpool: rainpoolSchema,
    ptc: ptcSchema,
    tasks: tasksSchema,
    premium: premiumSchema,
    shortLink: toggleSchema,
    advertising: toggleSchema,
    coupons: couponsSchema,
    loyalty: toggleSchema,
    chat: chatSchema,
    adExchange: toggleSchema,
    leaderboard: leaderboardSchema,
    faucet: faucetSchema,
    bankroll: bankrollSchema,
  })
  .strict();

const limitsSchema = z
  .object({
    currency: currencySchema,
    withdrawal: amountSchema,
    exchange: amountSchema,
    balance: amountSchema,
  })
  .strict();

// ─── POST /kyc-entitlements ─────────────────────────────────────────────────

const entitlementsWriteSchema = z
  .object({
    action: z.literal('entitlements'),
    /** `NONE` is legal HERE and nowhere else on this service. "What may an unverified
     *  account do" is a real configuration question with a real answer. */
    level: entitlementLevelSchema,
    limits: limitsSchema,
    features: featuresSchema,
    reason: reasonSchema,
    /** Compare-and-swap. `0` creates; the stored version starts at 1 and increments. */
    expectedVersion: expectedVersionSchema,
  })
  .strict();

const upgradeWriteSchema = z
  .object({
    action: z.literal('upgrade'),
    /** The level being upgraded TO. `NONE` is refused by the enum — nobody upgrades to
     *  holding nothing. */
    targetLevel: targetLevelSchema,
    /** Condition A. Null withdraws the balance route. */
    minimumBalance: amountSchema,
    /** Condition B, with its window. Both or neither. */
    depositThreshold: amountSchema,
    depositWindowDays: countSchema,
    /** Required once either amount is set. */
    thresholdCurrency: currencySchema,
    reason: reasonSchema,
    expectedVersion: expectedVersionSchema,
  })
  .strict();

/**
 * The write body.
 *
 * ═══ THE REFINEMENTS MIRROR CHECK CONSTRAINTS, AND TWO ARE STRICTER ════════
 *
 * Every rule below also exists in `db/sql/identity.sql` in the consumer. That is
 * deliberate duplication, not redundancy: the constraint is the authority (rows get
 * hand-edited in psql during incidents, and a DTO in this service is not a constraint
 * on that), and these exist so an operator gets a 400 naming the field instead of a
 * 500 carrying a Postgres constraint name.
 *
 * `.superRefine` on the union rather than on each member, because zod runs a
 * discriminated union's member refinements before the discriminator narrows — the shape
 * `kyc-policy.dto.ts` already uses, whose note explains the early return.
 */
export const kycEntitlementRequestSchema = z
  .discriminatedUnion('action', [entitlementsWriteSchema, upgradeWriteSchema])
  .superRefine((input, ctx) => {
    if (input.action === 'upgrade') {
      // ─── ck_kyc_upgrade_requirements_deposit_complete ─────────────────────
      //
      // An amount with no window can never be evaluated; a window with no amount
      // configures nothing. Both or neither.
      const halfConfigured =
        (input.depositThreshold === null) !== (input.depositWindowDays === null);
      if (halfConfigured) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['depositWindowDays'],
          message:
            'depositThreshold and depositWindowDays must be set together — an amount ' +
            'with no window can never be evaluated, and a window with no amount ' +
            'configures nothing',
        });
      }

      // ─── ck_kyc_upgrade_requirements_currency ─────────────────────────────
      if (
        (input.minimumBalance !== null || input.depositThreshold !== null) &&
        input.thresholdCurrency === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['thresholdCurrency'],
          message:
            'required when a threshold is set — there is no FX service, so an amount ' +
            'with no denomination either never applies or applies to the wrong currency',
        });
      }

      // Stricter than the database, deliberately, and for the reason
      // `kyc-renewal.dto.ts` gives about its own extra rule: a currency with no amount
      // to denominate is configuration that does nothing and will read as if it did the
      // day somebody sets a threshold.
      if (
        input.minimumBalance === null &&
        input.depositThreshold === null &&
        input.thresholdCurrency !== null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['thresholdCurrency'],
          message: 'must be null when no threshold is set — there is nothing to denominate',
        });
      }
      return;
    }

    // ─── there is no create path for a level ───────────────────────────────
    //
    // The consumer's migration seeds one row per level at version 1, and
    // `ck_kyc_level_entitlements_level` admits exactly three levels — so a level row
    // always exists and every write is an update. `expectedVersion: 0` means "I expect
    // no row yet", which cannot be true here, and accepting it would mean silently
    // doing nothing while reporting a lost compare-and-swap.
    //
    // Note the asymmetry with the `upgrade` action, where 0 IS valid: those rows are
    // deliberately not seeded, because an absent row means "this route is not offered"
    // and that is a real answer rather than a gap.
    if (input.expectedVersion === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedVersion'],
        message:
          'every level always has a row, so there is no create path — send the current ' +
          'version from GET /kyc-entitlements',
      });
    }

    const { limits, features } = input;

    // ─── ck_kyc_level_entitlements_currency ────────────────────────────────
    //
    // Collected rather than tested inline, because there are fourteen amounts across
    // five feature groups and a list is the only way to be sure none was forgotten.
    const amounts: readonly (string | null)[] = [
      limits.withdrawal,
      limits.exchange,
      limits.balance,
      features.withdraw.maxPerTransaction,
      features.withdraw.amountLimit,
      features.withdraw.securityThreshold,
      features.exchange.minAmount,
      features.exchange.maxAmount,
      features.exchange.maxPerExchange,
      features.transfer.minAmount,
      features.transfer.maxAmount,
      features.transfer.maxPerTransfer,
      features.transfer.maxTransferPerUser,
      features.bankroll.maxInvestment,
    ];
    const anyAmount = amounts.some((value) => value !== null);

    if (anyAmount && limits.currency === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limits', 'currency'],
        message:
          'required when any amount is set — there is no FX service, so an amount with ' +
          'no denomination either never applies or applies to the wrong currency',
      });
    }
    if (!anyAmount && limits.currency !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limits', 'currency'],
        message: 'must be null when no amount is set — there is nothing to denominate',
      });
    }

    // ─── ck_kyc_level_entitlements_withdraw_window ─────────────────────────
    const windowed =
      features.withdraw.amountLimit !== null || features.withdraw.countLimit !== null;
    if (windowed && features.withdraw.limitWindowSeconds === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['features', 'withdraw', 'limitWindowSeconds'],
        message:
          'required when amountLimit or countLimit is set — a ceiling with no period ' +
          'is uninterpretable, and nothing here defaults one to a day',
      });
    }
    if (!windowed && features.withdraw.limitWindowSeconds !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['features', 'withdraw', 'limitWindowSeconds'],
        message: 'must be null when neither amountLimit nor countLimit is set',
      });
    }

    // ─── ck_kyc_level_entitlements_ranges_ordered ──────────────────────────
    //
    // A minimum above a maximum is dead configuration that reads as though it worked:
    // no amount satisfies both, so the feature is closed while appearing bounded.
    for (const [area, min, max] of [
      ['exchange', features.exchange.minAmount, features.exchange.maxAmount],
      ['transfer', features.transfer.minAmount, features.transfer.maxAmount],
    ] as const) {
      if (min !== null && max !== null && compareDecimals(min, max) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['features', area, 'minAmount'],
          message: 'must not exceed maxAmount — no amount would satisfy both',
        });
      }
    }
  });

export type KycEntitlementRequest = z.infer<typeof kycEntitlementRequestSchema>;
export type KycEntitlementsWriteRequest = z.infer<typeof entitlementsWriteSchema>;
export type KycUpgradeWriteRequest = z.infer<typeof upgradeWriteSchema>;

/**
 * The body as it arrives, BEFORE parsing.
 *
 * Distinct from `KycEntitlementsWriteRequest` in two ways that matter to a caller
 * constructing one: a currency has not been uppercased yet and a list has not been
 * deduplicated or sorted. Exported so a test fixture can be typed as INPUT rather than
 * as output — a fixture typed as the parsed shape infers `'USDT'` for a field the schema
 * declares nullable, and then every case that overrides it with `null` is a type error
 * about the fixture rather than a statement about the rule.
 */
export type KycEntitlementsWriteInput = z.input<typeof entitlementsWriteSchema>;
export type KycUpgradeWriteInput = z.input<typeof upgradeWriteSchema>;

/**
 * Compare two values from `DECIMAL`, without float arithmetic.
 *
 * The grammar guarantees no sign, no exponent and no leading zeros, so integer parts
 * compare by length then lexically, and fractional parts compare lexically once padded
 * to the same width. `Number()` would reintroduce exactly the precision loss the string
 * representation exists to avoid.
 */
function compareDecimals(left: string, right: string): number {
  const [leftInt = '0', leftFrac = ''] = left.split('.');
  const [rightInt = '0', rightFrac = ''] = right.split('.');

  if (leftInt.length !== rightInt.length) return leftInt.length - rightInt.length;
  if (leftInt !== rightInt) return leftInt < rightInt ? -1 : 1;

  const width = Math.max(leftFrac.length, rightFrac.length);
  const leftPadded = leftFrac.padEnd(width, '0');
  const rightPadded = rightFrac.padEnd(width, '0');
  if (leftPadded === rightPadded) return 0;
  return leftPadded < rightPadded ? -1 : 1;
}

// ─── payload ────────────────────────────────────────────────────────────────

/**
 * One level's entitlements, as a screen reads them.
 *
 * ═══ THE SAME SHAPE THE WRITE TAKES, PLUS THE SERVER'S OWN FIELDS ══════════
 *
 * `level`, `limits` and `features` are field-for-field what `POST` accepts, so a screen
 * reads, edits and writes back one object. `configured`, `version`, `updatedAt` and the
 * rest are the server's and are not accepted on the way in — a client that tried to
 * send them is refused by `.strict()`.
 */
export interface KycEntitlementLevelView {
  readonly level: string;
  /** Has an administrator ever deliberately written this row? False on a seeded but
   *  untouched level, which is the shipped state of every deployment. */
  readonly configured: boolean;
  readonly version: number;
  readonly limits: {
    readonly currency: string | null;
    readonly withdrawal: string | null;
    readonly exchange: string | null;
    readonly balance: string | null;
  };
  readonly features: KycEntitlementsWriteRequest['features'];
  readonly updatedByAdminId: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
}

/** One target level's upgrade routes. */
export interface KycUpgradeRequirementView {
  readonly targetLevel: string;
  readonly version: number;
  readonly minimumBalance: string | null;
  readonly depositThreshold: string | null;
  readonly depositWindowDays: number | null;
  readonly thresholdCurrency: string | null;
  readonly updatedByAdminId: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
}

/**
 * Everything a KYC entitlement screen needs, in one read.
 *
 * ─── Why the vocabularies are in the payload ──────────────────────────────
 *
 * `levels`, `targetLevels` and `versionToCreate` follow `GET /kyc-policies`: a form
 * that hard-coded the level list would drift from the enum the moment a level was
 * added, and `versionToCreate` spells out the `expectedVersion: 0` convention rather
 * than leaving a client to infer it.
 */
export interface KycEntitlementsPayload {
  /** One entry per level, always all of them, in rank order. */
  readonly entitlements: readonly KycEntitlementLevelView[];
  /**
   * One entry per CONFIGURED target only — absent means "no route to this level is
   * offered", which is a real answer rather than a gap, so these rows are deliberately
   * not seeded and an unconfigured target simply does not appear.
   */
  readonly upgradeRequirements: readonly KycUpgradeRequirementView[];
  readonly levels: readonly string[];
  readonly targetLevels: readonly string[];
  /** What to send as `expectedVersion` to create a row that does not exist. */
  readonly versionToCreate: 0;
}
