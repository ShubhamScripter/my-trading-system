import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { config } from './config';
import { ProblemJsonFilter } from './http';
import { PinoNestLogger } from './logger';
import { registerOpenApi } from './openapi';

async function bootstrap(): Promise<void> {
  const logger = new PinoNestLogger();

  const adapter = new FastifyAdapter({
    // Every rate limit in this service is keyed on the client IP, and behind a
    // proxy the socket address is the proxy's. Without this, all traffic shares
    // one bucket and per-IP limiting silently does nothing.
    //
    // The inverse is worse, and is why this is a CIDR list rather than a flag:
    // `trustProxy: true` trusts every hop and resolves to the leftmost
    // `X-Forwarded-For` entry, which the client writes. Naming the proxies makes
    // Fastify walk the chain from the right and stop at the first address that is
    // not one of ours — the first one a caller could not have forged.
    //
    // Note this reads `X-Forwarded-For`, never `CF-Connecting-IP`. Behind
    // Cloudflare, TRUSTED_PROXIES must list Cloudflare's published ranges.
    trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false,
    // Bodies here are a handful of short fields. A megabyte-plus JSON body is not
    // a legitimate request to this service, and parsing it is free work for an
    // attacker.
    bodyLimit: 64 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger });

  // Registered before the routes so `req.cookies` is populated by the time any
  // handler runs.
  //
  // Three cookies use it, all of them named in auth/auth.constants.ts:
  // `orebit_session` (the BFF session handle) and `orebit_csrf` (its companion
  // token), both written by auth/security/session.cookie.ts, and `orebit_device`
  // (a rate-limit grouping key, not a credential) from
  // auth/security/device.cookie.ts.
  //
  // There is deliberately no temporary signup or login cookie. Both in-flight
  // flows are named by an opaque handle in the request body — `signupId` and
  // `loginId` — so a half-finished flow is never attached to a request that did
  // not mean to send it.
  await app.register(import('@fastify/cookie'));
  // Helmet keeps its defaults, deliberately. The /docs page needs no exception:
  // every asset it loads is a real file under /docs/static, and @fastify/swagger-ui
  // sets its own CSP on those routes anyway. Loosening `script-src` here to suit
  // the docs would weaken every API response to fix a page that was not broken.
  await app.register(import('@fastify/helmet'));
  await app.register(import('@fastify/cors'), {
    origin: [config.WEB_APP_URL],
    credentials: true,
    allowedHeaders: [
      'content-type',
      'authorization',
      // REMOVED: `x-registration-token` and `x-step-up-token`.
      //
      // The first carried the signup continuation secret for clients that would
      // rather not keep a cookie jar; it is `signupId` in the body now, which
      // serves those clients at least as well and leaves one way to name a flow
      // instead of two. The second was never implemented at all — nothing in this
      // service ever read it — so it was a preflight allowance for a mechanism
      // that did not exist.
      //
      // The CSRF token guarding POST /auth/session, echoed from the `orebit_csrf`
      // cookie. Without it listed here the preflight refuses the header and every
      // refresh fails — see CSRF in auth/auth.constants.ts.
      'x-orebit-csrf',
      // A single-use permit for one re-authenticated write. A DIFFERENT credential
      // from the one above and held by a different kind of caller, which is why it
      // is a different header — see the note on ELEVATION.HEADER_NAME.
      'x-elevation-ticket',
    ],
  });

  // Multipart parsing for uploads (max 10 MB per file)
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });

  await registerOpenApi(app);

  // Registered globally so there is exactly one error shape leaving the service.
  app.useGlobalFilters(new ProblemJsonFilter());

  app.enableShutdownHooks();

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.log({ port: config.PORT, env: config.NODE_ENV }, 'listening');
}

void bootstrap().catch((err: unknown) => {
  // Nothing is wired up yet at this point, so this deliberately bypasses the
  // logger — a failure to construct the app must still be visible.
  console.error('bootstrap failed', err);
  process.exit(1);
});
