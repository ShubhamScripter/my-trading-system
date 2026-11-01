/**
 * The error catalogue. Every failure this service reports is one of these slugs,
 * and the slug is what a client switches on — never the HTTP status, never the
 * message text, both of which are allowed to change.
 *
 * Adding an entry here is the only way to add an error to the API. That is the
 * point: it keeps the failure surface enumerable, so the frontend can be
 * exhaustive about what it handles, and it stops a stray `throw new Error` from
 * becoming a de-facto contract.
 */

export const ERR = {
  // ─── generic ──────────────────────────────────────────────────────────────
  VALIDATION_FAILED: 'validation_failed',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',

  // ─── captcha ──────────────────────────────────────────────────────────────
  CAPTCHA_FAILED: 'captcha_failed',
  CAPTCHA_PROVIDER_UNKNOWN: 'captcha_provider_unknown',
  CAPTCHA_PROVIDER_UNAVAILABLE: 'captcha_provider_unavailable',

  // ─── registration ─────────────────────────────────────────────────────────
  /** Deliberate account enumeration: the product asks that the signup screen say
   *  the address is unavailable and offer a password reset. */
  EMAIL_ALREADY_REGISTERED: 'email_already_registered',
  /** A known disposable ("temp-mail") domain. Distinct from `validation_failed`
   *  because the address is well-formed — the screen has to say "use a permanent
   *  address", not "that looks wrong". */
  EMAIL_DOMAIN_BLOCKED: 'email_domain_blocked',
  REGISTRATION_NOT_FOUND: 'registration_not_found',
  REGISTRATION_EXPIRED: 'registration_expired',
  /** The requested step is not legal from the registration's current state. */
  REGISTRATION_STEP_INVALID: 'registration_step_invalid',
  OTP_INVALID: 'otp_invalid',
  OTP_EXPIRED: 'otp_expired',
  OTP_ATTEMPTS_EXHAUSTED: 'otp_attempts_exhausted',
  OTP_RESEND_TOO_SOON: 'otp_resend_too_soon',
  OTP_SEND_LIMIT_REACHED: 'otp_send_limit_reached',
  PASSWORD_WEAK: 'password_weak',
  PASSWORD_MISMATCH: 'password_mismatch',
  /**
   * `action: 'set'` on an account that already has a password.
   *
   * Its own slug rather than `validation_failed` or `invalid_credentials`, because
   * nothing about the request was malformed and no credential was wrong: the caller
   * asked for the operation that CREATES a password and this account needs the one
   * that REPLACES it. A client reading this routes the user to `reset` (they know
   * their current password) or `forgot` (they do not), which is information the
   * generic slugs cannot carry.
   *
   * Also the answer when the write itself loses the race — see
   * `UserDbOperation.createPasswordIfAbsent`. Same cause, so the same slug.
   */
  PASSWORD_ALREADY_SET: 'password_already_set',
  /**
   * `action: 'reset'` or `'forgot'` on an account with no password.
   *
   * The mirror of the above, and it points the other way: use `set`. Distinct from
   * `OTP_REQUIRED`, which the legacy `POST /auth/password` returns for this case —
   * that slug's title is "Email verification code required", which describes the
   * remedy for a passwordless SIGN-IN and not this one.
   */
  PASSWORD_NOT_SET: 'password_not_set',
  /**
   * The new password is the one already in use.
   *
   * Refused rather than accepted as a no-op: a user who "changed" their password to
   * the one it already was has spent an emailed code and possibly a factor proof
   * believing something happened. Its own slug because the remedy differs from
   * `password_weak` — the password may be perfectly strong. The same argument, and
   * the same shape, as `PAYMENT_PIN_REUSED`.
   */
  PASSWORD_REUSED: 'password_reused',
  /**
   * `action: 'forgot'` on an account that has an enabled passkey or authenticator,
   * with no assertion or TOTP code presented.
   *
   * Carries `extra.methods` — which factors WOULD be accepted — so a client can
   * render the right prompt without a second call and without deciding the policy
   * itself. Not an enumeration risk: reaching this needs the account's own session,
   * so the caller is being told about their own factors.
   *
   * Distinct from `MFA_METHOD_UNAVAILABLE`, which means the opposite — the caller
   * named a method the account has NOT set up.
   */
  PASSWORD_FACTOR_REQUIRED: 'password_factor_required',
  USERNAME_GENERATION_FAILED: 'username_generation_failed',
  COUNTRY_INVALID: 'country_invalid',

  // ─── login ────────────────────────────────────────────────────────────────
  INVALID_CREDENTIALS: 'invalid_credentials',
  /** This account has no password (registration skipped it, or it was created
   *  through a provider). The email-OTP path is the way in. */
  OTP_REQUIRED: 'otp_required',
  ACCOUNT_LOCKED: 'account_locked',
  ACCOUNT_DISABLED: 'account_disabled',

  // ─── session ──────────────────────────────────────────────────────────────
  TOKEN_INVALID: 'token_invalid',
  TOKEN_EXPIRED: 'token_expired',
  SESSION_REVOKED: 'session_revoked',
  /**
   * The session ran out rather than being ended by anybody — the idle window closed.
   *
   * Distinct from `session_revoked`, which it used to be reported as, because the two
   * call for different words on screen: a revocation is somebody's deliberate act and
   * reads as a security event, while this is "you were away too long". Same 401 and
   * the same remedy; only the explanation differs. See `readLiveness`.
   */
  SESSION_EXPIRED: 'session_expired',
  /** A refresh token was presented twice. The whole family is now revoked. */
  SESSION_REUSE_DETECTED: 'session_reuse_detected',
  /**
   * Redis could not answer, so the record naming this browser's session could not be
   * read or written.
   *
   * Explicitly NOT a 401. The session is very probably fine and the thing that failed
   * is the store in front of it, so the honest answer is "retry", not "sign in again"
   * — and on logout it is the difference between reporting a revocation that happened
   * and one that could not even be attempted. It is also the one session-shaped
   * refusal that must never clear the cookies: the handle is the only value naming the
   * family, and dropping it would strand a live session nobody could revoke.
   */
  SESSION_STORE_UNAVAILABLE: 'session_store_unavailable',
  /** The `X-Orebit-Csrf` header was absent, did not match the `orebit_csrf`
   *  cookie, or was not issued for the session handle it arrived with. Only
   *  reachable on a request that authenticates with the session cookie. */
  CSRF_INVALID: 'csrf_invalid',

  // ─── second factor ────────────────────────────────────────────────────────
  //
  // None of these are reachable by an account that has not enrolled. 2FA is
  // opt-in, so a client that never shows a user this screen is still correct.

  /** The `loginId` is unknown, already spent, or names a flow that was
   *  superseded. The client has to start the sign-in again. */
  MFA_TOKEN_INVALID: 'mfa_token_invalid',
  /**
   * The `loginId` is live, but the step asked for is not legal from the state the
   * flow is actually in.
   *
   * Its own slug rather than folding into `mfa_token_invalid`, and the difference
   * is what the client should do next: an invalid handle means start over, this
   * means the client and the server disagree about where in the sign-in they are,
   * and the remedy is to re-read the flow with `step:'state'` rather than to throw
   * the flow away. Carries the server's `state` in `extra` so it can do that
   * without a second round trip.
   *
   * The registration flow's `registration_step_invalid` is the same idea on the
   * other route, down to the 409 and the `state` in `extra`.
   */
  MFA_STEP_INVALID: 'mfa_step_invalid',
  /** The sign-in took longer than `policy().MFA.CEREMONY_TTL_SECONDS`. Distinct from
   *  `mfa_token_invalid` because the remedy is the same but the message a user
   *  should read is not — "that took too long" rather than "something is wrong". */
  MFA_EXPIRED: 'mfa_expired',
  /** Wrong code. Carries `attemptsRemaining` in `extra`. */
  MFA_CODE_INVALID: 'mfa_code_invalid',
  /** `policy().MFA.PROOF_ATTEMPTS` wrong guesses. The attempt is dead; sign in again. */
  MFA_ATTEMPTS_EXHAUSTED: 'mfa_attempts_exhausted',
  /**
   * The second factor arrived from a different device or network than the first.
   *
   * Its own slug rather than folding into `mfa_token_invalid`, for the same reason
   * `oauth_context_mismatch` is separate: the two need different words on screen. An
   * invalid token means "start again, something is wrong with this sign-in"; this
   * means "we stopped this because it looked like someone else" — and it is the one
   * refusal here a legitimate user can hit by switching from wi-fi to mobile data
   * mid-ceremony. A client that cannot tell them apart cannot explain either.
   */
  MFA_CONTEXT_MISMATCH: 'mfa_context_mismatch',
  /** The caller asked to prove a method this account has not enrolled. */
  MFA_METHOD_UNAVAILABLE: 'mfa_method_unavailable',
  /** A TOTP code that was already spent for its 30-second step. Distinct from
   *  `mfa_code_invalid` on purpose: the code IS arithmetically correct, and a
   *  caller replaying one should be told so rather than left retyping it. */
  MFA_CODE_ALREADY_USED: 'mfa_code_already_used',
  /** Enrollment refused because the account already has this factor, or has as
   *  many as it may hold. */
  MFA_ALREADY_ENROLLED: 'mfa_already_enrolled',
  /** A WebAuthn ceremony whose challenge is unknown, expired, or already spent. */
  PASSKEY_CHALLENGE_INVALID: 'passkey_challenge_invalid',
  /** The authenticator's response did not verify against the challenge. */
  PASSKEY_VERIFICATION_FAILED: 'passkey_verification_failed',
  /**
   * This write needs a fresh second-factor proof that the caller did not present.
   *
   * A session says who you are; this says you proved it just now, for this. Obtain
   * a ticket from `POST /auth/2fa` with `action: 'reauth-verify'`.
   */
  REAUTH_REQUIRED: 'reauth_required',

  // ─── payment PIN ──────────────────────────────────────────────────────────
  //
  // The PIN is a security SETTING, not a sign-in factor, so none of these overlap
  // with the `mfa_*` slugs above. A client that never shows the Payment PIN screen
  // never sees one.

  /** Enable was called on an account that already has a PIN. Changing it is
   *  `action: 'update'`, which needs a verified challenge. */
  PAYMENT_PIN_ALREADY_ENABLED: 'payment_pin_already_enabled',
  /** Update, disable or a `method: 'pin'` verification on an account with no PIN. */
  PAYMENT_PIN_NOT_ENABLED: 'payment_pin_not_enabled',
  /**
   * Well-formed — six digits — but trivially guessable.
   *
   * Distinct from `validation_failed`, which is what a five-digit or non-numeric PIN
   * gets, for the same reason `password_weak` is distinct from it: the screen has to
   * say "choose something less predictable", not "that looks wrong". Carries the
   * specific reason in `detail`.
   */
  PAYMENT_PIN_WEAK: 'payment_pin_weak',
  /** The new PIN is the one already set. Its own slug because the remedy — pick a
   *  different PIN — is not the remedy for a weak one. */
  PAYMENT_PIN_REUSED: 'payment_pin_reused',
  /** The `currentPin` presented to `verify` did not match. */
  PAYMENT_PIN_INVALID: 'payment_pin_invalid',
  /**
   * The `challengeId` is unknown, expired, already spent, belongs to another account,
   * or was verified for the other operation.
   *
   * ONE slug for all five, deliberately, and for the reason `reauth_required` gives:
   * a caller holding a bad challenge learns nothing about which, and the legitimate
   * remedy is identical in every case — verify again, for this operation. Telling
   * them "that was for update, not disable" would confirm that a challenge they hold
   * is live and what it is good for.
   */
  PAYMENT_PIN_CHALLENGE_INVALID: 'payment_pin_challenge_invalid',

  // ─── anti-phishing code ───────────────────────────────────────────────────
  //
  // A display string printed in outbound mail so a reader can recognise a genuine
  // message. It is NOT a credential: nothing accepts it as proof of identity, and
  // `anti_phishing_code_incorrect` below is the only slug that reports a comparison
  // against it — on a path that a caller can bypass entirely with `action: 'replace'`.
  // See src/settings/antiPhishing/antiPhishing.types.ts.

  /** `set` was called on an account that already has a code. Changing it is
   *  `action: 'change'` if the caller knows it, `'replace'` if they do not. */
  ANTI_PHISHING_CODE_ALREADY_SET: 'anti_phishing_code_already_set',
  /** `change` or `replace` on an account with no code. `set` is the operation. */
  ANTI_PHISHING_CODE_NOT_SET: 'anti_phishing_code_not_set',
  /**
   * The `currentCode` presented to `change` did not match.
   *
   * Deliberately NOT a security refusal, and this is the one slug in this file whose
   * comment has to say so: `action: 'replace'` reaches the same write with only the
   * emailed code, so a caller who cannot produce `currentCode` is never blocked. This
   * exists so a user who believes they know their code is told they are wrong instead
   * of silently overwriting it. Nothing should ever be built on the assumption that
   * passing this check proves anything.
   */
  ANTI_PHISHING_CODE_INCORRECT: 'anti_phishing_code_incorrect',

  // ─── email change ─────────────────────────────────────────────────────────
  //
  // `email_already_registered` and `email_domain_blocked` above are reused rather than
  // duplicated here: an address held by a live account and one inside its retention
  // window are the same answer to the caller — unavailable — and a distinct slug for
  // the second would tell a stranger that somebody recently changed away from it.

  /** The requested address is the one the account already holds. Its own slug because
   *  the remedy is "pick a different address", not "that address is taken". */
  EMAIL_SAME_AS_CURRENT: 'email_same_as_current',
  /**
   * The in-flight change is unknown, expired, already completed, belongs to another
   * account or another login, names a different address than the one being claimed, or
   * was started for a different verification method.
   *
   * ONE slug for all six, for `payment_pin_challenge_invalid`'s reason: a caller
   * holding a bad challenge learns nothing about which, and the remedy is identical —
   * start again.
   */
  EMAIL_CHANGE_CHALLENGE_INVALID: 'email_change_challenge_invalid',
  /**
   * A change cannot be started at all right now — a previous address is still retained
   * and its mailbox was declared unreachable on an account with no factor strong enough
   * to stand in for it.
   */
  EMAIL_CHANGE_SECURITY_REQUIRED: 'email_change_security_required',
  /**
   * The recovery ticket is unknown, expired, already spent, or does not match the
   * retained address it names.
   *
   * Folded like the challenge slug above, and with an extra reason to be: this one is
   * reachable WITHOUT a session, so a caller distinguishing "expired" from "no such
   * ticket" would have an oracle for which addresses have recently been changed away
   * from.
   */
  EMAIL_RECOVERY_INVALID: 'email_recovery_invalid',

  // ─── username change ──────────────────────────────────────────────────────

  /**
   * The username is held by a live account, or reserved by one that released it
   * recently.
   *
   * ONE slug for both, and that is the security control rather than an economy. A
   * distinct "reserved" error would tell any caller that a specific username was
   * changed away from in the last thirty days — an oracle over other people's account
   * history, obtainable by walking a dictionary. Unavailable is unavailable; the
   * remedy is identical and so is the sentence on screen.
   *
   * The live availability check DOES distinguish them in its `reason` field, because
   * that endpoint exists to explain why a name cannot be used and says nothing about
   * whose it was. This slug is the MUTATION's refusal, where the caller has committed
   * to a name and the only useful answer is that they cannot have it.
   */
  USERNAME_UNAVAILABLE: 'username_unavailable',
  /**
   * The username does not satisfy the rules — charset, length band, reserved word.
   *
   * Distinct from `validation_failed` because the length band is not a property of the
   * request: the same string is legal for a Premium account and illegal for a free
   * one, so the refusal has to come from the service that resolved the entitlement,
   * carrying the band it applied.
   */
  USERNAME_INVALID: 'username_invalid',
  /** The requested username is the one the account already holds. `email_same_as_current`'s
   *  reasoning: the remedy is "pick a different one", not "that one is taken". */
  USERNAME_SAME_AS_CURRENT: 'username_same_as_current',
  /**
   * The free change allowance is spent, so this change costs money.
   *
   * 402, which is otherwise unused in this service, and the only correct code here: the
   * request is well-formed, the caller is authenticated and permitted, the name is
   * available, and the single thing standing between them and it is payment. `forbidden`
   * would say they may never do this and `rate_limited` would say to wait — both are
   * false, and both would send a client down the wrong recovery path.
   *
   * Carries `amountMinor` and `currency` in `extra`. The price is stated by the server
   * and never read from the request.
   */
  USERNAME_CHANGE_PAYMENT_REQUIRED: 'username_change_payment_required',

  // ─── the security cooldown after an email change ──────────────────────────

  /**
   * A high-impact security setting cannot be changed yet, because this account's email
   * address moved recently. See `SECURITY_COOLDOWN` in auth/auth.constants.ts.
   *
   * Carries `retryAfterSeconds` — and therefore a `Retry-After` header — plus
   * `availableAt` in `extra`, so a client renders "available in four hours" without
   * being handed a raw `emailChangedAt` to subtract from. The account's own timestamps
   * are not the client's business, and a client doing the arithmetic is a second copy
   * of the policy that drifts from this one.
   *
   * Its own slug rather than `forbidden` or `rate_limited`: the caller is
   * authenticated, the request is well-formed, nothing they can prove will help, and
   * the remedy is only to wait — which is a different sentence on screen from every
   * other refusal in this file.
   */
  SECURITY_CHANGE_COOLDOWN: 'security_change_cooldown',

  // ─── the temporary feature restriction after a sensitive change ───────────

  /**
   * A platform feature or sub-feature is temporarily unavailable to this account,
   * because a sensitive security action succeeded recently and the Admin-configured
   * policy for the security context it ran in restricts that feature for a while.
   * See src/restrictions/.
   *
   * Carries `retryAfterSeconds` — and therefore a `Retry-After` header — plus
   * `availableAt`, `feature` and `subFeature` in `extra`. The same envelope as
   * `SECURITY_CHANGE_COOLDOWN`, for the same reason: a client renders "available in
   * thirty minutes" and marks the one control that is unavailable, without being
   * handed the restriction row to reason about.
   *
   * ─── Why its own slug rather than SECURITY_CHANGE_COOLDOWN ─────────────────
   *
   * The two look alike and mean different things. That one says "you may not change a
   * SECURITY SETTING, because your address moved"; this says "you may not use a
   * PRODUCT FEATURE, because you changed a security setting". Opposite subjects,
   * opposite causes, and a client that showed one message for both would tell a user
   * to check their email about a withdrawal.
   *
   * ─── Why not `forbidden` ──────────────────────────────────────────────────
   *
   * `forbidden` says they may never do this. This is temporary by construction and
   * carries the instant it ends, which is the whole difference on screen.
   */
  FEATURE_RESTRICTED: 'feature_restricted',

  // ─── deleting the account ─────────────────────────────────────────────────

  /**
   * A deletion has already been requested and is inside its recovery window.
   *
   * NOT returned by the delete route, which is idempotent and answers a second click
   * with the standing deadline — re-requesting is what a double submit looks like, and
   * refusing it would make a harmless retry look like a failure while costing the user
   * another emailed code. This is for the paths that need the account NOT to be
   * pending deletion before they act.
   */
  ACCOUNT_DELETE_ALREADY_REQUESTED: 'account_delete_already_requested',
  /**
   * Reactivation was asked for on an account that is not deleted.
   *
   * Deliberately NOT distinguished from "no such account" on the public reactivation
   * route — see `ACCOUNT_RECOVERY_WINDOW_EXPIRED`. It is reachable only where the
   * caller has already proved which account they mean.
   */
  ACCOUNT_NOT_DELETED: 'account_not_deleted',
  /**
   * The thirty-day window closed and the account has been purged.
   *
   * ─── Why the public route never returns this ────────────────────────────────
   *
   * ─── Why nothing currently returns this ─────────────────────────────────────
   *
   * Two reasons, and they stack. Once the sweep writes `deletedAt` the row stops
   * resolving in every lookup, so for most of the account's life the reactivation route
   * genuinely cannot tell an expired account from an address that never registered — it
   * is not suppressing an answer it has, it does not have one.
   *
   * In the lag between `purgeAt` passing and the sweep running it COULD tell, and there
   * the answer is suppressed on purpose: `reactivate` collapses every failure into
   * `otp_invalid`, because the route is unauthenticated and this slug would confirm both
   * that the address has an account and that it was deleted — which is precisely the set
   * of accounts whose owners are locked out with only a mailbox to get back in.
   *
   * Kept rather than deleted because it names a real state the lifecycle has, and an
   * authenticated surface could return it honestly. Nothing may return it from a public
   * one.
   */
  ACCOUNT_RECOVERY_WINDOW_EXPIRED: 'account_recovery_window_expired',
  /**
   * A bound withdrawal subsystem reports funds the owner has not acknowledged losing.
   *
   * Unreachable today: no withdrawal subsystem exists, `NullPendingWithdrawalsProvider`
   * answers `unavailable`, and `unavailable` does not block a deletion. The slug is
   * here so the future subsystem changes one binding rather than this contract. See
   * src/settings/delete-account/withdrawals.service.ts.
   */
  ACCOUNT_DELETE_FUNDS_PENDING: 'account_delete_funds_pending',

  // ─── oauth ────────────────────────────────────────────────────────────────
  OAUTH_PROVIDER_UNSUPPORTED: 'oauth_provider_unsupported',
  OAUTH_STATE_INVALID: 'oauth_state_invalid',
  OAUTH_EXCHANGE_FAILED: 'oauth_exchange_failed',
  /** The provider's email belongs to an existing account, so a new one cannot be
   *  created with it. Returned when a client takes the "create account" branch
   *  anyway, having ignored `canCreateNew` on the choice. */
  OAUTH_LINK_REQUIRED: 'oauth_link_required',
  /** The pending provider identity is unknown, expired, or already spent. The
   *  client has to send the user back through the provider. */
  OAUTH_LINK_INVALID: 'oauth_link_invalid',
  /** The provider identity is already attached to some account. Reached only by a
   *  race or a replay — an ordinary second sign-in resolves to a session. */
  OAUTH_ALREADY_LINKED: 'oauth_already_linked',
  /**
   * The `nonce` in the provider's ID token is not the one this server put in the
   * authorization request.
   *
   * Deliberately NOT folded into `OAUTH_EXCHANGE_FAILED`. That one is a 502 titled
   * "Provider rejected the authorization", and this is the opposite situation: the
   * provider answered, and OUR check refused the answer. A token that verifies
   * against Google's keys but carries the wrong nonce is an injected token, which
   * is worth its own slug and its own log line.
   */
  OAUTH_NONCE_INVALID: 'oauth_nonce_invalid',
  /**
   * The request finishing an OAuth flow came from a different network than the one
   * that started it.
   *
   * Its own slug rather than folding into `oauth_state_invalid`, because the two
   * need different words on screen. An invalid state means "something went wrong,
   * start again"; this means "we stopped this because it looked like someone else",
   * and it is the one refusal here a legitimate user can hit by switching from
   * wi-fi to mobile data mid-flow. A client that cannot tell them apart cannot
   * explain either.
   */
  OAUTH_CONTEXT_MISMATCH: 'oauth_context_mismatch',
  /**
   * The provider cannot supply an email address, so no account can be created from
   * this identity — only attached to one that already exists.
   *
   * X and Telegram, structurally and permanently: X does not expose an address
   * through OAuth 2.0 at any access tier, and a Telegram account is a phone number.
   * Apple and Facebook can reach this too, situationally, when a user declines the
   * scope or the provider withholds the address on a repeat authorization.
   *
   * Its own slug rather than `oauth_exchange_failed`, which would be a 502 blaming
   * the provider for working correctly. Nothing went wrong here: the sign-in
   * succeeded and the identity is genuine. What the client has to say is "finish
   * signing up with an email, then link this" — advice it cannot give if the error
   * says the provider rejected the authorization.
   */
  OAUTH_EMAIL_UNAVAILABLE: 'oauth_email_unavailable',
} as const;

export type ErrorType = (typeof ERR)[keyof typeof ERR];

interface CatalogueEntry {
  readonly status: number;
  readonly title: string;
}

export const PROBLEM_CATALOGUE: Readonly<Record<ErrorType, CatalogueEntry>> = Object.freeze({
  [ERR.VALIDATION_FAILED]: { status: 400, title: 'Request validation failed' },
  [ERR.NOT_FOUND]: { status: 404, title: 'Not found' },
  [ERR.RATE_LIMITED]: { status: 429, title: 'Too many requests' },
  [ERR.INTERNAL_ERROR]: { status: 500, title: 'Internal server error' },
  [ERR.UNAUTHENTICATED]: { status: 401, title: 'Authentication required' },
  [ERR.FORBIDDEN]: { status: 403, title: 'Forbidden' },

  [ERR.CAPTCHA_FAILED]: { status: 400, title: 'Captcha verification failed' },
  [ERR.CAPTCHA_PROVIDER_UNKNOWN]: { status: 400, title: 'Unknown captcha provider' },
  [ERR.CAPTCHA_PROVIDER_UNAVAILABLE]: { status: 503, title: 'Captcha verification is unavailable' },

  [ERR.EMAIL_ALREADY_REGISTERED]: { status: 409, title: 'Email address is not available' },
  [ERR.EMAIL_DOMAIN_BLOCKED]: { status: 400, title: 'Email address is not accepted' },
  [ERR.REGISTRATION_NOT_FOUND]: { status: 404, title: 'Registration not found' },
  [ERR.REGISTRATION_EXPIRED]: { status: 410, title: 'Registration has expired' },
  [ERR.REGISTRATION_STEP_INVALID]: { status: 409, title: 'Step not valid from the current state' },
  [ERR.OTP_INVALID]: { status: 400, title: 'Incorrect code' },
  [ERR.OTP_EXPIRED]: { status: 410, title: 'Code has expired' },
  [ERR.OTP_ATTEMPTS_EXHAUSTED]: { status: 429, title: 'Too many incorrect codes' },
  [ERR.OTP_RESEND_TOO_SOON]: { status: 429, title: 'Code was requested too recently' },
  [ERR.OTP_SEND_LIMIT_REACHED]: { status: 429, title: 'Code request limit reached' },
  [ERR.PASSWORD_WEAK]: { status: 400, title: 'Password does not meet requirements' },
  [ERR.PASSWORD_MISMATCH]: { status: 400, title: 'Passwords do not match' },
  [ERR.PASSWORD_ALREADY_SET]: { status: 409, title: 'A password is already set' },
  [ERR.PASSWORD_NOT_SET]: { status: 409, title: 'No password is set' },
  [ERR.PASSWORD_REUSED]: { status: 400, title: 'Password is unchanged' },
  [ERR.PASSWORD_FACTOR_REQUIRED]: {
    status: 409,
    title: 'An additional verification is required',
  },
  [ERR.USERNAME_GENERATION_FAILED]: { status: 500, title: 'Could not allocate a username' },
  [ERR.COUNTRY_INVALID]: { status: 400, title: 'Unknown country' },

  [ERR.INVALID_CREDENTIALS]: { status: 401, title: 'Incorrect credentials' },
  [ERR.OTP_REQUIRED]: { status: 409, title: 'Email verification code required' },
  [ERR.ACCOUNT_LOCKED]: { status: 423, title: 'Account temporarily locked' },
  [ERR.ACCOUNT_DISABLED]: { status: 403, title: 'Account is disabled' },

  [ERR.TOKEN_INVALID]: { status: 401, title: 'Invalid token' },
  [ERR.TOKEN_EXPIRED]: { status: 401, title: 'Token has expired' },
  [ERR.SESSION_REVOKED]: { status: 401, title: 'Session has been revoked' },
  [ERR.SESSION_EXPIRED]: { status: 401, title: 'Session has expired' },
  [ERR.SESSION_REUSE_DETECTED]: { status: 401, title: 'Refresh token was already used' },
  [ERR.SESSION_STORE_UNAVAILABLE]: { status: 503, title: 'Session store is unavailable' },
  [ERR.CSRF_INVALID]: { status: 403, title: 'Missing or invalid CSRF token' },

  [ERR.MFA_TOKEN_INVALID]: { status: 401, title: 'Sign-in is invalid or already complete' },
  // 409, matching `registration_step_invalid`: nothing is wrong with the caller's
  // credential, the request is just out of order against server-side state.
  [ERR.MFA_STEP_INVALID]: { status: 409, title: 'Step not valid from the current state' },
  [ERR.MFA_EXPIRED]: { status: 410, title: 'Sign-in took too long' },
  [ERR.MFA_CODE_INVALID]: { status: 400, title: 'Incorrect code' },
  [ERR.MFA_ATTEMPTS_EXHAUSTED]: { status: 429, title: 'Too many incorrect codes' },
  [ERR.MFA_CONTEXT_MISMATCH]: {
    status: 400,
    title: 'Sign-in continued from a different device or network',
  },
  [ERR.MFA_METHOD_UNAVAILABLE]: { status: 409, title: 'That method is not set up on this account' },
  [ERR.MFA_CODE_ALREADY_USED]: { status: 409, title: 'That code has already been used' },
  [ERR.MFA_ALREADY_ENROLLED]: { status: 409, title: 'That factor is already set up' },
  [ERR.PASSKEY_CHALLENGE_INVALID]: { status: 400, title: 'Passkey challenge is invalid or expired' },
  [ERR.PASSKEY_VERIFICATION_FAILED]: { status: 400, title: 'Passkey could not be verified' },
  [ERR.REAUTH_REQUIRED]: { status: 403, title: 'Re-authentication required' },

  [ERR.PAYMENT_PIN_ALREADY_ENABLED]: { status: 409, title: 'A Payment PIN is already set' },
  [ERR.PAYMENT_PIN_NOT_ENABLED]: { status: 409, title: 'No Payment PIN is set' },
  [ERR.PAYMENT_PIN_WEAK]: { status: 400, title: 'Payment PIN is too easy to guess' },
  [ERR.PAYMENT_PIN_REUSED]: { status: 400, title: 'Payment PIN is unchanged' },
  [ERR.PAYMENT_PIN_INVALID]: { status: 400, title: 'Incorrect Payment PIN' },
  // 403 rather than 400, matching `reauth_required`: the request is well-formed and
  // the caller is authenticated — what is missing is a live authorisation for it.
  [ERR.PAYMENT_PIN_CHALLENGE_INVALID]: {
    status: 403,
    title: 'Payment PIN verification is invalid or expired',
  },

  [ERR.ANTI_PHISHING_CODE_ALREADY_SET]: {
    status: 409,
    title: 'An anti-phishing code is already set',
  },
  [ERR.ANTI_PHISHING_CODE_NOT_SET]: { status: 409, title: 'No anti-phishing code is set' },
  // 400 and not 403. A 403 would frame this as an authorisation failure, and it is not
  // one — `action: 'replace'` performs the same write without this check. It is a
  // mistyped field, which is what 400 means.
  [ERR.ANTI_PHISHING_CODE_INCORRECT]: { status: 400, title: 'Incorrect anti-phishing code' },

  [ERR.EMAIL_SAME_AS_CURRENT]: { status: 400, title: 'That is already your email address' },
  [ERR.EMAIL_CHANGE_CHALLENGE_INVALID]: {
    status: 403,
    title: 'Email change is invalid or expired',
  },
  [ERR.EMAIL_CHANGE_SECURITY_REQUIRED]: {
    status: 409,
    title: 'A stronger verification is required',
  },
  // 403 rather than 404: the request is well-formed and the refusal is about
  // authorisation. A 404 would additionally hint that the ticket simply does not exist,
  // which is the distinction this slug exists not to draw.
  [ERR.EMAIL_RECOVERY_INVALID]: {
    status: 403,
    title: 'Recovery link is invalid or expired',
  },

  // 409 for the same reason `email_already_registered` is one: the request is
  // well-formed and the conflict is with the world's state, not with the request.
  [ERR.USERNAME_UNAVAILABLE]: { status: 409, title: 'That username is not available' },
  [ERR.USERNAME_INVALID]: { status: 400, title: 'Username does not meet requirements' },
  [ERR.USERNAME_SAME_AS_CURRENT]: { status: 400, title: 'That is already your username' },
  // The only 402 in this service. See the slug for why nothing else fits.
  [ERR.USERNAME_CHANGE_PAYMENT_REQUIRED]: {
    status: 402,
    title: 'Further username changes require payment',
  },

  // 403 rather than 429, matching `reauth_required` and
  // `payment_pin_challenge_invalid`: the caller is authenticated and the request is
  // well-formed, and what is missing is authorisation for it right now. A 429 would
  // say "you did this too often", which is untrue — one email change is enough — and
  // would put this in the bucket clients retry automatically.
  [ERR.SECURITY_CHANGE_COOLDOWN]: {
    status: 403,
    title: 'Security settings are temporarily locked after an email change',
  },

  // 403 for `security_change_cooldown`'s reason exactly: authenticated, well-formed,
  // nothing the caller can prove will help, and the only remedy is to wait. Not 429 —
  // the caller has not done anything too often, and clients retry 429s automatically.
  [ERR.FEATURE_RESTRICTED]: {
    status: 403,
    title: 'This feature is temporarily unavailable after a recent security change',
  },

  // 409 for the three state slugs, matching `registration_step_invalid` and
  // `mfa_step_invalid`: the caller is authenticated and the request is well-formed, it
  // is simply out of order against server-side state, and no credential would help.
  [ERR.ACCOUNT_DELETE_ALREADY_REQUESTED]: {
    status: 409,
    title: 'This account is already scheduled for deletion',
  },
  [ERR.ACCOUNT_NOT_DELETED]: { status: 409, title: 'This account is not deleted' },
  // 410 rather than 409, matching `mfa_expired`: the thing being asked for did exist
  // and is now permanently gone, which is a different sentence on screen from "not
  // valid from here".
  [ERR.ACCOUNT_RECOVERY_WINDOW_EXPIRED]: {
    status: 410,
    title: 'The recovery period for this account has ended',
  },
  [ERR.ACCOUNT_DELETE_FUNDS_PENDING]: {
    status: 409,
    title: 'This account still holds funds',
  },

  [ERR.OAUTH_PROVIDER_UNSUPPORTED]: { status: 400, title: 'Provider is not supported' },
  [ERR.OAUTH_STATE_INVALID]: { status: 400, title: 'Invalid or expired authorization state' },
  [ERR.OAUTH_EXCHANGE_FAILED]: { status: 502, title: 'Provider rejected the authorization' },
  [ERR.OAUTH_LINK_REQUIRED]: { status: 409, title: 'An account already exists for this email' },
  [ERR.OAUTH_LINK_INVALID]: { status: 400, title: 'Link session is invalid or expired' },
  [ERR.OAUTH_ALREADY_LINKED]: { status: 409, title: 'This provider account is already linked' },
  [ERR.OAUTH_NONCE_INVALID]: { status: 400, title: 'Authorization response did not match the request' },
  [ERR.OAUTH_CONTEXT_MISMATCH]: { status: 400, title: 'Sign-in continued from a different network' },
  [ERR.OAUTH_EMAIL_UNAVAILABLE]: { status: 409, title: 'This provider cannot create an account' },
});
