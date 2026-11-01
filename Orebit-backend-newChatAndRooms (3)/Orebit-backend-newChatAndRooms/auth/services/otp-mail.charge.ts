import { KEYS, QuotaService, type QuotaCharge } from '../../redis';
import type { MailUndo } from '../../src/mail/mail.types';
import { policy, quotaSet } from '../limits';

/**
 * ═══ THE REGISTRATION OTP MAIL BUDGET ═══════════════════════════════════════
 *
 * Codes actually EMAILED to one address, across every registration attempt for it.
 *
 * Keyed on the RECIPIENT rather than on the registration, which is the fix for the
 * loophole that made restarting a signup reset the allowance: a caller who could
 * abandon and restart could send as many codes as they liked to any address they
 * chose. The address is what costs money, so the address is what is metered.
 *
 * ─── Why this lives in its own module ───────────────────────────────────────
 *
 * Because two flows spend the same budget and only one of them was charging it.
 * `RegistrationService` held these as private methods, so `OauthService` — which
 * creates a registration and sends the very same first OTP when a provider has not
 * verified the email — had no way to reach them and simply did not charge. The
 * address's budget was therefore enforced on the direct signup path and bypassed
 * entirely by starting the identical signup through a provider.
 *
 * Free functions taking `QuotaService` rather than a third injectable: there is no
 * state here, and making `OauthService` depend on `RegistrationService` to reach two
 * pure helpers would couple two large services for nothing.
 */

/**
 * Charge one send against the recipient's hourly AND daily budget, atomically.
 *
 * One `consumeAll` rather than two calls, because the pair is one decision: charging
 * the hour and then failing the day would spend an hour-slot for a send that never
 * happened. The script grants both or neither.
 *
 * `durable`, so the budget survives a restart of the cache — a mail cost that a Redis
 * bounce hands back is not a budget.
 *
 * `deny` on a cache failure: this is the only thing standing between a caller and
 * unmetered outbound mail, so an outage degrades signup rather than opening a relay.
 */
export async function chargeOtpMail(
  quota: QuotaService,
  emailLower: string,
): Promise<QuotaCharge> {
  return quota.consumeAll(
    quotaSet(
      policy().REGISTRATION.OTP_MAIL_BY_RECIPIENT,
      KEYS.rate.registerOtpMail(emailLower),
      KEYS.rate.registerOtpMailDaily(emailLower),
    ),
    'durable',
    'deny',
  );
}

/**
 * The compensation that hands that charge back, as data the mail worker can run.
 *
 * NOT the same thing as `registration.refund-otp-send`, and both are usually attached
 * together. That one returns a slot to the ROW's per-attempt count, this one returns
 * it to the ADDRESS's budget, and a user who received nothing is owed both. Running
 * only one would leave them a code short somewhere they cannot see.
 */
export function refundOtpMail(charge: QuotaCharge): MailUndo {
  return { kind: 'quota.refund', token: charge.token, keys: charge.keys, store: 'durable' };
}
