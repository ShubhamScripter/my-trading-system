import { Injectable, Logger } from '@nestjs/common';
import type { Admin, AdminLoginAttempt } from '@prisma/client';
import { CacheService, KEYS } from '../../redis';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { OtpQueueService } from '../../src/mail/otp-queue.service';
import { secondsFromNow } from '../../src/utils/public.utils';
import { LIMITS, OTP, STEP_UP } from '../auth.constants';
import type { ClientContext, LoginOutcome } from '../auth.types';
import {
  generateOtp,
  generateStepUpSecret,
  normaliseCode,
  normaliseEmail,
  pepperedHash,
} from '../auth.utility';
import { AdminDbOperation } from '../persistence/admin.dboperation';
import { AttemptDbOperation } from '../persistence/attempt.dboperation';
import { AUTH_EVENT, AuthEventDbOperation } from '../persistence/authevent.dboperation';
import { ChallengeDbOperation } from '../persistence/challenge.dboperation';
import { spendChallenge, verifyChallengeCode } from '../security/challenge';
import { assertLive } from '../security/stepup';
import { CredentialService } from './credential.service';
import { MfaService } from './mfa.service';

/** An attempt plus the account it belongs to — what every step after `password`
 *  resolves from the step-up secret. */
export interface ResolvedAttempt {
  readonly attempt: AdminLoginAttempt;
  readonly admin: Admin;
}

/**
 * The first two factors: password and the emailed code.
 *
 * ─── The one invariant this file exists to hold ─────────────────────────────
 *
 * No method here issues a session. Not one. `verifyEmail` — the furthest this
 * service gets — advances the attempt to `EMAIL_VERIFIED` and returns a
 * description of what the admin must do next. Minting tokens belongs to
 * MfaService, behind the second factor, and keeping that capability out of this
 * file is what makes "the email code is not enough" a structural property rather
 * than a rule someone has to remember.
 */
@Injectable()
export class LoginService {
  private readonly logger = new Logger('LoginService');

  constructor(
    private readonly admins: AdminDbOperation,
    private readonly attempts: AttemptDbOperation,
    private readonly challenges: ChallengeDbOperation,
    private readonly credentials: CredentialService,
    private readonly mfa: MfaService,
    private readonly cache: CacheService,
    private readonly otpQueue: OtpQueueService,
    private readonly events: AuthEventDbOperation,
  ) {}

  /**
   * Step 1: password.
   *
   * ═══ THE ORDER OF THE CHECKS IS THE DESIGN ═════════════════════════════════
   *
   * Seven steps, and each one's position is load-bearing:
   *
   *   1. flood ceiling      charged on EVERY attempt. A resource bound, not a
   *                         credential one, and the only limiter a success pays.
   *   2. resolve the admin  a miss burns the argon2 work anyway — see below.
   *   3. review / disabled  refused before the password is even checked, because
   *                         the answer does not depend on it.
   *   4. verify             throws `account_locked` / `admin_login_manual_review`.
   *   5. on failure         charge the two FAILURE buckets, record, refuse.
   *   6. on success         clear the device streak, not the shared IP one.
   *   7. open the attempt   and queue the code.
   *
   * ─── On what this discloses ─────────────────────────────────────────────
   *
   * A wrong password and an unknown email answer `invalid_credentials`, and they now
   * do so after the SAME WORK and against the same limiters. That second half is new
   * and it is the point: this method used to return early for an unknown address
   * without reaching argon2, and a comment here claimed there was "no timing tell
   * worth chasing". There was. argon2id is ~50ms and is the dominant cost of the
   * request, so skipping it made the unknown-email path visibly faster — identical
   * response bodies do not help when the clock separates them. `verifyDummy` closes
   * that, and charging the failure buckets on the miss closes the second-order
   * version, where an attacker distinguishes the two by watching which bucket
   * depletes.
   *
   * `account_locked`, `account_disabled` and `admin_login_manual_review` DO disclose
   * existence, and that is the same deliberate trade as before: someone being turned
   * away needs to know it, rather than retrying a password that was never the problem.
   * For accounts whose addresses are mostly guessable company emails, the disclosure
   * buys an attacker very little — and all three require the correct password or a
   * sustained attack to reach.
   *
   * Unlike the consumer service there is NO passwordless branch. Every admin has a
   * password, so a missing credential row is an anomaly rather than a signposted
   * way in, and it answers `invalid_credentials`.
   */
  async withPassword(
    input: { readonly email: string; readonly password: string },
    client: ClientContext,
    deviceId: string,
  ): Promise<{ readonly outcome: LoginOutcome; readonly stepUpSecret: string }> {
    const emailLower = normaliseEmail(input.email);

    // ═══ 1. THE FLOOD CEILING ════════════════════════════════════════════════
    //
    // Every attempt, successful or not, and the ONLY limiter a success pays. Sixty in
    // fifteen minutes is four a minute sustained, so no human meets it; it exists to
    // stop one address making this endpoint do argon2 work thousands of times, which
    // is a resource question rather than a credential one.
    //
    // The two FAILURE buckets — device then IP, tightest first — are charged in
    // `chargeFailureBuckets`, on the two paths that reach a refusal. That split is
    // the design, and the ordering inside it is the mechanism: a client that has spent
    // its own six is refused there without also spending a slot in the IP's shared
    // eight.
    //
    // `allow` on cache failure: `failedAttempts`, `lockedUntil` and `lockoutStrikes`
    // are all in Postgres and keep enforcing — including the escalation to manual
    // review — with Redis completely down. This is not the only line of defence.
    await this.cache.consume(
      KEYS.rate.loginFloodByIp(client.ip),
      LIMITS.LOGIN_FLOOD_BY_IP,
      'allow',
    );

    // ═══ 2. RESOLVE, OR BURN THE SAME WORK AND REFUSE ════════════════════════
    //
    // The account AND its password in one statement. This used to be two reads —
    // resolve by email, then re-read the same row by id for the credential — and the
    // second one's `admin` was thrown away, so all it bought was a round trip.
    //
    // A null here is a missing ACCOUNT, which is the unknown-email path below. An
    // account with no password row comes back with `credential: null` instead, and
    // is judged further down, AFTER the review and status gates — see step 3.
    const resolved = await this.admins.findByEmailWithCredential(emailLower);
    if (resolved === null) {
      await this.credentials.verifyDummy(input.password);
      await this.chargeFailureBuckets(client, deviceId);
      await this.events.record({
        eventType: AUTH_EVENT.UNKNOWN_EMAIL,
        adminId: null,
        client,
        failureStage: 'password',
      });
      throw new ProblemException({ type: ERR.INVALID_CREDENTIALS });
    }

    const found = resolved.admin;

    // ═══ 3. STATES THE PASSWORD CANNOT ANSWER FOR ════════════════════════════
    //
    // Checked before the verify, not after: the answer does not depend on whether the
    // password was right, and running argon2 first would only spend work to reach the
    // same refusal.
    this.assertNotUnderReview(found);
    if (found.status !== 'ACTIVE') {
      throw new ProblemException({ type: ERR.ACCOUNT_DISABLED });
    }

    // Still checked HERE, below the two gates above rather than beside the read that
    // produced it. An account under review or disabled must answer with its own slug,
    // and hoisting this would mask both behind `invalid_credentials`.
    if (resolved.credential === null) {
      this.logger.error({ adminId: found.id }, 'admin has no password credential');
      throw new ProblemException({ type: ERR.INVALID_CREDENTIALS });
    }

    // ═══ 4. VERIFY ══════════════════════════════════════════════════════════
    //
    // Throws `account_locked` while a lock is running — a distinct and useful answer,
    // since refusing to say so leaves an admin retrying a correct password against a
    // lock — and `admin_login_manual_review` when this failure was the second lock
    // inside the strike memory.
    const { valid, priorFailures } = await this.credentials.checkPassword(
      resolved.credential,
      input.password,
    );

    // ═══ 5. FAILURE: CHARGE THE FAILURE BUCKETS ═════════════════════════════
    if (!valid) {
      await this.chargeFailureBuckets(client, deviceId);
      await this.events.record({
        eventType: AUTH_EVENT.PASSWORD_FAILURE,
        adminId: found.id,
        client,
        failureStage: 'password',
        metadata: { consecutiveFailures: priorFailures + 1 },
      });
      throw new ProblemException({ type: ERR.INVALID_CREDENTIALS });
    }

    // ═══ 6. SUCCESS: CLEAR THE DEVICE STREAK, NOT THE IP ONE ════════════════
    //
    // The device key names ONE BROWSER — it is the `orebit_admin_device` cookie, not
    // the colliding user-agent fingerprint — so a correct password is real evidence
    // that the streak was that client fumbling. Clearing it stops an admin who
    // mistyped five times from being refused later in the same window, which is the
    // whole population this bucket exists to protect rather than bound.
    //
    // The IP key is deliberately left alone. It is SHARED across every account behind
    // that address, so letting one success wipe it would hand an attacker who holds a
    // single valid credential a reset lever: guess, guess, guess, sign in with the one
    // they own, repeat forever without ever meeting the limit. That is the exact
    // decoupling this whole change exists to make.
    await this.cache.clear(KEYS.rate.loginFailureByDevice(deviceId));

    if (priorFailures > 0) {
      // The streak is about to be unrecoverable — `checkPassword` has already cleared
      // it. A streak that ends in a success is an admin who fumbled and remembered;
      // one that ends in a lock is something else, and after the clear this row is the
      // only thing that can tell a reviewer which happened.
      await this.events.record({
        eventType: AUTH_EVENT.PASSWORD_SUCCESS_AFTER_FAILURES,
        adminId: found.id,
        client,
        metadata: { priorFailures },
      });
    }

    // ═══ 7. PASSWORD PROVEN. OPEN THE ATTEMPT AND QUEUE THE CODE ════════════
    const stepUpSecret = generateStepUpSecret();
    const attempt = await this.attempts.open({
      adminId: found.id,
      stepUpSecretHash: pepperedHash(stepUpSecret, 'stepup'),
      client,
      expiresAt: secondsFromNow(STEP_UP.TTL_SECONDS),
    });

    // ─── No `force`, and the cooldown now holds across attempts ─────────────
    //
    // This used to pass `force: true`, on the reasoning that a fresh password proof
    // earns a fresh code: without it, signing in twice inside the 60-second cooldown
    // left the second attempt stranded, because the first attempt's code had been
    // spent and no new one could be sent.
    //
    // Policy is now that the cooldown holds across attempts, and the stranding it was
    // avoiding no longer happens — for a reason that is structural rather than a
    // second exception. `issueEmailOtp` checks the cooldown BEFORE it invalidates
    // anything, so a second sign-in inside the window leaves the in-flight code alive
    // and reports when the next one may be asked for. The admin uses the code already
    // in their inbox; the new attempt verifies against it, because the challenge is
    // keyed on the account rather than the attempt.
    const sent = await this.issueEmailOtp(found, attempt, client);

    this.logger.log({ adminId: found.id, attemptId: attempt.id }, 'password verified');
    return { outcome: sent, stepUpSecret };
  }

  /**
   * Charge both failure dimensions for one wrong password.
   *
   * ─── Called from the unknown-email path too, and that is the point ────────
   *
   * If only real accounts charged these, an attacker could tell the two apart by
   * watching which bucket depletes — send eight guesses at a candidate address, then
   * check whether a known-good address from the same IP is refused. That reopens on
   * the limiter side the disclosure `verifyDummy` closes on the timing side.
   *
   * ─── TIGHTEST FIRST, AND THE ORDER IS THE MECHANISM ───────────────────────
   *
   * Device (6) before IP (8), over the same fifteen minutes. A client that has spent
   * its own six is refused HERE, without also spending a slot in the shared IP bucket
   * — charging the shared one first would let a single misbehaving browser drain it
   * anyway, one refusal at a time, which is the whole failure the device bucket
   * exists to prevent: an admin driven into a durable lockout by a background tab
   * replaying a stale saved password, and their office locked out alongside them.
   *
   * `consume` THROWS at the cap, so the ordering is what makes this real rather than
   * cosmetic: the device refusal short-circuits before the IP bucket is touched.
   *
   * `allow` on cache failure for both, matching the flood ceiling: the durable
   * Postgres counters are what actually bound guessing against one account, and they
   * escalate. A limiter we cannot read must not become an outage.
   */
  private async chargeFailureBuckets(client: ClientContext, deviceId: string): Promise<void> {
    await this.cache.consume(
      KEYS.rate.loginFailureByDevice(deviceId),
      LIMITS.LOGIN_FAILURE_BY_DEVICE,
      'allow',
    );
    await this.cache.consume(
      KEYS.rate.loginFailureByIp(client.ip),
      LIMITS.LOGIN_FAILURE_BY_IP,
      'allow',
    );
  }

  /**
   * Refuse an account the system has taken out of service pending a super admin.
   *
   * Called from every entry point that can reach a live account — the password step
   * and `resolve`, which covers every later login step and every `POST /2fa` action.
   * `SessionService.rotate` makes the same check for refresh tokens.
   *
   * A separate answer from `account_disabled` because the remedy differs: a disabled
   * account was turned off by a person, this one was suspended by the system and has a
   * review queued against it. Separate from `account_locked` because there is no wait
   * — sending `Retry-After` here would have the client count down to another refusal.
   */
  private assertNotUnderReview(admin: Admin): void {
    if (admin.loginReviewStatus !== 'PENDING') return;
    throw new ProblemException({
      type: ERR.ADMIN_LOGIN_MANUAL_REVIEW,
      detail:
        'This account is suspended pending review by a super administrator. ' +
        'Waiting will not restore access.',
    });
  }

  /**
   * Resolve the attempt a step-up secret names, and the account behind it.
   *
   * Every step after `password` goes through here — on this route AND on `POST
   * /2fa`. The secret is matched by hash — the column holds nothing else — and
   * `assertLive` runs before the caller sees the row, so no step can operate on an
   * expired or completed attempt even if it forgets to check.
   *
   * ─── `stepUpSecret` here is `loginId` on the wire ──────────────────────────
   *
   * Same value, two names. The client sends it as `loginId` in the request body;
   * inside the service it keeps the name it has always had, and at rest it is
   * `AdminLoginAttempt.stepUpSecretHash`. Renaming the internals would have made a
   * third name for one value, and the `'stepup'` hash domain below is mixed into
   * the digest — changing it would invalidate every live attempt row. See
   * `loginIdSchema` in dto/common.dto.ts.
   *
   * ─── Why the limiter is HERE and not in the controllers ───────────────────
   *
   * Two controllers reach this method across two routes. Metering at the call
   * sites would mean four places to keep in step, and a fifth that forgets. The
   * same argument as `issueEmailOtp`: a limit that guards a resource belongs next
   * to the resource, not next to one of the doors that reaches it.
   *
   * `allow` on cache failure, matching the password path. The durable bounds — the
   * attempt's own `expiresAt`, `otpSentCount` and `mfaAttempts`, all in Postgres —
   * keep enforcing with Redis completely down, so an unreadable counter must not
   * become an outage on the one flow an admin cannot work around.
   */
  async resolve(stepUpSecret: string, client: ClientContext): Promise<ResolvedAttempt> {
    await this.cache.consume(
      KEYS.rate.loginResolveByIp(client.ip),
      LIMITS.LOGIN_RESOLVE_BY_IP,
      'allow',
    );

    const attempt = await this.attempts.findBySecretHash(pepperedHash(stepUpSecret, 'stepup'));
    if (attempt === null) {
      // Forged, already spent, or belonging to an attempt that was superseded.
      // One answer for all three: distinguishing them would tell a caller whether
      // a secret was ever valid.
      throw new ProblemException({ type: ERR.STEP_UP_INVALID });
    }

    try {
      assertLive(attempt);
    } catch (err) {
      // Retire it as we refuse it, so a stale row stops occupying the unique
      // index and a retry gets the same clean answer.
      await this.attempts.expire(attempt.id);
      throw err;
    }

    const admin = await this.admins.findById(attempt.adminId);
    if (admin === null) {
      await this.attempts.expire(attempt.id);
      throw new ProblemException({ type: ERR.ACCOUNT_DISABLED });
    }

    // ═══ THE MANUAL-REVIEW GATE, FOR EVERY STEP AFTER THE PASSWORD ═══════════
    //
    // This one check covers `resend-otp`, `verify-email`, `state` and every action on
    // `POST /2fa` — all of them resolve their attempt through this method. That is why
    // the review columns live on `Admin` rather than on `AdminCredential`: the row is
    // already in hand here, so the check costs nothing and there is no second read for
    // a future step to forget.
    //
    // Checked BEFORE `status`, so an account suspended by the system gets the specific
    // answer rather than the generic one — the review sets `status = 'DISABLED'` too,
    // and the order is what stops that from masking the more useful slug.
    //
    // The attempt is retired either way. An in-flight sign-in must not outlive the
    // account's right to sign in, and a half-authenticated caller holding a step-up
    // secret is precisely what a review needs to invalidate.
    if (admin.loginReviewStatus === 'PENDING') {
      await this.attempts.expire(attempt.id);
      this.assertNotUnderReview(admin);
    }

    if (admin.status !== 'ACTIVE') {
      // Deleted or disabled since the password step.
      await this.attempts.expire(attempt.id);
      throw new ProblemException({ type: ERR.ACCOUNT_DISABLED });
    }

    return { attempt, admin };
  }

  /** Step 2a: send another code. */
  async resendOtp(resolved: ResolvedAttempt, client: ClientContext): Promise<LoginOutcome> {
    return this.issueEmailOtp(resolved.admin, resolved.attempt, client);
  }

  /**
   * Step 2b: verify the emailed code.
   *
   * The furthest this service goes. On success the attempt reaches
   * `EMAIL_VERIFIED` and the answer describes the second factor — it never
   * carries tokens.
   */
  async verifyEmail(resolved: ResolvedAttempt, rawCode: string): Promise<LoginOutcome> {
    const { admin, attempt } = resolved;

    const challenge = await verifyChallengeCode(
      this.challenges,
      admin.id,
      'LOGIN_EMAIL_OTP',
      normaliseCode(rawCode),
    );

    // Nothing between verify and spend on this path — there is no policy check to
    // run, so the code is spent the moment it is proven.
    await spendChallenge(this.challenges, challenge.id);

    // Compare-and-swap from the state we were told we were in. Losing means
    // something else already advanced this attempt, and a second advance from one
    // code is exactly what this prevents.
    if (!(await this.attempts.advanceState(attempt.id, 'PASSWORD_VERIFIED', 'EMAIL_VERIFIED'))) {
      throw new ProblemException({ type: ERR.STEP_UP_STEP_INVALID });
    }

    // First proof of this address, if it had never been proven.
    if (admin.emailVerifiedAt === null) {
      await this.admins.markEmailVerified(admin.id);
    }

    this.logger.log({ adminId: admin.id, attemptId: attempt.id }, 'email code verified');

    // Enrollment or authentication. Computed from confirmed factors rather than
    // from `Admin.mfaEnrolledAt`, so the answer cannot be stale.
    return this.describeMfaState(admin.id);
  }

  /** Where this attempt is, so a page refresh can resume rather than restart. */
  async readState(resolved: ResolvedAttempt): Promise<LoginOutcome> {
    const { admin, attempt } = resolved;

    if (attempt.state === 'PASSWORD_VERIFIED') {
      return this.describeOtpState(attempt);
    }

    return this.describeMfaState(admin.id);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /**
   * Enrollment or authentication, from ONE read of the factor set.
   *
   * Both callers — `verifyEmail` and `readState` — asked the same pair of questions
   * and each used to answer them with a separate `confirmedFactorCounts`, so a single
   * request ran four COUNT queries where two answer both. `enrollmentState` reads
   * once and derives both; the counts are still read fresh on every request.
   *
   * `enrollment_required` names both methods unconditionally rather than reporting
   * the (empty) confirmed set: nothing is enrolled yet, so this is the menu of what
   * the admin may set up, not a list of what they hold.
   */
  private async describeMfaState(adminId: string): Promise<LoginOutcome> {
    const { needsEnrollment, methods } = await this.mfa.enrollmentState(adminId);
    if (needsEnrollment) {
      return { kind: 'enrollment_required', methods: ['TOTP', 'PASSKEY'] };
    }
    return { kind: 'mfa_required', methods };
  }

  /**
   * Issue a sign-in code and hand it to the durable queue.
   *
   * ─── Why every limit lives here and not at the call sites ─────────────────
   *
   * Two paths reach this sender: `withPassword`, where a code follows a proven
   * password, and `resendOtp`. Metering only the second would let a caller who
   * knows a password email a real code on every request. A limit that guards a
   * resource belongs next to the resource, not next to one of the doors that
   * reaches it.
   *
   * ═══ THREE BUDGETS, AND NONE REPLACES ANOTHER ══════════════════════════════
   *
   * `OTP.MAX_SENDS` is a Postgres counter on the ATTEMPT row. `LOGIN_OTP_SHORT` and
   * `LOGIN_OTP_DAILY` are Redis buckets on the ACCOUNT.
   *
   * The Redis buckets are keyed on the account rather than the attempt, so abandoning
   * a sign-in and starting a new one does not reset them — which is what stops the
   * per-attempt counter from being trivially bypassed by opening a new attempt.
   *
   * The Postgres counter is DURABLE, which is what the buckets are not: this service's
   * cache instance runs `--save "" --appendonly no`, so every restart wipes every
   * bucket. Without the durable check the send budget would reset to zero-used on each
   * restart, and the API would go on reporting `otpSendsRemaining` from a counter
   * nothing enforced.
   *
   * ═══ THE ORDERING, AND THE ONE HAZARD IT AVOIDS ════════════════════════════
   *
   *   1. per-attempt budget   refuses at the cap; cannot be reset by a cache flush
   *   2. cooldown             BEFORE anything is spent or invalidated — see below
   *   3. rolling quotas       the burst and daily ceilings across attempts
   *   4. invalidate + issue   only now, once a send is definitely going to happen
   *   5. enqueue, then charge the cooldown and the counter
   *
   * Step 2 sitting above step 4 is the subtle part, and getting it backwards is a
   * self-inflicted lockout. `ChallengeDbOperation.issue` supersedes the live code as
   * it writes the new one — that is what makes "resend" mean resend rather than "now
   * two codes work". So invalidating first and THEN discovering the cooldown blocks
   * the send would leave the admin with no live code and a 60-second wait before they
   * could ask for one: their in-flight code killed to make room for one that was never
   * sent. Checking the cooldown first means a request inside the window changes
   * nothing at all and simply reports the wait.
   *
   * ═══ CHARGED AT ENQUEUE, REFUNDED BY THE WORKER ════════════════════════════
   *
   * Delivery is asynchronous now, so the outcome is not knowable here. The old code
   * sent first and charged only on a confirmed `'sent'`; that is no longer available,
   * and the inversion is the honest replacement — charge optimistically, and let
   * `OtpQueueService.compensate` give it all back if four attempts fail. The failure
   * mode it protects against is unchanged and is why any of this care exists: an SMTP
   * outage must not spend a budget the admin cannot see being spent, on an account
   * whose only way in is that emailed code.
   */
  private async issueEmailOtp(
    admin: Admin,
    attempt: AdminLoginAttempt,
    client: ClientContext,
  ): Promise<LoginOutcome> {
    const cooldownKey = KEYS.rate.loginOtpCooldown(admin.emailLower);

    // ═══ 1. THE DURABLE PER-ATTEMPT BUDGET ═══════════════════════════════════
    //
    // First, so nothing below can be reached past the cap. `attempt.otpSentCount` was
    // once read only to compute the `otpSendsRemaining` shown to the client, with
    // nothing comparing it to `MAX_SENDS` — so the API advertised a limit it did not
    // enforce.
    if (attempt.otpSentCount >= OTP.MAX_SENDS) {
      this.logger.warn(
        { adminId: admin.id, attemptId: attempt.id, sent: attempt.otpSentCount },
        'OTP send budget exhausted for this attempt',
      );
      throw new ProblemException({
        type: ERR.OTP_SEND_LIMIT_REACHED,
        detail: 'No more codes can be sent for this sign-in. Start again.',
        extra: { otpSendsRemaining: 0 },
      });
    }

    // ═══ 2. THE COOLDOWN, BEFORE ANYTHING IS SPENT ═══════════════════════════
    //
    // No `force` exemption any more: policy is that the 60 seconds holds across
    // attempts, including a fresh password proof. Returning here changes NOTHING — no
    // quota charged, no challenge superseded — so the code already in the admin's
    // inbox stays valid and stays verifiable by this new attempt, because the
    // challenge is keyed on the account rather than the attempt.
    //
    // Not an error: the caller asked for something that is already on its way, and
    // reporting the wait is more useful than refusing. The client renders a countdown
    // from it either way.
    const remaining = await this.cache.cooldownRemaining(cooldownKey);
    if (remaining > 0) {
      return this.describeOtpState(attempt, secondsFromNow(remaining));
    }

    // ═══ 3. THE ROLLING QUOTAS ═══════════════════════════════════════════════
    //
    // `deny` on cache failure for both: this sends email, and unlike the login
    // limiters there is no durable backstop that would keep metering it. An unreadable
    // limiter must not leave the sender unmetered.
    //
    // Short before daily, so the cheaper and more commonly hit ceiling answers first.
    await this.cache.consume(
      KEYS.rate.loginOtpShort(admin.emailLower),
      LIMITS.LOGIN_OTP_SHORT,
      'deny',
    );
    await this.cache.consume(
      KEYS.rate.loginOtpDaily(admin.emailLower),
      LIMITS.LOGIN_OTP_DAILY,
      'deny',
    );

    // ═══ 4. SUPERSEDE AND ISSUE ══════════════════════════════════════════════
    //
    // `issue` retires the previous live challenge in the same transaction. Reached
    // only past the cooldown, so a code is never killed for a send that will not
    // happen.
    const code = generateOtp();
    const expiresAt = secondsFromNow(OTP.TTL_SECONDS);
    const challenge = await this.challenges.issue({
      adminId: admin.id,
      purpose: 'LOGIN_EMAIL_OTP',
      codeHash: pepperedHash(code, 'otp'),
      expiresAt,
      ipAddress: client.ip,
    });

    // ═══ 5. ENQUEUE, THEN CHARGE ═════════════════════════════════════════════
    //
    // `enqueue` resolves once the job is durably stored, not once it is sent — so this
    // returns in milliseconds rather than holding the request open for up to 35
    // seconds behind a slow relay. It THROWS if the durable write fails, which is
    // correct: the quotas above are already spent and the challenge is already issued,
    // so failing the request lets the admin retry into a clean state rather than
    // waiting for a code that was never queued.
    await this.otpQueue.enqueue({
      adminId: admin.id,
      challengeId: challenge.id,
      attemptId: attempt.id,
      emailLower: admin.emailLower,
      to: admin.email,
      code,
      minutesValid: OTP.TTL_SECONDS / 60,
      // The challenge's own expiry, carried so the worker can refuse to deliver a code
      // that died while a relay was unreachable.
      validUntil: expiresAt,
    });

    await this.cache.startCooldown(cooldownKey, OTP.RESEND_COOLDOWN_SECONDS);
    const updated = await this.attempts.recordOtpSent(attempt.id);

    return this.describeOtpState(updated, secondsFromNow(OTP.RESEND_COOLDOWN_SECONDS));
  }

  /** The `email_otp_required` payload, from the attempt row. */
  private describeOtpState(
    attempt: AdminLoginAttempt,
    resendAvailableAt?: Date,
  ): LoginOutcome {
    const cooldownEnd =
      attempt.lastOtpSentAt === null
        ? null
        : new Date(attempt.lastOtpSentAt.getTime() + OTP.RESEND_COOLDOWN_SECONDS * 1000);

    return {
      kind: 'email_otp_required',
      otpExpiresAt:
        attempt.lastOtpSentAt === null
          ? null
          : new Date(attempt.lastOtpSentAt.getTime() + OTP.TTL_SECONDS * 1000),
      resendAvailableAt:
        resendAvailableAt ??
        (cooldownEnd !== null && cooldownEnd.getTime() > Date.now() ? cooldownEnd : null),
      otpSendsRemaining: Math.max(0, OTP.MAX_SENDS - attempt.otpSentCount),
    };
  }
}
