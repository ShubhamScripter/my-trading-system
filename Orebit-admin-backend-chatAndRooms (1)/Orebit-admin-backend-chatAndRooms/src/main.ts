import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { registerCachePolicy } from './cache';
import { config } from './config';
import { corsOptions } from './cors';
import { ProblemJsonFilter } from './http';
import { PinoNestLogger } from './logger';
import { registerOpenApi } from './openapi';

async function bootstrap(): Promise<void> {
  const logger = new PinoNestLogger();

  const adapter = new FastifyAdapter({
    // Every rate limit in this service is keyed on the client IP, and behind
    // Cloudflare the socket address is Cloudflare's. Without this, all traffic
    // shares one bucket and per-IP limiting silently does nothing.
    //
    // The inverse is worse: trusting the header with no proxy in front lets any
    // caller pick their own IP and step around every limit. Hence the env value —
    // it must match the actual deployment topology.
    //
    // A LIST of trusted proxies, never `true`. `trustProxy: true` trusts every hop,
    // and `proxy-addr` then returns the leftmost X-Forwarded-For entry — which is
    // the one the client wrote. Cloudflare appends to XFF rather than replacing it,
    // so with `true` a caller who sets the header themselves is never in the same
    // rate-limit bucket twice, and the captcha penalty ladder never escalates.
    // Naming the hops means the header is believed only where a hop exists.
    // `false` when nothing is configured — see config.trustedProxies.
    trustProxy: config.trustedProxies,
    // Bodies here are a handful of short fields plus, on the passkey steps, a
    // WebAuthn response. 64 KiB is comfortably more than either needs, and a
    // megabyte-plus JSON body is not a legitimate request to this service.
    bodyLimit: 64 * 1024,
    genReqId: () => randomUUID(),
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger });

  // FIRST, and before every other hook, plugin and route: an `onRequest` hook that
  // stamps `Cache-Control: no-store` on the reply. Registered here rather than per
  // handler because a handler cannot cover a guard's 401 — it never runs — and
  // because a private response that forgets the header is a bug that reports
  // nothing. See src/cache.ts.
  registerCachePolicy(app.getHttpAdapter().getInstance());

  // Registered before the routes so `req.cookies` is populated by the time any
  // handler runs. Three cookies, none of which is the sign-in credential any more:
  // the refresh token and its CSRF companion (auth/security/session.cookie.ts), and
  // the per-browser rate-limit id (auth/security/device.cookie.ts). The in-flight
  // sign-in travels in the body as `loginId`.
  await app.register(import('@fastify/cookie'));
  // Helmet keeps its defaults, deliberately. The /docs page needs no exception:
  // every asset it loads is a real file under /docs/static, and @fastify/swagger-ui
  // sets its own CSP on those routes anyway. Loosening `script-src` here to suit
  // the docs would weaken every API response to fix a page that was not broken.
  await app.register(import('@fastify/helmet'));
  // Origin allow-list, the headers the panel may send, and the one response
  // header it may read. In src/cors.ts so a spec can assert on it.
  await app.register(import('@fastify/cors'), corsOptions);

  await registerOpenApi(app);

  // Registered globally so there is exactly one error shape leaving the service.
  app.useGlobalFilters(new ProblemJsonFilter());

  app.enableShutdownHooks();

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.log(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      captcha: config.captchaEnabled
        ? config.captchaProviders.map(({ provider }) => provider).join(',')
        : 'DISABLED',
      webauthnRpId: config.WEBAUTHN_RP_ID,
      // Said out loud, because a wrong value here disables every rate limit
      // without producing a single error — the one misconfiguration in this file
      // that is completely silent.
      trustedProxies:
        config.trustedProxies === false ? 'NONE (socket address is the client)' : config.trustedProxies,
    },
    'listening',
  );
}

void bootstrap().catch((err: unknown) => {
  // Nothing is wired up yet at this point, so this deliberately bypasses the
  // logger — a failure to construct the app must still be visible.
  console.error('bootstrap failed', err);
  process.exit(1);
});
