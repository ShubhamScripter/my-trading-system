import { z } from 'zod';

/**
 * What an admin can store for Rainpool (system rain) and User Rain: "RainPool Settings", "Chat Rainpool Main",
 * Chat SETTINGS "/rain" and "Universal Currency and EXP: Per Rain", and Chat SETTINGS "ON / OFF / MAINTENANCE: Rain".
 *
 * Copied BYTE FOR BYTE into the admin backend (src/social/rain/rain.contract.ts). Change both copies, the shared
 * fixture (tests/social/fixtures/rain-contract.fixture.json) and RAIN_CONTRACT_VERSION together. Self-contained on
 * purpose: it imports nothing but zod.
 *
 * Money in this document is USD where the sheets say USD ("Rain Amount: Minimum x USD", "amount above x USD",
 * "X for every y$") and crypto units of their own currency where the sheets say per currency ("Set Separately for
 * Each Currency"). Decimal strings with at most 8 decimals, never floats.
 *
 * Defaults are off: nothing rains until an admin turns a side ON and lists a currency.
 */
export const RAIN_CONTRACT_VERSION = 4;

// ─── Building blocks ───────────────────────────────────────────────────────────────────────────────────────────────

const DECIMAL = /^\d{1,10}(\.\d{1,8})?$/;
const SCALE = 100_000_000n;

/** A decimal string with at most 8 decimals, below 1e10. A number is accepted and turned into its string. */
const DecimalSchema = (what: string) =>
  z
    .union([z.string(), z.number()])
    .transform((value) => (typeof value === 'number' ? String(value) : value.trim()))
    .pipe(z.string().regex(DECIMAL, `${what} with at most 8 decimals, below 10,000,000,000`));

const UsdSchema = DecimalSchema('A USD amount');
const AmountSchema = DecimalSchema('An amount');

/** A decimal string in units of 1e-8, or null when it is not one. */
export function decimalToMinor(text: string): bigint | null {
  const value = text.trim();
  if (!DECIMAL.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(`${frac}00000000`.slice(0, 8));
}

export const RAIN_STATUSES = ['ON', 'OFF', 'MAINTENANCE'] as const;
export type RainStatus = (typeof RAIN_STATUSES)[number];
const StatusSchema = z.enum(RAIN_STATUSES);

const CodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9]{2,10}$/, 'A currency code'));

const UuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'A uuid');

export const DURATION_UNITS = ['SECONDS', 'MINUTES', 'HOURS'] as const;
/** "x Minutes / hours", "x Seconds / Minutes": the number and the unit the admin chose. */
const DurationSchema = z
  .object({
    value: z.number().int().min(1).max(100_000),
    unit: z.enum(DURATION_UNITS),
  })
  .strict();
export type RainDuration = z.infer<typeof DurationSchema>;
const SystemDurationSchema = z
  .object({
    value: z.number().int().min(1).max(100_000),
    unit: z.enum(['MINUTES', 'HOURS']),
  })
  .strict();

export function durationSeconds(duration: RainDuration): number {
  if (duration.unit === 'HOURS') return duration.value * 3600;
  if (duration.unit === 'MINUTES') return duration.value * 60;
  return duration.value;
}

/** "Number of users to Rain: Specific Number / All Active users / x% of active users". */
export const RECIPIENT_MODES = ['SPECIFIC', 'ALL', 'PERCENT'] as const;
export type RecipientMode = (typeof RECIPIENT_MODES)[number];

/**
 * "Percentage of rain to distribute to normal users: x%" and "… to Premium Users (Plan wise): x%". Sums to 100.
 * `*` is every Premium plan not listed on its own. A Premium user whose plan is not listed (and no `*`) counts as
 * normal.
 */
const AllocationSchema = z
  .object({
    normalPercent: z.number().int().min(0).max(100),
    plans: z
      .array(
        z
          .object({
            planId: z.string().trim().min(1).max(64),
            percent: z.number().int().min(0).max(100),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type RainAllocation = z.infer<typeof AllocationSchema>;

/**
 * "EXP and Stars (set Separately) [Can be 0]": FIXED is `amount` each time; DYNAMIC is "X for every y$ worth of
 * rain": `amount` for every `everyUsd`, rounded down, at least 1 when `amount` is above 0 ("Dynamic (min 1)").
 */
const RewardRuleSchema = z
  .object({
    mode: z.enum(['FIXED', 'DYNAMIC']),
    amount: z.number().int().min(0).max(1_000_000),
    everyUsd: UsdSchema,
  })
  .strict();
export type RainRewardRule = z.infer<typeof RewardRuleSchema>;
const RewardPairSchema = z.object({ exp: RewardRuleSchema, stars: RewardRuleSchema }).strict();

/**
 * Chat SETTINGS "/rain: Maximum (Minimum) Amount That can be Rained: Set in USD / Fiat (Same for all Currencies) OR
 * Set Separately for Each Currency". In PER_CURRENCY a currency with no entry cannot be rained.
 */
const AmountLimitSchema = z
  .object({
    mode: z.enum(['USD', 'PER_CURRENCY']),
    usd: UsdSchema,
    perCurrency: z.array(z.object({ code: CodeSchema, amount: AmountSchema }).strict()).max(50),
  })
  .strict();
export type RainAmountLimit = z.infer<typeof AmountLimitSchema>;

/**
 * One questionnaire question. The user must pick an option the admin marked OK, or the rain is rejected ("User
 * must fill the answers marked as OK while creating the questionnaire or the withdrawal will be rejected").
 */
const QuestionSchema = z
  .object({
    text: z.string().trim().min(3).max(300),
    options: z.array(z.string().trim().min(1).max(120)).min(2).max(6),
    /** Indexes into `options` that count as OK. */
    okOptions: z.array(z.number().int().min(0).max(5)).min(1).max(6),
  })
  .strict();
export type RainQuestion = z.infer<typeof QuestionSchema>;

/** "Questionnaire type: Auto Trigger / Manual Trigger", "KYC Check Trigger: Auto / Manual". OFF = not used. */
export const TRIGGERS = ['OFF', 'AUTO', 'MANUAL'] as const;
const TriggerSchema = z.enum(TRIGGERS);

/**
 * "Security Verifications" of a user rain. Each rule is "[Can be set ON / OFF]"; `amountAboveUsd` is its "OR amount
 * above x USD" (null = the rule has no amount trigger). The highest rule that applies wins:
 *  - commonIp: from a common login IP → nothing required. OFF: such rains get the newIpSameCountry checks.
 *  - newIpSameCountry: EMAIL & 2FA, "Require One / Require Both".
 *  - newCountry: EMAIL & 2FA both, then the AUTO verification: questionnaire ON / OFF, KYC check ON / OFF.
 *  - vpnProxy: EMAIL & 2FA both, then MANUAL admin verification (Approve / Reject). The questionnaire and the KYC
 *    check are asked with the codes when AUTO, or requested by the admin during the review when MANUAL.
 */
const SecuritySchema = z
  .object({
    commonIp: z.object({ enabled: z.boolean() }).strict(),
    newIpSameCountry: z
      .object({
        enabled: z.boolean(),
        amountAboveUsd: UsdSchema.nullable(),
        require: z.enum(['ONE', 'BOTH']),
      })
      .strict(),
    newCountry: z
      .object({
        enabled: z.boolean(),
        amountAboveUsd: UsdSchema.nullable(),
        questionnaire: z.boolean(),
        kycCheck: z.boolean(),
      })
      .strict(),
    vpnProxy: z
      .object({
        enabled: z.boolean(),
        amountAboveUsd: UsdSchema.nullable(),
        questionnaire: TriggerSchema,
        kycCheck: TriggerSchema,
      })
      .strict(),
    questions: z.array(QuestionSchema).max(10),
    /** The KYC level the KYC check asks for. */
    kycMinLevel: z.number().int().min(1).max(10),
  })
  .strict();

// ─── The document ──────────────────────────────────────────────────────────────────────────────────────────────────

export const RainConfigSchema = z
  .object({
    /**
     * "ON / OFF / MAINTAIN" with "System Rains: ON / OFF" and "User Rains: ON / OFF" under it. `overall` OFF is
     * "Disable Overall Rains (Neither user nor rainpool can rain)". `note` is the maintenance text users see.
     */
    status: z
      .object({
        overall: StatusSchema,
        system: StatusSchema,
        user: StatusSchema,
        note: z.string().trim().min(1).max(300).nullable(),
      })
      .strict(),
    /** Rainpool: "Select Random Currency - Select Random Amount - Rain - Select Random Time - REPEAT". */
    system: z
      .object({
        /** "Currencies which can be rained by Rainpool (Select)". */
        currencies: z.array(CodeSchema).max(50),
        /** "Rain Amount: Minimum x USD, Maximum x USD". */
        amountUsd: z.object({ min: UsdSchema, max: UsdSchema }).strict(),
        /** "Rain Happens Every: Minimum x Minutes / hours, Maximum x Minutes / hours". */
        interval: z.object({ min: SystemDurationSchema, max: SystemDurationSchema }).strict(),
        /** "Number of users to Rain". SPECIFIC uses `count`, PERCENT uses `percent`. */
        recipients: z
          .object({
            mode: z.enum(RECIPIENT_MODES),
            count: z.number().int().min(1).max(100_000),
            percent: z.number().int().min(1).max(100),
          })
          .strict(),
        /** "if online users are above the threshold, random <threshold> will be selected". Null = no threshold. */
        threshold: z.number().int().min(1).max(100_000).nullable(),
        allocation: AllocationSchema,
        /** The chat room the rain falls in, among the users online there. Null = the Global room. */
        roomId: UuidSchema.nullable(),
      })
      .strict(),
    /** User rain: Chat MAIN "/rain" and Chat SETTINGS "/rain". */
    user: z
      .object({
        /** "Cryptos Allowed to rain: ALL / Select" ("Currencies which can be rained by Users (Select)"). */
        currencies: z.object({ all: z.boolean(), codes: z.array(CodeSchema).max(50) }).strict(),
        minAmount: AmountLimitSchema,
        maxAmount: AmountLimitSchema,
        /**
         * "Number of users to Rain: Specific Number / All Active users / x% of active users": the forms a user may use
         * (`/rain BTC 0.01 5`, `… all`, `… 10%`), and "Minimum / Maximum Amount of Users that can be rained on in a
         * single Rain".
         */
        recipients: z
          .object({
            modes: z.array(z.enum(RECIPIENT_MODES)).min(1).max(RECIPIENT_MODES.length),
            min: z.number().int().min(1).max(10_000),
            max: z.number().int().min(1).max(10_000),
          })
          .strict(),
        allocation: AllocationSchema,
        /** "Channels where raining is Allowed: ALL / Select". */
        channels: z.object({ all: z.boolean(), roomIds: z.array(UuidSchema).max(200) }).strict(),
        /** "Fess on Rains done by users (%)": cut first, the rest is distributed. */
        feePercent: z.number().min(0).max(100).multipleOf(0.01),
        /** "Auto Repeat Rains Option: OFF / ON: Min / Max Repeat Count, Min / Max Gap Duration". */
        autoRepeat: z
          .object({
            enabled: z.boolean(),
            minCount: z.number().int().min(1).max(100),
            maxCount: z.number().int().min(1).max(100),
            minGap: DurationSchema,
            maxGap: DurationSchema,
          })
          .strict(),
      })
      .strict(),
    /** "EXP and Stars: Per Rain Done / Every Rain Received" (Chat SETTINGS "Universal Currency and EXP: Per Rain"). */
    rewards: z.object({ perRainDone: RewardPairSchema, perRainReceived: RewardPairSchema }).strict(),
    security: SecuritySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const positive = (text: string) => (decimalToMinor(text) ?? 0n) > 0n;

    // Rainpool
    const usd = value.system.amountUsd;
    if (!positive(usd.min) || decimalToMinor(usd.max)! < decimalToMinor(usd.min)!) {
      issue(['system', 'amountUsd', 'max'], 'Maximum must be at least the minimum, and both above zero');
    }
    const lo = durationSeconds(value.system.interval.min);
    const hi = durationSeconds(value.system.interval.max);
    if (lo < 30 || hi > 7 * 24 * 3600) issue(['system', 'interval'], 'Between 30 seconds and 7 days');
    if (lo > hi) issue(['system', 'interval', 'max'], 'Must be at least the minimum');
    if (new Set(value.system.currencies).size !== value.system.currencies.length) {
      issue(['system', 'currencies'], 'Each currency may be listed once');
    }
    allocationIssues(value.system.allocation, ['system', 'allocation'], issue);

    // User rain
    const user = value.user;
    if (user.recipients.min > user.recipients.max) {
      issue(['user', 'recipients', 'max'], 'Must be at least the minimum');
    }
    if (new Set(user.recipients.modes).size !== user.recipients.modes.length) {
      issue(['user', 'recipients', 'modes'], 'Each form may be listed once');
    }
    allocationIssues(user.allocation, ['user', 'allocation'], issue);
    for (const side of ['minAmount', 'maxAmount'] as const) {
      const limit = user[side];
      if (limit.mode === 'USD' && !positive(limit.usd)) issue(['user', side, 'usd'], 'Must be above zero');
      const codes = limit.perCurrency.map((c) => c.code);
      if (new Set(codes).size !== codes.length) issue(['user', side, 'perCurrency'], 'Each currency may be listed once');
      limit.perCurrency.forEach((c, i) => {
        if (!positive(c.amount)) issue(['user', side, 'perCurrency', i, 'amount'], 'Must be above zero');
      });
    }
    if (user.minAmount.mode === 'USD' && user.maxAmount.mode === 'USD') {
      if (decimalToMinor(user.maxAmount.usd)! < decimalToMinor(user.minAmount.usd)!) {
        issue(['user', 'maxAmount', 'usd'], 'Must be at least the minimum');
      }
    }
    if (user.minAmount.mode === 'PER_CURRENCY' && user.maxAmount.mode === 'PER_CURRENCY') {
      for (const max of user.maxAmount.perCurrency) {
        const min = user.minAmount.perCurrency.find((c) => c.code === max.code);
        if (min && decimalToMinor(max.amount)! < decimalToMinor(min.amount)!) {
          issue(['user', 'maxAmount', 'perCurrency'], `${max.code}: maximum must be at least the minimum`);
        }
      }
    }
    if (new Set(user.currencies.codes).size !== user.currencies.codes.length) {
      issue(['user', 'currencies', 'codes'], 'Each currency may be listed once');
    }
    const repeat = user.autoRepeat;
    if (repeat.minCount > repeat.maxCount) issue(['user', 'autoRepeat', 'maxCount'], 'Must be at least the minimum');
    const gapLo = durationSeconds(repeat.minGap);
    const gapHi = durationSeconds(repeat.maxGap);
    if (gapLo < 10 || gapHi > 7 * 24 * 3600) issue(['user', 'autoRepeat'], 'Gaps between 10 seconds and 7 days');
    if (gapLo > gapHi) issue(['user', 'autoRepeat', 'maxGap'], 'Must be at least the minimum gap');

    // Rewards
    for (const kind of ['perRainDone', 'perRainReceived'] as const) {
      for (const what of ['exp', 'stars'] as const) {
        const rule = value.rewards[kind][what];
        if (rule.mode === 'DYNAMIC' && rule.amount > 0 && !positive(rule.everyUsd)) {
          issue(['rewards', kind, what, 'everyUsd'], 'Must be above zero for "X for every y$"');
        }
      }
    }

    // Security
    const security = value.security;
    security.questions.forEach((q, i) => {
      if (q.okOptions.some((o) => o >= q.options.length)) {
        issue(['security', 'questions', i, 'okOptions'], 'An OK answer must be one of the options');
      }
    });
    const asksQuestions =
      (security.newCountry.enabled && security.newCountry.questionnaire) ||
      (security.vpnProxy.enabled && security.vpnProxy.questionnaire !== 'OFF');
    if (asksQuestions && security.questions.length === 0) {
      issue(['security', 'questions'], 'The questionnaire is switched on: add at least one question');
    }
  });

function allocationIssues(
  allocation: RainAllocation,
  path: string[],
  issue: (path: (string | number)[], message: string) => void,
): void {
  const total = allocation.normalPercent + allocation.plans.reduce((sum, p) => sum + p.percent, 0);
  if (total !== 100) issue([...path, 'normalPercent'], `Normal and Premium percentages must add up to 100 (now ${total})`);
  const ids = allocation.plans.map((p) => p.planId);
  if (new Set(ids).size !== ids.length) issue([...path, 'plans'], 'Each Premium plan may be listed once');
}

export type RainConfig = z.infer<typeof RainConfigSchema>;
/** What an admin sends. */
export type RainConfigInput = z.input<typeof RainConfigSchema>;

const NO_REWARD: RainRewardRule = { mode: 'FIXED', amount: 0, everyUsd: '1' };

export const DEFAULT_RAIN_CONFIG: RainConfig = {
  status: { overall: 'ON', system: 'OFF', user: 'OFF', note: null },
  system: {
    currencies: [],
    amountUsd: { min: '1', max: '10' },
    interval: { min: { value: 5, unit: 'MINUTES' }, max: { value: 15, unit: 'MINUTES' } },
    recipients: { mode: 'SPECIFIC', count: 1000, percent: 100 },
    threshold: 1000,
    allocation: { normalPercent: 50, plans: [{ planId: '*', percent: 50 }] },
    roomId: null,
  },
  user: {
    currencies: { all: false, codes: [] },
    minAmount: { mode: 'USD', usd: '0.1', perCurrency: [] },
    maxAmount: { mode: 'USD', usd: '1000', perCurrency: [] },
    recipients: { modes: ['SPECIFIC'], min: 1, max: 20 },
    allocation: { normalPercent: 100, plans: [] },
    channels: { all: false, roomIds: [] },
    feePercent: 2,
    autoRepeat: {
      enabled: false,
      minCount: 2,
      maxCount: 5,
      minGap: { value: 60, unit: 'SECONDS' },
      maxGap: { value: 1, unit: 'HOURS' },
    },
  },
  rewards: {
    perRainDone: { exp: NO_REWARD, stars: NO_REWARD },
    perRainReceived: { exp: NO_REWARD, stars: NO_REWARD },
  },
  security: {
    commonIp: { enabled: true },
    newIpSameCountry: { enabled: false, amountAboveUsd: null, require: 'ONE' },
    newCountry: { enabled: false, amountAboveUsd: null, questionnaire: false, kycCheck: false },
    vpnProxy: { enabled: false, amountAboveUsd: null, questionnaire: 'OFF', kycCheck: 'OFF' },
    questions: [],
    kycMinLevel: 1,
  },
};

/**
 * What a side is right now. "Disable Overall Rains" (overall OFF) stops both; overall MAINTENANCE puts every side
 * that is not OFF under maintenance.
 */
export function effectiveStatus(config: Pick<RainConfig, 'status'>, side: 'system' | 'user'): RainStatus {
  const overall = config.status.overall;
  const own = config.status[side];
  if (overall === 'OFF' || own === 'OFF') return 'OFF';
  if (overall === 'MAINTENANCE' || own === 'MAINTENANCE') return 'MAINTENANCE';
  return 'ON';
}

// ─── Scheduled status changes ("ON / OFF / MAINTENANCE (Can be scheduled)") ───────────────────────────────────────

/** A status change the admin scheduled. Absent fields stay as they are; `note` null clears the text. */
export const RainStatusPatchSchema = z
  .object({
    overall: StatusSchema.optional(),
    system: StatusSchema.optional(),
    user: StatusSchema.optional(),
    note: z.string().trim().min(1).max(300).nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one status' });
export type RainStatusPatch = z.infer<typeof RainStatusPatchSchema>;

export function applyStatusPatch(config: RainConfig, patch: RainStatusPatch): RainConfig {
  return {
    ...config,
    status: {
      overall: patch.overall ?? config.status.overall,
      system: patch.system ?? config.status.system,
      user: patch.user ?? config.status.user,
      note: patch.note === undefined ? config.status.note : patch.note,
    },
  };
}

// ─── Reverts ("MODERATION ACTIONS: Revert Specific Rains") ────────────────────────────────────────────────────────

/**
 * Which rains a revert covers: "[all system / user rains] [specific time frame] [specific coins] [specific users /
 * group of users]". `who` null = every rain that matches. RAINER: the user rains these people started, in full.
 * RECIPIENT: only what these people received. A group is "Premium", "KYC" or "Level ≥ value".
 */
export const RainRevertFilterSchema = z
  .object({
    kind: z.enum(['ALL', 'SYSTEM', 'USER']),
    from: z.string().datetime({ offset: true }).nullable(),
    to: z.string().datetime({ offset: true }).nullable(),
    currencies: z.array(CodeSchema).max(50),
    who: z
      .object({
        role: z.enum(['RAINER', 'RECIPIENT']),
        userIds: z.array(UuidSchema).max(1000),
        group: z
          .object({
            targetType: z.enum(['PREMIUM', 'KYC', 'LEVEL']),
            value: z.string().trim().max(16).default(''),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .refine((w) => w.userIds.length > 0 || w.group !== null, { message: 'Pick users or a group' })
      .nullable(),
  })
  .strict()
  .refine((f) => !f.from || !f.to || new Date(f.from).getTime() <= new Date(f.to).getTime(), {
    message: '"from" must be before "to"',
    path: ['to'],
  });
export type RainRevertFilter = z.infer<typeof RainRevertFilterSchema>;

/**
 * "For User Rains: Refund user to the person raining [Does not include fee cut by us] / Do nothing", and "For Users
 * who do not have funds for refund: Refund till 0 / Negative balance".
 */
export const RainRevertPolicySchema = z
  .object({
    payerRefund: z.enum(['REFUND', 'NONE']),
    shortfall: z.enum(['ZERO', 'NEGATIVE']),
  })
  .strict();
export type RainRevertPolicy = z.infer<typeof RainRevertPolicySchema>;
