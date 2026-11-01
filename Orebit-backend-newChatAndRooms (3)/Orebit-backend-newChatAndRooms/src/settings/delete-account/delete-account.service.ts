import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { User } from '@prisma/client';
import { ACCOUNT_DELETION, OTP } from '../../../auth/auth.constants';
import { generateOtp, pepperedHash } from '../../../auth/auth.utility';
import { REVOKE_REASON, type Principal } from '../../../auth/auth.types';
import { policy } from '../../../auth/limits';
import { ChallengeDbOperation } from '../../../auth/persistence/challenge.dboperation';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { verifyChallengeCode } from '../../../auth/security/challenge';
import { RecentSecurityChangePolicy } from '../../../auth/services/recent-security-change.policy';
import { SessionService } from '../../../auth/services/session.service';
import { CacheService, KEYS } from '../../../redis';
import { ElevationService } from '../../2fa/elevation';
import { MfaService } from '../../2fa/mfa.service';
import { TwoFactorService } from '../../2fa/2fa.service';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { MailService } from '../../mail/mail.service';
import { antiPhishingCodeOf } from '../antiPhishing/antiPhishing.utility';
import {
  DELETE_ELEVATION_ACTION,
  PENDING_WITHDRAWALS_PORT,
  type DeletionStatus,
  type PendingWithdrawalsPort,
  type PendingWithdrawalsState,
} from './delete-account.types';
import {
  mayDeleteWithFunds,
  resolveDeleteProof,
  shouldPromptWithdrawal,
  type DeleteProofs,
} from './delete-account.utility';

/**
 * Ending an account, and bringing one back.
 *
 * ═══ WHAT MAKES THIS DIFFERENT FROM EVERY OTHER SETTINGS ACTION ═════════════
 *
 * Every other destructive setting leaves the owner signed in and able to reverse it
 * from the same screen. This one revokes every session it has, including the caller's,
 * so the moment it succeeds there is no authenticated route back. That single fact
 * shapes the whole design:
 *
 *  - the proof is the strictest the repository offers short of inventing one — an
 *    emailed code on every path, and never the account password;
 *  - the destruction waits thirty days, so a deletion nobody asked for is survivable;
 *  - the way back is PUBLIC, because the person who needs it cannot authenticate.
 *
 * ─── Immediate in effect, delayed in destruction ────────────────────────────
 *
 * The delayed social unlink is the architectural template and differs in exactly one
 * place: an unlink leaves the link FULLY LIVE for its seven days, because nothing has
 * been taken away and the delay is a notice period. Here `status` moves and the
 * sessions die in the same request, because an owner asking for their account to stop
 * working is entitled to have it stop working. What waits is the data.
 *
 * ─── Composed, not implemented ──────────────────────────────────────────────
 *
 * No Prisma import, no crypto beyond the shared helpers, no WebAuthn. The provers come
 * from `TwoFactorService`, the ticket from `ElevationService`, the sweep from
 * `SessionService`, every row from `UserDbOperation`.
 *
 * `SessionService` IS injected here, which is the one place this file departs from
 * `LinkAccountsService` — that class omits it so that minting a session is unreachable
 * rather than merely uncalled. This one needs the opposite capability: it must be able
 * to END every session. The methods it reaches for are `revokeAllForUser` and nothing
 * else, and no path here calls `issue`.
 *
 * ─── Ordering ───────────────────────────────────────────────────────────────
 *
 * Bound the attempt → check the cooldown → decide which proof is owed → spend the
 * emailed code → compare the factor. A refusal the server can issue for free must not
 * first cost the user their emailed code.
 */
@Injectable()
export class DeleteAccountService {
  private readonly logger = new Logger('DeleteAccount');

  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly mfa: MfaService,
    private readonly elevation: ElevationService,
    private readonly sessions: SessionService,
    private readonly users: UserDbOperation,
    private readonly challenges: ChallengeDbOperation,
    private readonly securityChange: RecentSecurityChangePolicy,
    private readonly cache: CacheService,
    private readonly mail: MailService,
    @Inject(PENDING_WITHDRAWALS_PORT)
    private readonly withdrawals: PendingWithdrawalsPort,
  ) {}

  // ─── reading the state ────────────────────────────────────────────────────

  /**
   * What the delete-account screen renders.
   *
   * Only two states are reachable from an authenticated request. A purged account has
   * no sessions and no longer resolves in `findById`, so it cannot ask.
   */
  async status(principal: Principal): Promise<{
    status: DeletionStatus;
    purgeAt: Date | null;
    withdrawal: PendingWithdrawalsState;
    withdrawalPromptRequired: boolean;
    methods: readonly string[];
  }> {
    const user = await this.users.findById(principal.userId);
    if (user === null) throw new ProblemException({ type: ERR.NOT_FOUND });

    // Never throws, by the port's contract, so there is no branch here for an outage.
    // `unavailable` is the answer for every account today and means NO SUBSYSTEM IS
    // BOUND — it travels to the client verbatim rather than being collapsed into the
    // boolean beside it, so a client can say something careful about a deployment that
    // genuinely cannot answer the funds question. See withdrawals.service.ts.
    const withdrawal = await this.withdrawals.check(principal.userId);

    return {
      status: user.status === 'DELETED' ? 'deleted' : 'active',
      purgeAt: user.purgeAt,
      withdrawal,
      withdrawalPromptRequired: shouldPromptWithdrawal(withdrawal),
      methods: await this.mfa.availableMethods(principal.userId),
    };
  }

  // ─── the ceremony ─────────────────────────────────────────────────────────

  /**
   * What this account can prove, and the WebAuthn options if it holds a passkey.
   *
   * Delegates to the shared re-authentication challenge with this feature's own
   * action, so the advertised list matches what will actually be accepted.
   * `reauthMethods` withholds `recovery_code` for every intent except factor removal,
   * which is the answer wanted here: a printed sheet must not delete an account.
   */
  async challenge(
    userId: string,
  ): Promise<{ methods: readonly string[]; options: Record<string, unknown> | null }> {
    return this.twoFactor.reauthChallenge(userId, DELETE_ELEVATION_ACTION);
  }

  /**
   * Spend the emailed code and one factor, and issue the ticket for ONE deletion.
   *
   * The ticket is single-use, bound to this session, and bound to `account.delete` —
   * it cannot be spent on a factor change, a social link, or `POST /auth/link`, and no
   * ticket earned for any of those can be spent here.
   */
  async verify(
    principal: Principal,
    input: { emailCode: string } & DeleteProofs,
  ): Promise<{ ticket: string; expiresInSeconds: number; action: string }> {
    // The same bucket `reauth-verify` charges, keyed on the session. This route is
    // bearer-only and compares credentials, so something must bound a stolen access
    // token grinding it; `deny` on a cache failure because there is no durable
    // backstop here the way `Credential.failedAttempts` is for passwords.
    await this.cache.consume(
      KEYS.rate.reauthBySession(principal.sessionId),
      policy().MFA.REAUTH_FAIL_BY_SESSION,
      'deny',
    );

    // The 24-hour freeze after an email change, on the entry path so the refusal is
    // cheap. Deleting an account is the highest-impact thing a moved address could be
    // used for, so if any surface owes this one does. The race-safe half runs inside
    // the write — see `remove`.
    await this.securityChange.assertNoRecentEmailChange(principal.userId);

    const methods = await this.mfa.availableMethods(principal.userId);
    const enrolled = {
      hasTotp: methods.includes('totp'),
      hasPasskey: methods.includes('passkey'),
    };

    // BEFORE anything is consumed — see the ordering note on the class.
    const resolved = resolveDeleteProof(input, enrolled);
    if (!resolved.ok) {
      throw new ProblemException({
        type: ERR.MFA_METHOD_UNAVAILABLE,
        detail: resolved.message,
      });
    }

    // Spent whatever happens next, which is the point: an abandoned request must still
    // have cost the code, and a wrong code must not be usable to probe whether the
    // factor beside it was right.
    await this.twoFactor.consumeCredentialOtp(principal.userId, input.emailCode);

    if (resolved.method !== 'none') {
      const proven =
        resolved.method === 'passkey'
          ? await this.twoFactor.provePasskeyAssertion(
              principal.userId,
              input.passkey as AuthenticationResponseJSON,
            )
          : await this.twoFactor.proveTotpCode(principal.userId, input.totpCode as string);

      if (!proven) {
        throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
      }
    }

    this.logger.log(
      { userId: principal.userId, method: resolved.method, action: DELETE_ELEVATION_ACTION },
      'account deletion verification passed',
    );
    return this.elevation.issue(principal.sessionId, DELETE_ELEVATION_ACTION);
  }

  // ─── the deletion ─────────────────────────────────────────────────────────

  /**
   * Delete the account. Reachable only through `ElevationGuard`, which has already
   * spent a ticket proved for this exact write.
   *
   * ─── What happens, in order, and why that order ─────────────────────────────
   *
   * The rate limit and the cooldown first, because both are refusals the server can
   * issue without touching anything. Then the withdrawal question, because a refusal
   * there is also free and must come before any state moves. Then the conditional
   * update, which is the atomic point of no return. Then the session sweep. Then the
   * mail.
   *
   * The sweep runs AFTER the state change and not before, deliberately. Revoking first
   * would leave a window in which every session was dead and the account still ACTIVE —
   * a user locked out of an account that was never deleted, if the update then lost its
   * race. Moving the state first means the only failure that can interleave leaves an
   * account marked DELETED whose sessions are still live, and those sessions cannot do
   * anything: `SessionService.mint` refuses to rotate them and every sign-in path
   * refuses the status. The next sweep-or-retry closes it. Of the two orderings only
   * one has a failure mode that grants access, and this is the other one.
   *
   * ─── Idempotent on purpose ─────────────────────────────────────────────────
   *
   * A second request returns the standing deadline and writes nothing, following
   * `requestUnlink`. Resetting the countdown on every call would let anyone holding a
   * session hold the purge thirty days away indefinitely; refusing outright would make
   * a double submit look like a failure. In practice a second call is nearly
   * unreachable — the first revoked the session that would have made it — but "nearly"
   * is not a property to rely on when the alternative is three lines.
   */
  async remove(
    principal: Principal,
    acknowledgeFundsForfeited: boolean,
    ipClass: string,
  ): Promise<{ purgeAt: Date }> {
    await this.cache.consume(
      KEYS.rate.deleteAccountByAccount(principal.userId),
      policy().SECURITY_SETTINGS.DELETE_ACCOUNT_BY_ACCOUNT,
      'deny',
    );

    await this.securityChange.assertNoRecentEmailChange(principal.userId);

    const user = await this.users.findById(principal.userId);
    if (user === null) throw new ProblemException({ type: ERR.NOT_FOUND });

    // Already counting down. Return the standing answer rather than re-stamping it.
    if (user.status === 'DELETED' && user.purgeAt !== null) {
      return { purgeAt: user.purgeAt };
    }

    const withdrawal = await this.withdrawals.check(principal.userId);
    if (!mayDeleteWithFunds(withdrawal, acknowledgeFundsForfeited)) {
      throw new ProblemException({
        type: ERR.ACCOUNT_DELETE_FUNDS_PENDING,
        detail:
          'This account still holds funds. Withdraw them first, or confirm that you are deleting the account anyway.',
      });
    }

    const now = new Date();
    const purgeAt = new Date(
      now.getTime() + ACCOUNT_DELETION.RECOVERY_DAYS * 24 * 60 * 60 * 1000,
    );

    if (!(await this.users.requestAccountDeletion(principal.userId, now, purgeAt))) {
      // Lost the compare-and-swap: a second tab deleted between the read and the write.
      // Re-read and answer with whatever is actually true now, rather than reporting a
      // deadline we did not set — `requestUnlink`'s shape.
      const current = await this.users.findById(principal.userId);
      if (current?.purgeAt == null) throw new ProblemException({ type: ERR.NOT_FOUND });
      return { purgeAt: current.purgeAt };
    }

    // The account is DELETED from here on. Everything below is reconciliation, and a
    // failure in any of it leaves a state that grants nothing.
    //
    // Note what is NOT logged: no email address, no username. `userId` and the deadline
    // are what an operator needs to answer "when was this account deleted", and the
    // identifiers are exactly what a purge is meant to remove from the record.
    this.logger.warn(
      { userId: principal.userId, purgeAt, withdrawal: withdrawal.state },
      'account deleted; purge scheduled',
    );

    // Every session, including the caller's. See `REVOKE_REASON.ACCOUNT_DELETED`.
    await this.sessions.revokeAllForUser(principal.userId, REVOKE_REASON.ACCOUNT_DELETED);

    // Fire-and-forget, after the write. The message is a warning with time attached
    // rather than a receipt, so its delivery is not load-bearing — the same reasoning
    // `requestUnlink` states. The recovery route needs only the mailbox, not this mail.
    this.mail.sendAccountDeleted(user.email, purgeAt, ipClass, antiPhishingCodeOf(user));

    return { purgeAt };
  }

  // ─── the way back ─────────────────────────────────────────────────────────

  /**
   * Mail a reactivation code, if there is an account to mail one for.
   *
   * ═══ THIS METHOD MUST BE INDISTINGUISHABLE FOR EVERY ADDRESS ════════════════
   *
   * It is reachable without authentication, so anything it varies on — the payload, the
   * status, the time it takes, which rate-limit bucket it charges — tells a stranger
   * whether an address has an account here. It therefore:
   *
   *  - charges BOTH buckets before resolving anything, so the meter is identical for an
   *    address with an account and one without. A bucket keyed on the resolved
   *    `userId` would be the leak in its purest form: charged only when an account
   *    existed, readable by sending two requests. See
   *    `KEYS.rate.accountReactivationByEmail`;
   *  - returns void on every path, so the caller has nothing to branch on;
   *  - does not throw for an unknown address, a live account, or a purged one. The only
   *    exceptions that escape are the rate limits, which fire on inputs the caller
   *    controls rather than on facts about the account.
   *
   * A purged account cannot be distinguished here even in principle: `findByEmail`
   * filters `deletedAt: null`, so once the sweep has run the row is simply not found.
   * That is not suppression, it is absence — there is no answer being withheld.
   */
  async requestReactivation(email: string, ip: string): Promise<void> {
    const emailLower = email.trim().toLowerCase();

    // Both charged BEFORE the lookup, and both keyed on caller-supplied values. The IP
    // bucket is the one that bounds an enumeration sweep — an attacker walking a list
    // changes the address every request and never reaches the per-address limit.
    await this.cache.consume(
      KEYS.rate.accountReactivationByIp(ip),
      policy().SECURITY_SETTINGS.REACTIVATE_BY_IP,
      'deny',
    );
    await this.cache.consume(
      KEYS.rate.accountReactivationByEmail(emailLower),
      policy().SECURITY_SETTINGS.REACTIVATE_BY_EMAIL,
      'deny',
    );

    const user = await this.users.findByEmail(emailLower);

    // No account, or one that is not deleted. Nothing is sent and nothing is said. A
    // live account deliberately gets no mail at all: telling its owner "somebody asked
    // to restore your account" would be a notification anyone could trigger for anyone,
    // and it reports nothing actionable — no state changed and none could have.
    if (user === null || user.status !== 'DELETED' || user.purgeAt === null) return;

    // The window, checked here so an expired account is not mailed a code that
    // `reactivate` would refuse. Not the authority — that is the conditional update —
    // but a courtesy that avoids sending something useless.
    if (user.purgeAt.getTime() <= Date.now()) return;

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP.TTL_SECONDS * 1000);

    await this.challenges.issue({
      userId: user.id,
      purpose: 'ACCOUNT_REACTIVATION',
      codeHash: pepperedHash(code, 'otp'),
      expiresAt,
      ipAddress: ip,
    });

    // Awaited, unlike the notifications: this IS the ceremony, and a swallowed failure
    // would answer "we have emailed you a code" having emailed nothing. It carries no
    // anti-phishing code — see `sendAccountReactivationCode`.
    await this.mail.sendAccountReactivationCode(user.email, code, expiresAt);

    this.logger.warn({ userId: user.id }, 'account reactivation code sent');
  }

  /**
   * Spend the code and bring the account back.
   *
   * ─── Where the recovery window is actually enforced ─────────────────────────
   *
   * In `UserDbOperation.reactivateAccount`, as a predicate on the UPDATE, and not in
   * this method. A check here followed by a write there would leave a gap in which the
   * purge sweep could destroy the account's data between the two, and this would then
   * resurrect a row whose credentials were already gone. Stated as a predicate, the
   * reactivation and the purge are mutually exclusive by construction.
   *
   * So the ordering below is: verify the code, spend it, then attempt the write and let
   * the database decide. A `false` from the update is the window having closed — or the
   * account never having been deleted, or a concurrent reactivation having won — and
   * the caller is told the same thing for all three.
   *
   * ─── Why a failed reactivation still spends the code ────────────────────────
   *
   * `consumeChallenge` runs before the update. A code that survived a refused
   * reactivation could be replayed against the same account the moment its state
   * changed, and a caller could hold one indefinitely waiting for that. One code, one
   * attempt, whatever the outcome.
   */
  async reactivate(email: string, code: string, ip: string, ipClass: string): Promise<void> {
    const emailLower = email.trim().toLowerCase();

    // Charged BEFORE the lookup and on EVERY request, exactly as `requestReactivation`
    // does, and for the same reason: a budget spent only when an account resolved would
    // be readable by sending two requests and watching for the throttle. This branch
    // used to charge nothing at all, which left the feature's own anti-enumeration
    // control applying to the half of the route that leaked least.
    await this.cache.consume(
      KEYS.rate.accountReactivationByIp(ip),
      policy().SECURITY_SETTINGS.REACTIVATE_BY_IP,
      'deny',
    );
    await this.cache.consume(
      KEYS.rate.accountReactivationByEmail(emailLower),
      policy().SECURITY_SETTINGS.REACTIVATE_BY_EMAIL,
      'deny',
    );

    const user = await this.users.findByEmail(emailLower);

    // ═══ EVERY FAILURE PAST THIS POINT ANSWERS THE SAME THING ══════════════════
    //
    // This route is unauthenticated, so anything it varies on is an oracle. The
    // refusals below are deliberately collapsed into one `otp_invalid`, with no
    // `extra` and no detail, because the alternatives each leak a different fact:
    //
    //   `otp_expired` (410)      — what `verifyChallengeCode` throws when no live code
    //                              exists. Returned only for an address that HAS a
    //                              deleted account, since an unknown one is refused
    //                              before that call. One request, no code, no prior
    //                              challenge, and the 400/410 split tells a stranger
    //                              which addresses are mid-deletion — precisely the
    //                              accounts whose owners are locked out and whose only
    //                              route back is a mailbox.
    //
    //   `attemptsRemaining`      — carried in `extra` on a wrong guess, and absent for
    //                              an address with no account. The same oracle, still
    //                              readable after the status codes are equalised.
    //
    //   `otp_attempts_exhausted` — likewise reachable only for a real account.
    //
    //   `account_recovery_window_expired` — reachable in the lag between `purgeAt`
    //                              passing and the sweep running, and it confirms both
    //                              that the account exists and that it was deleted.
    //
    // The cost is that a legitimate owner whose window has just closed is told their
    // code is invalid rather than that they are too late. That is a real but small
    // loss — the state lasts at most one sweep interval, after which the account no
    // longer resolves and the answer would be `otp_invalid` regardless — and it is the
    // price of the route not being a membership oracle.
    // Written as explicit throws rather than a `refuse()` helper: a helper returning
    // `never` does not narrow `user` for the compiler, and silencing that with a
    // non-null assertion would trade a real check for a comment.
    if (user === null || user.status !== 'DELETED' || user.purgeAt === null) {
      throw new ProblemException({ type: ERR.OTP_INVALID });
    }

    let challenge: Awaited<ReturnType<typeof verifyChallengeCode>>;
    try {
      challenge = await verifyChallengeCode(
        this.challenges,
        user.id,
        'ACCOUNT_REACTIVATION',
        code,
      );
    } catch {
      // Swallowed rather than inspected, deliberately: the point is that no distinction
      // this function could draw is safe to publish here. `verifyChallengeCode` has
      // already charged the attempt and retired a dead code, so the metering and the
      // one-code-one-attempt rule it enforces are unaffected by the refusal being
      // rewritten on the way out.
      throw new ProblemException({ type: ERR.OTP_INVALID });
    }

    // Lost the compare-and-swap on the code: something else spent it. Treated as a
    // failed verification, per `consumeChallenge`'s contract — two requests must not
    // both succeed on one code.
    if (!(await this.challenges.consume(challenge.id))) {
      throw new ProblemException({ type: ERR.OTP_INVALID });
    }

    // The window closed, or a concurrent reactivation won. Same answer as every other
    // failure, for the reason above.
    if (!(await this.users.reactivateAccount(user.id, new Date()))) {
      throw new ProblemException({ type: ERR.OTP_INVALID });
    }

    this.logger.warn({ userId: user.id }, 'account reactivated');

    // The owner still has to sign in: reactivation does not resurrect the sessions the
    // deletion revoked, and nothing here mints one. `SessionService` is injected for
    // `revokeAllForUser` and this path does not touch it.
    this.mail.sendAccountReactivated(user.email, ipClass, antiPhishingCodeOf(user));
  }

  /** Narrowing helper for the purge sweep's log line — see the sweeper. */
  static isRecoverable(user: Pick<User, 'status' | 'deletedAt'>): boolean {
    return user.status === 'DELETED' && user.deletedAt === null;
  }
}
