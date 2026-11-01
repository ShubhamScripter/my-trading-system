import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthGuard,
  OptionalAuthGuard,
  Public,
  requirePrincipal,
} from '../../auth/security/guards';
import { SessionService } from '../../auth/services/session.service';
import { BffSessionService } from '../../auth/security/bff.session';
import { signAccessToken } from '../../auth/security/jwt';
import { AppModule } from '../../src/app.module';
import { ProblemJsonFilter } from '../../src/http';
import { CacheService } from '../../redis';

/**
 * The global-guard arrangement itself, tested apart from any real controller.
 *
 * tests/auth/auth.routes.spec.ts proves that `/auth/me` is protected and that
 * `/auth/login` is not. That is necessary but it is not the property that matters
 * here, because both of those routes were written by someone who had authentication
 * in mind. The property that matters is what happens to a route written by someone
 * who did NOT.
 *
 * So the controllers below are deliberately fictional — a stand-in for the wallet,
 * earning, merchant and social routes that do not exist yet. `UnmarkedRoutes`
 * carries no decorator of any kind, which is exactly the mistake this design is
 * meant to survive.
 */

@Controller('unmarked')
class UnmarkedRoutes {
  /** No `@Public()`, no `@UseGuards`. The shape of a route someone forgot about. */
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }
}

@Controller('marked')
class MarkedRoutes {
  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }

  @Get('closed')
  closed(@Req() req: FastifyRequest): { sub: string } {
    return { sub: requirePrincipal(req).userId };
  }
}

/**
 * Stands in for `POST /auth/session` — the only route on the optional guard.
 *
 * It exists here so the touch/no-touch split has somewhere to be asserted, which
 * is not cosmetic: whether this guard records activity decides whether a client
 * can hold an abandoned session open by refreshing it on a timer.
 */
@Controller('lifecycle')
class LifecycleRoutes {
  @Public()
  @Get()
  @UseGuards(OptionalAuthGuard)
  get(): { ok: true } {
    return { ok: true };
  }
}

const sessions = {
  assertLive: vi.fn(),
  touch: vi.fn(),
};
/** These tests authenticate with a BEARER, so `resolve` is never reached — there is
 *  no session cookie for the guard to hand it. The double exists because the guard
 *  now takes it as a constructor argument, not because this file exercises it; the
 *  cookie path is covered in tests/auth/session-cookie.spec.ts. */
const bff = {
  resolve: vi.fn().mockResolvedValue({ kind: 'absent' }),
};
const cache = { consume: vi.fn().mockResolvedValue(undefined) };

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [UnmarkedRoutes, MarkedRoutes, LifecycleRoutes],
    providers: [
      { provide: SessionService, useValue: sessions },
      { provide: BffSessionService, useValue: bff },
      { provide: CacheService, useValue: cache },
      AuthGuard,
      OptionalAuthGuard,
      { provide: APP_GUARD, useExisting: AuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new ProblemJsonFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // `assertLive` returns the row facts the guard stashes now. `familyId` has to be
  // present and non-null: the guard refuses with `unauthenticated` without one,
  // deliberately, because everything after it keys on the family.
  sessions.assertLive.mockResolvedValue({ lastUsedAt: null, familyId: 'family-1' });
  sessions.touch.mockResolvedValue(undefined);
  bff.resolve.mockResolvedValue({ kind: 'absent' });
});

function http() {
  return request(app.getHttpServer());
}

function bearer(): string {
  const { token } = signAccessToken({
    userId: 'user-1',
    sessionId: 'session-1',
    publicCode: 'AB12CD',
  });
  return `Bearer ${token}`;
}

describe('a route nobody thought about is closed', () => {
  it('refuses an anonymous caller on a route carrying no decorator at all', async () => {
    // THE test for this arrangement. Under the previous opt-in design — a guard
    // attached per route with `@UseGuards(AuthGuard)` — this request returned 200
    // and published the endpoint to the internet, with nothing anywhere to say so.
    const res = await http().get('/unmarked').expect(401);

    expect(res.body.type).toBe('unauthenticated');
  });

  it('admits the same caller once they authenticate', async () => {
    // The other half: failing closed is only useful if the route still works. A
    // guard that rejected everyone would also pass the test above.
    await http().get('/unmarked').set('Authorization', bearer()).expect(200);
  });

  it('checks the session on that route too, not just the signature', async () => {
    // The guard is one unit — a route gets the revocation check with it, and does
    // not have to remember to ask.
    sessions.assertLive.mockRejectedValue(new Error('revoked'));

    await http().get('/unmarked').set('Authorization', bearer()).expect(500);
    expect(sessions.assertLive).toHaveBeenCalledWith('session-1');
  });
});

describe('the global registration in src/app.module.ts', () => {
  it('binds AuthGuard as APP_GUARD', () => {
    // Everything above builds its own testing module and registers APP_GUARD by
    // hand, which means all of it would still pass if someone deleted that
    // provider from the real composition root — and the whole service would be
    // open with a green suite. This is the one assertion that reads the actual
    // wiring, so that deletion has somewhere to fail.
    //
    // Metadata rather than a compiled module: instantiating AppModule would want
    // Postgres and Redis, and this question does not need either.
    const providers = Reflect.getMetadata('providers', AppModule) as Array<{
      provide?: unknown;
      useExisting?: unknown;
    }>;

    expect(
      providers.some((p) => p?.provide === APP_GUARD && p?.useExisting === AuthGuard),
    ).toBe(true);
  });
});

describe('@Public() is the only way out', () => {
  it('lets an anonymous caller through a route that asked for it', async () => {
    await http().get('/marked/open').expect(200);
  });

  it('does not leak the exemption to a sibling route on the same controller', async () => {
    // Metadata is read from the handler first and the class second, so one public
    // route must not open the rest of its controller. Worth pinning because the
    // failure would be silent and would look exactly like a working app.
    const res = await http().get('/marked/closed').expect(401);

    expect(res.body.type).toBe('unauthenticated');
  });

  it('does not reject a bad token on a public route', async () => {
    // A public route must not care about a credential it never asked for. If this
    // returned 401, a client with a stale token could not reach /auth/login to
    // replace it — the deadlock the early return in AuthGuard exists to prevent.
    await http().get('/marked/open').set('Authorization', 'Bearer not.a.token').expect(200);
  });
});

describe('only real use counts as use', () => {
  it('records activity against the FAMILY, not the generation', async () => {
    await http().get('/unmarked').set('Authorization', bearer()).expect(200);

    // The token names `session-1`; `assertLive` resolved the family from the row. The
    // write has to use the family, because it is fire-and-forget and a background
    // rotation can replace the generation the token names before it lands — and
    // because a generation-keyed throttle finds an empty bucket after every rotation.
    // The two ids differ in this fixture precisely so a mix-up cannot pass.
    expect(sessions.touch).toHaveBeenCalledWith('family-1');
    expect(sessions.touch).not.toHaveBeenCalledWith('session-1');
  });

  it('does NOT record activity on the session-lifecycle route', async () => {
    // The hole this closes: refresh, logout and logout-all sit behind the optional
    // guard, and a client that refreshes on a timer while still holding a valid
    // access token used to stamp `lastUsedAt` every time it did. An abandoned tab
    // therefore looked busy forever and the idle timeout could never fire. What the
    // user does with the product is activity; what the client does to the session
    // is not.
    await http().get('/lifecycle').set('Authorization', bearer()).expect(200);

    expect(sessions.assertLive).toHaveBeenCalledWith('session-1');
    expect(sessions.touch).not.toHaveBeenCalled();
  });
});
