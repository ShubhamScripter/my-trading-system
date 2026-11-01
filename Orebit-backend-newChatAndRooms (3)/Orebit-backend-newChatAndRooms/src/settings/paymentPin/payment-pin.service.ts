import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { policy } from '../../../auth/limits';
import type { Principal } from '../../../auth/auth.types';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { CredentialService } from '../../../auth/services/credential.service';
import { RecentSecurityChangePolicy } from '../../../auth/services/recent-security-change.policy';
import { SecurityRestrictionService } from '../../restrictions/restrictions.service';
import type { RequestFacts } from '../../restrictions/restrictions.types';
import { CacheService, KEYS, QuotaService } from '../../../redis';
import { MfaService } from '../../2fa/mfa.service';
import { TwoFactorService } from '../../2fa/2fa.service';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { MailService } from '../../mail/mail.service';
import { antiPhishingCodeOf } from '../antiPhishing/antiPhishing.utility';
import { PaymentPinDbOperation } from './payment-pin.dboperation';
import type { PaymentPinRequest, PaymentPinVerifyRequest } from './payment-pin.dto';
import {
  PAYMENT_PIN_UNAVAILABLE,
  type PaymentPinAccount,
  type PaymentPinGrant,
  type PaymentPinOperation,
  type PaymentPinStatus,
  type PaymentPinVerificationMethod,
} from './payment-pin.types';
import {
  assessPin,
  hasEnrolledFactor,
  methodAvailable,
  methodUnavailableReason,
  methodsFor,
  parseGrant,
  resolvePaymentPinProof,
  serialiseGrant,
} from './payment-pin.utility';

/**
 * ═══ THE PAYMENT PIN, AS A SETTING THE ACCOUNT'S OWNER CONTROLS ═════════════
 *
 * Three operations over one secret: create it, change it, remove it. See
 * `payment-pin.types.ts` for the policy tables and for why this is not a second
 * factor.
 *
 * ─── The shape of the API, and why it is three endpoints rather than eight ──
 *
 * `GET status → VERIFY when required → ACTION`. The status call is the only place a
 * client learns what is possible, the verify call converts a proof into a single-use
 * challenge, and the action call spends it. Enabling skips the middle step because
 * there is nothing to prove.
 *
 * Splitting each operation into start/complete pairs — the reflex — would publish six
 * endpoints describing three operations, and every one of them would need its own
 * statement of who may call it. Three endpoints means three, and the discriminants
 * (`action`, `method`) are what a reader follows instead of a route table.
 *
 * ─── Where each proof is checked, and why the order never varies ────────────
 *
 * Every operation runs the same sequence:
 *
 *   meter → resolve the request → check availability → consume the emailed code →
 *   prove the named credential → write → notify
 *
 * Metering is FIRST and charged on entry, because a caller hammering this must be
 * refused before it costs an argon2 hash or a database read. Availability is checked
 * BEFORE anything is consumed, because a method the account has not set up is the
 * server's knowledge and not the caller's mistake — discovering it by spending an
 * emailed code would charge a user for asking a reasonable question. The emailed code
 * is consumed BEFORE the second proof, so a wrong code cannot be used to probe whether
 * a PIN guess was right and an abandoned request has still cost the code. The mail goes
 * last and unawaited, because the setting has already changed and a mail failure must
 * not report the change as failed.
 *
 * That is the identical ordering `SettingsService.disableFactor` documents, and it is
 * identical on purpose: two security surfaces in one module that consume proofs in
 * different orders are two surfaces whose failure modes have to be reasoned about
 * separately.
 *
 * ─── What this service does NOT do ─────────────────────────────────────────
 *
 * It does not revoke sessions. See `disable`.
 *
 * It does not implement OTP, TOTP, WebAuthn, hashing, rate limiting or single-use
 * tokens. Every one of those is called: `TwoFactorService` for the three proofs,
 * `CredentialService` for argon2, `CacheService`/`QuotaService` for the budgets and the
 * challenge. This file is policy, and the moment it grows a crypto import that is the
 * signal it has taken on something belonging to a mechanism.
 */
@Injectable()
export class PaymentPinService {
  private readonly logger = new Logger('PaymentPin');

  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly mfa: MfaService,
    private readonly credentials: CredentialService,
    private readonly pins: PaymentPinDbOperation,
    private readonly users: UserDbOperation,
    private readonly cache: CacheService,
    private readonly quota: QuotaService,
    private readonly mail: MailService,
    /** The security cooldown after an email change — asked by all three operations,
     *  and by `verify`, so a frozen caller is told before spending a code rather than
     *  after minting a challenge they cannot spend. */
    private readonly securityChanges: RecentSecurityChangePolicy,
    /** The security consequence of a successful change. `update` and `disable` are two
     *  of the eight trigger actions; `enable` is deliberately not one — adding a factor
     *  strengthens an account and must not cost the user anything. */
    private readonly restrictions: SecurityRestrictionService,
  ) {}

  // ─── read ───────────────────────────────────────────────────────────────

  /**
   * The account's Payment PIN state, read once.
   *
   * One place that decides what "enabled" means and which methods are open, so the
   * status screen and the pre-consumption checks cannot answer it differently.
   * `MfaService.availableMethods` is the arbiter of what counts as a real factor —
   * CONFIRMED credentials only, so an abandoned enrollment does not make a user think
   * they can enable a PIN they would then be unable to change.
   */
  private async account(userId: string): Promise<PaymentPinAccount> {
    const [methods, pin] = await Promise.all([
      this.mfa.availableMethods(userId),
      this.pins.findByUserId(userId),
    ]);

    return {
      enabled: pin !== null,
      passkeyEnabled: methods.includes('passkey'),
      totpEnrolled: methods.includes('totp'),
    };
  }

  /**
   * What the Payment PIN setting screen renders.
   *
   * The client asks this one question and renders everything from the answer. It never
   * has to work out whether the account has an authenticator, whether a passkey exists,
   * or which combination makes an operation legal — those are policy, they are decided
   * here, and a client that re-derived them would be a second copy of this file in
   * TypeScript that nobody updates.
   *
   * Nothing here leaks: every value describes the caller's own account.
   */
  async status(userId: string): Promise<PaymentPinStatus> {
    const account = await this.account(userId);
    const methods = methodsFor(account);

    // Read WITHOUT charging. `QuotaService.used` is documented as being for metrics
    // rather than enforcement, which is exactly this: a number for a screen, where the
    // authoritative answer is still the refusal `consumeAll` produces. It never throws
    // — a cache failure reports zero used — so a Redis blip degrades this to an
    // optimistic count rather than failing the whole status render.
    const rule = policy().PAYMENT_PIN.UPDATE_BY_ACCOUNT;
    const used = await this.quota.used(
      KEYS.rate.paymentPinUpdateByAccount(userId),
      rule,
      'durable',
    );

    // Both operations need a PIN to act on and a way to authorise it. `methods` being
    // empty is only reachable when the PIN is off, since `pin` is available exactly
    // when it is on — but the condition is written out rather than assumed, because a
    // screen offering an operation with no method to perform it is the defect this
    // whole shape exists to prevent.
    const available = account.enabled && methods.length > 0;
    const reason = account.enabled ? undefined : PAYMENT_PIN_UNAVAILABLE.NOT_ENABLED;

    return {
      enabled: account.enabled,
      canEnable: !account.enabled && hasEnrolledFactor(account),
      canEnableReason: this.canEnableReason(account),
      update: {
        available,
        reason,
        methods: available ? methods : [],
        remaining: Math.max(0, rule.limit - used),
      },
      disable: {
        available,
        reason,
        methods: available ? methods : [],
      },
    };
  }

  /** Why enabling is closed, or `undefined` when it is open. The two causes are
   *  mutually exclusive and the order matters: an account that already has a PIN is
   *  told that, not told to set up a factor it may already have. */
  private canEnableReason(account: PaymentPinAccount): string | undefined {
    if (account.enabled) return PAYMENT_PIN_UNAVAILABLE.ALREADY_ENABLED;
    if (!hasEnrolledFactor(account)) return PAYMENT_PIN_UNAVAILABLE.NO_FACTOR;
    return undefined;
  }

  // ─── enable ─────────────────────────────────────────────────────────────

  /**
   * Turn the PIN on: an emailed code, an existing factor, and a PIN worth storing.
   *
   * ─── Why no factor proof, only factor EXISTENCE ────────────────────────────
   *
   * The product rule is "Email OTP + Passkey OR Authenticator already enrolled", and
   * the second half is a state check rather than a ceremony. That is weaker than
   * demanding a fresh proof, and the bound on the consequence is that enabling creates
   * a PIN where there was none: there is no existing secret to overwrite, and a caller
   * who could do this already holds a session and the mailbox.
   *
   * What the factor requirement actually buys is not authorisation but RECOVERABILITY.
   * Two of the three ways to change or remove a PIN are the two factors; an account
   * that set a PIN with neither would have exactly one — the PIN itself — and a user
   * who forgot it would be stranded with a secret they cannot change. The rule exists
   * to keep that state unreachable, which is why it is checked here and again nowhere
   * else: once a PIN exists, losing the factors is survivable because `pin` still works.
   *
   * ─── Why the PIN is assessed before the code is spent ──────────────────────
   *
   * So a weak PIN does not burn the user's emailed code and force another round trip.
   * The same seam `auth/security/challenge.ts` keeps open between verifying a code and
   * spending it, for the same reason it gives: password reset runs its policy check
   * between the two so a weak password does not cost the user their code.
   */
  async enable(
    userId: string,
    facts: RequestFacts,
    input: Extract<PaymentPinRequest, { action: 'enable' }>,
  ): Promise<void> {
    // On entry and `deny`: this bounds the attempts themselves, each of which costs an
    // argon2 hash. Entry rather than failure costs nothing in practice — a successful
    // enable turns the setting on, so there is no second successful call for the budget
    // to refuse.
    await this.cache.consume(
      KEYS.rate.paymentPinEnableByAccount(userId),
      policy().PAYMENT_PIN.ENABLE_BY_ACCOUNT,
      'deny',
    );

    // After the meter, before the emailed code is spent — the same slot
    // `assertMethodAvailable` occupies on the other operations, for its reason.
    await this.securityChanges.assertNoRecentEmailChange(userId);

    const account = await this.account(userId);

    if (account.enabled) {
      throw new ProblemException({
        type: ERR.PAYMENT_PIN_ALREADY_ENABLED,
        detail: PAYMENT_PIN_UNAVAILABLE.ALREADY_ENABLED,
      });
    }

    if (!hasEnrolledFactor(account)) {
      // `MFA_METHOD_UNAVAILABLE` rather than a payment-PIN slug: the caller is asking
      // for something that needs a factor this account has not set up, which is
      // precisely what that slug means, and `assertPathAvailable` next door answers the
      // same question with the same error.
      throw new ProblemException({
        type: ERR.MFA_METHOD_UNAVAILABLE,
        detail: PAYMENT_PIN_UNAVAILABLE.NO_FACTOR,
      });
    }

    this.assertPinAcceptable(input.pin);

    // Everything above is free to the user; from here their emailed code is spent.
    await this.twoFactor.consumeCredentialOtp(userId, input.emailCode);

    const pinHash = await this.credentials.hash(input.pin);
    await this.pins.create(userId, pinHash);

    // No pin and no hash in the line, here or in any other logger call in this file.
    // `src/logger.ts` redacts both as a backstop; not putting them here is the defence.
    this.logger.log({ userId }, 'payment PIN enabled');
    this.notify(userId, 'Payment PIN set', facts.ipClass);
  }

  // ─── verify ─────────────────────────────────────────────────────────────

  /**
   * Prove one named credential, and receive a single-use authorisation for one
   * operation.
   *
   * ─── Why exactly the declared method runs, and nothing else ────────────────
   *
   * `TwoFactorService.proveEnrolledFactor` tries a passkey, falls back to TOTP, and
   * accepts whichever answers. That is right for what it does — a ticket says a factor
   * was proved — and it would be wrong here for the reason `resolveDisablePath`
   * documents: "send everything and let the server sort it out" turns three separate
   * methods into a single OR, so the weakest one becomes the only one that matters, and
   * the caller cannot tell which credential was actually spent.
   *
   * So the client names one, the schema refuses any proof the named method does not
   * take, and the switch below runs that method and no other. There is no fallback and
   * no first-match.
   */
  async verify(
    principal: Principal,
    input: PaymentPinVerifyRequest,
  ): Promise<{ challengeId: string; expiresInSeconds: number; method: PaymentPinVerificationMethod }> {
    const { userId } = principal;

    // On entry, `deny`, and keyed on the ACCOUNT. This is the only bound on guesses
    // against the PIN itself — six digits, no durable backstop behind it — so it is
    // charged before the request is even resolved, and shared across all three methods
    // so a guesser cannot triple their budget by alternating. See
    // `PAYMENT_PIN.VERIFY_BY_ACCOUNT`.
    await this.cache.consume(
      KEYS.rate.paymentPinVerifyByAccount(userId),
      policy().PAYMENT_PIN.VERIFY_BY_ACCOUNT,
      'deny',
    );

    // Checked here as well as on the two actions, which is not a duplicate rule but an
    // earlier answer to it: this route costs the caller an emailed code and a
    // credential proof to mint a challenge, and a frozen account should learn that
    // before paying rather than at the action that cannot spend it.
    await this.securityChanges.assertNoRecentEmailChange(userId);

    // The same pure resolver the DTO ran. Repeated because a policy that holds only
    // when the HTTP layer is in front of it is not the policy.
    const resolved = resolvePaymentPinProof(input);
    if (!resolved.ok) {
      throw new ProblemException({ type: ERR.VALIDATION_FAILED, errors: resolved.problems });
    }
    const { method } = resolved;

    const account = await this.account(userId);
    this.assertOperable(account);
    this.assertMethodAvailable(method, account);

    // Always, and always before the credential proof.
    await this.twoFactor.consumeCredentialOtp(userId, input.emailCode);

    await this.proveMethod(userId, input);

    const challengeId = randomBytes(32).toString('base64url');
    const grant: PaymentPinGrant = {
      userId,
      // The rotation FAMILY, not the session — see `KEYS.paymentPin.challenge`.
      familyId: principal.familyId,
      operation: input.operation,
      method,
    };

    // `cache.set` throws on a Redis failure rather than degrading, and the guard is let
    // through: a challenge we could not store is one that can never be spent, so
    // returning its id would hand the caller a credential guaranteed to be refused a
    // moment later. The same fail-closed direction `ElevationService.issue` takes.
    await this.cache.set(
      KEYS.paymentPin.challenge(challengeId),
      serialiseGrant(grant),
      policy().PAYMENT_PIN.CHALLENGE_TTL_SECONDS,
    );

    this.logger.log(
      { userId, operation: input.operation, method },
      'payment PIN verification succeeded',
    );

    return {
      challengeId,
      expiresInSeconds: policy().PAYMENT_PIN.CHALLENGE_TTL_SECONDS,
      method,
    };
  }

  /**
   * Run exactly the named method's proof, and refuse on a wrong credential.
   *
   * The switch is on the DISCRIMINANT rather than on which fields are present, so
   * adding a method is a compile error here until it is handled — the `never` default
   * is what makes that true.
   */
  private async proveMethod(userId: string, input: PaymentPinVerifyRequest): Promise<void> {
    switch (input.method) {
      case 'pin': {
        const pin = await this.requirePin(userId);
        // argon2's own verify: constant-time by construction, and false rather than a
        // throw for a wrong value, so a malformed row cannot be probed by watching for
        // a 500.
        if (!(await this.credentials.verify(pin.pinHash, input.currentPin))) {
          throw new ProblemException({ type: ERR.PAYMENT_PIN_INVALID });
        }
        return;
      }

      case 'authenticator': {
        // Claims the RFC 6238 step, so a code shoulder-surfed inside its 30-second
        // window cannot be replayed into a second challenge. That is `proveTotpCode`'s
        // job and the reason it is called rather than `verifyCode` directly.
        if (!(await this.twoFactor.proveTotpCode(userId, input.totpCode))) {
          throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
        }
        return;
      }

      case 'passkey': {
        if (
          !(await this.twoFactor.provePasskeyAssertion(
            userId,
            // The schema keeps the WebAuthn response `passthrough`, so its inferred
            // type is the one field it bounds rather than the library's. Same cast as
            // `disableBiometrics`, for the same reason: the library owns the shape and
            // verifies every field cryptographically.
            input.passkey as unknown as AuthenticationResponseJSON,
          ))
        ) {
          throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
        }
        return;
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  // ─── update ─────────────────────────────────────────────────────────────

  /**
   * Change the PIN, given a challenge verified for `update`.
   *
   * ─── Why the budget is charged LAST, unlike every other quota here ─────────
   *
   * `enable` and `verify` meter on entry, and `SettingsService.disableFactor` does too.
   * This one does not, and the difference is what the quota is for. Those are
   * anti-guessing bounds: they must be paid before the work they bound, or a caller
   * gets the work for free by abandoning the request. This one is a PRODUCT FREQUENCY
   * CAP — "three PIN changes a day" — and guessing is already bounded upstream by
   * `PAYMENT_PIN.VERIFY_BY_ACCOUNT`, which is charged on entry and is what a caller
   * must get past to hold a challenge at all.
   *
   * So the only question left is what a refusal should cost, and the two orderings
   * trade differently:
   *
   *   Charging FIRST protects the challenge — a rate-limited caller keeps their proof.
   *   But a challenge lives five minutes and this window is twenty-four hours, so a
   *   caller refused by the budget can never use that challenge: it expires long before
   *   the window reopens. The protection is worth nothing.
   *
   *   Charging LAST protects the budget — a caller whose challenge was expired, spent,
   *   or minted for the other operation does not lose one of three daily changes to a
   *   request that changed nothing. That protection is worth something, and an expired
   *   challenge is the ordinary way a user reaches this line by mistake.
   *
   * So: validate everything, then charge, then write. Nothing between the charge and
   * the write can fail in a way that leaves the slot spent for no change, and
   * `consumeAll` is atomic, so two concurrent updates cannot both pass the check.
   */
  async update(
    principal: Principal,
    facts: RequestFacts,
    input: Extract<PaymentPinRequest, { action: 'update' }>,
  ): Promise<{ method: PaymentPinVerificationMethod }> {
    // Before the challenge is spent. A challenge lives five minutes and the freeze is
    // twenty-four hours, so one minted moments before an email change would otherwise
    // still be spendable after it — the exact ordering this cooldown exists to close.
    // Checking first also leaves a frozen caller's challenge intact.
    await this.securityChanges.assertNoRecentEmailChange(principal.userId);

    const grant = await this.spendChallenge(principal, input.challengeId, 'update');

    this.assertPinAcceptable(input.newPin);

    const existing = await this.requirePin(principal.userId);

    // Refused rather than accepted as a no-op. A user who "changed" their PIN to the
    // one it already was has spent a challenge and an emailed code believing something
    // happened, and telling them so is cheaper than the support ticket. Its own slug
    // because the remedy differs from a weak PIN's. Checked before the charge, so a
    // change that does not change anything does not cost a slot.
    if (await this.credentials.verify(existing.pinHash, input.newPin)) {
      throw new ProblemException({
        type: ERR.PAYMENT_PIN_REUSED,
        detail: 'The new Payment PIN must be different from the current one.',
      });
    }

    // A rolling window on the DURABLE store: the product's "three changes a day" must
    // mean that at every instant, and must survive a cache restart. See
    // `PAYMENT_PIN.UPDATE_BY_ACCOUNT` for why a fixed window would admit six.
    await this.quota.consumeAll(
      [
        {
          key: KEYS.rate.paymentPinUpdateByAccount(principal.userId),
          rule: policy().PAYMENT_PIN.UPDATE_BY_ACCOUNT,
        },
      ],
      'durable',
      'deny',
    );

    const pinHash = await this.credentials.hash(input.newPin);

    // ─── The security consequence, decided BEFORE the transaction opens ──────
    //
    // Three bounded history reads and a map lookup, producing a plain value. Placed
    // here — after every proof is spent, before the write — for two reasons: a request
    // about to be refused must not pay for it, and nothing that queries may run inside
    // the transaction below, which already holds `SELECT … FOR UPDATE` on
    // `identity.users` under Prisma's five-second default.
    //
    // This trigger matters more than it looks. `disable` below argues at length that a
    // Payment PIN change performs NO session sweep, so unlike the factor surfaces there
    // is nothing else here that would end an attacker's access — the restriction row is
    // the only consequence.
    const context = await this.restrictions.contextFrom(principal.userId, principal.sessionId, facts);
    const plan = await this.restrictions.planFor('paymentPin.update', context);

    if (!(await this.pins.replaceHash(principal.userId, pinHash, context, plan))) {
      // Reachable by a race: the PIN was disabled between `requirePin` above and this
      // write. The honest answer is the same one the caller would have got a moment
      // earlier, and nothing was changed.
      throw new ProblemException({
        type: ERR.PAYMENT_PIN_NOT_ENABLED,
        detail: PAYMENT_PIN_UNAVAILABLE.NOT_ENABLED,
      });
    }

    this.logger.warn({ userId: principal.userId, method: grant.method }, 'payment PIN changed');
    this.notify(principal.userId, 'Payment PIN changed', facts.ipClass);

    return { method: grant.method };
  }

  // ─── disable ────────────────────────────────────────────────────────────

  /**
   * Remove the PIN, given a challenge verified for `disable`.
   *
   * ─── Why this does NOT sweep the account's other sessions ──────────────────
   *
   * Disabling a passkey or an authenticator revokes every other session, and the reason
   * `SettingsService.disableFactor` gives is precise: the disabled factor MAY HAVE BEEN
   * HOW A SESSION WAS ESTABLISHED, so if the disable was not the owner's doing, the
   * sweep is what ends the other party's access.
   *
   * That reason does not reach a Payment PIN. It is never presented at sign-in, no
   * session anywhere derives from it, and removing it takes nothing away from any live
   * session that the session did not already lack. A sweep here would sign the user out
   * of their other devices to protect against a threat the sweep does not address —
   * which is a new session policy, adopted for a feature that does not need one, and
   * `SettingsService` is explicit that the existing one is justified by the mechanism
   * rather than by disabling being generally alarming.
   *
   * The other half of that pattern IS kept: the owner is emailed. If this was not their
   * doing, the mail is what tells them, and it is the same mail the factor surfaces send.
   *
   * ─── Why there is no separate disable quota ────────────────────────────────
   *
   * Reaching this line already cost a `VERIFY_BY_ACCOUNT` slot, an emailed code and a
   * credential proof, and a successful disable turns the setting off — so there is no
   * second successful call for a budget to refuse. A quota here would meter a step that
   * cannot be repeated.
   */
  async disable(
    principal: Principal,
    facts: RequestFacts,
    input: Extract<PaymentPinRequest, { action: 'disable' }>,
  ): Promise<{ method: PaymentPinVerificationMethod }> {
    // Before the challenge is spent — see `update` for why a five-minute challenge
    // must not outlive the freeze that started while it was live.
    await this.securityChanges.assertNoRecentEmailChange(principal.userId);

    const grant = await this.spendChallenge(principal, input.challengeId, 'disable');

    // Resolved before the transaction, for `update`'s reasons. See there.
    const context = await this.restrictions.contextFrom(principal.userId, principal.sessionId, facts);
    const plan = await this.restrictions.planFor('paymentPin.remove', context);

    if (!(await this.pins.remove(principal.userId, context, plan))) {
      throw new ProblemException({
        type: ERR.PAYMENT_PIN_NOT_ENABLED,
        detail: PAYMENT_PIN_UNAVAILABLE.NOT_ENABLED,
      });
    }

    this.logger.warn({ userId: principal.userId, method: grant.method }, 'payment PIN removed');
    this.notify(principal.userId, 'Payment PIN removed', facts.ipClass);

    return { method: grant.method };
  }

  // ─── the challenge ──────────────────────────────────────────────────────

  /**
   * Spend a challenge on `operation`, or refuse.
   *
   * `take` is a single `GETDEL`, so a challenge cannot be spent twice even by two
   * concurrent requests — the loser sees null. That is what makes "single-use" hold in
   * the presence of the race an attacker controls, rather than only in its absence.
   *
   * `operation` comes from the ACTION being executed, never from the request body. That
   * is what makes the binding meaningful: a caller who could name the operation at spend
   * time could name whichever one their challenge happens to carry. The identical
   * construction, and the identical argument, as `ElevationService.spend`.
   *
   * ─── Why the method is not compared ────────────────────────────────────────
   *
   * There is nothing to compare it against. The action request carries no method — it
   * carries an action and a challenge id — so a challenge verified with a passkey is
   * structurally incapable of being presented "as" a PIN. The field is read only to
   * report which credential was actually spent.
   *
   * ─── One answer for every way a challenge can be bad ───────────────────────
   *
   * Unknown, expired, already spent, another account's, another login's, or verified for
   * the other operation. A caller holding a bad challenge learns nothing about which,
   * and the legitimate remedy is identical in every case — verify again, for this
   * operation. Telling them "that was for update, not disable" would confirm that a
   * challenge they hold is live and what it is good for.
   */
  private async spendChallenge(
    principal: Principal,
    challengeId: string,
    operation: PaymentPinOperation,
  ): Promise<PaymentPinGrant> {
    const grant = parseGrant(await this.cache.take(KEYS.paymentPin.challenge(challengeId)));

    if (
      grant === null ||
      grant.userId !== principal.userId ||
      grant.familyId !== principal.familyId ||
      grant.operation !== operation
    ) {
      this.logger.warn(
        {
          userId: principal.userId,
          wanted: operation,
          matched: grant !== null,
          // Logged so an operator can tell a benign client bug from an attempt to reuse
          // a proof across operations. Safe in a log — these are our own values, and the
          // challenge is already spent by the read above.
          grantedFor: grant?.operation ?? null,
          sameUser: grant === null ? null : grant.userId === principal.userId,
        },
        'payment PIN challenge refused',
      );

      throw new ProblemException({
        type: ERR.PAYMENT_PIN_CHALLENGE_INVALID,
        detail:
          'That verification is no longer valid for this action. ' +
          'Verify again with POST /settings/security/payment-pin/verify.',
        // Named so a client can re-verify for the right operation without guessing.
        extra: { operation },
      });
    }

    return grant;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /**
   * The account's PIN row, or a refusal.
   *
   * One place that turns "no row" into `payment_pin_not_enabled`, so the three callers
   * that need the hash cannot each invent their own answer.
   */
  private async requirePin(userId: string) {
    const pin = await this.pins.findByUserId(userId);
    if (pin === null) {
      throw new ProblemException({
        type: ERR.PAYMENT_PIN_NOT_ENABLED,
        detail: PAYMENT_PIN_UNAVAILABLE.NOT_ENABLED,
      });
    }
    return pin;
  }

  /** Both operations need a PIN to act on. Checked before any proof is consumed. */
  private assertOperable(account: PaymentPinAccount): void {
    if (!account.enabled) {
      throw new ProblemException({
        type: ERR.PAYMENT_PIN_NOT_ENABLED,
        detail: PAYMENT_PIN_UNAVAILABLE.NOT_ENABLED,
      });
    }
  }

  /**
   * Is this method set up on this account at all?
   *
   * Runs BEFORE the emailed code is consumed. A method the account cannot use is the
   * server's knowledge, not the caller's mistake, and discovering it by spending a code
   * would charge a user for asking a reasonable question.
   *
   * Shares `methodAvailable` with the status render rather than re-deriving the rules,
   * so a method the screen offered can never be one this refuses.
   */
  private assertMethodAvailable(
    method: PaymentPinVerificationMethod,
    account: PaymentPinAccount,
  ): void {
    if (!methodAvailable(method, account)) {
      throw new ProblemException({
        type: ERR.MFA_METHOD_UNAVAILABLE,
        detail: methodUnavailableReason(method),
      });
    }
  }

  /** The strength rule, in the one place both writes reach it. */
  private assertPinAcceptable(pin: string): void {
    const assessment = assessPin(pin);
    if (!assessment.ok) {
      throw new ProblemException({ type: ERR.PAYMENT_PIN_WEAK, detail: assessment.reason });
    }
  }

  /**
   * Tell the owner something changed.
   *
   * After the write and fire-and-forget by `sendSecurityChanged`'s own contract: the
   * setting has already changed, and a mail failure must not report the change as
   * failed. A missing user row is possible only if the account was deleted mid-request,
   * and there is nobody left to notify.
   */
  private notify(userId: string, what: string, ipClass: string): void {
    void this.users
      .findById(userId)
      .then((user) => {
        if (user !== null) {
          // Off the row this lookup already fetched — no extra query.
          this.mail.sendSecurityChanged(user.email, what, ipClass, antiPhishingCodeOf(user));
        }
      })
      .catch((err: unknown) => {
        this.logger.error({ err, userId }, 'payment PIN notification lookup failed');
      });
  }
}
