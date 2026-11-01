import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard, SuperAdminGuard } from '../../auth/security/guards';
import { AdminDbOperation } from '../../auth/auth.dboperation';
import { BffSessionService } from '../../auth/security/bff.session';
import { signAccessToken } from '../../auth/security/jwt';
import { SessionService } from '../../auth/services/session.service';
import { ElevationGuard, ElevationService } from '../../src/2fa/elevation';
import { ERR } from '../../src/contracts';
import { ProblemException, ProblemJsonFilter } from '../../src/http';
import { KycEntitlementController } from '../../src/kyc/kyc-entitlement.controller';
import { KycEntitlementRoutes } from '../../src/kyc/kyc-entitlement.routes';
import { KycEntitlementService } from '../../src/kyc/kyc-entitlement.service';
import { KycExemptionController } from '../../src/kyc/kyc-exemption.controller';
import { KycExemptionRoutes } from '../../src/kyc/kyc-exemption.routes';
import { KycExemptionService } from '../../src/kyc/kyc-exemption.service';
import { KycPolicyController } from '../../src/kyc/kyc-policy.controller';
import { KycPolicyRoutes } from '../../src/kyc/kyc-policy.routes';
import { KycHistoryRoutes } from '../../src/kyc/kyc-history.routes';
import { KycRenewalRoutes } from '../../src/kyc/kyc-renewal.routes';
import { KycPolicyService } from '../../src/kyc/kyc-policy.service';
import { KycRequirementController } from '../../src/kyc/kyc-requirement.controller';
import { KycRequirementRoutes } from '../../src/kyc/kyc-requirement.routes';
import { KycRequirementService } from '../../src/kyc/kyc-requirement.service';
import { makeAdmin } from '../harness';
import { VALID_ENTITLEMENTS, VALID_POLICY, VALID_UPGRADE } from './kyc.cases';

/**
 * Who may reach these routes, over a real Fastify instance with the REAL guards.
 *
 * ═══ THE GUARDS ARE THE POINT, SO THEY ARE NOT DOUBLED ═════════════════════
 *
 * `AuthGuard` and `SuperAdminGuard` are the genuine articles and the token is really
 * signed and really verified. What IS doubled is only what they read — the session
 * row, the admin row, the elevation ticket — so a test can decide "this caller is a
 * disabled ADMIN" without a database.
 *
 * The services are doubled too: what a write STORES is covered elsewhere. This file
 * asks only who gets through the door.
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

const policyService = {
  state: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  history: vi.fn(),
};
const exemptionService = { list: vi.fn(), grant: vi.fn(), revoke: vi.fn() };
const requirementService = { list: vi.fn(), require: vi.fn(), waive: vi.fn() };
const entitlementService = {
  read: vi.fn(),
  writeEntitlements: vi.fn(),
  writeUpgradeRequirement: vi.fn(),
};
const elevation = { spend: vi.fn() };
const admins = { findById: vi.fn() };
const sessions = { assertLive: vi.fn(), touch: vi.fn() };
const bff = { resolve: vi.fn() };

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [
      KycPolicyRoutes,
      KycExemptionRoutes,
      KycRequirementRoutes,
      KycEntitlementRoutes,
    ],
    providers: [
      KycPolicyController,
      KycExemptionController,
      KycRequirementController,
      KycEntitlementController,
      { provide: KycPolicyService, useValue: policyService },
      { provide: KycExemptionService, useValue: exemptionService },
      { provide: KycRequirementService, useValue: requirementService },
      { provide: KycEntitlementService, useValue: entitlementService },
      { provide: ElevationService, useValue: elevation },
      { provide: AdminDbOperation, useValue: admins },
      { provide: SessionService, useValue: sessions },
      { provide: BffSessionService, useValue: bff },
      AuthGuard,
      SuperAdminGuard,
      ElevationGuard,
      // Mirrors src/app.module.ts. Without it every route here would be
      // unauthenticated and the assertions below would prove nothing.
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
  sessions.assertLive.mockResolvedValue({ lastUsedAt: null, familyId: 'family-1' });
  bff.resolve.mockResolvedValue({ kind: 'absent' });
  admins.findById.mockResolvedValue(makeAdmin({ id: ADMIN_ID, role: 'SUPER_ADMIN' }));
  elevation.spend.mockResolvedValue(undefined);
  policyService.state.mockResolvedValue({ policies: [] });
  policyService.upsert.mockResolvedValue({ policies: [] });
  policyService.remove.mockResolvedValue({ policies: [] });
  policyService.history.mockResolvedValue({ versions: [] });
  exemptionService.list.mockResolvedValue({ exemptions: [] });
  exemptionService.grant.mockResolvedValue({ exemptions: [] });
  exemptionService.revoke.mockResolvedValue({ exemptions: [] });
  requirementService.list.mockResolvedValue({ requirements: [], levels: [] });
  requirementService.require.mockResolvedValue({ requirements: [], levels: [] });
  requirementService.waive.mockResolvedValue({ requirements: [], levels: [] });
  const emptyEntitlements = {
    entitlements: [],
    upgradeRequirements: [],
    levels: [],
    targetLevels: [],
    versionToCreate: 0,
  };
  entitlementService.read.mockResolvedValue(emptyEntitlements);
  entitlementService.writeEntitlements.mockResolvedValue(emptyEntitlements);
  entitlementService.writeUpgradeRequirement.mockResolvedValue(emptyEntitlements);
});

function inject(input: {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}) {
  return app.inject({
    method: input.method,
    url: input.url,
    headers: { 'content-type': 'application/json', ...(input.headers ?? {}) },
    ...(input.payload === undefined ? {} : { payload: input.payload as never }),
  });
}

const GRANT = {
  action: 'grant',
  userId: '0195f0a0-bbbb-7000-8000-000000000002',
  effectiveLevel: 'L1',
  reason: 'Sanctioned onboarding exception.',
  expiresAt: null,
};

const USER_ID = '0195f0a0-bbbb-7000-8000-000000000002';

const REQUIRE = {
  action: 'require',
  userId: USER_ID,
  requiredLevel: 'L1',
  reference: 'CASE-4182',
  reason: 'Sanctions review pending.',
};

const ROUTES = [
  { label: 'GET /kyc-policies', method: 'GET' as const, url: '/kyc-policies' },
  {
    label: 'GET /kyc-policies/history',
    method: 'GET' as const,
    url: '/kyc-policies/history?region=IN&level=L1',
  },
  { label: 'POST /kyc-policies', method: 'POST' as const, url: '/kyc-policies', payload: VALID_POLICY },
  { label: 'GET /kyc-exemptions', method: 'GET' as const, url: '/kyc-exemptions' },
  { label: 'POST /kyc-exemptions', method: 'POST' as const, url: '/kyc-exemptions', payload: GRANT },
  {
    label: 'GET /kyc-requirements',
    method: 'GET' as const,
    url: `/kyc-requirements?userId=${USER_ID}`,
  },
  {
    label: 'POST /kyc-requirements',
    method: 'POST' as const,
    url: '/kyc-requirements',
    payload: REQUIRE,
  },
  { label: 'GET /kyc-entitlements', method: 'GET' as const, url: '/kyc-entitlements' },
  {
    label: 'POST /kyc-entitlements (entitlements)',
    method: 'POST' as const,
    url: '/kyc-entitlements',
    payload: VALID_ENTITLEMENTS,
  },
  {
    label: 'POST /kyc-entitlements (upgrade)',
    method: 'POST' as const,
    url: '/kyc-entitlements',
    payload: VALID_UPGRADE,
  },
];

describe('no route is reachable without a credential', () => {
  it.each(ROUTES.map((r) => [r.label, r] as const))('%s refuses an anonymous caller', async (
    _label,
    route,
  ) => {
    const res = await inject(route);

    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(ERR.UNAUTHENTICATED);
  });

  it.each(ROUTES.map((r) => [r.label, r] as const))(
    '%s refuses a caller whose session is gone',
    async (_label, route) => {
      sessions.assertLive.mockRejectedValue(new ProblemException({ type: ERR.SESSION_REVOKED }));

      const res = await inject({ ...route, headers: { authorization: bearerFor('SUPER_ADMIN') } });

      expect(res.statusCode).toBe(401);
    },
  );
});

describe('no route is reachable by an ordinary admin', () => {
  it.each(ROUTES.map((r) => [r.label, r] as const))('%s refuses role ADMIN', async (
    _label,
    route,
  ) => {
    admins.findById.mockResolvedValue(makeAdmin({ id: ADMIN_ID, role: 'ADMIN' }));

    const res = await inject({ ...route, headers: { authorization: bearerFor('ADMIN') } });

    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe(ERR.FORBIDDEN);
  });

  /**
   * The claim in the token is NOT what decides.
   *
   * `SuperAdminGuard` re-reads the admin row, so a token minted while the caller was a
   * super admin stops working the moment they are demoted — rather than lasting the
   * fifteen minutes of its own lifetime.
   */
  it.each(ROUTES.map((r) => [r.label, r] as const))(
    '%s refuses a SUPER_ADMIN token whose row says otherwise',
    async (_label, route) => {
      admins.findById.mockResolvedValue(makeAdmin({ id: ADMIN_ID, role: 'ADMIN' }));

      const res = await inject({ ...route, headers: { authorization: bearerFor('SUPER_ADMIN') } });

      expect(res.statusCode).toBe(403);
    },
  );

  it.each(ROUTES.map((r) => [r.label, r] as const))(
    '%s refuses a super admin whose account has been disabled',
    async (_label, route) => {
      admins.findById.mockResolvedValue(
        makeAdmin({ id: ADMIN_ID, role: 'SUPER_ADMIN', status: 'DISABLED' }),
      );

      const res = await inject({ ...route, headers: { authorization: bearerFor('SUPER_ADMIN') } });

      expect(res.statusCode).toBe(401);
    },
  );
});

describe('a super admin is allowed through', () => {
  it.each(ROUTES.map((r) => [r.label, r] as const))('%s succeeds', async (_label, route) => {
    const res = await inject({ ...route, headers: { authorization: bearerFor('SUPER_ADMIN') } });

    expect([200, 201]).toContain(res.statusCode);
  });
});

/**
 * ═══ THE WRITES CARRY NO SECOND-FACTOR PROOF, BY DECISION ══════════════════
 *
 * `security-policies`, the module this one is modelled on, spends a single-use
 * elevation ticket on its write. These do not: applying the second factor to the KYC
 * surface is a later phase, and until then a valid SUPER_ADMIN session is the whole
 * credential.
 *
 * Asserted rather than left implicit, because "no elevation" and "elevation that
 * silently never runs" look identical from the outside, and only one of them is a
 * decision. When the later phase lands, these expectations invert — which is the
 * point: the change will be visible here rather than passing unnoticed.
 */
describe('writes are gated by role alone, for now', () => {
  it('lets a super admin write with no elevation ticket', async () => {
    const res = await inject({
      method: 'POST',
      url: '/kyc-policies',
      headers: { authorization: bearerFor('SUPER_ADMIN') },
      payload: VALID_POLICY,
    });

    expect(res.statusCode).toBe(201);
    expect(policyService.upsert).toHaveBeenCalled();
  });

  it('lets a super admin grant relief with no elevation ticket', async () => {
    // The sharper half of the same gap: a grant raises one account's effective KYC
    // level platform-wide, and right now a live super-admin session is enough.
    const res = await inject({
      method: 'POST',
      url: '/kyc-exemptions',
      headers: { authorization: bearerFor('SUPER_ADMIN') },
      payload: GRANT,
    });

    expect(res.statusCode).toBe(201);
    expect(exemptionService.grant).toHaveBeenCalled();
  });

  it('ignores an elevation ticket if one is sent anyway', async () => {
    // Nothing reads the header today, so a client that still sends one is neither
    // helped nor refused. Worth pinning so the header is not mistaken for a
    // requirement that is quietly failing open.
    const res = await inject({
      method: 'POST',
      url: '/kyc-policies',
      headers: {
        authorization: bearerFor('SUPER_ADMIN'),
        'x-elevation-ticket': 'not-a-real-ticket',
      },
      payload: VALID_POLICY,
    });

    expect(res.statusCode).toBe(201);
  });

  it('still refuses an ordinary admin, ticket or no ticket', async () => {
    // The role gate is what is left, so it had better be the one thing that holds.
    admins.findById.mockResolvedValue(makeAdmin({ id: ADMIN_ID, role: 'ADMIN' }));

    const res = await inject({
      method: 'POST',
      url: '/kyc-exemptions',
      headers: {
        authorization: bearerFor('SUPER_ADMIN'),
        'x-elevation-ticket': 'not-a-real-ticket',
      },
      payload: GRANT,
    });

    expect(res.statusCode).toBe(403);
    expect(exemptionService.grant).not.toHaveBeenCalled();
  });
});

/**
 * ═══ NO ELEVATION GUARD EITHER ═════════════════════════════════════════════
 *
 * Belt and braces here would be a bug, not caution. When the second factor is
 * re-applied, the ticket must be spent in the CONTROLLER — the action lives in a
 * union body, which a guard cannot read — and a `@UseGuards(ElevationGuard)` on top
 * of that would consume the single-use ticket first, leaving the controller's spend
 * to fail on every request.
 *
 * So this asserts the guard is absent today AND names why it must stay absent when
 * elevation returns. The symptom it prevents — a 403 on every write — reads as a
 * credential problem rather than a wiring one, which is exactly the kind of bug worth
 * a test nobody has to remember to write later.
 */
describe('guards on the KYC routes', () => {
  it.each([
    ['KycPolicyRoutes', KycPolicyRoutes],
    // The sharpest write on this surface: a mandatory renewal period set here
    // de-verifies every account whose verification predates it, in one request. It is
    // gated exactly like the other two today, and unlike them its body is NOT a union —
    // so if elevation is ever re-applied, this one CAN take `@UseGuards(ElevationGuard)`
    // on the route rather than a controller-side spend. See `KycRenewalController`.
    ['KycRenewalRoutes', KycRenewalRoutes],
    // Read-only, but gated identically — KYC history is sensitive personal data, and a
    // surface that returns it for any account is not a lesser target than one that
    // edits configuration.
    ['KycHistoryRoutes', KycHistoryRoutes],
    ['KycExemptionRoutes', KycExemptionRoutes],
    // The MIRROR of exemptions: this one IMPOSES an obligation rather than relieving
    // one. Gated identically, and deliberately no stricter — an obligation only ever
    // withholds standing, so it is the safer of the two per-account KYC writes.
    ['KycRequirementRoutes', KycRequirementRoutes],
    // The broadest of the CONFIGURATION surfaces: it decides what every account at a
    // level may do. It targets a rule and never an account — there is no `userId`
    // anywhere on it — and it cannot reach a verification, a level state or an upgrade
    // achievement. Gated identically, and its body IS a union, so a future elevation
    // ticket has to be spent in the controller rather than declared here.
    ['KycEntitlementRoutes', KycEntitlementRoutes],
  ] as const)('%s declares SuperAdminGuard and never ElevationGuard', (_name, controller) => {
    const proto = controller.prototype as object;

    for (const method of Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor')) {
      const guards =
        (Reflect.getMetadata(GUARDS_METADATA, (proto as Record<string, unknown>)[method] as object) as
          | unknown[]
          | undefined) ?? [];

      expect(guards, `${method} must be guarded`).toContain(SuperAdminGuard);
      expect(guards, `${method} must not wear ElevationGuard`).not.toContain(ElevationGuard);
    }
  });
});
