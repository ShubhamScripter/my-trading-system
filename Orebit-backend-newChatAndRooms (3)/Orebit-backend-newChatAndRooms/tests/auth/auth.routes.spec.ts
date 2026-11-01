import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../../auth/auth.controller';
import { AuthRoutes } from '../../auth/auth.routes';
import { AuthGuard, OptionalAuthGuard } from '../../auth/security/guards';
import { ElevationGuard, ElevationService } from '../../src/2fa/elevation';
import { SessionService } from '../../auth/services/session.service';
import { BffSessionService } from '../../auth/security/bff.session';
import { ERR } from '../../src/contracts';
import { ProblemException, ProblemJsonFilter } from '../../src/http';
import { CacheService } from '../../redis';
import { CSRF, SESSION } from '../../auth/auth.constants';
import { generateCsrfToken } from '../../auth/auth.utility';
import { signAccessToken } from '../../auth/security/jwt';
import { SessionEndedException } from '../../auth/security/session.message';
import { bearerFor, makePrincipal, refreshBearerFor } from '../harness';

/**
 * The auth route table over a real Fastify instance: the real guards, real body
 * parsing, real cookie plugin, and the problem+json filter.
 *
 * `AuthController` is doubled — its dispatch is covered in auth.controller.spec.ts
 * and re-testing it through HTTP would only make these slower. What is NOT
 * doubled is the guard on each route, because that is the entire thing this file
 * exists to pin: which of the five routes is anonymous, which needs a bearer, and
 * which needs the awkward third option.
 */

const envelope = { data: { ok: true } };

const controller = {
  register: vi.fn().mockResolvedValue(envelope),
  loginRequest: vi.fn().mockResolvedValue(envelope),
  session: vi.fn().mockResolvedValue(envelope),
  password: vi.fn().mockResolvedValue(envelope),
  me: vi.fn().mockResolvedValue(envelope),
  updateMe: vi.fn().mockResolvedValue(envelope),
  linkPreview: vi.fn().mockResolvedValue(envelope),
  linkConfirm: vi.fn().mockResolvedValue(envelope),
};

/**
 * The elevation service, doubled.
 *
 * `POST /auth/link` wears `ElevationGuard`, and the guard is a real one here for
 * the same reason every other guard in this file is: which credential each route
 * demands is exactly what this suite exists to pin. What is doubled is only the
 * ticket LOOKUP, so the tests can decide whether a proof exists without a Redis.
 */
const elevation = {
  spend: vi.fn().mockResolvedValue(undefined),
};

const sessions = {
  assertLive: vi.fn(),
  // Fire-and-forget in the guard, so it must exist on the double even though no
  // test asserts on it — a missing method would throw synchronously out of
  // `authenticate` and surface as a 500 on every authenticated route.
  touch: vi.fn(),
};
/** Every request here authenticates with a BEARER, so `resolve` is not reached: the
 *  guard only calls it when a session cookie is present. Doubled because the guard
 *  takes it as a constructor argument. */
const bff = { resolve: vi.fn().mockResolvedValue({ kind: 'absent' }) };
const cache = { consume: vi.fn().mockResolvedValue(undefined) };

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthRoutes],
    providers: [
      { provide: AuthController, useValue: controller },
      { provide: SessionService, useValue: sessions },
      { provide: BffSessionService, useValue: bff },
      { provide: CacheService, useValue: cache },
      AuthGuard,
      OptionalAuthGuard,
      ElevationGuard,
      { provide: ElevationService, useValue: elevation },
      // Mirrors src/app.module.ts. `AuthGuard` is no longer attached per route —
      // it is global, and the open routes carry `@Public()` — so without this the
      // suite would exercise a version of the controller that has no guard at all
      // and would prove nothing about either half of that arrangement.
      { provide: APP_GUARD, useExisting: AuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new ProblemJsonFilter());
  // The cookie plugin, because deviceCookie() and sessionCookie() read req.cookies and call
  // reply.setCookie. Without it the register route throws on a real request.
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // The row facts the guard stashes. `familyId` must be non-null: the guard refuses
  // with `unauthenticated` without one, since everything after it keys on the family.
  sessions.assertLive.mockResolvedValue({ lastUsedAt: null, familyId: 'family-1' });
  sessions.touch.mockResolvedValue(undefined);
  bff.resolve.mockResolvedValue({ kind: 'absent' });
  controller.register.mockResolvedValue(envelope);
  controller.loginRequest.mockResolvedValue(envelope);
  controller.session.mockResolvedValue(envelope);
  controller.password.mockResolvedValue(envelope);
  controller.me.mockResolvedValue(envelope);
  controller.updateMe.mockResolvedValue(envelope);
  controller.linkPreview.mockResolvedValue(envelope);
  controller.linkConfirm.mockResolvedValue(envelope);
  elevation.spend.mockResolvedValue(undefined);
});

const http = () => request(app.getHttpServer());

describe('the anonymous routes', () => {
  it.each([
    ['/auth/register', 'register'],
    ['/auth/login', 'loginRequest'],
  ])('POST %s needs no credential at all', async (path, method) => {
    // Register's first step is anonymous by definition, and login IS the
    // authentication. `/auth/password` used to be on this list — it left when
    // recovery moved to email-OTP login; see the guarded-routes suite.
    await http().post(path).send({}).expect(201);
    expect(controller[method as keyof typeof controller]).toHaveBeenCalledTimes(1);
  });

  it('POST /auth/password is NOT anonymous any more', async () => {
    // The breaking half of moving recovery out of this route. A client still
    // calling the old public forgot/reset gets a 401, not a silent no-op.
    await http().post('/auth/password').send({ action: 'request-code' }).expect(401);
    expect(controller.password).not.toHaveBeenCalled();
  });

  it('POST /auth/register does not reject a bad bearer, because it reads none', async () => {
    await http()
      .post('/auth/register')
      .set('Authorization', 'Bearer not.a.jwt')
      .send({})
      .expect(201);
  });
});

describe('GET /auth/me — the mandatory guard', () => {
  it('rejects a request with no bearer', async () => {
    const res = await http().get('/auth/me').expect(401);
    expect(res.body.type).toBe('unauthenticated');
    expect(controller.me).not.toHaveBeenCalled();
  });

  it('rejects a malformed bearer', async () => {
    const res = await http()
      .get('/auth/me')
      .set('Authorization', 'Bearer not.a.jwt')
      .expect(401);
    expect(res.body.type).toBe('token_invalid');
  });

  it.each([
    ['a non-bearer scheme', 'Basic YWRhOnNlY3JldA=='],
    ['an empty bearer', 'Bearer '],
  ])('rejects %s', async (_case, header) => {
    // Both are "a credential is present but unusable", which must not fall through
    // to the anonymous path the way a missing header does on the optional guard.
    await http().get('/auth/me').set('Authorization', header).expect(401);
    expect(controller.me).not.toHaveBeenCalled();
  });

  it('rejects a REFRESH token presented as a bearer', async () => {
    // One secret signs both, so the `typ` claim is the only separation. A refresh
    // token accepted here would be a 30-day credential for the whole API.
    const res = await http()
      .get('/auth/me')
      .set('Authorization', refreshBearerFor())
      .expect(401);
    expect(res.body.type).toBe('token_invalid');
    expect(controller.me).not.toHaveBeenCalled();
  });

  it('rejects a valid signature whose session has been revoked', async () => {
    // The second half of the guard, and the reason it is two checks rather than
    // one. Signature-only would keep honouring an access token for its full
    // fifteen minutes after a logout, a password reset, or a detected replay.
    sessions.assertLive.mockRejectedValue(
      new ProblemException({ type: ERR.SESSION_REVOKED }),
    );

    const res = await http().get('/auth/me').set('Authorization', bearerFor()).expect(401);
    expect(res.body.type).toBe('session_revoked');
    expect(controller.me).not.toHaveBeenCalled();
  });

  it('passes a valid bearer through with the principal from the token', async () => {
    const principal = makePrincipal();
    await http().get('/auth/me').set('Authorization', bearerFor(principal)).expect(200);

    expect(sessions.assertLive).toHaveBeenCalledWith(principal.sessionId);
    expect(controller.me).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: principal.userId,
        sessionId: principal.sessionId,
      }),
      // The cookie port, so `ensureCsrf` can report the token to a client that
      // cannot read the cookie itself.
      expect.objectContaining({ ensureCsrf: expect.any(Function) }),
    );
  });
});

describe('PATCH /auth/me — the mandatory guard', () => {
  /**
   * The profile update, which was `PATCH /user/me` on its own `@Controller('user')`
   * until accounts folded into `auth/`. It carries no guard decorator at all: the
   * global `AuthGuard` covers it, and the four anonymous routes above opt out with
   * `@Public()`. So what is asserted below is the default, not a decoration — this
   * route is protected because every route is.
   */

  it('authenticates before it validates', async () => {
    // An unauthenticated caller learns nothing about the body schema — a 401, not
    // a 400, even with a body that could never parse.
    const res = await http().patch('/auth/me').send({ country: 'ZZ' }).expect(401);

    expect(res.body.type).toBe('unauthenticated');
    expect(controller.updateMe).not.toHaveBeenCalled();
  });

  it('rejects a malformed bearer', async () => {
    const res = await http()
      .patch('/auth/me')
      .set('Authorization', 'Bearer not.a.jwt')
      .send({ country: 'GB' })
      .expect(401);

    expect(res.body.type).toBe('token_invalid');
    expect(controller.updateMe).not.toHaveBeenCalled();
  });

  it('rejects a REFRESH token presented as a bearer', async () => {
    const res = await http()
      .patch('/auth/me')
      .set('Authorization', refreshBearerFor())
      .send({ country: 'GB' })
      .expect(401);

    expect(res.body.type).toBe('token_invalid');
    expect(controller.updateMe).not.toHaveBeenCalled();
  });

  it('rejects a valid signature whose session has been revoked', async () => {
    sessions.assertLive.mockRejectedValue(new ProblemException({ type: ERR.SESSION_REVOKED }));

    const res = await http()
      .patch('/auth/me')
      .set('Authorization', bearerFor())
      .send({ country: 'GB' })
      .expect(401);

    expect(res.body.type).toBe('session_revoked');
    expect(controller.updateMe).not.toHaveBeenCalled();
  });

  it('passes the body and the principal from the token through', async () => {
    const principal = makePrincipal();
    await http()
      .patch('/auth/me')
      .set('Authorization', bearerFor(principal))
      .send({ country: 'GB' })
      .expect(200);

    expect(sessions.assertLive).toHaveBeenCalledWith(principal.sessionId);
    expect(controller.updateMe).toHaveBeenCalledWith(
      { country: 'GB' },
      expect.objectContaining({
        userId: principal.userId,
        sessionId: principal.sessionId,
      }),
    );
  });

  it('reports a controller problem through the problem+json filter', async () => {
    controller.updateMe.mockRejectedValue(
      new ProblemException({ type: ERR.VALIDATION_FAILED }),
    );

    const res = await http()
      .patch('/auth/me')
      .set('Authorization', bearerFor())
      .send({ country: 'ZZ' })
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ type: ERR.VALIDATION_FAILED, status: 400 });
  });

  it('discloses nothing about an unexpected failure', async () => {
    // Anything that is not a ProblemException is a bug: 500, and the message is
    // logged rather than sent.
    controller.updateMe.mockRejectedValue(
      new Error('relation "identity.users" does not exist'),
    );

    const res = await http()
      .patch('/auth/me')
      .set('Authorization', bearerFor())
      .send({ country: 'GB' })
      .expect(500);

    expect(res.body).toMatchObject({ type: ERR.INTERNAL_ERROR });
    expect(JSON.stringify(res.body)).not.toContain('identity.users');
  });
});

describe('the retired /user prefix', () => {
  it('no longer answers, because accounts moved under /auth', async () => {
    // Asserted as "never reaches the controller" rather than as a status code:
    // Nest raises NotFoundException, ProblemJsonFilter catches everything, and
    // `toProblem` maps anything that is not a ProblemException to internal_error —
    // so an unrouted URL currently answers 500. See the note in src/http.ts:71.
    for (const res of [
      await http().get('/user/me').set('Authorization', bearerFor()),
      await http().patch('/user/me').set('Authorization', bearerFor()).send({ country: 'GB' }),
      await http().delete('/auth/me').set('Authorization', bearerFor()),
    ]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    expect(controller.me).not.toHaveBeenCalled();
    expect(controller.updateMe).not.toHaveBeenCalled();
  });
});

describe('POST /auth/session — the optional guard', () => {
  it('passes with NO credential, which is what a repeated logout requires', async () => {
    // It used to be refresh that needed this — the access token had already expired
    // by the time a client asked. Refresh is gone, and the logout actions inherited
    // the requirement for a better reason: a repeated logout has to keep succeeding,
    // and a user whose session died while they were away must still end up signed
    // out rather than looking at a 401.
    await http().post('/auth/session').send({ action: 'logout' }).expect(201);

    expect(controller.session).toHaveBeenCalledTimes(1);
    // No principal — that is the point.
    expect(controller.session.mock.calls[0]?.[1]).toBeNull();
  });

  it('still rejects a bearer that is PRESENT but invalid', async () => {
    // "No credential" and "a bad credential" are different, and only the first is
    // allowed through. This is the property most easily lost when the two guards
    // share an implementation.
    const res = await http()
      .post('/auth/session')
      .set('Authorization', 'Bearer not.a.jwt')
      .send({ action: 'logout' })
      .expect(401);

    expect(res.body.type).toBe('token_invalid');
    expect(controller.session).not.toHaveBeenCalled();
  });

  it('populates the principal when a valid bearer IS present, which logout needs', async () => {
    const principal = makePrincipal();
    await http()
      .post('/auth/session')
      .set('Authorization', bearerFor(principal))
      .send({ action: 'logout' })
      .expect(201);

    expect(controller.session.mock.calls[0]?.[1]).toMatchObject({
      userId: principal.userId,
      sessionId: principal.sessionId,
    });
  });

  it('rejects a refresh token presented as a bearer here too', async () => {
    await http()
      .post('/auth/session')
      .set('Authorization', refreshBearerFor())
      .send({ action: 'logout' })
      .expect(401);
  });
});

describe('the client context reaches the controller, and no flow cookie exists', () => {
  it('issues a device cookie and uses it as the session grouping ID', async () => {
    const first = await http()
      .post('/auth/register')
      .set('User-Agent', 'spec-agent')
      .send({})
      .expect(201);
    const setCookie = first.headers['set-cookie'] as string | string[] | undefined;
    const deviceCookie = Array.isArray(setCookie)
      ? setCookie.find((cookie) => cookie.startsWith('orebit_device='))
      : setCookie;

    expect(deviceCookie).toMatch(/^orebit_device=/);

    await http()
      .post('/auth/register')
      .set('User-Agent', 'spec-agent')
      .set('Cookie', deviceCookie as string)
      .send({})
      .expect(201);

    const firstContext = controller.register.mock.calls[0]?.[1] as {
      ip: string;
      ipClass: string;
      deviceId: string;
      userAgent: string | null;
    };
    const secondContext = controller.register.mock.calls[1]?.[1] as { deviceId: string };

    expect(firstContext.ip).toBeTruthy();
    expect(firstContext.ipClass).toBeTruthy();
    expect(firstContext.deviceId).toHaveLength(43);
    expect(secondContext.deviceId).toBe(firstContext.deviceId);
    expect(firstContext.userAgent).toBe('spec-agent');
  });

  /**
   * ─── What replaced the four tests that used to be here ───────────────────
   *
   * This block held five cases about a `ContinuationCookie` port: that the route
   * handed one to the controller, that it resolved the secret from the
   * `orebit_reg` cookie, that it fell back to `X-Registration-Token`, that a
   * request with neither answered `registration_not_found`, and that the cookie
   * won when both were sent.
   *
   * All five described a mechanism that no longer exists, so they are deleted
   * rather than adapted — there is no cookie, no header, and no port. What takes
   * their place is one assertion in the opposite direction: the route must hand
   * the controller exactly the client context and the session cookie port, and
   * must not reach for a flow credential in the transport layer at all.
   *
   * The positive half — that `signupId` in the body actually resolves a
   * registration — is not a routing question and lives in signup-id.spec.ts.
   */
  it('hands register only the client context and the session cookie port', async () => {
    await http().post('/auth/register').send({}).expect(201);

    const call = controller.register.mock.calls[0];
    expect(call).toHaveLength(3);

    const sessionCookies = call?.[2] as Record<string, unknown>;
    // The SESSION port, which `country` needs to mint the first session — not a
    // continuation port. `require` was the giveaway method on the old one.
    expect(typeof sessionCookies.issue).toBe('function');
    expect(typeof sessionCookies.clear).toBe('function');
    expect(sessionCookies.require).toBeUndefined();
  });

  it('sets no registration cookie on any register response', async () => {
    const res = await http().post('/auth/register').send({ step: 'start' }).expect(201);

    const setCookie = res.headers['set-cookie'] as string | string[] | undefined;
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.some((cookie) => cookie.startsWith('orebit_reg='))).toBe(false);
  });

  it('ignores X-Registration-Token entirely', async () => {
    // Not merely unused — the route must not read it. If it did, a client sending
    // one would get different behaviour from one that did not, which is the
    // second undocumented way to name a flow that this migration removed.
    await http()
      .post('/auth/register')
      .set('x-registration-token', 'header-secret')
      .send({ step: 'state', signupId: 'a'.repeat(43) })
      .expect(201);

    const body = controller.register.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.signupId).toBe('a'.repeat(43));
    expect(controller.register.mock.calls[0]).toHaveLength(3);
  });

  it('hands login only the client context and the session cookie port', async () => {
    await http().post('/auth/login').send({ step: 'start' }).expect(201);

    const call = controller.loginRequest.mock.calls[0];
    expect(call).toHaveLength(3);
    const sessionCookies = call?.[2] as Record<string, unknown>;
    expect(typeof sessionCookies.issue).toBe('function');
    expect(sessionCookies.require).toBeUndefined();
  });
});

describe('the provider-link routes — preview must not spend the confirm ticket', () => {
  /**
   * ═══ THE REGRESSION THIS FILE COULD NOT PREVIOUSLY CATCH ════════════════════
   *
   * `preview` and `confirm` used to share one handler with an `action` discriminator,
   * and `ElevationGuard` sat on it. A Nest guard runs BEFORE the body is parsed, so
   * the guard spent the single-use ticket without knowing which action was asked for
   * — and `ElevationService.spend` is GETDEL, so the spend was real. Previewing
   * destroyed the ticket and the confirm that followed got `reauth_required`.
   *
   * This suite had no `/auth/link` case at all, and its `elevation.spend` double
   * always resolved, so neither half of that could have been noticed. The double is
   * made genuinely single-use below.
   */

  /** Model `spend` as GETDEL: the first call succeeds, every later one refuses. */
  function singleUseTicket(): void {
    let spent = false;
    elevation.spend.mockImplementation(async () => {
      if (spent) throw new ProblemException({ type: ERR.REAUTH_REQUIRED });
      spent = true;
    });
  }

  it('preview needs a bearer but NO elevation ticket', async () => {
    await http()
      .post('/auth/link/preview')
      .set('Authorization', bearerFor())
      .send({ linkToken: 'tok' })
      .expect(201);

    expect(controller.linkPreview).toHaveBeenCalledTimes(1);
    // The whole fix, in one assertion.
    expect(elevation.spend).not.toHaveBeenCalled();
  });

  it('preview still refuses an unauthenticated caller', async () => {
    // Unelevated is not unauthenticated: the token being previewed is the caller's,
    // and which account it would attach to is decided by their session.
    const res = await http().post('/auth/link/preview').send({ linkToken: 'tok' }).expect(401);
    expect(res.body.type).toBe('unauthenticated');
    expect(controller.linkPreview).not.toHaveBeenCalled();
  });

  it('confirm spends a ticket', async () => {
    await http()
      .post('/auth/link')
      .set('Authorization', bearerFor())
      .send({ linkToken: 'tok' })
      .expect(201);

    expect(elevation.spend).toHaveBeenCalledTimes(1);
    expect(controller.linkConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirm is refused without a ticket', async () => {
    // 403, not 401: the caller IS authenticated — what is missing is the fresh proof.
    elevation.spend.mockRejectedValue(new ProblemException({ type: ERR.REAUTH_REQUIRED }));

    const res = await http()
      .post('/auth/link')
      .set('Authorization', bearerFor())
      .send({ linkToken: 'tok' })
      .expect(403);

    expect(res.body.type).toBe('reauth_required');
    expect(controller.linkConfirm).not.toHaveBeenCalled();
  });

  it('ONE ticket serves preview then confirm', async () => {
    // The sequence a real client performs, against a genuinely single-use ticket.
    // Before the split this failed at the second call.
    singleUseTicket();
    const bearer = bearerFor();

    await http()
      .post('/auth/link/preview')
      .set('Authorization', bearer)
      .send({ linkToken: 'tok' })
      .expect(201);

    await http()
      .post('/auth/link')
      .set('Authorization', bearer)
      .send({ linkToken: 'tok' })
      .expect(201);

    expect(elevation.spend).toHaveBeenCalledTimes(1);
    expect(controller.linkConfirm).toHaveBeenCalledTimes(1);
  });

  it('a second confirm on the same ticket is refused', async () => {
    // The property the single-use ticket exists for, asserted so the double above is
    // not merely permissive.
    singleUseTicket();
    const bearer = bearerFor();

    await http().post('/auth/link').set('Authorization', bearer).send({ linkToken: 'tok' }).expect(201);
    const res = await http()
      .post('/auth/link')
      .set('Authorization', bearer)
      .send({ linkToken: 'tok' })
      .expect(403);

    expect(res.body.type).toBe('reauth_required');
  });
});

/**
 * ═══ OPTIONAL AUTHENTICATION MEETS CSRF ═════════════════════════════════════
 *
 * `POST /auth/session` is a real production route on `OptionalAuthGuard`, and it is an
 * UNSAFE method reachable by cookie. The block above covers its BEARER path — no
 * credential, a malformed bearer, a valid bearer, a refresh token in the wrong place.
 * What it never exercised is the cookie path, which is where the interesting question
 * lives:
 *
 *   Does making authentication OPTIONAL make CSRF optional too?
 *
 * It does not, and that is not obvious from reading the guard. `OptionalAuthGuard`
 * looks permissive — it returns `true` unconditionally — but the CSRF assertion lives
 * inside `authenticate`, ahead of the branch that tolerates a dead session, and it
 * fires for any unsafe request presenting a session cookie. So an authenticated caller
 * here is held to exactly the token requirement `AuthGuard` imposes, while an anonymous
 * one is asked for nothing.
 *
 * The other property is that "optional" is about ABSENCE, not about validity. A revoked
 * or expired session degrades to anonymous — which is what lets a repeated logout
 * succeed — but must never come back authenticated; and a session store that is merely
 * unreachable must not degrade at all.
 *
 * Three real routes sit on this guard: this one, plus `POST /settings/security/email`
 * and `POST /settings/security/email/verify`. All three are POSTs behind the same
 * `@Public()` + `@UseGuards(OptionalAuthGuard)` pair and reach the identical
 * `authenticate` call, so what is asserted below is a property of the guard rather than
 * of this route. The email pair additionally refuses a null principal per branch in its
 * own controller, which its own spec covers.
 */
describe('POST /auth/session — the optional guard on the COOKIE path', () => {
  const HANDLE = 'handle-for-the-optional-guard-suite-000000';
  const principal = makePrincipal();

  /** What `bff.resolve` hands back for a live session. */
  const liveSession = () => ({
    kind: 'session' as const,
    accessToken: signAccessToken({
      userId: principal.userId,
      sessionId: principal.sessionId,
      publicCode: principal.publicCode,
    }).token,
    rotated: false,
  });

  /** The cookie pair a browser holds after signing in. */
  const pair = (): { cookie: string; token: string } => {
    const token = generateCsrfToken(HANDLE);
    return { cookie: `${SESSION.COOKIE_NAME}=${HANDLE}; ${CSRF.COOKIE_NAME}=${token}`, token };
  };

  /** The principal the controller actually saw, or null. */
  const sawPrincipal = (): unknown => controller.session.mock.calls[0]?.[1] ?? null;

  // ─── anonymous ──────────────────────────────────────────────────────────

  it('lets an anonymous unsafe request through, and asks it for no token', async () => {
    // No cookie means nothing was attached ambiently, so there is no cross-site request
    // to forge. Demanding a token here would break the repeated-logout case the guard
    // exists for.
    await http().post('/auth/session').send({ action: 'logout' }).expect(201);

    expect(sawPrincipal()).toBeNull();
  });

  it('does not let an anonymous caller inherit an identity', async () => {
    // No privilege confusion: an absent credential must mean an absent principal, never
    // a stale one left behind by a previous request on the same instance.
    await http().post('/auth/session').send({ action: 'logout' }).expect(201);
    await http().post('/auth/session').send({ action: 'logout' }).expect(201);

    for (const call of controller.session.mock.calls) {
      expect(call[1]).toBeNull();
    }
  });

  // ─── the CSRF matrix ────────────────────────────────────────────────────

  it('accepts a valid cookie with a matching CSRF token, and attaches the principal', async () => {
    bff.resolve.mockResolvedValue(liveSession());
    const { cookie, token } = pair();

    await http()
      .post('/auth/session')
      .set('Cookie', cookie)
      .set(CSRF.HEADER_NAME, token)
      .send({ action: 'logout' })
      .expect(201);

    expect(sawPrincipal()).toMatchObject({
      userId: principal.userId,
      sessionId: principal.sessionId,
    });
  });

  it('REFUSES an authenticated request whose CSRF header is missing', async () => {
    // ═══ THE PROPERTY THIS FINDING IS ABOUT ═══════════════════════════════
    //
    // Optional authentication must not become an accidental CSRF exemption. The cookie
    // is attached ambiently, so this is forgeable exactly as it would be on `AuthGuard`.
    bff.resolve.mockResolvedValue(liveSession());
    const { cookie } = pair();

    const res = await http()
      .post('/auth/session')
      .set('Cookie', cookie)
      .send({ action: 'logout' })
      .expect(403);

    expect(res.body.type).toBe('csrf_invalid');
    // And it never reached the handler, so no logout was performed.
    expect(controller.session).not.toHaveBeenCalled();
  });

  it('REFUSES an authenticated request whose CSRF header does not match the cookie', async () => {
    bff.resolve.mockResolvedValue(liveSession());
    const { cookie } = pair();

    const res = await http()
      .post('/auth/session')
      .set('Cookie', cookie)
      .set(CSRF.HEADER_NAME, generateCsrfToken(HANDLE))
      .send({ action: 'logout' })
      .expect(403);

    // Both halves are valid tokens for this handle and it still fails: the
    // double-submit half is about the two values being the SAME.
    expect(res.body.type).toBe('csrf_invalid');
  });

  it('REFUSES a matching pair minted for a different session handle', async () => {
    // The sibling-subdomain attack. Writing cookies does not require reading them, so
    // an attacker can plant a self-consistent pair; the binding to the handle refuses it.
    bff.resolve.mockResolvedValue(liveSession());
    const foreign = generateCsrfToken('a-handle-the-attacker-controls');

    const res = await http()
      .post('/auth/session')
      .set('Cookie', `${SESSION.COOKIE_NAME}=${HANDLE}; ${CSRF.COOKIE_NAME}=${foreign}`)
      .set(CSRF.HEADER_NAME, foreign)
      .send({ action: 'logout' })
      .expect(403);

    expect(res.body.type).toBe('csrf_invalid');
  });

  it('refuses BEFORE resolving the session, so a forgery cannot rotate a token', async () => {
    // `bff.resolve` can rotate the refresh token, which is a state change of its own.
    bff.resolve.mockResolvedValue(liveSession());
    const { cookie } = pair();

    await http().post('/auth/session').set('Cookie', cookie).send({ action: 'logout' }).expect(403);

    expect(bff.resolve).not.toHaveBeenCalled();
    expect(sessions.assertLive).not.toHaveBeenCalled();
  });

  it('asks a BEARER caller for no token, as on every other route', async () => {
    // Nothing ambient to forge, and demanding one would break non-browser clients.
    await http()
      .post('/auth/session')
      .set('Authorization', bearerFor(principal))
      .send({ action: 'logout' })
      .expect(201);

    expect(sawPrincipal()).toMatchObject({ userId: principal.userId });
  });

  // ─── credentials that are present but dead ──────────────────────────────

  it('treats a REVOKED session as anonymous, never as authenticated', async () => {
    // ═══ NO AUTHENTICATION CONFUSION ══════════════════════════════════════
    //
    // The logout case the guard exists for: the request succeeds so the user ends up
    // signed out, but it must arrive with NO principal. Authenticating a revoked
    // session here would be the serious failure.
    bff.resolve.mockResolvedValue(liveSession());
    sessions.assertLive.mockRejectedValue(
      new SessionEndedException('SESSION_REVOKED', ERR.SESSION_REVOKED),
    );
    const { cookie, token } = pair();

    await http()
      .post('/auth/session')
      .set('Cookie', cookie)
      .set(CSRF.HEADER_NAME, token)
      .send({ action: 'logout' })
      .expect(201);

    expect(sawPrincipal()).toBeNull();
  });

  it('treats an EXPIRED session as anonymous, never as authenticated', async () => {
    bff.resolve.mockResolvedValue(liveSession());
    sessions.assertLive.mockRejectedValue(
      new SessionEndedException('SESSION_EXPIRED', ERR.SESSION_EXPIRED),
    );
    const { cookie, token } = pair();

    await http()
      .post('/auth/session')
      .set('Cookie', cookie)
      .set(CSRF.HEADER_NAME, token)
      .send({ action: 'logout' })
      .expect(201);

    expect(sawPrincipal()).toBeNull();
  });

  it('still demands the CSRF token from a session that turns out to be revoked', async () => {
    // Ordering: the token is checked before the credential is spent, so a dead session
    // is not a way to skip the check.
    bff.resolve.mockResolvedValue(liveSession());
    sessions.assertLive.mockRejectedValue(
      new SessionEndedException('SESSION_REVOKED', ERR.SESSION_REVOKED),
    );
    const { cookie } = pair();

    const res = await http()
      .post('/auth/session')
      .set('Cookie', cookie)
      .send({ action: 'logout' })
      .expect(403);

    expect(res.body.type).toBe('csrf_invalid');
  });

  it('treats a cookie naming a session that no longer exists as anonymous', async () => {
    // `resolve` answers `absent` and there is no bearer to fall back on, so the guard
    // finds no credential at all.
    bff.resolve.mockResolvedValue({ kind: 'absent' });
    const { cookie, token } = pair();

    await http()
      .post('/auth/session')
      .set('Cookie', cookie)
      .set(CSRF.HEADER_NAME, token)
      .send({ action: 'logout' })
      .expect(201);

    expect(sawPrincipal()).toBeNull();
  });

  it('does NOT swallow a session store that is merely unreachable', async () => {
    // The one failure that must not degrade to anonymous: nothing has been learned
    // about the session. `session_store_unavailable` is absent from
    // `DEAD_SESSION_TYPES` precisely so this stays a 503.
    bff.resolve.mockResolvedValue({ kind: 'unavailable' });
    const { cookie, token } = pair();

    const res = await http()
      .post('/auth/session')
      .set('Cookie', cookie)
      .set(CSRF.HEADER_NAME, token)
      .send({ action: 'logout' })
      .expect(503);

    expect(res.body.type).toBe('session_store_unavailable');
    expect(controller.session).not.toHaveBeenCalled();
  });
});
