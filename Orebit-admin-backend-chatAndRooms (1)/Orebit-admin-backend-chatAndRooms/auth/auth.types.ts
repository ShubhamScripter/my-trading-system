import type { AdminLoginState, AdminMfaMethod, AdminRole } from '@prisma/client';

/**
 * Internal domain types for `auth/`. Nothing here is a request or response shape
 * — those live in the dto files. These are what the services pass between
 * themselves.
 */

/** The explicit subset of an admin record that may cross the API boundary. */
export interface PublicAdmin {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: AdminRole;
  readonly emailVerified: boolean;
  readonly mfaEnrolled: boolean;
  readonly createdAt: Date;
}

/**
 * The authenticated caller, attached to the request by AuthGuard.
 *
 * ═══ TWO IDENTIFIERS, TWO JOBS ═══════════════════════════════════════════════
 *
 * Both are uuids and it is worth being clear about which is which, because using
 * the wrong one is the shape of both F07 and F08.
 *
 *   sessionId  the refresh GENERATION (`AdminSession.id`, the JWT `sid` claim). It
 *              changes on every rotation — roughly every fifteen minutes, at a
 *              moment no client can observe. It identifies the CREDENTIAL, and it
 *              is what refresh replay detection and `logout`'s `resolveSessionId`
 *              are keyed on, correctly.
 *   familyId   the stable LOGIN (`AdminSessionFamily.id`). Constant from sign-in
 *              until the session ends. It identifies the browser session, and it is
 *              what per-action authorisation is keyed on: elevation tickets, reauth
 *              challenges and the reauth rate-limit bucket.
 *
 * The rule for a new consumer: if the thing you are keying would be wrong to lose
 * when tokens refresh in the background, key it on `familyId`.
 *
 * ─── Why a database fact lives on the principal ────────────────────────────
 *
 * This interface used to be exactly "what the credential asserts" — three values
 * read out of a verified JWT — and `familyId` breaks that, deliberately.
 *
 * The alternative was a `fam` claim on the access token, which would have kept the
 * purity and been worse. A claim is a value the credential ASSERTS; the family has
 * to be a value the database RESOLVES, because it is the thing revocation is
 * enforced against. It would also have needed a rollout fallback for every token
 * minted by the previous deploy.
 *
 * So it is resolved server-side, on every request, by `AuthGuard` from the
 * `assertLive` call it was already making:
 *
 *   verified `sid` → readLiveness(sid) → the row's NOT NULL `family_id`
 *
 * Nothing a caller can send reaches it. See the note on `FAMILY` in
 * security/guards.ts.
 */
export interface Principal {
  readonly adminId: string;
  /** The refresh GENERATION. Changes on every rotation — see above. */
  readonly sessionId: string;
  /** The stable LOGIN. Constant for the life of the session — see above. */
  readonly familyId: string;
  readonly role: AdminRole;
}

/** JWT payload `typ`. Both types are signed by one key, so what actually
 *  separates them is the pinned `aud` claim — see jwt.ts. */
export type TokenType = 'access' | 'refresh';

export interface AccessClaims {
  readonly sub: string;
  readonly sid: string;
  /** The admin's role. Carried in the token so a future RBAC guard can answer
   *  "may this caller do X" without a database read on every request. It is
   *  authoritative for at most fifteen minutes — a role change takes effect on
   *  the next refresh, which is the same latency a revocation would have if the
   *  session cache were the only check. */
  readonly rol: AdminRole;
  readonly typ: 'access';
}

export interface RefreshClaims {
  readonly sub: string;
  readonly sid: string;
  readonly fam: string;
  readonly typ: 'refresh';
}

/** What a request tells us about who is calling. Coarse by construction: it
 *  informs risk decisions and is recorded on the session, but it never
 *  authorises anything. */
export interface ClientContext {
  readonly ip: string;
  readonly ipClass: string;
  readonly deviceFingerprint: string;
  readonly userAgent: string | null;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
}

/** A minted session, as returned to a client. */
export interface IssuedSession extends TokenPair {
  readonly sessionId: string;
  /** The family's absolute ceiling. Unlike `refreshExpiresAt`, which slides with
   *  every rotation, this instant does not move for the life of the sign-in — at it,
   *  the admin runs password + email OTP + MFA again. */
  readonly reauthenticateAt: Date;
  readonly admin: PublicAdmin;
}

/** Why a session was revoked. Written to `AdminSession.revokedReason`. */
export const REVOKE_REASON = {
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  REUSE_DETECTED: 'REUSE_DETECTED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
} as const;

export type RevokeReason = (typeof REVOKE_REASON)[keyof typeof REVOKE_REASON];

/** Which second factors an admin may use, or must choose between when enrolling. */
export type MfaMethod = AdminMfaMethod;

/**
 * Every step of the sign-in ceremony. One route carries all of them — see the
 * union in dto/login.dto.ts and the dispatch in auth.controller.ts.
 */
export const LOGIN_STEPS = [
  'start',
  'password',
  'resend-otp',
  'verify-email',
  'state',
] as const;

export type LoginStep = (typeof LOGIN_STEPS)[number];

/**
 * ═══ THE ACCESS-CONTROL TABLE ═══════════════════════════════════════════════
 *
 * The state a step requires to be legal.
 *
 * This is the single most important object in the service. The whole sign-in
 * surface is ONE route, so there is no per-route guard doing this job — this
 * table IS the enforcement, and `assertStep` in security/stepup.ts is the only
 * thing that reads it.
 *
 * A table rather than a chain of `if` statements in the services: it is the one
 * place to look to answer "can a client do X now", so an illegal transition
 * cannot be introduced by editing a single conditional in one service and
 * forgetting its sibling.
 *
 * ─── How to read it ────────────────────────────────────────────────────────
 *
 * `start` and `password` are absent because they are anonymous — there is no
 * attempt yet, so there is no state to require. Every other step demands a live
 * attempt, and a step requested from the wrong state is `step_up_step_invalid`.
 *
 * The load-bearing entry is that NOTHING is legal from `PASSWORD_VERIFIED`
 * except the two email-OTP steps. That single line is what makes the email
 * factor unskippable: an attacker holding a `loginId` minted by a stolen
 * password cannot reach any factor step, cannot reach enrollment, and therefore
 * cannot reach a session.
 *
 * `COMPLETED` and `EXPIRED` appear in no list at all, deliberately — a finished
 * attempt is not a credential, and a spent step-up secret buys nothing.
 */
export const STEP_REQUIRES: Readonly<Record<string, readonly AdminLoginState[]>> = {
  'resend-otp': ['PASSWORD_VERIFIED'],
  'verify-email': ['PASSWORD_VERIFIED'],
  // Readable from anywhere a live attempt exists — it reports where the caller
  // is, which is exactly the question someone who refreshed the page has.
  state: ['PASSWORD_VERIFIED', 'EMAIL_VERIFIED'],
};

/**
 * ═══ THE SECOND HALF OF THE SAME MATRIX ════════════════════════════════════
 *
 * The four factor steps — `enroll-totp`, `verify-totp`, `enroll-passkey`,
 * `verify-passkey` — used to live in `STEP_REQUIRES` above, on `POST /auth/login`.
 * They now live on `POST /2fa`, so their entries live in `TWO_FACTOR_REQUIRES`
 * (src/2fa/2fa.types.ts) instead.
 *
 * They were MOVED, not relaxed: each still demands `EMAIL_VERIFIED`, still resolves
 * its attempt from the same `loginId`, and is still checked by the same
 * `assertStep`. `EMAIL_VERIFIED` appearing nowhere in the table above is the point
 * — reaching it on this route now ends the route's usefulness, and the only thing
 * a caller can do from that state is go to `/2fa`.
 *
 * If you are auditing "what can a half-authenticated caller do", read both tables.
 */

/**
 * How the sign-in ceremony resolved at each step. The client renders a different
 * screen for each, which is why it is a discriminated result rather than an error.
 */
export type LoginOutcome =
  /** Password and captcha accepted; a code is in the admin's inbox. */
  | {
      readonly kind: 'email_otp_required';
      readonly otpExpiresAt: Date | null;
      readonly resendAvailableAt: Date | null;
      readonly otpSendsRemaining: number;
    }
  /** Email proven, and this admin has at least one confirmed factor. */
  | { readonly kind: 'mfa_required'; readonly methods: readonly MfaMethod[] }
  /**
   * Email proven, and this admin has NO confirmed factor.
   *
   * Distinct from `mfa_required` because the client shows a different screen — a
   * QR code or a "create a passkey" prompt rather than a code box — and because
   * conflating them would let a client show the wrong one and strand the admin.
   * No session is issued in either case.
   */
  | { readonly kind: 'enrollment_required'; readonly methods: readonly MfaMethod[] };

/**
 * ═══ THERE IS NO `session` VARIANT, AND THAT IS LOAD-BEARING ═══════════════
 *
 * There used to be one, and it was already unreachable: the second factor moved to
 * `POST /2fa`, and `LoginService` does not inject `SessionService` — so nothing on
 * the login route could construct it.
 *
 * Removed rather than left as a dead arm, because its absence turns the service's
 * central invariant into a COMPILE-TIME fact. "No path through `/auth/login` can
 * produce a session" is now enforced by the type: a future step that tried would
 * have nothing to return, rather than a convenient variant sitting ready for
 * someone to fill in. `LoginService`'s own docblock claims exactly this property;
 * this is what makes the claim checkable.
 *
 * A session is described by `SessionPayload` (auth/dto/response.dto.ts) and issued
 * only by `MfaService`, behind a proven second factor.
 */

/** A freshly generated, not-yet-confirmed TOTP secret, handed to the client once
 *  and never retrievable again. */
export interface TotpEnrollment {
  /** Base32, for manual entry when a camera is not available. */
  readonly secret: string;
  /** The `otpauth://totp/...` URI a QR code encodes. */
  readonly uri: string;
}

/**
 * Whether a WebAuthn ceremony is registering a new passkey or authenticating with
 * an existing one.
 *
 * The server decides this from the admin's confirmed passkey count and stores it
 * alongside the challenge. `passkey-verify` reads the STORED mode rather than
 * accepting one from the request — that is what lets one step serve both flows
 * without letting a caller choose which verification path runs against them.
 */
export type PasskeyMode = 'register' | 'authenticate';

/** What `passkey-challenge` hands back. `options` is passed to the browser's
 *  `navigator.credentials` call verbatim. */
export interface PasskeyChallenge {
  readonly mode: PasskeyMode;
  readonly options: Record<string, unknown>;
}
