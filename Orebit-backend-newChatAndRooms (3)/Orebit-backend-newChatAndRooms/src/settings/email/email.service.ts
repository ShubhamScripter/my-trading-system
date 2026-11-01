import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { RetainedEmail, User } from '@prisma/client';
import { EMAIL, OTP } from '../../../auth/auth.constants';
import type { Principal } from '../../../auth/auth.types';
import { REVOKE_REASON } from '../../../auth/auth.types';
import { generateOtp, normaliseEmail, pepperedHash } from '../../../auth/auth.utility';
import { policy, quotaSet } from '../../../auth/limits';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { ChallengeDbOperation } from '../../../auth/persistence/challenge.dboperation';
import { spendChallenge, verifyChallengeCode } from '../../../auth/security/challenge';
import { BlocklistService } from '../../../auth/services/blocklist.service';
import { CredentialService } from '../../../auth/services/credential.service';
import { SessionService } from '../../../auth/services/session.service';
import { SecurityRestrictionService } from '../../restrictions/restrictions.service';
import type { RequestFacts, RestrictionPlan, SecurityContext } from '../../restrictions/restrictions.types';
import { isUniqueViolation } from '../../../db/client';
import { CacheService, KEYS, QuotaService } from '../../../redis';
import { TwoFactorService } from '../../2fa/2fa.service';
import { MfaService } from '../../2fa/mfa.service';
import { config } from '../../config';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { MailService } from '../../mail/mail.service';
import { antiPhishingCodeOf } from '../antiPhishing/antiPhishing.utility';
import { RetainedEmailDbOperation } from '../../../auth/persistence/retained-email.dboperation';
import { safeEqual, secondsFromNow } from '../../utils/public.utils';
import { KYC_PORT, type KycStatusPort } from '../settings.types';
import type {
  EmailChangeRequest,
  EmailChangeVerifyRequest,
  EmailRecoveryVerifyRequest,
} from './email.dto';
import {
  EMAIL_CHANGE_UNAVAILABLE,
  PURPOSE_BY_TARGET,
  canSkipRetained,
  type EmailChangeAccount,
  type EmailChangeGrant,
  type EmailChangeMethod,
  type EmailChangeStatus,
  type EmailProofTarget,
  type EmailRecoveryGrant,
  type RecoveryIntent,
} from './email.types';
import {
  maskEmail,
  methodAllowed,
  methodUnavailableReason,
  methodsFor,
  parseChangeGrant,
  parseRecoveryGrant,
  resolveEmailChangeProof,
  serialiseGrant,
} from './email.utility';

/**
 * ═══ CHANGING THE ACCOUNT'S EMAIL ADDRESS ═══════════════════════════════════
 *
 * See `email.types.ts` for the policy tables and for why this is the hardest surface in
 * `src/settings/`.
 *
 * ─── Two ceremonies, and the second is why the first is safe ────────────────
 *
 * CHANGE is authenticated: two emailed codes — one to the address held now, one to the
 * address being claimed — plus the strongest security proof the account can offer, plus
 * a code to any previous address still inside its retention window.
 *
 * RECOVERY is not authenticated, and that is the point. A completed change sweeps every
 * session and the released address can no longer sign in, so whoever changed an address
 * away from its owner would otherwise have taken the account outright. Instead the
 * change mails that address a single-use ticket, and the ticket plus a code to the same
 * address authorises putting the account back — or moving it somewhere the ticket-holder
 * does control. Every operation recovery can perform points the account at an address
 * proved in the same request, which is what stops a recovery being an escalation.
 *
 * ─── The order, and why it never varies ─────────────────────────────────────
 *
 *   meter -> validate the address -> check availability -> create the challenge ->
 *   send the codes ... then, on verify: consume the codes -> prove the factor ->
 *   mutate in one transaction -> sweep sessions -> notify
 *
 * Metering is first and on entry, so a caller hammering this is refused before it costs
 * a database read or an outbound message. Availability is checked before anything is
 * consumed, because an address the account cannot claim is the server's knowledge and
 * not the caller's mistake. The codes are consumed before the security proof, so a wrong
 * code cannot be used to probe whether a password guess was right. The mail goes last
 * and unawaited except for the one message that carries a recovery ticket.
 *
 * That is the identical ordering `SettingsService.disableFactor` and
 * `PaymentPinService` document, and identical on purpose: three security surfaces in one
 * module that consume proofs in different orders are three sets of failure modes to
 * reason about separately.
 *
 * ─── What this file does not do ─────────────────────────────────────────────
 *
 * No crypto, no WebAuthn, no argon2, no OTP arithmetic. Codes go through
 * `challenges.issue` and `verifyChallengeCode`; factors through `TwoFactorService`; the
 * password through `CredentialService`; identity through `KycStatusPort`. The moment
 * this file grows one of those imports it has taken on something belonging to a
 * mechanism.
 */
@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger('EmailChange');

  constructor(
    private readonly emails: RetainedEmailDbOperation,
    private readonly users: UserDbOperation,
    private readonly challenges: ChallengeDbOperation,
    private readonly twoFactor: TwoFactorService,
    private readonly mfa: MfaService,
    private readonly credentials: CredentialService,
    private readonly blocklist: BlocklistService,
    private readonly sessions: SessionService,
    private readonly cache: CacheService,
    private readonly quota: QuotaService,
    private readonly mail: MailService,
    /** The security consequence of a successful CHANGE. The recovery paths
     *  (`recoverStart`, `verifyRecovery`) are deliberately NOT a trigger: they exist
     *  for the person who has just LOST the account, and restricting them would close
     *  the flow for exactly the victim it is there to help. */
    private readonly restrictions: SecurityRestrictionService,
    @Inject(KYC_PORT) private readonly kyc: KycStatusPort,
  ) {}

  // ─── read ───────────────────────────────────────────────────────────────

  /**
   * The account's security inventory, read once.
   *
   * One place decides what each tier means, so the status screen and the pre-consumption
   * checks cannot answer differently. `MfaService.availableMethods` is the arbiter of
   * what counts as a real factor — CONFIRMED credentials only — and the KYC port never
   * throws, so no guard is needed around it.
   */
  private async account(userId: string): Promise<EmailChangeAccount> {
    const [methods, kycVerified, found] = await Promise.all([
      this.mfa.availableMethods(userId),
      this.kyc.isVerified(userId),
      this.users.findWithCredential(userId),
    ]);

    return {
      passkeyEnabled: methods.includes('passkey'),
      totpEnrolled: methods.includes('totp'),
      kycVerified,
      // A missing row rather than a null hash — an account that skipped the password
      // step, or was created through a provider, has no `credentials` row at all.
      hasPassword: found?.credential != null,
    };
  }

  /** What the email setting screen renders. Nothing here leaks: every value describes
   *  the caller's own account, and the addresses are masked. */
  async status(principal: Principal): Promise<EmailChangeStatus> {
    const user = await this.requireUser(principal.userId);

    const [account, retained, spendable, pending, used] = await Promise.all([
      this.account(principal.userId),
      this.emails.listLiveForUser(principal.userId),
      this.emails.findSpendableForUser(principal.userId),
      this.readPending(principal.userId),
      // Read WITHOUT charging. `QuotaService.used` is documented as being for metrics
      // rather than enforcement, which is exactly this: a number for a screen, where the
      // authoritative answer is still the refusal `consumeAll` produces. It never
      // throws, so a cache blip degrades this to an optimistic count rather than failing
      // the whole render.
      this.quota.used(
        KEYS.rate.emailChangeByAccount(principal.userId),
        policy().EMAIL_CHANGE.CHANGE_BY_ACCOUNT,
        'durable',
      ),
    ]);

    const live = retained[0] ?? null;
    const rule = policy().EMAIL_CHANGE.CHANGE_BY_ACCOUNT;

    return {
      email: maskEmail(user.email),
      emailVerified: user.emailVerifiedAt !== null,
      change: {
        available: true,
        securityMethods: methodsFor(account),
        securityRequired: !methodsFor(account).includes('none'),
        remaining: Math.max(0, rule.limit - used),
      },
      pending:
        pending === null
          ? { active: false }
          : {
              active: true,
              newEmail: maskEmail(pending.newEmail),
              method: pending.method,
              requiredTargets: pending.requiredTargets,
            },
      retainedEmail:
        live === null
          ? { active: false }
          : {
              active: true,
              email: maskEmail(live.email),
              expiresAt: live.expiresAt.toISOString(),
              otpRequired: true,
            },
      recovery:
        spendable === null
          ? { available: false }
          : { available: true, expiresAt: spendable.expiresAt.toISOString() },
    };
  }

  // ─── start ──────────────────────────────────────────────────────────────

  /**
   * Begin a change: fix the policy, mint the challenge, send the codes.
   *
   * ─── Why the whole policy is decided HERE rather than at verify ─────────
   *
   * The tier, the address, and the set of mailboxes that must answer are all written
   * into the server's record before a single code is sent, and the completion reads them
   * from that record. Deciding any of them later would mean the client could influence
   * them: a challenge started against a passkey could be finished with a password, or a
   * challenge minted for one address completed against another. Both are the same class
   * of substitution, and fixing the policy up front is what makes both impossible rather
   * than merely checked.
   */
  async start(
    principal: Principal,
    ipAddress: string,
    input: Extract<EmailChangeRequest, { action: 'start' }>,
  ): Promise<EmailChangeGrant & { expiresInSeconds: number }> {
    // On entry and `deny`: this bounds the ceremony itself, before it costs a database
    // read or an outbound message. The mail it causes is bounded separately, per
    // recipient — see `sendCode`.
    await this.cache.consume(
      KEYS.rate.emailChangeStartByAccount(principal.userId),
      policy().EMAIL_CHANGE.START_BY_ACCOUNT,
      'deny',
    );

    const user = await this.requireUser(principal.userId);
    const newEmailLower = normaliseEmail(input.newEmail);

    if (newEmailLower === user.emailLower) {
      throw new ProblemException({
        type: ERR.EMAIL_SAME_AS_CURRENT,
        detail: EMAIL_CHANGE_UNAVAILABLE.SAME_ADDRESS,
      });
    }

    // The seventh door. `BlocklistService`'s own header names the failure mode of
    // forgetting one: it is silent, and you find out because somebody walked in through
    // the door nobody wired up.
    await this.blocklist.assertNotBlocked(newEmailLower);

    await this.assertAddressAvailable(principal.userId, newEmailLower);

    const account = await this.account(principal.userId);
    this.assertMethodAllowed(input.method, account);

    const retained = await this.resolveRetained(principal.userId, input, account);

    const targets: EmailProofTarget[] = ['current', 'new'];
    if (retained.requireCode) targets.push('retained');

    const grant: EmailChangeGrant = {
      challengeId: randomBytes(32).toString('base64url'),
      userId: principal.userId,
      // The rotation FAMILY, not the session: `sessionId` changes on every refresh and
      // this ceremony lasts half an hour. Same reasoning as `KEYS.paymentPin.challenge`,
      // with six times the exposure to it.
      familyId: principal.familyId,
      newEmail: input.newEmail,
      newEmailLower,
      method: input.method,
      requiredTargets: targets,
      retainedEmailLower: retained.requireCode ? (retained.record?.emailLower ?? null) : null,
      skippedRetained: retained.skipped,
    };

    // Written BEFORE the codes go out. A code whose ceremony was not recorded is a code
    // the user can never spend, and `cache.set` throws rather than degrading, so an
    // outage refuses the ceremony instead of half-starting it.
    await this.cache.set(
      KEYS.emailChange.pending(principal.userId),
      serialiseGrant(grant),
      policy().EMAIL_CHANGE.CHALLENGE_TTL_SECONDS,
    );

    await this.sendCode(user, grant, 'current', ipAddress);
    await this.sendCode(user, grant, 'new', ipAddress);
    if (retained.requireCode && retained.record !== null) {
      await this.sendCode(user, grant, 'retained', ipAddress);
    }

    this.logger.log(
      {
        userId: principal.userId,
        method: input.method,
        targets,
        skippedRetained: retained.skipped,
      },
      'email change started',
    );

    return { ...grant, expiresInSeconds: policy().EMAIL_CHANGE.CHALLENGE_TTL_SECONDS };
  }

  /**
   * Re-send one code without disturbing the others.
   *
   * Per-target deliberately. `ChallengeDbOperation.issue` supersedes the live row for a
   * `(user, purpose)` pair, so a "resend everything" would invalidate the two codes the
   * user has already found in order to deliver the one they are missing.
   *
   * Metered on its OWN budget and not the start one it used to share. Sharing made the
   * long `CHALLENGE_TTL_SECONDS` pointless — it is long so a resend fits inside one
   * ceremony, and a resend that spent a start slot forced the restart that was meant to
   * avoid. See `EMAIL_CHANGE.RESEND_BY_ACCOUNT`.
   */
  async resend(
    principal: Principal,
    ipAddress: string,
    input: Extract<EmailChangeRequest, { action: 'resend' }>,
  ): Promise<void> {
    await this.cache.consume(
      KEYS.rate.emailChangeResendByAccount(principal.userId),
      policy().EMAIL_CHANGE.RESEND_BY_ACCOUNT,
      'deny',
    );

    const user = await this.requireUser(principal.userId);
    const grant = await this.requirePending(principal, input.challengeId);

    if (!grant.requiredTargets.includes(input.target)) {
      throw new ProblemException({
        type: ERR.EMAIL_CHANGE_CHALLENGE_INVALID,
        detail: 'This change does not use a code from that address.',
      });
    }

    await this.sendCode(user, grant, input.target, ipAddress);
  }

  // ─── verify and commit ──────────────────────────────────────────────────

  /**
   * Complete a change: spend every code, prove the factor, move the address.
   *
   * ─── Why this endpoint performs the mutation ────────────────────────────
   *
   * Payment PIN splits verification from the action because its action carries a payload
   * — the new PIN — that the challenge cannot hold. Here the challenge already holds
   * everything: the address, the tier, the mailboxes. A separate completion call would
   * carry nothing but an id, and would open a window in which the change is authorised
   * but not applied. So all the proofs arrive together and the mutation is atomic with
   * them.
   */
  async verifyChange(
    principal: Principal,
    facts: RequestFacts,
    input: EmailChangeVerifyRequest,
  ): Promise<{ email: string }> {
    await this.cache.consume(
      KEYS.rate.emailChangeVerifyByAccount(principal.userId),
      policy().EMAIL_CHANGE.VERIFY_BY_ACCOUNT,
      'deny',
    );

    const user = await this.requireUser(principal.userId);
    const grant = await this.requirePending(principal, input.challengeId);

    // The same pure resolver the DTO ran. Repeated because a policy that holds only when
    // the HTTP layer is in front of it is not the policy.
    const resolved = resolveEmailChangeProof(input);
    if (!resolved.ok) {
      throw new ProblemException({ type: ERR.VALIDATION_FAILED, errors: resolved.problems });
    }

    // The downgrade check. The tier was fixed at `start`; a request naming a different
    // one is refused rather than run, whichever direction it moves.
    if (resolved.method !== grant.method) {
      throw new ProblemException({
        type: ERR.EMAIL_CHANGE_CHALLENGE_INVALID,
        detail: 'This change was started with a different verification method.',
        extra: { method: grant.method },
      });
    }

    // Re-checked at completion, because the world moved while the user read three
    // mailboxes: somebody may have registered the address, or it may have entered a
    // retention window. §29's requirement, and cheaper than discovering it as a
    // constraint violation.
    await this.assertAddressAvailable(principal.userId, grant.newEmailLower);

    const account = await this.account(principal.userId);
    this.assertMethodAllowed(grant.method, account);

    // Every code first, and all of them before the factor: a wrong code must not be
    // usable to probe whether a password guess was right, and an abandoned request must
    // still have cost the codes.
    await this.consumeCodes(user, grant, input);

    await this.proveMethod(principal.userId, grant.method, input);

    // Resolved after every proof is spent and before the transaction opens — three
    // bounded history reads and a map lookup, producing a plain value.
    const context = await this.restrictions.contextFrom(
      principal.userId,
      principal.sessionId,
      facts,
    );
    const plan = await this.restrictions.planFor('email.update', context);

    await this.commitChange(user, grant, facts.ipClass, { context, plan });

    return { email: grant.newEmail };
  }

  /**
   * The write, the sweep and the notifications.
   *
   * The budget is charged HERE rather than on entry, and it is the only quota in this
   * file that is: it is a product cap on how often the identifier moves, not an
   * anti-abuse bound — those are `START_BY_ACCOUNT` and `VERIFY_BY_ACCOUNT`, both
   * charged on entry — so a ceremony that failed its proofs must not spend one of two
   * monthly changes. Charged before the write rather than after, so two concurrent
   * completions cannot both pass the check.
   */
  private async commitChange(
    user: User,
    grant: EmailChangeGrant,
    ipClass: string,
    restriction: { context: SecurityContext; plan: RestrictionPlan },
  ): Promise<void> {
    await this.quota.consumeAll(
      quotaSet(
        [policy().EMAIL_CHANGE.CHANGE_BY_ACCOUNT],
        KEYS.rate.emailChangeByAccount(user.id),
      ),
      'durable',
      'deny',
    );

    const recoveryToken = randomBytes(EMAIL.RECOVERY_TOKEN_BYTES).toString('base64url');
    const skipped = grant.skippedRetained ? await this.liveRetained(user.id) : null;

    try {
      await this.emails.changeEmail({
        userId: user.id,
        newEmail: grant.newEmail,
        newEmailLower: grant.newEmailLower,
        releasedEmail: user.email,
        releasedEmailLower: user.emailLower,
        retentionExpiresAt: this.retentionDeadline(),
        recoveryTokenHash: pepperedHash(recoveryToken, 'email-recovery'),
        skippedRetainedId: skipped?.id ?? null,
        restriction,
      });
    } catch (err) {
      // `ix_users_email_active` is a partial index Prisma cannot see, so a collision
      // arrives as a raw 23505 rather than a typed P2002 — `isUniqueViolation` handles
      // both. Someone claimed the address between the check above and this write; the
      // transaction rolled back, so nothing changed.
      if (isUniqueViolation(err)) {
        throw new ProblemException({
          type: ERR.EMAIL_ALREADY_REGISTERED,
          detail: 'That email address was claimed while you were confirming. Try another.',
        });
      }
      throw err;
    }

    // Every session, including this one. Unlike a password change — which keeps the
    // caller's session, because signing someone out of the tab they are standing in is
    // hostile — the address that authenticated this session no longer belongs to the
    // account. Keeping it would leave a session resting on a credential that is now
    // somebody else's to claim.
    await this.sessions.revokeAllForUser(user.id, REVOKE_REASON.EMAIL_CHANGED);

    // ─── And the sign-ins that never became sessions ──────────────────────────
    //
    // The same gap the password change had. A sweep ends sign-ins that FINISHED; a
    // sign-in half-way through its MFA ceremony has no session yet — it is a
    // `login_attempts` row at `FACTOR_REQUIRED` holding a `loginId`, and nothing in the
    // second half of that ceremony re-reads the identifier it started from.
    //
    // It matters more here than it does for a password, because this method revokes
    // EVERY session with no exception kept: the reasoning above is that the address
    // which authenticated those sessions is no longer the account's. A flow opened
    // against that same released address is resting on exactly the credential this
    // revocation distrusts, so leaving it drivable would undo the sweep one row at a
    // time.
    await this.mfa.expireLiveAttemptsFor(user.id);

    this.logger.warn(
      { userId: user.id, method: grant.method, skippedRetained: grant.skippedRetained },
      'email changed',
    );

    // Read from the row BEFORE the address moved, which is the same row and therefore
    // the same code — the change does not touch the anti-phishing columns.
    await this.notifyChange(
      user.email,
      grant.newEmail,
      recoveryToken,
      ipClass,
      antiPhishingCodeOf(user),
    );
  }

  // ─── recovery ───────────────────────────────────────────────────────────

  /**
   * Begin a recovery from a released address. No session required.
   *
   * The ticket resolves the account; nothing in the request names one, and nothing in
   * the response reveals one that the caller's own mailbox did not already receive.
   */
  async recoverStart(
    ipAddress: string,
    ipClass: string,
    input: Extract<EmailChangeRequest, { action: 'recover-start' }>,
  ): Promise<EmailRecoveryGrant & { expiresInSeconds: number }> {
    // The only bucket chargeable on entry: there is no account until the ticket
    // resolves, so an IP is the only subject available.
    await this.cache.consume(
      KEYS.rate.emailRecoverByIp(ipAddress),
      policy().EMAIL_CHANGE.RECOVER_BY_IP,
      'deny',
    );

    const record = await this.resolveTicket(input.recoveryId);

    // The per-account bound, applied the moment there is an account to bound. Keyed on
    // the RECORD rather than the token, so asking for a fresh ticket cannot mint a fresh
    // budget.
    await this.cache.consume(
      KEYS.rate.emailRecoverByRecord(record.id),
      policy().EMAIL_CHANGE.RECOVER_BY_TOKEN,
      'deny',
    );

    const user = await this.requireUser(record.userId);

    const target =
      input.intent === 'restore'
        ? { email: record.email, emailLower: record.emailLower }
        : { email: input.newEmail as string, emailLower: normaliseEmail(input.newEmail as string) };

    if (input.intent === 'replace') {
      if (target.emailLower === user.emailLower) {
        throw new ProblemException({
          type: ERR.EMAIL_SAME_AS_CURRENT,
          detail: EMAIL_CHANGE_UNAVAILABLE.SAME_ADDRESS,
        });
      }
      await this.blocklist.assertNotBlocked(target.emailLower);
      await this.assertAddressAvailable(record.userId, target.emailLower);
    }

    const grant: EmailRecoveryGrant = {
      challengeId: randomBytes(32).toString('base64url'),
      retainedEmailId: record.id,
      userId: record.userId,
      intent: input.intent,
      targetEmail: target.email,
      targetEmailLower: target.emailLower,
      reportedCompromise: input.reportedCompromise === true,
    };

    await this.cache.set(
      KEYS.emailChange.pending(record.userId),
      serialiseGrant(grant),
      policy().EMAIL_CHANGE.CHALLENGE_TTL_SECONDS,
    );

    // Always to the released address: that is the mailbox the ticket was mailed to, and
    // proving it again is what stops a leaked ticket alone being enough.
    await this.sendRecoveryCode(record, 'retained', record.emailLower, ipAddress);
    if (input.intent === 'replace') {
      await this.sendRecoveryCode(record, 'new', target.emailLower, ipAddress);
    }

    this.logger.warn(
      {
        userId: record.userId,
        intent: input.intent,
        reportedCompromise: grant.reportedCompromise,
        ipClass,
      },
      'email recovery started',
    );

    return { ...grant, expiresInSeconds: policy().EMAIL_CHANGE.CHALLENGE_TTL_SECONDS };
  }

  /** Complete a recovery: spend the codes, claim the ticket, move the address. */
  async verifyRecovery(
    ipAddress: string,
    ipClass: string,
    input: EmailRecoveryVerifyRequest,
  ): Promise<{ email: string; intent: RecoveryIntent }> {
    await this.cache.consume(
      KEYS.rate.emailRecoverByIp(ipAddress),
      policy().EMAIL_CHANGE.RECOVER_BY_IP,
      'deny',
    );

    const record = await this.resolveTicket(input.recoveryId);

    await this.cache.consume(
      KEYS.rate.emailRecoverByRecord(record.id),
      policy().EMAIL_CHANGE.RECOVER_BY_TOKEN,
      'deny',
    );

    const grant = parseRecoveryGrant(
      await this.cache.get(KEYS.emailChange.pending(record.userId)),
    );
    if (grant === null || grant.retainedEmailId !== record.id) {
      throw new ProblemException({
        type: ERR.EMAIL_RECOVERY_INVALID,
        detail: 'Start the recovery again from the link in your email.',
      });
    }

    const user = await this.requireUser(record.userId);

    // The released address always answers.
    await this.consumeCode(
      record.userId,
      'retained',
      record.emailLower,
      input.retainedEmailCode,
    );

    if (grant.intent === 'replace') {
      if (input.newEmailCode === undefined) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          errors: [
            { path: 'newEmailCode', message: 'Required when moving to a different address.' },
          ],
        });
      }
      await this.assertAddressAvailable(record.userId, grant.targetEmailLower);
      await this.consumeCode(
        record.userId,
        'new',
        grant.targetEmailLower,
        input.newEmailCode,
      );
    } else if (input.newEmailCode !== undefined) {
      // Refused rather than ignored: a caller sending it believes a second mailbox was
      // checked, and it was not.
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          { path: 'newEmailCode', message: 'Not permitted when restoring your old address.' },
        ],
      });
    }

    const renewedToken = randomBytes(EMAIL.RECOVERY_TOKEN_BYTES).toString('base64url');
    const released = user.email;

    let moved: boolean;
    try {
      moved = await this.emails.recoverEmail({
        retainedEmailId: record.id,
        userId: record.userId,
        intent: grant.intent,
        targetEmail: grant.targetEmail,
        targetEmailLower: grant.targetEmailLower,
        renewedExpiresAt: this.retentionDeadline(),
        renewedRecoveryTokenHash: pepperedHash(renewedToken, 'email-recovery'),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ProblemException({
          type: ERR.EMAIL_ALREADY_REGISTERED,
          detail: 'That email address was claimed while you were confirming. Try another.',
        });
      }
      throw err;
    }

    if (!moved) {
      // Lost the compare-and-swap: another request spent this ticket first, or the
      // window closed. Nothing was changed.
      throw new ProblemException({
        type: ERR.EMAIL_RECOVERY_INVALID,
        detail: 'That recovery link has already been used.',
      });
    }

    await this.cache.clear(KEYS.emailChange.pending(record.userId));

    // EVERY session, with no exception kept — unlike a change, the caller has no session
    // to preserve, and in the case this exists for the live sessions belong to whoever
    // performed the change being undone.
    await this.sessions.revokeAllForUser(record.userId, REVOKE_REASON.EMAIL_RECOVERED);

    // And the half-finished sign-ins, for the reason `commitChange` gives — with the
    // argument at its strongest on this path. Both intents move the address, so both
    // reach here; and in the case this exists for, the party holding a live `loginId`
    // for this account is the attacker whose change is being reversed. Reached only
    // past the `moved` check above, so a recovery that lost its compare-and-swap and
    // changed nothing retires nothing.
    await this.mfa.expireLiveAttemptsFor(record.userId);

    this.logger.warn(
      {
        userId: record.userId,
        intent: grant.intent,
        reportedCompromise: grant.reportedCompromise,
        ipClass,
      },
      grant.reportedCompromise
        ? 'email change reported as unauthorised and reversed'
        : 'email recovered',
    );

    // The address that just lost the account. In the compromise case this is the other
    // party's mailbox, which is why the message says almost nothing.
    this.mail.sendEmailRemoved(released, ipClass);

    // One lookup for both branches. This is the recovery path — rare and high-stakes,
    // the same exception `sendRecoveryCode` documents — and the alternative is a
    // recovery confirmation with no mark of authenticity on it.
    const owner = await this.users.findById(record.userId);
    const ownerCode = owner === null ? null : antiPhishingCodeOf(owner);

    if (grant.intent === 'replace') {
      // A replace leaves the released address on hold again, with a fresh window — so it
      // gets a fresh ticket, and the same "did you do this?" question.
      await this.notifyChange(record.email, grant.targetEmail, renewedToken, ipClass, ownerCode);
    } else {
      this.mail.sendEmailAdded(grant.targetEmail, ipClass, ownerCode);
    }

    return { email: grant.targetEmail, intent: grant.intent };
  }

  // ─── proofs ─────────────────────────────────────────────────────────────

  /** Spend every code the challenge demanded, and refuse a code it did not ask for. */
  private async consumeCodes(
    user: User,
    grant: EmailChangeGrant,
    input: EmailChangeVerifyRequest,
  ): Promise<void> {
    const supplied: Record<EmailProofTarget, string | undefined> = {
      current: input.currentEmailCode,
      new: input.newEmailCode,
      retained: input.retainedEmailCode,
    };

    const addresses: Record<EmailProofTarget, string | null> = {
      current: user.emailLower,
      new: grant.newEmailLower,
      retained: grant.retainedEmailLower,
    };

    for (const target of (['current', 'new', 'retained'] as const)) {
      const required = grant.requiredTargets.includes(target);
      const code = supplied[target];

      if (!required) {
        if (code !== undefined) {
          // Refused rather than ignored, so a client that believes it proved three
          // mailboxes is told it only needed two.
          throw new ProblemException({
            type: ERR.VALIDATION_FAILED,
            errors: [
              { path: `${target}EmailCode`, message: 'This change does not use that address.' },
            ],
          });
        }
        continue;
      }

      if (code === undefined) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          errors: [{ path: `${target}EmailCode`, message: 'Required for this change.' }],
        });
      }

      await this.consumeCode(user.id, target, addresses[target], code);
    }
  }

  /**
   * Verify and spend one code, bound to the address it was mailed to.
   *
   * The `targetEmailLower` argument is what makes the binding real. Without it
   * `verifyChallengeCode` finds the live row for `(userId, purpose)` and asks only
   * whether the digits match — so the code the user legitimately received at their
   * CURRENT inbox would satisfy the proof for an address they have shown no control
   * over.
   *
   * `current` passes no target, because its code goes to the account's own address and
   * there is exactly one candidate — the same reason the three original purposes carry
   * no target at all.
   */
  private async consumeCode(
    userId: string,
    target: EmailProofTarget,
    addressLower: string | null,
    code: string,
  ): Promise<void> {
    const challenge = await verifyChallengeCode(
      this.challenges,
      userId,
      PURPOSE_BY_TARGET[target],
      code,
      target === 'current' ? undefined : (addressLower ?? undefined),
    );
    await spendChallenge(this.challenges, challenge.id);
  }

  /**
   * Run exactly the named tier's proof, and refuse on a wrong credential.
   *
   * A switch on the discriminant rather than on which fields are present, so adding a
   * tier is a compile error here until it is handled — that is what the `never` default
   * buys. There is no fallback and no first-match: trying each proof would collapse five
   * ordered tiers into one OR whose weakest member decides.
   */
  private async proveMethod(
    userId: string,
    method: EmailChangeMethod,
    input: EmailChangeVerifyRequest,
  ): Promise<void> {
    switch (input.method) {
      case 'authenticator': {
        // Claims the RFC 6238 step, so a code shoulder-surfed inside its 30-second
        // window cannot be replayed into a second ceremony.
        if (!(await this.twoFactor.proveTotpCode(userId, input.totpCode))) {
          throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
        }
        return;
      }

      case 'passkey': {
        const proved = await this.twoFactor.provePasskeyAssertion(
          userId,
          // The schema keeps the WebAuthn response `passthrough`, so its inferred type
          // is the one field it bounds rather than the library's. Same cast as
          // `disableBiometrics`: the library owns the shape and verifies every field
          // cryptographically.
          input.passkey as unknown as AuthenticationResponseJSON,
        );
        if (!proved) throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
        return;
      }

      case 'kyc': {
        if (!(await this.proveKyc(userId, input.kyc))) {
          throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
        }
        return;
      }

      case 'password': {
        const found = await this.users.findWithCredential(userId);
        if (found?.credential == null) {
          // The account lost its password between `start` and here. The honest answer is
          // the availability one, not a wrong-password error.
          throw new ProblemException({
            type: ERR.MFA_METHOD_UNAVAILABLE,
            detail: EMAIL_CHANGE_UNAVAILABLE.NO_PASSWORD,
          });
        }
        // `checkPassword` rather than a bare `verify`: it carries the durable lockout,
        // so guessing here costs the same as guessing at sign-in. A password proof that
        // did not feed the lockout would be a counter-free oracle for the same secret.
        if (!(await this.credentials.checkPassword(found.credential, input.password))) {
          throw new ProblemException({ type: ERR.INVALID_CREDENTIALS });
        }
        return;
      }

      case 'none': {
        // The two emailed codes are the whole proof. Reached only for an account with no
        // factor, no KYC and no password — `assertMethodAllowed` has already refused this
        // tier for anyone who has something stronger.
        void method;
        return;
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  /**
   * The KYC tier: charge the hard cap, then check the image.
   *
   * Charged first, because a check that costs a third-party call must be bounded before
   * it is made. Refunded only when the PROVIDER failed: a `false` is the provider's
   * answer and is exactly the event the cap rations, while a throw is not an answer at
   * all. The same arrangement — and the same shared bucket — as
   * `SettingsService.proveKyc`, because the cap rations image checks rather than screens.
   */
  private async proveKyc(userId: string, evidence: { reference: string }): Promise<boolean> {
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
      return await this.kyc.reverify(userId, evidence);
    } catch (err) {
      await this.quota.refund(charge, 'durable');
      throw err;
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /**
   * Is this address claimable by this account right now?
   *
   * Three ways it is not, and the third is the interesting one. It may belong to a live
   * account. It may be reserved by ANOTHER account's retention. Or it may be reserved by
   * THIS account's own retention — which is not a refusal at all: reclaiming an address
   * you released is the ordinary remedy for a change you regret, and
   * `EmailDbOperation.changeEmail` deletes the reservation as part of the move.
   *
   * Both refusals use `EMAIL_ALREADY_REGISTERED`. A distinct "in retention" slug would
   * tell a caller that somebody recently changed away from that address, and the remedy
   * — pick another — is identical either way.
   */
  private async assertAddressAvailable(userId: string, emailLower: string): Promise<void> {
    if (await this.users.emailExists(emailLower)) {
      throw new ProblemException({
        type: ERR.EMAIL_ALREADY_REGISTERED,
        detail: 'That email address is not available.',
      });
    }

    const reserved = await this.emails.findLiveByEmail(emailLower);
    if (reserved !== null && reserved.userId !== userId) {
      throw new ProblemException({
        type: ERR.EMAIL_ALREADY_REGISTERED,
        detail: 'That email address is not available.',
      });
    }
  }

  /**
   * Which previous address, if any, must also authorise this change — and whether the
   * caller is allowed to proceed without it.
   *
   * ─── The invariant, asserted rather than assumed ───────────────────────
   *
   * `EMAIL.RETENTION_DAYS` equals `CHANGE_BY_ACCOUNT`'s window, and each change retains
   * one address, so at most one previous address can be live here. Three
   * `ChallengePurpose` values depend on that. If the two numbers are ever changed apart,
   * this refuses to start rather than silently verifying fewer mailboxes than the policy
   * requires — a weakening nobody would notice, because the flow would still succeed.
   */
  private async resolveRetained(
    userId: string,
    input: Extract<EmailChangeRequest, { action: 'start' }>,
    account: EmailChangeAccount,
  ): Promise<{ record: RetainedEmail | null; requireCode: boolean; skipped: boolean }> {
    const live = await this.emails.listLiveForUser(userId);

    if (live.length > 1) {
      this.logger.error(
        { userId, count: live.length },
        'more live retained addresses than the ceremony can verify — check that ' +
          'EMAIL.RETENTION_DAYS still matches EMAIL_CHANGE.CHANGE_BY_ACCOUNT',
      );
      throw new ProblemException({
        type: ERR.EMAIL_CHANGE_SECURITY_REQUIRED,
        detail: EMAIL_CHANGE_UNAVAILABLE.TOO_MANY_RETAINED,
      });
    }

    const record = live[0] ?? null;
    if (record === null) return { record: null, requireCode: false, skipped: false };

    if (input.skipRetainedEmail !== true) {
      return { record, requireCode: true, skipped: false };
    }

    // The escape, and the one place it is granted. Refused for `password` and `none`
    // because on an account whose only proof is a password, an attacker holding that
    // password could otherwise shed the very record the real owner needs to recover.
    if (!canSkipRetained(input.method) || !methodAllowed(input.method, account)) {
      throw new ProblemException({
        type: ERR.EMAIL_CHANGE_SECURITY_REQUIRED,
        detail: EMAIL_CHANGE_UNAVAILABLE.RETAINED_UNREACHABLE,
      });
    }

    return { record, requireCode: false, skipped: true };
  }

  private async liveRetained(userId: string): Promise<RetainedEmail | null> {
    return (await this.emails.listLiveForUser(userId))[0] ?? null;
  }

  /** Is the declared tier one this account may use right now? Shares `methodAllowed`
   *  with the status render, so a tier the screen offered can never be one this
   *  refuses. */
  private assertMethodAllowed(method: EmailChangeMethod, account: EmailChangeAccount): void {
    if (!methodAllowed(method, account)) {
      throw new ProblemException({
        type: ERR.MFA_METHOD_UNAVAILABLE,
        detail: methodUnavailableReason(method),
      });
    }
  }

  private async readPending(userId: string): Promise<EmailChangeGrant | null> {
    return parseChangeGrant(await this.cache.get(KEYS.emailChange.pending(userId)));
  }

  /**
   * The in-flight change this caller is entitled to act on.
   *
   * ONE answer for every way it can be wrong — unknown, expired, another account's,
   * another login's, or a different id than the one on record. A caller holding a bad
   * challenge learns nothing about which, and the remedy is identical: start again.
   *
   * The id is compared with `safeEqual` via `pepperedHash`'s constant-time sibling. The
   * Redis key is the user id, so the id in the record is what actually identifies the
   * ceremony, and a timing side channel on it would be a way to enumerate one.
   */
  private async requirePending(
    principal: Principal,
    challengeId: string,
  ): Promise<EmailChangeGrant> {
    const grant = await this.readPending(principal.userId);
    const reason = refusalReason(grant, principal, challengeId);

    if (grant === null || reason !== null) {
      // The REASON goes in the log and never in the response. Folding the five cases
      // into one answer is a property the caller must see; it is not a property the
      // operator benefits from, and `found: true` alone cannot distinguish a stale
      // challenge id from a ceremony bound to a login that has since been replaced —
      // which are the same 403 and completely different mistakes.
      this.logger.warn(
        { userId: principal.userId, found: grant !== null, reason },
        'email change challenge refused',
      );
      throw new ProblemException({
        type: ERR.EMAIL_CHANGE_CHALLENGE_INVALID,
        detail: 'Start the email change again.',
      });
    }

    return grant;
  }

  /**
   * The retention record a recovery ticket names.
   *
   * ONE answer for unknown, expired, already spent, and malformed — and the reason to
   * fold them is sharper here than anywhere else in this file: this path is reachable
   * WITHOUT a session, so a caller able to tell "expired" from "no such ticket" would
   * have an oracle for which addresses have recently been changed away from.
   *
   * The ticket is looked up by its hash rather than compared after a fetch, so an
   * attacker cannot use response timing to learn whether an id exists.
   */
  private async resolveTicket(recoveryId: string): Promise<RetainedEmail> {
    const record = await this.emails.findByRecoveryTokenHash(
      pepperedHash(recoveryId, 'email-recovery'),
    );

    if (
      record === null ||
      record.recoveryConsumedAt !== null ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new ProblemException({
        type: ERR.EMAIL_RECOVERY_INVALID,
        detail: 'That recovery link is no longer valid.',
      });
    }

    return record;
  }

  /** `now + EMAIL.RETENTION_DAYS`, in one place so the change and the recovery cannot
   *  disagree about how long an address is held. */
  private retentionDeadline(): Date {
    return secondsFromNow(EMAIL.RETENTION_DAYS * 24 * 60 * 60);
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (user === null || user.status !== 'ACTIVE') {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
    return user;
  }

  // ─── outbound mail ──────────────────────────────────────────────────────

  /**
   * Issue one code and mail it, metered on the DESTINATION.
   *
   * ─── The recipient budget is the whole reason this is not `requestCredentialOtp` ──
   *
   * Every other post-account budget in this service keys on `user.emailLower`, because
   * until now the account's address and the message's destination were the same value.
   * Here the caller names the destination. An account-keyed budget would meter how often
   * THIS account sends and say nothing about how much mail one stranger's inbox receives
   * — which is exactly the hole `REGISTRATION.OTP_MAIL_BY_RECIPIENT` was written to
   * close for signup, and this is the same defence.
   *
   * Charged optimistically and refunded if the message is finally undeliverable, via the
   * `quota.refund` descriptor that travels WITH the message on the durable queue. The
   * token-carrying form is what makes a duplicated refund safe.
   */
  private async sendCode(
    user: User,
    grant: EmailChangeGrant,
    target: EmailProofTarget,
    ipAddress: string,
  ): Promise<void> {
    const recipient =
      target === 'current'
        ? { email: user.email, lower: user.emailLower }
        : target === 'new'
          ? { email: grant.newEmail, lower: grant.newEmailLower }
          : { email: grant.retainedEmailLower ?? '', lower: grant.retainedEmailLower ?? '' };

    await this.issueAndMail(
      user.id,
      target,
      recipient.email,
      recipient.lower,
      ipAddress,
      // Off the `User` this method was handed — no extra query on the change path.
      antiPhishingCodeOf(user),
    );
  }

  /**
   * The recovery twin of `sendCode`, for a caller holding a released address rather
   * than a session.
   *
   * ─── Why this one accepts an extra query ────────────────────────────────────
   *
   * It has a `RetainedEmail`, not a `User`, so unlike every other mail path in this
   * codebase the anti-phishing code is not already in hand. The rule is "no extra query
   * per email", and this is the deliberate exception: recovery is a rare, high-stakes
   * flow — a handful of requests rather than a per-sign-in path — and this is the code
   * that lets somebody back into an account that may have been taken. A message asking
   * a victim to trust it is the last one that should be missing the mark of
   * authenticity.
   *
   * `findById` is one indexed read by primary key, and a null row means the account is
   * gone, which the caller's own checks already answer.
   */
  private async sendRecoveryCode(
    record: RetainedEmail,
    target: EmailProofTarget,
    addressLower: string,
    ipAddress: string,
  ): Promise<void> {
    const display = target === 'retained' ? record.email : addressLower;
    const user = await this.users.findById(record.userId);
    await this.issueAndMail(
      record.userId,
      target,
      display,
      addressLower,
      ipAddress,
      user === null ? null : antiPhishingCodeOf(user),
    );
  }

  private async issueAndMail(
    userId: string,
    target: EmailProofTarget,
    displayAddress: string,
    addressLower: string,
    ipAddress: string,
    antiPhishingCode: string | null,
  ): Promise<void> {
    const charge = await this.quota.consumeAll(
      quotaSet(
        policy().EMAIL_CHANGE.OTP_MAIL_BY_RECIPIENT,
        KEYS.rate.emailChangeOtpMail(addressLower),
        KEYS.rate.emailChangeOtpMailDaily(addressLower),
      ),
      'durable',
      'deny',
    );

    const code = generateOtp();
    const expiresAt = secondsFromNow(OTP.TTL_SECONDS);
    const codeHash = pepperedHash(code, 'otp');

    const challenge = await this.challenges.issue({
      userId,
      purpose: PURPOSE_BY_TARGET[target],
      codeHash,
      expiresAt,
      ipAddress,
      // The account's own address needs no binding — there is one candidate. The other
      // two do, and it is what stops one of their codes standing in for the other.
      targetEmailLower: target === 'current' ? undefined : addressLower,
    });

    try {
      await this.mail.sendOtp(
        displayAddress,
        code,
        expiresAt,
        [
          {
            kind: 'quota.refund',
            token: charge.token,
            keys: charge.keys,
            store: 'durable',
          },
        ],
        // Note what this means on the `new` target: the code goes to an address the
        // account does not hold yet, so the footer proves to that inbox that the
        // request came from us. That is the right direction — the recipient is the
        // person performing the change, and they are the one being asked to act.
        antiPhishingCode,
      );
    } catch (error) {
      // The enqueue failed, so the message does not exist. Retire the code — leaving it
      // live would mean a challenge the user can never satisfy — and hand the budget
      // back.
      await this.challenges.invalidateIfHash(challenge.id, codeHash);
      await this.quota.refund(charge, 'durable');
      throw error;
    }
  }

  /**
   * The "did you do this?" message, and the one piece of mail here that is awaited.
   *
   * It carries the recovery ticket, so it is not a notification: it is the mechanism by
   * which somebody whose account was taken over gets it back. An enqueue failure has to
   * be visible.
   *
   * But it must NOT fail the request. The change has already committed, and reporting
   * failure would tell a user their address is unchanged when it is not. So the failure
   * is logged at `error` — loudly, because the consequence is a user with no route back
   * for this change — and the caller returns success.
   */
  private async notifyChange(
    releasedEmail: string,
    newEmail: string,
    recoveryToken: string,
    ipClass: string,
    /**
     * ═══ WHY THE RECOVERY MAIL CARRIES THE CODE ═══════════════════════════════
     *
     * This is the strongest case for the whole feature. The message goes to the address
     * the account just LEFT and carries the single-use recovery ticket — so in a
     * takeover it lands in the victim's own mailbox and is their route back.
     *
     * A victim who has been taught to check for their code will check for it here, of
     * all places, because the message is asking them to click a link about their
     * account being compromised. An unstamped one would read as the phishing attempt
     * the reader is already primed to suspect.
     *
     * Which is exactly why `AntiPhishingService.assertChangeAllowed` applies the
     * post-email-change freeze: without it, an attacker who moved the address could
     * also change the code, and the owner would see an unfamiliar one on this very
     * message.
     */
    antiPhishingCode: string | null,
  ): Promise<void> {
    const url = `${config.WEB_APP_URL}/settings/email/recover?token=${encodeURIComponent(recoveryToken)}`;

    try {
      await this.mail.sendEmailChanged(
        releasedEmail,
        maskEmail(newEmail),
        url,
        ipClass,
        antiPhishingCode,
      );
    } catch (err) {
      this.logger.error(
        { err },
        'email-change recovery notification could not be queued — the address was still ' +
          'changed, and this account now has no self-service route back',
      );
    }

    this.mail.sendEmailAdded(newEmail, ipClass, antiPhishingCode);
  }
}

/**
 * Which of the binding checks refused a pending change — for the LOG only.
 *
 * The order is the one `requirePending` used when these were a single boolean chain,
 * and it is load-bearing rather than cosmetic: `safeEqual` stays last, so a caller
 * who fails an earlier check never reaches the constant-time comparison and cannot
 * time it. Returning a reason changes what is written to the log and nothing about
 * what is returned, which is the same 403 for every case here.
 */
function refusalReason(
  grant: EmailChangeGrant | null,
  principal: Principal,
  challengeId: string,
): string | null {
  if (grant === null) return 'no-pending-change';
  if (grant.userId !== principal.userId) return 'different-account';
  // The ceremony is bound to the login that started it, so signing in again — or
  // having every session swept — abandons a change in flight. Deliberate, and the
  // single most confusing of these to meet without a reason in the log.
  if (grant.familyId !== principal.familyId) return 'different-login';
  if (!safeEqual(grant.challengeId, challengeId)) return 'different-challenge';
  return null;
}

