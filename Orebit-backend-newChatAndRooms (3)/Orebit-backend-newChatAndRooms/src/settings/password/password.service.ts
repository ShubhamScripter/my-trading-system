import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { policy } from '../../../auth/limits';
import type { Principal } from '../../../auth/auth.types';
import { REVOKE_REASON } from '../../../auth/auth.types';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { CredentialService } from '../../../auth/services/credential.service';
import { RecentSecurityChangePolicy } from '../../../auth/services/recent-security-change.policy';
import { SessionService } from '../../../auth/services/session.service';
import { CacheService, KEYS } from '../../../redis';
import { MfaService } from '../../2fa/mfa.service';
import { TwoFactorService } from '../../2fa/2fa.service';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { MailService } from '../../mail/mail.service';
import { antiPhishingCodeOf } from '../antiPhishing/antiPhishing.utility';
import { SecurityRestrictionService } from '../../restrictions/restrictions.service';
import type {
  RequestFacts,
  RestrictionPlan,
  SecurityContext,
} from '../../restrictions/restrictions.types';
import type {
  PasswordForgotRequest,
  PasswordResetRequest,
  PasswordSetRequest,
} from './password.dto';
import {
  PASSWORD_UNAVAILABLE,
  type PasswordAccount,
  type PasswordFactorMethod,
  type PasswordOperation,
  type PasswordStatus,
} from './password.types';
import {
  factorAvailable,
  factorRequirementFor,
  factorUnavailableReason,
  resolveFactorProof,
  statusFor,
} from './password.utility';

/**
 * ═══ THE ACCOUNT PASSWORD, AS A SETTING ITS OWNER CONTROLS ══════════════════
 *
 * Three operations over one credential: create it, replace it knowing the current
 * one, replace it without. See `password.types.ts` for the policy table and for why
 * the split is by what the caller can prove rather than by what the account has.
 *
 * ─── The shape of the API ───────────────────────────────────────────────────
 *
 *     GET  status  →  POST { action }
 *
 * Two endpoints, not six. The status call is the only place a client learns what is
 * possible — including whether `forgot` will demand a factor — and the action call
 * does the work. There is no verify-then-act challenge as the Payment PIN has,
 * because there is no second operation for a proof to be bound to: every proof here
 * authorises exactly one write, in the same request, so a challenge would add a
 * round trip and a cache record without narrowing anything.
 *
 * ─── Where each proof is checked, and why the order never varies ────────────
 *
 * Every operation runs the same sequence, and it is the sequence
 * `PaymentPinService` documents:
 *
 *   meter → freeze → load state → eligibility → factor requirement →
 *   password policy → consume the emailed code → prove the factor →
 *   hash → write → sweep → notify
 *
 * Metering is FIRST and charged on entry, because a caller hammering this must be
 * refused before it costs an argon2 hash and two database reads. The freeze, the
 * eligibility check and the factor requirement all come BEFORE anything is consumed,
 * because a refusal the server could have issued for free must not first cost the
 * user their emailed code — the slot `assertMethodAvailable` occupies next door.
 * The password policy is checked in that same free region, so a weak password does
 * not burn a code and force another email.
 *
 * The emailed code is consumed BEFORE the factor proof, and that ordering is
 * deliberate and repo-wide: `reauthVerify`, `PaymentPinService.verify` and both
 * factor-disable paths do the same. It means a caller cannot use a wrong emailed code
 * to probe whether a TOTP guess was right, and an abandoned request has still spent
 * the code. It also means a WRONG factor burns a good code, which is the accepted
 * cost of that property.
 *
 * The mail goes last and unawaited, because the password has already changed and a
 * dead SMTP host must not report a successful change as failed.
 *
 * ─── What this service does NOT do ─────────────────────────────────────────
 *
 * It does not implement OTP, TOTP, WebAuthn, hashing, the password policy, rate
 * limiting, the session sweep, or the security freeze. Every one is called. This file
 * is policy, and the moment it grows a crypto import that is the signal it has taken
 * on something belonging to a mechanism.
 */
@Injectable()
export class PasswordSettingsService {
  private readonly logger = new Logger('PasswordSettings');

  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly mfa: MfaService,
    private readonly credentials: CredentialService,
    private readonly users: UserDbOperation,
    private readonly sessions: SessionService,
    private readonly cache: CacheService,
    private readonly mail: MailService,
    /** The security cooldown after an email change. Asked by all three operations —
     *  the existing policy names the password explicitly. See `assertNotFrozen`. */
    private readonly securityChanges: RecentSecurityChangePolicy,
    /** The security consequence. All three operations are the one trigger action
     *  `password.change` — see `restrictionFor`. */
    private readonly restrictions: SecurityRestrictionService,
  ) {}

  // ─── read ───────────────────────────────────────────────────────────────

  /**
   * The account's password state, read once.
   *
   * ONE place that decides what each operation requires, so the status screen and
   * the pre-consumption checks cannot answer differently — they share `statusFor`
   * and `factorRequirementFor`.
   *
   * Nothing here leaks: every value describes the caller's own account, and reaching
   * it needs that account's session.
   */
  async status(userId: string): Promise<PasswordStatus> {
    return statusFor(await this.account(userId));
  }

  /**
   * The account facts every policy question is a function of.
   *
   * Two reads, in parallel. `findWithCredential` is the authority on whether a
   * password exists — the presence of a live `PASSWORD` credential row and nothing
   * else — and `MfaService.availableMethods` is the authority on factors, CONFIRMED
   * only, so an abandoned enrollment never demands a proof the user cannot produce.
   *
   * This is the ONLY function in the feature that answers "does this account have a
   * password / a factor", and no request field reaches it. That is what makes the
   * frontend structurally unable to claim otherwise.
   */
  private async account(userId: string): Promise<PasswordAccount> {
    const [found, methods] = await Promise.all([
      this.users.findWithCredential(userId),
      this.mfa.availableMethods(userId),
    ]);

    return {
      passwordSet: found?.credential != null,
      passkeyEnabled: methods.includes('passkey'),
      totpEnrolled: methods.includes('totp'),
    };
  }

  // ─── set ────────────────────────────────────────────────────────────────

  /**
   * Create the account's first password: an emailed code, and a password worth
   * storing.
   *
   * ─── Why no second proof, and what bounds that ─────────────────────────────
   *
   * The product rule is "no existing password + Email OTP + new password", and the
   * bound on the consequence is that this operation CREATES a credential where there
   * was none. There is no existing secret to overwrite, and a caller who could reach
   * it already holds a session and the mailbox. The identical argument, and the
   * identical bound, as `PaymentPinService.enable`.
   *
   * Note what is NOT asked and deliberately so: no factor proof, even on an account
   * that has a passkey. Such an account is reachable — registration lets a user skip
   * the password, and a provider-created account never had one — and demanding a
   * factor here would be demanding a proof to create the credential rather than to
   * replace one. `forgot` is where the factor requirement lives, because that is the
   * operation that overwrites.
   *
   * ─── The precondition is enforced TWICE, and the second one is the real one ─
   *
   * `assertNoPassword` gives an honest, cheap refusal. `createPasswordIfAbsent` is
   * the arbiter: there are hundreds of milliseconds of argon2 between the two, which
   * is ample for a concurrent `set` to land, and the unique index cannot be raced.
   * Two simultaneous requests therefore produce one password and one
   * `password_already_set` — never two credentials, and never a silent overwrite.
   */
  async set(principal: Principal, facts: RequestFacts, input: PasswordSetRequest): Promise<void> {
    const account = await this.begin(principal.userId);

    if (account.passwordSet) {
      throw new ProblemException({
        type: ERR.PASSWORD_ALREADY_SET,
        detail: `${PASSWORD_UNAVAILABLE.ALREADY_SET} Use action 'reset' if you know it, or 'forgot' if you do not.`,
      });
    }

    await this.assertPolicy(principal.userId, input.password);

    // Everything above was free to the user; from here their emailed code is spent.
    await this.twoFactor.consumeCredentialOtp(principal.userId, input.emailCode);

    const hash = await this.credentials.hash(input.password);

    if (
      !(await this.users.createPasswordIfAbsent(
        principal.userId,
        hash,
        await this.restrictionFor(principal, facts),
      ))
    ) {
      // Lost the race, or the cheap check went stale. The honest answer is the one
      // the caller would have received a moment earlier, and nothing was written.
      throw new ProblemException({
        type: ERR.PASSWORD_ALREADY_SET,
        detail: PASSWORD_UNAVAILABLE.ALREADY_SET,
      });
    }

    await this.finish(principal, 'set', null, facts, 'password set');
  }

  // ─── reset ──────────────────────────────────────────────────────────────

  /**
   * Replace a password the caller can prove they know.
   *
   * ─── Both proofs, and why that is not a change of policy ───────────────────
   *
   * The current password AND the emailed code. `auth/dto/password.dto.ts` argues that
   * `change` must not accept a code, and it is right — but the argument is against
   * accepting a code INSTEAD OF the password, which would make the mailbox the only
   * thing that matters. Demanding both is strictly stronger than demanding the
   * password alone, so it does not reopen anything that argument closed.
   *
   * ─── Ordering: the code is spent before the password is checked ────────────
   *
   * Which means a wrong password burns a good code. That is the repo's convention
   * (`PaymentPinService.verify` consumes the code before `proveMethod`, whose `pin`
   * branch is the exact analogue) and the property it buys is worth the cost: a
   * caller holding no valid code cannot use this endpoint to probe passwords at all,
   * so the durable lockout ladder is not the only thing standing between a stolen
   * access token and a locked-out account.
   *
   * `checkPassword` maintains that ladder — `Credential.failedAttempts`,
   * `lockedUntil` and the escalating strikes — and throws `account_locked` on a
   * locked credential. A session is not a reason to exempt a password guess from the
   * counter that bounds guessing.
   */
  async reset(principal: Principal, facts: RequestFacts, input: PasswordResetRequest): Promise<void> {
    const account = await this.begin(principal.userId);
    this.assertPasswordSet(account);

    await this.assertPolicy(principal.userId, input.password);

    // Cheap, and before anything is consumed: a "change" that changes nothing must
    // not cost the user their emailed code. Compared as plaintext because both
    // values are in hand — no hash, no timing question, since a caller who supplied
    // `currentPassword` already knows it.
    if (input.password === input.currentPassword) {
      throw new ProblemException({
        type: ERR.PASSWORD_REUSED,
        detail: 'The new password must be different from your current one.',
      });
    }

    await this.twoFactor.consumeCredentialOtp(principal.userId, input.emailCode);

    // Re-read rather than reusing the snapshot: `account()` deliberately returns
    // booleans, and the lockout columns this needs are on the row itself.
    const found = await this.users.findWithCredential(principal.userId);
    if (found === null || found.credential === null) {
      // A concurrent removal, or the snapshot went stale. Same answer as the cheap
      // check above.
      throw new ProblemException({
        type: ERR.PASSWORD_NOT_SET,
        detail: PASSWORD_UNAVAILABLE.NOT_SET,
      });
    }

    if (!(await this.credentials.checkPassword(found.credential, input.currentPassword))) {
      // Nothing about how close the guess was, and nothing distinguishing this from
      // any other wrong credential — the same flat answer `PasswordService.change`
      // gives.
      throw new ProblemException({ type: ERR.INVALID_CREDENTIALS });
    }

    await this.write(principal.userId, input.password, await this.restrictionFor(principal, facts));
    await this.finish(principal, 'reset', null, facts, 'password changed');
  }

  // ─── forgot ─────────────────────────────────────────────────────────────

  /**
   * Replace a password the caller cannot supply, against the account's own factor.
   *
   * ═══ THE FACTOR REQUIREMENT IS THE WHOLE POINT OF THIS OPERATION ═══════════
   *
   * Without it this would be `set` on an account that already has a password —
   * anyone holding a session and the mailbox could replace the credential of an
   * account whose owner deliberately enrolled a second factor. That is the exact
   * downgrade `MfaService` exists to prevent, and it is why `forgot` is a separate
   * operation rather than a widening of `set`.
   *
   * ─── The four factor states, all four handled by one branch ────────────────
   *
   *   no factor            `requirement.required` is false. The emailed code is
   *                        sufficient, and a body carrying a proof is refused rather
   *                        than ignored — see `assertNoUnusableProof`.
   *   passkey only         a passkey assertion. `totpCode` is refused as
   *                        `mfa_method_unavailable`.
   *   authenticator only   a TOTP code. `passkey` is refused the same way.
   *   both                 EITHER, and the caller names which. Not "send both and
   *                        the server picks" — the DTO refuses two proofs, so the
   *                        weaker cannot silently become the only one that matters.
   *
   * All four fall out of `factorRequirementFor` plus `factorAvailable`, which are the
   * same functions the status render uses. There is no fifth path and no default.
   */
  async forgot(
    principal: Principal,
    facts: RequestFacts,
    input: PasswordForgotRequest,
  ): Promise<{ readonly factorVerified: PasswordFactorMethod | null }> {
    const account = await this.begin(principal.userId);
    this.assertPasswordSet(account);

    // The same pure resolver the DTO ran. Repeated because a policy that holds only
    // when the HTTP layer is in front of it is not the policy.
    const resolved = resolveFactorProof(input);
    if (!resolved.ok) {
      throw new ProblemException({ type: ERR.VALIDATION_FAILED, errors: resolved.problems });
    }

    const requirement = factorRequirementFor(account);
    const named = resolved.method;

    if (requirement.required && named === null) {
      throw new ProblemException({
        type: ERR.PASSWORD_FACTOR_REQUIRED,
        detail: PASSWORD_UNAVAILABLE.FACTOR_REQUIRED,
        // Which factors WOULD be accepted, so a client renders the right prompt
        // without a second call and without deciding the rule itself. The caller's
        // own account, behind their own session — no enumeration surface.
        extra: { methods: requirement.methods },
      });
    }

    if (named !== null) this.assertNoUnusableProof(named, account, requirement.required);

    await this.assertPolicy(principal.userId, input.password);

    await this.twoFactor.consumeCredentialOtp(principal.userId, input.emailCode);

    // Only after the code, and only when one is required. An account with no factor
    // reaches the write with the emailed code as its sole authorisation, which is the
    // documented product rule for that case.
    if (named !== null) await this.proveFactor(principal.userId, named, input);

    await this.write(principal.userId, input.password, await this.restrictionFor(principal, facts));
    await this.finish(principal, 'forgot', named, facts, 'password reset');

    // Which credential was actually spent, so the response and the audit trail do
    // not have to re-derive it from a request that no longer exists. `null` is the
    // no-factor account, reported as a fact rather than as an omission.
    return { factorVerified: named };
  }

  /**
   * Run exactly the named factor's proof, and refuse on a wrong credential.
   *
   * A switch on the resolved method rather than on which fields are present, so
   * adding a factor is a compile error here until it is handled — the `never` default
   * is what makes that true. No fallback and no first-match: `proveEnrolledFactor`
   * is the permissive either-or, and using it here would collapse two named
   * alternatives into one OR whose weaker half is the only one that matters.
   */
  private async proveFactor(
    userId: string,
    method: PasswordFactorMethod,
    input: PasswordForgotRequest,
  ): Promise<void> {
    switch (method) {
      case 'passkey': {
        if (
          !(await this.twoFactor.provePasskeyAssertion(
            userId,
            // The schema keeps the WebAuthn response `passthrough`, so its inferred
            // type is the one field it bounds rather than the library's. The same
            // cast as `PaymentPinService.proveMethod`, for its reason: the library
            // owns the shape and verifies every field cryptographically.
            input.passkey as unknown as AuthenticationResponseJSON,
          ))
        ) {
          throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
        }
        return;
      }

      case 'authenticator': {
        // Claims the RFC 6238 step, so a code shoulder-surfed inside its 30-second
        // window cannot be replayed into a second password reset. That is
        // `proveTotpCode`'s job and the reason it is called rather than `verifyCode`.
        if (!(await this.twoFactor.proveTotpCode(userId, input.totpCode as string))) {
          throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
        }
        return;
      }

      default: {
        const exhaustive: never = method;
        return exhaustive;
      }
    }
  }

  // ─── the shared spine ───────────────────────────────────────────────────

  /**
   * Meter, unfreeze-check, and read the account. The first three lines of all three
   * operations, in one place so their order cannot drift.
   *
   * ─── Charged on ENTRY, and `deny` on a cache failure ──────────────────────
   *
   * Entry, because a caller who abandons the request mid-flight has still cost an
   * argon2 hash and two reads. `deny` because there is no durable backstop behind
   * this bucket on the `set` and `forgot` paths — `Credential.failedAttempts` only
   * counts wrong passwords, which neither of them presents — so it is the only bound.
   *
   * ONE bucket for all three operations; see `policy().PASSWORD.UPDATE_BY_ACCOUNT`
   * for why a per-action key would triple the ceiling while the number still read ten.
   */
  private async begin(userId: string): Promise<PasswordAccount> {
    await this.cache.consume(
      KEYS.rate.passwordUpdateByAccount(userId),
      policy().PASSWORD.UPDATE_BY_ACCOUNT,
      'deny',
    );

    await this.assertNotFrozen(userId);

    return this.account(userId);
  }

  /**
   * Refuse while the account is inside the post-email-change freeze.
   *
   * ─── This applies to `forgot` too, and that is the existing policy ────────
   *
   * `RecentSecurityChangePolicy` names the password among the four surfaces it
   * freezes, without exempting any password flow — and `forgot` is the one the freeze
   * matters most on. It is the path that needs no knowledge of the current password,
   * so it is exactly the path an attacker who has just moved the address would take.
   *
   * The exemption that policy DOES define is for the email RECOVERY flow, and it is
   * not extended here: `EmailChangeService.recoverStart` is how someone whose address
   * was moved without their consent gets back in, and it deliberately does not depend
   * on the password.
   *
   * A second, row-locked check runs inside the write's own transaction — see
   * `UserDbOperation.createPasswordIfAbsent`. This one is for an honest, cheap
   * refusal before any code is spent; that one closes the window an argon2 hash opens.
   */
  private async assertNotFrozen(userId: string): Promise<void> {
    await this.securityChanges.assertNoRecentEmailChange(userId);
  }

  /** Both replacing operations need a password to replace. Checked before anything is
   *  consumed, and re-checked by the write itself. */
  private assertPasswordSet(account: PasswordAccount): void {
    if (!account.passwordSet) {
      throw new ProblemException({
        type: ERR.PASSWORD_NOT_SET,
        detail: `${PASSWORD_UNAVAILABLE.NOT_SET} Use action 'set' instead.`,
      });
    }
  }

  /**
   * A proof the account cannot use, or one it does not need.
   *
   * Two refusals, both BEFORE the emailed code is consumed:
   *
   *   A factor the account has NOT set up — `mfa_method_unavailable`, the same slug
   *   `assertMethodAvailable` uses next door. The server's knowledge, not the
   *   caller's mistake, so discovering it by spending a code would charge a user for
   *   asking a reasonable question.
   *
   *   A factor on an account that needs none — refused rather than ignored. Not
   *   tidiness: verifying it would spend a live TOTP step or a WebAuthn challenge
   *   the user may be part-way through using elsewhere, and silently dropping it
   *   would let a client believe a proof was checked when nothing looked at it. The
   *   same argument `resolveDisablePath` makes about an `emailCode` on the
   *   `backup-code` path.
   */
  private assertNoUnusableProof(
    method: PasswordFactorMethod,
    account: PasswordAccount,
    required: boolean,
  ): void {
    if (!required) {
      throw new ProblemException({
        type: ERR.MFA_METHOD_UNAVAILABLE,
        detail:
          'This account has no additional verification enabled, ' +
          'so no passkey or authenticator proof is accepted here.',
      });
    }

    if (!factorAvailable(method, account)) {
      throw new ProblemException({
        type: ERR.MFA_METHOD_UNAVAILABLE,
        detail: factorUnavailableReason(method),
      });
    }
  }

  /**
   * The account-relative password rules.
   *
   * `passwordSchema` has already checked length and character classes at the DTO.
   * This is `CredentialService.assertPolicy`, which needs the account's email and
   * username and therefore cannot live in a field schema — `alice@example.com` with
   * `alice12345` passes every class rule and is among the first things anyone tries
   * against that address.
   *
   * Run in the free region, before any code is consumed and before argon2, so a weak
   * password costs nothing but a round trip.
   */
  private async assertPolicy(userId: string, password: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (user === null || user.status !== 'ACTIVE') {
      // A token can outlive a soft-deleted or disabled account. Do not turn a stale
      // token into a 500, and do not disclose which of the two happened — the same
      // answer `PasswordService.requireUser` gives.
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }

    this.credentials.assertPolicy(password, { email: user.email, username: user.username });
  }

  /**
   * Hash and replace, or refuse.
   *
   * The predicate is on the WRITE — `replacePassword` updates only a live `PASSWORD`
   * row and reports whether it matched — so a credential removed during the argon2
   * hash produces a refusal rather than a resurrection. `set` uses the mirror-image
   * write for the same reason, and neither goes through `upsertPassword`, which is
   * direction-blind.
   */
  /**
   * Resolve this request's security consequence, as a plain value.
   *
   * One helper for all three operations, because all three are the SAME trigger:
   * `password.change`. Set, reset and forgot differ in what they demand as proof and
   * in nothing the restriction engine cares about — a password that changed is a
   * password that changed.
   *
   * Called after every proof is spent and before the write, so a refused request pays
   * nothing and no query runs inside the mutation's own transaction, which already
   * holds a row lock on `identity.users`.
   */
  private async restrictionFor(
    principal: Principal,
    facts: RequestFacts,
  ): Promise<{ context: SecurityContext; plan: RestrictionPlan }> {
    const context = await this.restrictions.contextFrom(
      principal.userId,
      principal.sessionId,
      facts,
    );
    return { context, plan: await this.restrictions.planFor('password.change', context) };
  }

  private async write(
    userId: string,
    password: string,
    restriction: { context: SecurityContext; plan: RestrictionPlan },
  ): Promise<void> {
    const hash = await this.credentials.hash(password);

    if (!(await this.users.replacePassword(userId, hash, restriction))) {
      throw new ProblemException({
        type: ERR.PASSWORD_NOT_SET,
        detail: PASSWORD_UNAVAILABLE.NOT_SET,
      });
    }
  }

  /**
   * Sweep the other sessions, notify the owner, log the event.
   *
   * ─── Why all three operations sweep ────────────────────────────────────────
   *
   * `PasswordService.commit` already does this for the flows it serves, and the
   * reason it gives is what makes a password change a usable response to a
   * compromise: the attacker is evicted, and if it was the attacker who changed it,
   * the owner finds out. Both halves are needed — a sweep with no mail is a silent
   * eviction, and mail with no sweep leaves the other party inside.
   *
   * That reasoning covers `set` as well, which is why it is not exempted. An account
   * that had no password may still have live sessions — an OAuth sign-in, an emailed
   * code — and creating the credential that will authenticate future ones is exactly
   * the moment to end the ones established before it.
   *
   * This is deliberately the opposite of `PaymentPinService.disable`, which does not
   * sweep. Its argument is precise and does not reach here: no session was ever
   * established with a Payment PIN, whereas a password is presented at sign-in and
   * sessions do derive from it.
   *
   * ─── The caller's own session is kept ──────────────────────────────────────
   *
   * `revokeAllForUserExcept`, not `revokeAll`. Signing someone out of the tab they
   * are standing in as a reward for good security hygiene is hostile, and it buys
   * nothing — that session is the one just authenticated.
   *
   * ─── Order: sweep BEFORE the notification, and after the write ─────────────
   *
   * `PasswordService.commit` revokes before it writes, on the argument that failing
   * after the write would leave a new password live alongside the sessions it was
   * meant to evict. That ordering is not available here and is not needed: the write
   * is the operation's own compare-and-swap, and it must be allowed to refuse — so
   * revoking first would sweep an account's sessions for a request that then changed
   * nothing. Sweeping immediately after keeps both properties, because a sweep is
   * idempotent and a failure here still leaves the new password in place with the
   * mail unsent, which is a state a retry resolves.
   */
  private async finish(
    principal: Principal,
    operation: PasswordOperation,
    factor: PasswordFactorMethod | null,
    facts: RequestFacts,
    what: string,
  ): Promise<void> {
    await this.sessions.revokeAllForUserExcept(
      principal.userId,
      principal.sessionId,
      REVOKE_REASON.PASSWORD_CHANGED,
    );

    // ─── The half of "other activity" a session sweep cannot see ──────────────
    //
    // A sweep ends sign-ins that FINISHED. A sign-in half-way through has no session
    // yet: it is a `FACTOR_REQUIRED` row holding a `loginId` with the MFA ceremony's
    // budget on it, and the second half of that ceremony never re-reads the password.
    // So a flow opened with the OLD password survived every one of these three
    // operations and stayed completable by whoever held its handle.
    //
    // Placed with the sweep, and after the write, for the reason the note above gives:
    // the write is this operation's compare-and-swap and must be allowed to refuse, so
    // nothing here may run for a request that changed nothing. Both are idempotent, so
    // a failure between them is resolved by a retry.
    await this.mfa.expireLiveAttemptsFor(principal.userId);

    // No password, no hash, no emailed code and no assertion in this line — here or
    // in any other logger call in this file. `src/logger.ts` redacts several of those
    // as a backstop; not putting them here is the defence.
    this.logger.warn(
      { userId: principal.userId, operation, factor, ipClass: facts.ipClass },
      `${what}; other sessions revoked`,
    );

    this.notify(principal.userId, what, facts.ipClass);
  }

  /**
   * Tell the owner something changed.
   *
   * After the write and fire-and-forget by `sendSecurityChanged`'s own contract: the
   * password has already changed, and a mail failure must not report the change as
   * failed and invite the user to do it again. A missing user row is possible only if
   * the account was deleted mid-request, and there is nobody left to notify.
   */
  private notify(userId: string, what: string, ipClass: string): void {
    void this.users
      .findById(userId)
      .then((user) => {
        if (user !== null) {
          // The anti-phishing code comes off the row this lookup already fetched, so
          // stamping the notification costs nothing extra.
          this.mail.sendSecurityChanged(user.email, what, ipClass, antiPhishingCodeOf(user));
        }
      })
      .catch((err: unknown) => {
        this.logger.error({ err, userId }, 'password notification lookup failed');
      });
  }
}
