import type { LoginAttempt, MfaMethod } from '@prisma/client';

/**
 * Domain types for the second-factor surface.
 *
 * ─── The three groups of action, and why one route serves all of them ───────
 *
 * Every second-factor operation passes through `POST /auth/2fa`, except the one the
 * sign-in ceremony needs, which has its own path because the client calls it at a
 * different moment with a different credential. There are three groups and they
 * differ in what a caller must present, which is the entire reason the table below
 * exists:
 *
 *  1. SIGN-IN — the caller is half-authenticated. `POST /auth/login` proved the
 *     first factor and stopped; the `loginId` carries them to
 *     `POST /auth/2fa/verify`, and proving a factor is what mints the session.
 *  2. RE-AUTH — the caller is signed in and is proving a factor again in order to
 *     be allowed to write. Yields a single-use elevation ticket.
 *  3. MANAGEMENT — the caller is signed in AND has just re-proved a factor, and is
 *     changing which factors exist.
 *
 * The same verbs (enroll, confirm, challenge, verify, remove) appear across the
 * groups against the same tables. Split across routes, "what counts as a confirmed
 * factor" would have three answers. Here it has one, and the thing that varies —
 * who may ask — is a table a reviewer can read in one screen.
 */

/** A factor kind that has a table. */
export type FactorKind = MfaMethod;

/**
 * How a sign-in may be satisfied, as the wire names it.
 *
 * Lowercase snake, and a superset of `MfaMethod`: `recovery_code` is something a
 * caller may DO but not something they enrol, so it has no enum member in Postgres.
 * The response's `methods` array lists what this account can actually use right
 * now, which is the question a client is asking.
 */
export type SignInMethod = 'totp' | 'passkey' | 'recovery_code';

/** Every action on `POST /auth/2fa`. */
export type TwoFactorAction =
  // ─── re-auth: a live session, proving a factor to earn a ticket ───
  | 'reauth-challenge'
  | 'reauth-verify'
  /** Email the code that credential changes require alongside a factor proof. */
  | 'credential-otp'
  // ─── management: a live session plus a spent ticket ───
  | 'totp-add'
  | 'totp-confirm'
  | 'passkey-add-challenge'
  | 'passkey-add-verify'
  | 'recovery-regenerate'
  | 'remove'
  | 'rename';

/**
 * What a caller must present.
 *
 *  - `bearer`        — a valid access token and nothing more.
 *  - `bearer+ticket` — a valid access token AND a single-use elevation ticket in
 *                      `ELEVATION.HEADER_NAME`.
 */
export type TwoFactorCredential = 'bearer' | 'bearer+ticket';

/**
 * ═══ THE ACCESS-CONTROL TABLE FOR THIS ROUTE ═══════════════════════════════
 *
 * ─── Why `reauth-*` needs only a bearer ─────────────────────────────────────
 *
 * It is the action that GRANTS elevation. Requiring elevation to obtain elevation
 * is the deadlock, not the defence.
 *
 * ─── Why `totp-confirm` and `passkey-add-verify` need no ticket ─────────────
 *
 * Each is the second half of a two-step flow whose FIRST half already spent one.
 * `totp-confirm` is gated by possession of a pending enrollment row, and
 * `passkey-add-verify` by a single-use challenge in Redis — both created by a
 * request that was itself elevated. Demanding a second ticket would mean two
 * proofs for one logical action without adding a second barrier.
 *
 * ─── The bootstrap, stated so it does not look like a bug ───────────────────
 *
 * `totp-add` requires a ticket, and a ticket comes from proving a factor — so a
 * user with NO factor could never enrol their first one. `reauth-verify` therefore
 * accepts the account password as a proof when no factor is enrolled. That is not a
 * hole: with nothing enrolled, the password is the only factor the account has, and
 * demanding more than an account possesses is a lockout rather than a defence. The
 * moment a factor exists, `reauth-verify` stops accepting the password alone —
 * see `TwoFactorService.reauthVerify`.
 */
export const TWO_FACTOR_REQUIRES: Readonly<Record<TwoFactorAction, TwoFactorCredential>> = {
  'reauth-challenge': 'bearer',
  'reauth-verify': 'bearer',
  // Sends mail to the account's own address, so a session is the whole
  // authorisation — there is nothing here for a ticket to protect, and demanding
  // one would require the very proof this code is part of obtaining.
  'credential-otp': 'bearer',

  'totp-add': 'bearer+ticket',
  'totp-confirm': 'bearer',
  'passkey-add-challenge': 'bearer+ticket',
  'passkey-add-verify': 'bearer',
  'recovery-regenerate': 'bearer+ticket',
  remove: 'bearer+ticket',
  rename: 'bearer+ticket',
};

/**
 * One enrolled factor, flattened across the two tables.
 *
 * `id` is the row id in whichever table `kind` names. It is not a secret: it
 * authorises nothing on its own, and every mutation re-checks that the row belongs
 * to the calling user.
 */
export interface EnrolledFactor {
  readonly id: string;
  readonly kind: FactorKind;
  readonly label: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/** A freshly generated TOTP secret, returned exactly once. */
export interface TotpEnrollment {
  readonly secret: string;
  readonly uri: string;
}

/**
 * A login flow that has resolved whose sign-in it is.
 *
 * `LoginAttempt.userId` is nullable, because a flow can be opened before the
 * account is attached to it — `oauth-start` parks one across the provider round
 * trip with nobody identified. Every state past that point has an
 * account attached — `promoteAttempt` writes the state and the id in one
 * statement — but the Prisma type cannot express "null only while STARTED", so
 * without this every consumer of a resolved attempt would carry a null check for
 * a case it cannot be handed.
 *
 * Produced only by `MfaService.requireAttempt`, which does that check once, at the
 * gate. A value of this type is a promise that the check has already happened.
 */
export type IdentifiedAttempt = LoginAttempt & { readonly userId: string };

/**
 * What the login paths get back when they ask whether an account owes a factor.
 *
 * `null` means it does not, and the caller mints a session exactly as it always
 * did — which is what makes 2FA opt-in rather than a flag every path has to
 * remember to check.
 *
 * There is deliberately no handle in here. It used to carry an `mfaToken` it had
 * just minted; the ceremony now promotes the caller's existing login flow, so the
 * client already holds the `loginId` that names it and re-issuing a value under a
 * second name would be inventing a seam rather than describing one.
 */
export interface MfaChallenge {
  readonly methods: readonly SignInMethod[];
  readonly expiresAt: Date;
}

/** A verified ceremony, handed back to whoever is going to mint the session. */
export interface ProvenFactor {
  readonly attempt: IdentifiedAttempt;
  readonly method: SignInMethod;
}
