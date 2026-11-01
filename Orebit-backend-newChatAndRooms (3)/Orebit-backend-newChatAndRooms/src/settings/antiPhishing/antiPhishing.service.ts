import { Injectable, Logger } from '@nestjs/common';
import { policy } from '../../../auth/limits';
import type { Principal } from '../../../auth/auth.types';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { RecentSecurityChangePolicy } from '../../../auth/services/recent-security-change.policy';
import { CacheService, KEYS } from '../../../redis';
import { TwoFactorService } from '../../2fa/2fa.service';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { MailService } from '../../mail/mail.service';
import { safeEqual } from '../../utils/public.utils';
import type {
  AntiPhishingChangeRequest,
  AntiPhishingReplaceRequest,
  AntiPhishingSetRequest,
} from './antiPhishing.dto';
import {
  ANTI_PHISHING_UNAVAILABLE,
  type AntiPhishingAction,
  type AntiPhishingStatus,
} from './antiPhishing.types';
import {
  antiPhishingCodeOf,
  openAntiPhishingCode,
  sealAntiPhishingCode,
} from './antiPhishing.utility';

/**
 * ═══ THE ANTI-PHISHING CODE, AS A SETTING ITS OWNER CONTROLS ════════════════
 *
 * Three operations over one display string: create it, replace it knowing the current
 * one, replace it without. See `antiPhishing.types.ts` for the policy table, for why
 * this is not a credential, and for why `change`'s extra field is not a control.
 *
 * ─── The shape of the API ───────────────────────────────────────────────────
 *
 *     GET  status  →  POST { action }
 *
 * Two endpoints. No verify-then-act challenge as the Payment PIN has, because there is
 * no second operation for a proof to be bound to: every proof here authorises exactly
 * one write in the same request, so a challenge would add a round trip and a cache
 * record without narrowing anything. `PasswordSettingsService` makes the same call.
 *
 * ─── Where each check sits, and why the order never varies ──────────────────
 *
 * All three operations run the same sequence, and it is the sequence
 * `PaymentPinService` and `PasswordSettingsService` document:
 *
 *   meter → freeze → load state → eligibility → compare currentCode →
 *   consume the emailed code → seal → write → log → notify
 *
 * Metering is FIRST and charged on entry, because a caller hammering this must be
 * refused before it costs a database read and an AES open. The freeze, the eligibility
 * check and the `currentCode` comparison all come BEFORE anything is consumed, because
 * a refusal the server could have issued for free must not first cost the user their
 * emailed code — the slot `assertMethodAvailable` occupies next door.
 *
 * The emailed code is consumed LAST of the checks and immediately before the write. On
 * the other settings surfaces the code is spent before a second proof, so that a wrong
 * code cannot be used to probe whether the other proof was right. That ordering is not
 * available here and is not needed: there is no second proof to probe. `currentCode` is
 * not one — `replace` performs the same write without it — so comparing it first costs
 * an attacker nothing and saves an honest user a code they would otherwise burn on a
 * typo.
 *
 * The mail goes last and unawaited, because the code has already changed and a dead
 * SMTP host must not report a successful change as failed.
 *
 * ─── What this service does NOT do ─────────────────────────────────────────
 *
 * It does not implement OTP, AES-GCM, rate limiting, the security freeze, or mail. Every
 * one is called. It does not sweep sessions — see `finish`. It does not read or write
 * `users` directly; `UserDbOperation` owns that table.
 */
@Injectable()
export class AntiPhishingService {
  private readonly logger = new Logger('AntiPhishing');

  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly users: UserDbOperation,
    private readonly cache: CacheService,
    private readonly mail: MailService,
    /** Today's backing check for `assertChangeAllowed`. Injected rather than called
     *  inline so the seam has one edit point; see that method. */
    private readonly securityChanges: RecentSecurityChangePolicy,
  ) {}

  // ─── read ───────────────────────────────────────────────────────────────

  /**
   * Whether a code is configured.
   *
   * One question, one boolean, and the client renders all three controls from it —
   * `set` is open exactly when this is false. Nothing here leaks: the value describes
   * the caller's own account and reaching it needs that account's session.
   *
   * Deliberately does NOT open the envelope. The status render touches no key material,
   * so a key-ring problem cannot break the settings screen, and there is no code path
   * from this endpoint to the plaintext for a future change to accidentally expose.
   */
  async status(userId: string): Promise<AntiPhishingStatus> {
    return { configured: (await this.users.findAntiPhishing(userId)) !== null };
  }

  // ─── set ────────────────────────────────────────────────────────────────

  /**
   * Create the account's first code: an emailed code, and a code worth storing.
   *
   * ─── Why no second proof, and what bounds that ─────────────────────────────
   *
   * This CREATES a value where there was none, so there is nothing to overwrite and
   * nothing to lose that the mailbox does not already guard. A caller who reaches it
   * already holds a session and the emailed code. The identical argument, and the
   * identical bound, as `PaymentPinService.enable` and `PasswordSettingsService.set`.
   *
   * ─── The precondition is enforced TWICE, and the second one is the real one ─
   *
   * `assertNotConfigured` gives an honest, cheap refusal before the code is spent.
   * `setAntiPhishingIfAbsent` is the arbiter: its `WHERE ciphertext IS NULL` runs under
   * a row lock, so two simultaneous `set` requests produce one code and one
   * `anti_phishing_code_already_set` — never a silent overwrite.
   */
  async set(principal: Principal, ipClass: string, input: AntiPhishingSetRequest): Promise<void> {
    const configured = await this.begin(principal.userId);

    if (configured !== null) {
      throw new ProblemException({
        type: ERR.ANTI_PHISHING_CODE_ALREADY_SET,
        detail:
          `${ANTI_PHISHING_UNAVAILABLE.ALREADY_SET} ` +
          "Use action 'change' if you know it, or 'replace' if you do not.",
      });
    }

    // Everything above was free to the user; from here their emailed code is spent.
    await this.twoFactor.consumeCredentialOtp(principal.userId, input.emailCode);

    if (
      !(await this.users.setAntiPhishingIfAbsent(
        principal.userId,
        sealAntiPhishingCode(input.code, principal.userId),
      ))
    ) {
      // Lost the race, or the cheap check went stale. The honest answer is the one the
      // caller would have received a moment earlier, and nothing was written.
      throw new ProblemException({
        type: ERR.ANTI_PHISHING_CODE_ALREADY_SET,
        detail: ANTI_PHISHING_UNAVAILABLE.ALREADY_SET,
      });
    }

    await this.finish(principal.userId, 'set', ipClass, 'anti-phishing code set');
  }

  // ─── change ─────────────────────────────────────────────────────────────

  /**
   * Replace a code the caller says they know.
   *
   * ─── ⚠ `currentCode` IS NOT AN AUTHORISATION, AND THIS IS THE PROOF ────────
   *
   * `replace` below performs the identical write with no `currentCode` at all. So this
   * comparison cannot be stopping an attacker: anyone who could call this could call
   * that instead, and would. It exists so a user who misremembers their code learns
   * that fact, instead of overwriting a value they will then fail to recognise in their
   * own mail.
   *
   * Which is why it is compared BEFORE the emailed code is consumed, and why its
   * refusal is a 400. A mistyped field should cost a round trip, not a fresh email.
   *
   * ─── Why an unopenable envelope is allowed to throw ────────────────────────
   *
   * `openAntiPhishingCode` throws on a bad tag or a missing key — the database and the
   * key ring disagreeing, which is an operational emergency rather than a wrong-code
   * response. It surfaces as `internal_error`, which is the honest answer and exactly
   * what `openSecret` in totp.ts is documented to do.
   *
   * The user is not stranded by it: `replace` never opens the envelope, so it is the
   * escape hatch from precisely this state and the write it performs heals the row.
   */
  async change(
    principal: Principal,
    ipClass: string,
    input: AntiPhishingChangeRequest,
  ): Promise<void> {
    const sealed = await this.begin(principal.userId);
    this.assertConfigured(sealed);

    const current = openAntiPhishingCode(sealed, principal.userId);

    // Constant-time, though nothing here is a secret worth timing: the value is printed
    // in the user's own email, and a caller who wanted it without knowing it would use
    // `replace`. Used because comparing a stored value with `===` is a habit worth not
    // having, and `safeEqual` costs nothing at this length.
    if (!safeEqual(current, input.currentCode)) {
      throw new ProblemException({
        type: ERR.ANTI_PHISHING_CODE_INCORRECT,
        detail:
          'That is not your current anti-phishing code. ' +
          "It appears in the emails we send you — or use action 'replace' to set a new one.",
      });
    }

    await this.write(principal, ipClass, 'change', input.code, input.emailCode);
  }

  // ─── replace ────────────────────────────────────────────────────────────

  /**
   * Replace a code the caller cannot produce.
   *
   * ═══ WHY THIS EXISTS, AND WHY IT DEMANDS NO FACTOR ══════════════════════════
   *
   * The value lives in the user's inbox rather than in their memory. Someone who has not
   * read an Orebit email in months genuinely cannot produce it, and gating the change on
   * a value only old mail contains would strand them with a code they can neither
   * recognise nor replace — the exact state this feature exists to prevent.
   *
   * `PasswordSettingsService.forgot` makes the same argument and then demands an
   * enrolled factor, because without one anyone holding a session and the mailbox could
   * replace the credential that guards the account. That reason does not reach here: this
   * value guards nothing. An attacker who changes it cannot sign in, cannot move money,
   * and cannot authorise anything — the whole of what they gain is that the owner's next
   * genuine email carries a code the owner does not recognise, which makes the owner
   * TRUST IT LESS. That is a nuisance, and it is bounded by the two things that already
   * apply: the emailed code, and the security freeze in `assertChangeAllowed`.
   *
   * Demanding a passkey or TOTP here would therefore buy no security and would lock
   * every account without a factor out of a setting they are entitled to change.
   */
  async replace(
    principal: Principal,
    ipClass: string,
    input: AntiPhishingReplaceRequest,
  ): Promise<void> {
    const sealed = await this.begin(principal.userId);
    this.assertConfigured(sealed);

    await this.write(principal, ipClass, 'replace', input.code, input.emailCode);
  }

  // ─── the shared spine ───────────────────────────────────────────────────

  /**
   * Meter, freeze-check, and read the account's envelope. The first three lines of all
   * three operations, in one place so their order cannot drift.
   *
   * ─── Charged on ENTRY, and `deny` on a cache failure ──────────────────────
   *
   * Entry, because a caller who abandons the request mid-flight has still cost a
   * database read and an AES open. `deny` because nothing durable backstops this bucket
   * — there is no lockout ladder behind a value that is not a credential — so it is the
   * only bound.
   *
   * ONE bucket for all three operations; see `policy().ANTI_PHISHING.UPDATE_BY_ACCOUNT`
   * for why a per-action key would triple the ceiling while the number still read ten.
   */
  private async begin(userId: string) {
    await this.cache.consume(
      KEYS.rate.antiPhishingUpdateByAccount(userId),
      policy().ANTI_PHISHING.UPDATE_BY_ACCOUNT,
      'deny',
    );

    await this.assertChangeAllowed(userId);

    return this.users.findAntiPhishing(userId);
  }

  /**
   * ═══ THE SECURITY-RESTRICTION SEAM — READ THIS BEFORE CHANGING IT ═══════════
   *
   * Whether this account may change its anti-phishing code right now.
   *
   * ─── ⚠ WHAT BACKS THIS TODAY, AND WHAT DOES NOT EXIST ─────────────────────
   *
   * Today it is `RecentSecurityChangePolicy.assertNoRecentEmailChange`: the account is
   * refused for twenty-four hours after its email address moves. That is ONE column
   * (`users.email_changed_at`) and one duration, and it takes no action parameter.
   *
   * It is emphatically NOT the IP / device / country restriction model. That model does
   * not exist anywhere in this backend, and nothing here pretends otherwise:
   * `src/geo/` ships `NullGeoResolver`, which returns `country: null` for every address;
   * there is no IP-history query and no index on `sessions.ip_class`; and
   * `deviceSeenBefore` sends an email and gates nothing. So there is no evaluator to
   * call and no action identifier to register, and inventing either — an enum, a
   * registry, a per-action duration table — would be building the frame before the thing
   * that fills it, which is how a placeholder becomes the architecture.
   *
   * ─── Why the freeze applies to this setting at all ────────────────────────
   *
   * The founder's list names 2FA, the Payment PIN, the password and the phone number,
   * not this. It is included anyway, for one concrete reason: the "your email address
   * was changed — did you do this?" message goes to the address the account just left
   * and carries the recovery link, and it carries the anti-phishing code. If an attacker
   * who has just moved the address could also change the code, the genuine owner would
   * see an unfamiliar code on the one email that gives them their account back, and the
   * correct response to an unfamiliar code is to distrust the message. Freezing closes
   * that. It is recorded as a product decision in the plan.
   *
   * ─── Why this is a named method and not an inline call ────────────────────
   *
   * So there is exactly one edit point. When the real evaluator lands, this body changes
   * and no flow logic moves — the three operations already express "ask whether this is
   * allowed" rather than "ask whether the email moved". A reader who arrives after that
   * work should find this note before they find the old policy.
   *
   * Paired with `assertNoRecentEmailChangeLocked` inside each write's own transaction,
   * which is the last word on the freeze — this check runs before an emailed code is
   * spent, and an email change can commit in between. The two move together.
   */
  private async assertChangeAllowed(userId: string): Promise<void> {
    await this.securityChanges.assertNoRecentEmailChange(userId);
  }

  /** Both replacing operations need a code to replace. Checked before anything is
   *  consumed, and re-checked by the write itself. */
  private assertConfigured<T>(sealed: T | null): asserts sealed is T {
    if (sealed === null) {
      throw new ProblemException({
        type: ERR.ANTI_PHISHING_CODE_NOT_SET,
        detail: `${ANTI_PHISHING_UNAVAILABLE.NOT_SET} Use action 'set' instead.`,
      });
    }
  }

  /**
   * Spend the emailed code, seal, and replace — the tail `change` and `replace` share.
   *
   * The predicate is on the WRITE: `replaceAntiPhishing` matches only a row that still
   * has a code, so a concurrent removal produces a refusal rather than a resurrection.
   * `set` uses the mirror-image write for the same reason, and neither goes through
   * anything direction-blind.
   *
   * A new code identical to the old one is deliberately ALLOWED — no `..._reused`
   * refusal, unlike `PASSWORD_REUSED` and `PAYMENT_PIN_REUSED`. Re-affirming a display
   * string is harmless: it grants nobody anything, and a user who re-enters the value
   * they already had has changed nothing they needed to change. Refusing it would be
   * friction in exchange for no property. Recorded in the plan as a product decision.
   */
  private async write(
    principal: Principal,
    ipClass: string,
    action: Extract<AntiPhishingAction, 'change' | 'replace'>,
    code: string,
    emailCode: string,
  ): Promise<void> {
    await this.twoFactor.consumeCredentialOtp(principal.userId, emailCode);

    if (
      !(await this.users.replaceAntiPhishing(
        principal.userId,
        sealAntiPhishingCode(code, principal.userId),
      ))
    ) {
      throw new ProblemException({
        type: ERR.ANTI_PHISHING_CODE_NOT_SET,
        detail: ANTI_PHISHING_UNAVAILABLE.NOT_SET,
      });
    }

    await this.finish(principal.userId, action, ipClass, 'anti-phishing code changed');
  }

  /**
   * Log the event and tell the owner.
   *
   * ─── Why NO session sweep ──────────────────────────────────────────────────
   *
   * `PasswordSettingsService.finish` sweeps every other session, and the reason it gives
   * is precise: a password is presented at sign-in, so sessions derive from it, and
   * changing it is how a compromise is answered. Disabling a passkey sweeps for the same
   * reason.
   *
   * Neither reason reaches an anti-phishing code. It is never presented at sign-in, no
   * session anywhere derives from it, and changing it takes nothing away from any live
   * session that the session did not already lack. A sweep here would sign a user out of
   * their other devices to address a threat the sweep does not touch — which is a new
   * session policy adopted for a feature that does not need one. This is
   * `PaymentPinService.disable`'s position, and it is deliberate rather than an omission:
   * `AntiPhishingUpdatedPayload.otherSessionsRevoked` reports `false` as a fact.
   *
   * The other half of that pattern IS kept: the owner is emailed. If this was not their
   * doing, the mail is what tells them — and, because the notification itself carries the
   * code, it shows them the new value at the same time.
   */
  private async finish(
    userId: string,
    action: AntiPhishingAction,
    ipClass: string,
    what: string,
  ): Promise<void> {
    // No code and no `currentCode` in this line, here or in any other logger call in
    // this file. `src/logger.ts` redacts both as a backstop; not putting them here is
    // the defence.
    this.logger.warn({ userId, action, ipClass }, what);

    this.notify(userId, what, ipClass);
  }

  /**
   * Tell the owner something changed.
   *
   * After the write and fire-and-forget by `sendSecurityChanged`'s own contract: the code
   * has already changed, and a mail failure must not report the change as failed and
   * invite the user to do it again.
   *
   * ─── Why the row is re-read rather than reusing what we sealed ─────────────
   *
   * Because this notification is the first email to carry the new code, and it must
   * carry what the DATABASE holds rather than what this request believed it wrote. If a
   * concurrent change landed between the write and here, the row is the truth and the
   * user should be shown the value their next email will actually contain. Re-reading
   * costs the `findById` this method was going to perform anyway to get the address.
   */
  private notify(userId: string, what: string, ipClass: string): void {
    void this.users
      .findById(userId)
      .then((user) => {
        if (user === null) return;
        this.mail.sendSecurityChanged(user.email, what, ipClass, antiPhishingCodeOf(user));
      })
      .catch((err: unknown) => {
        this.logger.error({ err, userId }, 'anti-phishing notification lookup failed');
      });
  }
}
