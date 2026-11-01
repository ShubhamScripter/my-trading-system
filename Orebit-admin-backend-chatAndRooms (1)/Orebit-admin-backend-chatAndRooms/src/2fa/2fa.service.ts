import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { LIMITS, PASSKEY } from '../../auth/auth.constants';
import { AdminDbOperation, MfaDbOperation } from '../../auth/auth.dboperation';
import type { Principal } from '../../auth/auth.types';
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  challengeOf,
  parseChallenge,
  serialiseChallenge,
  verifyAuthentication,
  verifyRegistration,
} from '../../auth/security/passkey';
import {
  base32Encode,
  generateSecret,
  openSecret,
  otpauthUri,
  sealSecret,
  verifyCode,
} from '../../auth/security/totp';
// The enrollment deadline, shared with the sign-in ceremony rather than re-derived
// here. Two cutoffs would be two policies, and the looser one would decide.
import { enrollmentCutoff } from '../../auth/services/mfa.service';
import { isUniqueViolation } from '../../db/client';
import { CacheService, KEYS } from '../../redis';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import { MailService } from '../mail/mail.service';
import { TwoFactorDbOperation } from './2fa.dboperation';
import type { EnrolledFactor, FactorKind, TotpEnrollmentStart } from './2fa.types';
import { ElevationService } from './elevation';

const DEFAULT_TOTP_LABEL = 'Authenticator';
const DEFAULT_PASSKEY_LABEL = 'Passkey';

/**
 * Second-factor management and re-authentication for an admin who is signed in.
 *
 * The SIGN-IN half of `POST /2fa` is not here — those four actions delegate
 * straight to `MfaService` in `auth/`, which already owns factor verification and
 * `complete()`, "THE only place a session is issued". Reimplementing them here
 * would be a second writer on the same tables, which is the drift this
 * consolidation exists to remove.
 *
 * ─── The two rules that make this surface safe ──────────────────────────────
 *
 * 1. EVERY WRITE COSTS A FRESH PROOF. There is no password check any more and no
 *    sudo window; `ElevationService` hands out single-use tickets and the
 *    controller spends one per mutating action. A stolen access token cannot
 *    change the factor set without also defeating a factor.
 *
 * 2. NEVER LET AN ENROLLED ADMIN REACH ZERO FACTORS. `assertNotLastFactor` is the
 *    downgrade guard — otherwise "remove a factor" would be a cheaper attack than
 *    defeating one.
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger('TwoFactor');

  constructor(
    private readonly factors: TwoFactorDbOperation,
    private readonly mfa: MfaDbOperation,
    private readonly admins: AdminDbOperation,
    private readonly cache: CacheService,
    private readonly mail: MailService,
    private readonly elevation: ElevationService,
  ) {}

  // ─── read ─────────────────────────────────────────────────────────────────

  async list(adminId: string): Promise<{
    readonly mfaEnrolled: boolean;
    readonly factors: readonly EnrolledFactor[];
  }> {
    const [factors, counts] = await Promise.all([
      this.factors.listFactors(adminId),
      this.mfa.confirmedFactorCounts(adminId),
    ]);
    return { mfaEnrolled: counts.totp + counts.passkey > 0, factors };
  }

  // ─── re-authentication ────────────────────────────────────────────────────

  /**
   * Options for an assertion the admin will use to earn an elevation ticket.
   *
   * Stored under its own Redis namespace keyed on the LOGIN, so a challenge issued
   * for re-auth cannot be redeemed by the sign-in or enrollment verify steps.
   *
   * The login rather than the refresh generation: a background rotation between this
   * call and `reauth-verify` would otherwise orphan the challenge and refuse a
   * ceremony the admin is halfway through. See the namespace comment in
   * redis/keys.ts.
   */
  async reauthChallenge(principal: Principal): Promise<Record<string, unknown>> {
    const passkeys = await this.mfa.listPasskeys(principal.adminId);
    if (passkeys.length === 0) {
      throw new ProblemException({
        type: ERR.MFA_NOT_ENROLLED,
        detail:
          'No passkey is enrolled. Prove a TOTP code instead, then add a passkey — ' +
          'passkeys are what make per-action approval workable.',
      });
    }

    const options = await buildAuthenticationOptions(passkeys);
    // `deny` — see the reasoning at the matching call in auth/services/mfa.service.ts.
    await this.cache.set(
      KEYS.mfa.reauthChallenge(principal.familyId),
      serialiseChallenge({ mode: 'authenticate', challenge: challengeOf(options) }),
      PASSKEY.CHALLENGE_TTL_SECONDS,
      'deny',
    );
    return options;
  }

  /**
   * Prove a factor and receive a single-use ticket.
   *
   * The rate limits are charged FIRST and deny on cache failure. The sign-in path
   * charges the login attempt row instead, which survives a cache flush; there is
   * no attempt here, so these buckets are the only thing between an access-token
   * holder and unlimited guesses against a code that does not rotate.
   *
   * ─── TWO dimensions, and neither covers the other ──────────────────────────
   *
   * Per-LOGIN first, then per-ADMIN. Both are charged on every call.
   *
   * The account bucket bounds the total; the login bucket bounds what any ONE login
   * can take out of it. With only the account bucket, an attacker holding a single
   * stolen session grinds five guesses and the real admin is refused
   * re-authentication in every other session for the rest of the window — the
   * attacker cannot get in, but neither can anyone else, which is a lockout handed
   * to whoever arrives first. With only the login bucket, opening a new session
   * resets the budget.
   *
   * Login first so the tighter limit answers first: a login that has spent its three
   * is refused without also spending a slot in the account's five.
   *
   * Keyed on the FAMILY, not the refresh generation. Keyed on the generation the cap
   * reset on every token rotation, so "three per fifteen minutes" was really three
   * per generation and a caller who could provoke a rotation got a fresh budget on
   * demand — see redis/keys.ts. This is a tightening, and deliberate.
   */
  async reauthVerify(
    principal: Principal,
    proof:
      | { readonly kind: 'passkey'; readonly response: AuthenticationResponseJSON }
      | { readonly kind: 'totp'; readonly code: string },
    intent: string,
  ): Promise<{ ticket: string; expiresInSeconds: number; action: string }> {
    await this.cache.consume(
      KEYS.rate.reauthByLogin(principal.familyId),
      LIMITS.REAUTH_BY_SESSION,
      'deny',
    );
    await this.cache.consume(
      KEYS.rate.twoFactorProofByAdmin(principal.adminId),
      LIMITS.TWO_FACTOR_PROOF_BY_ADMIN,
      'deny',
    );

    if (proof.kind === 'passkey') {
      await this.verifyReauthPasskey(principal, proof.response);
    } else {
      await this.verifyReauthTotp(principal, proof.code);
    }

    // Bound to the action the caller said they intended. Not validated against a
    // list here: the routes own the closed set, and a ticket naming an action no
    // route accepts is simply a ticket that can never be spent — which is a refusal
    // either way, one request later.
    return this.elevation.issue(principal.familyId, intent);
  }

  private async verifyReauthPasskey(
    principal: Principal,
    response: AuthenticationResponseJSON,
  ): Promise<void> {
    // Read-and-delete first, so a failed attempt burns the challenge too. Leaving
    // it in place would let a captured assertion be retried against it.
    const record = parseChallenge(
      await this.cache.take(KEYS.mfa.reauthChallenge(principal.familyId)),
    );
    if (record.mode !== 'authenticate') {
      throw new ProblemException({ type: ERR.PASSKEY_CHALLENGE_INVALID });
    }

    const passkey = await this.mfa.findPasskeyByCredentialId(response.id);
    // The credential must belong to the caller. Without this, a valid assertion
    // from ANY registered passkey would elevate any session.
    if (passkey === null || passkey.adminId !== principal.adminId) {
      throw new ProblemException({ type: ERR.PASSKEY_VERIFICATION_FAILED });
    }

    const { newSignCount } = await verifyAuthentication(response, record.challenge, passkey);
    await this.mfa.recordPasskeyUse(passkey.id, newSignCount);
  }

  /**
   * The bootstrap path, and the only reason TOTP is accepted for re-auth.
   *
   * `claimTotpStep` puts the comparison in the WHERE clause, so a step cannot be
   * spent twice — which also means at most one elevation per 30 seconds from a
   * code. That ceiling is why passkeys are the intended factor here and why this
   * exists only so a TOTP-only admin can reach `passkey-add-challenge`.
   */
  private async verifyReauthTotp(principal: Principal, code: string): Promise<void> {
    const confirmed = await this.mfa.findConfirmedTotp(principal.adminId);
    if (confirmed === null) {
      throw new ProblemException({ type: ERR.MFA_NOT_ENROLLED });
    }

    const step = verifyCode(openSecret(sealedOf(confirmed)), code);
    if (step === null) {
      throw new ProblemException({ type: ERR.TOTP_INVALID });
    }

    if (!(await this.mfa.claimTotpStep(confirmed.id, step))) {
      throw new ProblemException({
        type: ERR.TOTP_REPLAYED,
        detail: 'That code was already used. Wait for the next one, or add a passkey.',
      });
    }
  }

  // ─── TOTP management ──────────────────────────────────────────────────────

  /**
   * Begin — or rotate — an authenticator enrollment.
   *
   * A confirmed factor already existing is not an error: it starts a ROTATION. The
   * new factor is created pending alongside the old, and only `totpConfirm` retires
   * the old — so an abandoned rotation leaves the admin's FACTOR SET exactly as it
   * was.
   *
   * ═══ THAT LAST CLAIM WAS ONCE WIDER THAN IT SHOULD HAVE BEEN ══════════════
   *
   * It used to read "leaves the admin exactly as they were", and that was false in
   * the one place it mattered. The rows were indeed untouched, but `totpVerify` on
   * the SIGN-IN path derived its branch from the presence of a pending factor — so
   * the row this method creates, harmless here, made every subsequent login verify
   * against the abandoned secret instead of the live one. An abandoned rotation left
   * the admin unable to sign in at all.
   *
   * The reader is fixed (a confirmed factor now always authenticates), and the row
   * this creates now expires: `MFA.ENROLLMENT_TTL_SECONDS` from `createdAt`, after
   * which `totpConfirm` refuses it and discards it. Both halves are needed — the
   * first stops it blocking sign-in, the second stops an abandoned secret staying
   * confirmable indefinitely by any later session of this admin.
   *
   * The narrower claim above is the true one, and it is worth keeping stated
   * narrowly: this method's safety depends on what OTHER readers do with the row it
   * writes, which is exactly the coupling that went wrong.
   */
  async totpAdd(principal: Principal, label: string | undefined): Promise<TotpEnrollmentStart> {
    const existing = await this.mfa.findConfirmedTotp(principal.adminId);
    const secret = generateSecret();

    const factor = await this.mfa.startTotpEnrollment({
      adminId: principal.adminId,
      sealed: sealSecret(secret),
      label: label ?? DEFAULT_TOTP_LABEL,
    });

    this.logger.log(
      { adminId: principal.adminId, factorId: factor.id, replacing: existing !== null },
      'totp enrollment started from the management surface',
    );

    const base32 = base32Encode(secret);
    const admin = await this.admins.findById(principal.adminId);

    return {
      secret: base32,
      uri: otpauthUri(base32, admin?.email ?? ''),
      replacing: existing !== null,
    };
  }

  /**
   * Prove the authenticator was scanned, and make it live.
   *
   * ═══ AN EXPIRED CEREMONY IS REFUSED EXACTLY LIKE NO CEREMONY ══════════════
   *
   * `findPendingTotp` takes a cutoff, so a row older than
   * `MFA.ENROLLMENT_TTL_SECONDS` is simply not found and lands in the same branch
   * as "nothing was started". One answer for both, deliberately: a caller holding
   * a secret they can no longer use learns nothing about whether it exists, and the
   * remedy is identical either way — start another ceremony.
   *
   * That deadline is what makes an abandoned replacement safely discardable. This
   * step is gated by a bearer alone (the pending row IS the credential, per
   * `TWO_FACTOR_REQUIRES`), so without it a secret minted in one session stayed
   * confirmable from any later session of this admin, indefinitely.
   */
  async totpConfirm(principal: Principal, code: string): Promise<EnrolledFactor> {
    await this.cache.consume(
      KEYS.rate.twoFactorProofByAdmin(principal.adminId),
      LIMITS.TWO_FACTOR_PROOF_BY_ADMIN,
      'deny',
    );

    const cutoff = enrollmentCutoff();
    const pending = await this.mfa.findPendingTotp(principal.adminId, cutoff);
    if (pending === null) {
      // ═══ CLEANUP, ON A PATH THAT HAS ALREADY DECIDED TO REFUSE ════════════
      //
      // Ordering matters and it is this way round on purpose. The refusal is
      // decided by the line above — this only stops an abandoned secret lingering
      // in decryptable form, and NOTHING about the answer may depend on it. So its
      // result is discarded and its failure is swallowed: a delete that deadlocks
      // must not turn a refusal into a 500, and must certainly never turn one into
      // a success. `discardStaleTotpEnrollments` is scoped to this admin, to
      // unconfirmed rows, and to rows older than the cutoff, so the worst a bug
      // here can cost is an abandoned secret that outlives its window.
      await this.mfa
        .discardStaleTotpEnrollments(principal.adminId, cutoff)
        .catch((err: unknown) =>
          this.logger.warn({ err, adminId: principal.adminId }, 'stale enrollment sweep failed'),
        );

      throw new ProblemException({
        type: ERR.MFA_NOT_ENROLLED,
        detail:
          'No authenticator enrollment is in progress, or the one you started has expired. ' +
          'Start another with action "totp-add".',
      });
    }

    const step = verifyCode(openSecret(sealedOf(pending)), code);
    if (step === null) {
      throw new ProblemException({ type: ERR.TOTP_INVALID });
    }

    const confirmed = await this.factors.confirmTotpReplacing({
      adminId: principal.adminId,
      factorId: pending.id,
      step,
    });

    if (!confirmed) {
      // Lost the compare-and-swap. Nothing was retired — the transaction rolled back.
      throw new ProblemException({ type: ERR.MFA_ALREADY_ENROLLED });
    }

    await this.admins.markMfaEnrolled(principal.adminId);
    await this.notify(principal.adminId, 'An authenticator app was added to your account');

    const factor = await this.factors.findFactor({
      adminId: principal.adminId,
      kind: 'TOTP',
      factorId: pending.id,
    });
    if (factor === null) throw new ProblemException({ type: ERR.INTERNAL_ERROR });
    return factor;
  }

  // ─── passkey management ───────────────────────────────────────────────────

  async passkeyAddChallenge(principal: Principal): Promise<Record<string, unknown>> {
    const admin = await this.admins.findById(principal.adminId);
    if (admin === null) throw new ProblemException({ type: ERR.UNAUTHENTICATED });

    const existing = await this.mfa.listPasskeys(principal.adminId);
    if (existing.length >= PASSKEY.MAX_PER_ADMIN) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: `At most ${PASSKEY.MAX_PER_ADMIN} passkeys may be registered.`,
      });
    }

    const options = await buildRegistrationOptions({
      adminId: admin.id,
      email: admin.email,
      name: admin.name,
      existing,
    });

    // `deny` — see the reasoning at the matching call in auth/services/mfa.service.ts.
    await this.cache.set(
      KEYS.mfa.passkeyEnrollChallenge(principal.familyId),
      serialiseChallenge({ mode: 'register', challenge: challengeOf(options) }),
      PASSKEY.CHALLENGE_TTL_SECONDS,
      'deny',
    );

    return options;
  }

  async passkeyAddVerify(
    principal: Principal,
    response: RegistrationResponseJSON,
    label: string | undefined,
  ): Promise<EnrolledFactor> {
    const record = parseChallenge(
      await this.cache.take(KEYS.mfa.passkeyEnrollChallenge(principal.familyId)),
    );
    if (record.mode !== 'register') {
      throw new ProblemException({ type: ERR.PASSKEY_CHALLENGE_INVALID });
    }

    const verified = await verifyRegistration(response, record.challenge);

    let created;
    try {
      created = await this.mfa.createPasskey({
        adminId: principal.adminId,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        signCount: verified.signCount,
        transports: verified.transports,
        aaguid: verified.aaguid,
        label: label ?? DEFAULT_PASSKEY_LABEL,
      });
    } catch (err) {
      // The partial unique index is the authority on availability; a check-then-
      // insert would lose the race against a concurrent registration.
      if (isUniqueViolation(err)) {
        throw new ProblemException({ type: ERR.PASSKEY_ALREADY_REGISTERED });
      }
      throw err;
    }

    await this.admins.markMfaEnrolled(principal.adminId);
    await this.notify(principal.adminId, 'A passkey was added to your account');

    return {
      id: created.id,
      kind: 'PASSKEY',
      label: created.label,
      createdAt: created.createdAt,
      lastUsedAt: created.lastUsedAt,
    };
  }

  // ─── remove and rename ────────────────────────────────────────────────────

  async remove(principal: Principal, kind: FactorKind, factorId: string): Promise<void> {
    // Guard BEFORE the write, and from live counts rather than
    // `Admin.mfaEnrolledAt` — a stale value here would decide whether an account
    // may be stripped of its last factor.
    await this.assertNotLastFactor(principal.adminId);

    const retired = await this.factors.retireFactor({ adminId: principal.adminId, kind, factorId });
    if (!retired) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No such factor on this account.' });
    }

    this.logger.log({ adminId: principal.adminId, kind, factorId }, 'second factor retired');
    await this.notify(principal.adminId, `A second factor (${kind}) was removed from your account`);
  }

  async rename(
    principal: Principal,
    kind: FactorKind,
    factorId: string,
    label: string,
  ): Promise<EnrolledFactor> {
    const renamed = await this.factors.renameFactor({
      adminId: principal.adminId,
      kind,
      factorId,
      label,
    });
    if (!renamed) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No such factor on this account.' });
    }

    const factor = await this.factors.findFactor({ adminId: principal.adminId, kind, factorId });
    if (factor === null) throw new ProblemException({ type: ERR.NOT_FOUND });
    return factor;
  }

  // ─── guards and helpers ───────────────────────────────────────────────────

  /**
   * ═══ THE DOWNGRADE GUARD ═══════════════════════════════════════════════════
   *
   * Counted BEFORE the removal, so the question is "would this be the last one",
   * not "was it". An admin rotating their only authenticator uses
   * `totp-add` + `totp-confirm`, which replaces it atomically and never passes
   * through zero.
   */
  private async assertNotLastFactor(adminId: string): Promise<void> {
    const counts = await this.mfa.confirmedFactorCounts(adminId);
    if (counts.totp + counts.passkey > 1) return;

    throw new ProblemException({
      type: ERR.MFA_NOT_ENROLLED,
      detail:
        'This is the only second factor on the account. Add another before removing this one, ' +
        'or rotate it in place with "totp-add".',
    });
  }

  /** Fire-and-forget, like every send. A change made by someone who stole a token
   *  is exactly what must not happen silently, so it is always attempted. */
  private async notify(adminId: string, change: string): Promise<void> {
    const admin = await this.admins.findById(adminId);
    if (admin === null) return;
    await this.mail.sendSecurityChanged(admin.email, change);
  }
}

/** Prisma types `Bytes` as `Uint8Array`; `createDecipheriv` wants Buffers. */
function sealedOf(factor: {
  secretCiphertext: Uint8Array;
  secretIv: Uint8Array;
  secretTag: Uint8Array;
}): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  return {
    ciphertext: Buffer.from(factor.secretCiphertext),
    iv: Buffer.from(factor.secretIv),
    tag: Buffer.from(factor.secretTag),
  };
}

export const TWO_FACTOR_SERVICES = [TwoFactorService, ElevationService] as const;
