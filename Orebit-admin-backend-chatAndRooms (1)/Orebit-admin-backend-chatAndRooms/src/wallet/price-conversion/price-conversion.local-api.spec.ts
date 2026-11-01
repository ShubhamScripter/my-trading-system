import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ELEVATION } from '../../../auth/auth.constants.js';
import { AdminDbOperation } from '../../../auth/persistence/admin.dboperation.js';
import { BffSessionService } from '../../../auth/security/bff.session.js';
import { AuthGuard, SuperAdminGuard } from '../../../auth/security/guards.js';
import { signAccessToken } from '../../../auth/security/jwt.js';
import { SessionService } from '../../../auth/services/session.service.js';
import { ElevationGuard, ElevationService } from '../../2fa/elevation.js';
import { ERR } from '../../contracts.js';
import { ProblemException, ProblemJsonFilter } from '../../http.js';
import { PriceConfigurationValidationError } from './price-conversion.errors.js';
import { PriceConversionExceptionFilter } from './price-conversion.filter.js';
import {
  PriceConversionRoutes,
} from './price-conversion.routes.js';
import { PRICE_CONVERSION_STORE, PriceConversionService } from './price-conversion.service.js';
import type {
  PriceConversionAuditContext, PriceConversionBootstrap,
  PriceConversionBootstrapQuery, PriceConversionHistoryPage,
  PriceConversionHistoryQuery, PriceConversionPatch, PriceConversionStore,
  PriceConversionPricePage, PriceConversionPriceQuery,
  PriceConversionUpdateResult,
} from './price-conversion.types.js';
import { adminPriceApiFixture } from './fixtures/admin-price-api.fixture.js';

type PrincipalFixture = {
  readonly adminId: string;
  readonly sessionId: string;
  readonly role: 'ADMIN' | 'SUPER_ADMIN';
};
type SuccessfulPatchFixture = {
  readonly body: PriceConversionPatch;
  readonly revision: number;
};
type Fixture = {
  readonly request: {
    readonly path: string;
    readonly requestId: string;
    readonly ipAddress: string;
    readonly userAgent: string;
    readonly acceptLanguage: string;
    readonly deviceId: string;
    readonly elevationTicket: string;
    readonly invalidCursor: string;
    readonly invalidLimit: number;
    readonly historyLimit: number;
    readonly superAdmin: PrincipalFixture;
    readonly admin: PrincipalFixture;
  };
  readonly bootstrap: PriceConversionBootstrap;
  readonly patches: {
    readonly push: SuccessfulPatchFixture;
    readonly draft: SuccessfulPatchFixture;
    readonly schedule: SuccessfulPatchFixture;
    readonly validationInvalid: { readonly body: unknown };
    readonly configurationInvalid: { readonly body: PriceConversionPatch; readonly detail: string };
    readonly conflict: { readonly body: PriceConversionPatch; readonly actualRevision: number };
  };
  readonly history: PriceConversionHistoryPage;
};

const fixture: Fixture = adminPriceApiFixture;

/** Fixture-backed store is the only persistence boundary used by this local server. */
class FixtureStore implements PriceConversionStore {
  readonly bootstrapInputs: PriceConversionBootstrapQuery[] = [];
  readonly historyInputs: PriceConversionHistoryQuery[] = [];
  readonly priceInputs: PriceConversionPriceQuery[] = [];
  readonly updates: Array<readonly [PriceConversionPatch, PriceConversionAuditContext]> = [];

  async bootstrap(input: PriceConversionBootstrapQuery): Promise<PriceConversionBootstrap> {
    this.bootstrapInputs.push(input);
    return fixture.bootstrap;
  }

  async updateAtomically(
    input: PriceConversionPatch,
    audit: PriceConversionAuditContext,
  ): Promise<PriceConversionUpdateResult> {
    this.updates.push([input, audit]);
    if (input.reason === fixture.patches.configurationInvalid.body.reason) {
      throw new PriceConfigurationValidationError(fixture.patches.configurationInvalid.detail);
    }
    if (input.reason === fixture.patches.conflict.body.reason) {
      return { kind: 'revision_conflict', actualRevision: fixture.patches.conflict.actualRevision };
    }
    const match = [fixture.patches.push, fixture.patches.draft, fixture.patches.schedule]
      .find((entry) => entry.body.action === input.action && entry.body.reason === input.reason);
    if (match === undefined) throw new Error('Unexpected local API PATCH fixture');
    return { kind: 'updated', revision: match.revision };
  }

  async history(input: PriceConversionHistoryQuery): Promise<PriceConversionHistoryPage> {
    this.historyInputs.push(input);
    return fixture.history;
  }

  async prices(input: PriceConversionPriceQuery): Promise<PriceConversionPricePage> {
    this.priceInputs.push(input);
    return { items: [], nextCursor: null };
  }
}

type AuthKey = 'superAdmin' | 'admin' | 'demoted' | 'inactive';
type LocalApi = {
  readonly baseUrl: string;
  readonly store: FixtureStore;
  readonly tokens: Readonly<Record<AuthKey, string>>;
  close(): Promise<void>;
};

/** Starts the actual Nest/Fastify route stack with only approved boundaries replaced. */
async function startLocalApi(): Promise<LocalApi> {
  const store = new FixtureStore();
  const principals: Readonly<Record<AuthKey, PrincipalFixture>> = {
    superAdmin: fixture.request.superAdmin,
    admin: fixture.request.admin,
    demoted: { ...fixture.request.admin, role: 'SUPER_ADMIN' },
    inactive: {
      adminId: '01930000-0000-7000-8000-000000000090',
      sessionId: '01930000-0000-7000-8000-000000000091',
      role: 'SUPER_ADMIN',
    },
  };
  const sessions = {
    async assertLive(sessionId: string): Promise<void> {
      if (!Object.values(principals).some((principal) => principal.sessionId === sessionId)) {
        throw new ProblemException({ type: ERR.SESSION_REVOKED });
      }
    },
    async touch(): Promise<void> {},
  };
  const admins = {
    async findById(adminId: string): Promise<Record<string, unknown> | null> {
      if (adminId === principals.inactive.adminId) {
        return { id: adminId, status: 'DISABLED', role: 'SUPER_ADMIN' };
      }
      if (adminId === principals.superAdmin.adminId) {
        return { id: adminId, status: 'ACTIVE', role: 'SUPER_ADMIN' };
      }
      if (adminId === principals.admin.adminId) {
        return { id: adminId, status: 'ACTIVE', role: 'ADMIN' };
      }
      return null;
    },
  };
  const wrongActionTicket = `${fixture.request.elevationTicket}.wrong-action`;
  const elevation = {
    async spend(ticket: string | null, sessionId: string, action: string): Promise<void> {
      const grantedAction = ticket === fixture.request.elevationTicket
        ? 'wallet.price-conversion.configure'
        : ticket === wrongActionTicket ? 'wallet.price-conversion.other' : null;
      if (sessionId !== fixture.request.superAdmin.sessionId || grantedAction !== action) {
        throw new ProblemException({ type: ERR.REAUTH_REQUIRED });
      }
    },
  };
  const reflector = new Reflector();
  const authGuard = new AuthGuard(
    sessions as never,
    { resolve: async () => null } as never,
    reflector,
  );
  const superAdminGuard = new SuperAdminGuard(admins as never);
  const elevationGuard = new ElevationGuard(elevation as never, reflector);
  Reflect.defineMetadata('design:paramtypes', [PriceConversionService], PriceConversionRoutes);
  const moduleRef = await Test.createTestingModule({
    controllers: [PriceConversionRoutes],
    providers: [
      PriceConversionService,
      { provide: PRICE_CONVERSION_STORE, useValue: store },
      { provide: AdminDbOperation, useValue: admins },
      { provide: SuperAdminGuard, useValue: superAdminGuard },
      PriceConversionExceptionFilter,
      { provide: Reflector, useValue: reflector },
      { provide: SessionService, useValue: sessions },
      { provide: BffSessionService, useValue: { resolve: async () => null } },
      { provide: AuthGuard, useValue: authGuard },
      { provide: APP_GUARD, useExisting: AuthGuard },
      ElevationGuard,
      { provide: ElevationService, useValue: elevation },
    ],
  })
    .overrideGuard(SuperAdminGuard).useValue(superAdminGuard)
    .overrideGuard(ElevationGuard).useValue(elevationGuard)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: 64 * 1024,
      genReqId: () => fixture.request.requestId,
    }),
    { logger: false },
  );
  app.useGlobalFilters(new ProblemJsonFilter());
  await app.init();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.getHttpServer().address() as AddressInfo;
  const tokens = Object.fromEntries((Object.keys(principals) as AuthKey[]).map((key) => [
    key,
    signAccessToken({
      ...principals[key],
      ceilingAt: new Date(Date.now() + 60 * 60 * 1000),
    }).token,
  ])) as Readonly<Record<AuthKey, string>>;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    tokens,
    close: () => app.close(),
  };
}

type CallOptions = {
  readonly method?: 'GET' | 'PATCH';
  readonly auth?: AuthKey | null;
  readonly elevated?: boolean | 'wrong-action';
  readonly body?: unknown;
};

/** Sends one real localhost request with deterministic fixture headers. */
async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const auth = options.auth === undefined ? 'superAdmin' : options.auth;
  const headers: Record<string, string> = {
    'user-agent': fixture.request.userAgent,
    'accept-language': fixture.request.acceptLanguage,
    'x-forwarded-for': fixture.request.ipAddress,
  };
  if (auth !== null) headers.authorization = `Bearer ${api.tokens[auth]}`;
  if (options.elevated !== undefined && options.elevated !== false) {
    headers[ELEVATION.HEADER_NAME] = options.elevated === 'wrong-action'
      ? `${fixture.request.elevationTicket}.wrong-action`
      : fixture.request.elevationTicket;
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${api.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function expectSuccess<T>(response: Response, data: T): Promise<T> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  const body = await response.json() as { readonly data: T };
  assert.deepEqual(body, { data });
  return body.data;
}

async function expectProblem(
  response: Response,
  status: number,
  type: string,
): Promise<Record<string, unknown>> {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /^application\/problem\+json/);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.type, type);
  assert.equal(body.status, status);
  assert.equal(body.requestId, fixture.request.requestId);
  return body;
}

let api: LocalApi;
before(async () => { api = await startLocalApi(); });
after(async () => { await api.close(); });

test('GET bootstrap returns the exact success envelope through HTTP', async () => {
  const bootstrap = await expectSuccess(await call(fixture.request.path), fixture.bootstrap);
  assert.equal(bootstrap.fiatOptions.length, 45);
  assert.equal(bootstrap.roleConfigurationStatus, 'HEALTHY');
  assert.equal(bootstrap.securityState, 'DEGRADED');
  assert.equal('latestEffectivePrices' in bootstrap, false);
  assert.equal('displayFiats' in bootstrap, false);
  assert.equal('providerStatus' in bootstrap, false);
  assert.deepEqual(api.store.bootstrapInputs.at(-1), { scheduledLimit: 50 });
});

test('GET bootstrap rejects obsolete pagination fields, missing auth, and the ADMIN role', async () => {
  const cursor = Buffer.from(JSON.stringify([
    'BTC', '01920000-0000-7000-8000-000000000001',
  ])).toString('base64url');
  await expectProblem(await call(
    `${fixture.request.path}?cursor=${cursor}`,
  ), 400, ERR.VALIDATION_FAILED);
  await expectProblem(await call(
    `${fixture.request.path}?limit=2`,
  ), 400, ERR.VALIDATION_FAILED);
  await expectProblem(await call(fixture.request.path, { auth: null }), 401, ERR.UNAUTHENTICATED);
  await expectProblem(await call(fixture.request.path, { auth: 'admin' }), 403, ERR.FORBIDDEN);
});

test('PATCH PUSH, SAVE_DRAFT, and SCHEDULE pass DTO/service and preserve audit context', async () => {
  for (const entry of [fixture.patches.push, fixture.patches.draft, fixture.patches.schedule]) {
    await expectSuccess(await call(fixture.request.path, {
      method: 'PATCH', elevated: true, body: entry.body,
    }), { revision: entry.revision });
  }
  const pushed = api.store.updates.find(([input]) => input.reason === fixture.patches.push.body.reason);
  assert.ok(pushed);
  assert.deepEqual(pushed, [fixture.patches.push.body, {
    actorId: fixture.request.superAdmin.adminId,
    sessionId: fixture.request.superAdmin.sessionId,
    requestId: fixture.request.requestId,
    ipAddress: fixture.request.ipAddress,
    deviceId: fixture.request.deviceId,
  }]);
});

test('PATCH maps DTO and domain configuration failures to stable 400 problems', async () => {
  await expectProblem(await call(fixture.request.path, {
    method: 'PATCH', elevated: true, body: fixture.patches.validationInvalid.body,
  }), 400, ERR.VALIDATION_FAILED);
  const invalid = await expectProblem(await call(fixture.request.path, {
    method: 'PATCH', elevated: true, body: fixture.patches.configurationInvalid.body,
  }), 400, 'price_configuration_invalid');
  assert.equal(invalid.detail, fixture.patches.configurationInvalid.detail);
});

test('PATCH requires auth and role but no elevation, and rejects stale revision', async () => {
  await expectProblem(await call(fixture.request.path, {
    method: 'PATCH', auth: null, body: fixture.patches.push.body,
  }), 401, ERR.UNAUTHENTICATED);
  await expectProblem(await call(fixture.request.path, {
    method: 'PATCH', auth: 'admin', elevated: true, body: fixture.patches.push.body,
  }), 403, ERR.FORBIDDEN);
  await expectProblem(await call(fixture.request.path, {
    method: 'PATCH', auth: 'demoted', elevated: true, body: fixture.patches.push.body,
  }), 403, ERR.FORBIDDEN);
  await expectProblem(await call(fixture.request.path, {
    method: 'PATCH', auth: 'inactive', elevated: true, body: fixture.patches.push.body,
  }), 401, ERR.UNAUTHENTICATED);
  assert.equal((await call(fixture.request.path, {
    method: 'PATCH', body: fixture.patches.push.body,
  })).status, 200);
  const conflict = await expectProblem(await call(fixture.request.path, {
    method: 'PATCH', elevated: true, body: fixture.patches.conflict.body,
  }), 409, 'price_configuration_conflict');
  assert.deepEqual(conflict.extra, { actualRevision: fixture.patches.conflict.actualRevision });
});

test('GET history returns all five union kinds in the success envelope', async () => {
  const cursor = Buffer.from(JSON.stringify([
    '2026-08-31T00:00:00.000000Z', '01920000-0000-7000-8000-000000000001',
    '["history",null,null,null,null,null,null,"timestamp","desc"]',
  ])).toString('base64url');
  const path = `${fixture.request.path}/history?limit=${fixture.request.historyLimit}&cursor=${cursor}`;
  await expectSuccess(await call(path), fixture.history);
  assert.deepEqual(fixture.history.items.map((item) => item.kind), [
    'RESOLUTION', 'VIEW_RESOLUTION', 'FETCH_RUN', 'CONFIG_CHANGE', 'AUDIT',
  ]);
  assert.deepEqual(api.store.historyInputs.at(-1), {
    limit: fixture.request.historyLimit, cursor, sortBy: 'timestamp', sortDirection: 'desc',
  });
});

test('GET prices uses its independently bounded strict query contract', async () => {
  await expectSuccess(await call(`${fixture.request.path}/prices?providerCode=COINGECKO&limit=10`), {
    items: [], nextCursor: null,
  });
  assert.deepEqual(api.store.priceInputs.at(-1), {
    providerCode: 'COINGECKO', limit: 10, sortBy: 'currencyId', sortDirection: 'asc',
  });
  await expectProblem(await call(`${fixture.request.path}/prices?sortBy=raw_sql`),
    400, ERR.VALIDATION_FAILED);
});

test('GET history rejects bad query, missing auth, and the ADMIN role', async () => {
  const path = `${fixture.request.path}/history`;
  await expectProblem(await call(
    `${path}?cursor=${encodeURIComponent(fixture.request.invalidCursor)}`,
  ), 400, ERR.VALIDATION_FAILED);
  await expectProblem(await call(`${path}?limit=${fixture.request.invalidLimit}`),
    400, ERR.VALIDATION_FAILED);
  await expectProblem(await call(path, { auth: null }), 401, ERR.UNAUTHENTICATED);
  await expectProblem(await call(path, { auth: 'admin' }), 403, ERR.FORBIDDEN);
});
