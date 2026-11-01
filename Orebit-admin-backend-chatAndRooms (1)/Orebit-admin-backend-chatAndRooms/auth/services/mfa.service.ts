import { Injectable, Logger } from '@nestjs/common';
import type { Admin, AdminLoginAttempt, AdminTotpFactor } from '@prisma/client';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isUniqueViolation } from '../../db/client';
import { CacheService, KEYS } from '../../redis';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { MailService } from '../../src/mail/mail.service';
import { MFA, PASSKEY } from '../auth.constants';
import type {
  ClientContext,
  IssuedSession,
  MfaMethod,
  PasskeyChallenge,
  TotpEnrollment,
} from '../auth.types';
import { normaliseCode } from '../auth.utility';
import { AdminDbOperation } from '../persistence/admin.dboperation';
import { AttemptDbOperation } from '../persistence/attempt.dboperation';
import { MfaDbOperation } from '../persistence/mfa.dboperation';
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  challengeOf,
  parseChallenge,
  serialiseChallenge,
  verifyAuthentication,
  verifyRegistration,
} from '../security/passkey';
import { assertMfaAttemptsRemain, mfaAttemptsRemaining } from '../security/stepup';
import {
  base32Encode,
  generateSecret,
  openSecret,
  otpauthUri,
  sealSecret,
  verifyCode,
} from '../security/totp';
import { SessionService } from './session.service';

/**
 * The second factor: TOTP and passkeys, verify and enroll.
 *
 * Every method here assumes its caller has already run `assertStep`, so the
 * attempt is live and in `EMAIL_VERIFIED`. That assumption is why the controller
 * resolves the attempt once and passes it down rather than each method loading it
 * — one check, at one door.
 *
 * ─── The two collapses, and why they are safe ───────────────────────────────
 *
 * `totpVerify` serves both enrollment confirmation and authentication, and
 * `passkeyVerify` serves both registration and assertion. Neither reads a mode
 * from the request. In the TOTP case the server asks whether the admin has a
 * CONFIRMED factor; in the passkey case it reads the mode it stored alongside the
 * challenge it issued. A client cannot select which path runs against it, which is
 * the only reason collapsing them does not widen anything.
 *
 * That last sentence is the whole safety argument, and it is worth recording that
 * it was once false. `totpVerify` used to derive the mode from the presence of a
 * PENDING factor, which the management-surface replacement ceremony can create for
 * an already-enrolled admin — so the path a sign-in took was decided by a row
 * somebody else had written, and the secret it verified against came with it. A
 * collapse is only safe while the thing it derives the mode from is not reachable
 * by the caller. See the header on `totpVerify`.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger('MfaService');

  constructor(
    private readonly admins: AdminDbOperation,
    private readonly attempts: AttemptDbOperation,
    private readonly mfa: MfaDbOperation,
    private readonly sessions: SessionService,
    private readonly cache: CacheService,
    private readonly mail: MailService,
  ) {}

  /**
   * Whether this admin must enroll, and which factors they can present — from ONE
   * read of the factor tables.
   *
   * ─── Why the two questions are answered together ───────────────────────────
   *
   * They were separate methods, `needsEnrollment` and `availableMethods`, and every
   * caller asked both in a row. Each did its own `confirmedFactorCounts`, which is
   * two `COUNT` queries, so `verify-email` and `state` ran four count queries per
   * request to answer one question about one admin. Both answers are functions of the
   * same two numbers, so the pair is now derived from a single read.
   *
   * This is NOT a cache — the counts are read fresh on every request, and nothing is
   * held between them. It is one read where there were two, inside one request.
   *
   * ─── What this must not be used for ────────────────────────────────────────
   *
   * The downgrade guards — `assertNoConfirmedFactor` here and
   * `TwoFactorService.assertNotLastFactor` — deliberately call
   * `confirmedFactorCounts` themselves, and must keep doing so. They run in DIFFERENT
   * requests from whatever last observed the factor set, and they decide whether a
   * credential may be created or destroyed. Sharing a value with them would be
   * reusing an observation across the window they exist to close.
   */
  async enrollmentState(adminId: string): Promise<{
    readonly needsEnrollment: boolean;
    readonly methods: readonly MfaMethod[];
  }> {
    const counts = await this.mfa.confirmedFactorCounts(adminId);

    // TOTP before PASSKEY, as `availableMethods` ordered them — this list reaches the
    // client and drives which factor a sign-in page offers first.
    const methods: MfaMethod[] = [];
    if (counts.totp > 0) methods.push('TOTP');
    if (counts.passkey > 0) methods.push('PASSKEY');

    return { needsEnrollment: counts.totp === 0 && counts.passkey === 0, methods };
  }

  // ─── TOTP ─────────────────────────────────────────────────────────────────

  /**
   * Begin a TOTP enrollment: generate a secret, store it sealed and unconfirmed,
   * and hand back the QR payload.
   *
   * ═══ THE DOWNGRADE GUARD ═══════════════════════════════════════════════════
   *
   * `assertNoConfirmedFactor` is the reason this is a separate step rather than
   * being folded into `totpVerify`. Without it, anyone holding a step-up token —
   * which is to say anyone who stole a password and could read the email — could
   * mint a fresh secret, enroll an authenticator they control, and walk straight
   * past the factor the real admin owns. The second factor would become a
   * formality.
   *
   * The check counts CONFIRMED factors from the factor tables, deliberately not
   * from `Admin.mfaEnrolledAt`, which is a denormalised convenience that could go
   * stale. And it is backed by the partial unique index
   * `ix_admin_totp_confirmed_unique`, because this read-then-write can be raced
   * and the index cannot.
   */
  async totpEnroll(admin: Admin): Promise<TotpEnrollment> {
    await this.assertNoConfirmedFactor(admin.id);

    const secret = generateSecret();
    await this.mfa.startTotpEnrollment({
      adminId: admin.id,
      sealed: sealSecret(secret),
      label: 'Authenticator',
    });

    const base32 = base32Encode(secret);
    return { secret: base32, uri: otpauthUri(base32, admin.email) };
  }

  /**
   * Verify a TOTP code and finish the ceremony.
   *
   * One step, two readings, resolved from server state rather than from the
   * request: an admin with a confirmed factor is AUTHENTICATING against it, and
   * only an admin with none can be confirming an enrollment.
   *
   * ═══ THE CONFIRMED FACTOR IS ASKED FOR FIRST, AND THAT IS F06 ══════════════
   *
   * This used to branch on `findPendingTotp() !== null` — "a pending row exists,
   * so this must be an enrollment". That was a sound PROXY for the real question
   * exactly as long as one thing was true: that the only way to create a pending
   * row was `totpEnroll`, which refuses when a confirmed factor exists. So a
   * pending row implied an unenrolled admin, and the proxy held.
   *
   * `TwoFactorService.totpAdd` broke that implication on purpose. A replacement
   * ceremony creates a pending row ALONGSIDE the live confirmed one — that is what
   * makes the rotation safe, because the old authenticator has to keep working
   * until the new one is proved. The reader here was never told.
   *
   * The consequence was a permanent lockout. An abandoned `totp-add` left a pending
   * row with no expiry, and every subsequent sign-in verified the admin's real code
   * against the ABANDONED secret, failed, and charged an MFA attempt for it. The
   * confirmed factor was unreachable while the pending row existed, and nothing
   * ever removed it.
   *
   * So the branch now asks the question it actually means. A confirmed factor
   * always authenticates; the enrollment branch is reachable only when there is
   * none. Three things follow, and all three are why this ordering is the fix
   * rather than merely a fix:
   *
   *   the ceremony survives   an abandoned replacement no longer touches sign-in.
   *                           The pending row stays completable on the management
   *                           surface, where it belongs, until it expires.
   *   nothing is weakened     the enrollment branch got NARROWER. It is now
   *                           unreachable for an enrolled admin, which is the state
   *                           it was never meant to serve.
   *   the branch is ours      the secret a sign-in verifies against is no longer
   *                           selectable by whoever last called `totp-add`. That
   *                           mattered: an abandoned ceremony must never become a
   *                           valid replacement, and this is what enforces it.
   *
   * One query rather than two on the common path, as a side effect: an enrolled
   * admin signing in never looks for a pending row at all.
   */
  async totpVerify(
    admin: Admin,
    attempt: AdminLoginAttempt,
    rawCode: string,
    client: ClientContext,
  ): Promise<IssuedSession> {
    const code = normaliseCode(rawCode);

    // Charged BEFORE the comparison, and the count comes back from the database,
    // so an abandoned request still costs an attempt and a caller cannot get
    // unlimited guesses by racing.
    const attemptsUsed = await this.attempts.incrementMfaAttempts(attempt.id);
    assertMfaAttemptsRemain(attemptsUsed - 1);

    const confirmed = await this.mfa.findConfirmedTotp(admin.id);
    if (confirmed === null) {
      // No confirmed factor, so this can only be an enrollment. The cutoff is what
      // stops an abandoned ceremony being completed by whoever reaches it next —
      // a stale row is not found, and is refused exactly like no row at all.
      const pending = await this.mfa.findPendingTotp(admin.id, enrollmentCutoff());
      if (pending === null) {
        throw new ProblemException({ type: ERR.MFA_NOT_ENROLLED });
      }
      return this.confirmTotpEnrollment(admin, attempt, pending, code, attemptsUsed, client);
    }

    const step = verifyCode(openSecret(sealedOf(confirmed)), code);
    if (step === null) {
      throw this.wrongCode(ERR.TOTP_INVALID, attemptsUsed);
    }

    // The replay defence. `claimTotpStep` puts the comparison in the WHERE clause,
    // so two requests presenting the same code cannot both win — the loser is
    // told the code was already used rather than being handed a session.
    if (!(await this.mfa.claimTotpStep(confirmed.id, step))) {
      throw new ProblemException({ type: ERR.TOTP_REPLAYED });
    }

    return this.complete(admin, attempt, 'TOTP', client);
  }

  /**
   * The enrollment-confirmation branch of `totpVerify`.
   *
   * Note there is no replay check on this path, and none is needed: the factor is
   * being confirmed for the first time, so there is no previous step to have
   * spent. `confirmTotp` writes the matched step as it confirms, which is what
   * arms the defence for every subsequent sign-in.
   *
   * ─── Why `confirmTotp` and not `confirmTotpReplacing` ──────────────────────
   *
   * Because this branch is now only reachable when the admin has NO confirmed
   * factor, so there is nothing to retire. That is a precondition of the caller
   * rather than something this method checks, and it is the reason the simpler
   * writer is still the right one here: `confirmTotpReplacing` exists for the
   * management surface, where a confirmed factor is present by construction.
   *
   * It used to be reachable with a confirmed factor present, and then it was
   * actively wrong — `confirmTotp` does not retire the old row, so the partial
   * unique index `ix_admin_totp_confirmed_unique` refused the write and the caller
   * got a 500 rather than an answer. Keep the precondition and that cannot recur.
   */
  private async confirmTotpEnrollment(
    admin: Admin,
    attempt: AdminLoginAttempt,
    pending: AdminTotpFactor,
    code: string,
    attemptsUsed: number,
    client: ClientContext,
  ): Promise<IssuedSession> {
    const step = verifyCode(openSecret(sealedOf(pending)), code);
    if (step === null) {
      throw this.wrongCode(ERR.TOTP_INVALID, attemptsUsed);
    }

    if (!(await this.mfa.confirmTotp(pending.id, step))) {
      // Lost the CAS, or the unique index refused a second confirmed factor.
      // Either way something else already enrolled for this admin.
      throw new ProblemException({ type: ERR.MFA_ALREADY_ENROLLED });
    }

    await this.admins.markMfaEnrolled(admin.id);
    // Fire-and-forget by construction (MailService swallows failures): the admin
    // must not be blocked from finishing enrollment because SMTP is down, but the
    // real owner has to find out that a factor was added.
    await this.mail.sendSecurityChanged(admin.email, 'An authenticator app was enrolled');

    this.logger.log({ adminId: admin.id }, 'TOTP factor confirmed');
    return this.complete(admin, attempt, 'TOTP', client);
  }

  // ─── passkeys ─────────────────────────────────────────────────────────────

  /**
   * Issue a WebAuthn challenge, and decide what kind it is.
   *
   * The mode is derived from the admin's confirmed passkey count and stored WITH
   * the challenge, so `passkeyVerify` reads it back instead of trusting the
   * request. It is also returned to the client — not as an input it can change,
   * but so the browser knows whether to call `navigator.credentials.create` or
   * `.get` without having to infer it.
   */
  async passkeyChallenge(admin: Admin, attempt: AdminLoginAttempt): Promise<PasskeyChallenge> {
    const existing = await this.mfa.listPasskeys(admin.id);

    if (existing.length === 0) {
      // Registering. The same downgrade guard as TOTP: an admin who already has a
      // confirmed TOTP factor must not be able to bolt on a passkey of their own
      // choosing mid-sign-in.
      await this.assertNoConfirmedFactor(admin.id);

      const options = await buildRegistrationOptions({
        adminId: admin.id,
        email: admin.email,
        name: admin.name,
        existing,
      });
      await this.storeChallenge(attempt.id, 'register', challengeOf(options));
      return { mode: 'register', options };
    }

    const options = await buildAuthenticationOptions(existing);
    await this.storeChallenge(attempt.id, 'authenticate', challengeOf(options));
    return { mode: 'authenticate', options };
  }

  /**
   * Verify a WebAuthn response against the challenge we issued.
   *
   * `cache.take` reads and deletes in one round trip, which is what makes the
   * challenge single-use — and it happens FIRST, before verification, so a failed
   * attempt burns the challenge too. That ordering matters: leaving it in place on
   * failure would let a caller retry a captured assertion against the same
   * challenge until something worked.
   */
  async passkeyVerify(
    admin: Admin,
    attempt: AdminLoginAttempt,
    response: RegistrationResponseJSON | AuthenticationResponseJSON,
    client: ClientContext,
  ): Promise<IssuedSession> {
    const attemptsUsed = await this.attempts.incrementMfaAttempts(attempt.id);
    assertMfaAttemptsRemain(attemptsUsed - 1);

    const record = parseChallenge(await this.cache.take(KEYS.mfa.passkeyChallenge(attempt.id)));

    if (record.mode === 'register') {
      return this.registerPasskey(
        admin,
        attempt,
        response as RegistrationResponseJSON,
        record.challenge,
        client,
      );
    }
    return this.authenticatePasskey(
      admin,
      attempt,
      response as AuthenticationResponseJSON,
      record.challenge,
      client,
    );
  }

  private async registerPasskey(
    admin: Admin,
    attempt: AdminLoginAttempt,
    response: RegistrationResponseJSON,
    expectedChallenge: string,
    client: ClientContext,
  ): Promise<IssuedSession> {
    // Re-checked here, not only at challenge time. The two calls are separate
    // requests, so a factor could have been confirmed in between — and this is
    // the call that actually writes a credential.
    await this.assertNoConfirmedFactor(admin.id);

    const verified = await verifyRegistration(response, expectedChallenge);

    try {
      await this.mfa.createPasskey({
        adminId: admin.id,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        signCount: verified.signCount,
        transports: verified.transports,
        aaguid: verified.aaguid,
        label: 'Passkey',
      });
    } catch (err) {
      // The partial unique index is the authority, and losing to it means this
      // authenticator is already registered — to this admin or another.
      if (isUniqueViolation(err)) {
        throw new ProblemException({ type: ERR.PASSKEY_ALREADY_REGISTERED });
      }
      throw err;
    }

    await this.admins.markMfaEnrolled(admin.id);
    await this.mail.sendSecurityChanged(admin.email, 'A passkey was registered');

    this.logger.log({ adminId: admin.id }, 'passkey registered');
    return this.complete(admin, attempt, 'PASSKEY', client);
  }

  private async authenticatePasskey(
    admin: Admin,
    attempt: AdminLoginAttempt,
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    client: ClientContext,
  ): Promise<IssuedSession> {
    const passkey = await this.mfa.findPasskeyByCredentialId(response.id);

    // The credential must belong to the admin whose sign-in this is. Without this
    // comparison, a valid assertion from ANY registered passkey would satisfy any
    // admin's step-up token — one admin could complete another's sign-in with
    // their own key.
    if (passkey === null || passkey.adminId !== admin.id) {
      throw new ProblemException({ type: ERR.PASSKEY_VERIFICATION_FAILED });
    }

    const { newSignCount } = await verifyAuthentication(response, expectedChallenge, passkey);
    await this.mfa.recordPasskeyUse(passkey.id, newSignCount);

    return this.complete(admin, attempt, 'PASSKEY', client);
  }

  // ─── shared ───────────────────────────────────────────────────────────────

  /**
   * Close the attempt and mint the session. THE only place a session is issued.
   *
   * `complete` is a compare-and-swap that demands `EMAIL_VERIFIED` and
   * `completedAt: null`, so an attempt cannot yield two sessions — and the session
   * is minted only after that swap is won, never before. Reversing those two
   * would let a lost race still hand out tokens.
   */
  private async complete(
    admin: Admin,
    attempt: AdminLoginAttempt,
    method: MfaMethod,
    client: ClientContext,
  ): Promise<IssuedSession> {
    if (!(await this.attempts.complete(attempt.id, method))) {
      throw new ProblemException({ type: ERR.STEP_UP_INVALID });
    }

    // Re-read before minting. The `admin` this method was handed was loaded at
    // the start of the request, BEFORE `markMfaEnrolled` and `markEmailVerified`
    // ran — so minting from it returns `mfaEnrolled: false` to the very admin who
    // just enrolled. The row is authoritative; the in-memory copy is stale by
    // construction on exactly the path that matters most.
    const fresh = (await this.admins.findById(admin.id)) ?? admin;
    return this.sessions.issue(fresh, method, client);
  }

  /** The downgrade guard, in one place so both factor types share it. */
  private async assertNoConfirmedFactor(adminId: string): Promise<void> {
    const counts = await this.mfa.confirmedFactorCounts(adminId);
    if (counts.totp > 0 || counts.passkey > 0) {
      throw new ProblemException({
        type: ERR.MFA_ALREADY_ENROLLED,
        detail: 'This account already has a second factor. Sign in with it instead.',
      });
    }
  }

  private async storeChallenge(
    attemptId: string,
    mode: 'register' | 'authenticate',
    challenge: string,
  ): Promise<void> {
    // `deny`: a challenge that was not stored cannot be verified, so the options we
    // are about to return would send the browser through a WebAuthn prompt that is
    // certain to fail. Refuse now instead.
    await this.cache.set(
      KEYS.mfa.passkeyChallenge(attemptId),
      serialiseChallenge({ mode, challenge }),
      PASSKEY.CHALLENGE_TTL_SECONDS,
      'deny',
    );
  }

  /** A wrong code, carrying how many guesses are left so the UI can warn. */
  private wrongCode(type: typeof ERR.TOTP_INVALID, attemptsUsed: number): ProblemException {
    return new ProblemException({
      type,
      extra: { attemptsRemaining: mfaAttemptsRemaining(attemptsUsed) },
    });
  }
}

/**
 * The oldest `createdAt` a pending enrollment may have and still be completable.
 *
 * Exported because BOTH ceremonies have to agree on it — this file confirms an
 * enrollment during sign-in, and `TwoFactorService` confirms a replacement from the
 * management surface. Two independently-derived cutoffs would be two policies, and
 * the looser one would decide.
 *
 * Computed per call rather than captured, so it cannot go stale in a long-lived
 * service instance.
 */
export function enrollmentCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - MFA.ENROLLMENT_TTL_SECONDS * 1000);
}

/**
 * Pull the AES-GCM envelope out of a factor row.
 *
 * Prisma types `Bytes` as `Uint8Array`, and `createDecipheriv` wants Buffers, so
 * this is the one conversion point rather than three `Buffer.from` calls scattered
 * across call sites.
 */
function sealedOf(factor: AdminTotpFactor): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  return {
    ciphertext: Buffer.from(factor.secretCiphertext),
    iv: Buffer.from(factor.secretIv),
    tag: Buffer.from(factor.secretTag),
  };
}
