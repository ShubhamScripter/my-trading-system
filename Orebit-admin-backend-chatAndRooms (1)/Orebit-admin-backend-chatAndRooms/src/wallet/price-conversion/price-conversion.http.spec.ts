import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { EXCEPTION_FILTERS_METADATA, GUARDS_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import pg from 'pg';
import type { PriceConversionBootstrap } from './price-conversion.types.js';

async function load<T>(path: string): Promise<T | undefined> {
  return import(path).catch(() => undefined) as Promise<T | undefined>;
}

function testDatabaseUrl(): string {
  const value = process.env.PRICE_TEST_DATABASE_URL;
  if (value === undefined) throw new Error('PRICE_TEST_DATABASE_URL is required');
  return value;
}

function runtimeDatabaseUrl(): string {
  return testDatabaseUrl();
}

const AUDIT_CONTEXT = {
  actorId: '01920000-0000-7000-8000-000000000010',
  sessionId: '01920000-0000-7000-8000-000000000011',
  requestId: '01920000-0000-7000-8000-000000000012',
  ipAddress: '203.0.113.8',
  deviceId: '262a22871b5e894643e6833ceb144fbe',
} as const;
const AUTH_CEILING_AT = new Date(Date.now() + 60 * 60 * 1000);

const LIVE_SESSION = {
  assertLive: async () => null,
  touch: async () => undefined,
};

const BEARER_ONLY_BFF = {
  resolve: async () => null,
};

function httpContext(request: unknown): never {
  return {
    getClass: () => class TestRoute {},
    getHandler: () => function testHandler() {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('admin price-conversion service', () => {
  it('forwards bounded bootstrap and exact-string latest-price pages', async () => {
    const services = await load<typeof import('./price-conversion.service.js')>(
      './price-conversion.service.js',
    );
    const bootstrap = {
      settings: { revision: 7, divergenceThresholdBps: 125, updatedAt: '2026-08-31T00:00:00.000Z' },
      providers: [],
      configuration: { draft: null, live: null, scheduled: [], scheduledNextCursor: null },
      fiatOptions: [{ code: 'USD' as const, visible: true }],
      roleConfigurationStatus: 'HEALTHY' as const,
      securityState: 'DEGRADED' as const,
    } satisfies PriceConversionBootstrap;
    let receivedQuery: unknown;
    const db = {
      bootstrap: async (query: unknown) => {
        receivedQuery = query;
        return bootstrap;
      },
      updateAtomically: async () => ({ kind: 'updated' as const, revision: 8 }),
      history: async () => ({ items: [], nextCursor: null }),
      prices: async () => ({ items: [{
        currencyId: '01920000-0000-7000-8000-000000000001',
        priceUsd: '67890.123456789012345678',
        observedAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:01.000Z', provider: 'COINGECKO' as const,
        snapshotId: '01920000-0000-7000-8000-000000000002', stale: false,
        disabled: false, reason: 'PRIMARY_CONFIRMED' as const,
      }], nextCursor: null }),
    };

    assert.ok(services);
    const service = new services.PriceConversionService(db);

    assert.deepEqual(await service.bootstrap({}), bootstrap);
    assert.deepEqual(receivedQuery, {});
    assert.equal((await service.prices({ limit: 1 })).items[0]?.priceUsd,
      '67890.123456789012345678');
  });

  it('maps conflict and validation errors through the module RFC9457 filter', async () => {
    const [services, filters] = await Promise.all([
      import('./price-conversion.service.js'),
      load<typeof import('./price-conversion.filter.js')>('./price-conversion.filter.js'),
    ]);
    assert.ok(filters?.PriceConversionExceptionFilter);
    const responses: unknown[] = [];
    let status = 0;
    const reply = {
      status(code: number) { status = code; return this; },
      header() { return this; },
      send(body: unknown) { responses.push(body); },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ id: '01920000-0000-7000-8000-000000000012', url: '/v1/admin/wallet/price-conversion' }),
      }),
    } as never;
    const filter = new filters.PriceConversionExceptionFilter();

    filter.catch(new services.PriceConfigurationConflict(9), host);
    assert.equal(status, 409);
    assert.deepEqual(responses.pop(), {
      type: 'price_configuration_conflict', title: 'Price configuration revision conflict',
      status: 409, instance: '/v1/admin/wallet/price-conversion',
      requestId: '01920000-0000-7000-8000-000000000012', extra: { actualRevision: 9 },
    });

    filter.catch(new services.PriceConfigurationValidationError('Scheduled effectiveAt must be in the future'), host);
    assert.equal(status, 400);
    assert.deepEqual(responses.pop(), {
      type: 'price_configuration_invalid', title: 'Invalid price configuration', status: 400,
      detail: 'Scheduled effectiveAt must be in the future',
      instance: '/v1/admin/wallet/price-conversion', requestId: '01920000-0000-7000-8000-000000000012',
    });
  });

  it('sends the expected revision and complete batch to one atomic store operation', async () => {
    const services = await load<typeof import('./price-conversion.service.js')>(
      './price-conversion.service.js',
    );
    const input = {
      action: 'PUSH' as const, expectedRevision: 7, reason: 'Apply reviewed settings.',
      changelog: 'Reviewed.', divergenceThresholdBps: 125,
    };
    let received: readonly unknown[] = [];
    const db = {
      bootstrap: async () => ({
        settings: { revision: 7, divergenceThresholdBps: 125, updatedAt: '2026-08-31T00:00:00.000Z' },
        providers: [],
        configuration: { draft: null, live: null, scheduled: [], scheduledNextCursor: null },
        fiatOptions: [{ code: 'USD' as const, visible: true }],
        roleConfigurationStatus: 'HEALTHY' as const,
        securityState: 'HEALTHY' as const,
      }),
      updateAtomically: async (...args: readonly unknown[]) => {
        received = args;
        return { kind: 'updated' as const, revision: 8 };
      },
      history: async () => ({ items: [], nextCursor: null }),
      prices: async () => ({ items: [], nextCursor: null }),
    };

    assert.ok(services);
    const service = new services.PriceConversionService(db);

    assert.deepEqual(await service.update(input, AUDIT_CONTEXT), { revision: 8 });
    assert.deepEqual(received, [input, AUDIT_CONTEXT]);
  });

  it('reports an optimistic revision conflict as a stable local 409 problem', async () => {
    const services = await load<typeof import('./price-conversion.service.js')>('./price-conversion.service.js');
    assert.ok(services);
    const service = new services.PriceConversionService({
      bootstrap: async () => ({
        settings: { revision: 1, divergenceThresholdBps: 1, updatedAt: '2026-08-31T00:00:00.000Z' },
        providers: [],
        configuration: { draft: null, live: null, scheduled: [], scheduledNextCursor: null },
        fiatOptions: [{ code: 'USD' as const, visible: true }],
        roleConfigurationStatus: 'HEALTHY' as const,
        securityState: 'HEALTHY' as const,
      }),
      updateAtomically: async () => ({ kind: 'revision_conflict' as const, actualRevision: 9 }),
      history: async () => ({ items: [], nextCursor: null }),
      prices: async () => ({ items: [], nextCursor: null }),
    });
    await assert.rejects(() => service.update({
      action: 'PUSH', expectedRevision: 8, reason: 'Apply reviewed settings.', changelog: 'Reviewed.',
    }, AUDIT_CONTEXT), (error: unknown) =>
      error instanceof services.PriceConfigurationConflict && error.status === 409 && error.actualRevision === 9,
    );
  });
});

describe('admin price-conversion transport', () => {
  it('validates every route input and returns each service result in the success envelope', async () => {
    const routes = await load<typeof import('./price-conversion.routes.js')>(
      './price-conversion.routes.js',
    );
    const calls: unknown[] = [];
    const service = {
      bootstrap: async (input: unknown) => {
        calls.push(input);
        return {
        settings: { revision: 7, divergenceThresholdBps: 125, updatedAt: '2026-08-31T00:00:00.000Z' },
        providers: [],
        configuration: { draft: null, live: null, scheduled: [], scheduledNextCursor: null },
        fiatOptions: [{ code: 'USD' as const, visible: true }],
        roleConfigurationStatus: 'HEALTHY' as const,
        securityState: 'HEALTHY' as const,
        };
      },
      update: async (input: unknown) => {
        calls.push(input);
        return { revision: 8 };
      },
      history: async (input: unknown) => {
        calls.push(input);
        return { items: [], nextCursor: null };
      },
      prices: async (input: unknown) => {
        calls.push(input);
        return { items: [], nextCursor: null };
      },
    };

    assert.ok(routes);
    const transport = new routes.PriceConversionRoutes(service as never);
    const guards = await import('../../../auth/security/guards.js');
    const jwt = await import('../../../auth/security/jwt.js');
    const request = {
      id: AUDIT_CONTEXT.requestId,
      ip: AUDIT_CONTEXT.ipAddress,
      headers: {
        authorization: `Bearer ${jwt.signAccessToken({
          adminId: AUDIT_CONTEXT.actorId,
          sessionId: AUDIT_CONTEXT.sessionId,
          role: 'SUPER_ADMIN',
          ceilingAt: AUTH_CEILING_AT,
        }).token}`,
      },
    };
    await new guards.AuthGuard(
      LIVE_SESSION as never,
      BEARER_ONLY_BFF as never,
      new Reflector(),
    ).canActivate(httpContext(request));

    assert.deepEqual(await transport.bootstrap({}), {
      data: {
        settings: { revision: 7, divergenceThresholdBps: 125, updatedAt: '2026-08-31T00:00:00.000Z' },
        providers: [],
        configuration: { draft: null, live: null, scheduled: [], scheduledNextCursor: null },
        fiatOptions: [{ code: 'USD' as const, visible: true }],
        roleConfigurationStatus: 'HEALTHY' as const,
        securityState: 'HEALTHY' as const,
      },
    });
    assert.deepEqual(await transport.update({
      action: 'PUSH', expectedRevision: 7, reason: 'Push reviewed changes.', changelog: 'Reviewed.',
    }, request as never), { data: { revision: 8 } });
    assert.deepEqual(await transport.history({ limit: '10' }), {
      data: { items: [], nextCursor: null },
    });
    assert.deepEqual(await transport.prices({ limit: '10' }), {
      data: { items: [], nextCursor: null },
    });
    await assert.rejects(() => transport.bootstrap({ limit: '2' }));
    assert.deepEqual(calls, [
      { scheduledLimit: 50 },
      { action: 'PUSH', expectedRevision: 7, reason: 'Push reviewed changes.', changelog: 'Reviewed.' },
      { limit: 10, sortBy: 'timestamp', sortDirection: 'desc' },
      { limit: 10, sortBy: 'currencyId', sortDirection: 'asc' },
    ]);
  });
});

describe('admin price-conversion routes', () => {
  it('declares only the four unmounted price-conversion endpoints', async () => {
    const routes = await load<typeof import('./price-conversion.routes.js')>(
      './price-conversion.routes.js',
    );

    assert.ok(routes);
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, routes.PriceConversionRoutes),
      'v1/admin/wallet/price-conversion',
    );
    assert.equal(Reflect.getMetadata(PATH_METADATA, routes.PriceConversionRoutes.prototype.bootstrap), '/');
    assert.equal(Reflect.getMetadata(PATH_METADATA, routes.PriceConversionRoutes.prototype.update), '/');
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, routes.PriceConversionRoutes.prototype.history),
      'history',
    );
    assert.equal(Reflect.getMetadata(PATH_METADATA, routes.PriceConversionRoutes.prototype.prices), 'prices');
  });

  it('passes only an empty bootstrap query to the service', async () => {
    const routes = await load<typeof import('./price-conversion.routes.js')>('./price-conversion.routes.js');
    assert.ok(routes);
    let received: unknown;
    const service = {
      bootstrap: async (query: unknown) => {
        received = query;
        return { data: {} };
      },
    };

    await new routes.PriceConversionRoutes(service as never).bootstrap({});

    assert.deepEqual(received, { scheduledLimit: 50 });
  });

  it('uses current admin state without elevation before configuration writes', async () => {
    const [routes, guards, jwt] = await Promise.all([
      load<typeof import('./price-conversion.routes.js')>('./price-conversion.routes.js'),
      import('../../../auth/security/guards.js'),
      import('../../../auth/security/jwt.js'),
    ]);
    assert.ok(routes);
    const auth = new guards.AuthGuard(
      LIVE_SESSION as never,
      BEARER_ONLY_BFF as never,
      new Reflector(),
    );

    for (const [stored, expectedStatus] of [
      [{ status: 'ACTIVE', role: 'SUPER_ADMIN' }, null],
      [{ status: 'ACTIVE', role: 'ADMIN' }, 403],
      [{ status: 'DISABLED', role: 'SUPER_ADMIN' }, 401],
    ] as const) {
      const token = jwt.signAccessToken({
        adminId: '01920000-0000-7000-8000-000000000010',
        sessionId: '01920000-0000-7000-8000-000000000011',
        role: 'SUPER_ADMIN',
        ceilingAt: AUTH_CEILING_AT,
      }).token;
      const context = httpContext({ headers: { authorization: `Bearer ${token}` } });
      await auth.canActivate(context);
      const guard = new guards.SuperAdminGuard({ findById: async () => stored } as never);
      if (expectedStatus === null) assert.equal(await guard.canActivate(context), true);
      else await assert.rejects(() => guard.canActivate(context), (error: unknown) =>
        typeof error === 'object' && error !== null && 'status' in error
          && error.status === expectedStatus,
      );
    }

    const appliedGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      routes.PriceConversionRoutes.prototype.update,
    ) as readonly unknown[];
    const elevation = await import('../../2fa/elevation.js');
    assert.deepEqual(appliedGuards, [guards.SuperAdminGuard]);
    assert.equal(
      Reflect.getMetadata(elevation.ELEVATION_ACTION, routes.PriceConversionRoutes.prototype.update),
      undefined,
    );
    const historyGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      routes.PriceConversionRoutes.prototype.history,
    ) as readonly unknown[];
    assert.deepEqual(historyGuards, [guards.SuperAdminGuard]);
    const filters = await load<typeof import('./price-conversion.filter.js')>('./price-conversion.filter.js');
    assert.ok(filters?.PriceConversionExceptionFilter);
    assert.deepEqual(
      Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, routes.PriceConversionRoutes.prototype.update),
      [filters.PriceConversionExceptionFilter],
    );
  });

  it('passes actor, session, request, IP, and device audit context from PATCH', async () => {
    const [routes, guards, jwt] = await Promise.all([
      load<typeof import('./price-conversion.routes.js')>('./price-conversion.routes.js'),
      import('../../../auth/security/guards.js'),
      import('../../../auth/security/jwt.js'),
    ]);
    assert.ok(routes);
    let received: readonly unknown[] = [];
    const service = {
      update: async (...args: readonly unknown[]) => {
        received = args;
        return { revision: 1 };
      },
    };
    const token = jwt.signAccessToken({
      adminId: '01920000-0000-7000-8000-000000000010',
      sessionId: '01920000-0000-7000-8000-000000000011',
      role: 'SUPER_ADMIN',
      ceilingAt: AUTH_CEILING_AT,
    }).token;
    const request = {
      id: '01920000-0000-7000-8000-000000000012',
      ip: '203.0.113.8',
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'OREBiT Admin Test',
        'accept-language': 'en-IN',
      },
    };
    await new guards.AuthGuard(
      LIVE_SESSION as never,
      BEARER_ONLY_BFF as never,
      new Reflector(),
    )
      .canActivate(httpContext(request));
    const body = { action: 'PUSH', expectedRevision: 0, reason: 'Audit this.', changelog: 'Audited.' };

    assert.deepEqual(
      await new routes.PriceConversionRoutes(service as never).update(body, request as never),
      { data: { revision: 1 } },
    );

    assert.deepEqual(received, [body, {
      actorId: '01920000-0000-7000-8000-000000000010',
      sessionId: '01920000-0000-7000-8000-000000000011',
      requestId: '01920000-0000-7000-8000-000000000012',
      ipAddress: '203.0.113.8',
      deviceId: createHash('sha256').update('OREBiT Admin Test|en-IN').digest('hex').slice(0, 32),
    }]);
  });
});

describe('admin price-conversion module', () => {
  it('compiles without a TwoFactorModule dependency and closes its validated PostgreSQL pool', async () => {
    process.env.PRICE_DATABASE_URL = runtimeDatabaseUrl();
    const [testing, moduleFile, db, redis, mail, otpQueue, captcha, captchaSettings, auth, twoFactor, operation] = await Promise.all([
      import('@nestjs/testing'),
      load<typeof import('./price-conversion.module.js')>('./price-conversion.module.js'),
      import('../../../db/client.js'),
      import('../../../redis/index.js'),
      import('../../mail/mail.module.js'),
      import('../../mail/otp-queue.service.js'),
      import('../../captcha/captcha.module.js'),
      import('../../captcha/captcha.settings.js'),
      import('../../../auth/auth.module.js'),
      import('../../2fa/2fa.module.js'),
      import('./price-conversion.dboperation.js'),
    ]);
    assert.ok(moduleFile);
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleFile.PriceConversionModule) as readonly unknown[];
    assert.ok(imports.includes(auth.AuthModule));
    assert.equal(imports.includes(twoFactor.TwoFactorModule), false);
    const app = await testing.Test.createTestingModule({
      imports: [db.DbModule, redis.RedisModule, mail.MailModule, captcha.CaptchaModule, moduleFile.PriceConversionModule],
    })
      .overrideProvider(db.PrismaService).useValue({})
      .overrideProvider(redis.RedisService).useValue({})
      .overrideProvider(redis.DurableRedisService).useValue({})
      .overrideProvider(otpQueue.OtpQueueService).useValue({})
      .overrideProvider(captchaSettings.CaptchaSettingsService).useValue({})
      .compile();
    await app.init();
    const pool = app.get<pg.Pool>(operation.PRICE_CONVERSION_DATABASE);
    assert.equal(Number((await pool.query('SELECT 1 AS ok')).rows[0]?.ok), 1);

    await app.close();

    await assert.rejects(() => pool.query('SELECT 1'), /Cannot use a pool after calling end/);
  });
});
