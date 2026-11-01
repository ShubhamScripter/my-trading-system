import { GUARDS_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminDbOperation } from '../../auth/auth.dboperation';
import { BffSessionService } from '../../auth/security/bff.session';
import { AuthGuard, SuperAdminGuard } from '../../auth/security/guards';
import { signAccessToken } from '../../auth/security/jwt';
import { SessionService } from '../../auth/services/session.service';
import { ERR } from '../../src/contracts';
import { CountryController } from '../../src/country/country.controller';
import { CountryRoutes } from '../../src/country/country.routes';
import { CountryService } from '../../src/country/country.service';
import { ProblemException, ProblemJsonFilter } from '../../src/http';
import { makeAdmin } from '../harness';

/**
 * Who may reach the country routes, over a real Fastify instance with the REAL guards.
 *
 * ═══ THE GUARDS ARE THE POINT, SO THEY ARE NOT DOUBLED ═════════════════════
 *
 * `AuthGuard` and `SuperAdminGuard` are the genuine articles and the token is really
 * signed and really verified. What IS doubled is only what they read — the session row,
 * the admin row — so a spec can decide "this caller is a disabled ADMIN" without a
 * database. `CountryService` is doubled too: what a write STORES is
 * country.service.spec.ts's job. This file asks only who gets through the door.
 */

const ADMIN_ID = '0195f0a0-aaaa-7000-8000-000000000001';
const CEILING = new Date(Date.now() + 60 * 60 * 1000);

function bearerFor(role: 'SUPER_ADMIN' | 'ADMIN'): string {
  const { token } = signAccessToken({
    adminId: ADMIN_ID,
    sessionId: '0195f0a0-dddd-7000-8000-000000000004',
    role,
    ceilingAt: CEILING,
  });
  return `Bearer ${token}`;
}

const BOUNDARY = 'orebittestboundary';

const ROUND_KEY = 'country-assets/IN/round/0195f0a0-aaaa-7000-8000-000000000001.webp';
const SQUARE_KEY = 'country-assets/IN/square/0195f0a0-aaaa-7000-8000-000000000002.webp';

/**
 * A minimal multipart body: one file plus the two fields.
 *
 * Hand-built rather than pulled from a library because the only thing these cases need
 * is a well-formed envelope the parser will accept — the image bytes never reach a
 * decoder, since the service is doubled.
 */
function multipartBody(): Buffer {
  const part = (headers: string, body: Buffer): Buffer =>
    Buffer.concat([Buffer.from(`--${BOUNDARY}\r\n${headers}\r\n\r\n`), body, Buffer.from('\r\n')]);

  return Buffer.concat([
    part('Content-Disposition: form-data; name="isoCode"', Buffer.from('IN')),
    part('Content-Disposition: form-data; name="type"', Buffer.from('round')),
    part(
      'Content-Disposition: form-data; name="image"; filename="r.png"\r\nContent-Type: image/png',
      Buffer.from([1, 2, 3]),
    ),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
}

const countryService = {
  list: vi.fn(),
  listImages: vi.fn(),
  create: vi.fn(),
  uploadImage: vi.fn(),
};
const admins = { findById: vi.fn() };
const sessions = { assertLive: vi.fn(), touch: vi.fn() };
const bff = { resolve: vi.fn() };

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [CountryRoutes],
    providers: [
      CountryController,
      { provide: CountryService, useValue: countryService },
      { provide: AdminDbOperation, useValue: admins },
      { provide: SessionService, useValue: sessions },
      { provide: BffSessionService, useValue: bff },
      AuthGuard,
      SuperAdminGuard,
      // Mirrors src/app.module.ts. Without it every route here would be
      // unauthenticated and the assertions below would prove nothing.
      { provide: APP_GUARD, useExisting: AuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new ProblemJsonFilter());

  // CountryModule registers this on init; the testing module builds the controller
  // without it, so the upload route would have no `request.parts` to call.
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 1_048_576, files: 2, fields: 1, parts: 3 },
  });

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
  bff.resolve.mockResolvedValue({ kind: 'absent' });
  admins.findById.mockResolvedValue(makeAdmin({ id: ADMIN_ID, role: 'SUPER_ADMIN' }));
  countryService.list.mockResolvedValue({ countries: [] });
  countryService.listImages.mockResolvedValue({ images: [] });
  countryService.create.mockResolvedValue({ isoCode: 'IN' });
  countryService.uploadImage.mockResolvedValue({ key: ROUND_KEY, type: 'round' });
});

interface RouteCase {
  readonly label: string;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: unknown;
  readonly headers?: Record<string, string>;
}

const ROUTES: readonly RouteCase[] = [
  { label: 'GET /countries/images', method: 'GET', url: '/countries/images' },
  { label: 'GET /countries', method: 'GET', url: '/countries' },
  {
    label: 'POST /countries',
    method: 'POST',
    url: '/countries',
    payload: {
      name: 'India',
      isoCode: 'IN',
      roundImageKey: ROUND_KEY,
      squareImageKey: SQUARE_KEY,
    },
    headers: { 'content-type': 'application/json' },
  },
  {
    label: 'POST /countries/images',
    method: 'POST',
    url: '/countries/images',
    payload: multipartBody(),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  },
];

function inject(route: RouteCase, headers: Record<string, string> = {}) {
  return app.inject({
    method: route.method,
    url: route.url,
    headers: { ...(route.headers ?? {}), ...headers },
    ...(route.payload === undefined ? {} : { payload: route.payload as never }),
  });
}

const cases = ROUTES.map((r) => [r.label, r] as const);

describe('no route is reachable without a credential', () => {
  it.each(cases)('%s refuses an anonymous caller', async (_label, route) => {
    const res = await inject(route);
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(ERR.UNAUTHENTICATED);
  });

  it.each(cases)('%s refuses a caller whose session is gone', async (_label, route) => {
    sessions.assertLive.mockRejectedValue(new ProblemException({ type: ERR.SESSION_REVOKED }));

    const res = await inject(route, { authorization: bearerFor('SUPER_ADMIN') });
    expect(res.statusCode).toBe(401);
  });
});

describe('no route is reachable by an ordinary admin', () => {
  it.each(cases)('%s refuses role ADMIN', async (_label, route) => {
    admins.findById.mockResolvedValue(makeAdmin({ id: ADMIN_ID, role: 'ADMIN' }));

    const res = await inject(route, { authorization: bearerFor('ADMIN') });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe(ERR.FORBIDDEN);
  });

  /**
   * The claim in the token is NOT what decides. `SuperAdminGuard` re-reads the admin
   * row, so a token minted while the caller was a super admin stops working the moment
   * they are demoted — rather than lasting until it expires.
   */
  it.each(cases)('%s refuses a SUPER_ADMIN token whose row says otherwise', async (_l, route) => {
    admins.findById.mockResolvedValue(makeAdmin({ id: ADMIN_ID, role: 'ADMIN' }));

    const res = await inject(route, { authorization: bearerFor('SUPER_ADMIN') });
    expect(res.statusCode).toBe(403);
  });

  it.each(cases)('%s refuses a super admin whose account is disabled', async (_l, route) => {
    admins.findById.mockResolvedValue(
      makeAdmin({ id: ADMIN_ID, role: 'SUPER_ADMIN', status: 'DISABLED' }),
    );

    const res = await inject(route, { authorization: bearerFor('SUPER_ADMIN') });
    expect(res.statusCode).toBe(401);
  });

  /** A write must not reach the service on a refusal — not even to be rolled back. */
  it('does not touch the service when authorisation fails', async () => {
    admins.findById.mockResolvedValue(makeAdmin({ id: ADMIN_ID, role: 'ADMIN' }));

    for (const route of ROUTES) {
      await inject(route, { authorization: bearerFor('ADMIN') });
    }

    expect(countryService.create).not.toHaveBeenCalled();
    expect(countryService.uploadImage).not.toHaveBeenCalled();
    expect(countryService.listImages).not.toHaveBeenCalled();
    expect(countryService.list).not.toHaveBeenCalled();
  });
});

describe('a super admin is allowed through', () => {
  it.each(cases)('%s succeeds', async (_label, route) => {
    const res = await inject(route, { authorization: bearerFor('SUPER_ADMIN') });
    expect([200, 201]).toContain(res.statusCode);
  });

  /** Every POST returns 201 — the house rule. */
  it.each(cases.filter(([, r]) => r.method === 'POST'))('%s returns 201', async (_l, route) => {
    const res = await inject(route, { authorization: bearerFor('SUPER_ADMIN') });
    expect(res.statusCode).toBe(201);
  });

  it('carries the normalised fields from the multipart body into the service', async () => {
    const upload = ROUTES.find((r) => r.label === 'POST /countries/images') as RouteCase;
    await inject(upload, { authorization: bearerFor('SUPER_ADMIN') });

    expect(countryService.uploadImage).toHaveBeenCalledWith(
      'IN',
      'round',
      expect.any(Buffer),
      expect.objectContaining({ adminId: ADMIN_ID }),
      expect.objectContaining({ ip: expect.any(String) }),
    );
  });

  /**
   * ═══ AN UPLOAD MUST NOT REACH THE COUNTRY TABLE ════════════════════════════
   *
   * Asserted at the HTTP boundary as well as in the service, because this is the rule
   * the whole refactor turns on: putting an image in the library creates no country and
   * needs none to exist.
   */
  it('does not create or read a country when an image is uploaded', async () => {
    const upload = ROUTES.find((r) => r.label === 'POST /countries/images') as RouteCase;
    await inject(upload, { authorization: bearerFor('SUPER_ADMIN') });

    expect(countryService.create).not.toHaveBeenCalled();
    expect(countryService.list).not.toHaveBeenCalled();
  });

  /** The library and the catalogue are separate reads and must not be confused. */
  it('serves the image library from listImages, not from the catalogue', async () => {
    await inject(ROUTES[0] as RouteCase, { authorization: bearerFor('SUPER_ADMIN') });

    expect(countryService.listImages).toHaveBeenCalledTimes(1);
    expect(countryService.list).not.toHaveBeenCalled();
  });

  it('serves the catalogue from list, not from the image library', async () => {
    await inject(ROUTES[1] as RouteCase, { authorization: bearerFor('SUPER_ADMIN') });

    expect(countryService.list).toHaveBeenCalledTimes(1);
    expect(countryService.listImages).not.toHaveBeenCalled();
  });
});

describe('the routes declare their own gates', () => {
  const guardsOn = (handler: object): string[] =>
    ((Reflect.getMetadata(GUARDS_METADATA, handler) as { name: string }[] | undefined) ?? []).map(
      (g) => g.name,
    );

  it.each([
    ['listImages', CountryRoutes.prototype.listImages],
    ['list', CountryRoutes.prototype.list],
    ['create', CountryRoutes.prototype.create],
    ['uploadImage', CountryRoutes.prototype.uploadImage],
  ])('puts SuperAdminGuard on %s', (_name, handler) => {
    expect(guardsOn(handler)).toContain('SuperAdminGuard');
  });

  /**
   * ─── An assertion for an ABSENCE, which is unusual and deliberate ─────────
   *
   * The elevation decision is documented at length in country.routes.ts. Asserting it
   * here means adding `ElevationGuard` later is a conscious edit to this spec rather
   * than a silent change of the surface's risk profile — and equally, that a guard
   * quietly deleted from a route would fail something.
   */
  it.each([
    ['listImages', CountryRoutes.prototype.listImages],
    ['list', CountryRoutes.prototype.list],
    ['create', CountryRoutes.prototype.create],
    ['uploadImage', CountryRoutes.prototype.uploadImage],
  ])('requires NO elevation ticket on %s', (_name, handler) => {
    expect(guardsOn(handler)).toEqual(['SuperAdminGuard']);
  });
});
