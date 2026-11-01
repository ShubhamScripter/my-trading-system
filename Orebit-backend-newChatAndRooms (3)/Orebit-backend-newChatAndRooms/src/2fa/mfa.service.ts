import { Injectable, Logger } from '@nestjs/common';
import type { LoginAttempt, LoginState } from '@prisma/client';
import { MFA } from '../../auth/auth.constants';
import { policy } from '../../auth/limits';
import type { ClientContext } from '../../auth/auth.types';
import { pepperedHash } from '../../auth/auth.utility';
import { ERR, type ErrorType } from '../contracts';
import { ProblemException } from '../http';
import { secondsFromNow } from '../utils/public.utils';
import {
  assertAttemptLive,
  assertAttemptsRemain,
  attemptsRemaining,
  isLastAttempt,
} from './attempt';
import { TwoFactorDbOperation } from './2fa.dboperation';
import { hashRecoveryCode } from './recovery';
import { needsReseal, openFactorSecret, sealSecret, verifyCode } from './totp';
import type {
  IdentifiedAttempt,
  MfaChallenge,
  ProvenFactor,
  SignInMethod,
} from './2fa.types';

/**
 * ═══ THE GATE BETWEEN A FIRST FACTOR AND A SESSION ═════════════════════════
 *
 * This is the half of the 2FA module that `auth` depends on, and it is deliberately
 * the half that knows nothing about HTTP, cookies, or sessions. Two questions and
 * two answers:
 *
 *   `challengeFor(flow, userId, from)` — does this account owe a second factor?
 *   Returns `null` when it does not, which is what makes 2FA opt-in: every login
 *   path calls it, and an account with nothing enrolled is unaffected down to the
 *   round trip. When it does, it PROMOTES the caller's existing login flow rather
 *   than minting a handle of its own — there is one handle per sign-in.
 *
 *   `proveFactor(...)` — here is a `loginId` and a code; is the ceremony
 *   complete? Returns the attempt, and the CALLER mints the session.
 *
 * ─── Why the caller mints the session and not this file ────────────────────
 *
 * Because `SessionService` lives in `auth`, and `auth` depends on this module. If
 * this file called back into it, the two modules would be a cycle and Nest would
 * need `forwardRef` to resolve it. Handing the verified attempt back instead keeps
 * the dependency one-way, and it puts session minting where every other path
 * already does it. That is why `TwoFactorModule` (the route surface) can depend on
 * `AuthModule` while `TwoFactorCoreModule` — which provides this — depends on
 * nothing but Prisma.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger('MfaService');

  constructor(private readonly factors: TwoFactorDbOperation) {}

  /**
   * What this account can prove, right now.
   *
   * Recovery codes are listed only when at least one is unspent, so a client never
   * offers a way in that cannot work. TOTP and passkeys are listed only when
   * CONFIRMED — an abandoned enrollment must not make a user think they have a
   * factor they do not.
   */
  async availableMethods(userId: string): Promise<SignInMethod[]> {
    const [totp, passkeys, recovery] = await Promise.all([
      this.factors.listConfirmedTotpFactors(userId),
      this.factors.listPasskeys(userId),
      this.factors.countUnusedRecoveryCodes(userId),
    ]);

    const methods: SignInMethod[] = [];
    if (totp.length > 0) methods.push('totp');
    if (passkeys.length > 0) methods.push('passkey');
    // Recovery codes are never the ONLY method offered: they exist because a real
    // factor is unavailable, and an account holding nothing but codes has no second
    // factor to recover. `hasFactor` below is what decides whether the ceremony
    // happens at all, and it agrees with this by construction.
    if (recovery > 0 && methods.length > 0) methods.push('recovery_code');
    return methods;
  }

  /** Does this account have a real second factor? The one question every login
   *  path asks, and the reason an un-enrolled account never notices this module. */
  async hasFactor(userId: string): Promise<boolean> {
    const methods = await this.availableMethods(userId);
    return methods.includes('totp') || methods.includes('passkey');
  }

  /**
   * Move an existing login flow into its second factor, or answer `null`.
   *
   * `null` means the account has nothing enrolled, and the caller mints a session
   * as it always did — which is what makes 2FA opt-in rather than a flag every
   * path has to remember to check.
   *
   * The client context is already on the row: `start` wrote it, and the session is
   * minted by a LATER request, by which point the one that proved the first factor
   * is gone. Without it the ceremony would silently lose remember-me and the
   * new-device notification would fire for the wrong device. It used to be copied
   * across here, when this method created the row; there is nothing to copy now,
   * which also means there is no opportunity for the two halves of a flow to
   * disagree about which browser they belong to.
   *
   * Nothing about a pending OAuth link travels on this row. Attaching a provider is
   * its own elevated write now — see `POST /auth/link` — so the ceremony has one
   * job, and a sign-in that happens to have been started from the OAuth callback is
   * an ordinary sign-in.
   */
  async challengeFor(
    flow: LoginAttempt,
    userId: string,
    from: LoginState,
  ): Promise<MfaChallenge | null> {
    const methods = await this.availableMethods(userId);
    if (!methods.includes('totp') && !methods.includes('passkey')) {
      return null;
    }

    // ═══ NO SECOND HANDLE IS MINTED HERE ═════════════════════════════════════
    //
    // This used to generate an `mfaToken` — its own 32-byte secret, its own row —
    // because the login flow had no server-side identity until a first factor had
    // succeeded. It does now: the caller arrives holding a `LoginAttempt` that
    // the first factor opened, and the client is already holding the handle that
    // names it.
    //
    // So the ceremony PROMOTES that row rather than opening a second one. What
    // that removes is a seam. With two handles there was a moment where the client
    // had to swap one credential for another mid-sign-in, and the first handle's
    // lifetime, binding and invalidation were a separate set of rules from the
    // second's. One handle for one sign-in means one set of rules.
    //
    // The expiry is re-stamped, and this is the only place that happens. The
    // flow's clock started at `start`, which may have been most of
    // `LOGIN_FLOW.TTL_SECONDS` ago while the user typed; the second factor needs
    // its own budget — long enough to unlock a phone and open an authenticator
    // app. It is a state transition rather than a sliding window, so it can occur
    // at most once per flow and a caller cannot hold one open by repeating a step.
    const expiresAt = secondsFromNow(policy().MFA.CEREMONY_TTL_SECONDS);

    if (
      !(await this.factors.promoteAttempt({
        id: flow.id,
        userId,
        from,
        to: 'FACTOR_REQUIRED',
        expiresAt,
      }))
    ) {
      // Lost the compare-and-swap: something else advanced this flow between the
      // caller resolving it and here. Refused rather than retried — the loser has
      // no way to know it was the same actor.
      throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
    }

    this.logger.log({ userId, attemptId: flow.id, methods }, 'second factor required');
    return { methods, expiresAt };
  }

  /**
   * Charge one guess against an attempt, and refuse once the cap is spent.
   *
   * Extracted so the PASSKEY path can charge too. It previously bypassed attempt
   * accounting entirely — `chargeAttempt` was reachable only from `proveFactor` —
   * so invalid assertions were unlimited for the ceremony's full ten minutes, with
   * no lockout and nothing durable recording them.
   *
   * Charged BEFORE the comparison, matching `proveFactor` and `verifyChallengeCode`:
   * a caller who abandons the request mid-flight has still spent a guess, so the cap
   * cannot be raced.
   */
  async chargeGuess(attemptId: string): Promise<number> {
    const attempts = await this.factors.chargeAttempt(attemptId);
    assertAttemptsRemain(attempts);
    return attempts;
  }

  /**
   * A guess was compared and failed: retire the attempt if that was the last one,
   * and hand back the exception to throw.
   *
   * Returns the error rather than throwing it, so call sites read
   * `throw await mfa.guessFailure(...)`. That is not a style preference — a helper
   * declared `Promise<never>` does not narrow control flow at an `await`, so a
   * throwing version leaves TypeScript believing execution continues and every
   * caller needs an unreachable statement after it. Returning the exception keeps
   * the `throw` visible at the call site, which is also where it belongs.
   *
   * `wrong` is the error for a guess that merely missed; an exhausted attempt always
   * answers `MFA_ATTEMPTS_EXHAUSTED` whichever factor was being proven, because "no
   * guesses left" is the same fact either way.
   */
  async guessFailure(
    attemptId: string,
    attempts: number,
    wrong: ErrorType,
  ): Promise<ProblemException> {
    if (isLastAttempt(attempts)) {
      await this.factors.expireAttempt(attemptId);
      return new ProblemException({ type: ERR.MFA_ATTEMPTS_EXHAUSTED });
    }

    return new ProblemException({
      type: wrong,
      extra: { attemptsRemaining: attemptsRemaining(attempts) },
    });
  }

  /**
   * ═══ A CREDENTIAL CHANGED: END THE SIGN-INS THAT WERE HALF-WAY THROUGH ══════
   *
   * Retire every live login flow for one account, and report how many.
   *
   * The companion to `SessionService.revokeAllForUserExcept` for the state a session
   * sweep cannot reach. A sweep ends flows that FINISHED authenticating; this ends the
   * ones that are still in the middle of it, and the gap between the two is where a
   * changed password stopped meaning what the UI promises.
   *
   * Concretely: a first factor accepted at 12:00 leaves a `FACTOR_REQUIRED` row with
   * the MFA ceremony's budget on it. `requireAttempt` re-checks that the row is live,
   * in that state, and presented from the same device and network class — it does not
   * and cannot re-check the password, because the password is not part of the second
   * half of the ceremony. A password changed at 12:03 therefore left that flow
   * completable by whoever held its `loginId`.
   *
   * ─── Why this is on MfaService rather than on each caller ──────────────────
   *
   * `MfaService` owns the attempt lifecycle — it is what promotes, charges, retires
   * and completes them — and the two password services already inject it. A caller
   * reaching into `TwoFactorDbOperation` for this one write would put the flow's
   * lifecycle in two places, and the second one would be the one that forgets.
   *
   * Never throws for "nothing to do": zero live flows is the ordinary case, and a
   * password change must not fail because the account happened not to be signing in.
   */
  async expireLiveAttemptsFor(userId: string): Promise<number> {
    const retired = await this.factors.expireLiveAttemptsForUser(userId);

    if (retired > 0) {
      // Worth a line: it means somebody's sign-in was cut off mid-ceremony, which is
      // either the owner changing their password in another tab or the event this
      // exists for. `userId` only — a `loginId` is a bearer credential.
      this.logger.warn({ userId, retired }, 'live login flows retired by a credential change');
    }

    return retired;
  }

  /**
   * Resolve a `loginId` to a live, half-authenticated flow, or refuse.
   *
   * Exported separately from `proveFactor` because the passkey path needs the
   * attempt BEFORE it can build a challenge — it has to know whose credentials to
   * name in `allowCredentials`.
   *
   * `client` is REQUIRED, and that is the point: the context check below is the one
   * thing every path into the second half of a ceremony must perform, so it belongs
   * on the function they all already call rather than on each of them. A caller that
   * has no client context now cannot reach an attempt at all.
   */
  async requireAttempt(loginId: string, client: ClientContext): Promise<IdentifiedAttempt> {
    const attempt = await this.factors.findAttemptByTokenHash(pepperedHash(loginId, 'mfa'));
    if (attempt === null) {
      throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
    }
    assertAttemptLive(attempt);
    this.assertSameContext(attempt, client);

    // ═══ THE SECOND FACTOR IS LEGAL FROM EXACTLY ONE STATE ═══════════════════
    //
    // Every path into `POST /auth/2fa/verify` comes through here, so this is where
    // that is enforced for all of them rather than in each. A flow still at
    // STARTED or OTP_SENT has not proven a first factor, so reaching a second one
    // from there would BE the bypass — and a handle from a freshly-started flow is
    // the cheapest kind to come by, because `start` is anonymous and asks for
    // nothing.
    //
    // COMPLETED and EXPIRED cannot arrive here at all: both retire the hash, so
    // the lookup above finds nothing. The check is written against the state
    // anyway, because "the finder happens to exclude it" is a property of the
    // query and this is a property of the flow.
    if (attempt.state !== 'FACTOR_REQUIRED') {
      throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
    }

    // Narrowing, not a check. FACTOR_REQUIRED is only ever reached through
    // `promoteAttempt`, which writes `userId` in the same statement, so a null
    // here would mean a row written by something that bypassed it — a server
    // fault rather than a client one. Refused identically regardless: telling the
    // two apart would say something about the row to someone holding its handle.
    if (attempt.userId === null) {
      throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
    }

    return attempt as IdentifiedAttempt;
  }

  /**
   * ═══ THE SECOND HALF MUST COME FROM THE BROWSER THAT STARTED IT ═════════════
   *
   * The attempt records the device and network that proved the first factor. Until
   * this existed, nothing compared them: the controller simply SUBSTITUTED the
   * stored values into the context it passed to `SessionService.issue`, so whoever
   * held a `loginId` got a session stamped with the original browser's identity.
   *
   * What that bought an attacker with a leaked token and a phished code: a session
   * that inherited the victim's trusted-device `rememberUntil`, and no new-device
   * email, because `deviceSeenBefore` was asked about the victim's device rather
   * than theirs.
   *
   * ─── Why requiring the same device cookie is safe ──────────────────────────
   *
   * The substitution was defended on the grounds that the finishing request may
   * carry no device cookie — a fresh tab, a client that does not persist cookies —
   * and that using the live context would drop remember-me for every 2FA sign-in.
   * That worry does not survive checking the order of events: `contextOf` mints and
   * SETS a device cookie on the first half of the ceremony, so a browser arriving
   * here already has one, and it is the same one. The values match in the ordinary
   * case, which is why comparing them costs nothing and substituting them was never
   * necessary.
   *
   * A client that genuinely holds no cookie jar now has to restart rather than
   * silently inheriting somebody's device identity. That is the correct trade.
   *
   * ─── Class, not address; refuse, not retire ────────────────────────────────
   *
   * `ipClass` for the same reason every other cross-request comparison in this
   * service uses it: a mobile client's exact address moves constantly inside one
   * carrier block, so comparing addresses would refuse legitimate flows and catch
   * none of the real relocations.
   *
   * A mismatch refuses without retiring the attempt, matching
   * `OauthService.assertSameNetwork`. Retiring would let anyone holding a token kill
   * a victim's in-flight ceremony, and the attempt expires on its own in ten minutes
   * regardless.
   */
  // Public, because `LoginService.resolveFlow` applies the same check to the
  // earlier half of the flow. It lives here rather than being lifted somewhere
  // neutral so there is exactly one copy of the comparison, one policy switch and
  // one warning log — a second implementation in `auth` would be a second thing to
  // keep in step with `MFA.ENFORCE_CONTEXT`.
  assertSameContext(attempt: LoginAttempt, client: ClientContext): void {
    const sameDevice = attempt.deviceFingerprint === client.deviceKey;
    const sameNetwork = attempt.ipClass === client.ipClass;
    if (sameDevice && sameNetwork) return;

    // Logged whether or not it is enforced, so turning the policy off leaves the
    // signal intact rather than blinding the thing that would tell you to turn it
    // back on.
    this.logger.warn(
      {
        userId: attempt.userId,
        attemptId: attempt.id,
        sameDevice,
        sameNetwork,
        enforced: MFA.ENFORCE_CONTEXT,
      },
      'second factor presented from a different device or network than the first',
    );

    if (!MFA.ENFORCE_CONTEXT) return;
    throw new ProblemException({ type: ERR.MFA_CONTEXT_MISMATCH });
  }

  /**
   * Prove a factor and close the ceremony.
   *
   * ─── The order of operations, which is the security content ────────────────
   *
   * 1. Resolve and liveness-check the attempt. An expired or spent one costs no
   *    guess, because a slow user must not lose attempts to the clock.
   * 2. Charge an attempt BEFORE comparing anything. A caller who abandons the
   *    request mid-flight has still spent a guess, so the cap cannot be raced.
   * 3. Compare. On failure, report how many guesses remain.
   * 4. Compare-and-swap the attempt to COMPLETED. Losing that swap is a FAILURE,
   *    not a quiet success — a loser presented a correct code that something else
   *    already spent, which for a sign-in would mean two sessions from one proof.
   *
   * The verified attempt is returned rather than a session, for the reason in the
   * class comment.
   */
  async proveFactor(input: {
    loginId: string;
    method: SignInMethod;
    /** The TOTP or recovery code. Absent for the passkey path, which verifies its
     *  assertion in the route module and calls `completeProven` directly. */
    code: string;
    /** The device and network finishing the ceremony, checked against the ones that
     *  started it. Required — see `assertSameContext`. */
    client: ClientContext;
  }): Promise<ProvenFactor> {
    const attempt = await this.requireAttempt(input.loginId, input.client);

    const available = await this.availableMethods(attempt.userId);
    if (!available.includes(input.method)) {
      // Not charged as an attempt: naming a method the account does not have is a
      // client mistake, not a guess at a credential.
      throw new ProblemException({ type: ERR.MFA_METHOD_UNAVAILABLE, extra: { available } });
    }

    const attempts = await this.chargeGuess(attempt.id);

    const verified =
      input.method === 'totp'
        ? await this.verifyTotp(attempt.userId, input.code)
        : await this.verifyRecoveryCode(attempt.userId, input.code);

    if (!verified) {
      // Retires the attempt when that was the last guess — which it now actually
      // does. The old inline version tested `attempts >= MFA.MAX_ATTEMPTS`, a
      // condition only reachable when the guard above had already thrown, so
      // `expireAttempt` never fired once. See the note in attempt.ts.
      throw await this.guessFailure(attempt.id, attempts, ERR.MFA_CODE_INVALID);
    }

    return this.completeProven(attempt, input.method);
  }

  /**
   * Close a ceremony whose factor has already been proven elsewhere.
   *
   * The passkey path uses this: its assertion is verified against a challenge in
   * the route module, which owns the WebAuthn dependency, and only the CAS below
   * belongs here.
   */
  async completeProven(attempt: IdentifiedAttempt, method: SignInMethod): Promise<ProvenFactor> {
    if (!(await this.factors.completeAttempt(attempt.id))) {
      // Lost the swap: something else completed this ceremony between the check and
      // here. Treated as a failed verification, because the alternative is two
      // sessions from one proof.
      throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
    }

    this.logger.log(
      { userId: attempt.userId, attemptId: attempt.id, method },
      'second factor proven',
    );
    return { attempt, method };
  }

  /**
   * A TOTP code, against every confirmed factor the account has.
   *
   * Each factor is tried because a user may hold two authenticators and we cannot
   * tell from six digits which one produced them. The step claim inside the loop is
   * what makes trying them all safe: a code that verifies against a factor whose
   * step is already spent is refused with a DISTINCT error rather than silently
   * falling through to the next factor.
   */
  private async verifyTotp(userId: string, code: string): Promise<boolean> {
    const factors = await this.factors.listConfirmedTotpFactors(userId);

    for (const factor of factors) {
      const secret = openFactorSecret(factor);

      const step = verifyCode(secret, code);
      if (step === null) continue;

      if (await this.factors.claimTotpStep(factor.id, step)) {
        await this.resealIfLegacy(factor, secret);
        return true;
      }

      // Arithmetically correct, already spent. Told apart from a wrong code on
      // purpose: a user retyping the digits from their screen needs to know the
      // remedy is to wait thirty seconds, not to check what they typed.
      this.logger.warn({ userId, factorId: factor.id }, 'totp code replayed');
      throw new ProblemException({ type: ERR.MFA_CODE_ALREADY_USED });
    }

    return false;
  }

  /**
   * Upgrade a pre-AAD envelope, once, after it has proven itself.
   *
   * How the v1 format drains: no backfill, no migration window, and no moment where
   * a user cannot sign in. Only rows that have just successfully verified are
   * touched, so a re-seal can never be the thing that breaks a factor.
   *
   * Failures are swallowed. The sign-in has already succeeded by the time this runs,
   * and a bookkeeping write must not be able to fail it — the row simply stays v1 and
   * is retried on the next verification.
   */
  private async resealIfLegacy(
    factor: { id: string; userId: string; keyVersion: number },
    secret: Buffer,
  ): Promise<void> {
    if (!needsReseal(factor.keyVersion)) return;

    try {
      const sealed = sealSecret(secret, factor.userId, factor.id);
      const done = await this.factors.resealTotpSecret(factor.id, factor.keyVersion, {
        secretCiphertext: sealed.ciphertext,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
        keyVersion: sealed.keyVersion,
      });
      if (done) {
        this.logger.log(
          { userId: factor.userId, factorId: factor.id, to: sealed.keyVersion },
          'totp secret re-sealed under the current envelope version',
        );
      }
    } catch (err) {
      this.logger.error({ err, factorId: factor.id }, 'totp re-seal failed; row left as-is');
    }
  }

  /** A recovery code. `spendRecoveryCode` is the compare-and-swap, so the check and
   *  the consumption are one statement and a code cannot be spent twice. */
  private async verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
    const spent = await this.factors.spendRecoveryCode(userId, hashRecoveryCode(code));
    if (spent) {
      const left = await this.factors.countUnusedRecoveryCodes(userId);
      this.logger.warn({ userId, remaining: left }, 'recovery code used');
    }
    return spent;
  }
}
