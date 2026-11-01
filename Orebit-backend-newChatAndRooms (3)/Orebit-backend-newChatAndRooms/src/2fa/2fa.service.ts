import { Injectable, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { OTP } from '../../auth/auth.constants';
import { policy } from '../../auth/limits';
import type { ClientContext } from '../../auth/auth.types';
import { generateOtp, pepperedHash } from '../../auth/auth.utility';
import { ChallengeDbOperation } from '../../auth/persistence/challenge.dboperation';
import { spendChallenge, verifyChallengeCode } from '../../auth/security/challenge';
import { CredentialService } from '../../auth/services/credential.service';
import { RecentSecurityChangePolicy } from '../../auth/services/recent-security-change.policy';
import { MailService } from '../mail/mail.service';
import { antiPhishingCodeOf } from '../settings/antiPhishing/antiPhishing.utility';
import { UserDbOperation } from '../../auth/persistence/user.dboperation';
import { CacheService, KEYS } from '../../redis';
 import { secondsFromNow, uuidv7 } from '../utils/public.utils';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import { TwoFactorDbOperation } from './2fa.dboperation';
import type { ElevationAction } from './elevation';
import { ElevationService } from './elevation';
import { MfaService } from './mfa.service';
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  challengeOf,
  parseChallenge,
  serialiseChallenge,
  verifyAuthentication,
  verifyRegistration,
} from './passkey';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery';
import {
  base32Encode,
  generateSecret,
  openFactorSecret,
  otpauthUri,
  sealSecret,
  verifyCode,
} from './totp';
import type { EnrolledFactor, ProvenFactor, TotpEnrollment } from './2fa.types';

/**
 * Enrollment, management, and re-authentication.
 *
 * Everything here needs a live session, which is what separates it from
 * `MfaService`: that one is reachable half-authenticated and is therefore about the
 * sign-in ceremony only. This one is about the factors a signed-in user owns.
 *
 * It may depend on `auth` services freely — it lives in `TwoFactorModule`, which
 * imports `AuthModule`. `MfaService` may not; see 2fa.core.module.ts.
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger('TwoFactorService');

  constructor(
    private readonly factors: TwoFactorDbOperation,
    private readonly mfa: MfaService,
    private readonly elevation: ElevationService,
    private readonly credentials: CredentialService,
    private readonly users: UserDbOperation,
    private readonly cache: CacheService,
    // The credential-change email code. Reachable because `TwoFactorModule` imports
    // `AuthModule` (which exports the dboperations) and `MailModule` is `@Global`.
    // `MfaService` deliberately cannot have either — see 2fa.core.module.ts.
    private readonly challenges: ChallengeDbOperation,
    private readonly mail: MailService,
    /**
     * The security cooldown after an email change.
     *
     * Injected HERE, into the service both route families funnel through, rather than
     * into the two controllers that call it. `POST /auth/2fa` and
     * `POST /settings/security/{authenticator,passkeys}` reach the same four
     * enrollment methods below with DIFFERENT credential requirements — the settings
     * routes take an emailed code alone, the 2FA route takes an elevation ticket — so
     * a check placed on either route is a check the other route does not have. One
     * check per METHOD is what makes switching endpoints pointless.
     */
    private readonly securityChanges: RecentSecurityChangePolicy,
  ) {}

  // ─── reading ──────────────────────────────────────────────────────────────

  /**
   * Everything enrolled on the caller's own account.
   *
   * Unconfirmed TOTP rows are excluded: a scanned-but-abandoned QR code is not a
   * factor, and listing it would invite a user to believe they are protected when
   * they are not.
   */
  async list(userId: string): Promise<{
    factors: EnrolledFactor[];
    recoveryCodesRemaining: number;
  }> {
    const [totp, passkeys, recoveryCodesRemaining] = await Promise.all([
      this.factors.listConfirmedTotpFactors(userId),
      this.factors.listPasskeys(userId),
      this.factors.countUnusedRecoveryCodes(userId),
    ]);

    const factors: EnrolledFactor[] = [
      ...totp.map((f) => ({
        id: f.id,
        kind: 'TOTP' as const,
        label: f.label,
        createdAt: f.createdAt,
        lastUsedAt: f.lastUsedAt,
      })),
      ...passkeys.map((p) => ({
        id: p.id,
        kind: 'PASSKEY' as const,
        label: p.label,
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt,
      })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    return { factors, recoveryCodesRemaining };
  }

  // ─── re-authentication ────────────────────────────────────────────────────

  /**
   * A challenge for a caller who is about to re-prove a factor.
   *
   * Only passkeys need one — TOTP and the password are submitted directly. Returns
   * the available methods either way so a client can render the right prompt without
   * a second call.
   */
  async reauthChallenge(
    userId: string,
    intent?: ElevationAction,
  ): Promise<{ methods: readonly string[]; options: Record<string, unknown> | null }> {
    const methods = await this.mfa.availableMethods(userId);
    const passkeys = await this.factors.listPasskeys(userId);

    if (passkeys.length === 0) {
      return { methods: this.reauthMethods(methods, intent), options: null };
    }

    const options = await buildAuthenticationOptions(passkeys);
    // Its OWN key, not `KEYS.passkey.registration`. Re-authentication and passkey
    // enrollment are two different ceremonies, and sharing one key meant a
    // bearer-only reauth challenge could overwrite a pending enrollment challenge
    // that had cost an elevation ticket to obtain — and vice versa. The `mode` field
    // caught the confusion at verification, so the symptom was a wasted ticket and a
    // `PASSKEY_CHALLENGE_INVALID`, not a bypass. Separate namespaces remove it.
    await this.cache.set(
      KEYS.passkey.reauth(userId),
      serialiseChallenge({ mode: 'authenticate', challenge: challengeOf(options) }),
      policy().MFA.PASSKEY_CHALLENGE_TTL_SECONDS,
    );

    return { methods: this.reauthMethods(methods, intent), options };
  }

  /**
   * Prove a factor again, and receive a single-use ticket for ONE named write.
   *
   * ─── What counts as a proof here, and the bootstrap ────────────────────────
   *
   * A confirmed factor if the account has one. If it does not, the account password
   * — because with nothing enrolled the password IS the only factor the account
   * has, and a user who cannot obtain a ticket can never reach `totp-add` to enrol
   * their first factor. Demanding more than an account possesses is a lockout, not
   * a defence.
   *
   * The moment a factor exists that branch closes: `hasFactor` is checked first, so
   * a password alone stops earning tickets as soon as there is something stronger to
   * ask for. That ordering is the whole rule and is why it is the first line.
   *
   * ─── When a recovery code IS accepted, and why the rule changed ────────────
   *
   * Only for `account.mfa.remove`. It used to be refused everywhere, on the argument
   * that a printed sheet must not authorise removing the authenticator it backs up —
   * "I lost my phone" and "I found your printout" being the same event.
   *
   * That argument was half right and produced a dead end. A user who genuinely lost
   * their only authenticator still had `hasFactor === true`, so re-authentication
   * demanded the very TOTP code or passkey they no longer possessed. They could sign
   * in with a recovery code and then do nothing: `remove`, `rename`,
   * `recovery-regenerate`, `totp-add` and `passkey-add-challenge` are all
   * ticket-gated, adding a password did not help because `hasFactor` is checked
   * first, and there is no support override in this service. The account was
   * permanently stuck behind a factor that no longer existed.
   *
   * So the rule is scoped rather than absolute: a recovery code may take a factor
   * OFF an account, and may never add one or attach a provider. Removal is the
   * operation whose absence was unrecoverable; enrollment is the one where a found
   * printout would be a takeover. Each code is single-use and spending it is a CAS,
   * so this cannot be replayed — and removing the last factor clears the remaining
   * codes with it.
   */
  async reauthVerify(
    user: User,
    sessionId: string,
    action: ElevationAction,
    input: {
      totpCode?: string;
      password?: string;
      passkey?: AuthenticationResponseJSON;
      recoveryCode?: string;
      /** The emailed code, required for the factor-changing intents. */
      emailCode?: string;
    },
  ): Promise<{ ticket: string; expiresInSeconds: number; action: ElevationAction }> {
    // ─── Why this route needs its own limiter ──────────────────────────────────
    //
    // `reauth-verify` is bearer-only, and on an account with no enrolled factor it
    // compares the account PASSWORD — which charges `Credential.failedAttempts` and
    // can therefore lock the account out. Nothing bounded that: `cache.consume` was
    // not used anywhere in this module, there is no global rate-limit plugin, and
    // `KEYS.rate` had no 2FA bucket. So a stolen access token was enough to lock a
    // user out of their own account through this endpoint.
    //
    // Keyed on the SESSION rather than the user: the caller is authenticated, and
    // metering the session is what makes one compromised token's damage bounded
    // without letting it deny service to the account's other sessions.
    //
    // `deny` on cache failure — unlike the login limiters, there is no durable
    // backstop here that keeps working with Redis down, and this is the only bound.
    await this.cache.consume(
      KEYS.rate.reauthBySession(sessionId),
      policy().MFA.REAUTH_FAIL_BY_SESSION,
      'deny',
    );

    const enrolled = await this.mfa.hasFactor(user.id);

    // The lost-factor path. Checked before `proveEnrolledFactor`, because the whole
    // point is that the enrolled factor is exactly what the caller cannot present.
    //
    // No emailed code is demanded on this branch, deliberately: the scope lists a
    // backup code on its own as sufficient for disabling a factor, and requiring a
    // mailbox round trip as well would re-close the path this release just opened.
    if (input.recoveryCode !== undefined) {
      if (!this.recoveryCodeAllowedFor(action)) {
        throw new ProblemException({
          type: ERR.MFA_METHOD_UNAVAILABLE,
          detail: 'A recovery code can only authorise removing a factor.',
        });
      }

      // `spendRecoveryCode` is the compare-and-swap, so the check and the consumption
      // are one statement and a code cannot be spent twice.
      const spent = await this.factors.spendRecoveryCode(
        user.id,
        hashRecoveryCode(input.recoveryCode),
      );
      if (!spent) {
        throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
      }

      const remaining = await this.factors.countUnusedRecoveryCodes(user.id);
      this.logger.warn(
        { userId: user.id, action, remaining },
        'recovery code spent to authorise factor removal',
      );
      return this.elevation.issue(sessionId, action);
    }

    // Spent before the factor proof: an emailed code the caller does not hold must
    // not be usable to probe whether a TOTP guess was right, and an abandoned request
    // has still consumed it — the same rule the login and password flows apply.
    if (this.emailCodeRequiredFor(action)) {
      await this.consumeCredentialOtp(user.id, input.emailCode);
    }

    const proven = enrolled
      ? await this.proveEnrolledFactor(user.id, input)
      : await this.proveWithPassword(user, input.password);

    if (!proven) {
      // Which credential actually failed: on the bootstrap branch it is the password,
      // and reporting `mfa_code_invalid` for a wrong password told the user to check a
      // code they were never asked for.
      throw new ProblemException({
        type: enrolled ? ERR.MFA_CODE_INVALID : ERR.INVALID_CREDENTIALS,
      });
    }

    return this.elevation.issue(sessionId, action);
  }

  // ─── TOTP enrollment ──────────────────────────────────────────────────────

  /**
   * Begin enrollment: mint a secret, store it sealed and UNCONFIRMED, and return
   * it exactly once.
   *
   * The secret is returned in the clear here and nowhere else — that is the whole
   * point of the step, since the user has to get it into their authenticator. It is
   * sealed before it is stored, so this response is the only moment it exists in
   * plaintext outside an AES envelope.
   *
   * Starting again before confirming supersedes the previous pending row rather
   * than erroring: scanning a QR code and closing the tab is the ordinary way to
   * reach that state, and an unconfirmed factor grants nothing.
   */
  async totpAdd(user: User, label = 'Authenticator'): Promise<TotpEnrollment> {
    // Before the secret is minted: a frozen account must not be handed a TOTP secret
    // it cannot confirm, and a refusal that costs nothing should cost nothing.
    await this.securityChanges.assertNoRecentEmailChange(user.id);

    const confirmed = await this.factors.listConfirmedTotpFactors(user.id);
    if (confirmed.length > 0) {
      // One authenticator per account. Not a technical limit — the schema would take
      // several — but a product one: two secrets means two things to lose track of,
      // and "which of these is my phone" is a question a support ticket asks.
      throw new ProblemException({ type: ERR.MFA_ALREADY_ENROLLED });
    }

    const pending = await this.factors.findPendingTotpFactor(user.id);
    if (pending !== null) {
      await this.factors.softDeleteTotpFactor(pending.id, user.id);
    }

    // The id is minted here rather than by the insert, because the envelope is bound
    // to `(userId, factorId)` and so the id has to exist before the secret is sealed.
    const factorId = uuidv7();
    const secret = generateSecret();
    const sealed = sealSecret(secret, user.id, factorId);
    await this.factors.createTotpFactor({
      id: factorId,
      userId: user.id,
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
      keyVersion: sealed.keyVersion,
      label,
    });

    const base32 = base32Encode(secret);
    return { secret: base32, uri: otpauthUri(base32, user.email) };
  }

  /**
   * Confirm the enrollment by proving the user's authenticator agrees with us.
   *
   * The recovery codes are minted HERE and not at `totpAdd`, because until a code
   * verifies there is no factor to recover from — issuing them earlier would hand
   * out a set that half the time backs up nothing.
   *
   * They are returned exactly once, in this response. Nothing can show them again;
   * `recovery-regenerate` replaces the set.
   */
  async totpConfirm(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    // Checked again rather than trusted from `totpAdd`: the pending row outlives the
    // request that made it, so an enrollment started before a change can arrive here
    // after one. This is also the call that mints the account's first recovery codes.
    await this.securityChanges.assertNoRecentEmailChange(userId);

    const pending = await this.factors.findPendingTotpFactor(userId);
    if (pending === null) {
      throw new ProblemException({ type: ERR.MFA_METHOD_UNAVAILABLE });
    }

    const secret = openFactorSecret(pending);
    const step = verifyCode(secret, code);
    if (step === null) {
      throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
    }

    // Claimed even at enrollment, so the code that confirmed the factor cannot then
    // be replayed to satisfy a sign-in inside the same 30-second step.
    //
    // The result is now REQUIRED to be true. It used to be discarded, which meant a
    // second request presenting the same six digits inside one step sailed past a CAS
    // that had already refused it — see the note on `confirmTotpFactor`. Every other
    // caller of `claimTotpStep` checks it; this one silently did not.
    if (!(await this.factors.claimTotpStep(pending.id, step))) {
      throw new ProblemException({ type: ERR.MFA_CODE_ALREADY_USED });
    }

    // Only for an account that has none. Confirming a second factor must not
    // silently invalidate the codes the user already wrote down.
    const issue = !(await this.factors.hasAnyRecoveryCode(userId));
    const recoveryCodes = issue ? generateRecoveryCodes() : [];

    const confirmed = await this.factors.confirmTotpFactor(
      pending.id,
      userId,
      recoveryCodes.map(hashRecoveryCode),
    );
    if (!confirmed) {
      // Lost the swap. Reported as already-enrolled rather than as a success with an
      // empty code list, because the caller must not be told it enrolled a factor and
      // handed a set of codes that were never stored.
      throw new ProblemException({ type: ERR.MFA_ALREADY_ENROLLED });
    }

    this.logger.log({ userId, factorId: pending.id }, 'totp factor confirmed');

    return { recoveryCodes };
  }

  // ─── passkey enrollment ───────────────────────────────────────────────────

  async passkeyAddChallenge(user: User): Promise<Record<string, unknown>> {
    await this.securityChanges.assertNoRecentEmailChange(user.id);

    const existing = await this.factors.listPasskeys(user.id);
    if (existing.length >= policy().MFA.PASSKEYS_PER_ACCOUNT) {
      throw new ProblemException({ type: ERR.MFA_ALREADY_ENROLLED });
    }

    const options = await buildRegistrationOptions({
      userId: user.id,
      email: user.email,
      name: user.username,
      existing,
    });

    // `mode: 'register'` is written by US and read back at verification, which is
    // what stops a caller choosing which verification path runs against a challenge
    // they hold. See the note on PasskeyChallengeRecord.
    await this.cache.set(
      KEYS.passkey.registration(user.id),
      serialiseChallenge({ mode: 'register', challenge: challengeOf(options) }),
      policy().MFA.PASSKEY_CHALLENGE_TTL_SECONDS,
    );

    return options;
  }

  /**
   * Finish passkey enrollment, returning the recovery codes it earned.
   *
   * ─── Why the return type grew ──────────────────────────────────────────────
   *
   * Because the codes used to be thrown away. They were generated, hashed and
   * dropped on one line, and the method returned only the factor — so a user whose
   * FIRST factor was a passkey was never shown the set that backs it up. Two things
   * then compounded it: `list()` reported `recoveryCodesRemaining: 10`, and
   * `availableMethods` advertised `recovery_code` as a usable sign-in method, so the
   * account was told it had ten codes that had only ever existed as hashes.
   *
   * Worse, it was unrecoverable: a later `totp-confirm` gates on `hasAnyRecoveryCode`,
   * found the invisible set, and returned `recoveryCodes: []`. The user could never
   * obtain a visible set at all without an explicit regenerate they had no reason to
   * suspect they needed.
   *
   * `recoveryCodes` is empty when the account already had a set — the same rule
   * `totpConfirm` follows, so confirming a second factor never invalidates codes
   * already written down.
   */
  async passkeyAddVerify(
    userId: string,
    response: RegistrationResponseJSON,
    label = 'Passkey',
  ): Promise<{ factor: EnrolledFactor; recoveryCodes: string[] }> {
    // Before the challenge is spent, for the same reason `totpConfirm` re-checks: a
    // ceremony started before the address moved must not complete after it. Ordering
    // it ahead of the `take` also means a frozen caller keeps their challenge instead
    // of having it consumed by a request that was never going to succeed.
    await this.securityChanges.assertNoRecentEmailChange(userId);

    // `take` — a challenge is single-use, and reading it with GETDEL is what makes
    // that true rather than merely intended.
    const record = parseChallenge(await this.cache.take(KEYS.passkey.registration(userId)));
    if (record.mode !== 'register') {
      throw new ProblemException({ type: ERR.PASSKEY_CHALLENGE_INVALID });
    }

    const verified = await verifyRegistration(response, record.challenge);

    if ((await this.factors.findPasskeyByCredentialId(verified.credentialId, userId)) !== null) {
      throw new ProblemException({ type: ERR.MFA_ALREADY_ENROLLED });
    }

    const passkey = await this.factors.createPasskey({
      userId,
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      signCount: verified.signCount,
      transports: [...verified.transports],
      aaguid: verified.aaguid,
      label,
    });

    // A passkey is a first factor too, so it earns recovery codes on the same terms
    // TOTP does — an account whose only factor is one security key needs a way back
    // exactly as much as one whose only factor is one phone.
    //
    // The plaintext is KEPT and returned. It used to be generated and discarded on
    // this line; see the docblock.
    const issue = !(await this.factors.hasAnyRecoveryCode(userId));
    const recoveryCodes = issue ? generateRecoveryCodes() : [];
    if (issue) {
      await this.factors.replaceRecoveryCodes(userId, recoveryCodes.map(hashRecoveryCode));
    }

    this.logger.log(
      { userId, passkeyId: passkey.id, issuedRecoveryCodes: issue },
      'passkey enrolled',
    );

    return {
      factor: {
        id: passkey.id,
        kind: 'PASSKEY',
        label: passkey.label,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt,
      },
      recoveryCodes,
    };
  }

  // ─── the sign-in ceremony's passkey half ──────────────────────────────────

  /**
   * A challenge for a half-authenticated caller holding an `loginId`.
   *
   * Keyed on the ATTEMPT rather than the user, so a challenge minted for one
   * sign-in cannot be spent on another — including one belonging to the same person
   * in a different browser.
   */
  async signInPasskeyChallenge(
    loginId: string,
    client: ClientContext,
  ): Promise<Record<string, unknown>> {
    const attempt = await this.mfa.requireAttempt(loginId, client);

    // Metered, but NOT charged against the five-guess cap. Minting a challenge is not
    // a guess — no assertion has been offered — so spending an attempt on it would
    // let a client lock itself out by rendering the prompt twice. Unbounded it was an
    // unmetered path to building options and writing a Redis record, for as long as
    // the attempt lived. `deny` on cache failure: this is the only bound.
    await this.cache.consume(
      KEYS.rate.mfaPasskeyChallengeByAttempt(attempt.id),
      {
        limit: policy().MFA.PASSKEY_CHALLENGES_PER_CEREMONY,
        windowSeconds: policy().MFA.CEREMONY_TTL_SECONDS,
      },
      'deny',
    );

    const passkeys = await this.factors.listPasskeys(attempt.userId);
    if (passkeys.length === 0) {
      throw new ProblemException({ type: ERR.MFA_METHOD_UNAVAILABLE });
    }

    const options = await buildAuthenticationOptions(passkeys);
    await this.cache.set(
      KEYS.passkey.authentication(attempt.id),
      serialiseChallenge({ mode: 'authenticate', challenge: challengeOf(options) }),
      policy().MFA.PASSKEY_CHALLENGE_TTL_SECONDS,
    );
    return options;
  }

  /**
   * Verify an assertion against the ceremony's own challenge, then close it.
   *
   * ─── Why this charges the attempt ──────────────────────────────────────────
   *
   * It used not to, and that was the hole: `chargeAttempt` was reachable only from
   * `MfaService.proveFactor`, so the passkey branch had no cap at all. A holder of an
   * `loginId` could submit unlimited assertions for the ceremony's full ten minutes,
   * with nothing durable recording them and no lockout at the end.
   *
   * Charged BEFORE verification, matching every other proof path: a caller who
   * abandons the request mid-flight has still spent a guess. Forging an assertion is
   * cryptographically infeasible, so the practical value is not stopping a
   * brute-force — it is that the ceremony now has one accounting model instead of two,
   * and an attempt cannot be probed indefinitely through whichever branch was
   * unmetered.
   */
  async signInPasskeyVerify(
    loginId: string,
    response: AuthenticationResponseJSON,
    client: ClientContext,
  ): Promise<ProvenFactor> {
    const attempt = await this.mfa.requireAttempt(loginId, client);
    const attempts = await this.mfa.chargeGuess(attempt.id);

    const record = parseChallenge(await this.cache.take(KEYS.passkey.authentication(attempt.id)));
    if (record.mode !== 'authenticate') {
      throw new ProblemException({ type: ERR.PASSKEY_CHALLENGE_INVALID });
    }

    const passkey = await this.factors.findPasskeyByCredentialId(response.id, attempt.userId);
    if (passkey === null) {
      // The assertion names a credential this account does not own. Same answer as a
      // failed signature — which of the two it was is not information a caller needs.
      throw await this.mfa.guessFailure(
        attempt.id,
        attempts,
        ERR.PASSKEY_VERIFICATION_FAILED,
      );
    }

    let newSignCount: bigint;
    try {
      ({ newSignCount } = await verifyAuthentication(response, record.challenge, passkey));
    } catch (err) {
      // A failed signature is a spent guess like any other, and it must be able to
      // retire the attempt when it was the last one — so it cannot simply propagate.
      if (err instanceof ProblemException) {
        throw await this.mfa.guessFailure(
          attempt.id,
          attempts,
          ERR.PASSKEY_VERIFICATION_FAILED,
        );
      }
      throw err;
    }

    // Awaited, not `void`-ed. Fire-and-forget left the ordering unguaranteed even
    // within this request and made a rejection unhandled — and `touchPasskey` now
    // carries the monotonic predicate that makes the write race-safe.
    await this.factors.touchPasskey(passkey.id, newSignCount, attempt.userId);

    return this.mfa.completeProven(attempt, 'passkey');
  }

  // ─── management ───────────────────────────────────────────────────────────

  /**
   * Removing a factor: refused for both kinds, with a pointer to where it is done.
   *
   * ─── Why this action no longer removes anything ─────────────────────────────
   *
   * Both factors are user SETTINGS now, and turning either off has a policy this
   * route cannot express: one of four alternative proof paths named strictly, every
   * credential of that kind removed rather than one, and every other session swept.
   * This action offers none of that. It accepts any single enrolled factor, makes no
   * distinction between which one, deletes exactly the id it was handed, and leaves
   * other sessions running.
   *
   * So it is not a second way to do the same thing — it is a one-call bypass of the
   * whole policy. A caller who could reach it would need only a ticket (any factor
   * plus an emailed code) to drop the credential that the settings route requires a
   * NAMED path to drop, and the four paths would be documentation rather than a rule.
   * `PASSKEY` was refused first, on exactly this argument; `TOTP` follows it the
   * moment the authenticator has a settings surface of its own.
   *
   * ─── Why the action survives as a shape ─────────────────────────────────────
   *
   * A runtime refusal, not a narrowing of `removeSchema` and not a deletion from
   * `TwoFactorAction`: the published shape of `POST /auth/2fa` does not change, so an
   * existing client gets a 4xx that names its replacement rather than a validation
   * error about an unknown action. `TWO_FACTOR_REQUIRES.remove` is likewise unchanged.
   *
   * `rename` still accepts both kinds — renaming a factor is not removing it, and it
   * has none of the effects that motivated the policy.
   *
   * Removing the last factor still takes the recovery codes with it, but that now
   * happens on the settings path — see `clearRecoveryCodesIfLastFactor`, which both
   * disable routes call.
   */
  async remove(_userId: string, kind: 'TOTP' | 'PASSKEY', _id: string): Promise<void> {
    throw new ProblemException({
      type: ERR.MFA_METHOD_UNAVAILABLE,
      detail:
        kind === 'PASSKEY'
          ? 'Passkeys are managed as a security setting. ' +
            'Use POST /settings/security/passkeys/disable to turn biometric sign-in off.'
          : 'The authenticator app is managed as a security setting. ' +
            'Use POST /settings/security/authenticator/disable to turn it off.',
    });
  }

  /**
   * Drop the recovery codes if nothing is left for them to recover.
   *
   * Leaving them would mean an account with no second factor still holding live
   * codes that satisfy a ceremony — and if 2FA were later re-enabled, a set the user
   * has long forgotten about would still be valid.
   *
   * Public so `src/settings/` applies the identical rule after disabling biometrics.
   * One home for it rather than two copies: the rule is about the account reaching
   * zero factors, not about which route emptied it, and a second implementation is
   * how the two drift.
   */
  async clearRecoveryCodesIfLastFactor(userId: string): Promise<void> {
    if (await this.mfa.hasFactor(userId)) return;

    await this.factors.replaceRecoveryCodes(userId, []);
    this.logger.warn({ userId }, 'last second factor removed; recovery codes cleared');
  }

  async rename(userId: string, kind: 'TOTP' | 'PASSKEY', id: string, label: string): Promise<void> {
    const renamed =
      kind === 'TOTP'
        ? await this.factors.renameTotpFactor(id, userId, label)
        : await this.factors.renamePasskey(id, userId, label);

    if (!renamed) throw new ProblemException({ type: ERR.NOT_FOUND });
  }

  /** Replace the recovery codes, returning the new set exactly once. */
  async regenerateRecoveryCodes(userId: string): Promise<{ recoveryCodes: string[] }> {
    // Frozen with the factors themselves. The codes ARE the account's recovery
    // credential — a set regenerated during the window would hand whoever moved the
    // address the one thing that survives losing every factor, which is the takeover
    // this cooldown exists to interrupt. This is the only protected mutation whose
    // freeze lives solely at this layer; `replaceRecoveryCodes` explains why the
    // persistence guard would be wrong for its other caller.
    await this.securityChanges.assertNoRecentEmailChange(userId);

    if (!(await this.mfa.hasFactor(userId))) {
      // Codes with no factor behind them would be a second way in that the user
      // never asked for, and the only one — which is strictly worse than no 2FA.
      throw new ProblemException({ type: ERR.MFA_METHOD_UNAVAILABLE });
    }

    const recoveryCodes = generateRecoveryCodes();
    await this.factors.replaceRecoveryCodes(userId, recoveryCodes.map(hashRecoveryCode));
    this.logger.log({ userId, count: policy().MFA.RECOVERY_CODE_COUNT }, 'recovery codes regenerated');
    return { recoveryCodes };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /**
   * Which of the account's methods this re-authentication will actually accept.
   *
   * A recovery code is offered only for `account.mfa.remove`. That asymmetry is the
   * whole rule: a printed sheet may take a lost factor OFF an account, because
   * otherwise losing the factor is unrecoverable — but it must not add a factor or
   * attach a provider, because then "I found your printout" and "I own this account"
   * would be the same event. See `reauthVerify`.
   */
  private reauthMethods(
    methods: readonly string[],
    intent: ElevationAction | undefined,
  ): readonly string[] {
    if (intent === 'account.mfa.remove') return methods;
    return methods.filter((method) => method !== 'recovery_code');
  }

  /** Does this intent accept a recovery code as proof? The one place that decides. */
  private recoveryCodeAllowedFor(intent: ElevationAction): boolean {
    return intent === 'account.mfa.remove';
  }

  /**
   * Does this intent additionally require an emailed code?
   *
   * The two factor-changing intents do, per product scope: adding a passkey, enabling
   * an authenticator and disabling either all owe Email OTP, and none of them sent or
   * checked one before.
   *
   * `account.oauth.link` deliberately does not. Attaching a provider is already
   * behind a proved factor and a single-use ticket, the scope's credential-security
   * section does not list it, and widening it here would change a flow this release
   * has not otherwise touched.
   */
  private emailCodeRequiredFor(intent: ElevationAction): boolean {
    return intent === 'account.mfa.enroll' || intent === 'account.mfa.remove';
  }

  /**
   * Email a code for a pending credential change.
   *
   * Reuses the challenge protocol the password and login-OTP flows already use —
   * `ChallengeDbOperation.issue` supersedes any live code for the same purpose, and
   * `verifyChallengeCode` owns expiry-before-counter, increment-before-compare and
   * the constant-time compare. Writing a second mechanism for this would have meant
   * two implementations of the same five rules.
   *
   * `CREDENTIAL_CHANGE` rather than reusing `PASSWORD_RESET`: `issue` retires the live
   * row for its purpose, so sharing would mean starting a factor change silently
   * invalidated a password reset already in the user's inbox.
   */
  async requestCredentialOtp(user: User, ipAddress: string): Promise<{ sent: true }> {
    // Keyed on the account. This sends mail, so `deny` on a cache failure — the
    // alternative is an unmetered send path.
    await this.cache.consume(
      KEYS.rate.credentialOtpByAccount(user.emailLower),
      policy().CREDENTIAL.OTP_BY_ACCOUNT,
      'deny',
    );

    const code = generateOtp();
    // Shared between the challenge row and the queued message, so the deadline the
    // mail worker enforces is the same instant the verifier enforces.
    const expiresAt = secondsFromNow(OTP.TTL_SECONDS);
    const codeHash = pepperedHash(code, 'otp');

    const challenge = await this.challenges.issue({
      userId: user.id,
      purpose: 'CREDENTIAL_CHANGE',
      codeHash,
      expiresAt,
      ipAddress,
    });

    // ─── Awaited, and compensated ─────────────────────────────────────────────
    //
    // This was fire-and-forget with an empty undo list, justified on the grounds that
    // "nothing was charged against a budget the user can exhaust". That is not right:
    // the `cache.consume` above IS a consumed slot in a fixed window, and it is the
    // same shape as `passwordForgotByEmail`, which `PasswordService` compensates in
    // exactly this way.
    //
    // Not awaiting was the worse half. `MailService.sendOtp` rethrows when Redis will
    // not take the job, so an un-awaited call turned a queue outage into an unhandled
    // rejection — while this method returned `{ sent: true }` and left a live
    // `CREDENTIAL_CHANGE` challenge behind for a code that was never queued and never
    // would be. The user would then be told a code was sent, be unable to find it, and
    // be refused a resend by the very slot this failed send had spent.
    //
    // The enqueue is one `XADD`, not an SMTP round trip, so awaiting it costs a
    // millisecond and buys the ability to undo all of that.
    try {
      // The anti-phishing code from the `User` this method was handed. This is the
      // credential-change code every settings surface spends, so it is the message a
      // forger has the most to gain from imitating — and the one the footer matters
      // most on.
      await this.mail.sendOtp(user.email, code, expiresAt, [], antiPhishingCodeOf(user));
    } catch (error) {
      // Retire exactly the challenge this attempt created — the hash predicate keeps a
      // concurrent resend's newer challenge intact — and give back the slot.
      await this.challenges.invalidateIfHash(challenge.id, codeHash);
      await this.cache.refund(KEYS.rate.credentialOtpByAccount(user.emailLower));
      throw error;
    }

    this.logger.log({ userId: user.id }, 'credential-change code sent');
    // Always the same answer, so the response never reveals anything about the
    // account beyond what the caller's own session already proves.
    return { sent: true };
  }

  /**
   * Consume the emailed code a credential change owes, or refuse.
   *
   * Verified and spent BEFORE the factor proof runs, so a caller cannot use a wrong
   * email code to probe whether a TOTP code was right — and so an abandoned request
   * has still spent the emailed code, which is the same discipline every other
   * challenge consumer follows.
   *
   * Public because `src/settings/` owes the same emailed code on three of its four
   * disable paths and on enabling biometrics. Sharing this rather than re-issuing
   * against `CREDENTIAL_CHANGE` from a second place keeps one answer to "what does a
   * credential-change code mean and when is it spent".
   */
  async consumeCredentialOtp(userId: string, code: string | undefined): Promise<void> {
    if (code === undefined) {
      throw new ProblemException({
        type: ERR.OTP_REQUIRED,
        detail: "Request a code with action 'credential-otp', then send it as emailCode.",
      });
    }

    const challenge = await verifyChallengeCode(
      this.challenges,
      userId,
      'CREDENTIAL_CHANGE',
      code,
    );
    await spendChallenge(this.challenges, challenge.id);
  }

  /**
   * Verify a passkey assertion against the challenge `reauthChallenge` minted, and
   * nothing else.
   *
   * Public because `src/settings/` needs to prove ONE named factor rather than "any
   * factor the account has". `proveEnrolledFactor` below is the permissive
   * either-or that re-authentication wants; the biometrics disable policy needs the
   * halves separately, because "a passkey re-verification" and "a 2FA verification"
   * are two of its four distinct paths and accepting one where the caller named the
   * other would collapse them back into one.
   */
  async provePasskeyAssertion(
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<boolean> {
    // `reauth`, matching what `reauthChallenge` wrote. These two used to read and
    // write `KEYS.passkey.registration`, sharing a namespace with enrollment — see
    // the note in redis/keys.ts.
    const record = parseChallenge(await this.cache.take(KEYS.passkey.reauth(userId)));
    if (record.mode !== 'authenticate') {
      throw new ProblemException({ type: ERR.PASSKEY_CHALLENGE_INVALID });
    }
    const passkey = await this.factors.findPasskeyByCredentialId(response.id, userId);
    if (passkey === null) {
      throw new ProblemException({ type: ERR.PASSKEY_VERIFICATION_FAILED });
    }
    const { newSignCount } = await verifyAuthentication(response, record.challenge, passkey);
    // Awaited rather than `void`-ed, same as the sign-in path: a fire-and-forget
    // write leaves its ordering unguaranteed and its rejection unhandled.
    await this.factors.touchPasskey(passkey.id, newSignCount, userId);
    return true;
  }

  /**
   * Verify a TOTP code against the account's confirmed authenticators, and nothing
   * else. See `provePasskeyAssertion` for why this is public and split out.
   */
  async proveTotpCode(userId: string, code: string): Promise<boolean> {
    for (const factor of await this.factors.listConfirmedTotpFactors(userId)) {
      const secret = openFactorSecret(factor);
      const step = verifyCode(secret, code);
      if (step === null) continue;

      // The same step claim as a sign-in, and for a sharper reason here: without it
      // one 30-second code could be replayed to mint several tickets, and a ticket
      // is a permit for a write.
      if (await this.factors.claimTotpStep(factor.id, step)) return true;
      throw new ProblemException({ type: ERR.MFA_CODE_ALREADY_USED });
    }

    return false;
  }

  /**
   * Spend a backup code, if it is one of this account's live ones.
   *
   * A compare-and-swap, so the check and the consumption are one statement and a
   * code cannot be spent twice — the same call `reauthVerify` makes. Public for the
   * `backup-code` disable path in `src/settings/`.
   */
  async proveBackupCode(userId: string, code: string): Promise<boolean> {
    const spent = await this.factors.spendRecoveryCode(userId, hashRecoveryCode(code));
    if (!spent) return false;

    const remaining = await this.factors.countUnusedRecoveryCodes(userId);
    this.logger.warn({ userId, remaining }, 'recovery code spent');
    return true;
  }

  /**
   * Either factor satisfies a re-authentication — passkey first, TOTP otherwise.
   *
   * Deliberately permissive, and correct for what it is used for: a ticket says the
   * person at the keyboard re-proved they hold the account, and any enrolled factor
   * establishes that. The two narrow provers above exist for the caller that needs
   * to insist on a PARTICULAR factor.
   */
  private async proveEnrolledFactor(
    userId: string,
    input: { totpCode?: string; passkey?: AuthenticationResponseJSON },
  ): Promise<boolean> {
    if (input.passkey !== undefined) {
      return this.provePasskeyAssertion(userId, input.passkey);
    }

    if (input.totpCode === undefined) {
      throw new ProblemException({ type: ERR.MFA_METHOD_UNAVAILABLE });
    }

    return this.proveTotpCode(userId, input.totpCode);
  }

  /**
   * The bootstrap branch: no factor enrolled, so the password is the only one.
   *
   * ─── Order of the two refusals ─────────────────────────────────────────────
   *
   * "This account has no password" is checked BEFORE "you did not send one", and the
   * order was previously reversed. That made the helpful message unreachable for the
   * account it was written for: a passwordless caller sending no `password` field got
   * a bare `invalid_credentials`, and the "Set a password before performing this
   * action" detail only appeared if they happened to send a dummy value. The state of
   * the account does not depend on what the request contained, so it is the question
   * to answer first.
   */
  private async proveWithPassword(user: User, password: string | undefined): Promise<boolean> {
    const found = await this.users.findWithCredential(user.id);
    if (found === null || found.credential === null) {
      // A passwordless account with no factor has nothing to re-prove with. It is
      // reachable — registration lets a user skip the password — and the honest
      // answer is that this action is not available, not that the password is wrong.
      //
      // Not a dead end, and worth knowing which way out to point a client at:
      // `POST /auth/password {action:'set'}` needs only a session and an emailed
      // code, so such an account can set a password and then elevate.
      throw new ProblemException({
        type: ERR.MFA_METHOD_UNAVAILABLE,
        detail: 'Set a password before performing this action.',
      });
    }

    if (password === undefined) {
      throw new ProblemException({ type: ERR.INVALID_CREDENTIALS });
    }

    return this.credentials.checkPassword(found.credential, password);
  }
}
