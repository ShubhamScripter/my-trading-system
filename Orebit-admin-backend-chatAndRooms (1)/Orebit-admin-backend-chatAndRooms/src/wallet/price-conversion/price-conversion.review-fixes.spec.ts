import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { ProblemException } from '../../http.js';
import { PriceConfigurationValidationError } from './price-conversion.errors.js';
import { PriceConversionPriceRepository } from './price-conversion.price-repository.js';
import { encodeBoundCursor, encodeHistoryCursor, historyCursorContext,
  priceCursorContext } from './price-conversion.cursor.js';
import { parsePersistedPriceConfiguration } from './price-conversion.policy.js';
import type { PriceConversionAuditContext } from './price-conversion.types.js';

const AUDIT: PriceConversionAuditContext = {
  actorId: '01920000-0000-7000-8000-000000000010',
  sessionId: 'session-11',
  requestId: '01920000-0000-7000-8000-000000000012',
  ipAddress: '203.0.113.8',
  deviceId: 'device-13',
};
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

describe('final admin price-conversion review fixes', () => {
  it('applies the shared verified-Bearer guard to the whole Pricing controller', async () => {
    const routes = await import('./price-conversion.routes.js');
    const { WalletAdminBearerGuard } = await import('../core/wallet-admin-bearer.guard.js');
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, routes.PriceConversionRoutes), [
      WalletAdminBearerGuard,
    ]);
  });

  it('uses the canonical current-admin guard and an action-bound elevation ticket', async () => {
    const routes = await import('./price-conversion.routes.js');
    const { ELEVATION_ACTION } = await import('../../2fa/elevation.js');
    const { AuthGuard, SuperAdminGuard } = await import('../../../auth/security/guards.js');
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      routes.PriceConversionRoutes.prototype.bootstrap,
    ) as readonly unknown[];
    assert.deepEqual(guards, [SuperAdminGuard]);
    assert.equal(
      Reflect.getMetadata(ELEVATION_ACTION, routes.PriceConversionRoutes.prototype.update),
      'wallet.price-conversion.configure',
    );

    const { signAccessToken } = await import('../../../auth/security/jwt.js');
    const auth = new AuthGuard(
      LIVE_SESSION as never,
      BEARER_ONLY_BFF as never,
      new (await import('@nestjs/core')).Reflector(),
    );
    for (const [stored, expected] of [
      [{ status: 'ACTIVE', role: 'SUPER_ADMIN' }, true],
      [{ status: 'ACTIVE', role: 'ADMIN' }, 'forbidden'],
      [{ status: 'DISABLED', role: 'SUPER_ADMIN' }, 'unauthenticated'],
    ] as const) {
      const token = signAccessToken({
        adminId: AUDIT.actorId,
        sessionId: '01920000-0000-7000-8000-000000000011',
        role: 'SUPER_ADMIN',
        ceilingAt: AUTH_CEILING_AT,
      }).token;
      const context = httpContext({ headers: { authorization: `Bearer ${token}` } });
      await auth.canActivate(context);
      const guard = new SuperAdminGuard({ findById: async () => stored } as never);
      if (expected === true) assert.equal(await guard.canActivate(context), true);
      else await assert.rejects(() => guard.canActivate(context), (error: unknown) =>
        error instanceof ProblemException && error.type === expected,
      );
    }
  });

  it('rejects Wallet-owned currency data at DTO and stored-draft boundaries', async () => {
    const { priceConversionPatchSchema } = await import('./price-conversion.dto.js');
    const result = priceConversionPatchSchema.safeParse({
      action: 'PUSH', expectedRevision: 0, reason: 'Activate BTC.', changelog: 'BTC active.',
      currencies: [],
    });
    assert.equal(result.success, false);
    assert.throws(() => parsePersistedPriceConfiguration({
      settings: { divergenceThresholdBps: 125 },
      providers: {
        COINGECKO: { enabled: true, sensitiveRole: 'PRIMARY', viewEnabled: true },
        ALCHEMY: { enabled: true, sensitiveRole: 'COMPARISON', viewEnabled: false },
        COINMARKETCAP: { enabled: true, sensitiveRole: 'FALLBACK', viewEnabled: false },
      },
      currencyUpserts: [],
    }), (error: unknown) => error instanceof PriceConfigurationValidationError && error.status === 400);
  });

  it('returns transport validation as the shared RFC 9457-compatible 400 instead of a 500', async () => {
    const { PriceConversionRoutes } = await import('./price-conversion.routes.js');
    const routes = new PriceConversionRoutes({
      bootstrap: async () => { throw new Error('service must not receive invalid DTO'); },
    } as never);
    await assert.rejects(
      () => routes.bootstrap({ limit: '2' }),
      (error: unknown) => error instanceof ProblemException && error.status === 400,
    );
  });

  it('exposes a separately bounded latest-prices query with strict controls', async () => {
    const { PriceConversionRoutes } = await import('./price-conversion.routes.js');
    const inputs: unknown[] = [];
    const routes = new PriceConversionRoutes({
      prices: async (input: unknown) => {
        inputs.push(input);
        return { items: [], nextCursor: null };
      },
    } as never);

    assert.deepEqual(await routes.prices({ providerCode: 'COINGECKO', limit: '10' }), {
      data: { items: [], nextCursor: null },
    });
    assert.deepEqual(inputs, [{
      providerCode: 'COINGECKO', limit: 10, sortBy: 'currencyId', sortDirection: 'asc',
    }]);
    await assert.rejects(
      () => routes.prices({ sortBy: 'raw SQL', limit: '101' }),
      (error: unknown) => error instanceof ProblemException && error.status === 400,
    );
  });

  it('pages latest priceUsd records with stable sort and query-bound cursors', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const rows = [
      { id: '01920000-0000-7000-8000-000000000221', currencyId: '01920000-0000-7000-8000-000000000101',
        priceUsd: '1.25', observedAt: '2026-09-10T07:59:00Z', updatedAt: '2026-09-10T08:00:00Z',
        provider: 'COINGECKO', snapshotId: '01920000-0000-7000-8000-000000000311',
        stale: false, disabled: false, reason: 'PRIMARY_CONFIRMED' },
      { id: '01920000-0000-7000-8000-000000000222', currencyId: '01920000-0000-7000-8000-000000000102',
        priceUsd: null, observedAt: null, updatedAt: '2026-09-10T08:01:00Z', provider: null,
        snapshotId: null, stale: true, disabled: true, reason: 'PRICE_UNAVAILABLE' },
    ];
    const repository = new PriceConversionPriceRepository({ priceConversionSchema: 'price_conversion_test',
      query: async (sql: string, values: readonly unknown[] = []) => { calls.push({ sql, values }); return { rows }; } } as never);
    const query = { currencyId: rows[0]!.currencyId, providerCode: 'COINGECKO' as const,
      status: 'ACTIVE' as const, sortBy: 'currencyId' as const, sortDirection: 'asc' as const, limit: 1 };
    const first = await repository.prices(query);
    assert.match(calls[0]?.sql ?? '', /ORDER BY currency_id ASC, id ASC/);
    assert.match(calls[0]?.sql ?? '', /ORDER BY r\.currency_id, r\.created_at DESC, r\.id DESC\s+\) SELECT[\s\S]+FROM latest WHERE currency_id = \$1::uuid AND provider = \$2 AND pricing_status = \$3/);
    assert.deepEqual(calls[0]?.values, [query.currencyId, 'COINGECKO', 'ACTIVE', 2]);
    assert.equal(first.items[0]?.priceUsd, '1.25');
    assert.ok(first.nextCursor);
    const cursor = first.nextCursor ?? undefined;
    await repository.prices({ ...query, cursor });
    await assert.rejects(() => repository.prices({ ...query, status: 'DISABLED',
      cursor }), /cursor does not match query/i);
  });

  it('strictly validates Pricing history filters, UTC bounds, and cursor context', async () => {
    const { priceConversionHistoryQuerySchema, priceConversionPriceQuerySchema } =
      await import('./price-conversion.dto.js');
    const query = {
      eventType: 'RESOLUTION' as const,
      currencyId: '01920000-0000-7000-8000-000000000101',
      providerCode: 'COINGECKO' as const,
      from: '2026-09-10T00:00:00.000Z', to: '2026-09-11T00:00:00.000Z',
      sortBy: 'timestamp' as const, sortDirection: 'desc' as const,
    };
    const cursor = encodeHistoryCursor([
      '2026-09-10T08:00:00.000000Z',
      '01920000-0000-7000-8000-000000000211',
      historyCursorContext(query),
    ]);
    assert.equal(priceConversionHistoryQuerySchema.safeParse({ ...query, cursor }).success, true);
    assert.equal(priceConversionHistoryQuerySchema.safeParse({ ...query, cursor,
      providerCode: 'ALCHEMY' }).success, false);
    assert.equal(priceConversionHistoryQuerySchema.safeParse({ ...query,
      from: query.to, to: query.from }).success, false);
    assert.equal(priceConversionHistoryQuerySchema.safeParse({ ...query, rawSql: 'created_at' }).success, false);
    const priceQuery = { sortBy: 'currencyId' as const, sortDirection: 'asc' as const };
    const invalidSortCursor = encodeBoundCursor([
      'not-a-uuid', '01920000-0000-7000-8000-000000000211', priceCursorContext(priceQuery),
    ]);
    assert.equal(priceConversionPriceQuerySchema.safeParse({ ...priceQuery,
      cursor: invalidSortCursor }).success, false);
  });
});
