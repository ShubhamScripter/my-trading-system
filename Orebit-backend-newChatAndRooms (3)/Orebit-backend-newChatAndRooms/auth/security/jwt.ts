import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
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
 * There is a single signing key, `JWT_PRIVATE_KEY`, and it signs both token types.
 * Orebit is a monolith: the reason to keep separate keypairs was to hand a
 * verifying-only public half to a gateway or an edge worker, and there is no such
 * consumer here. One key is one secret to store, rotate and leak.
 *
 * That makes the access/refresh boundary a claim rather than a signature, and the
 * claim carrying it is `aud` — `orebit/access` or `orebit/refresh`, pinned on both
 * sides. A refresh token presented as a bearer therefore fails inside `jwt.verify`,
 * on an audience the library enforces, and never reaches our own checks. `typ` is
 * still asserted below, as defence in depth rather than as the sole barrier.
 *
 * `aud` and not `typ` alone, deliberately: `audience` is an argument to `jwt.verify`,
 * so it cannot be dropped without deleting the line that verifies. A hand-written
 * `if (payload.typ !== expected)` is an easier thing to lose in a refactor, and this
 * used to be a service where `typ` was the ONLY thing standing between a 30-day
 * refresh token and 30 days of API access.
 *
 * The public key still exists — ECDSA cannot verify without it — but it is derived
 * from the private key at boot, never configured and never exported.
 *
 * ─── Why ES256 and not EdDSA ────────────────────────────────────────────────
 *
 * Ed25519 is the better primitive: its nonce is derived deterministically, so the
 * repeated-`k` key-recovery failure that ECDSA is prone to cannot occur. We do not
 * use it because `jsonwebtoken` cannot emit it — the algorithm list is hard-coded
 * and `jwa` rejects the name — and the alternative was hand-assembling the JWS
 * ourselves. Owning that assembly means owning `alg` handling, claim validation
 * and segment parsing, which is exactly where this format's CVEs have historically
 * lived. ES256 keeps a maintained library in charge of all of it, and ECDSA's nonce
 * comes from OpenSSL's CSPRNG, which is not a practical weakness here.
 *
 * ─── The two entry points ───────────────────────────────────────────────────
 *
 * There are exactly two, `verifyAccessToken` and `verifyRefreshToken`, both routed
 * through one private `verify` that takes the expected type and refuses anything
 * else. There is deliberately no general-purpose `decode` exported, because a
 * caller holding one would eventually check the signature and forget the type.
 *
 * tests/auth/jwt.spec.ts asserts both directions of that confusion fail, along
 * with the algorithm-pinning and ordering properties. Treat that test as
 * non-negotiable.
 */

const ALGORITHM = 'ES256';
/** The curve ES256 mandates. Anything else is a different algorithm. */
const CURVE = 'prime256v1';
const ISSUER = 'orebit';

/**
 * What a token is *for*, and since both types are signed by the same key, the only
 * thing that distinguishes them at verification time.
 *
 * Pinned on both sides — set in `sign`, demanded in `verify` — so the mismatch is
 * resolved by `jsonwebtoken` rather than by us.
 */
const AUDIENCE: Readonly<Record<TokenType, string>> = {
  access: 'orebit/access',
  refresh: 'orebit/refresh',
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
 * some user's login rather than on deploy.
 */
function loadKeypair(name: string, encoded: string): Keypair {
  let key: KeyObject;
  try {
    key = createPrivateKey(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error(`Invalid environment:\n  ${name}: not a base64-encoded PKCS#8 PEM private key`);
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
  readonly userId: string;
  readonly sessionId: string;
  readonly publicCode: string;
}

interface SignRefreshInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly familyId: string;
  /**
   * When the session row itself expires — NOT a constant TTL.
   *
   * The token must not outlive its row, and must not die before it either. Once
   * the row's expiry became variable (an idle window, or a trusted device's longer
   * one), signing this from a fixed constant would break in whichever direction
   * the constant was wrong: too short and a trusted device is quietly logged out
   * while its row is still live; too long and the token survives a session the
   * database has already retired.
   */
  readonly expiresAt: Date;
}

export function signAccessToken(input: SignAccessInput): { token: string; expiresAt: Date } {
  const token = jwt.sign(
    { sub: input.userId, sid: input.sessionId, pid: input.publicCode, typ: 'access' },
    KEY.private,
    {
      algorithm: ALGORITHM,
      issuer: ISSUER,
      audience: AUDIENCE.access,
      expiresIn: SESSION.ACCESS_TTL_SECONDS,
    },
  );
  return { token, expiresAt: secondsFromNow(SESSION.ACCESS_TTL_SECONDS) };
}

export function signRefreshToken(input: SignRefreshInput): { token: string; expiresAt: Date } {
  const token = jwt.sign(
    { sub: input.userId, sid: input.sessionId, fam: input.familyId, typ: 'refresh' },
    KEY.private,
    {
      algorithm: ALGORITHM,
      issuer: ISSUER,
      audience: AUDIENCE.refresh,
      // Rounded up: a sub-second remainder floored to 0 would sign a token that is
      // already expired, and `jwt.sign` rejects a negative value outright.
      expiresIn: Math.max(1, Math.ceil((input.expiresAt.getTime() - Date.now()) / 1000)),
    },
  );
  return { token, expiresAt: input.expiresAt };
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = verify(token, 'access');
  const { sub, sid, pid } = payload;
  if (typeof sub !== 'string' || typeof sid !== 'string' || typeof pid !== 'string') {
    throw new ProblemException({ type: ERR.TOKEN_INVALID });
  }
  return { sub, sid, pid, typ: 'access' };
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
 * The single verification path.
 *
 * `algorithms` is pinned rather than left to the library's default, which is the
 * standard algorithm-confusion defence: without it a token whose header claims
 * `alg: none` is accepted as valid, and one claiming `HS256` invites the classic
 * asymmetric-to-symmetric downgrade in which the public key — not a secret — is
 * used as the HMAC key.
 *
 * The audience comes from `expected`, the caller's demand, and never from anything
 * inside the token. That is what makes the split audiences load-bearing.
 *
 * ─── Why `exp` is checked here and not by the library ───────────────────────
 *
 * A forgery must surface as `token_invalid` and never as `token_expired`: the
 * latter confirms to a forger that their payload was parsed and understood, which
 * is a signal they should never get. tests/auth/jwt.spec.ts pins that ordering.
 *
 * `jsonwebtoken` checks claims in the order `nbf → exp → aud → iss`, and offers no
 * way to reorder them. Since one key now signs both token types, a refresh token
 * presented as a bearer gets a VALID signature and is caught at `aud` — but if it
 * had also expired, `exp` would fire first and answer `token_expired`. So we take
 * `exp` off the library and enforce it ourselves, below, once `aud` and `typ` have
 * had their say.
 *
 * `ignoreExpiration` reads alarmingly and does the opposite of what it looks like:
 * expiry is still mandatory, still rejected, and additionally still *required* to
 * be present — see the `typeof payload.exp` check, which the library never made.
 * Signature verification is unaffected by the flag and continues to run first.
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

  // Defence in depth: a wrong-type token has already failed the `aud` check inside
  // `jwt.verify`. Kept because the claim is cheap, and because `aud` and `typ`
  // disagreeing means a token minted by something that is not this file.
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

  // The expiry check the library would have done, moved here so it lands after the
  // two above. `exp` is seconds since the epoch, and the comparison is inclusive:
  // a token is dead ON its expiry second, not one second later. No clock tolerance,
  // matching the library's own default of zero.
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
