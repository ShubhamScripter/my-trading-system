import { z } from 'zod';
import { KYC_POLICY_LEVELS, type KycExemptionView } from './kyc.types';

/**
 * Wire shapes for KYC exemptions.
 *
 * ═══ THE MOST DANGEROUS WRITE IN THIS MODULE ═══════════════════════════════
 *
 * A policy misconfiguration obligates people who did not need to verify, which is
 * annoying and visible. An exemption does the opposite and is invisible: the consumer
 * folds a live exemption into `effectiveLevel` on EVERY evaluation, so a grant raises
 * one account's standing platform-wide the moment it commits — with no provider
 * involved and nothing attesting anything.
 *
 * Hence: a mandatory reason on both actions, a mandatory (nullable) expiry so
 * permanence is always deliberate, its own elevation action per verb, and no edit
 * route at all.
 */

const reasonSchema = z.string().trim().min(1).max(256);

/**
 * How far in the future an expiry must sit.
 *
 * ═══ WHY A FLOOR RATHER THAN `> now` ═══════════════════════════════════════
 *
 * This process compares against the Node clock; the row is written against the
 * database clock. Under skew, an expiry a second in the future passes validation and
 * lands already expired — and an expired-but-unrevoked row is the worst possible
 * state: it grants nothing (the consumer's reader skips it) while OCCUPYING the live
 * slot (`ux_kyc_exemptions_live` keys only on `revoked_at IS NULL`), so the account
 * can neither use it nor be granted another.
 *
 * A minute of headroom costs an operator nothing and puts that state out of reach.
 */
const MINIMUM_EXPIRY_LEAD_MS = 60_000;

const grantSchema = z
  .object({
    action: z.literal('grant'),
    userId: z.string().uuid(),
    effectiveLevel: z.enum(KYC_POLICY_LEVELS as unknown as [string, ...string[]]),
    /** NOT NULL in the column, with a `btrim(reason) <> ''` CHECK. Trimming here makes
     *  the stored value canonical so that constraint can never fire. */
    reason: reasonSchema,
    /**
     * When the exemption lapses. `null` is a PERMANENT exemption.
     *
     * Nullable but never optional. An omitted field defaulting to permanent is exactly
     * the accident this field exists to prevent — permanence has to be typed out.
     */
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

/**
 * Withdraw a live exemption.
 *
 * Takes the account as well as the row id. The id alone identifies the row, so this is
 * defence in depth rather than routing: it stops a console that has paired a displayed
 * user with a stale row id from revoking somebody else's exemption, and it means the
 * ownership check is in the WHERE clause rather than in a comparison somebody could
 * later drop.
 */
const revokeSchema = z
  .object({
    action: z.literal('revoke'),
    userId: z.string().uuid(),
    exemptionId: z.string().uuid(),
    reason: reasonSchema,
  })
  .strict();

/**
 * Grant or revoke.
 *
 * The expiry rule sits on the UNION rather than on `grantSchema`, because
 * `z.discriminatedUnion` reads the discriminator off each member's shape and
 * `.superRefine()` wraps a schema in `ZodEffects`, which has none. It returns
 * immediately for `revoke`, which has no cross-field rule of its own.
 */
export const kycExemptionRequestSchema = z
  .discriminatedUnion('action', [grantSchema, revokeSchema])
  .superRefine((input, ctx) => {
    if (input.action !== 'grant' || input.expiresAt === null) return;

    if (Date.parse(input.expiresAt) - Date.now() < MINIMUM_EXPIRY_LEAD_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'must be at least a minute in the future',
      });
    }
  });

export type KycExemptionRequest = z.infer<typeof kycExemptionRequestSchema>;
export type KycExemptionGrantRequest = z.infer<typeof grantSchema>;
export type KycExemptionRevokeRequest = z.infer<typeof revokeSchema>;

/**
 * The list filter.
 *
 * `userId` is optional: with it you get one account's full history, without it every
 * account that currently holds relief — which is the compliance-review question and is
 * bounded, because the partial unique index permits one live row per account.
 */
export const kycExemptionQuerySchema = z
  .object({
    userId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type KycExemptionQuery = z.infer<typeof kycExemptionQuerySchema>;

export interface KycExemptionsPayload {
  readonly exemptions: readonly KycExemptionView[];
  readonly levels: readonly string[];
}
