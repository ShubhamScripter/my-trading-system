import { Controller, Get, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF, SESSION } from '../../auth/auth.constants';
import { generateCsrfToken } from '../../auth/auth.utility';
import { AuthGuard, ExplainsSessionState, NotActivity } from '../../auth/security/guards';
import { BffSessionService } from '../../auth/security/bff.session';
import { SessionEndedException } from '../../auth/security/session.message';
import { SessionService } from '../../auth/services/session.service';
import { signAccessToken } from '../../auth/security/jwt';
import { ERR } from '../../src/contracts';
import { ProblemException, ProblemJsonFilter } from '../../src/http';
import { CacheService } from '../../redis';

/**
 * ═══ CSRF, AND WHERE IT IS NOW CHECKED ═════════════════════════════════════
 *
 * The check used to live in one controller, because exactly one route read a cookie.
 * The session cookie is root-scoped now — every route authenticates from it — so every
 * mutating route is a cookie-authenticated state change, and the check moved into
 * `AuthGuard`. One place, and a new controller cannot forget to opt in.
 *
 * Three properties matter, and only the first is the classic double-submit:
 *
 *   both halves agree     an attacker's page can cause the cookie to be SENT, which is
 *                         what CSRF is, but cannot READ it to populate the header.
 *   the value is OURS,    cookie WRITES are governed by a weaker rule than reads: any
 *   for THIS handle       sibling subdomain can set a cookie on the parent domain. So
 *                         an unsigned pair is forgeable by anything that can emit a
 *                         `Set-Cookie` for `.orebit.io`.
 *   checked BEFORE the    `bff.resolve` can rotate the refresh token, which is a state
 *   credential is spent    change of its own. A forged request must be refused before
 *                         it can cause one.
 */

@Controller('thing')
class ThingRoutes {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  write(): { ok: true } {
    return { ok: true };
  }
}

/** Stands in for `GET /auth/session`: guarded, background, and its 401 is an answer. */
@Controller('status')
class StatusRoutes {
  @Get()
  @NotActivity()
  @ExplainsSessionState()
  read(): { ok: true } {
    return { ok: true };
  }
}

const HANDLE = 'handle-for-the-csrf-suite-0000000000000000';

const sessions = {
  assertLive: vi.fn(),
  touch: vi.fn(),
};
const bff = { resolve: vi.fn() };
const cache = { consume: vi.fn().mockResolvedValue(undefined) };

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [ThingRoutes, StatusRoutes],
    providers: [
      { provide: SessionService, useValue: sessions },
      { provide: BffSessionService, useValue: bff },
      { provide: CacheService, useValue: cache },
      AuthGuard,
      { provide: APP_GUARD, useExisting: AuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.register(import('@fastify/cookie'));
  app.useGlobalFilters(new ProblemJsonFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  sessions.assertLive.mockResolvedValue({ lastUsedAt: null, familyId: 'family-1' });
  sessions.touch.mockResolvedValue(undefined);
  bff.resolve.mockResolvedValue({ kind: 'session', accessToken: accessToken(), rotated: false });
});

function http() {
  return request(app.getHttpServer());
}

function accessToken(): string {
  return signAccessToken({
    userId: '01940000-0000-7000-8000-000000000001',
    sessionId: '01940000-0000-7000-8000-00000000005e',
    publicCode: 'OREBiT7Q9K2M4X',
  }).token;
}

/** The pair a browser holds after a sign-in. */
function pair(handle = HANDLE): { cookie: string; token: string } {
  const token = generateCsrfToken(handle);
  return {
    cookie: `${SESSION.COOKIE_NAME}=${handle}; ${CSRF.COOKIE_NAME}=${token}`,
    token,
  };
}

describe('the cookie is a credential', () => {
  it('authenticates a GET with no Authorization header at all', async () => {
    const { cookie } = pair();
    await http().get('/thing').set('Cookie', cookie).expect(200);

    expect(bff.resolve).toHaveBeenCalledWith(HANDLE, expect.anything());
  });

  it('needs no CSRF token on a safe method', async () => {
    // A GET changes nothing, and demanding a token on reads would break the very
    // first request a reloaded page makes.
    await http().get('/thing').set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}`).expect(200);
  });

  it('prefers the cookie over a bearer when a client sends both', async () => {
    const { cookie } = pair();
    bff.resolve.mockResolvedValue({ kind: 'session', accessToken: accessToken(), rotated: false });

    await http()
      .get('/thing')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken()}`)
      .expect(200);

    // A browser that has both is presenting the newer contract.
    expect(bff.resolve).toHaveBeenCalled();
  });

  it('falls back to a bearer when the cookie names a record that is gone', async () => {
    bff.resolve.mockResolvedValue({ kind: 'absent' });

    await http()
      .get('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}`)
      .set('Authorization', `Bearer ${accessToken()}`)
      .expect(200);
  });

  it('reads a dead handle with no bearer as "no credential"', async () => {
    bff.resolve.mockResolvedValue({ kind: 'absent' });

    const res = await http()
      .get('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}`)
      .expect(401);

    expect(res.body.type).toBe('unauthenticated');
  });
});

describe('an unsafe method authenticated by cookie', () => {
  it('succeeds with a matching header', async () => {
    const { cookie, token } = pair();

    await http().post('/thing').set('Cookie', cookie).set(CSRF.HEADER_NAME, token).expect(201);
  });

  it('is refused when the header is missing', async () => {
    const { cookie } = pair();

    const res = await http().post('/thing').set('Cookie', cookie).expect(403);
    expect(res.body.type).toBe('csrf_invalid');
  });

  it('is refused when the cookie is missing but the header is sent', async () => {
    const res = await http()
      .post('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}`)
      .set(CSRF.HEADER_NAME, generateCsrfToken(HANDLE))
      .expect(403);

    expect(res.body.type).toBe('csrf_invalid');
  });

  it('is refused when the two halves disagree', async () => {
    const { cookie } = pair();

    const res = await http()
      .post('/thing')
      .set('Cookie', cookie)
      .set(CSRF.HEADER_NAME, generateCsrfToken(HANDLE))
      .expect(403);

    // Both are valid tokens for this handle, and it still fails: the double-submit
    // half of the check is about the two values being the SAME, which an attacker who
    // cannot read the cookie cannot arrange.
    expect(res.body.type).toBe('csrf_invalid');
  });

  it('is refused when a matching pair was minted for a DIFFERENT handle', async () => {
    // The subdomain attack, in full. Anything that can emit a `Set-Cookie` for
    // `.orebit.io` plants a value it knows in `orebit_csrf` and echoes the same value
    // in the header — so the double-submit check passes — while the victim's own
    // session cookie authenticates the request. The binding is what refuses it.
    const foreign = generateCsrfToken('a-handle-the-attacker-controls');

    const res = await http()
      .post('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}; ${CSRF.COOKIE_NAME}=${foreign}`)
      .set(CSRF.HEADER_NAME, foreign)
      .expect(403);

    expect(res.body.type).toBe('csrf_invalid');
  });

  it('is refused for a matching pair of values we never issued', async () => {
    const res = await http()
      .post('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}; ${CSRF.COOKIE_NAME}=made.up`)
      .set(CSRF.HEADER_NAME, 'made.up')
      .expect(403);

    expect(res.body.type).toBe('csrf_invalid');
  });

  /**
   * ═══ FINDING #3 ON THE REACHABLE PATH ═════════════════════════════════════
   *
   * `assertCsrf` compares the cookie against the header with `safeEqual`, and BOTH are
   * supplied by the caller. `safeEqual`'s length guard counted UTF-16 code units while
   * `timingSafeEqual` compares bytes, so a value whose encoding is longer than its
   * code-unit count got past the guard and `timingSafeEqual` threw `RangeError`.
   *
   * Nothing on this path catches that, so the refusal became an `internal_error` 500
   * with a stack in the log — before `bff.resolve` was ever called, and repeatable by
   * anyone. It failed closed, so it was never a bypass; it was free log noise and an
   * alert channel an attacker could drive.
   *
   * These send the mismatch through the real guard and assert the ordinary refusal.
   */
  /**
   * Each pair below has MATCHING UTF-16 length and differing UTF-8 byte length, which
   * is precisely the blind spot: the old guard compared the former and
   * `timingSafeEqual` the latter, so every one of these got past the guard and threw.
   *
   * The values are written as latin1 because that is how they arrive. Node decodes
   * header bytes as latin1, so raw wire bytes become one code unit each — a UTF-8
   * encoded `€` sent as three bytes reads back as three characters that re-encode to
   * six. Anything above U+00FF is not expressible in a header at all, which is why
   * these are byte sequences rather than the characters they spell.
   */
  const latin1 = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');

  it.each([
    ['a raw high byte, as reported', 'Ã', 'a'],
    ['a two-byte character', latin1('é'), 'ab'],
    ['a three-byte character', latin1('€'), 'abc'],
    ['a surrogate pair', latin1('\u{1F600}'), 'abcd'],
  ])('refuses %s with csrf_invalid rather than a 500', async (_case, cookie, header) => {
    // The precondition that makes this a regression test: the old guard saw these as
    // equal-length and handed `timingSafeEqual` mismatched buffers.
    expect(cookie.length).toBe(header.length);
    expect(Buffer.from(cookie, 'utf8').length).not.toBe(Buffer.from(header, 'utf8').length);

    const res = await http()
      .post('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}; ${CSRF.COOKIE_NAME}=${cookie}`)
      .set(CSRF.HEADER_NAME, header)
      .expect(403);

    expect(res.body.type).toBe('csrf_invalid');
  });

  it('still refuses before resolving the session on a multibyte mismatch', async () => {
    // The ordering property from the test below has to survive the fix: the throw used
    // to happen here too, so this asserts the refusal is still the guard's and not an
    // error escaping from somewhere later.
    await http()
      .post('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}; ${CSRF.COOKIE_NAME}=é`)
      .set(CSRF.HEADER_NAME, 'a')
      .expect(403);

    expect(bff.resolve).not.toHaveBeenCalled();
    expect(sessions.assertLive).not.toHaveBeenCalled();
  });

  it('refuses a matching multibyte pair that we never issued', async () => {
    // Equal byte lengths, so `safeEqual` genuinely agrees — and the token binding is
    // what refuses it. Proves the fix did not turn every multibyte value into an
    // early `false` that masked the second half of the check.
    const res = await http()
      .post('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}; ${CSRF.COOKIE_NAME}=héllo`)
      .set(CSRF.HEADER_NAME, 'héllo')
      .expect(403);

    expect(res.body.type).toBe('csrf_invalid');
  });

  /**
   * ═══ A RE-CUT SIGNATURE DOES NOT AUTHENTICATE ANOTHER HANDLE ══════════════
   *
   * The signature was taken over `${nonce}:${handle}`, and the nonce reaching
   * verification is sliced out of the caller's own token. So a token minted for the
   * handle `b:c` could be presented as nonce `<nonce>:b` against the handle `c` — the
   * same bytes, re-split — and `assertCsrf` accepted it.
   *
   * Driven through the real guard rather than only the helper, because the claim that
   * matters is about the route: this pair must produce the ordinary 403 rather than a
   * pass. Latent in production, where handles are base64url and contain no `:`.
   */
  it('refuses a signature re-cut onto a different handle', async () => {
    const issued = generateCsrfToken('b:c');
    const nonce = issued.slice(0, issued.indexOf('.'));
    const signature = issued.slice(issued.indexOf('.') + 1);

    // Same underlying message, split one separator to the left.
    const recut = `${nonce}:b.${signature}`;

    const res = await http()
      .post('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=c; ${CSRF.COOKIE_NAME}=${recut}`)
      .set(CSRF.HEADER_NAME, recut)
      .expect(403);

    expect(res.body.type).toBe('csrf_invalid');
    // And the credential was never spent on it.
    expect(bff.resolve).not.toHaveBeenCalled();
  });

  it('still accepts the token for the handle it was actually issued for', async () => {
    // The other half: the fix must not have broken a legitimate pair whose handle
    // happens to contain the old separator.
    const issued = generateCsrfToken('b:c');

    await http()
      .post('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=b:c; ${CSRF.COOKIE_NAME}=${issued}`)
      .set(CSRF.HEADER_NAME, issued)
      .expect(201);
  });

  it('never resolves the session when the CSRF check fails', async () => {
    // The ordering that matters. `bff.resolve` can ROTATE the refresh token, so a
    // forged request must be refused before it can cause a state change — and the
    // refusal must not depend on the session resolving first.
    const { cookie } = pair();

    await http().post('/thing').set('Cookie', cookie).expect(403);

    expect(bff.resolve).not.toHaveBeenCalled();
    expect(sessions.assertLive).not.toHaveBeenCalled();
    expect(sessions.touch).not.toHaveBeenCalled();
  });
});

describe('a bearer caller is never asked for a CSRF token', () => {
  it('succeeds on an unsafe method with no header', async () => {
    // Nothing is attached ambiently — a cross-site caller cannot set an
    // `Authorization` header — so there is no forgery to prevent, and demanding a
    // token would break every non-browser client.
    await http().post('/thing').set('Authorization', `Bearer ${accessToken()}`).expect(201);
  });

  it('is still refused when it presents an empty session cookie', async () => {
    // An empty cookie value reads as absent, so this is the bearer path — not a
    // cookie-authenticated request whose CSRF check was silently skipped.
    await http()
      .post('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=`)
      .set('Authorization', `Bearer ${accessToken()}`)
      .expect(201);
  });
});

describe('the session cookie is slid when, and only when, a rotation happened', () => {
  it('re-sets both cookies after a rotation', async () => {
    const { cookie } = pair();
    bff.resolve.mockResolvedValue({ kind: 'session', accessToken: accessToken(), rotated: true });

    const res = await http().get('/thing').set('Cookie', cookie).expect(200);

    const setCookie = (res.headers['set-cookie'] ?? []) as string[];
    // The session's deadline just moved. Without this, a cookie set once at sign-in
    // becomes an absolute ceiling this service does not have.
    expect(setCookie.some((c) => c.startsWith(`${SESSION.COOKIE_NAME}=`))).toBe(true);
    expect(setCookie.some((c) => c.startsWith(`${CSRF.COOKIE_NAME}=`))).toBe(true);
  });

  it('re-sends the SAME CSRF token, so a concurrent save is not broken', async () => {
    const { cookie, token } = pair();
    bff.resolve.mockResolvedValue({ kind: 'session', accessToken: accessToken(), rotated: true });

    const res = await http().get('/thing').set('Cookie', cookie).expect(200);

    const setCookie = (res.headers['set-cookie'] ?? []) as string[];
    const csrf = setCookie.find((c) => c.startsWith(`${CSRF.COOKIE_NAME}=`)) as string;
    expect(csrf).toContain(token);
  });

  it('emits nothing on an ordinary request', async () => {
    const { cookie } = pair();
    bff.resolve.mockResolvedValue({ kind: 'session', accessToken: accessToken(), rotated: false });

    const res = await http().get('/thing').set('Cookie', cookie).expect(200);

    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('does not extend the credential of a session it is about to refuse', async () => {
    // The slide happens AFTER `assertLive` agrees the session is live. Extending a
    // cookie for a session being revoked would be exactly backwards.
    const { cookie } = pair();
    bff.resolve.mockResolvedValue({ kind: 'session', accessToken: accessToken(), rotated: true });
    sessions.assertLive.mockRejectedValue(
      new SessionEndedException('SESSION_REVOKED', ERR.SESSION_REVOKED),
    );

    const res = await http().get('/thing').set('Cookie', cookie).expect(401);

    const setCookie = (res.headers['set-cookie'] ?? []) as string[];
    // Nothing was SET. This route does not carry `@ExplainsSessionState()`, so
    // nothing is cleared either — its 401 is byte-for-byte what it always was.
    expect(setCookie.some((c) => c.startsWith(`${SESSION.COOKIE_NAME}=${HANDLE}`))).toBe(false);
  });
});

describe('the route whose 401 is an answer', () => {
  it('explains an idle-expired session, and clears the stale cookies', async () => {
    const { cookie } = pair();
    sessions.assertLive.mockRejectedValue(
      new SessionEndedException(
        'SESSION_EXPIRED',
        ERR.SESSION_EXPIRED,
        new Date('2026-09-01T12:00:00.000Z'),
      ),
    );

    const res = await http().get('/status').set('Cookie', cookie).expect(401);

    expect(res.body.type).toBe('session_expired');
    expect(res.body.extra).toMatchObject({
      authenticated: false,
      lastActiveAt: '2026-09-01T12:00:00.000Z',
      message: { code: 'SESSION_EXPIRED' },
    });
    expect(res.headers['cache-control']).toBe('no-store');

    // The stale-cookie case this exists for: left in place, the next sign-in arrives
    // carrying a CSRF cookie bound to the OLD handle, and `assertCsrf` refuses the
    // very request whose purpose is to establish a new session.
    const setCookie = (res.headers['set-cookie'] ?? []) as string[];
    expect(setCookie).toHaveLength(2);
    expect(setCookie.every((c) => /Expires=Thu, 01 Jan 1970|Max-Age=0/.test(c))).toBe(true);
  });

  it('tells a handle that is gone from a caller who never had one', async () => {
    // Both answer `unauthenticated` from the guard, and they are different facts. A
    // handle that resolves to nothing is a session that ran out; reporting that as
    // NOT_LOGGED_IN would tell someone who was working a minute ago that they never
    // signed in.
    bff.resolve.mockResolvedValue({ kind: 'absent' });

    const withHandle = await http()
      .get('/status')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}`)
      .expect(401);
    expect(withHandle.body.extra.message.code).toBe('SESSION_EXPIRED');

    const anonymous = await http().get('/status').expect(401);
    expect(anonymous.body.extra.message.code).toBe('NOT_LOGGED_IN');
  });

  it('emits no Set-Cookie for an anonymous poll', async () => {
    const res = await http().get('/status').expect(401);

    // Clearing cookies a caller never sent would put two `Set-Cookie` headers on
    // every unauthenticated request.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('does NOT clear the cookies on a 503 thrown from inside resolve', async () => {
    // The one refusal that must leave them alone. The handle is the only value
    // naming this session, so dropping it over a Redis blip would strand a live
    // session nobody — including its owner — could ever revoke.
    const { cookie } = pair();
    bff.resolve.mockRejectedValue(
      new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE }),
    );

    const res = await http().get('/status').set('Cookie', cookie).expect(503);

    expect(res.body.type).toBe('session_store_unavailable');
    expect(res.headers['set-cookie']).toBeUndefined();
    // And no session state attached: Redis being away says nothing about whether
    // anyone is signed in.
    expect(res.body.extra).toBeUndefined();
  });

  it('answers 503 — not a cookie-clearing 401 — when the store is unreachable', async () => {
    // ═══ THE DEFECT CURL FOUND, AND THE ONE THAT MATTERED MOST ═════════════
    //
    // `resolve` used to fold "Redis did not answer" in with "no such record" and
    // return one null. The guard then saw no credential, answered `unauthenticated`,
    // `explainSessionEnd` labelled it SESSION_EXPIRED — "you have been logged out due
    // to inactivity", which was false — and the catch CLEARED BOTH COOKIES.
    //
    // So a Redis blip during the one route a page calls on load destroyed the only
    // value naming a live session: exactly the harm the 503-must-not-clear rule
    // exists to prevent, arrived at from the other direction. Every layer was
    // individually doing what it was designed to do, which is why no unit test caught
    // it.
    const { cookie } = pair();
    bff.resolve.mockResolvedValue({ kind: 'unavailable' });

    const res = await http().get('/status').set('Cookie', cookie).expect(503);

    expect(res.body.type).toBe('session_store_unavailable');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.extra).toBeUndefined();
  });

  it('still prefers a bearer when the cookie’s store is unreachable', async () => {
    // The 503 is only right when there is nothing else to authenticate with. A caller
    // holding both should not be refused for the half that is broken.
    bff.resolve.mockResolvedValue({ kind: 'unavailable' });

    await http()
      .get('/thing')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}`)
      .set('Authorization', `Bearer ${accessToken()}`)
      .expect(200);
  });

  it('does not count as activity', async () => {
    // A client polling "am I still signed in?" is the application talking to itself.
    // Counting it would let an abandoned tab hold its session open forever.
    const { cookie } = pair();

    await http().get('/status').set('Cookie', cookie).expect(200);

    expect(sessions.touch).not.toHaveBeenCalled();
  });

  it('leaves an unmarked route’s 401 exactly as it was', async () => {
    const { cookie } = pair();
    sessions.assertLive.mockRejectedValue(
      new SessionEndedException('SESSION_REVOKED', ERR.SESSION_REVOKED),
    );

    const res = await http().get('/thing').set('Cookie', cookie).expect(401);

    // Opting in rather than enriching every refusal: a business route that started
    // reporting session state in its errors would be a wider contract change than
    // this asks for.
    expect(res.body.type).toBe('session_revoked');
    expect(res.body.extra).toBeUndefined();
  });
});
