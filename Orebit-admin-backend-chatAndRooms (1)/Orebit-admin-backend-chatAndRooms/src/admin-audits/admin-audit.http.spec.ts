import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import 'reflect-metadata';

import '../../tests/setup.js';
import { AuthGuard } from '../../auth/security/guards.js';
import { signAccessToken } from '../../auth/security/jwt.js';
import { ERR } from '../contracts.js';
import { ProblemException } from '../http.js';
import { encodeAdminAuditCursor } from './admin-audit.cursor.js';
import { AdminAuditDatabase } from './admin-audit.database.js';
import { adminAuditHistoryQuerySchema } from './admin-audit.dto.js';
import { AdminAuditHistoryModule } from './admin-audit.history.module.js';
import { AdminAuditHistoryRepository } from './admin-audit.history-repository.js';
import { AdminAuditHistoryService } from './admin-audit.history.service.js';
import { AdminAuditRoutes, AdminAuditSuperAdminGuard } from './admin-audit.routes.js';
import {
  DEPOSIT_ADMIN_AUDIT_ACTIONS,
  WALLET_CORE_ADMIN_AUDIT_ACTIONS,
  type AdminAuditHistoryQuery,
} from './admin-audit.types.js';

const UUID_V7 = '01920000-0000-7000-8000-000000000001';
const UUID_V4 = '550e8400-e29b-41d4-a716-446655440000';

function routesOf(controller: new (...args: never[]) => unknown): string[] {
  const prefix = (Reflect.getMetadata('path', controller) as string | undefined) ?? '';
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = proto[name];
      if (typeof handler !== 'function') return [];
      const path = Reflect.getMetadata('path', handler) as string | undefined;
      const method = Reflect.getMetadata('method', handler) as number | undefined;
      if (path === undefined || method === undefined) return [];
      const verb = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'][method] ?? String(method);
      const full = `/${[prefix, path].filter((part) => part !== '' && part !== '/').join('/')}`;
      return [`${verb} ${full}`];
    })
    .sort();
}

function httpContext(request: unknown): never {
  return {
    getClass: () => AdminAuditRoutes,
    getHandler: () => AdminAuditRoutes.prototype.history,
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('admin audit history HTTP query', () => {
  it('defaults and bounds the limit and accepts only the closed domains and actions', () => {
    assert.deepEqual(adminAuditHistoryQuerySchema.parse({}), { limit: 50 });
    assert.deepEqual(adminAuditHistoryQuerySchema.parse({ limit: '100' }), { limit: 100 });
    for (const domain of ['WALLET_CORE', 'DEPOSIT']) {
      assert.deepEqual(adminAuditHistoryQuerySchema.parse({ domain }), { domain, limit: 50 });
    }
    for (const action of new Set([
      ...WALLET_CORE_ADMIN_AUDIT_ACTIONS,
      ...DEPOSIT_ADMIN_AUDIT_ACTIONS,
    ])) {
      assert.equal(adminAuditHistoryQuerySchema.parse({ action }).action, action);
    }
    for (const query of [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 },
      { domain: 'OTHER' }, { action: 'UNKNOWN.ACTION' }, { extra: true },
    ]) assert.throws(() => adminAuditHistoryQuerySchema.parse(query));
  });

  it('requires UUIDv7, paired subjects, ordered canonical UTC bounds, and a canonical cursor', () => {
    const cursor = encodeAdminAuditCursor('2026-09-03T12:00:00.123456Z', UUID_V7);
    assert.deepEqual(adminAuditHistoryQuerySchema.parse({
      actorId: UUID_V7.toUpperCase(), runId: UUID_V7,
      subjectType: 'DEPOSIT', subjectId: UUID_V7,
      from: '2026-09-03T10:00:00.000001Z',
      to: '2026-09-03T11:00:00.000001Z', cursor,
    }), {
      actorId: UUID_V7, runId: UUID_V7,
      subjectType: 'DEPOSIT', subjectId: UUID_V7,
      from: '2026-09-03T10:00:00.000001Z',
      to: '2026-09-03T11:00:00.000001Z', cursor, limit: 50,
    });
    for (const query of [
      { actorId: UUID_V4 }, { runId: 'not-a-uuid' },
      { subjectType: 'DEPOSIT' }, { subjectId: UUID_V7 },
      { subjectType: 'deposit', subjectId: UUID_V7 },
      { subjectType: 'DEPOSIT', subjectId: ` ${UUID_V7}` },
      { from: '2026-09-03T10:00:00.000Z' },
      { from: '2026-09-03T10:00:00.000001Z', to: '2026-09-03T10:00:00.000001Z' },
      { from: '2026-09-03T11:00:00.000001Z', to: '2026-09-03T10:00:00.000001Z' },
      { cursor: cursor + '=' },
    ]) assert.throws(() => adminAuditHistoryQuerySchema.parse(query));
  });
});

describe('admin audit history route', () => {
  it('declares one GET route, one local guard, and returns the parsed service page in an envelope', async () => {
    let received: AdminAuditHistoryQuery | undefined;
    const route = new AdminAuditRoutes({
      async history(query: AdminAuditHistoryQuery) {
        received = query;
        return { items: [], nextCursor: null };
      },
    } as never);

    assert.deepEqual(routesOf(AdminAuditRoutes), ['GET /v1/admin/audits']);
    assert.deepEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminAuditRoutes.prototype.history),
      [AdminAuditSuperAdminGuard],
    );
    assert.deepEqual(await route.history({ domain: 'DEPOSIT', limit: '25' }), {
      data: { items: [], nextCursor: null },
    });
    assert.deepEqual(received, { domain: 'DEPOSIT', limit: 25 });
    await assert.rejects(
      () => route.history({ limit: '25', extra: true }),
      (error: unknown) => error instanceof ProblemException && error.type === ERR.VALIDATION_FAILED,
    );
  });

  it('relies on AuthGuard for authentication and permits only SUPER_ADMIN locally', async () => {
    const auth = new AuthGuard({ assertLive: async () => undefined } as never, new Reflector());
    const local = new AdminAuditSuperAdminGuard();

    await assert.rejects(
      () => auth.canActivate(httpContext({ headers: {} })),
      (error: unknown) => error instanceof ProblemException && error.type === ERR.UNAUTHENTICATED,
    );
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      const token = signAccessToken({
        adminId: '01920000-0000-7000-8000-000000000010',
        sessionId: '01920000-0000-7000-8000-000000000011',
        role,
      }).token;
      const context = httpContext({ headers: { authorization: `Bearer ${token}` } });
      assert.equal(await auth.canActivate(context), true);
      if (role === 'SUPER_ADMIN') assert.equal(local.canActivate(context), true);
      else assert.throws(
        () => local.canActivate(context),
        (error: unknown) => error instanceof ProblemException && error.type === ERR.FORBIDDEN,
      );
    }
  });
});

describe('admin audit history module isolation', () => {
  it('contains only reader providers and remains absent from the root module', async () => {
    assert.deepEqual(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminAuditHistoryModule), [
      AdminAuditRoutes,
    ]);
    assert.deepEqual(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminAuditHistoryModule), [
      AdminAuditDatabase,
      AdminAuditHistoryRepository,
      AdminAuditHistoryService,
      AdminAuditSuperAdminGuard,
    ]);
    assert.deepEqual(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminAuditHistoryModule) ?? [], []);
    assert.deepEqual(Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminAuditHistoryModule) ?? [], []);

    const rootSource = readFileSync(resolve(__dirname, '../app.module.ts'), 'utf8');
    assert.doesNotMatch(rootSource, /AdminAudit(?:History|Writer)Module/);

    const moduleRef = await Test.createTestingModule({ imports: [AdminAuditHistoryModule] })
      .overrideProvider(AdminAuditDatabase)
      .useValue({ query: async () => ({ rows: [] }) })
      .compile();
    try {
      assert.ok(moduleRef.get(AdminAuditRoutes));
      assert.ok(moduleRef.get(AdminAuditHistoryService));
      assert.ok(moduleRef.get(AdminAuditHistoryRepository));
    } finally {
      await moduleRef.close();
    }
  });
});
