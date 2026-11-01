import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { LoginAttempt, LoginState, User } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { MailService } from '../../src/mail/mail.service';
import { antiPhishingCodeOf } from '../../src/settings/antiPhishing/antiPhishing.utility';
import { CacheService, KEYS, QuotaService } from '../../redis';
import { secondsFromNow } from '../../src/utils/public.utils';
import { LOGIN_FLOW, OTP, STEP_UP } from '../auth.constants';
import { policy, quotaSet } from '../limits';
import { LOGIN_STEP_REQUIRES, type ClientContext, type IssuedSession } from '../auth.types';
import {
  generateContinuationSecret,
  generateOtp,
  normaliseCode,
  normaliseEmail,
  pepperedHash,
} from '../auth.utility';
import { spendChallenge, verifyChallengeCode } from '../security/challenge';
import { ChallengeDbOperation } from '../persistence/challenge.dboperation';
import { classifyIdentifier } from '../dto/common.dto';
import { MfaService } from '../../src/2fa/mfa.service';
import { TwoFactorDbOperation } from '../../src/2fa/2fa.dboperation';
import { assertAttemptLive } from '../../src/2fa/attempt';
import type { SignInMethod } from '../../src/2fa/2fa.types';
import { BlocklistService } from './blocklist.service';
import { CredentialService } from './credential.service';
import { SessionService } from './session.service';
import { UserDbOperation, type UserWithCredential } from '../persistence/user.dboperation';
import type {
  LoginOtpRequestRequest,
  LoginOtpVerifyRequest,
  LoginPasswordRequest,
} from '../dto/login.dto';

/**
 * What a login attempt resolved to.
 *
 * ═══ EVERY IN-PROGRESS VARIANT CARRIES ITS `loginId` ═══════════════════════
 *
 * `session` is the only member without one, and that asymmetry is the type doing
 * real work rather than an oversight. A flow that has ended has no handle worth
 * returning — it was retired in the same statement that completed it — while a
 * flow that has NOT ended is useless to a client that cannot name it.
 *
 * It is on the variants rather than a parameter of the mapper because the handle
 * is not always known to the caller: `password` and `otp-request` MINT one, so
 * only this service can say what it is. Putting it here means a new in-progress
 * outcome cannot be added without deciding how a client continues from it.
 */
export type LoginResult =
  /** A flow exists and nothing has been proven on it yet. Reached only by
   *  `step:'state'` reading back a flow parked mid-OAuth. */
  | { readonly kind: 'started'; readonly loginId: string }
  | { readonly kind: 'session'; readonly session: IssuedSession }
  /** No password on this account; a code has been emailed. */
  | {
      readonly kind: 'otp_required';
      readonly loginId: string;
      readonly resendAvailableAt: Date | null;
    }
  /** A code was sent, or silently was not. Indistinguishable by design — which
   *  includes the handle: one is returned either way, or the next step would
   *  answer differently for a real address than for an unknown one. */
  | {
      readonly kind: 'otp_sent';
      readonly loginId: string;
      readonly resendAvailableAt: Date | null;
    }
  /**
   * The first factor was accepted and this account has a second. NO session was
   * issued — the caller's existing `loginId` now names a half-authenticated
   * sign-in, and `POST /auth/2fa/verify` completes it.
   *
   * No handle in this variant, deliberately. It used to carry a freshly minted
   * `mfaToken`; the flow row is promoted in place now, so the client continues
   * with the value the first factor returned to it.
   *
   * Only reachable for an account that has enrolled. 2FA is opt-in, so a client
   * that never handles this variant is still correct for every user who has not
   * turned it on.
   */
  | {
      readonly kind: 'mfa_required';
      readonly loginId: string;
      readonly methods: readonly SignInMethod[];
      readonly expiresAt: Date;
    };

/** A live flow plus the plaintext handle naming it, as `openFlow` returns them.
 *  The plaintext exists only here and in the response — at rest there is a hash. */
export interface StartedFlow {
  readonly loginId: string;
  readonly attempt: LoginAttempt;
}

@Injectable()
export class LoginService {
  private readonly logger = new Logger('LoginService');

  constructor(
    private readonly users: UserDbOperation,
    private readonly challenges: ChallengeDbOperation,
    private readonly credentials: CredentialService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly cache: CacheService,
    private readonly quota: QuotaService,
    private readonly blocklist: BlocklistService,
    // The gate between a proven first factor and a session. Provided by
    // `TwoFactorCoreModule`, which deliberately depends on nothing in `auth` — see
    // the note there for why the 2FA feature is two Nest modules.
    private readonly mfa: MfaService,
    // The flow row itself. Provided by the same core module as `MfaService`, for
    // the same reason: it depends on nothing in `auth`, so reaching for it here
    // does not make the two modules a cycle.
    private readonly attempts: TwoFactorDbOperation,
  ) {}

  // ─── the flow handle ──────────────────────────────────────────────────────

  /**
   * ═══ THE ONE PLACE A LOGIN FLOW COMES INTO EXISTENCE ══════════════════════
   *
   * Mint the handle, write the row, hand both back. Every entry point calls this
   * and nothing else creates a `LoginAttempt`, so the entropy, the hash domain,
   * the recorded context and the expiry have exactly one definition.
   *
   * ─── When callers must call it ────────────────────────────────────────────
   *
   * AFTER their own rate limiter has been charged, and as late as they usefully
   * can. Both halves matter and neither is arbitrary:
   *
   *   - after the limiter, because this writes a row for a caller who has proven
   *     nothing, and a limiter charged afterwards bounds the response rather than
   *     the write;
   *   - as late as possible, because a row written before a credential is checked
   *     is a row a wrong password leaves behind. `withPassword` therefore opens
   *     the flow only once the password has actually verified.
   *
   * ─── Why it no longer meters anything itself ──────────────────────────────
   *
   * It used to, because it used to BE an endpoint: `POST /auth/login
   * {step:'start'}` presented no credential, so it needed limiters of its own or
   * it had none at all. That step is gone. Flow creation now happens inside
   * `password`, `otp-request` and `oauth-start`, each of which already charges a
   * limiter keyed on the same caller before reaching here — so charging again
   * would bill one request twice for one write. See `LOGIN_FLOW` in limits.ts.
   */
  private async openFlow(client: ClientContext): Promise<StartedFlow> {
    // 32 bytes, base64url — the same primitive and the same size as the signup
    // continuation secret and the session handle. Only its peppered hash is
    // stored, so a database dump hands over nothing that can drive a sign-in.
    const loginId = randomBytes(STEP_UP.SECRET_BYTES).toString('base64url');

    const attempt = await this.attempts.createFlow({
      tokenHash: pepperedHash(loginId, 'mfa'),
      ipClass: client.ipClass,
      deviceFingerprint: client.deviceKey,
      userAgent: client.userAgent,
      // Absolute, from this moment. The clock starts when the first real login
      // request opens the flow — not when a page was rendered — so a user who
      // leaves a login form open all afternoon still gets the full window once
      // they actually submit it.
      expiresAt: secondsFromNow(LOGIN_FLOW.TTL_SECONDS),
    });

    return { loginId, attempt };
  }

  /**
   * Open a flow for the OAuth entry point.
   *
   * `OauthService` owns the provider quotas and the state stash but not the
   * handle, and this keeps it that way: it passes this in as the thing to call
   * once its own limiters have been charged and before it parks the state. The
   * alternative — giving that service its own copy of the three lines above —
   * would put the byte count and the hash domain in two places.
   */
  openFlowFor(client: ClientContext): Promise<StartedFlow> {
    return this.openFlow(client);
  }

  /**
   * ═══ THE GATE EVERY CONTINUATION STEP GOES THROUGH ════════════════════════
   *
   * Resolve the `loginId` to its row, prove the row is still usable, and prove the
   * caller is the one who opened it.
   *
   * All three in one method, and every branch of the controller uses it, because
   * the failure mode of the alternative is silent: a step that resolved its own
   * row would work perfectly while skipping a check, and nothing would report it
   * until somebody noticed the flow could be short-circuited.
   *
   * ─── One answer for three different failures ───────────────────────────────
   *
   * Forged, already spent, and superseded all answer `mfa_token_invalid`.
   * Distinguishing them would tell a caller whether a handle was ever valid, which
   * is the one thing a holder of a guessed handle would like to know. Expiry is
   * the deliberate exception: it answers `mfa_expired`, because a legitimate user
   * who took too long needs to be told to start again rather than to retry.
   *
   * A MISSING handle never reaches here — `loginId` is required by the DTO, so
   * `parseDto` answers `validation_failed` first. That is the honest description
   * once the value is a body field rather than a cookie the browser attaches
   * invisibly: nothing was sent, so the request is malformed.
   */
  async resolveFlow(loginId: string, client: ClientContext): Promise<LoginAttempt> {
    // Fail-open, unlike the entry-point limiters that guard flow CREATION. This
    // guards a read whose real defence is 256 bits of entropy, so refusing every
    // in-flight sign-in during a cache outage would cost far more than the attack
    // it prevents.
    await this.cache.consume(
      KEYS.rate.loginResolveByIp(client.ip),
      policy().LOGIN_FLOW.RESOLVE_BY_IP,
      'allow',
    );

    const attempt = await this.attempts.findAttemptByTokenHash(pepperedHash(loginId, 'mfa'));
    if (attempt === null) {
      throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
    }

    try {
      assertAttemptLive(attempt);
    } catch (err) {
      // Retire it as we refuse it, so a stale row stops occupying the unique
      // partial index and a retry gets the same clean answer as the first try.
      await this.attempts.expireAttempt(attempt.id);
      throw err;
    }

    // The same device and network that opened the flow, for the whole flow rather
    // than only its second factor. `MfaService` owns this comparison because it
    // owns the policy switch and the warning log; duplicating it here would be a
    // second copy to keep in step. A mismatch refuses WITHOUT retiring the row —
    // otherwise anyone holding a copied handle could kill a victim's live sign-in.
    this.mfa.assertSameContext(attempt, client);

    return attempt;
  }

  /**
   * Describe a flow's own progress, for `step:'state'`.
   *
   * Lives here rather than in the controller because answering it properly needs
   * the account's CURRENT factors, and the controller has no `MfaService`. An
   * earlier version filled `methods` with an empty array from the row alone,
   * which typechecked, read plausibly, and told a client that had lost its place
   * that there was nothing it could prove — the precise situation this step
   * exists to rescue.
   *
   * The methods are resolved fresh rather than remembered from when the ceremony
   * opened, so a factor removed mid-sign-in stops being offered.
   */
  async describeFlow(flow: LoginAttempt, loginId: string): Promise<LoginResult> {
    if (flow.state === 'FACTOR_REQUIRED' && flow.userId !== null) {
      return {
        kind: 'mfa_required',
        loginId,
        methods: await this.mfa.availableMethods(flow.userId),
        expiresAt: flow.expiresAt,
      };
    }

    if (flow.state === 'OTP_SENT') {
      // No `resendAvailableAt`: the cooldown lives in Redis against the account,
      // and a state read must not need one — it is a read of the flow, and an
      // unresolvable identifier must not make it fail.
      return { kind: 'otp_sent', loginId, resendAvailableAt: null };
    }

    // STARTED. The only way to see this is a flow parked mid-OAuth: the provider
    // round trip leaves the row untouched, so a client returning to a fresh page
    // can read back that its sign-in is still open and nothing has been proven.
    return { kind: 'started', loginId };
  }

  /**
   * Retire a flow that is not going to become a session.
   *
   * One caller: `oauth-register`, where the provider identity turns out to belong
   * to nobody and the answer is "create an account" rather than "you are signed
   * in". The sign-in is over, so its handle should stop working immediately rather
   * than sitting live until `LOGIN_FLOW.TTL_SECONDS` runs out — the caller is
   * being handed a `signupId` and has no further use for the other one.
   *
   * Deliberately not an error path. Nothing went wrong; this is a flow reaching a
   * terminal state that is not `COMPLETED`, which is exactly what EXPIRED already
   * means for a superseded or abandoned one.
   */
  async abandonFlow(flow: LoginAttempt): Promise<void> {
    await this.attempts.expireAttempt(flow.id);
  }

  /**
   * Refuse a step the flow's current state does not allow.
   *
   * Separate from `resolveFlow` so the two reasons a request is refused stay
   * distinguishable in the code as well as on the wire: `resolveFlow` answers
   * "this handle is not usable", this answers "this handle is fine, but not for
   * that". A client seeing the second one should re-read its state, not restart.
   *
   * Fails CLOSED on a step it does not recognise. A step added to the DTO without
   * a `LOGIN_STEP_REQUIRES` entry is refused on its first request rather than
   * quietly running from any state at all.
   */
  assertLoginStep(attempt: LoginAttempt, step: string): void {
    const allowed = LOGIN_STEP_REQUIRES[step];
    if (allowed === undefined || !allowed.includes(attempt.state)) {
      throw new ProblemException({
        type: ERR.MFA_STEP_INVALID,
        detail: `Step '${step}' is not valid from state '${attempt.state}'.`,
        extra: { state: attempt.state },
      });
    }
  }

  /**
   * Password login.
   *
   * The account is resolved from one identifier — email, username, or public code —
   * because the product shows one input box.
   *
   * ─── On the passwordless case ────────────────────────────────────────────
   *
   * An account with no `Credential` row returns `otp_required`, which does tell a
   * caller that this address exists and has no password. That disclosure is a
   * deliberate product decision: set-password is skippable, so those accounts
   * need a signposted way in, and silently returning `invalid_credentials` would
   * strand them. Everything else on this path is kept indistinguishable — a
   * non-existent account and a wrong password produce the identical response.
   */
  async withPassword(input: LoginPasswordRequest, client: ClientContext): Promise<LoginResult> {
    // The flood ceiling, charged on EVERY call before any work is done. It bounds what
    // the endpoint costs us and says nothing about whether the caller succeeded.
    await this.chargeLoginFlood(client.ip);

    const found = await this.resolve(input.identifier);

    if (found === null) {
      // No such account. Charged against the enumeration bucket rather than the
      // failure buckets: a person mistypes their own address occasionally, a scanner
      // walks a list and misses almost every time, and those deserve different
      // ceilings.
      //
      // Same error and no timing tell worth chasing here: the dominant cost on the
      // real path is argon2, and the rate limit is what actually bounds an attacker.
      await this.chargeUnknownIdentifier(client.ip);
      throw new ProblemException({ type: ERR.INVALID_CREDENTIALS });
    }

    await this.assertUsable(found.user);

    if (found.credential === null) {
      const resendAvailableAt = await this.issueLoginOtp(found.user, client);
      // A flow IS opened on this branch, even though the caller asked for a
      // password login: what happens next is `otp-verify`, which is a
      // continuation and needs a handle to resolve. It moves straight to
      // OTP_SENT, and recording the address is what lets the verify step stop
      // asking for it.
      const { loginId, attempt } = await this.openFlow(client);
      await this.attempts.markOtpSent(attempt.id, found.user.emailLower);
      return { kind: 'otp_required', loginId, resendAvailableAt };
    }

    // Throws `account_locked` when the credential is locked, which is a distinct
    // and useful answer — refusing to say so would leave a user retrying a correct
    // password against a lock.
    const valid = await this.credentials.checkPassword(found.credential, input.password);
    if (!valid) {
      await this.chargeFailedPassword(found.user.id, client.ip);
      throw new ProblemException({ type: ERR.INVALID_CREDENTIALS });
    }

    // The streak this bounds has demonstrably ended. Only the ACCOUNT bucket is
    // cleared: the IP and device buckets meter a caller rather than a target, and one
    // correct password says nothing about the other attempts made from that address.
    await this.cache.clear(KEYS.rate.loginFailByAccount(found.user.id));

    // ═══ THE FLOW IS OPENED HERE, NOT ON ENTRY ═══════════════════════════════
    //
    // Every refusal above returns before this line, so a wrong password, an
    // unknown identifier, a locked credential and a disabled account all leave no
    // row behind. That is deliberate and it is stricter than opening the flow at
    // the top of the method would be: the rows this table accumulates are rows
    // belonging to people who actually proved something.
    const { loginId, attempt } = await this.openFlow(client);

    return this.completeLogin(attempt, loginId, 'STARTED', found, client);
  }

  /**
   * Request an email code.
   *
   * Any active, unblocked account can receive one. That is a deliberate widening:
   * this is now both the passwordless sign-in path AND the account-recovery path
   * that replaced `POST /auth/password`'s public forgot flow.
   *
   * Stated plainly, because it is the security consequence: whoever controls the
   * email controls the account, password or not. That was already true of any
   * forgot-password flow, so it is not a regression — but it does make the mailbox
   * the single factor behind every account, which is what raises the priority of
   * 2FA. The existing protections still apply: five codes per account per hour,
   * five attempts per code.
   *
   * An address that matches nothing returns the same `otp_sent` and sends nothing,
   * so this still discloses no more than `withPassword` already does.
   */
  async requestOtp(
    /** The flow to resend on, or null to open one. See `otpRequestSchema`. */
    existing: LoginAttempt | null,
    existingLoginId: string | null,
    input: LoginOtpRequestRequest,
    client: ClientContext,
  ): Promise<LoginResult> {
    // The endpoint guard, and only that: it bounds resolution of identifiers that
    // match nothing, which is work this endpoint does before it knows whether a
    // code is owed. The budget for codes actually SENT lives in `issueLoginOtp`,
    // where both callers pay it.
    //
    // Three keys now, not one. An identifier bucket meters one target at a time, so a
    // caller walking a list of addresses paid nothing at all — every request landed
    // in a different bucket. The IP and device buckets are what meter the CALLER, and
    // they apply whether or not the identifier resolves to anything, so this endpoint
    // cannot be used to tell the difference.
    //
    // Deny on cache failure: this path can send email.
    await this.quota.consumeAll(
      [
        {
          key: KEYS.rate.loginOtpByIdentifier(input.identifier),
          rule: policy().LOGIN_OTP.REQUEST_BY_IDENTIFIER,
        },
        { key: KEYS.rate.loginOtpByIp(client.ip), rule: policy().LOGIN_OTP.REQUEST_BY_IP },
        {
          key: KEYS.rate.loginOtpByDevice(client.deviceKey),
          rule: policy().LOGIN_OTP.REQUEST_BY_DEVICE,
        },
      ],
      'burst',
      'deny',
    );

    const found = await this.resolve(input.identifier);
    const eligible =
      found !== null &&
      // No `credential === null` here any more, and removing it is half of one
      // change: email OTP is now a universal sign-in method, because it is also
      // the recovery path that replaced forgot-password. Keeping the gate while
      // deleting that route would leave a user who forgets their password with no
      // way back into their account, ever.
      found.user.status === 'ACTIVE' &&
      // Folded into eligibility rather than asserted, so a blocked account is
      // refused the code without becoming distinguishable from an address that
      // matches nothing. `assertUsable` would throw here and undo the one
      // property this endpoint exists to preserve.
      !(await this.blocklist.isBlocked(found.user.emailLower));

    // ═══ THE FLOW ADVANCES WHETHER OR NOT AN ACCOUNT EXISTS ═════════════════
    //
    // This is the whole reason `identifierLower` is recorded even when it matched
    // nothing. The endpoint's contract is that a real address and an unknown one
    // are indistinguishable, and that contract does not end with this response —
    // if only the eligible branch advanced the row, the NEXT step would answer
    // `mfa_step_invalid` for an unknown address and `otp_invalid` for a real one,
    // handing back exactly the distinction this response was careful not to make.
    //
    // Normalised through `normaliseEmail` rather than stored as typed, so a
    // resend that capitalises differently lands on the same row. For a username or
    // public code the normalised identifier is what was looked up anyway.
    //
    // Opened here rather than on entry so a rate-limited request writes nothing —
    // the quotas above have already been charged by the time this runs. A resend
    // reuses the row it was given instead, which is the whole reason `loginId` is
    // optional on this step.
    const opened = existing === null ? await this.openFlow(client) : null;
    const flowId = opened?.attempt.id ?? (existing as LoginAttempt).id;
    const loginId = opened?.loginId ?? (existingLoginId as string);

    await this.attempts.markOtpSent(flowId, normaliseEmail(input.identifier));

    if (!eligible) {
      return { kind: 'otp_sent', loginId, resendAvailableAt: null };
    }

    const resendAvailableAt = await this.issueLoginOtp(found.user, client);
    return { kind: 'otp_sent', loginId, resendAvailableAt };
  }

  /**
   * Verify an email code and issue a session.
   *
   * Same attempt discipline as registration: expiry first, then the attempt
   * counter, then a constant-time comparison, then a compare-and-swap consume so
   * one code cannot mint two sessions.
   */
  async verifyOtp(
    flow: LoginAttempt,
    loginId: string,
    input: LoginOtpVerifyRequest,
    client: ClientContext,
  ): Promise<LoginResult> {
    await this.chargeLoginFlood(client.ip);

    // ═══ THE IDENTIFIER COMES FROM THE ROW, NOT FROM THE REQUEST ════════════
    //
    // This used to read `input.identifier`, and that was the defect. An address in
    // a request body names an account and proves nothing about the sender, so a
    // caller who had legitimately requested a code for their own address could
    // present it against somebody else's — the pairing was only ever checked
    // against what the body claimed.
    //
    // `flow.identifierLower` was written by `otp-request` on this same row, under
    // this same handle. The client cannot influence it, so the code and the
    // account it was sent to can no longer be separated.
    //
    // Null is unreachable: OTP_SENT is only entered by `markOtpSent`, which writes
    // the column in the same statement, and `LOGIN_STEP_REQUIRES` admits this step
    // from no other state. Treated as an invalid code rather than a server error,
    // because that is what a client can act on.
    if (flow.identifierLower === null) {
      throw new ProblemException({ type: ERR.OTP_INVALID });
    }

    const found = await this.resolve(flow.identifierLower);
    if (found === null) {
      // The address never matched an account. Reached because `otp-request`
      // advances the flow for unknown addresses too — see the note there — so this
      // is the point at which that pretence ends, with the same generic answer a
      // wrong code gets.
      //
      // No enumeration charge here any more. The identifier was fixed when the
      // flow was opened and cannot be varied per request, so this step can no
      // longer be used to walk a list; the charge belongs on `otp-request`, which
      // is where the address is now chosen.
      throw new ProblemException({ type: ERR.OTP_INVALID });
    }
    await this.assertUsable(found.user);

    const challenge = await verifyChallengeCode(
      this.challenges,
      found.user.id,
      'LOGIN_OTP',
      input.code,
    );

    // Nothing between verify and spend on this path — a login has no equivalent
    // of reset's policy check, so the code is spent the moment it is proven.
    await spendChallenge(this.challenges, challenge.id);

    return this.completeLogin(flow, loginId, 'OTP_SENT', found, client);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /**
   * One identifier, three possible columns.
   *
   * `classifyIdentifier` decides which; a value that classifies as a username but
   * matches nothing simply returns null, which the callers turn into the same
   * generic failure as a wrong password.
   */
  private async resolve(identifier: string): Promise<UserWithCredential | null> {
    const kind = classifyIdentifier(identifier);

    let user: User | null;
    switch (kind) {
      case 'email':
        user = await this.users.findByEmail(normaliseEmail(identifier));
        break;
      case 'publicCode':
        user = await this.users.findByPublicCode(normaliseCode(identifier));
        break;
      case 'username':
        user = await this.users.findByUsername(identifier.trim().toLowerCase());
        break;
    }

    if (user === null) return null;
    return this.users.findWithCredential(user.id);
  }

  /**
   * Both reasons an account that exists may still not sign in.
   *
   * One method rather than two calls, because the two checks have to travel
   * together. Every path that resolves an account has to ask both questions, and
   * a path that asked only about `status` would be a door the blocklist does not
   * cover — silently, and discovered only by someone walking through it.
   *
   * Both answers disclose that the account exists, which is the same trade
   * `ACCOUNT_DISABLED` already made here deliberately: a user turned away needs to
   * know they are being turned away, rather than being left retrying a password
   * that was never the problem. The paths where that trade is NOT acceptable do
   * not call this — see `requestOtp`.
   */
  private async assertUsable(user: User): Promise<void> {
    if (user.status !== 'ACTIVE') {
      throw new ProblemException({ type: ERR.ACCOUNT_DISABLED });
    }
    await this.blocklist.assertNotBlocked(user.emailLower);
  }

  /**
   * Issue and email a login code. Returns when a resend becomes possible, or null
   * if one can be sent immediately.
   *
   * ─── Why both limits live here and not at the call sites ──────────────────
   *
   * Two paths reach this sender: `requestOtp`, where a code is what the caller
   * asked for, and `withPassword`, which falls through to one when the account
   * turns out to have no password. Only the first used to meter anything, so a
   * junk password submitted against a passwordless account emailed a real code
   * every sixty seconds — around forty an hour, against a documented cap of five.
   * A limit that guards a resource belongs next to the resource, not next to one
   * of the doors that reaches it.
   *
   * The budget is keyed on the account rather than on the identifier the caller
   * typed, so email, username and public code cannot each carry their own five.
   *
   * Cooldown first, budget second: a caller hammering during the cooldown should
   * not burn budget, and the counter should mean "codes sent" rather than
   * "attempts to send".
   *
   * ─── What the return value can and cannot say now ─────────────────────────
   *
   * It used to answer `null` — "retry whenever you like" — when the send failed,
   * because it awaited the result. Dispatch is non-blocking now, so at the moment
   * this returns nobody knows yet, and it reports the cooldown optimistically.
   *
   * The consequence is worth stating precisely, because it is a real regression in
   * one direction and a non-issue in the other: a user whose mail failed is told to
   * wait sixty seconds, and can in fact retry sooner than that, because the undo
   * clears the cooldown behind them. They are told to wait too long, never too
   * little — and the budget they were charged is still handed back.
   */
  private async issueLoginOtp(user: User, client: ClientContext): Promise<Date | null> {
    const cooldownKey = KEYS.rate.loginOtpCooldown(user.emailLower);
    const lockKey = KEYS.rate.loginOtpLock(user.emailLower);
    const lockValue = generateContinuationSecret();

    // The cooldown read, budget charge, challenge replacement, and queue handoff
    // must be one critical section per recipient. Without this lease two concurrent
    // requests can both observe no cooldown and each replace the other’s OTP.
    const acquired = await this.cache.setIfAbsent(lockKey, lockValue, 30);
    if (!acquired) return secondsFromNow(OTP.RESEND_COOLDOWN_SECONDS);

    try {
      return await this.issueLoginOtpLocked(user, client, cooldownKey);
    } finally {
      await this.cache.clearIfValue(lockKey, lockValue);
    }
  }

  private async issueLoginOtpLocked(
    user: User,
    client: ClientContext,
    cooldownKey: string,
  ): Promise<Date | null> {

    const remaining = await this.cache.cooldownRemaining(cooldownKey);
    if (remaining > 0) {
      return secondsFromNow(remaining);
    }

    // The mail budget: the short window and the rolling day, atomically, on the
    // DURABLE instance. Durable because this is a cost quota rather than a request
    // counter — a cache restart that hands every address a fresh day's worth of mail
    // is not a budget. Atomic because "5 per 15 minutes AND 25 per day" is one
    // decision, and two round trips would let a caller pass the first, be charged, and
    // then be refused by the second.
    //
    // Deny on cache failure: this sends email, and unlike the password paths there
    // is no durable counter in Postgres backing it up.
    const mailCharge = await this.quota.consumeAll(
      quotaSet(
        policy().LOGIN_OTP.MAIL_BY_ACCOUNT,
        KEYS.rate.loginOtpSendByAccount(user.emailLower),
        KEYS.rate.loginOtpSendByAccountDaily(user.emailLower),
      ),
      'durable',
      'deny',
    );

    const code = generateOtp();
    // Shared between the challenge row and the queued message, so the deadline the
    // worker enforces is the same instant the verifier enforces.
    const expiresAt = secondsFromNow(OTP.TTL_SECONDS);
    const codeHash = pepperedHash(code, 'otp');

    // ─── One compensation scope, covering everything after the charge ─────────
    //
    // The `try` used to begin at the enqueue. `challenges.issue` and `startCooldown`
    // sat between the charge and it, so a Postgres or Redis failure in either spent a
    // slot from the account's send budget for a code that never reached the queue —
    // and in the `startCooldown` case also left an orphan `LOGIN_OTP` challenge row
    // holding a live hash for a message nobody would ever receive.
    //
    // That matters most on a passwordless account, where email OTP is the only way in:
    // five such failures and the user is locked out of their own account for the rest
    // of the window, having seen no error at any point.
    //
    // `challenge` is tracked so the catch can retire exactly the row this attempt
    // created, and only if it created one.
    let challengeId: string | null = null;

    try {
      const challenge = await this.challenges.issue({
        userId: user.id,
        purpose: 'LOGIN_OTP',
        codeHash,
        expiresAt,
        ipAddress: client.ip,
      });
      challengeId = challenge.id;

      await this.cache.startCooldown(cooldownKey, OTP.RESEND_COOLDOWN_SECONDS);

      // Our outage, not their attempt. Left charged, a user on a passwordless account
      // burns all five sends retrying, receives nothing, sees no error, and is locked
      // out of their own account for an hour. The undo hands back both the cooldown
      // and the budget slot so the next attempt is free to succeed.
      //
      // Descriptors, not a closure. The compensation travels WITH the message on a
      // durable queue, so it survives the process dying between "we told the user a
      // code was sent" and the relay accepting it.
      //
      // Two undos because two separate mechanisms were charged: the resend cooldown is
      // a key to drop, and the send budget is a counter to decrement. A user who
      // received nothing is owed both back.
      await this.mail.sendOtp(user.email, code, expiresAt, [
        { kind: 'cache.clear', key: cooldownKey },
        // The budget refund carries the charge TOKEN, so running it twice returns one
        // slot rather than two. The `cache.refund` it replaced was a DECR, and a
        // duplicated compensation there was a way to mint quota by breaking delivery.
        {
          kind: 'quota.refund',
          token: mailCharge.token,
          keys: mailCharge.keys,
          store: 'durable',
        },
      ],
      // From the `user` row this flow already resolved to look up the credential — no
      // extra query on the sign-in path.
      antiPhishingCodeOf(user),
    );
    } catch (error) {
      const issued = challengeId;
      await this.compensate(async () => {
        if (issued !== null) await this.challenges.invalidateIfHash(issued, codeHash);
        await this.cache.clear(cooldownKey);
        await this.quota.refund(mailCharge, 'durable');
      });
      throw error;
    }

    return secondsFromNow(OTP.RESEND_COOLDOWN_SECONDS);
  }

  /**
   * Run a compensation without letting it replace the failure that caused it.
   *
   * These paths run when Redis or Postgres is already misbehaving, which is precisely
   * when the compensation itself is most likely to throw. Letting it propagate would
   * report a failed refund to the caller instead of the failure that made a refund
   * necessary, and the root cause would never appear in a log.
   */
  private async compensate(undo: () => Promise<void>): Promise<void> {
    try {
      await undo();
    } catch (err) {
      this.logger.error({ err }, 'compensation after a failed login-OTP send did not complete');
    }
  }

  /**
   * ═══ THE GATE ═══════════════════════════════════════════════════════════════
   *
   * The one place both login paths turn a proven first factor into a session, and
   * therefore the one place the second factor can be enforced for both.
   *
   * `challengeFor` answers `null` for an account with nothing enrolled, and that
   * `null` is what makes 2FA opt-in rather than a migration: the overwhelming
   * majority of sign-ins take the same branch they always took, in one round trip,
   * with the same response shape.
   *
   * When it answers a challenge, NO session is issued and `touchLastSeen` does not
   * run — the sign-in has not happened yet. Both move to `POST /auth/2fa/verify`.
   *
   * ─── On the departed `linkToken` ───────────────────────────────────────────
   *
   * This method used to attach a pending OAuth identity when a `linkToken` rode
   * along on the login body. It no longer can, and the removal IS the fix: linking
   * writes a credential that outlives a password change, a session sweep and an
   * email change, so it must not be a side effect of presenting one factor.
   * Attaching a provider is now its own re-authenticated write — see
   * `POST /auth/link` and `ELEVATION_ACTIONS`.
   */
  private async completeLogin(
    flow: LoginAttempt,
    loginId: string,
    from: LoginState,
    found: UserWithCredential,
    client: ClientContext,
  ): Promise<LoginResult> {
    // Promotes the flow in place when a factor is owed — no second handle is
    // minted, so the client continues with the `loginId` it already holds. `from`
    // is the state the first factor was proven in, and it is passed rather than
    // read off the row so the promotion is a compare-and-swap against what the
    // caller actually saw.
    const challenge = await this.mfa.challengeFor(flow, found.user.id, from);
    if (challenge !== null) {
      // The handle travels back with the challenge. This is the ONLY response on
      // the password path that carries one: a sign-in that finishes in a single
      // request has nothing left to continue, so it returns a session and no
      // handle at all.
      return { kind: 'mfa_required', loginId, ...challenge };
    }

    // No second factor owed, so this flow ends here. Completing the row is what
    // retires the handle: the same compare-and-swap the 2FA path uses, nulling the
    // hash in the statement that sets `completedAt`.
    //
    // The account is attached first. A flow that minted a session while still
    // saying it belonged to nobody would be a row that cannot be audited, and
    // `promoteAttempt` is the only writer of `userId`.
    if (
      !(await this.attempts.promoteAttempt({
        id: flow.id,
        userId: found.user.id,
        from,
        to: 'FACTOR_REQUIRED',
      }))
    ) {
      throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
    }
    if (!(await this.attempts.completeAttempt(flow.id))) {
      // Lost the swap: something else completed this flow between the promotion
      // and here. Refused rather than retried — the alternative is two sessions
      // from one first factor.
      throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
    }

    const session = await this.sessions.issue(found.user, found.credential, client);
    await this.users.touchLastSeen(found.user.id);
    return { kind: 'session', session };
  }

  /**
   * ═══ THREE BUCKETS, THREE MOMENTS ═════════════════════════════════════════
   *
   * The endpoint used to charge one bucket on entry, before the password had been
   * checked, and that was the defect. A user typing their own password CORRECTLY
   * spent the same quota as an attacker guessing wrong — so signing in eleven times
   * in a quarter of an hour got the person the limit exists to protect thrown out.
   * A failure quota has to be charged after a failure is confirmed, or it is not
   * measuring failures.
   *
   * Splitting it also makes each bucket answerable. "Sixty calls from this address"
   * is a capacity question; "five wrong passwords for this account" is a compromise
   * question; "thirty identifiers that matched nothing" is an enumeration question.
   * One counter answering all three answers none of them.
   *
   * `allow` on cache failure throughout: `Credential.failedAttempts` and
   * `lockedUntil` live in Postgres and keep enforcing lockout with Redis completely
   * down, so none of these is the only line of defence.
   */

  /** Every call to the endpoint, charged before any work. */
  private async chargeLoginFlood(ip: string): Promise<void> {
    await this.cache.consume(
      KEYS.rate.loginFloodByIp(ip),
      policy().PASSWORD_LOGIN.FLOOD_BY_IP,
      'allow',
    );
  }

  /** An identifier that resolved to nothing. */
  private async chargeUnknownIdentifier(ip: string): Promise<void> {
    await this.cache.consume(
      KEYS.rate.loginUnknownByIp(ip),
      policy().PASSWORD_LOGIN.UNKNOWN_BY_IP,
      'allow',
    );
  }

  /**
   * A wrong password, confirmed.
   *
   * Keyed on the resolved account ID rather than on whatever string the caller
   * typed. One account is reachable as an email, a username and a public code, so an
   * identifier-keyed bucket silently gave every account three separate allowances —
   * and casing or an address alias would have split them further still.
   */
  private async chargeFailedPassword(userId: string, ip: string): Promise<void> {
    await this.cache.consume(
      KEYS.rate.loginFailByAccount(userId),
      policy().PASSWORD_LOGIN.FAIL_BY_ACCOUNT,
      'allow',
    );
    await this.cache.consume(
      KEYS.rate.loginFailByIp(ip),
      policy().PASSWORD_LOGIN.FAIL_BY_IP,
      'allow',
    );
  }
}
