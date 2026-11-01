import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Registration } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { MailService } from '../../src/mail/mail.service';
import { GEO_RESOLVER, type GeoResolver } from '../../src/geo/geo.types';
import { CacheService, KEYS, QuotaService } from '../../redis';
import { policy, quotaSet } from '../limits';
import { chargeOtpMail, refundOtpMail } from './otp-mail.charge';
import { safeEqual, secondsFromNow } from '../../src/utils/public.utils';
import { OTP, REGISTRATION } from '../auth.constants';
import type { ClientContext, IssuedSession } from '../auth.types';
import { STEP_REQUIRES } from '../auth.types';
import {
  generateContinuationSecret,
  generateOtp,
  normaliseCode,
  pepperedHash,
} from '../auth.utility';
import { UserService } from './user.service';
import { BlocklistService } from './blocklist.service';
import { CredentialService } from './credential.service';
import { RegistrationDbOperation } from '../persistence/registration.dboperation';
import { RetainedEmailDbOperation } from '../persistence/retained-email.dboperation';
import { SessionService } from './session.service';
import type {
  RegisterCheckReferralRequest,
  RegisterCountryRequest,
  RegisterCredentialsRequest,
  RegisterStartRequest,
  RegisterTrustDeviceRequest,
  RegisterVerifyEmailRequest,
} from '../dto/register.dto';

/**
 * The registration state machine.
 *
 *   direct signup
 *   OTP_SENT ──verify-email──▶ OTP_VERIFIED ──credentials──▶ CREDENTIALS_SET
 *                                                                  │
 *   OAuth, provider-verified email                                 │
 *   ─────────────────────────────────────────────────────────▶ CREDENTIALS_SET
 *                                                                  │
 *   OAuth, provider would not vouch                                │
 *   OTP_SENT ──verify-email───────────────────────────────────▶ CREDENTIALS_SET
 *                                                                  │
 *                                                              country
 *                                                                  ▼
 *                                                    USER + SESSION + COMPLETED
 *
 * The two OAuth entries skip `credentials` because the provider is the credential
 * — there is no decision left for that step to record, and requiring it would put
 * a mandatory no-op between "Continue with Google" and the country screen. They
 * skip it by *starting further along*, never by relaxing a guard: `country` still
 * demands `CREDENTIALS_SET` from every caller. See `OauthService.beginRegistration`.
 *
 * Two properties hold throughout, and both are enforced here rather than trusted
 * from the client:
 *
 *  1. A step is legal only from the states in `STEP_REQUIRES`. A client cannot
 *     reach `credentials` without having verified the email, no matter what it
 *     sends.
 *  2. `registrationId` is the credential for every step after `start`. It is a
 *     UUIDv7 the client is handed once, and `complete` retires it — which is what
 *     makes it acceptable for the country step to be keyed on it rather than on a
 *     session.
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger('RegistrationService');

  constructor(
    private readonly registrations: RegistrationDbOperation,
    private readonly users: UserService,
    private readonly credentials: CredentialService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly cache: CacheService,
    private readonly quota: QuotaService,
    private readonly blocklist: BlocklistService,
    /** Addresses released by an email change and still reserved. Read on `start`
     *  only — this service never writes the table. */
    private readonly retainedEmails: RetainedEmailDbOperation,
    @Inject(GEO_RESOLVER) private readonly geo: GeoResolver,
  ) {}

  // ─── step: start ──────────────────────────────────────────────────────────

  /**
   * Begin a registration and mint the continuation secret that identifies it.
   *
   * Any live attempt for this address is superseded rather than resumed. That is a
   * product decision — abandoning the flow means starting over — and it has a
   * useful side effect: a cookie left over from an earlier attempt stops
   * resolving, so there is no way to end up half in one registration and half in
   * another.
   *
   * The secret is returned to the caller, NOT stored on the returned row. Only its
   * hash is persisted, so this is the one and only moment the plaintext exists
   * server-side; the controller's job is to put it straight into a cookie.
   */
  async start(
    input: RegisterStartRequest,
    client: ClientContext,
  ): Promise<{ registration: Registration; continuationSecret: string }> {
    // Six quotas — email, IP and signed device, each over an hour and a rolling day —
    // as ONE atomic decision. Two round trips would let a caller pass the hourly check,
    // be charged, and then be refused by the daily one, leaving a charge behind for a
    // request that never happened.
    //
    // ─── On the tight per-IP value ────────────────────────────────────────────
    //
    // Four an hour is deliberately tight and is the policy's own flagged risk: an
    // office, a university, a hotel, a VPN or a mobile carrier is one address and many
    // people, so on its own this number turns away real users. The device quota beside
    // it is what separates those users from each other — and it only works because the
    // cookie carrying it is signed and cannot be minted by the caller. See
    // `device.cookie.ts`; without that signature this pairing would be theatre.
    //
    // Deny on cache failure: this path sends email, and there is no durable backstop
    // counting starts per IP.
    await this.quota.consumeAll(
      [
        ...quotaSet(
          policy().REGISTRATION.START_BY_EMAIL,
          KEYS.rate.registerStartByEmail(input.email),
          KEYS.rate.registerStartByEmailDaily(input.email),
        ),
        ...quotaSet(
          policy().REGISTRATION.START_BY_IP,
          KEYS.rate.registerStartByIp(client.ip),
          KEYS.rate.registerStartByIpDaily(client.ip),
        ),
        ...quotaSet(
          policy().REGISTRATION.START_BY_DEVICE,
          KEYS.rate.registerStartByDevice(client.deviceKey),
          KEYS.rate.registerStartByDeviceDaily(client.deviceKey),
        ),
      ],
      'burst',
      'deny',
    );

    // Placed between the rate limits and the existence check, and both sides of
    // that matter.
    //
    // After the limits, so probing the blocklist costs a counter like any other
    // request — checked first, this endpoint would be a free oracle for reading
    // back which domains we block.
    //
    // Before `emailExists`, so a blocked address never reaches the account
    // enumeration below it. Otherwise a blocked address would answer a question
    // we only agreed to answer for addresses someone could actually register.
    await this.blocklist.assertNotBlocked(input.email);

    // The product asks for this disclosure explicitly: the signup screen says the
    // address is unavailable and offers a password reset. It is account
    // enumeration, accepted deliberately for the UX.
    if (await this.users.emailExists(input.email)) {
      throw new ProblemException({
        type: ERR.EMAIL_ALREADY_REGISTERED,
        detail: 'An account already exists for this email. Try signing in, or reset your password.',
      });
    }

    // ─── the second reservation, and why the index does not cover it ─────────
    //
    // `ix_users_email_active` scopes uniqueness to LIVE accounts, so the moment an email
    // change commits the released address is free by that index's own definition. It has
    // to be: the same property is what lets a user move an address back to themselves.
    //
    // But free-to-the-index is not free-to-the-world. An address its previous owner may
    // still want back — and which is still receiving their mail — must not be claimable
    // by a stranger, so a change reserves it for `EMAIL.RETENTION_DAYS`.
    //
    // The check is a live-row lookup rather than a flag, so an expired reservation stops
    // blocking without anything having to sweep it: correctness does not depend on a
    // cleanup job ever running.
    //
    // ─── Why this reuses EMAIL_ALREADY_REGISTERED ───────────────────────────
    //
    // The caller's remedy is identical — choose another address — and a distinct slug
    // would tell a stranger that somebody recently changed away from this one, which is
    // a fact about another user's account that this endpoint has no business disclosing.
    // The enumeration above is deliberate about accounts that EXIST; this would be
    // enumeration about accounts that moved.
    if ((await this.retainedEmails.findLiveByEmail(input.email)) !== null) {
      throw new ProblemException({
        type: ERR.EMAIL_ALREADY_REGISTERED,
        detail: 'An account already exists for this email. Try signing in, or reset your password.',
      });
    }

    const code = generateOtp();
    const continuationSecret = generateContinuationSecret();
    // Shared between the row that verifies the code and the message that carries it.
    const otpExpiresAt = secondsFromNow(OTP.TTL_SECONDS);

    // Charged BEFORE the registration is created, and before the previous attempt is
    // superseded. Both orderings matter: a caller refused here must not have destroyed
    // an in-flight registration on the way to being told no, and must not leave a row
    // behind for a code that was never sent.
    const mailCharge = await chargeOtpMail(this.quota, input.email);

    // ─── One compensation scope, covering everything after the charge ─────────
    //
    // The `try` used to start at the enqueue, five statements below. Everything in
    // between — superseding the previous attempt, resolving GEO, creating the row,
    // starting the cooldown — could throw with the budget already spent and nothing
    // giving it back, so a Postgres blip during signup silently cost the address one
    // of its five hourly sends for an email that was never even composed. Repeat it
    // five times and the address is locked out for an hour with no error that names
    // the reason.
    //
    // `registration` is declared out here so the catch can tell "failed before the row
    // existed" (refund the budget only) from "failed after" (retire the OTP and return
    // the row's own send count as well).
    let registration: Registration | null = null;
    const otpHash = pepperedHash(code, 'otp');

    try {
      const superseded = await this.registrations.supersedeLiveAttempts(input.email);
      if (superseded > 0) {
        this.logger.log({ superseded }, 'superseded earlier registration attempt(s) for this email');
      }

      const geo = await this.geo.resolve(client.ip);

      registration = await this.registrations.create({
        email: input.email,
        emailLower: input.email,
        ipAddress: client.ip,
        countrySuggested: geo.country,
        otpHash,
        otpExpiresAt,
        expiresAt: secondsFromNow(REGISTRATION.TTL_SECONDS),
        continuationSecretHash: pepperedHash(continuationSecret, 'continuation'),
        state: 'OTP_SENT',
        emailVerified: false,
        oauth: null,
      });

      await this.startCooldown(registration.id);

      // Enqueue returns immediately, and the compensation now travels WITH the message
      // rather than as a closure this process has to survive long enough to run. The
      // registration is created and its cookie set either way, which is the property
      // that made a failed send survivable in the first place.
      await this.mail.sendOtp(
        registration.email,
        code,
        otpExpiresAt,
        [
          { kind: 'registration.refund-otp-send', registrationId: registration.id },
          refundOtpMail(mailCharge),
        ],
        // No anti-phishing code, and there cannot be one: this is a REGISTRATION, so no
        // account exists to have set one. Worth naming rather than leaving implicit,
        // because it means the signup verification mail is the one message in the
        // system a forger can imitate without having to defeat the footer.
        null,
      );
    } catch (error) {
      const row = registration;
      await this.compensate(async () => {
        if (row !== null) {
          await this.registrations.invalidateOtp(row.id, otpHash);
          await this.registrations.refundOtpSend(row.id);
        }
        await this.quota.refund(mailCharge, 'durable');
      });
      throw error;
    }

    return { registration, continuationSecret };
  }

  /**
   * Run a compensation without letting it replace the failure that caused it.
   *
   * Every one of these is a Redis or Postgres call, and the paths that need them are
   * exactly the paths where Redis or Postgres is already misbehaving — so the
   * compensation is more likely to throw here than anywhere else in the service. If it
   * did, it would propagate INSTEAD of the original error, and the caller would be told
   * about a failed refund rather than about the failure that made a refund necessary.
   *
   * So it is logged and swallowed, and the caller rethrows the real error. A lost
   * refund is a user one send short on a window that expires by itself; a swallowed
   * root cause is an outage nobody can read.
   */
  private async compensate(undo: () => Promise<void>): Promise<void> {
    try {
      await undo();
    } catch (err) {
      this.logger.error({ err }, 'compensation after a failed registration send did not complete');
    }
  }

  /**
   * Record the answer to "trust this device?".
   *
   * Stored on the registration rather than acted on now, because the device can
   * only be trusted once there is an account to trust it for — `setCountry` is
   * where that happens. Does not advance `state`, so it is safe to re-send as the
   * user toggles the switch.
   */
  async setTrustDevice(secret: string, input: RegisterTrustDeviceRequest): Promise<Registration> {
    const registration = await this.load(secret, 'trust-device');
    return this.registrations.setTrustDevice(registration.id, input.trust);
  }

  // ─── step: resend-otp ─────────────────────────────────────────────────────

  async resendOtp(secret: string): Promise<Registration> {
    const registration = await this.load(secret, 'resend-otp');
    const lockKey = KEYS.rate.otpResendLock(registration.id);
    const lockValue = generateContinuationSecret();
    const acquired = await this.cache.setIfAbsent(lockKey, lockValue, 30);
    if (!acquired) {
      // A concurrent resend is deliberately treated like the cooldown. It reveals
      // neither attempt state nor delivery state and cannot create a second live OTP.
      const remaining = await this.cache.cooldownRemaining(KEYS.rate.otpResend(registration.id));
      throw new ProblemException({
        type: ERR.OTP_RESEND_TOO_SOON,
        retryAfterSeconds: Math.max(1, remaining),
      });
    }

    try {
      return await this.sendOtp(registration);
    } finally {
      await this.cache.clearIfValue(lockKey, lockValue);
    }
  }

  /**
   * Issue and email a new code.
   *
   * ─── Three limits, and why none of them replaces another ───────────────────
   *
   * `otpSentCount` (the row) caps the total for ONE attempt, and lives in Postgres so
   * a cache flush cannot reset a user's send budget to zero-used.
   *
   * The cooldown (Redis) stops rapid-fire resends.
   *
   * The recipient quota is the one that was missing, and its absence was a loophole
   * rather than a gap. The budget was `otpSentCount` alone — a column on the
   * registration row — so a caller who exhausted it simply called `start` again for
   * the same address: `supersedeLiveAttempts` retired the old row and the new one
   * arrived with `otpSentCount` at zero. Five codes became five codes *per attempt*,
   * and attempts were free. Keyed on the recipient, there is no attempt to reset:
   * the address has one budget however many registrations are started for it.
   */
  private async sendOtp(registration: Registration): Promise<Registration> {
    if (registration.otpSentCount >= OTP.MAX_SENDS) {
      throw new ProblemException({
        type: ERR.OTP_SEND_LIMIT_REACHED,
        detail: 'Too many codes requested for this registration. Start again.',
      });
    }

    const remaining = await this.cache.cooldownRemaining(KEYS.rate.otpResend(registration.id));
    if (remaining > 0) {
      throw new ProblemException({ type: ERR.OTP_RESEND_TOO_SOON, retryAfterSeconds: remaining });
    }

    const code = generateOtp();
    const otpExpiresAt = secondsFromNow(OTP.TTL_SECONDS);
    const otpHash = pepperedHash(code, 'otp');

    // Cooldown first, quota second: a caller hammering during the cooldown should not
    // burn budget, and the quota should mean "codes sent" rather than "attempts to
    // send".
    const mailCharge = await chargeOtpMail(this.quota, registration.emailLower);

    // One compensation scope from the charge onwards — see `start` for why. Here the
    // unprotected statements were `recordOtpSent` and `startCooldown`: a failure in
    // either left the address's budget one send poorer for a code that was never
    // queued, and in the `startCooldown` case also left a live `otpHash` on the row
    // for a message nobody would ever receive.
    let updated: Registration | null = null;

    try {
      // Overwrites `otpHash` and resets `otpAttempts` in one update, so the previous
      // code stops verifying the instant this one exists. One row, one live code.
      updated = await this.registrations.recordOtpSent(registration.id, otpHash, otpExpiresAt);

      await this.startCooldown(registration.id);

      await this.mail.sendOtp(
        updated.email,
        code,
        otpExpiresAt,
        [
          { kind: 'registration.refund-otp-send', registrationId: registration.id },
          refundOtpMail(mailCharge),
        ],
        // Still a registration — no account, no code. See the note on the first send.
        null,
      );
    } catch (error) {
      await this.compensate(async () => {
        await this.registrations.invalidateOtp(registration.id, otpHash);
        // Only if `recordOtpSent` actually landed — otherwise the row's count was
        // never incremented and refunding it would give back a send nobody took.
        if (updated !== null) await this.registrations.refundOtpSend(registration.id);
        await this.cache.clear(KEYS.rate.otpResend(registration.id));
        await this.quota.refund(mailCharge, 'durable');
      });
      throw error;
    }

    return updated;
  }

  /**
   * Undo the charge for a send that never left. Clears the cooldown too, so the
   * user can retry immediately rather than waiting out a minute for a code that
   * was never coming.
   */
  private async refundOtpSend(registrationId: string): Promise<void> {
    await this.registrations.refundOtpSend(registrationId);
    await this.cache.clear(KEYS.rate.otpResend(registrationId));
  }

  private async startCooldown(registrationId: string): Promise<void> {
    await this.cache.startCooldown(
      KEYS.rate.otpResend(registrationId),
      OTP.RESEND_COOLDOWN_SECONDS,
    );
  }

  // ─── step: verify-email ───────────────────────────────────────────────────

  /**
   * Check the code.
   *
   * Expiry is tested before the comparison, and the attempt counter is incremented
   * before the comparison too — so a wrong guess costs an attempt even if the
   * request is abandoned mid-flight, and a caller cannot get unlimited guesses by
   * racing.
   */
  async verifyEmail(secret: string, input: RegisterVerifyEmailRequest): Promise<Registration> {
    const registration = await this.load(secret, 'verify-email');

    if (registration.otpHash === null || registration.otpExpiresAt === null) {
      throw new ProblemException({ type: ERR.OTP_EXPIRED });
    }
    if (registration.otpExpiresAt.getTime() <= Date.now()) {
      throw new ProblemException({ type: ERR.OTP_EXPIRED });
    }
    if (registration.otpAttempts >= OTP.MAX_ATTEMPTS) {
      throw new ProblemException({ type: ERR.OTP_ATTEMPTS_EXHAUSTED });
    }

    const attempts = await this.registrations.incrementOtpAttempts(registration.id);

    if (!safeEqual(pepperedHash(input.code, 'otp'), registration.otpHash)) {
      throw new ProblemException({
        type: attempts >= OTP.MAX_ATTEMPTS ? ERR.OTP_ATTEMPTS_EXHAUSTED : ERR.OTP_INVALID,
        extra: { attemptsRemaining: Math.max(0, OTP.MAX_ATTEMPTS - attempts) },
      });
    }

    // An OAuth-initiated attempt has no credential decision left to make — the
    // provider is the credential — so it lands on `CREDENTIALS_SET` and the client
    // goes straight to the country step. Same rule `beginRegistration` applies to
    // a provider-verified email; this is the branch where the provider would not
    // vouch for the address and our own code had to prove it instead.
    return this.registrations.markEmailVerified(
      registration.id,
      registration.oauthProvider !== null ? 'CREDENTIALS_SET' : 'OTP_VERIFIED',
    );
  }

  // ─── step: check-referral ─────────────────────────────────────────────────

  /**
   * Look up a referral code and, when it matches, remember it on the row.
   *
   * The ONLY writer of `referralCodeEntered`, and deliberately so. It stores a
   * code that resolves and clears one that does not, which is what lets
   * `referralApplied` mean "a real referrer is attached" — a second writer that
   * stored codes unresolved would give the same column two meanings.
   *
   * Rate-limited per registration, which is the only thing stopping this endpoint
   * being used to enumerate valid referral codes. On a miss the row is cleared
   * rather than left holding a stale code, so the last answer the user saw is the
   * one that gets applied.
   *
   * No code at all is a legitimate answer rather than a malformed request — the
   * user cleared the field, or the screen offers "skip". It takes the same
   * clearing path as a miss, which is what makes the step safe to re-send: the
   * stored code always reflects the last thing the user actually saw.
   *
   * The match is re-resolved at account creation (see `resolveReferrer` in
   * user.service.ts) rather than trusted from here, because the referrer can be
   * deleted between this call and the end of the flow.
   */
  async checkReferral(
    secret: string,
    input: RegisterCheckReferralRequest,
  ): Promise<{ registration: Registration; referrerUsername: string | null }> {
    const registration = await this.load(secret, 'check-referral');

    await this.cache.consume(
      KEYS.rate.referralCheck(registration.id),
      policy().REGISTRATION.REFERRAL_CHECK,
      // Allow on cache failure: this reads one indexed row and sends nothing, so
      // the cost of an unlimited-but-brief window is low.
      'allow',
    );

    // Nothing to look up, so no user read at all — an empty field must not cost a
    // query, and `lookupReferrer('')` would be a needless miss.
    if (input.code === undefined) {
      const cleared = await this.registrations.setReferralCode(registration.id, null);
      return { registration: cleared, referrerUsername: null };
    }

    const code = normaliseCode(input.code);
    const referrer = await this.users.lookupReferrer(code);

    const updated = await this.registrations.setReferralCode(
      registration.id,
      referrer === null ? null : code,
    );

    return { registration: updated, referrerUsername: referrer?.username ?? null };
  }

  // ─── step: credentials ────────────────────────────────────────────────────

  /**
   * Store the password decision without creating an account.
   *
   * The password is hashed immediately, but the hash stays only on this temporary
   * registration row until `country` completes the flow. A User, Credential, and
   * session therefore cannot exist for an abandoned registration.
   *
   * It carries no referral field: `check-referral` is the one writer of that
   * column, and it is reachable from both states this step can be entered from.
   */
  async setCredentials(secret: string, input: RegisterCredentialsRequest): Promise<Registration> {
    const registration = await this.load(secret, 'credentials');

    let passwordHash: string | null = null;
    if (!input.skip && input.password !== undefined) {
      // The cross-field policy check that `passwordSchema` structurally cannot do.
      // No username to compare against yet — it does not exist until the insert
      // below — so email is the only context available, which is also the one that
      // matters most here.
      this.credentials.assertPolicy(input.password, { email: registration.email });
      passwordHash = await this.credentials.hash(input.password);
    }

    return this.registrations.setCredentials(registration.id, passwordHash);
  }

  // ─── step: country ────────────────────────────────────────────────────────

  /**
   * The final step: create the account and issue its first session.
   *
   * User creation, optional password credential, OAuth link, country, and
   * completion of the registration row occur in the same database transaction.
   * Only after that commit succeeds is a session minted.
   */
  async setCountry(
    secret: string,
    input: RegisterCountryRequest,
    client: ClientContext,
  ): Promise<{ registration: Registration; session: IssuedSession }> {
    const registration = await this.load(secret, 'country');

    const geo = await this.geo.resolve(client.ip);
    const { user, credential } = await this.users.createFromRegistration({
      registration,
      passwordHash: registration.pendingPasswordHash,
      country: input.country,
      countryIp: geo.country,
      oauthName: null,
    });
    const completed = await this.registrations.findById(registration.id);
    if (completed === null) throw new ProblemException({ type: ERR.REGISTRATION_STEP_INVALID });

    // Trust is recorded before the session is issued, not after: `issue` reads the
    // live trust for this browser and stamps the window at creation. Trusting
    // afterwards would leave the just-signed refresh token on the idle window while
    // the row carried the longer one — the user would be logged out mid-week.
    if (completed.trustDevice) {
      await this.sessions.trustDeviceFor(user.id, client);
    }

    return {
      registration: completed,
      session: await this.sessions.issue(user, credential, client),
    };
  }

  // ─── step: state ──────────────────────────────────────────────────────────

  /** Read the current state, so a client can resume after a reload. Not
   *  step-guarded: reading where you are is legal from anywhere. */
  async readState(secret: string): Promise<Registration> {
    return this.loadRaw(secret);
  }

  // ─── guards ───────────────────────────────────────────────────────────────

  /**
   * Load a registration and assert the step is legal from its current state.
   *
   * The two checks are separate on purpose: an expired row and a wrong-state row
   * are different problems for a client (start again versus you already did this),
   * and collapsing them into one error would leave a stuck client with no way to
   * tell which.
   */
  private async load(secret: string, step: string): Promise<Registration> {
    const registration = await this.loadRaw(secret);

    const allowed = STEP_REQUIRES[step];
    if (allowed !== undefined && !allowed.includes(registration.state)) {
      throw new ProblemException({
        type: ERR.REGISTRATION_STEP_INVALID,
        detail: `Step '${step}' is not valid from state '${registration.state}'.`,
        extra: { state: registration.state },
      });
    }

    return registration;
  }

  /**
   * Resolve the continuation secret to its registration.
   *
   * An absent cookie, a secret that never existed, an expired row, and a
   * superseded one all arrive here and all produce the SAME `registration_not_found`.
   * That is deliberate: distinguishing them would let a caller probe which secrets
   * are live, and none of the distinctions help a legitimate client, whose only
   * available action in every case is to start again.
   */
  private async loadRaw(secret: string): Promise<Registration> {
    const registration = await this.registrations.findByContinuationHash(
      pepperedHash(secret, 'continuation'),
    );
    if (registration === null) {
      throw new ProblemException({
        type: ERR.REGISTRATION_NOT_FOUND,
        detail: 'No registration in progress. Start again.',
      });
    }

    // Expiry is evaluated on read rather than by a sweep job. There is no
    // scheduler yet, and an expired row that is never read costs nothing — but one
    // that IS read must never be usable, so the check belongs on this path.
    if (registration.expiresAt.getTime() <= Date.now() && registration.completedAt === null) {
      if (registration.state !== 'EXPIRED') {
        await this.registrations.markExpired(registration.id);
      }
      throw new ProblemException({ type: ERR.REGISTRATION_EXPIRED });
    }

    return registration;
  }
}
