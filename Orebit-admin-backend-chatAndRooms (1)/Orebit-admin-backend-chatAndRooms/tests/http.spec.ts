import { describe, expect, it } from 'vitest';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Module,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { NO_STORE, registerCachePolicy } from '../src/cache';
import { ProblemException, ProblemJsonFilter } from '../src/http';
import { ERR } from '../src/contracts';
import { config } from '../src/config';
import { corsOptions } from '../src/cors';
import { CSRF, ELEVATION } from '../auth/auth.constants';

@Controller('test')
class TestController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Post('echo')
  echo() {
    return { ok: true };
  }

  @Get('problem')
  problem() {
    throw new ProblemException({
      type: ERR.INVALID_CREDENTIALS,
      detail: 'Credentials did not match.',
    });
  }

  @Get('not-found-exception')
  notFound() {
    throw new NotFoundException('Custom item was not found');
  }

  @Get('unauthorized-exception')
  unauthorized() {
    throw new UnauthorizedException('Missing token');
  }

  @Get('forbidden-exception')
  forbidden() {
    throw new ForbiddenException('Access denied');
  }

  @Get('rate-limited-exception')
  rateLimited() {
    throw new HttpException('Slow down', HttpStatus.TOO_MANY_REQUESTS);
  }

  @Get('internal-error')
  internalError() {
    throw new Error('Database connection failed on relation admin.admin_sessions');
  }

  /** The first lockout rung: a wait the client is meant to count down. */
  @Get('locked')
  locked() {
    throw new ProblemException({
      type: ERR.ACCOUNT_LOCKED,
      detail: 'Too many failed attempts.',
      retryAfterSeconds: 3600,
    });
  }

  /** The second rung: a refusal with NO wait. Nothing to count down to. */
  @Get('manual-review')
  manualReview() {
    throw new ProblemException({
      type: ERR.ADMIN_LOGIN_MANUAL_REVIEW,
      detail: 'This account is under review.',
    });
  }

  /** A cooldown that has just this moment lapsed. Zero is a real answer. */
  @Get('zero-cooldown')
  zeroCooldown() {
    throw new ProblemException({ type: ERR.RATE_LIMITED, retryAfterSeconds: 0 });
  }
}

@Module({
  controllers: [TestController],
})
class TestAppModule {}

describe('F12 — ProblemJsonFilter framework HTTP exception mapping', () => {
  async function createTestApp() {
    const adapter = new FastifyAdapter();
    const app = await NestFactory.create<NestFastifyApplication>(
      TestAppModule,
      adapter,
      { logger: false },
    );
    app.useGlobalFilters(new ProblemJsonFilter());
    await app.init();
    return { app, fastify: app.getHttpAdapter().getInstance() };
  }

  it('maps unknown routes (404) to documented not_found problem rather than 500', async () => {
    const { app, fastify } = await createTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/non-existent-route',
      });

      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');

      const body = JSON.parse(res.body);
      expect(body.type).toBe('not_found');
      expect(body.title).toBe('Not found');
      expect(body.status).toBe(404);
      expect(body.instance).toBe('/non-existent-route');
      expect(body.requestId).toBeDefined();
      expect(body.detail).toContain('Cannot GET /non-existent-route');
    } finally {
      await app.close();
    }
  });

  it('maps malformed JSON request bodies (400) to validation_failed problem rather than 500', async () => {
    const { app, fastify } = await createTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/test/echo',
        headers: { 'content-type': 'application/json' },
        body: '{"unclosed": json,',
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');

      const body = JSON.parse(res.body);
      expect(body.type).toBe('validation_failed');
      expect(body.title).toBe('Request validation failed');
      expect(body.status).toBe(400);
      expect(body.instance).toBe('/test/echo');
      expect(body.requestId).toBeDefined();
      expect(body.detail).toBeDefined();
      expect(typeof body.detail).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('preserves application-level ProblemException', async () => {
    const { app, fastify } = await createTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test/problem',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('invalid_credentials');
      expect(body.title).toBe('Incorrect credentials');
      expect(body.status).toBe(401);
      expect(body.detail).toBe('Credentials did not match.');
    } finally {
      await app.close();
    }
  });

  it('maps NestJS NotFoundException to not_found', async () => {
    const { app, fastify } = await createTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test/not-found-exception',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('not_found');
      expect(body.status).toBe(404);
      expect(body.detail).toBe('Custom item was not found');
    } finally {
      await app.close();
    }
  });

  it('maps NestJS UnauthorizedException to unauthenticated', async () => {
    const { app, fastify } = await createTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test/unauthorized-exception',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('unauthenticated');
      expect(body.status).toBe(401);
      expect(body.detail).toBe('Missing token');
    } finally {
      await app.close();
    }
  });

  it('maps NestJS ForbiddenException to forbidden', async () => {
    const { app, fastify } = await createTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test/forbidden-exception',
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('forbidden');
      expect(body.status).toBe(403);
      expect(body.detail).toBe('Access denied');
    } finally {
      await app.close();
    }
  });

  it('maps 429 status exceptions to rate_limited', async () => {
    const { app, fastify } = await createTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test/rate-limited-exception',
      });

      expect(res.statusCode).toBe(429);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('rate_limited');
      expect(body.status).toBe(429);
      expect(body.detail).toBe('Slow down');
    } finally {
      await app.close();
    }
  });

  it('redacts internal server errors and leaks no internal database details', async () => {
    const { app, fastify } = await createTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test/internal-error',
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('internal_error');
      expect(body.title).toBe('Internal server error');
      expect(body.status).toBe(500);
      // Detail must NOT be sent for internal errors
      expect(body.detail).toBeUndefined();
      expect(res.body).not.toContain('admin.admin_sessions');
      expect(res.body).not.toContain('Database connection failed');
    } finally {
      await app.close();
    }
  });
});

/**
 * ═══ F13 — THE COOLDOWN DURATION HAS TO BE READABLE ═════════════════════════
 *
 * The wait was being reported ONLY as the `Retry-After` header, and the admin
 * panel is a cross-origin caller: a browser hands script no response header that
 * CORS has not named in `Access-Control-Expose-Headers`, so `headers.get(...)`
 * returned null and a locked-out admin was told they were locked with no way to
 * learn for how long. That is the difference between waiting an hour and filing a
 * support ticket.
 *
 * These assertions are at the HTTP level ON PURPOSE. tests/auth/lockout.spec.ts
 * already asserts `problem.retryAfterSeconds` on the exception the service throws,
 * and every one of those assertions passed for the entire time the bug was live —
 * the defect was in serialization, below the layer those specs can see. A green
 * service-level suite is not evidence about the wire.
 */
describe('F13 — the retry duration on the wire', () => {
  async function createTestApp(withCors: boolean) {
    const adapter = new FastifyAdapter();
    const app = await NestFactory.create<NestFastifyApplication>(TestAppModule, adapter, {
      logger: false,
    });
    // Registered before `init`, and with the REAL policy object rather than a copy
    // of it — a duplicated options literal here would keep passing after someone
    // dropped `exposedHeaders` from src/cors.ts, which is the regression this is
    // supposed to catch.
    if (withCors) await app.register(import('@fastify/cors'), corsOptions);
    app.useGlobalFilters(new ProblemJsonFilter());
    await app.init();
    return { app, fastify: app.getHttpAdapter().getInstance() };
  }

  // ─── Case 1: a duration exists ────────────────────────────────────────────

  it('serializes retryAfterSeconds into the problem body', async () => {
    const { app, fastify } = await createTestApp(false);
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test/locked' });

      expect(res.statusCode).toBe(423);
      expect(res.headers['content-type']).toContain('application/problem+json');

      const body = JSON.parse(res.body);
      expect(body.type).toBe('account_locked');
      expect(body.retryAfterSeconds).toBe(3600);
    } finally {
      await app.close();
    }
  });

  it('still sends the Retry-After header', async () => {
    const { app, fastify } = await createTestApp(false);
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test/locked' });
      expect(res.headers['retry-after']).toBe('3600');
    } finally {
      await app.close();
    }
  });

  /** Two representations of one fact. A client that reads either must not be able
   *  to draw a different conclusion from a client that reads the other. */
  it('reports the same number in the header and the body', async () => {
    const { app, fastify } = await createTestApp(false);
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test/locked' });
      const body = JSON.parse(res.body);

      expect(body.retryAfterSeconds).toBe(Number(res.headers['retry-after']));
    } finally {
      await app.close();
    }
  });

  // ─── Case 2: no duration ──────────────────────────────────────────────────

  /**
   * `admin_login_manual_review` is the second lockout rung, and NO wait lifts it —
   * only a super admin's decision does. A `retryAfterSeconds` of 0 or null here
   * would have the panel render a countdown that expires into another refusal,
   * telling an admin to wait for something that is never going to happen.
   *
   * Absence is the representation. Asserted three ways because `toBeUndefined()`
   * alone passes for an explicit `null` in JSON and for a key whose value is 0.
   */
  it('omits retryAfterSeconds entirely when there is no wait', async () => {
    const { app, fastify } = await createTestApp(false);
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test/manual-review' });

      expect(res.statusCode).toBe(403);

      const body = JSON.parse(res.body);
      expect(body.type).toBe('admin_login_manual_review');
      expect('retryAfterSeconds' in body).toBe(false);
      expect(body.retryAfterSeconds).toBeUndefined();
      expect(res.body).not.toContain('retryAfterSeconds');
    } finally {
      await app.close();
    }
  });

  it('sends no Retry-After header when there is no wait', async () => {
    const { app, fastify } = await createTestApp(false);
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test/manual-review' });
      expect(res.headers['retry-after']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  /**
   * The other direction, and the reason the filter tests `!== undefined` rather
   * than truthiness: a cooldown whose remaining time has just reached zero is a
   * wait of zero seconds, not the absence of a wait. A `?? {}` or a `? :` on the
   * value itself would drop it and report "no cooldown" for a live rate limit.
   */
  it('keeps an explicit zero rather than dropping it', async () => {
    const { app, fastify } = await createTestApp(false);
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test/zero-cooldown' });

      const body = JSON.parse(res.body);
      expect(body.retryAfterSeconds).toBe(0);
      expect(res.headers['retry-after']).toBe('0');
    } finally {
      await app.close();
    }
  });

  // ─── Case 3: CORS exposure ────────────────────────────────────────────────

  /**
   * The header half of the fix. `Access-Control-Expose-Headers` is what makes
   * `response.headers.get('retry-after')` return a value in browser JavaScript
   * served from another origin; without it the header is on the wire and still
   * invisible to the page.
   *
   * Asserted on the 423 itself rather than on a 200, because that is the response
   * that carries the duration — CORS headers being present on success proves
   * nothing about an error reply produced by an exception filter.
   */
  it('exposes retry-after to an allowed origin, on the refusal itself', async () => {
    const { app, fastify } = await createTestApp(true);
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test/locked',
        headers: { origin: config.ADMIN_APP_URL },
      });

      expect(res.statusCode).toBe(423);
      expect(res.headers['access-control-allow-origin']).toBe(config.ADMIN_APP_URL);
      expect(String(res.headers['access-control-expose-headers'])).toContain('retry-after');
      // Both halves reach the panel on one response.
      expect(res.headers['retry-after']).toBe('3600');
      expect(JSON.parse(res.body).retryAfterSeconds).toBe(3600);
    } finally {
      await app.close();
    }
  });

  /** The allow-list is unchanged: exposing a header did not widen who may read it. */
  it('grants nothing to a disallowed origin', async () => {
    const { app, fastify } = await createTestApp(true);
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test/locked',
        headers: { origin: 'https://not-the-admin-panel.example' },
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-expose-headers']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  /**
   * Exposure is deliberately narrow. `Access-Control-Expose-Headers` is a decision
   * about what another origin's script may read off this service's responses, so
   * the list is asserted exactly — an addition should have to change this line and
   * justify itself, not arrive as a side effect of a wildcard.
   */
  it('exposes exactly one header, and no wildcard', async () => {
    expect(corsOptions.exposedHeaders).toEqual(['retry-after']);
  });

  /** The pre-existing policy, asserted because the extraction into src/cors.ts
   *  must not have changed any of it. */
  it('preserves credentials and the allowed request headers', async () => {
    expect(corsOptions.credentials).toBe(true);
    expect(corsOptions.allowedHeaders).toEqual([
      'content-type',
      'authorization',
      ELEVATION.HEADER_NAME,
      CSRF.HEADER_NAME,
    ]);
  });
});

/**
 * ═══ F15 — THE CACHE POLICY, ON EVERY OUTCOME ══════════════════════════════
 *
 * `Cache-Control: no-store` was set by individual handlers, and that could not be
 * complete. `GET /auth/session` set it on its own 200; `GET /auth/me` — which
 * returns the admin's name, email and role — set nothing at all, so a private
 * profile response left the service with no `Cache-Control` and whatever a proxy's
 * heuristic freshness rules made of it.
 *
 * Worse, a handler cannot cover a REFUSAL. `AuthGuard` throws before any handler
 * runs, so the line that set the header was never reached on a 401 — and a cached
 * 401 outlives the condition that caused it just as a cached 200 outlives the
 * session.
 *
 * The policy is an `onRequest` hook now (src/cache.ts), which is the earliest point
 * Fastify offers: the header is on the reply before routing, before guards, and
 * before the handler, so every path out of the service carries it. These cases
 * drive a real Fastify instance rather than a mocked reply, because the hook IS the
 * thing under test.
 */
describe('F15 — no-store on private responses', () => {
  @Controller('sensitive')
  class SensitiveController {
    /** Stands in for `GET /auth/me`: a private profile read. */
    @Get('me')
    me() {
      return { data: { admin: { email: 'admin@orebit.io' } } };
    }

    /** Stands in for a guard refusal — thrown before any handler could set a header. */
    @Get('refused')
    refused() {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
  }

  @Module({ controllers: [SensitiveController] })
  class SensitiveAppModule {}

  async function createApp() {
    const adapter = new FastifyAdapter();
    const app = await NestFactory.create<NestFastifyApplication>(SensitiveAppModule, adapter, {
      logger: false,
    });
    const fastify = app.getHttpAdapter().getInstance();
    // Registered exactly as src/main.ts does it, and BEFORE init, so the hook is in
    // place for every route the app goes on to declare.
    registerCachePolicy(fastify);
    app.useGlobalFilters(new ProblemJsonFilter());
    // A stand-in for the /docs mount, which is served straight off Fastify rather
    // than through Nest — see src/openapi.ts.
    fastify.get('/docs', async () => ({ openapi: '3.0.0' }));
    fastify.get('/docs/static/main.js', async () => 'console.log(1)');
    await app.init();
    return { app, fastify };
  }

  it('sets no-store on a private profile response', async () => {
    const { app, fastify } = await createApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/sensitive/me' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe(NO_STORE);
    } finally {
      await app.close();
    }
  });

  /** The path no handler can reach. This is the half F15 was actually about. */
  it('sets no-store on a refusal, which no handler ever runs to set', async () => {
    const { app, fastify } = await createApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/sensitive/refused' });

      expect(res.statusCode).toBe(401);
      expect(res.headers['cache-control']).toBe(NO_STORE);
      // The problem document is intact — the hook adds a header, it does not
      // interfere with the one error shape leaving the service.
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json().type).toBe(ERR.UNAUTHENTICATED);
    } finally {
      await app.close();
    }
  });

  /** A route that never reaches Nest at all still gets the header. */
  it('sets no-store on a framework 404', async () => {
    const { app, fastify } = await createApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/no-such-route' });

      expect(res.statusCode).toBe(404);
      expect(res.headers['cache-control']).toBe(NO_STORE);
    } finally {
      await app.close();
    }
  });

  /**
   * The one exemption. `/docs` is public, identical for every caller, and pulls
   * static assets on each load; stamping `no-store` over them would make a
   * documentation page re-download its own JavaScript to protect a document that is
   * already public.
   */
  it('exempts the docs and their static assets', async () => {
    const { app, fastify } = await createApp();
    try {
      const docs = await fastify.inject({ method: 'GET', url: '/docs' });
      const asset = await fastify.inject({ method: 'GET', url: '/docs/static/main.js' });

      expect(docs.headers['cache-control']).toBeUndefined();
      expect(asset.headers['cache-control']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  /** A query string must not smuggle a private route past the exemption, and a
   *  route merely starting with those characters is not the docs. */
  it('matches the docs exemption on the path, not the prefix of the URL', async () => {
    const { app, fastify } = await createApp();
    try {
      const withQuery = await fastify.inject({ method: 'GET', url: '/docs?theme=dark' });
      const lookalike = await fastify.inject({ method: 'GET', url: '/docsomething' });

      expect(withQuery.headers['cache-control']).toBeUndefined();
      // Not the docs. Gets the policy, even though its URL starts with `/docs`.
      expect(lookalike.headers['cache-control']).toBe(NO_STORE);
    } finally {
      await app.close();
    }
  });
});
