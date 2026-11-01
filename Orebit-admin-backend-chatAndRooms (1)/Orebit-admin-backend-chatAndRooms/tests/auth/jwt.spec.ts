import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { SESSION } from '../../auth/auth.constants';
import {
  bearerFrom,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../auth/security/jwt';
import { config } from '../../src/config';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * ═══ NON-NEGOTIABLE ══════════════════════════════════════════════════════════
 *
 * These tests pin the properties that stand between a 12-hour refresh token and
 * 12 hours of unauthenticated admin API access. Every one of them corresponds to
 * a real, published class of JWT vulnerability.
 *
 * If a change makes a test in this file fail, the change is wrong. Do not adjust
 * the expectations.
 */

const ISSUER = 'orebit-admin';
const ADMIN_ID = '01920000-0000-7000-8000-00000000000a';
const SESSION_ID = '01920000-0000-7000-8000-00000000000b';
const FAMILY_ID = '01920000-0000-7000-8000-00000000000c';

/** The real signing key, so hand-forged tokens carry a VALID signature — which is
 *  the only way to test that the claim checks, not the signature, are what reject
 *  them. */
const PRIVATE_KEY = createPrivateKey(
  Buffer.from(config.JWT_PRIVATE_KEY, 'base64').toString('utf8'),
);
const PUBLIC_KEY = createPublicKey(PRIVATE_KEY);

/**
 * Deadlines far enough away that neither clamp bites, for the tests that are about
 * CLAIMS rather than lifetimes. The clamping itself has its own block at the bottom
 * of this file, where the deadlines are deliberately close.
 */
const FAR_CEILING = (): Date => new Date(Date.now() + SESSION.ABSOLUTE_TTL_SECONDS * 1000);
const FAR_EXPIRY = (): Date => new Date(Date.now() + SESSION.INACTIVITY_TIMEOUT_SECONDS * 1000);

function slugOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProblemException) return err.type;
    return `unexpected: ${String(err)}`;
  }
  return 'did not throw';
}

/** Sign an arbitrary payload with the real key. For forging the tokens a genuine
 *  attacker could not produce, so the test proves the claim checks work. */
function forge(payload: Record<string, unknown>, options: jwt.SignOptions = {}): string {
  return jwt.sign(payload, PRIVATE_KEY, { algorithm: 'ES256', ...options });
}

describe('the happy path', () => {
  it('round-trips an access token with its claims intact', () => {
    const { token, expiresAt } = signAccessToken({
      adminId: ADMIN_ID,
      sessionId: SESSION_ID,
      role: 'SUPER_ADMIN',
      ceilingAt: FAR_CEILING(),
    });
    const claims = verifyAccessToken(token);

    expect(claims).toEqual({
      sub: ADMIN_ID,
      sid: SESSION_ID,
      rol: 'SUPER_ADMIN',
      typ: 'access',
    });
    // Within a second of the configured TTL, allowing for test execution time.
    const expectedMs = Date.now() + SESSION.ACCESS_TTL_SECONDS * 1000;
    expect(Math.abs(expiresAt.getTime() - expectedMs)).toBeLessThan(1000);
  });

  it('round-trips a refresh token with its claims intact', () => {
    const { token } = signRefreshToken({
      adminId: ADMIN_ID,
      sessionId: SESSION_ID,
      familyId: FAMILY_ID,
      ceilingAt: FAR_EXPIRY(),
    });
    expect(verifyRefreshToken(token)).toEqual({
      sub: ADMIN_ID,
      sid: SESSION_ID,
      fam: FAMILY_ID,
      typ: 'refresh',
    });
  });

  it('issues a refresh token that outlives its access token', () => {
    // The ratio is the reason the pair exists. If these were equal there would be
    // nothing to refresh.
    expect(SESSION.INACTIVITY_TIMEOUT_SECONDS).toBeGreaterThan(SESSION.ACCESS_TTL_SECONDS);
  });

  it('bounds the idle window by the absolute ceiling', () => {
    // An idle window longer than the ceiling would make the ceiling unreachable by
    // the sliding clock and the two constants would silently be one.
    expect(SESSION.ABSOLUTE_TTL_SECONDS).toBeGreaterThan(SESSION.INACTIVITY_TIMEOUT_SECONDS);
  });
});

describe('token confusion — both directions must fail', () => {
  /**
   * ONE key signs both token types, so the boundary between them is the pinned
   * `aud` claim rather than the signature. This is THE test for that design: a
   * refresh token presented as a bearer has a perfectly valid signature and must
   * still be refused.
   *
   * If this fails, a stolen refresh token is a 12-hour admin API credential.
   */
  it('refuses a refresh token presented as an access token', () => {
    const { token } = signRefreshToken({
      adminId: ADMIN_ID,
      sessionId: SESSION_ID,
      familyId: FAMILY_ID,
      ceilingAt: FAR_EXPIRY(),
    });
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses an access token presented as a refresh token', () => {
    const { token } = signAccessToken({
      adminId: ADMIN_ID,
      sessionId: SESSION_ID,
      role: 'ADMIN',
      ceilingAt: FAR_CEILING(),
    });
    expect(slugOf(() => verifyRefreshToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  /** `typ` is defence in depth behind `aud`. A token whose two disagree was minted
   *  by something that is not our signing path, and is refused. */
  it('refuses a token whose aud and typ disagree', () => {
    const token = forge(
      { sub: ADMIN_ID, sid: SESSION_ID, rol: 'ADMIN', typ: 'refresh' },
      { issuer: ISSUER, audience: 'orebit-admin/access', expiresIn: 600 },
    );
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });
});

describe('algorithm pinning', () => {
  /**
   * The classic asymmetric-to-symmetric downgrade. Without `algorithms: ['ES256']`
   * pinned at verification, a token claiming `alg: HS256` is verified by HMAC using
   * the PUBLIC key as the shared secret — and the public key is not a secret, so
   * anyone can mint valid tokens.
   */
  it('refuses an HS256 token signed with the public key as the HMAC secret', () => {
    const publicPem = PUBLIC_KEY.export({ type: 'spki', format: 'pem' }).toString();
    const token = jwt.sign(
      { sub: ADMIN_ID, sid: SESSION_ID, rol: 'SUPER_ADMIN', typ: 'access' },
      publicPem,
      { algorithm: 'HS256', issuer: ISSUER, audience: 'orebit-admin/access', expiresIn: 600 },
    );
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  /** `alg: none` — an unsigned token. Historically accepted by libraries that
   *  trusted the header. */
  it('refuses an unsigned (alg: none) token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: ADMIN_ID,
        sid: SESSION_ID,
        rol: 'SUPER_ADMIN',
        typ: 'access',
        iss: ISSUER,
        aud: 'orebit-admin/access',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    expect(slugOf(() => verifyAccessToken(`${header}.${payload}.`))).toBe(ERR.TOKEN_INVALID);
  });

  /** A token signed by a DIFFERENT ES256 key. Right algorithm, wrong signer. */
  it('refuses a token signed with a different key', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const token = jwt.sign(
      { sub: ADMIN_ID, sid: SESSION_ID, rol: 'SUPER_ADMIN', typ: 'access' },
      privateKey,
      { algorithm: 'ES256', issuer: ISSUER, audience: 'orebit-admin/access', expiresIn: 600 },
    );
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });
});

describe('the issuer separates this service from the consumer backend', () => {
  /**
   * ═══ PRIVILEGE-ESCALATION GUARD ════════════════════════════════════════════
   *
   * The two services may end up sharing a signing key through a common secret
   * store. If they did and the issuer matched, a CONSUMER access token would
   * verify here and hand its bearer an admin principal.
   *
   * The issuer string is the only thing making that a rejection. Do not "tidy" it
   * to match the other service.
   */
  it('refuses a token issued by "orebit" rather than "orebit-admin"', () => {
    const token = forge(
      { sub: ADMIN_ID, sid: SESSION_ID, rol: 'SUPER_ADMIN', typ: 'access' },
      { issuer: 'orebit', audience: 'orebit-admin/access', expiresIn: 600 },
    );
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses a token with the consumer backend\'s audience', () => {
    const token = forge(
      { sub: ADMIN_ID, sid: SESSION_ID, rol: 'SUPER_ADMIN', typ: 'access' },
      { issuer: ISSUER, audience: 'orebit/access', expiresIn: 600 },
    );
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  it('refuses a token with no issuer or no audience at all', () => {
    expect(
      slugOf(() =>
        verifyAccessToken(
          forge({ sub: ADMIN_ID, sid: SESSION_ID, rol: 'ADMIN', typ: 'access' }, { expiresIn: 600 }),
        ),
      ),
    ).toBe(ERR.TOKEN_INVALID);
  });
});

describe('expiry, and the ordering of the checks', () => {
  it('reports a genuinely expired, otherwise-valid token as expired', () => {
    const token = forge(
      { sub: ADMIN_ID, sid: SESSION_ID, rol: 'ADMIN', typ: 'access' },
      { issuer: ISSUER, audience: 'orebit-admin/access', expiresIn: -10 },
    );
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_EXPIRED);
  });

  /**
   * ═══ THE ORDERING PROPERTY ═════════════════════════════════════════════════
   *
   * `token_expired` confirms to a forger that their payload was PARSED AND
   * UNDERSTOOD. A forgery must never earn that signal — it must be
   * `token_invalid`, indistinguishable from garbage.
   *
   * `jsonwebtoken` checks claims in the order `nbf → exp → aud → iss` and offers
   * no way to reorder them, which is why jwt.ts sets `ignoreExpiration: true` and
   * enforces expiry itself AFTER the audience and type checks. These two tests are
   * the reason that flag is set; without them it reads like a mistake.
   */
  it('reports an EXPIRED WRONG-TYPE token as invalid, not expired', () => {
    const token = forge(
      { sub: ADMIN_ID, sid: SESSION_ID, fam: FAMILY_ID, typ: 'refresh' },
      { issuer: ISSUER, audience: 'orebit-admin/refresh', expiresIn: -10 },
    );
    // Presented as an access token: wrong audience AND expired. The wrong audience
    // must win.
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  it('reports an EXPIRED WRONG-ISSUER token as invalid, not expired', () => {
    const token = forge(
      { sub: ADMIN_ID, sid: SESSION_ID, rol: 'ADMIN', typ: 'access' },
      { issuer: 'orebit', audience: 'orebit-admin/access', expiresIn: -10 },
    );
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  /**
   * A token with no `exp` at all. `jsonwebtoken` treats that as "never expires"
   * and says nothing about it, so jwt.ts demands the claim explicitly. An eternal
   * admin credential is the worst possible reading of a missing field.
   */
  it('refuses a token carrying no expiry claim', () => {
    const token = forge(
      { sub: ADMIN_ID, sid: SESSION_ID, rol: 'SUPER_ADMIN', typ: 'access' },
      { issuer: ISSUER, audience: 'orebit-admin/access' },
    );
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  /** Dead ON the expiry second, not one second later. No clock tolerance. */
  it('treats the expiry instant itself as expired', () => {
    const token = forge(
      {
        sub: ADMIN_ID,
        sid: SESSION_ID,
        rol: 'ADMIN',
        typ: 'access',
        exp: Math.floor(Date.now() / 1000),
      },
      { issuer: ISSUER, audience: 'orebit-admin/access' },
    );
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_EXPIRED);
  });
});

describe('claim validation', () => {
  it.each(['sub', 'sid', 'rol'])('refuses an access token missing %s', (missing) => {
    const claims: Record<string, unknown> = {
      sub: ADMIN_ID,
      sid: SESSION_ID,
      rol: 'ADMIN',
      typ: 'access',
    };
    delete claims[missing];
    const token = forge(claims, {
      issuer: ISSUER,
      audience: 'orebit-admin/access',
      expiresIn: 600,
    });
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  it.each(['sub', 'sid', 'fam'])('refuses a refresh token missing %s', (missing) => {
    const claims: Record<string, unknown> = {
      sub: ADMIN_ID,
      sid: SESSION_ID,
      fam: FAMILY_ID,
      typ: 'refresh',
    };
    delete claims[missing];
    const token = forge(claims, {
      issuer: ISSUER,
      audience: 'orebit-admin/refresh',
      expiresIn: 600,
    });
    expect(slugOf(() => verifyRefreshToken(token))).toBe(ERR.TOKEN_INVALID);
  });

  /**
   * `rol` is validated against the closed set, not merely checked for being a
   * string. It is the claim a future RBAC guard will branch on, so an unrecognised
   * value must be a REJECTED TOKEN and never a principal carrying a role nothing
   * in the codebase handles.
   */
  it.each(['ROOT', 'admin', 'SUPERADMIN', '', 'OWNER'])(
    'refuses an unrecognised role %j',
    (role) => {
      const token = forge(
        { sub: ADMIN_ID, sid: SESSION_ID, rol: role, typ: 'access' },
        { issuer: ISSUER, audience: 'orebit-admin/access', expiresIn: 600 },
      );
      expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
    },
  );

  it.each([42, null, true, { role: 'ADMIN' }, ['ADMIN']])(
    'refuses a non-string role %j',
    (role) => {
      const token = forge(
        { sub: ADMIN_ID, sid: SESSION_ID, rol: role, typ: 'access' },
        { issuer: ISSUER, audience: 'orebit-admin/access', expiresIn: 600 },
      );
      expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
    },
  );

  it('accepts both real roles', () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      const { token } = signAccessToken({
        adminId: ADMIN_ID,
        sessionId: SESSION_ID,
        role,
        ceilingAt: FAR_CEILING(),
      });
      expect(verifyAccessToken(token).rol).toBe(role);
    }
  });
});

/**
 * ═══ NEITHER TOKEN MAY OUTLIVE THE DEADLINE IT WAS HANDED ═══════════════════════
 *
 * These read the `exp` claim rather than the returned `expiresAt`, because `exp` is
 * the number a verifier acts on — a returned date that disagreed with it would be a
 * comforting lie. The window near a family's absolute ceiling is exactly where the
 * old code handed out a fifteen-minute bearer for a session with one minute to live.
 */
describe('lifetime clamping', () => {
  /** `exp`, in ms, as any verifier would read it. */
  function expOf(token: string): number {
    const claims = jwt.decode(token) as { exp: number };
    return claims.exp * 1000;
  }

  it('clamps an access token to a ceiling closer than 15 minutes', () => {
    const ceilingAt = new Date(Date.now() + 60_000); // one minute of session left
    const { token, expiresAt } = signAccessToken({
      adminId: ADMIN_ID,
      sessionId: SESSION_ID,
      role: 'ADMIN',
      ceilingAt,
    });

    // Never past the ceiling — the whole point. The 1s slack is the floor rounding.
    expect(expOf(token)).toBeLessThanOrEqual(ceilingAt.getTime());
    expect(expOf(token)).toBeGreaterThan(ceilingAt.getTime() - 2000);
    // And the reported date agrees with the signed claim.
    expect(Math.abs(expiresAt.getTime() - expOf(token))).toBeLessThan(1000);
  });

  it('leaves an access token at its full TTL when the ceiling is far away', () => {
    const { token } = signAccessToken({
      adminId: ADMIN_ID,
      sessionId: SESSION_ID,
      role: 'ADMIN',
      ceilingAt: FAR_CEILING(),
    });
    const expected = Date.now() + SESSION.ACCESS_TTL_SECONDS * 1000;
    expect(Math.abs(expOf(token) - expected)).toBeLessThan(2000);
  });

  /**
   * ═══ THE CEILING, NOT THE SLIDING IDLE DEADLINE (F03) ══════════════════════
   *
   * This asserted the row's `expiresAt` — the idle deadline — and that was the bug.
   * `touch` moves that deadline forward on every eligible request; a signed JWT
   * cannot move with it, and the mint happens BEFORE the touch (guards.ts:191 vs
   * :235), so the token always froze a value the row was about to leave behind. An
   * admin working continuously could reach the frozen instant with hours of session
   * left and be signed out with `token_expired`.
   *
   * Bounding by the ceiling removes the disagreement: the ceiling is written once by
   * the three-factor sign-in and copied verbatim into every generation, so it cannot
   * drift from the row. The idle rule did not move into the token and did not go
   * away — it is enforced on the row by `SessionService.rotate`, which re-reads it.
   */
  it('signs a refresh token to the family ceiling, not the sliding idle deadline', () => {
    const ceilingAt = new Date(Date.now() + 90_000);
    const { token } = signRefreshToken({
      adminId: ADMIN_ID,
      sessionId: SESSION_ID,
      familyId: FAMILY_ID,
      ceilingAt,
    });
    expect(expOf(token)).toBeLessThanOrEqual(ceilingAt.getTime());
    expect(expOf(token)).toBeGreaterThan(ceilingAt.getTime() - 2000);
  });

  /**
   * The other half of the same guarantee: a token must never outlive the sign-in it
   * belongs to. Stated separately from the cap below because they fail differently —
   * this one catches a ceiling passed through wrongly, that one catches a corrupt
   * ceiling.
   */
  it('never signs a refresh token past the ceiling it was given', () => {
    for (const minutes of [1, 30, 60 * 6]) {
      const ceilingAt = new Date(Date.now() + minutes * 60 * 1000);
      const { token } = signRefreshToken({
        adminId: ADMIN_ID,
        sessionId: SESSION_ID,
        familyId: FAMILY_ID,
        ceilingAt,
      });
      expect(expOf(token)).toBeLessThanOrEqual(ceilingAt.getTime());
    }
  });

  /**
   * A row whose `reauthenticateAt` is absurdly far out — a bad backfill, a
   * hand-edited record — must not become a refresh token that lives that long. One
   * family lifetime is the hard cap regardless of what the row says.
   */
  it('never signs a refresh token longer than one family lifetime', () => {
    const { token } = signRefreshToken({
      adminId: ADMIN_ID,
      sessionId: SESSION_ID,
      familyId: FAMILY_ID,
      ceilingAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
    });
    const cap = Date.now() + SESSION.ABSOLUTE_TTL_SECONDS * 1000;
    expect(expOf(token)).toBeLessThanOrEqual(cap);
  });

  /**
   * A deadline already past should be unreachable — callers reject those first — so
   * arriving here is a bug. It must produce a token that is instantly useless rather
   * than one with no expiry at all, which is what `expiresIn: 0` risks.
   */
  it('mints an immediately-expired token for a deadline in the past', () => {
    const { token } = signRefreshToken({
      adminId: ADMIN_ID,
      sessionId: SESSION_ID,
      familyId: FAMILY_ID,
      ceilingAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(expOf(token)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('malformed input', () => {
  it.each([
    ['empty string', ''],
    ['not a jwt', 'not-a-token'],
    ['two segments', 'aaa.bbb'],
    ['four segments', 'aaa.bbb.ccc.ddd'],
    ['garbage base64', '!!!.???.***'],
  ])('refuses %s', (_label, token) => {
    expect(slugOf(() => verifyAccessToken(token))).toBe(ERR.TOKEN_INVALID);
  });
});

describe('bearerFrom', () => {
  it('extracts a token from a well-formed header', () => {
    expect(bearerFrom('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive about the scheme', () => {
    expect(bearerFrom('bearer abc')).toBe('abc');
    expect(bearerFrom('BEARER abc')).toBe('abc');
  });

  /**
   * Returns null rather than throwing, so `OptionalAuthGuard` can distinguish "no
   * credential offered" from "a credential that failed". Only the first is ever
   * allowed through.
   */
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['no scheme', 'abc.def.ghi'],
    ['wrong scheme', 'Basic abc'],
    ['scheme only', 'Bearer'],
    ['scheme and space only', 'Bearer '],
  ])('returns null for %s', (_label, header) => {
    expect(bearerFrom(header)).toBeNull();
  });
});
