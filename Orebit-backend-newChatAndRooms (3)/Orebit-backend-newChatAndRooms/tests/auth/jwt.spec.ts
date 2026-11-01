import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  bearerFrom,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../auth/security/jwt';
import { SESSION } from '../../auth/auth.constants';
import { secondsFromNow } from '../../src/utils/public.utils';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * The token layer, and the one file in `auth/` whose own docstring calls its test
 * non-negotiable.
 *
 * These are not round-trip tests with a few edge cases bolted on. Almost every
 * case below is an *attack*, because the module has no interesting behaviour
 * beyond refusing things.
 *
 * `jsonwebtoken` supplies the envelope, so these do not re-test base64 or JSON
 * parsing. What they test is everything the library leaves to the caller and gets
 * blamed for anyway: whether `algorithms` is actually pinned, whether the right
 * key is chosen, and whether the `typ` claim is asserted. Every historical JWT
 * CVE lives in that gap, not in the library's parser.
 *
 * Three properties are what actually matter, and each has a section:
 *
 *   1. Type confusion fails in both directions. One key signs both types, so this
 *      rests on the `aud` claim — `orebit/access` vs `orebit/refresh` — pinned at
 *      signing and demanded at verification, and enforced by the library rather
 *      than by us. The tests below therefore attack `aud` directly, since forging
 *      it is the whole of the attack now that no signature stands in the way.
 *   2. `alg` in the token header cannot steer verification anywhere it likes.
 *      ES256 is the only accepted value; `none` and HS256 are refused outright.
 *   3. A rejected token can never elicit `token_expired` for any reason other than
 *      being a genuine, correctly-typed, expired token — because that answer
 *      confirms to a forger that their payload parsed. With one key this no longer
 *      falls out of the signature check for free: `jsonwebtoken` would test `exp`
 *      before `aud`, so jwt.ts sets `ignoreExpiration` and enforces expiry itself,
 *      after `aud` and `typ`. Section 3 is what holds that in place.
 */

/** The one key. Both token types are signed with it. */
const SIGNING_KEY = loadKey(process.env.JWT_PRIVATE_KEY);

/** The secret this service signed with before it moved to asymmetric keys. Kept
 *  only so the tests below can prove tokens bearing it are now refused. */
const RETIRED_HS256_SECRET = 'test-jwt-secret-must-be-at-least-32-characters';

function loadKey(encoded: string | undefined): KeyObject {
  return createPrivateKey(Buffer.from(encoded as string, 'base64').toString('utf8'));
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** A well-formed access payload. Pass overrides to break exactly one thing. */
function accessClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-1',
    sid: 'session-1',
    pid: 'AB12CD',
    typ: 'access',
    aud: 'orebit/access',
    iss: 'orebit',
    iat: now(),
    exp: now() + SESSION.ACCESS_TTL_SECONDS,
    ...overrides,
  };
}

function refreshClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-1',
    sid: 'session-1',
    fam: 'family-1',
    typ: 'refresh',
    aud: 'orebit/refresh',
    iss: 'orebit',
    iat: now(),
    exp: now() + SESSION.IDLE_TIMEOUT_SECONDS,
    ...overrides,
  };
}

/** Claims minus one entry. A delete rather than a rest-destructure, which the
 *  lint config flags: it sets `argsIgnorePattern` but not `ignoreRestSiblings`. */
function without(claims: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...claims };
  delete copy[key];
  return copy;
}

/**
 * An ES256 token, built by hand rather than through `jwt.sign` so that `alg` and
 * the signing key can be made to disagree. The library refuses to produce such a
 * token, which is exactly why an attacker's version has to be simulated here.
 *
 * `dsaEncoding: 'ieee-p1363'` is load-bearing: JWS carries the raw r‖s pair, while
 * Node's default for ECDSA is DER. Get it wrong and every signature is rejected
 * for the wrong reason — the suite still passes, while proving nothing.
 */
function esToken(claims: unknown, key: KeyObject, alg = 'ES256'): string {
  const input = `${segment({ alg, typ: 'JWT' })}.${segment(claims)}`;
  const signature = cryptoSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

/** An HS256 token — exactly how every pre-migration token was produced. */
function hsToken(claims: unknown, secret: string | Buffer): string {
  const input = `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(claims)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function problem(run: () => unknown): ProblemException {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to throw, but it returned');
}

describe('the happy path', () => {
  it('round-trips an access token', () => {
    const { token, expiresAt } = signAccessToken({
      userId: 'user-1',
      sessionId: 'session-1',
      publicCode: 'AB12CD',
    });

    expect(verifyAccessToken(token)).toEqual({
      sub: 'user-1',
      sid: 'session-1',
      pid: 'AB12CD',
      typ: 'access',
    });
    // Within a second of the constant, not equal to it — the clock moves between
    // the call and the assertion.
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(
      SESSION.ACCESS_TTL_SECONDS * 1000 - 1000,
    );
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(SESSION.ACCESS_TTL_SECONDS * 1000);
  });

  it('round-trips a refresh token', () => {
    const { token } = signRefreshToken({
      userId: 'user-1',
      sessionId: 'session-1',
      familyId: 'family-1',
      expiresAt: secondsFromNow(SESSION.IDLE_TIMEOUT_SECONDS),
    });

    expect(verifyRefreshToken(token)).toEqual({
      sub: 'user-1',
      sid: 'session-1',
      fam: 'family-1',
      typ: 'refresh',
    });
  });

  it('advertises ES256 on the wire', () => {
    // Asserted because it is the point of the migration, and because a silent
    // fallback to HS256 would otherwise pass every other test in here.
    const { token } = signAccessToken({ userId: 'u', sessionId: 's', publicCode: 'p' });
    const header = JSON.parse(Buffer.from(token.split('.')[0] as string, 'base64url').toString());

    expect(header).toEqual({ alg: 'ES256', typ: 'JWT' });
  });

  it('emits a standard JWT any conforming library can verify', () => {
    // Interoperability is the reason to use a registered algorithm rather than a
    // private scheme. Nothing outside this process verifies these tokens today —
    // Orebit is a monolith, which is why there is one key — but the format staying
    // standard is what keeps that a choice rather than a wall.
    //
    // Verified here through the library's own API rather than through jwt.ts, so a
    // bug in our wrapper cannot make this pass.
    const { token } = signAccessToken({ userId: 'u', sessionId: 's', publicCode: 'p' });
    const claims = jwt.verify(token, createPublicKey(SIGNING_KEY), {
      algorithms: ['ES256'],
      issuer: 'orebit',
      audience: 'orebit/access',
    }) as Record<string, unknown>;

    expect(claims).toMatchObject({ sub: 'u', sid: 's', pid: 'p', typ: 'access' });
    expect(claims.aud).toBe('orebit/access');
    expect(claims.exp).toBeTypeOf('number');
  });
});

describe('type confusion — the invariant this file exists for', () => {
  it('accepts a hand-crafted token signed with the matching key', () => {
    // The positive control for every rejection below. Without it, a token built by
    // `esToken` could be failing for some reason unrelated to the key — a typo in
    // the claims, a broken helper — and the whole section would pass vacuously.
    expect(verifyAccessToken(esToken(accessClaims(), SIGNING_KEY))).toMatchObject({
      sub: 'user-1',
      typ: 'access',
    });
    expect(verifyRefreshToken(esToken(refreshClaims(), SIGNING_KEY))).toMatchObject({
      fam: 'family-1',
      typ: 'refresh',
    });
  });

  it('refuses a real refresh token where an access token belongs', () => {
    const { token } = signRefreshToken({
      userId: 'user-1',
      sessionId: 'session-1',
      familyId: 'family-1',
      expiresAt: secondsFromNow(SESSION.IDLE_TIMEOUT_SECONDS),
    });

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses a real access token where a refresh token belongs', () => {
    const { token } = signAccessToken({
      userId: 'user-1',
      sessionId: 'session-1',
      publicCode: 'AB12CD',
    });

    expect(problem(() => verifyRefreshToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses a refresh token whose `typ` has been rewritten to access', () => {
    // The attack the `aud` pin exists for, and the one that had no equivalent while
    // the keys were split — back then this token could not be produced at all
    // without the access private key. Now it can: everything an attacker holds is
    // signed by the same key as everything else, so `typ` alone is forgeable and
    // `aud` is what refuses it.
    const token = esToken(refreshClaims({ typ: 'access' }), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses an access token whose `typ` has been rewritten to refresh', () => {
    const token = esToken(accessClaims({ typ: 'refresh' }), SIGNING_KEY);

    expect(problem(() => verifyRefreshToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('ACCEPTS a token forging both `typ` and `aud` — the limit of a shared key', () => {
    // A refresh token rewritten into a flawless access token — every claim correct,
    // signed by the genuine key, indistinguishable from the real thing. It is
    // accepted, and that is not a bug: with one key this is not a forgery at all,
    // it is minting, and only possession of the private key makes it possible.
    //
    // Asserted rather than omitted because it is the honest boundary of the design.
    // Anyone holding the signing key can mint anything; `aud` defends against a
    // stolen *token*, never against a stolen *key*. Splitting the keypairs again is
    // the only thing that would change this line, so if it ever needs to change,
    // that is the conversation it should start.
    //
    // `pid` has to be supplied too — an access token carries claims a refresh token
    // does not, and `verifyAccessToken` demands them. That is a shape requirement
    // rather than a security boundary: it costs the key-holder one extra field.
    const token = esToken(
      refreshClaims({ typ: 'access', aud: 'orebit/access', pid: 'AB12CD' }),
      SIGNING_KEY,
    );

    expect(verifyAccessToken(token)).toMatchObject({ typ: 'access' });
  });

  it('refuses a token with no `aud` at all', () => {
    const token = esToken(without(accessClaims(), 'aud'), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses a token whose `aud` belongs to neither type', () => {
    const token = esToken(accessClaims({ aud: 'orebit/something-else' }), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses an `aud` edited after signing', () => {
    // The signature covers `aud`, so rewriting it in a genuine token breaks the
    // signature rather than the audience check. Both roads end at `token_invalid`;
    // this pins that there is no third road where the edit simply takes effect.
    const { token } = signRefreshToken({
      userId: 'user-1',
      sessionId: 'session-1',
      familyId: 'family-1',
      expiresAt: secondsFromNow(SESSION.IDLE_TIMEOUT_SECONDS),
    });
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${segment(refreshClaims({ aud: 'orebit/access' }))}.${signature}`;

    expect(problem(() => verifyAccessToken(tampered)).type).toBe(ERR.TOKEN_INVALID);
  });
});

describe('algorithm confusion', () => {
  it('refuses alg:none with an empty signature', () => {
    const claims = accessClaims();
    const unsigned = `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims)}.`;

    expect(problem(() => verifyAccessToken(unsigned)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses alg:none carrying a plausible-looking signature', () => {
    // The empty-signature case above can be caught by the structural check alone.
    // This one can only be caught by the `alg` allow-list, so it is the real test.
    const claims = accessClaims();
    const forged = `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims)}.ZmFrZQ`;

    expect(problem(() => verifyAccessToken(forged)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses HS256 signed with the Ed25519 public key as the HMAC secret', () => {
    // The classic asymmetric-to-symmetric downgrade: the public key is not secret,
    // so if `alg` could pick the *scheme* as well, anyone holding it could mint
    // tokens. Kept as a named case because it is the attack the `alg` check exists
    // for, even though the broader HS256 rejection below now subsumes it.
    const publicPem = createPublicKey(SIGNING_KEY).export({ type: 'spki', format: 'pem' });
    const token = hsToken(accessClaims(), publicPem as string);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses a header with no alg at all', () => {
    const input = `${segment({ typ: 'JWT' })}.${segment(accessClaims())}`;
    const signature = cryptoSign('sha256', Buffer.from(input), { key: SIGNING_KEY, dsaEncoding: 'ieee-p1363' });
    const token = `${input}.${signature.toString('base64url')}`;

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });
});

describe('`token_expired` is reserved for genuinely expired tokens', () => {
  /**
   * THE ordering section, and the one that got harder when the keys merged.
   *
   * `token_expired` tells the caller their token was real, correctly typed, and
   * merely stale. Anything else must answer `token_invalid`, or the error code
   * becomes an oracle confirming to a forger that their payload was understood.
   *
   * While each type had its own keypair this held for free: a wrong-type token
   * failed the signature, and `jsonwebtoken` checks signatures first. With one key
   * the signature now passes, and the library's own claim order — `exp` before
   * `aud` — would answer `token_expired` to an expired refresh token used as a
   * bearer. jwt.ts therefore passes `ignoreExpiration` and applies expiry itself,
   * after `aud` and `typ`. Every case below pins one step of that order.
   */

  it('reports a genuine expired token as expired', () => {
    const token = esToken(accessClaims({ iat: now() - 3600, exp: now() - 1 }), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_EXPIRED);
  });

  it('reports an expired token with the wrong `aud` as invalid, not expired', () => {
    // `aud` is enforced by the library, `exp` by us — so this pins that we removed
    // expiry from `jwt.verify`. Leave `ignoreExpiration` off and this returns
    // `token_expired`, because the library reaches `exp` before it reaches `aud`.
    const token = esToken(
      refreshClaims({ typ: 'access', iat: now() - 3600, exp: now() - 1 }),
      SIGNING_KEY,
    );

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('reports an expired token with the wrong `typ` as invalid, not expired', () => {
    // Both checks are ours here, so this pins their relative order inside jwt.ts:
    // `typ` first, `exp` second. Swap the two blocks and this test goes red.
    const token = esToken(accessClaims({ typ: 'refresh', iat: now() - 3600, exp: now() - 1 }), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('reports an expired token with a broken signature as invalid, not expired', () => {
    // `ignoreExpiration` does not weaken signature verification — the library still
    // rejects a bad signature before any claim is read, flag or no flag.
    const token = `${esToken(accessClaims({ iat: now() - 3600, exp: now() - 1 }), SIGNING_KEY).slice(0, -6)}AAAAAA`;

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('still refuses a token that expired one second ago', () => {
    // The boundary of the hand-rolled comparison. `exp` is the moment the token
    // dies, not the last moment it lives, and there is no clock tolerance.
    const token = esToken(accessClaims({ exp: now() - 1 }), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_EXPIRED);
  });

  it('refuses a token whose payload was edited after signing', () => {
    const { token } = signAccessToken({ userId: 'user-1', sessionId: 's', publicCode: 'p' });
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${segment(accessClaims({ sub: 'attacker' }))}.${signature}`;

    expect(problem(() => verifyAccessToken(tampered)).type).toBe(ERR.TOKEN_INVALID);
  });
});

describe('claim validation', () => {
  it('refuses a foreign issuer', () => {
    const token = esToken(accessClaims({ iss: 'not-orebit' }), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses a token with no expiry rather than treating it as eternal', () => {
    const token = esToken(without(accessClaims(), 'exp'), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses a non-numeric expiry', () => {
    const token = esToken(accessClaims({ exp: '9999999999' }), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses a token missing a required claim', () => {
    const token = esToken(without(accessClaims(), 'pid'), SIGNING_KEY);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it.each([
    ['a bare string', '"not-an-object"'],
    ['an array', '[1,2,3]'],
    ['null', 'null'],
    ['a number', '42'],
  ])('refuses a payload that is %s', (_label, json) => {
    // Indexing into any of these for `.typ` yields undefined, which without the
    // object check would read as a claim that merely failed to match — the right
    // outcome by accident, for the wrong reason, and not true of every claim.
    const input = `${segment({ alg: 'ES256', typ: 'JWT' })}.${Buffer.from(json).toString('base64url')}`;
    const signature = cryptoSign('sha256', Buffer.from(input), { key: SIGNING_KEY, dsaEncoding: 'ieee-p1363' });
    const token = `${input}.${signature.toString('base64url')}`;

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });
});

describe('malformed input', () => {
  it.each([
    ['empty', ''],
    ['no separators', 'notatoken'],
    ['two segments', 'aaa.bbb'],
    ['four segments', 'aaa.bbb.ccc.ddd'],
    ['empty header', '.bbb.ccc'],
    ['empty payload', 'aaa..ccc'],
    ['empty signature', 'aaa.bbb.'],
    ['separators only', '..'],
    ['not base64', '!!!.???.***'],
  ])('refuses %s', (_label, token) => {
    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
    expect(problem(() => verifyRefreshToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });
});

describe('HS256 is gone, not merely unused', () => {
  // This service signed with HS256 before it moved to asymmetric keys, and briefly
  // still verified it to carry sessions across the cutover. Both are gone, and
  // these are the headstone: a token that WOULD have verified a release ago now
  // does not, so nobody can quietly widen `algorithms` without a red test.

  it('refuses an otherwise perfect HS256 access token', () => {
    const token = hsToken(accessClaims(), RETIRED_HS256_SECRET);

    expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses an otherwise perfect HS256 refresh token', () => {
    const token = hsToken(refreshClaims(), RETIRED_HS256_SECRET);

    expect(problem(() => verifyRefreshToken(token)).type).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses HS256 whatever secret it was signed with', () => {
    // The rejection must come from `alg`, not from a secret mismatch — there is no
    // secret left to mismatch against, and that is the property under test.
    for (const secret of [RETIRED_HS256_SECRET, 'another-secret-of-sufficient-length', '']) {
      expect(problem(() => verifyAccessToken(hsToken(accessClaims(), secret))).type).toBe(
        ERR.TOKEN_INVALID,
      );
    }
  });

  // ES256 is deliberately absent — it is the one value that must be accepted, and
  // the positive control in the type-confusion block covers it.
  it.each(['HS384', 'HS512', 'RS256', 'ES384', 'ES512', 'PS256', 'EdDSA', 'none', ''])(
    'refuses alg:%s',
    (alg) => {
      // Signed correctly with the correct key; only the advertised `alg` differs.
      const token = esToken(accessClaims(), SIGNING_KEY, alg);

      expect(problem(() => verifyAccessToken(token)).type).toBe(ERR.TOKEN_INVALID);
    },
  );
});

describe('bearerFrom', () => {
  it('extracts the token', () => {
    expect(bearerFrom('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('accepts any casing of the scheme', () => {
    expect(bearerFrom('bearer abc')).toBe('abc');
    expect(bearerFrom('BEARER abc')).toBe('abc');
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['the wrong scheme', 'Basic abc'],
    ['a scheme with no value', 'Bearer'],
    ['a scheme with a blank value', 'Bearer  '],
  ])('returns null for %s', (_label, header) => {
    // Null rather than a throw: OptionalAuthGuard has to tell "no credential
    // offered" apart from "a credential that failed", and only the first may pass.
    expect(bearerFrom(header)).toBeNull();
  });
});
