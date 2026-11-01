import { z } from 'zod';
import { CAPTCHA_PROVIDERS, type CaptchaProviderState } from './captcha.types';

/**
 * `GET|POST /captcha/providers` — the operator's view of the captcha toggle table,
 * and the one write that changes it.
 *
 * ═══ WHY THIS IS NOT AN ACTION ON `POST /admins` ═══════════════════════════
 *
 * That route's stated invariant is that EVERY action names an `adminId` — it is the
 * one surface that acts on an account other than the caller's own, and being able to
 * say so plainly is why it is a separate prefix. A captcha toggle targets no admin
 * at all, so folding it in would cost that sentence, and the sentence is doing real
 * work for anyone auditing what can touch another account.
 *
 * So this is a single-purpose route with `@UseGuards(SuperAdminGuard)` — one gate,
 * declared, because it does not vary per caller. `POST /admins` is the union-body
 * exception, not the template.
 */

/**
 * A provider name, checked against the const rather than accepted as free text.
 *
 * The COLUMN is free text on purpose, so adding a provider is not a migration and an
 * unknown value simply matches nothing. That is right for a table also written by
 * hand in psql. It is wrong for an API: a typo there should be a 400 the operator can
 * see, not a row that is silently ignored and looks like it worked.
 */
const providerSchema = z.enum(CAPTCHA_PROVIDERS);

/**
 * Turn one provider on or off.
 *
 * `.strict()` like every schema here, so a misspelled field is a refusal rather than
 * a silently ignored one — `{"enable": false}` must not read as `{"enabled": true}`
 * by omission.
 */
export const captchaToggleRequestSchema = z
  .object({
    provider: providerSchema,
    enabled: z.boolean(),
    /**
     * Why, for whoever finds this row at 3am. Required when switching a provider
     * OFF and refused when switching one on.
     *
     * Required on the way off because that is the direction that removes a defence
     * and the one an incident review will ask about. Refused on the way on because
     * the reason column describes why something is disabled — leaving a stale
     * "vendor incident" attached to a provider that is now live would be worse than
     * having no reason at all.
     */
    reason: z.string().trim().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.enabled && value.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'reason is required when disabling a provider',
      });
    }
    if (value.enabled && value.reason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'reason applies only when disabling a provider',
      });
    }
  });

export type CaptchaToggleRequest = z.infer<typeof captchaToggleRequestSchema>;

/** One provider on the wire. `updatedAt` is an ISO string rather than a Date, like
 *  every other timestamp this service returns. */
export interface CaptchaProviderPayload {
  readonly provider: string;
  readonly configured: boolean;
  readonly disabled: boolean;
  readonly live: boolean;
  readonly siteKey: string | null;
  readonly reason: string | null;
  readonly updatedByAdminId: string | null;
  readonly updatedAt: string | null;
}

/**
 * The whole table, plus what an operator needs to interpret it.
 *
 * `propagationSeconds` is here rather than in documentation because it is the answer
 * to the question every operator asks next: "I disabled it, why is it still being
 * offered?". Each instance re-reads on a timer, so a toggle is not instant across a
 * fleet, and a screen that does not say so invites a second write.
 */
export interface CaptchaProvidersPayload {
  readonly providers: readonly CaptchaProviderPayload[];
  readonly propagationSeconds: number;
}

export function toCaptchaProvidersPayload(
  state: readonly CaptchaProviderState[],
  propagationSeconds: number,
): CaptchaProvidersPayload {
  return {
    providers: state.map((entry) => ({
      provider: entry.provider,
      configured: entry.configured,
      disabled: entry.disabled,
      live: entry.live,
      siteKey: entry.siteKey,
      reason: entry.reason,
      updatedByAdminId: entry.updatedByAdminId,
      updatedAt: entry.updatedAt?.toISOString() ?? null,
    })),
    propagationSeconds,
  };
}
