import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { AdminRole } from '@prisma/client';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { config } from '../../src/config';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { secondsFromNow } from '../../src/utils/public.utils';
import { SESSION } from '../auth.constants';
import type { AccessClaims, RefreshClaims, TokenType } from '../auth.types';

/**
 * Signing and verification for the access/refresh pair. ES256 — ECDSA over
 * P-256 with SHA-256.
 *
 * ─── One key, two audiences ─────────────────────────────────────────────────
 *
 * There is a single signing key, `JWT_PRIVATE_KEY`, and it signs both token
 * types. The reason to keep separate keypairs was to hand a verifying-only public
 * half to a gateway or an edge worker, and there is no such consumer here. One
 * key is one secret to store, rotate and leak.
 *
 * That makes the access/refresh boundary a claim rather than a signature, and the
 * claim carrying it is `aud` — `orebit-admin/access` or `orebit-admin/refresh`,
 * pinned on both sides. A refresh token presented as a bearer therefore fails
 * inside `jwt.verify`, on an audience the library enforces, and never reaches our
 * own checks. `typ` is still asserted below, as defence in depth rather than as
 * the sole barrier.
 *
 * `aud` and not `typ` alone, deliberately: `audience` is an argument to
 * `jwt.verify`, so it cannot be dropped without deleting the line that verifies.
 * A hand-written `if (payload.typ !== expected)` is an easier thing to lose in a
 * refactor, and the consequence would be a refresh token that works as a bearer
 * for its full lifetime.
 *
 * The public key still exists — ECDSA cannot verify without it — but it is
 * derived from the private key at boot, never configured and never exported.
 *
 * ─── Why the issuer differs from the main backend ───────────────────────────
 *
 * `orebit-admin`, not `orebit`. The two services may end up sharing a signing key
 * through a common secret store, and if they did, an identical issuer and
 * audience would make a consumer access token verify here — silently granting a
 * user an admin principal. The issuer is what makes that a rejection rather than
 * a privilege escalation, so it must not be "tidied" to match.
 *
 * ─── Why ES256 and not EdDSA ────────────────────────────────────────────────
 *
 * Ed25519 is the better primitive: its nonce is derived deterministically, so the
 * repeated-`k` key-recovery failure that ECDSA is prone to cannot occur. We do
 * not use it because `jsonwebtoken` cannot emit it — the algorithm list is
 * hard-coded and `jwa` rejects the name — and the alternative was hand-assembling
 * the JWS ourselves. Owning that assembly means owning `alg` handling, claim
 * validation and segment parsing, which is exactly where this format's CVEs have
 * historically lived.
 *
 * ─── The two entry points ───────────────────────────────────────────────────
 *
 * There are exactly two, `verifyAccessToken` and `verifyRefreshToken`, both
 * routed through one private `verify` that takes the expected type and refuses
 * anything else. There is deliberately no general-purpose `decode` exported,
 * because a caller holding one would eventually check the signature and forget
 * the type.
 *
 * tests/auth/jwt.spec.ts asserts both directions of that confusion fail, along
 * with the algorithm-pinning and ordering properties. Treat that test as
 * non-negotiable.
 */

const ALGORITHM = 'ES256';
/** The curve ES256 mandates. Anything else is a different algorithm. */
const CURVE = 'prime256v1';
const ISSUER = 'orebit-admin';

/**
 * What a token is *for*, and since both types are signed by the same key, the
 * only thing that distinguishes them at verification time.
 *
 * Pinned on both sides — set in `sign`, demanded in `verify` — so the mismatch is
 * resolved by `jsonwebtoken` rather than by us.
 */
const AUDIENCE: Readonly<Record<TokenType, string>> = {
  access: 'orebit-admin/access',
  refresh: 'orebit-admin/refresh',
};

/**
 * `public` is not a second secret and is not configured anywhere: ECDSA
 * verification needs the public point, so it is computed from `private` at boot
 * and kept in memory. Nothing exports it.
 */
interface Keypair {
  readonly private: KeyObject;
  readonly public: KeyObject;
}

/**
 * Parsed once, at import, so a bad key fails the process at boot with the
 * variable's name — the contract src/config.ts provides for everything else, and
 * why the message is shaped like the ones it throws.
 *
 * The curve is checked here rather than left to the library. `jsonwebtoken` does
 * reject a wrong-curve key, but only when it first signs something, which is on
 * some admin's sign-in rather than on deploy.
 */
function loadKeypair(name: string, encoded: string): Keypair {
  let key: KeyObject;
  try {
    key = createPrivateKey(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error(
      `Invalid environment:\n  ${name}: not a base64-encoded PKCS#8 PEM private key`,
    );
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(
      `Invalid environment:\n  ${name}: expected an EC key, got ${key.asymmetricKeyType ?? 'unknown'}`,
    );
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== CURVE) {
    throw new Error(
      `Invalid environment:\n  ${name}: ${ALGORITHM} requires curve ${CURVE}, got ${curve ?? 'unknown'}`,
    );
  }
  return { private: key, public: createPublicKey(key) };
}

const KEY: Keypair = loadKeypair('JWT_PRIVATE_KEY', config.JWT_PRIVATE_KEY);

interface SignAccessInput {
  readonly adminId: string;
  readonly sessionId: string;
  readonly role: AdminRole;
  /**
   * The family's immutable `reauthenticateAt`. REQUIRED, not optional, and that is
   * the type system carrying a security invariant — the same reasoning as
   * `SessionService.issue`'s required `mfaMethod`. An optional ceiling is a ceiling
   * the next caller forgets, and forgetting it here mints a token that outlives the
   * absolute lifetime it was supposed to be bounded by.
   */
  readonly ceilingAt: Date;
}

interface SignRefreshInput {
  readonly adminId: string;
  readonly sessionId: string;
  readonly familyId: string;

  /**
   * The family's immutable `reauthenticateAt` — the same value `SignAccessInput`
   * takes, and required for the same reason.
   *
   * ═══ WHY THE CEILING AND NOT THE IDLE DEADLINE ═════════════════════════════
   *
   * This used to be the session row's `expiresAt`, i.e. `min(idle window, ceiling)`,
   * and that made the token carry a SECOND COPY of a deadline that moves.
   *
   * The idle deadline is advanced by `touch` on every eligible request. A signed JWT
   * cannot be advanced. Worse, the ordering guarantees the copy is stale the instant
   * it is made: `bff.resolve` mints at guards.ts:191 and `sessions.touch` advances
   * the row at guards.ts:235, fire-and-forget. So the token always froze a deadline
   * the row was about to move past — and an admin working continuously could reach
   * that frozen instant while their session had hours of life left, and be signed
   * out with `token_expired`.
   *
   * The ceiling has the opposite property: it is written once by the three-factor
   * sign-in and copied byte-for-byte into every generation, so a token bounded by it
   * can never disagree with the row.
   *
   * This does not lengthen any session. The idle policy is unchanged and still
   * enforced, in the one place that can enforce it correctly — `SessionService.rotate`
   * re-reads `session.expiresAt` from PostgreSQL on every refresh, and `readLiveness`
   * checks it on every request. What was removed is a duplicate, not a control.
   */
  readonly ceilingAt: Date;
}

/**
 * Seconds until `deadline`, never more than `cap` and never less than one.
 *
 * Rounds DOWN. A ceiling rounded up is not a ceiling, and `Math.ceil` on a
 * sub-second remainder puts the token's `exp` past the instant it was clamped to —
 * a second of admin access nobody authorised. The floor of one second is for a
 * deadline already reached: callers reject those before getting here, so the only
 * way to arrive with one is a bug, and a token that is instantly expired is the
 * safe way to express it. `expiresIn: 0` would be a token valid forever in some
 * readings, which is the opposite.
 */
function boundedTtl(deadline: Date, cap: number): number {
  return Math.max(1, Math.min(cap, Math.floor((deadline.getTime() - Date.now()) / 1000)));
}

/**
 * Fifteen minutes, or less if the family ceiling falls inside them.
 *
 * The clamp is defence in depth, not the enforcement: `AuthGuard` calls
 * `assertLive` on every request and `SessionDbOperation.isUnusable` checks
 * `reauthenticateAt` in Postgres, so a session past its ceiling is refused whatever
 * its access token says. But without the clamp a rotation at 11:59 hands out a
 * bearer whose own `exp` is hour 12:14, and the only thing standing between that
 * token and a live admin session is a database round-trip that some future
 * fast-path may decide to skip. Cheaper to make the token honest.
 */
export function signAccessToken(input: SignAccessInput): { token: string; expiresAt: Date } {
  const ttl = boundedTtl(input.ceilingAt, SESSION.ACCESS_TTL_SECONDS);
  const token = jwt.sign(
    { sub: input.adminId, sid: input.sessionId, rol: input.role, typ: 'access' },
    KEY.private,
    {
      algorithm: ALGORITHM,
      issuer: ISSUER,
      audience: AUDIENCE.access,
      expiresIn: ttl,
    },
  );
  return { token, expiresAt: secondsFromNow(ttl) };
}

/**
 * The refresh token expires when the SIGN-IN does — never later, and never earlier.
 *
 * Bounding it by the family ceiling makes it a ceiling rather than a deadline: it
 * cannot outlive the sign-in that produced it, and it cannot die while that sign-in
 * is still alive. The idle window is not its business — see `SignRefreshInput`.
 *
 * `ABSOLUTE_TTL_SECONDS` is a second belt: a row whose `reauthenticateAt` were
 * somehow far in the future — a bad backfill, a hand-edited record — still cannot
 * mint a refresh token that outlives one family lifetime.
 */
export function signRefreshToken(input: SignRefreshInput): { token: string; expiresAt: Date } {
  const ttl = boundedTtl(input.ceilingAt, SESSION.ABSOLUTE_TTL_SECONDS);
  const token = jwt.sign(
    { sub: input.adminId, sid: input.sessionId, fam: input.familyId, typ: 'refresh' },
    KEY.private,
    {
      algorithm: ALGORITHM,
      issuer: ISSUER,
      audience: AUDIENCE.refresh,
      expiresIn: ttl,
    },
  );
  return { token, expiresAt: secondsFromNow(ttl) };
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = verify(token, 'access');
  const { sub, sid, rol } = payload;
  if (typeof sub !== 'string' || typeof sid !== 'string' || !isAdminRole(rol)) {
    throw new ProblemException({ type: ERR.TOKEN_INVALID });
  }
  return { sub, sid, rol, typ: 'access' };
}

export function verifyRefreshToken(token: string): RefreshClaims {
  const payload = verify(token, 'refresh');
  const { sub, sid, fam } = payload;
  if (typeof sub !== 'string' || typeof sid !== 'string' || typeof fam !== 'string') {
    throw new ProblemException({ type: ERR.TOKEN_INVALID });
  }
  return { sub, sid, fam, typ: 'refresh' };
}

/**
 * The role claim is validated against the closed set rather than merely checked
 * for `typeof === 'string'`.
 *
 * It is the one claim a future RBAC guard will make a decision from, so an
 * unrecognised value must be a rejected token and never a principal carrying a
 * role nothing in the codebase handles.
 */
function isAdminRole(value: unknown): value is AdminRole {
  return value === 'SUPER_ADMIN' || value === 'ADMIN';
}

/**
 * The single verification path.
 *
 * `algorithms` is pinned rather than left to the library's default, which is the
 * standard algorithm-confusion defence: without it a token whose header claims
 * `alg: none` is accepted as valid, and one claiming `HS256` invites the classic
 * asymmetric-to-symmetric downgrade in which the public key — not a secret — is
 * used as the HMAC key.
 *
 * The audience comes from `expected`, the caller's demand, and never from
 * anything inside the token. That is what makes the split audiences load-bearing.
 *
 * ─── Why `exp` is checked here and not by the library ───────────────────────
 *
 * A forgery must surface as `token_invalid` and never as `token_expired`: the
 * latter confirms to a forger that their payload was parsed and understood, which
 * is a signal they should never get.
 *
 * `jsonwebtoken` checks claims in the order `nbf → exp → aud → iss`, and offers
 * no way to reorder them. Since one key signs both token types, a refresh token
 * presented as a bearer gets a VALID signature and is caught at `aud` — but if it
 * had also expired, `exp` would fire first and answer `token_expired`. So we take
 * `exp` off the library and enforce it ourselves, below, once `aud` and `typ`
 * have had their say.
 *
 * `ignoreExpiration` reads alarmingly and does the opposite of what it looks
 * like: expiry is still mandatory, still rejected, and additionally still
 * *required* to be present — see the `typeof payload.exp` check, which the
 * library never made. Signature verification is unaffected by the flag and
 * continues to run first.
 */
function verify(token: string, expected: TokenType): JwtPayload {
  let payload: string | JwtPayload;
  try {
    payload = jwt.verify(token, KEY.public, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE[expected],
      ignoreExpiration: true,
    });
  } catch {
    // Every failure in here is a signature, an algorithm, an issuer, an audience
    // or a malformed token — never an expiry, which is now ours. So there is no
    // `TokenExpiredError` left to distinguish, and everything is `token_invalid`.
    throw new ProblemException({ type: ERR.TOKEN_INVALID });
  }

  if (typeof payload === 'string') {
    throw new ProblemException({ type: ERR.TOKEN_INVALID });
  }

  // Defence in depth: a wrong-type token has already failed the `aud` check
  // inside `jwt.verify`. Kept because the claim is cheap, and because `aud` and
  // `typ` disagreeing means a token minted by something that is not this file.
  //
  // Ordering matters and is not incidental: this runs BEFORE the expiry check
  // below, so a wrong-type token is `token_invalid` whether or not it has also
  // expired. That is the whole reason `ignoreExpiration` is set above.
  if (payload.typ !== expected) {
    throw new ProblemException({ type: ERR.TOKEN_INVALID });
  }

  // `jsonwebtoken` treats a token with no `exp` as one that never expires, and
  // says nothing about it. Every token we issue carries one, so reaching this
  // branch means either a signing path that forgot `expiresIn` or a token minted
  // with a leaked key — and in both cases an eternal credential is the worst
  // possible reading. Demanded explicitly because the library will not.
  if (typeof payload.exp !== 'number') {
    throw new ProblemException({ type: ERR.TOKEN_INVALID });
  }

  // The expiry check the library would have done, moved here so it lands after
  // the two above. `exp` is seconds since the epoch, and the comparison is
  // inclusive: a token is dead ON its expiry second, not one second later. No
  // clock tolerance, matching the library's own default of zero.
  if (payload.exp * 1000 <= Date.now()) {
    throw new ProblemException({ type: ERR.TOKEN_EXPIRED });
  }

  return payload;
}

/**
 * Extracts a bearer token from an Authorization header.
 *
 * Returns null rather than throwing so `OptionalAuthGuard` can distinguish "no
 * credential offered" from "a credential that failed" — the first is allowed on
 * `/auth/session`, the second never is.
 */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim() || null;
}
