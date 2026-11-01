import { describe, expect, it } from 'vitest';
import { AuthRoutes } from '../auth/auth.routes';
import { TwoFactorRoutes } from '../src/2fa/2fa.routes';
import { AdminsRoutes } from '../src/admins/admins.routes';
import { CaptchaRoutes } from '../src/captcha/captcha.routes';
import { CountryRoutes } from '../src/country/country.routes';
import { KycEntitlementRoutes } from '../src/kyc/kyc-entitlement.routes';
import { KycExemptionRoutes } from '../src/kyc/kyc-exemption.routes';
import { KycPolicyRoutes } from '../src/kyc/kyc-policy.routes';
import { KycHistoryRoutes } from '../src/kyc/kyc-history.routes';
import { KycRenewalRoutes } from '../src/kyc/kyc-renewal.routes';
import { KycRequirementRoutes } from '../src/kyc/kyc-requirement.routes';
import { SecurityPolicyRoutes } from '../src/security-policies/security-policies.routes';
import { ChatRoutes } from '../src/social/chat/chat.routes';
import { AppRoutes, ROUTE_GROUPS } from '../src/app.routes';

/**
 * The API surface, asserted.
 *
 * The minimal-surface rule is a design constraint, not a preference: the whole
 * nine-step sign-in ceremony lives on ONE route, because a route per step would
 * mean nine places to get a guard right. A test is the only thing that keeps that
 * constraint from eroding one convenient endpoint at a time.
 *
 * Nest derives routing from decorator metadata, so this reads the same metadata
 * the router does rather than booting an HTTP server.
 */

/**
 * EVERY controller in the service, in one place.
 *
 * Listed once rather than at each assertion, and that is not tidiness: the list was
 * repeated three times and adding a module updated two of them, so the third — the
 * "nothing extra in ROUTE_GROUPS" check — reported a registry entry as orphaned when
 * it was the test that was out of date. One constant means adding a controller is
 * one edit here, and the two ROUTE_GROUPS directions cannot disagree about what
 * exists.
 */
const ALL_CONTROLLERS = [
  AuthRoutes,
  AppRoutes,
  TwoFactorRoutes,
  AdminsRoutes,
  CaptchaRoutes,
  SecurityPolicyRoutes,
  KycPolicyRoutes,
  KycRenewalRoutes,
  KycHistoryRoutes,
  KycExemptionRoutes,
  KycRequirementRoutes,
  KycEntitlementRoutes,
  CountryRoutes,
  ChatRoutes,
] as const;

/** Every (method, path) a controller class declares, read from Nest's metadata. */
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
      // Nest's RequestMethod enum: 0 GET, 1 POST, 2 PUT, 3 DELETE, 4 PATCH.
      const verb = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'][method] ?? String(method);
      const full = `/${[prefix, path].filter((p) => p !== '' && p !== '/').join('/')}`;
      return [`${verb} ${full}`];
    })
    .sort();
}

describe('the API surface', () => {
  /**
   * ═══ THE MINIMAL-SURFACE CONSTRAINT ════════════════════════════════════════
   *
   * FOUR auth routes. Not five, not nine.
   *
   * If this test fails because a route was added, the question to ask first is
   * whether the new endpoint carries a genuinely different CREDENTIAL or GUARD.
   * A new step of the sign-in ceremony does not — it belongs in the discriminated
   * union on POST /auth/login.
   *
   * `GET /auth/session` is the fourth, and it earns its place by that test rather
   * than by convenience: a standalone frontend cannot inspect an httpOnly cookie, so
   * establishing login state on load needs a request, and no existing route answers
   * it. `GET /auth/me` is the near miss — it needs the same credential — but it
   * reports an identity and this reports a LIFETIME, and it carries `@NotActivity()`
   * because it is polled. Folding the two would make every session check extend the
   * idle deadline it was asking about.
   */
  it('exposes exactly four auth routes', () => {
    expect(routesOf(AuthRoutes)).toEqual([
      'GET /auth/me',
      'GET /auth/session',
      'POST /auth/login',
      'POST /auth/session',
    ]);
  });

  /**
   * TWO 2FA routes, and the same question applies as above: the six mutations
   * (totp-add, totp-confirm, passkey-add-challenge, passkey-add-verify, remove,
   * rename) are variants of the union on POST /2fa, not endpoints of their own.
   *
   * These earn separate routes from POST /auth/login because they carry a
   * different CREDENTIAL — a bearer access token plus a password re-check, rather
   * than the step-up cookie. That is the test the rule actually asks.
   */
  it('exposes exactly two 2fa routes', () => {
    expect(routesOf(TwoFactorRoutes)).toEqual(['GET /2fa', 'POST /2fa']);
  });

  it('exposes exactly two unauthenticated probes', () => {
    expect(routesOf(AppRoutes)).toEqual(['GET /health', 'GET /readiness']);
  });

  /**
   * TWO admin-management routes: one that writes, one that reads.
   *
   * The same union-body rule as the routes above holds for the WRITE. `reset-factors`,
   * `disable`, `enable` and `resolve-login-review` all share one credential — bearer
   * plus a per-action elevation ticket — so they are variants of `POST /admins` rather
   * than four endpoints. A future action needing a DIFFERENT credential would earn its
   * own route; that is the test the rule asks, and it is why adding the fourth action
   * did not change this count.
   *
   * `GET /admins/login-reviews` is the exception, and it is the method that makes it
   * one rather than a preference. A read must be a GET so it is cacheable, linkable
   * and safe to retry — and a GET has no body for a discriminated union to switch on.
   * It also carries a strictly weaker credential (no elevation ticket, because it
   * changes nothing), which is the same rule pointing the same way.
   *
   * If this count grows again, the questions to ask are whether the new action can
   * touch another admin — the property this prefix exists to isolate — and whether it
   * genuinely needs a credential or a method the union cannot express.
   */
  it('exposes exactly two admin-management routes', () => {
    expect(routesOf(AdminsRoutes)).toEqual(['GET /admins/login-reviews', 'POST /admins']);
  });

  /**
   * THREE KYC policy routes: a list, a history read, and one union write.
   *
   * `upsert` and `delete` share a credential shape — bearer plus a per-action elevation
   * ticket — so they are variants of one POST rather than two endpoints, which is the
   * same union rule `POST /admins` follows. They take DIFFERENT elevation actions, but
   * that is a body-level distinction the controller makes, not a reason for a second
   * path with a second guard to keep right.
   *
   * `GET /kyc-policies/history` reads a different resource (the versions table) with a
   * mandatory target, and a read must be a GET — which has no body to discriminate on.
   */
  it('exposes exactly three kyc-policy routes', () => {
    expect(routesOf(KycPolicyRoutes)).toEqual([
      'GET /kyc-policies',
      'GET /kyc-policies/history',
      'POST /kyc-policies',
    ]);
  });

  /**
   * TWO exemption routes, and the count is the point.
   *
   * There is deliberately no route that EDITS a granted exemption. Changing one is a
   * revoke followed by a grant, so the record shows which grant was in force when — an
   * in-place edit would erase exactly that.
   */
  it('exposes exactly two kyc-exemption routes', () => {
    expect(routesOf(KycExemptionRoutes)).toEqual(['GET /kyc-exemptions', 'POST /kyc-exemptions']);
  });

  /**
   * TWO entitlement routes, and the count is the point here too.
   *
   * One GET returns the whole configuration — every level side by side, because an
   * operator sets what L1 grants by comparing it with NONE and L2, and three requests
   * to build one screen could straddle a concurrent write. One POST writes either
   * resource, discriminated on `action`.
   *
   * There is deliberately no DELETE: a level always has a row, and "grants nothing" is
   * said by writing every switch false rather than by removing the row and leaving the
   * consumer to guess what its absence means.
   */
  it('exposes exactly two kyc-entitlement routes', () => {
    expect(routesOf(KycEntitlementRoutes)).toEqual([
      'GET /kyc-entitlements',
      'POST /kyc-entitlements',
    ]);
  });

  /**
   * ═══ FOUR ROUTES, TWO SURFACES ═════════════════════════════════════════════
   *
   * `/countries/images` is the IMAGE LIBRARY — objects in the bucket, listed and added.
   * `/countries` is the CATALOGUE — rows in the database. They answer different
   * questions and an asset is not a country, so they are separate routes rather than one
   * overloaded projection.
   *
   * Neither upload nor create takes a path parameter: the ISO code travels as a
   * multipart field, a query parameter or a body field, for the reason the
   * path-parameter test below gives.
   */
  it('exposes exactly four country routes', () => {
    // `routesOf` sorts, so this is alphabetical rather than declaration order.
    expect(routesOf(CountryRoutes)).toEqual([
      'GET /countries',
      'GET /countries/images',
      'POST /countries',
      'POST /countries/images',
    ]);
  });

  it('exposes social chat routes', () => {
    expect(routesOf(ChatRoutes)).toEqual([
      'GET /social/chat/actions',
      'GET /social/chat/bans',
      'GET /social/chat/history',
      'GET /social/chat/hitters',
      'GET /social/chat/media',
      'GET /social/chat/moderation/settings',
      'GET /social/chat/regions',
      'GET /social/chat/report-reasons',
      'GET /social/chat/reports',
      'GET /social/chat/rooms',
      'GET /social/chat/rules',
      'GET /social/chat/settings',
      'GET /social/chat/settings/changes',
      'GET /social/chat/settings/preview',
      'GET /social/chat/skins',
      'GET /social/chat/staff/roles',
      'GET /social/chat/stats',
      'GET /social/chat/test-entitlements',
      'POST /social/chat/bans',
      'POST /social/chat/bans/lift',
      'POST /social/chat/broadcast',
      'POST /social/chat/media/delete',
      'POST /social/chat/media/flag',
      'POST /social/chat/moderation/settings',
      'POST /social/chat/regions',
      'POST /social/chat/regions/delete',
      'POST /social/chat/regions/update',
      'POST /social/chat/report-reasons',
      'POST /social/chat/reports/action',
      'POST /social/chat/retract',
      'POST /social/chat/rooms',
      'POST /social/chat/rooms/access',
      'POST /social/chat/rooms/delete',
      'POST /social/chat/rooms/update',
      'POST /social/chat/rules',
      'POST /social/chat/settings',
      'POST /social/chat/settings/rollback',
      'POST /social/chat/skins',
      'POST /social/chat/skins/activate',
      'POST /social/chat/skins/deactivate',
      'POST /social/chat/staff/assign-role',
      'POST /social/chat/staff/remove-role',
      'POST /social/chat/test-entitlements',
      'POST /social/chat/test-entitlements/delete',
    ]);
  });

  /**
   * ═══ NO ROUTE MAY TAKE AN adminId IN ITS PATH ══════════════════════════════
   *
   * A path parameter naming another admin is the shape that makes "which accounts
   * can this reach" un-auditable — it spreads the answer across every route's
   * decorator instead of keeping it in one union body with one table of required
   * proofs. The target is a validated field in the body, checked in one place.
   */
  it('takes no path parameters anywhere', () => {
    for (const controller of ALL_CONTROLLERS) {
      for (const route of routesOf(controller)) {
        expect(route).not.toMatch(/:/);
      }
    }
  });

  /** No global prefix and no versioning — paths are literally `/auth/login`. */
  it('uses no version segment anywhere', () => {
    for (const controller of ALL_CONTROLLERS) {
      for (const route of routesOf(controller)) {
        expect(route).not.toMatch(/\/v\d/);
        expect(route).not.toMatch(/\/api\//);
      }
    }
  });
});

describe('ROUTE_GROUPS', () => {
  /**
   * The registry is documentation, so the only thing that can keep it honest is a
   * test. It compares CONTROLLER prefixes — the value in `@Controller(...)` — not
   * the first path segment: `AppRoutes` is `@Controller()` with no prefix, and its
   * routes sit at the root, which is the `''` entry.
   */
  it('declares a group for every controller prefix', () => {
    const declared = new Set(ROUTE_GROUPS.map((g) => g.prefix));

    for (const prefix of controllerPrefixes()) {
      expect(declared, `ROUTE_GROUPS is missing "${prefix}"`).toContain(prefix);
    }
  });

  /** And nothing extra: a group for a module that no longer exists is worse than
   *  no registry, because it reads as coverage. */
  it('declares no group without a controller behind it', () => {
    const actual = new Set(controllerPrefixes());

    for (const group of ROUTE_GROUPS) {
      expect(actual, `ROUTE_GROUPS declares "${group.prefix}" but nothing serves it`).toContain(
        group.prefix,
      );
    }
  });
});

/** The `@Controller(...)` prefix of every controller, normalised so `AppRoutes`'s
 *  empty prefix matches the `''` registry entry. */
function controllerPrefixes(): string[] {
  return ALL_CONTROLLERS.map((c) => {
    const prefix = (Reflect.getMetadata('path', c) as string | undefined) ?? '';
    return prefix === '/' ? '' : prefix;
  });
}
