import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { policy, quotaSet } from '../../auth/limits';
import { REVOKE_REASON } from '../../auth/auth.types';
import { UserDbOperation } from '../../auth/persistence/user.dboperation';
import { RecentSecurityChangePolicy } from '../../auth/services/recent-security-change.policy';
import { SessionService } from '../../auth/services/session.service';
import { CacheService, KEYS, QuotaService } from '../../redis';
import { TwoFactorDbOperation } from '../2fa/2fa.dboperation';
import { TwoFactorService } from '../2fa/2fa.service';
import { MfaService } from '../2fa/mfa.service';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import { MailService } from '../mail/mail.service';
import { antiPhishingCodeOf } from './antiPhishing/antiPhishing.utility';
import {
  AUTHENTICATOR_SUBJECT,
  KYC_PORT,
  PASSKEY_SUBJECT,
  UNAVAILABLE,
  disablePathsFor,
  type AccountFactors,
  type DisablePath,
  type DisablePathStatus,
  type DisableProofs,
  type DisableSubject,
  type FactorSettingStatus,
  type KycStatusPort,
} from './settings.types';
import { resolveDisablePath } from './settings.utility';
import { SecurityRestrictionService } from '../restrictions/restrictions.service';
import type { RequestFacts } from '../restrictions/restrictions.types';

/**
 * Second factors, as settings the account's owner controls.
 *
 * Two surfaces — biometrics (passkey sign-in) and the authenticator app — over one
 * policy. See `DisablePath` in settings.types.ts for the policy itself and for why
 * the two share it rather than each owning a copy.
 *
 * ─── What this service adds over `POST /auth/2fa` ───────────────────────────
 *
 * `src/2fa/` can already enrol a passkey or a TOTP factor. What it cannot express is
 * the product policy for either as a SWITCH, which differs in four ways:
 *
 *  1. Disabling accepts one of four ALTERNATIVE proof paths, strictly — see
 *     `DisablePath`. The generic `remove` accepted any single factor and made no
 *     distinction between them, which is why it now refuses both kinds and points
 *     here (`TwoFactorService.remove`).
 *  2. Disabling removes EVERY credential of that kind, because "biometrics is off"
 *     and "the authenticator is off" are statements about the account, not about one
 *     credential.
 *  3. Disabling sweeps every other session.
 *  4. Enabling costs an emailed code and nothing else.
 *
 * ─── The relaxation on enabling, stated so it does not look like an oversight ──
 *
 * `POST /auth/2fa {"action":"passkey-add-challenge"}` and `{"action":"totp-add"}`
 * both require an elevation ticket, and a ticket costs a proof of an existing factor
 * plus an emailed code. Enabling either factor through this module requires the
 * emailed code ALONE — no factor proof, no ticket.
 *
 * That is weaker, and it is weaker in the same way and to the same degree for both
 * factors, so neither is a special case:
 *
 *   On an account that ALREADY has a factor, a caller holding both a stolen access
 *   token and the mailbox can enrol a credential of their own where previously they
 *   would also have needed the existing factor.
 *
 *   On an account with NO factor yet, that same caller enrols the account's FIRST
 *   factor and is handed the minted backup codes — which is the sharper version of
 *   the same event, because the codes are the account's recovery path and the
 *   legitimate owner never sees them. This is not new here; it is equally true of the
 *   passkey half, and of `totp-confirm`, which mints codes behind a bearer token.
 *
 * It is the approved product behaviour, and the mailbox is still a second factor
 * that a stolen token alone does not provide. Two things bound the consequence: the
 * emailed code is metered by `CREDENTIAL.OTP_BY_ACCOUNT` (five an hour), and
 * enrolling a factor grants no new power over the account that the access token
 * being used to do it did not already grant.
 *
 * The stricter routes are untouched and still available to clients that want them.
 *
 * ─── Ordering, and why the emailed code is spent before the second proof ────
 *
 * On the paths that need both, the emailed code is consumed FIRST. It is the
 * discipline every other challenge consumer in this service follows: a caller must
 * not be able to use a wrong email code to probe whether their TOTP guess was right,
 * and an abandoned request must still have cost the code.
 *
 * The exception is path AVAILABILITY, which is checked before anything is consumed —
 * offering `totp+otp` to an account with no authenticator and then burning its
 * emailed code to discover that would charge a user for the server's mistake.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger('Settings');

  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly factors: TwoFactorDbOperation,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly users: UserDbOperation,
    private readonly cache: CacheService,
    private readonly quota: QuotaService,
    private readonly mail: MailService,
    /**
     * The security cooldown after an email change.
     *
     * Asked in three places here, and the reason differs between them.
     *
     * `disableFactor` asks because it is the one path that reaches
     * `TwoFactorDbOperation` directly rather than through `TwoFactorService` — nothing
     * else would refuse it.
     *
     * The two ENABLE-CHALLENGE methods ask because of ORDERING, not authority. They
     * spend the account's emailed code and only THEN delegate to `TwoFactorService`,
     * which is where the authoritative check lives. Without a check of their own a
     * frozen user would lose a code per attempt to a refusal the server could have
     * issued for free — the same defect `assertPathAvailable` exists to prevent below,
     * and the same early-refusal pattern `PaymentPinService.verify` uses.
     *
     * The two ENABLE-VERIFY methods deliberately do NOT ask: they delegate immediately,
     * consume nothing first, and a second check would be a copy with nothing to buy.
     */
    private readonly securityChanges: RecentSecurityChangePolicy,
    /** The security consequence of a successful DISABLE. Both factor removals are
     *  trigger actions; enabling either is deliberately not one. */
    private readonly restrictions: SecurityRestrictionService,
    @Inject(KYC_PORT) private readonly kyc: KycStatusPort,
  ) {}

  // ─── read ─────────────────────────────────────────────────────────────────

  /**
   * The account's factor inventory, read once.
   *
   * One place that decides what "enabled" means for each factor, so the status
   * screens and the availability checks cannot answer it differently. Both read
   * CONFIRMED credentials only — `MfaService.availableMethods` is the arbiter of
   * what counts as a real factor, and an abandoned enrollment must not make a user
   * think they have a factor they do not.
   */
  private async accountFactors(userId: string): Promise<AccountFactors> {
    const [methods, backupCodesRemaining, kycVerified] = await Promise.all([
      this.mfa.availableMethods(userId),
      this.factors.countUnusedRecoveryCodes(userId),
      // The port never throws, so this needs no guard — see `KycStatusPort`.
      this.kyc.isVerified(userId),
    ]);

    return {
      passkeyEnabled: methods.includes('passkey'),
      totpEnrolled: methods.includes('totp'),
      backupCodesRemaining,
      kycVerified,
    };
  }

  /**
   * What the biometrics setting screen renders.
   *
   * Reports each disable path's availability WITH a reason, because a client that
   * has to guess why an option is greyed out will guess wrong, and because a user
   * who has lost a credential needs to be told which way out is still open before
   * they start rather than after a refusal.
   *
   * Nothing here leaks: every value describes the caller's own account.
   */
  async biometricsStatus(userId: string): Promise<FactorSettingStatus> {
    const [passkeys, account] = await Promise.all([
      this.factors.listPasskeys(userId),
      this.accountFactors(userId),
    ]);

    return {
      factor: 'passkey',
      enabled: account.passkeyEnabled,
      factorCount: passkeys.length,
      remainingSlots: Math.max(0, policy().MFA.PASSKEYS_PER_ACCOUNT - passkeys.length),
      backupCodesRemaining: account.backupCodesRemaining,
      disablePaths: this.disablePathStatuses(PASSKEY_SUBJECT, account),
    };
  }

  /**
   * What the authenticator setting screen renders.
   *
   * `remainingSlots` is one or zero rather than a policy value, because
   * `TwoFactorService.totpAdd` enforces one authenticator per account — not a
   * technical limit but a product one, so it is not in `policy().MFA` to be tuned.
   *
   * `factorCount` counts CONFIRMED factors, so an abandoned enrollment reads as zero
   * here. It is still swept by a disable; see `AuthenticatorDisabledPayload.removed`
   * for the one place the two counts can legitimately differ.
   */
  async authenticatorStatus(userId: string): Promise<FactorSettingStatus> {
    const [confirmed, account] = await Promise.all([
      this.factors.listConfirmedTotpFactors(userId),
      this.accountFactors(userId),
    ]);

    return {
      factor: 'totp',
      enabled: account.totpEnrolled,
      factorCount: confirmed.length,
      remainingSlots: account.totpEnrolled ? 0 : 1,
      backupCodesRemaining: account.backupCodesRemaining,
      disablePaths: this.disablePathStatuses(AUTHENTICATOR_SUBJECT, account),
    };
  }

  private disablePathStatuses(
    subject: DisableSubject,
    account: AccountFactors,
  ): readonly DisablePathStatus[] {
    return disablePathsFor(subject).map((path) => this.pathStatus(subject, path, account));
  }

  // ─── enable ───────────────────────────────────────────────────────────────

  /**
   * Step one of turning biometrics on: spend the emailed code, return the WebAuthn
   * options.
   *
   * Two calls because the ceremony requires a server-minted challenge before the
   * client can produce an attestation — inherent to WebAuthn, not a policy step.
   * The code is spent here, and the single-use challenge in Redis is what authorises
   * step two, exactly the argument `TWO_FACTOR_REQUIRES` makes for
   * `passkey-add-verify` needing no ticket of its own.
   *
   * `passkeyAddChallenge` enforces `MFA.PASSKEYS_PER_ACCOUNT`, so the slot limit is
   * checked in one place for both routes.
   */
  async enableChallenge(userId: string, emailCode: string): Promise<Record<string, unknown>> {
    const user = await this.requireUser(userId);

    // BEFORE the code is spent. `passkeyAddChallenge` asks again and is the
    // authoritative check; this one exists because the line below is irreversible from
    // the user's side, and a frozen caller must not pay for it.
    await this.securityChanges.assertNoRecentEmailChange(userId);

    await this.twoFactor.consumeCredentialOtp(userId, emailCode);
    return this.twoFactor.passkeyAddChallenge(user);
  }

  /**
   * Step two: verify the attestation and store the credential.
   *
   * Delegates wholesale, which is what makes the backup-code rule automatic:
   * `passkeyAddVerify` mints a set only when the account has none, and returns an
   * empty array otherwise. So the first passkey on an account produces the codes to
   * keep safe and the second through fifth produce nothing — which is the behaviour
   * asked for, arrived at by not reimplementing it.
   */
  async enableVerify(
    userId: string,
    response: RegistrationResponseJSON,
    label?: string,
  ): Promise<{ factor: { id: string; label: string; createdAt: Date }; backupCodes: string[] }> {
    const { factor, recoveryCodes } = await this.twoFactor.passkeyAddVerify(
      userId,
      response,
      label,
    );

    this.logger.log(
      { userId, factorId: factor.id, mintedBackupCodes: recoveryCodes.length > 0 },
      'biometric sign-in enabled',
    );

    return {
      factor: { id: factor.id, label: factor.label, createdAt: factor.createdAt },
      backupCodes: recoveryCodes,
    };
  }

  // ─── enable the authenticator ─────────────────────────────────────────────

  /**
   * Step one of turning the authenticator on: spend the emailed code, mint the
   * secret.
   *
   * ─── How this differs from the passkey half, and why it matters ────────────
   *
   * `passkeyAddChallenge` writes an ephemeral challenge to Redis with a TTL, read
   * back once with `GETDEL`. `totpAdd` writes a DURABLE, unconfirmed `TotpFactor`
   * row and returns the secret in the clear — the secret has to reach the user's
   * authenticator, so there is no version of this step that does not disclose it.
   *
   * That durability is what makes the disable sweep total rather than
   * confirmed-only: `totp-confirm` needs no elevation ticket, so a pending row left
   * behind by an abandoned enrollment is a row a bare access token could confirm
   * later. See `TwoFactorDbOperation.softDeleteAllTotpFactors`.
   *
   * `totpAdd` already refuses when a confirmed factor exists (`MFA_ALREADY_ENROLLED`,
   * one per account) and supersedes an earlier pending row rather than erroring —
   * scanning a QR code and closing the tab is the ordinary way to reach that state.
   * Both are the right answers here, so neither is reimplemented.
   */
  async enableAuthenticatorChallenge(
    userId: string,
    emailCode: string,
    label?: string,
  ): Promise<{ secret: string; uri: string }> {
    const user = await this.requireUser(userId);

    // BEFORE the code is spent — see `enableChallenge` for why the delegate's own
    // check is not enough on this path.
    await this.securityChanges.assertNoRecentEmailChange(userId);

    await this.twoFactor.consumeCredentialOtp(userId, emailCode);
    return this.twoFactor.totpAdd(user, label);
  }

  /**
   * Step two: the user proves their authenticator agrees with us, and the setting
   * comes on.
   *
   * Delegates wholesale, which is what makes two rules automatic rather than
   * duplicated: `totpConfirm` claims the RFC 6238 step so the confirming code cannot
   * then be replayed into a sign-in inside the same thirty seconds, and it mints
   * backup codes only for an account that has none — so confirming a second factor
   * never invalidates codes the user already wrote down.
   *
   * This is the spec's "Verify 2FA" and "Save Backup Codes" in one call. The codes
   * are visible in this response and nowhere else; `recovery-regenerate` replaces
   * the set.
   */
  async enableAuthenticatorVerify(
    userId: string,
    totpCode: string,
  ): Promise<{ backupCodes: string[] }> {
    const { recoveryCodes } = await this.twoFactor.totpConfirm(userId, totpCode);

    this.logger.log(
      { userId, mintedBackupCodes: recoveryCodes.length > 0 },
      'authenticator app enabled',
    );

    return { backupCodes: recoveryCodes };
  }

  // ─── disable ──────────────────────────────────────────────────────────────

  /**
   * Turn biometrics off, given exactly one path's proofs.
   *
   * Atomic from the caller's point of view: it either proves a path and disables, or
   * changes nothing about which credentials exist.
   */
  async disable(
    userId: string,
    sessionId: string,
    facts: RequestFacts,
    proofs: DisableProofs,
  ): Promise<{ removed: number; path: DisablePath }> {
    return this.disableFactor(userId, sessionId, facts, PASSKEY_SUBJECT, proofs);
  }

  /**
   * Turn the authenticator app off, given exactly one path's proofs.
   *
   * The `totp+otp` path here asks the user for a code from the very authenticator
   * they are removing, which is the ordinary case rather than a curiosity: they still
   * have it, and proving they hold it is the cheapest honest authorisation. The other
   * three exist for when they do not.
   */
  async disableAuthenticator(
    userId: string,
    sessionId: string,
    facts: RequestFacts,
    proofs: DisableProofs,
  ): Promise<{ removed: number; path: DisablePath }> {
    return this.disableFactor(userId, sessionId, facts, AUTHENTICATOR_SUBJECT, proofs);
  }

  /**
   * Turn one factor off. The whole of the disable policy, for either surface.
   *
   * ─── The order is the design ────────────────────────────────────────────────
   *
   *   meter -> resolve -> check availability -> consume the emailed code ->
   *   prove the path -> write -> clear orphaned codes -> sweep sessions -> notify
   *
   * Availability comes before anything is consumed, because a path the account cannot
   * use is the server's knowledge and not the caller's mistake. The emailed code is
   * consumed before the second proof, so a wrong code cannot be used to probe whether
   * a TOTP guess was right and an abandoned request has still cost the code. The mail
   * goes last and unawaited, because the setting has already changed and a mail
   * failure must not report the change as failed.
   */
  private async disableFactor(
    userId: string,
    sessionId: string,
    facts: RequestFacts,
    subject: DisableSubject,
    proofs: DisableProofs,
  ): Promise<{ removed: number; path: DisablePath }> {
    // On entry and `deny`: this is the only bound on guesses against a backup code,
    // and there is no durable backstop behind it. One bucket for BOTH surfaces — see
    // `SECURITY_SETTINGS.DISABLE_BY_ACCOUNT` for why entry rather than failure, why
    // the account rather than the session, and why a per-surface key would halve the
    // protection while appearing to keep it.
    await this.cache.consume(
      KEYS.rate.securitySettingsDisableByAccount(userId),
      policy().SECURITY_SETTINGS.DISABLE_BY_ACCOUNT,
      'deny',
    );

    // After the meter, before anything is proved or spent — the slot
    // `assertPathAvailable` below already occupies, and for its reason: a refusal the
    // server can issue for free must not first cost the user their emailed code.
    //
    // Removing a factor is frozen exactly as adding one is. The asymmetry would be
    // tempting — surely taking security AWAY is safe — and it is backwards: an
    // attacker who has just moved the address wants the owner's authenticator gone,
    // and `disableFactor` is what would do it for them.
    await this.securityChanges.assertNoRecentEmailChange(userId);

    // The same pure resolver the DTO ran. Repeated because a policy that holds only
    // when the HTTP layer is in front of it is not the policy.
    const resolved = resolveDisablePath(proofs);
    if (!resolved.ok) {
      throw new ProblemException({ type: ERR.VALIDATION_FAILED, errors: resolved.problems });
    }
    const { path } = resolved;

    await this.assertPathAvailable(userId, subject, path);

    if (path !== 'backup-code') {
      await this.twoFactor.consumeCredentialOtp(userId, proofs.emailCode);
    }

    await this.provePath(userId, path, proofs);

    // ─── the write ──────────────────────────────────────────────────────────
    //
    // Every credential of this kind, not the one that was proved: "the setting is
    // off" is a statement about the account. For TOTP that includes an unconfirmed
    // row — see `softDeleteAllTotpFactors` for why leaving one would be a way back in.
    // ─── The security consequence, resolved BEFORE the write ────────────────
    //
    // Three bounded history reads and a map lookup, producing a plain value that the
    // transaction below writes in its own commit. Placed after every proof is spent —
    // a request about to be refused must not pay for this — and outside the
    // transaction, which already holds a row lock on `identity.users`.
    //
    // Which of the two triggers this is depends on the subject, and that is the only
    // thing this service knows about restrictions. It does not classify, does not read
    // policy and does not decide durations.
    const context = await this.restrictions.contextFrom(userId, sessionId, facts);
    const plan = await this.restrictions.planFor(
      subject.kind === 'passkey' ? 'passkey.remove' : 'authenticator.remove',
      context,
    );

    const removed =
      subject.kind === 'passkey'
        ? await this.factors.softDeleteAllPasskeys(userId, context, plan)
        : await this.factors.softDeleteAllTotpFactors(userId, context, plan);

    // The same last-factor rule the 2FA route applies, called rather than copied:
    // codes with no factor behind them are a second way in that the user never asked
    // for. An account that still has the other factor keeps its codes.
    await this.twoFactor.clearRecoveryCodesIfLastFactor(userId);

    // Every session but this one. The disabled factor may have been how a session was
    // established, and if this disable was not the owner's doing, the sweep is what
    // ends the other party's access — the same reason a password change sweeps.
    await this.sessions.revokeAllForUserExcept(
      userId,
      sessionId,
      subject.kind === 'passkey' ? REVOKE_REASON.PASSKEY_DISABLED : REVOKE_REASON.TOTP_DISABLED,
    );

    const description =
      subject.kind === 'passkey' ? 'biometric sign-in disabled' : 'authenticator app disabled';

    this.logger.warn({ userId, factor: subject.kind, path, removed }, description);

    // After the write, and fire-and-forget by the method's own contract: the setting
    // is already changed, and a mail failure must not report the change as failed.
    const user = await this.users.findById(userId);
    if (user !== null) {
      // From the row this lookup already returned — the anti-phishing code costs no
      // extra query on any notification path.
      this.mail.sendSecurityChanged(user.email, description, facts.ipClass, antiPhishingCodeOf(user));
    }

    return { removed, path };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /**
   * Is this path open on this account at all?
   *
   * Runs BEFORE any proof is consumed. A path the account cannot use is the server's
   * knowledge, not the caller's mistake, and discovering it by spending an emailed
   * code would charge a user for asking a reasonable question.
   *
   * `MFA_METHOD_UNAVAILABLE` for all of them — the caller named a method this
   * account has not set up, which is precisely what that slug means.
   *
   * Shares `pathStatus` rather than re-deriving the rules, so a path the screen
   * offered can never be one this refuses, and vice versa. That symmetry used to be
   * two hand-written copies of four conditions, and their reason strings had already
   * drifted apart.
   */
  private async assertPathAvailable(
    userId: string,
    subject: DisableSubject,
    path: DisablePath,
  ): Promise<void> {
    const status = this.pathStatus(subject, path, await this.accountFactors(userId));
    if (!status.available) {
      throw new ProblemException({
        type: ERR.MFA_METHOD_UNAVAILABLE,
        detail: status.reason,
      });
    }
  }

  /** Run exactly the named path's proof, and refuse on a wrong credential. */
  private async provePath(
    userId: string,
    path: DisablePath,
    proofs: DisableProofs,
  ): Promise<void> {
    const proven = await this.runProof(userId, path, proofs);
    if (!proven) {
      throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
    }
  }

  private async runProof(
    userId: string,
    path: DisablePath,
    proofs: DisableProofs,
  ): Promise<boolean> {
    switch (path) {
      case 'passkey+otp':
        return this.twoFactor.provePasskeyAssertion(
          userId,
          proofs.passkey as AuthenticationResponseJSON,
        );
      case 'totp+otp':
        return this.twoFactor.proveTotpCode(userId, proofs.totpCode as string);
      case 'backup-code':
        return this.twoFactor.proveBackupCode(userId, proofs.backupCode as string);
      case 'kyc+otp':
        return this.proveKyc(userId, proofs);
      default: {
        const exhaustive: never = path;
        return exhaustive;
      }
    }
  }

  /**
   * The KYC path: charge the hard cap, then check the image.
   *
   * ─── Why the charge is before the check, and refunded selectively ───────────
   *
   * Charged first, because a check that costs a third-party call must be bounded
   * before it is made rather than after — otherwise the bound is advisory and the
   * cost is not.
   *
   * Refunded only when the PROVIDER failed. A `false` is the provider's answer: it
   * looked, and the face did not match, which is exactly the event the cap exists to
   * ration and must therefore be paid for. A throw is not an answer at all, and
   * making a user spend one of two monthly attempts on someone else's outage would
   * turn an incident into a lockout.
   *
   * `'durable'` store: a ceiling of two per thirty days that a cache restart resets
   * is not a ceiling.
   *
   * ─── One ceiling across both surfaces ──────────────────────────────────────
   *
   * The keys carry no subject, so a reverification spent disabling biometrics is
   * gone for the authenticator screen too. That is the intent: the cap rations image
   * checks — a third-party call, and a user being asked to photograph themselves —
   * and neither of those costs is halved by which screen asked. Keying it per
   * surface would turn a documented "twice a month" into four times a month while
   * both limits still read as two.
   */
  private async proveKyc(userId: string, proofs: DisableProofs): Promise<boolean> {
    const charge = await this.quota.consumeAll(
      quotaSet(
        policy().SECURITY_SETTINGS.KYC_REVERIFY_BY_ACCOUNT,
        KEYS.rate.kycReverifyByAccount(userId),
        KEYS.rate.kycReverifyByAccountMonthly(userId),
      ),
      'durable',
      'deny',
    );

    try {
      return await this.kyc.reverify(userId, proofs.kyc as { reference: string });
    } catch (err) {
      // `refund` swallows its own failures: the reverification already did not
      // happen, and turning a refund error into the caller's error would replace an
      // outage with a second, more confusing one.
      await this.quota.refund(charge, 'durable');
      throw err;
    }
  }

  /**
   * One path's availability on one account. The whole availability rule, for both
   * surfaces and for both callers.
   *
   * Pure and synchronous, given the snapshot — which is what lets the setting screen
   * and the pre-consumption check share it, and what makes the refusal matrix
   * testable without a DI container.
   *
   * Note how the "setting is already off" test subsumes the self-path test: the
   * subject's own path is available exactly when the setting is on, because it IS
   * the setting. So there is one condition per path below and no special case for
   * which surface is asking.
   */
  private pathStatus(
    subject: DisableSubject,
    path: DisablePath,
    account: AccountFactors,
  ): DisablePathStatus {
    const emailCodeRequired = path !== 'backup-code';
    const unavailable = (reason: string): DisablePathStatus => ({
      path,
      available: false,
      reason,
      emailCodeRequired,
    });

    // Nothing to disable means no path is offered — the honest answer for a setting
    // that is already off, and it keeps a client from rendering four live options on
    // a screen where the switch cannot move.
    const enabled = subject.kind === 'passkey' ? account.passkeyEnabled : account.totpEnrolled;
    if (!enabled) return unavailable(subject.offReason);

    if (path === 'passkey+otp' && !account.passkeyEnabled) {
      return unavailable(UNAVAILABLE.NO_PASSKEY);
    }
    if (path === 'totp+otp' && !account.totpEnrolled) {
      return unavailable(UNAVAILABLE.NO_TOTP);
    }
    if (path === 'backup-code' && account.backupCodesRemaining === 0) {
      // Unused, not merely "a set exists": a user who has spent every code has no
      // proof left to offer, and `hasAnyRecoveryCode` would report the set and let
      // them burn an attempt discovering that.
      return unavailable(UNAVAILABLE.NO_BACKUP_CODES);
    }
    if (path === 'kyc+otp' && !account.kycVerified) {
      return unavailable(UNAVAILABLE.NO_KYC);
    }

    return { path, available: true, emailCodeRequired };
  }

  private async requireUser(userId: string) {
    const found = await this.users.findWithCredential(userId);
    if (found === null) {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
    return found.user;
  }
}
