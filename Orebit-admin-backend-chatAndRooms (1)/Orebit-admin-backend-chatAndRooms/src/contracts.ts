/**
 * The error catalogue. Every failure this service reports is one of these slugs,
 * and the slug is what a client switches on — never the HTTP status, never the
 * message text, both of which are allowed to change.
 *
 * Adding an entry here is the only way to add an error to the API. That is the
 * point: it keeps the failure surface enumerable, so the admin frontend can be
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
  /**
   * Refused: the write would have left no captcha provider live.
   *
   * Distinct from `validation_failed`, because nothing about the request was
   * malformed — the operator asked for something coherent and it was denied on
   * policy. And distinct from `captcha_provider_unavailable`, which is what a
   * SIGN-IN gets; this is what an OPERATOR gets, and the two audiences need
   * different words.
   *
   * The rule it reports: an empty provider set would leave no admin able to sign
   * in, including the one who would have to sign in to undo it. Disable the others
   * one at a time and there is always a last one this refuses.
   */
  CAPTCHA_LAST_PROVIDER: 'captcha_last_provider',

  // ─── credentials ──────────────────────────────────────────────────────────
  INVALID_CREDENTIALS: 'invalid_credentials',
  ACCOUNT_LOCKED: 'account_locked',
  ACCOUNT_DISABLED: 'account_disabled',
  /**
   * The account locked twice inside the strike memory and is now out of service
   * pending a super admin's decision.
   *
   * Distinct from `account_locked`, which is a WAIT — it carries `Retry-After` and
   * resolves itself. This one does not: no amount of waiting restores the account,
   * and the client must say so rather than render a countdown. Distinct from
   * `account_disabled` too, because the remedy differs: a disabled account was turned
   * off by a person, this one was taken out of service by the system and has a review
   * queued against it.
   *
   * Answered by every path, not just the password step — the OTP and MFA steps, and
   * the refresh rotation, all refuse a reviewed account with this slug.
   */
  ADMIN_LOGIN_MANUAL_REVIEW: 'admin_login_manual_review',
  PASSWORD_WEAK: 'password_weak',
  PASSWORD_MISMATCH: 'password_mismatch',

  // ─── email one-time codes ─────────────────────────────────────────────────
  OTP_INVALID: 'otp_invalid',
  OTP_EXPIRED: 'otp_expired',
  OTP_ATTEMPTS_EXHAUSTED: 'otp_attempts_exhausted',
  OTP_RESEND_TOO_SOON: 'otp_resend_too_soon',
  OTP_SEND_LIMIT_REACHED: 'otp_send_limit_reached',

  // ─── step-up (the partially-authenticated login attempt) ──────────────────
  /**
   * DECLARED BUT NO LONGER THROWN. Kept because the catalogue is a frozen contract
   * and a client may still switch on it.
   *
   * It existed when the credential was an httpOnly cookie the browser attached
   * invisibly: "nothing was presented" was then a question about authentication,
   * because the caller could not see whether they had sent one. The credential is
   * now `loginId`, a required field in the request body, so an absent one is caught
   * by `parseDto` and answered as `validation_failed` (400) — a malformed request,
   * which is what it now is.
   */
  STEP_UP_REQUIRED: 'step_up_required',
  /** One was offered but matches no live attempt: forged, or already spent. */
  STEP_UP_INVALID: 'step_up_invalid',
  STEP_UP_EXPIRED: 'step_up_expired',
  /**
   * The requested step is not legal from the attempt's current state.
   *
   * This is the slug that reports an attempt to skip a factor — asking for
   * `totp-verify` while still at `PASSWORD_VERIFIED`, for instance. It is the
   * observable consequence of the `STEP_REQUIRES` table in auth/auth.types.ts.
   */
  STEP_UP_STEP_INVALID: 'step_up_step_invalid',

  // ─── second factor ────────────────────────────────────────────────────────
  MFA_ATTEMPTS_EXHAUSTED: 'mfa_attempts_exhausted',
  /** A mutating request arrived without a live elevation ticket. The caller is
   *  authenticated — they simply have not re-proved a second factor for THIS
   *  action. Distinct from `unauthenticated` so a UI knows to prompt for a
   *  passkey tap rather than bounce to the sign-in page. */
  REAUTH_REQUIRED: 'reauth_required',
  /** A verify step ran against an admin with no confirmed factor of that kind. */
  MFA_NOT_ENROLLED: 'mfa_not_enrolled',
  /**
   * Enrollment was attempted by an admin who already has a confirmed factor.
   *
   * The downgrade guard. Without it, anyone holding a step-up token could mint a
   * fresh secret and enroll a factor they control, which would make the second
   * factor a formality rather than a barrier.
   */
  MFA_ALREADY_ENROLLED: 'mfa_already_enrolled',
  TOTP_INVALID: 'totp_invalid',
  /** A correct code, but one already spent inside its own 30-second window. */
  TOTP_REPLAYED: 'totp_replayed',
  /** No challenge was issued for this attempt, or it expired, or it was spent. */
  PASSKEY_CHALLENGE_INVALID: 'passkey_challenge_invalid',
  PASSKEY_VERIFICATION_FAILED: 'passkey_verification_failed',
  PASSKEY_ALREADY_REGISTERED: 'passkey_already_registered',

  // ─── session ──────────────────────────────────────────────────────────────
  TOKEN_INVALID: 'token_invalid',
  TOKEN_EXPIRED: 'token_expired',
  /**
   * Someone ENDED this session: a logout, a logout-all, a password change, a detected
   * refresh replay, or an administrative sweep.
   *
   * Distinct from `SESSION_EXPIRED` below, and the distinction is for the client. Both
   * are 401 and both call for the same cleanup, but only this one is worth telling an
   * admin about — "your session was ended elsewhere" is a security event they may need
   * to act on, where "you were idle too long" is routine.
   */
  SESSION_REVOKED: 'session_revoked',
  /** The idle window elapsed with no eligible request. Nobody ended the session; it
   *  simply timed out. See `SESSION` in auth/auth.constants.ts for the window. */
  SESSION_EXPIRED: 'session_expired',
  /** A refresh token was presented twice. The whole family is now revoked. */
  SESSION_REUSE_DETECTED: 'session_reuse_detected',
  /**
   * A session operation could not be completed because the coordination state behind
   * it was unavailable — so the server does not know what it would have been acting
   * on, and will not claim to have acted.
   *
   * Two callers today:
   *
   *   logout    the store that names the session could not be reached, so the server
   *             does not know WHAT to revoke, and will not claim to have revoked it.
   *
   * ═══ WHY THIS EXISTS RATHER THAN AN OPTIMISTIC 200 ═════════════════════════
   *
   * The browser holds an opaque handle; the mapping from that handle to a session
   * family lives in Redis. With Redis unreachable there is no way to identify the
   * family, so the authoritative revocation in PostgreSQL cannot even be attempted.
   * Answering "logged out" there is a lie with a long tail: the client discards its
   * cookie, and the session comes back to life the moment Redis recovers.
   *
   * ─── What it does NOT mean ────────────────────────────────────────────────
   *
   * Not "no such session". Redis answering that a handle names nothing is an
   * ordinary, honest success — there is nothing left to revoke. This slug is only
   * for the case where Redis did not answer at all. Conflating the two is the bug
   * this slug was added to make impossible.
   *
   *   refresh   another request holds the refresh lock and did not produce a result
   *             within the wait budget. The session is very likely fine; what failed
   *             is the coordination. Answering 401 here would sign out a healthy
   *             session because a different request was slow.
   *
   *   locking   the refresh lock could not be ACQUIRED — Redis went away between
   *             serving the session record and the acquire. Distinct from the case
   *             above: there, a holder exists and was slow; here there is no holder
   *             and no lock. Both are the same answer to a client, and neither is a
   *             statement about the session.
   *
   * 503 rather than 500, matching `CAPTCHA_PROVIDER_UNAVAILABLE`: a dependency this
   * operation needs is down, the request was not wrong, and retrying later is the
   * correct client behaviour. Deliberately NOT in `DEAD_SESSION_TYPES` — this is not
   * a session ending, and the logout routes must not swallow it as one.
   */
  SESSION_STORE_UNAVAILABLE: 'session_store_unavailable',

  // ─── kyc ────────────────────────────────────────────────────────────────
  /**
   * Refused: the account already holds a live KYC exemption.
   *
   * Deliberately NOT `validation_failed`. Nothing about the request was malformed —
   * the operator asked for something coherent and a rule denied it, which is the
   * distinction `captcha_last_provider` already draws at this status.
   *
   * `ux_kyc_exemptions_live` permits one live exemption per account on purpose: an
   * exemption grants an EFFECTIVE level, so two rows would be two answers to "what is
   * this account's standing". Raising or lowering one is a revoke followed by a grant,
   * both of which leave a record — an implicit replacement would hide which grant was
   * in force at a given moment, which is the one thing that table exists to say.
   *
   * The remedy is specific and different from a 400's: revoke the existing exemption,
   * then grant the new one.
   */
  KYC_EXEMPTION_ACTIVE: 'kyc_exemption_active',

  // ─── countries ────────────────────────────────────────────────────────────
  /**
   * A country with this ISO code already exists.
   *
   * 409 and its own slug rather than `validation_failed`, for `captcha_last_provider`'s
   * reason: nothing about the request was malformed. The operator asked for something
   * coherent and a uniqueness rule denied it, and the remedy is specific and different
   * from a 400's — edit the existing country, or check the code they meant to type.
   *
   * `UNIQUE(iso_code)` is what raises it, so it is reported from a caught constraint
   * violation rather than from a read-then-write, which two admins can race.
   */
  COUNTRY_ALREADY_EXISTS: 'country_already_exists',

  /**
   * An uploaded image was not something this service will store.
   *
   * Covers every content-level refusal: a format outside the allow-list, an animated or
   * multi-page image, a non-square canvas, an oversized dimension, and bytes that do not
   * decode at all. Deliberately ONE slug for all of them — `detail` carries which — so a
   * client has one branch for "this file is no good" and the list of reasons can grow
   * without becoming a wire contract.
   *
   * Distinct from `validation_failed` because the offending part is a file, not a field:
   * there is no `path` for a `errors[]` entry to point at.
   */
  COUNTRY_IMAGE_INVALID: 'country_image_invalid',

  /** An uploaded image exceeded the byte ceiling, before or after normalisation. */
  COUNTRY_IMAGE_TOO_LARGE: 'country_image_too_large',

  /**
   * Object storage could not be reached, or is not configured.
   *
   * 503, and the ONLY thing the caller learns. The endpoint, the bucket, the
   * credentials and the SDK's own message never reach the wire — they are logged
   * instead. `captcha_provider_unavailable` draws the same line at the same status.
   *
   * Also what the image library reports when it cannot read the bucket. An empty library
   * and an unreachable one must never look alike: the first says "upload something", the
   * second says "try again", and showing the first when the second is true invites an
   * admin to re-upload flags that already exist.
   */
  COUNTRY_IMAGE_STORAGE_UNAVAILABLE: 'country_image_storage_unavailable',

  // ─── social chat ───────────────────────────────────────────────────────────
  CHAT_ROOM_NOT_FOUND: 'chat_room_not_found',
  CHAT_ROOM_SLUG_EXISTS: 'chat_room_slug_exists',
  CHAT_REPORT_NOT_FOUND: 'chat_report_not_found',
  CHAT_REPORT_ALREADY_RESOLVED: 'chat_report_already_resolved',
  CHAT_BAN_NOT_FOUND: 'chat_ban_not_found',
  CHAT_COSMETIC_NOT_FOUND: 'chat_cosmetic_not_found',
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
  [ERR.CAPTCHA_LAST_PROVIDER]: {
    status: 409,
    title: 'At least one captcha provider must stay enabled',
  },
  [ERR.CAPTCHA_PROVIDER_UNAVAILABLE]: {
    status: 503,
    title: 'Captcha verification is unavailable',
  },

  [ERR.INVALID_CREDENTIALS]: { status: 401, title: 'Incorrect credentials' },
  [ERR.ACCOUNT_LOCKED]: { status: 423, title: 'Account temporarily locked' },
  [ERR.ACCOUNT_DISABLED]: { status: 403, title: 'Account is disabled' },
  // 403 rather than 423. A lock is temporary and 423 Locked pairs with the
  // `Retry-After` it carries; this is a refusal with no wait attached, so it belongs
  // with the other "you may not, and time will not change that" answers.
  [ERR.ADMIN_LOGIN_MANUAL_REVIEW]: { status: 403, title: 'Account is under manual review' },
  [ERR.PASSWORD_WEAK]: { status: 400, title: 'Password does not meet requirements' },
  [ERR.PASSWORD_MISMATCH]: { status: 400, title: 'Passwords do not match' },

  [ERR.OTP_INVALID]: { status: 400, title: 'Incorrect code' },
  // 400, not 410. CONTRACT CHANGE — this answered 410 Gone until the rate-limit
  // policy landed. 410 is defensible on its own terms (the code existed and is now
  // permanently unavailable), but it put the two "your code did not work" answers on
  // different statuses: `otp_invalid` is 400 and this was 410, so a client handling
  // them by status had to special-case one of two outcomes of the same box. The slug
  // is what clients switch on, and it has not changed.
  [ERR.OTP_EXPIRED]: { status: 400, title: 'Code has expired' },
  [ERR.OTP_ATTEMPTS_EXHAUSTED]: { status: 429, title: 'Too many incorrect codes' },
  [ERR.OTP_RESEND_TOO_SOON]: { status: 429, title: 'Code was requested too recently' },
  [ERR.OTP_SEND_LIMIT_REACHED]: { status: 429, title: 'Code request limit reached' },

  [ERR.STEP_UP_REQUIRED]: { status: 401, title: 'Sign-in must be started first' },
  [ERR.STEP_UP_INVALID]: { status: 401, title: 'Sign-in session is invalid' },
  [ERR.STEP_UP_EXPIRED]: { status: 410, title: 'Sign-in session has expired' },
  [ERR.STEP_UP_STEP_INVALID]: { status: 409, title: 'Step not valid from the current state' },

  [ERR.MFA_ATTEMPTS_EXHAUSTED]: { status: 429, title: 'Too many incorrect codes' },
  [ERR.REAUTH_REQUIRED]: { status: 403, title: 'Re-authentication required' },
  [ERR.MFA_NOT_ENROLLED]: { status: 409, title: 'No second factor is enrolled' },
  [ERR.MFA_ALREADY_ENROLLED]: { status: 409, title: 'A second factor is already enrolled' },
  [ERR.TOTP_INVALID]: { status: 400, title: 'Incorrect authenticator code' },
  [ERR.TOTP_REPLAYED]: { status: 409, title: 'That code has already been used' },
  [ERR.PASSKEY_CHALLENGE_INVALID]: { status: 400, title: 'Passkey challenge is invalid' },
  [ERR.PASSKEY_VERIFICATION_FAILED]: { status: 400, title: 'Passkey could not be verified' },
  [ERR.PASSKEY_ALREADY_REGISTERED]: { status: 409, title: 'This passkey is already registered' },

  [ERR.TOKEN_INVALID]: { status: 401, title: 'Invalid token' },
  [ERR.TOKEN_EXPIRED]: { status: 401, title: 'Token has expired' },
  [ERR.SESSION_REVOKED]: { status: 401, title: 'Session has been revoked' },
  [ERR.SESSION_EXPIRED]: { status: 401, title: 'Session has expired' },
  [ERR.SESSION_REUSE_DETECTED]: { status: 401, title: 'Refresh token was already used' },
  [ERR.SESSION_STORE_UNAVAILABLE]: { status: 503, title: 'Session store is unavailable' },
  [ERR.KYC_EXEMPTION_ACTIVE]: {
    status: 409,
    title: 'This account already has a live KYC exemption',
  },

  [ERR.COUNTRY_ALREADY_EXISTS]: { status: 409, title: 'That country already exists' },
  [ERR.COUNTRY_IMAGE_INVALID]: { status: 400, title: 'Image could not be accepted' },
  // 413, not 400. The request was well-formed and the file was simply too big, which is
  // the one thing `Content-Too-Large` says precisely — and it is what Fastify's own
  // stream limit would have produced had the ceiling been reached mid-upload.
  [ERR.COUNTRY_IMAGE_TOO_LARGE]: { status: 413, title: 'Image is too large' },
  [ERR.COUNTRY_IMAGE_STORAGE_UNAVAILABLE]: {
    status: 503,
    title: 'Image storage is unavailable',
  },

  // ─── social chat ───────────────────────────────────────────────────────────
  [ERR.CHAT_ROOM_NOT_FOUND]: { status: 404, title: 'Chat room not found' },
  [ERR.CHAT_ROOM_SLUG_EXISTS]: { status: 409, title: 'A chat room with this slug already exists' },
  [ERR.CHAT_REPORT_NOT_FOUND]: { status: 404, title: 'Chat report not found' },
  [ERR.CHAT_REPORT_ALREADY_RESOLVED]: { status: 409, title: 'Chat report has already been resolved' },
  [ERR.CHAT_BAN_NOT_FOUND]: { status: 404, title: 'Chat ban not found' },
  [ERR.CHAT_COSMETIC_NOT_FOUND]: { status: 404, title: 'Chat cosmetic not found' },
});
