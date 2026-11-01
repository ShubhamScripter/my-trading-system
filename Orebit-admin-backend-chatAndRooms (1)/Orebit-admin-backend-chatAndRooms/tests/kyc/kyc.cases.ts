import type {
  KycEntitlementsWriteInput,
  KycUpgradeWriteInput,
} from '../../src/kyc/kyc-entitlement.dto';
/**
 * The parity table: one list of bad policy shapes, asserted twice.
 *
 * ═══ WHY THIS IS SHARED RATHER THAN WRITTEN OUT IN EACH SPEC ═══════════════
 *
 * `identity.kyc_policies` carries CHECK constraints that ../Orebit-backend owns, and
 * the DTO in this repository mirrors every one of them. Those are two independent
 * statements of the same rule in two different languages, in two different
 * repositories, with nothing in either type system connecting them.
 *
 * So each case below is used twice:
 *   · `kyc-policy.dto.spec.ts` asserts the DTO rejects it at the boundary, naming the
 *     field — so an operator gets a 400 rather than a 500.
 *   · `kyc.postgres.spec.ts` asserts a direct INSERT of the same value is refused by
 *     the named constraint (SQLSTATE 23514) — so the mirror is provably a mirror.
 *
 * A constraint added over there without a matching DTO rule fails a test HERE, which
 * is the only mechanical link the two repositories have.
 *
 * Not a `.spec.ts`, deliberately: vitest's `include` is `tests/**\/*.spec.ts` and
 * `*.test.ts`, so a plain module here is shared without being collected as a suite.
 */

/** A valid `upsert` body. Every case below is this, with one thing broken. */
export const VALID_POLICY = {
  action: 'upsert' as const,
  region: 'IN',
  level: 'L1',
  enabled: true,
  required: true,
  triggersOnly: false,
  workflowId: null,
  renewalWorkflowId: null,
  balanceThreshold: null,
  lifetimeDepositThreshold: null,
  lifetimeWithdrawalThreshold: null,
  rollingWindowAmount: null,
  rollingWindowSeconds: null,
  rollingWindowOperation: null,
  thresholdCurrency: null,
  features: [] as string[],
  subFeatures: [] as Array<{ feature: string; subFeature: string }>,
  reason: 'Regulatory requirement for this market.',
  expectedVersion: 0,
};

export interface PolicyCase {
  /** What is wrong, phrased as the rule being broken. */
  readonly name: string;
  /** The fields to override on `VALID_POLICY`. */
  readonly patch: Record<string, unknown>;
  /** The DTO issue path an operator should see. */
  readonly path: string;
  /**
   * The database constraint that would have caught it, or null when the rule exists
   * only in the DTO — the lockout guard and the two "dead configuration" rules have no
   * constraint behind them, which is exactly why they are worth stating.
   */
  readonly constraint: string | null;
  /**
   * Column values for the direct-INSERT half of the parity check, when the DTO field
   * is not the column.
   *
   * Only `version` needs this: it is never taken from a request — the writer computes
   * it as `expectedVersion + 1` — so the DTO enforces `ck_kyc_policies_version_positive`
   * transitively, by refusing a negative `expectedVersion`. The database test still has
   * to violate the actual column to prove the constraint is live.
   */
  readonly insert?: Record<string, unknown>;
}

export const CHECK_CASES: readonly PolicyCase[] = [
  // ─── ck_kyc_policies_region ───────────────────────────────────────────────
  {
    name: 'a region that is neither "*" nor two letters',
    patch: { region: '1N' },
    path: 'region',
    constraint: 'ck_kyc_policies_region',
  },
  {
    // The DTO catches this as a region rule; the DATABASE catches it as
    // `VARCHAR(2)` truncation (SQLSTATE 22001) before any CHECK is evaluated. Listed
    // without a constraint because the parity check asserts CHECK violations, and a
    // truncation is a different — equally fatal — failure.
    name: 'a region longer than the column',
    patch: { region: 'IND' },
    path: 'region',
    constraint: null,
  },

  // ─── ck_kyc_policies_level ────────────────────────────────────────────────
  {
    name: 'a level outside L1/L2',
    patch: { level: 'L3' },
    path: 'level',
    constraint: 'ck_kyc_policies_level',
  },
  {
    // NONE is a state an account can be in, never a level a policy can demand.
    name: 'NONE as a required level',
    patch: { level: 'NONE' },
    path: 'level',
    constraint: 'ck_kyc_policies_level',
  },

  // ─── ck_kyc_policies_thresholds_positive ──────────────────────────────────
  {
    name: 'a zero threshold',
    patch: { balanceThreshold: '0', thresholdCurrency: 'USD' },
    path: 'balanceThreshold',
    constraint: 'ck_kyc_policies_thresholds_positive',
  },
  {
    name: 'a zero threshold written with decimals',
    patch: { balanceThreshold: '0.000', thresholdCurrency: 'USD' },
    path: 'balanceThreshold',
    constraint: 'ck_kyc_policies_thresholds_positive',
  },
  {
    name: 'a negative threshold',
    patch: { balanceThreshold: '-5', thresholdCurrency: 'USD' },
    path: 'balanceThreshold',
    constraint: 'ck_kyc_policies_thresholds_positive',
  },

  // ─── ck_kyc_policies_threshold_currency ───────────────────────────────────
  {
    name: 'a threshold with no currency to denominate it',
    patch: { balanceThreshold: '10000' },
    path: 'thresholdCurrency',
    constraint: 'ck_kyc_policies_threshold_currency',
  },

  // ─── ck_kyc_policies_rolling_window_complete ──────────────────────────────
  {
    /**
     * ═══ THE DATABASE DOES NOT CATCH THIS ONE ════════════════════════════════
     *
     * Verified against a real PostgreSQL, and the reason is a property of SQL rather
     * than a typo in the constraint. `ck_kyc_policies_rolling_window_complete` reads:
     *
     *   (amount IS NULL AND seconds IS NULL AND operation IS NULL)
     *   OR (amount IS NOT NULL AND seconds IS NOT NULL AND seconds > 0
     *       AND operation IN ('WITHDRAWAL', 'DEPOSIT'))
     *
     * With amount and seconds set and operation NULL, the first arm is FALSE and the
     * second contains `NULL IN (...)`, which is UNKNOWN — so the whole expression is
     * UNKNOWN, and a CHECK constraint only REFUSES on FALSE. The row is accepted.
     *
     * The consumer's `narrowPolicy` then discards it as `incomplete_rolling_window`,
     * silently, so the policy is configured and enforcing nothing.
     *
     * That makes the DTO rule below the only thing standing between an operator and
     * that state, and it is why `enforcementRejectionOf` has a genuinely reachable
     * case rather than being pure belt and braces. The gap is in the consumer's
     * schema and fixing it is out of scope for this phase; it is reported instead.
     *
     * The other three rolling-window cases DO fire, because each makes the expression
     * FALSE rather than UNKNOWN.
     */
    name: 'a rolling window with no operation',
    patch: {
      rollingWindowAmount: '1000',
      rollingWindowSeconds: 86_400,
      thresholdCurrency: 'USD',
    },
    path: 'rollingWindowOperation',
    constraint: null,
  },
  {
    name: 'a rolling window with no period',
    patch: {
      rollingWindowAmount: '1000',
      rollingWindowOperation: 'WITHDRAWAL',
      thresholdCurrency: 'USD',
    },
    path: 'rollingWindowSeconds',
    constraint: 'ck_kyc_policies_rolling_window_complete',
  },
  {
    name: 'a rolling window with no amount',
    patch: { rollingWindowSeconds: 86_400, rollingWindowOperation: 'WITHDRAWAL' },
    path: 'rollingWindowAmount',
    constraint: 'ck_kyc_policies_rolling_window_complete',
  },
  {
    name: 'a rolling window operation the vocabulary does not contain',
    patch: {
      rollingWindowAmount: '1000',
      rollingWindowSeconds: 86_400,
      rollingWindowOperation: 'TRANSFER',
      thresholdCurrency: 'USD',
    },
    path: 'rollingWindowOperation',
    constraint: 'ck_kyc_policies_rolling_window_complete',
  },

  // The two renewal-period cases that stood here were removed with the columns they
  // exercised. `ck_kyc_policies_renewal` and `ck_kyc_policies_grace` no longer exist:
  // renewal periods are GLOBAL now and live on `kyc_renewal_settings`, whose own
  // equivalents are covered by tests/kyc/kyc-renewal.dto.spec.ts.

  // ─── DTO-only rules: no constraint exists for these ───────────────────────
  // ⚠ `triggersOnly enabled with nothing to trigger on` USED TO BE HERE, and its
  // removal is the point rather than a tidy-up. The DTO refused it on the reasoning
  // that verification in such a region would be permanently unreachable — which stopped
  // being true when `/kyc-requirements` shipped: the consumer's `mayStart` opens
  // verification on ANY open requirement, whatever the policy triggers on.
  //
  // It is now an ACCEPTED shape, asserted in `kyc-policy.dto.spec.ts`. Leaving it here
  // would have made this table assert a rule that no longer exists, and `CHECK_CASES`
  // is also read by `kyc.postgres.spec.ts` — where a DTO-only case carries
  // `constraint: null` and is skipped — so a stale entry here is a silently wrong
  // statement about the API in two places at once.
  {
    name: 'an enabled policy that demands nothing and triggers on nothing',
    patch: { required: false, triggersOnly: false },
    path: 'enabled',
    constraint: null,
  },
  {
    name: 'a currency with no threshold to denominate',
    patch: { thresholdCurrency: 'USD' },
    path: 'thresholdCurrency',
    constraint: null,
  },
  {
    name: 'a duplicate feature',
    patch: { features: ['wallet', 'wallet'], required: true },
    path: 'features',
    constraint: null,
  },
  {
    name: 'a duplicate sub-feature pair',
    patch: {
      subFeatures: [
        { feature: 'wallet', subFeature: 'withdraw' },
        { feature: 'wallet', subFeature: 'withdraw' },
      ],
      required: true,
    },
    path: 'subFeatures',
    constraint: null,
  },
  {
    // `/` is the storage delimiter for a qualified sub-feature, so an id containing one
    // would make `feature/subFeature` ambiguous on the consumer's read.
    name: 'a feature id containing the storage delimiter',
    patch: { features: ['wallet/withdraw'] },
    path: 'features',
    constraint: null,
  },
  {
    name: 'an exponential threshold',
    patch: { balanceThreshold: '1e5', thresholdCurrency: 'USD' },
    path: 'balanceThreshold',
    constraint: null,
  },
  {
    name: 'a threshold with more than 18 decimal places',
    patch: { balanceThreshold: '1.0000000000000000001', thresholdCurrency: 'USD' },
    path: 'balanceThreshold',
    constraint: null,
  },
  {
    // 21 integer digits. numeric(38,18) holds 20, and a 21st is SQLSTATE 22003 —
    // an overflow, not a CHECK violation, and a 500 rather than a 400 if the DTO
    // did not own this ceiling.
    name: 'a threshold too large for numeric(38,18)',
    patch: { balanceThreshold: '123456789012345678901', thresholdCurrency: 'USD' },
    path: 'balanceThreshold',
    constraint: null,
  },
  {
    name: 'an unknown field',
    patch: { sneak: true },
    path: 'sneak',
    constraint: null,
  },
  {
    name: 'an account id smuggled into the body',
    patch: { userId: '00000000-0000-7000-8000-000000000000' },
    path: 'userId',
    constraint: null,
  },
  {
    name: 'a missing reason',
    patch: { reason: '   ' },
    path: 'reason',
    constraint: null,
  },
  {
    // The stored `version` is derived (`expectedVersion + 1`, or 1 on create), so this
    // is how the DTO mirrors `ck_kyc_policies_version_positive`: refusing a negative
    // expectation is what makes a non-positive stored version unreachable.
    name: 'a negative expectedVersion',
    patch: { expectedVersion: -1 },
    path: 'expectedVersion',
    constraint: 'ck_kyc_policies_version_positive',
    insert: { version: 0 },
  },
];

/** The cases a real INSERT can be built from — those with a constraint behind them. */
export const CONSTRAINT_CASES = CHECK_CASES.filter((c) => c.constraint !== null);

// ─── the entitlement matrix ─────────────────────────────────────────────────

/**
 * A valid `POST /kyc-entitlements` body for the `entitlements` action.
 *
 * ═══ WHY THIS LIVES HERE RATHER THAN IN ONE SPEC ═══════════════════════════
 *
 * Seventy-one fields, and three specs need a valid one: the DTO spec derives every
 * rejection case from it, the authorization spec posts it to prove the guard rather
 * than the validation, and `kyc.postgres.spec.ts` writes it against a real database.
 * Three copies of a seventy-one-field literal is three copies that drift apart the
 * first time a field is added.
 *
 * Deliberately CONSERVATIVE: every switch off and every ceiling null, except the few
 * each rule needs. A permissive fixture would mean a DTO rule that stopped firing
 * looked like a pass.
 */
export const VALID_ENTITLEMENTS: KycEntitlementsWriteInput = {
  action: 'entitlements' as const,
  level: 'L1',
  limits: {
    currency: 'USDT',
    withdrawal: '1000',
    exchange: '2000',
    balance: '3000',
  },
  features: {
    profile: { links: true },
    wallet: { disabledCurrencies: [] },
    deposits: { onRamp: true, offRamp: false },
    withdraw: {
      enabled: true,
      maxPerTransaction: '500',
      amountLimit: '1000',
      countLimit: 5,
      limitWindowSeconds: 86_400,
      minimumGapSeconds: 300,
      securityThreshold: '750',
    },
    exchange: {
      enabled: true,
      minAmount: '10',
      maxAmount: '1000',
      maxPerExchange: '500',
      smallExchangeEnabled: true,
      multiCoinExchangeEnabled: false,
      availableCoins: ['BTC', 'ETH'],
    },
    transfer: {
      enabled: true,
      minAmount: '1',
      maxAmount: '100',
      maxPerTransfer: '50',
      maxTransferPerUser: '200',
    },
    staking: {
      enabled: true,
      availableCoins: ['SOL'],
      types: { flexible: true, locked: false },
    },
    merchant: { enabled: false, maxWebsitesOrApps: null },
    tools: {
      bulkPayment: { enabled: false },
      tipBox: { enabled: true, maxTipBoxes: 3 },
      invoiceGenerator: { enabled: false, maxActiveInvoices: null },
    },
    referral: {
      enabled: true,
      allowedDivisions: ['NORTH'],
      allowedTiers: ['GOLD'],
      maxActiveReferralLinks: 10,
    },
    rainpool: { eligible: true, canRain: false },
    ptc: { canViewAds: true, canAdvertise: false },
    tasks: {
      canParticipate: true,
      canAdvertise: false,
      allowedProviders: ['PROVIDER_A'],
    },
    premium: { canPurchase: true, canGift: false },
    shortLink: { enabled: false },
    advertising: { enabled: false },
    coupons: { canCreate: false, canRedeem: true, canPurchaseThirdParty: false },
    loyalty: { enabled: true },
    chat: {
      canAccessPublicChat: true,
      canAdvertiseInChat: false,
      canSendMoney: false,
      allowedRooms: [],
    },
    adExchange: { enabled: false },
    leaderboard: { canReceiveRewards: true },
    faucet: { enabled: true, autoEnabled: false, offlineEnabled: false },
    bankroll: { enabled: false, maxInvestment: null },
  },
  reason: 'Opening the L1 tier for this market.',
  // Not 0: every level always has a seeded row, so there is no create path. The DTO
  // refuses 0 for this action, which is asserted in kyc-entitlement.dto.spec.ts.
  expectedVersion: 1,
};

/** A valid `POST /kyc-entitlements` body for the `upgrade` action. */
export const VALID_UPGRADE: KycUpgradeWriteInput = {
  action: 'upgrade' as const,
  targetLevel: 'L2',
  minimumBalance: '10000',
  depositThreshold: '20000',
  depositWindowDays: 30,
  thresholdCurrency: 'USDT',
  reason: 'Opening the L2 upgrade routes.',
  // 0 IS valid here: these rows are deliberately not seeded, because an absent row
  // means "this route is not offered".
  expectedVersion: 0,
};
