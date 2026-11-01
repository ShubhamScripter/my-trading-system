import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { MailService } from '../../src/mail/mail.service';
import { SecurityRestrictionService } from '../../src/restrictions/restrictions.service';
import { antiPhishingCodeOf } from '../../src/settings/antiPhishing/antiPhishing.utility';
import { CacheService, KEYS } from '../../redis';
import { secondsFromNow } from '../../src/utils/public.utils';
import { spendChallenge, verifyChallengeCode } from '../security/challenge';
import { OTP } from '../auth.constants';
import { policy } from '../limits';
import type { ClientContext, Principal } from '../auth.types';
import { REVOKE_REASON } from '../auth.types';
import { generateOtp, pepperedHash } from '../auth.utility';
import { ChallengeDbOperation } from '../persistence/challenge.dboperation';
import { CredentialService } from './credential.service';
import { RecentSecurityChangePolicy } from './recent-security-change.policy';
import { SessionService } from './session.service';
import { UserDbOperation } from '../persistence/user.dboperation';
import type { PasswordChangeRequest, PasswordSetRequest } from '../dto/password.dto';
import { MfaService } from '../../src/2fa/mfa.service';
// A PURE function, not a service — see `assertNotAFactorDowngrade` for why importing
// it across the module boundary is sound and why a second copy of the rule is not.
import { factorRequirementFor } from '../../src/settings/password/password.utility';

/**
 * Setting and changing a password, from inside an authenticated session.
 *
 * Recovery is no longer here. The public forgot/reset pair is gone; a user who has
 * forgotten their password signs in with an emailed code and comes here. The
 * requirement went up rather than down — the old flow needed only the mailbox,
 * this needs the mailbox and a session.
 *
 * Every path through this service ends the account's *other* sessions and sends a
 * notification. Those two together are what make a password change a usable
 * recovery action after a compromise: the attacker is evicted, and if it was the
 * attacker who changed it, the owner finds out.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger('PasswordService');

  constructor(
    private readonly users: UserDbOperation,
    private readonly challenges: ChallengeDbOperation,
    private readonly credentials: CredentialService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    /** The security consequence. `POST /auth/password` is the second of the two
     *  password-change paths and is the same trigger action as the settings one. */
    private readonly restrictions: SecurityRestrictionService,
    private readonly cache: CacheService,
    /** The security cooldown after an email change. Both paths below ask it; neither
     *  `requestCode` nor anything else in this file sends mail on its behalf. */
    private readonly securityChanges: RecentSecurityChangePolicy,
    /** Read-only here, and for one question: does this account have a confirmed
     *  factor that `set` would be downgrading? See `assertNotAFactorDowngrade`. */
    private readonly mfa: MfaService,
  ) {}

  /**
   * Email a code for the `set` action.
   *
   * Authenticated, so there is no enumeration question to answer and no captcha
   * to require — the account is already known. The rate limit is still per
   * account, because a session is not a licence to send unlimited mail.
   */
  async requestCode(principal: Principal, client: ClientContext): Promise<void> {
    const user = await this.requireUser(principal.userId);

    await this.cache.consume(
      KEYS.rate.passwordForgotByEmail(user.emailLower),
      policy().CREDENTIAL.SET_CODE_BY_ACCOUNT,
      // Deny on cache failure: this sends email and has no durable backstop.
      'deny',
    );

    const code = generateOtp();
    // One instant, shared by the row that will verify the code and the message that
    // carries it. Computing it twice would let the two drift, and the queue would then
    // be enforcing a deadline a second or two after the one the database enforces.
    const expiresAt = secondsFromNow(OTP.TTL_SECONDS);

    const codeHash = pepperedHash(code, 'otp');
    const challenge = await this.challenges.issue({
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      codeHash,
      expiresAt,
      ipAddress: client.ip,
    });

    try {
      await this.mail.sendPasswordReset(
        user.email,
        code,
        expiresAt,
        [{ kind: 'cache.refund', key: KEYS.rate.passwordForgotByEmail(user.emailLower) }],
        // From the row this flow already resolved. A password-reset mail is the
        // archetypal phishing target, so this is one of the messages the footer exists
        // for.
        antiPhishingCodeOf(user),
      );
    } catch (error) {
      await this.challenges.invalidateIfHash(challenge.id, codeHash);
      await this.cache.refund(KEYS.rate.passwordForgotByEmail(user.emailLower));
      throw error;
    }
  }

  /**
   * Set a password, proving ownership of the email rather than knowing the old one.
   *
   * Serves two populations that look different to a user and identical here: an
   * account created through a provider that never had a password, and one whose
   * owner has forgotten it. Both can read the mailbox and neither can supply a
   * current password, so both take this path.
   */
  async set(
    principal: Principal,
    input: PasswordSetRequest,
    client: ClientContext,
  ): Promise<void> {
    const user = await this.requireUser(principal.userId);

    // Before the code is verified, let alone spent. This is the path that needs no
    // knowledge of the current password — only the mailbox and a session — so it is
    // the one an attacker who has just moved the address would take, and the one the
    // freeze matters most on.
    await this.securityChanges.assertNoRecentEmailChange(user.id);

    await this.assertNotAFactorDowngrade(user.id);

    const challenge = await verifyChallengeCode(
      this.challenges,
      user.id,
      'PASSWORD_RESET',
      input.code,
    );

    // Policy is checked HERE — after the code is proven, before it is spent — so a
    // weak password does not burn the code and force another email.
    this.credentials.assertPolicy(input.password, {
      email: user.email,
      username: user.username,
    });

    await spendChallenge(this.challenges, challenge.id);
    await this.commit(principal, input.password, client, 'password set');
  }

  /**
   * Change a password, proving the current one.
   *
   * No emailed code is accepted here, and that is deliberate. Offering two proofs
   * for one action means the weaker of them is the only one that matters — the
   * whole value of asking for the current password is that it is the one thing a
   * mailbox alone cannot supply.
   */
  async change(
    principal: Principal,
    input: PasswordChangeRequest,
    client: ClientContext,
  ): Promise<void> {
    const found = await this.users.findWithCredential(principal.userId);
    if (found === null || found.user.status !== 'ACTIVE') {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }

    // Before the current password is checked, so a frozen account does not feed the
    // durable lockout counter for an operation that could not have succeeded.
    await this.securityChanges.assertNoRecentEmailChange(principal.userId);

    if (found.credential === null) {
      // Nothing to change. Told plainly rather than fudged into an invalid-password
      // error, because the client needs to route the user to `set` instead.
      throw new ProblemException({
        type: ERR.OTP_REQUIRED,
        detail: 'This account has no password yet. Use the set-password flow.',
      });
    }

    // Throws `account_locked` on a locked credential, and counts this failure
    // toward the lockout like any other — a session is not a reason to exempt a
    // password guess from the counter that bounds guessing.
    const valid = await this.credentials.checkPassword(found.credential, input.currentPassword);
    if (!valid) {
      throw new ProblemException({ type: ERR.INVALID_CREDENTIALS });
    }

    this.credentials.assertPolicy(input.password, {
      email: found.user.email,
      username: found.user.username,
    });

    await this.commit(principal, input.password, client, 'password changed');
  }

  /**
   * The tail both paths share: revoke, write, notify.
   *
   * Revoke BEFORE the write, for the same reason the reset flow did: these are two
   * independent commits, and failing after the write would leave the new password
   * live alongside every session it was meant to evict.
   *
   * The caller's own session is kept. Signing someone out of the tab they are
   * standing in as a reward for good security hygiene is hostile, and it buys
   * nothing — that session is the one we just authenticated.
   *
   * ─── Sessions were only half of "other authentication activity" ────────────
   *
   * A sweep ends sign-ins that FINISHED. It cannot see one that is half-way through:
   * a flow whose password was accepted is a `FACTOR_REQUIRED` row holding a `loginId`
   * with the MFA ceremony's budget on it, and no session exists for it yet. Nothing in
   * the second half of that ceremony re-reads the password — `requireAttempt` asks
   * only that the row is live, in that state, and from the same device and network
   * class — so a flow started with the OLD password stayed completable after this ran.
   *
   * That is the whole finding, and it is worse than a stale session: the party holding
   * that handle is, in the case the user is changing their password FOR, the attacker.
   * `expireLiveAttemptsFor` closes it, and sits beside the revoke rather than after the
   * write for the same reason the revoke does — expiring a flow for a change that then
   * fails costs a retry, while writing a password and failing to expire is the bug.
   */
  private async commit(
    principal: Principal,
    password: string,
    client: ClientContext,
    what: string,
  ): Promise<void> {
    const hash = await this.credentials.hash(password);

    // Resolved BEFORE the sweep, and that ordering is load-bearing: the sweep below
    // revokes sessions, and the evaluator reads the acting session row to establish
    // the device identity. Capturing afterwards would classify against a session that
    // had just been revoked.
    const context = await this.restrictions.contextFrom(
      principal.userId,
      principal.sessionId,
      { ipClass: client.ipClass, country: client.country, requestId: null },
    );
    const plan = await this.restrictions.planFor('password.change', context);

    await this.sessions.revokeAllForUserExcept(
      principal.userId,
      principal.sessionId,
      REVOKE_REASON.PASSWORD_CHANGED,
    );
    await this.mfa.expireLiveAttemptsFor(principal.userId);
    await this.users.upsertPassword(principal.userId, hash, { context, plan });

    const user = await this.users.findById(principal.userId);
    if (user !== null) {
      // Not awaited for its outcome — the change has already committed, and a dead
      // SMTP host must not turn a successful password change into a 500 that
      // invites the user to do it again.
      this.mail.sendSecurityChanged(
        user.email,
        what,
        client.ipClass,
        antiPhishingCodeOf(user),
      );
    }

    this.logger.log(
      { userId: principal.userId, ipClass: client.ipClass },
      `${what}; other sessions revoked`,
    );
  }

  /**
   * ═══ THE ONE THING THIS ACTION MUST NOT BE ALLOWED TO DO ════════════════════
   *
   * `set` serves two populations that are identical here and are not identical at
   * all: an account that has NO password, and one whose owner has forgotten theirs.
   * For the first it CREATES a credential, which is safely authorised by the mailbox
   * alone — there is nothing to overwrite. For the second it REPLACES a live
   * password, and if that account has a passkey or an authenticator enrolled, the
   * mailbox alone is a downgrade of the exact protection the owner opted into.
   *
   * `src/settings/password/` splits those into `set` and `forgot` and demands a
   * factor on the second. This action predates that split and cannot express it — it
   * has no field for an assertion or a TOTP code — so it refuses the case rather than
   * serving it weakly. Without this check `POST /auth/password {action:'set'}` would
   * be a one-call bypass of `PASSWORD_FACTOR_REQUIRED`, and the new rule would be
   * documentation rather than a policy.
   *
   * ─── What this deliberately does NOT change ────────────────────────────────
   *
   * Two of the three cases are untouched, and that is the point of putting the check
   * here rather than retiring the action:
   *
   *   no password at all         unaffected. This is `set`'s real job, and the
   *                              provider-created and password-skipped accounts that
   *                              depend on it keep working.
   *   password, but no factor    unaffected. Equivalent to `forgot` on a no-factor
   *                              account, where the emailed code IS the documented
   *                              sufficient authorisation.
   *   password AND a factor      refused, pointing at the route that can ask for the
   *                              proof.
   *
   * ─── Why the pure function rather than a second copy of the rule ───────────
   *
   * `factorRequirementFor` is imported from `src/settings/password/password.utility.ts`
   * — a pure function over an account snapshot, no DI, no cycle. Two implementations
   * of "when is a factor required" is how the settings route and this one would come
   * to disagree, silently, while both returning 200.
   *
   * Importing across the boundary is sound in this direction only because the function
   * is pure. `MfaService` arrives from `TwoFactorCoreModule`, which `AuthModule`
   * already imports and which depends on nothing here — see 2fa.core.module.ts. If
   * this ever needs `PasswordSettingsService` injected, the acyclic split is broken.
   */
  private async assertNotAFactorDowngrade(userId: string): Promise<void> {
    const found = await this.users.findWithCredential(userId);

    // No live password: this is a genuine first-time set, and there is nothing to
    // downgrade. Return before asking about factors — the common case, and one fewer
    // pair of counting queries on it.
    if (found === null || found.credential === null) return;

    const methods = await this.mfa.availableMethods(userId);
    const requirement = factorRequirementFor({
      passwordSet: true,
      passkeyEnabled: methods.includes('passkey'),
      totpEnrolled: methods.includes('totp'),
    });

    if (!requirement.required) return;

    throw new ProblemException({
      type: ERR.PASSWORD_FACTOR_REQUIRED,
      detail:
        'This account has an additional verification enabled, so a password reset ' +
        'must be confirmed with it. Use POST /settings/security/password with ' +
        "action 'forgot'.",
      // The methods that would be accepted there, so a client can render the right
      // prompt without a second call. The caller's own account, behind their own
      // session — no enumeration surface.
      extra: { methods: requirement.methods },
    });
  }

  private async requireUser(userId: string) {
    const user = await this.users.findById(userId);
    if (user === null || user.status !== 'ACTIVE') {
      // A token can outlive a soft-deleted account. Do not turn a stale token into
      // a 500, and do not disclose which of the two happened.
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
    return user;
  }
}
