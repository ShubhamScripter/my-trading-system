import { z } from 'zod';
import { otpCodeSchema, passwordSchema } from './common.dto';

/**
 * `POST /auth/password` — setting and changing a password, from inside the account.
 *
 * This route used to be the public forgot/reset pair. It is now **authenticated**,
 * and recovery moved to email-OTP login: a user who has forgotten their password
 * signs in with an emailed code and changes it here. That is a strict improvement
 * on the old flow, which needed only the mailbox — this needs the mailbox *and* a
 * session.
 *
 * ─── Why three actions and not two ────────────────────────────────────────────
 *
 * The obvious shape is `set` (no password yet) and `change` (has one, prove it).
 * It locks people out. A user who has forgotten their password *has* one, so
 * `set` does not apply — and `change` demands the very thing they cannot supply.
 * The forgotten-password case would have no path at all.
 *
 * So the split is by **what you can prove**, not by what you have:
 *
 *   `change`       you know the current password. No email round trip.
 *   `set`          you can read the account's email. Serves both the account that
 *                  never had a password and the user who has forgotten theirs.
 *   `request-code` sends the code that `set` consumes.
 *
 * `change` deliberately does NOT accept an emailed code. Two proofs for one action
 * would mean the weaker one is the only one that matters, and the point of asking
 * for the current password is that it is something the mailbox alone cannot supply.
 */

const requestCodeSchema = z.object({
  action: z.literal('request-code'),
});

const setSchema = z.object({
  action: z.literal('set'),
  code: otpCodeSchema,
  password: passwordSchema,
  confirmPassword: z.string(),
});

const changeSchema = z.object({
  action: z.literal('change'),
  /** Not `passwordSchema`: the existing password predates the current policy and
   *  must still be presentable. Validating it here would refuse the proof and
   *  strand exactly the users whose passwords need changing most. */
  currentPassword: z.string().min(1).max(200),
  password: passwordSchema,
  confirmPassword: z.string(),
});

export const passwordRequestSchema = z
  .discriminatedUnion('action', [requestCodeSchema, setSchema, changeSchema])
  .superRefine((value, ctx) => {
    if (value.action === 'request-code') return;

    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'Passwords do not match',
      });
    }
  });

export type PasswordRequest = z.infer<typeof requestCodeSchema | typeof setSchema>;
export type PasswordRequestCodeRequest = z.infer<typeof requestCodeSchema>;
export type PasswordSetRequest = z.infer<typeof setSchema>;
export type PasswordChangeRequest = z.infer<typeof changeSchema>;
